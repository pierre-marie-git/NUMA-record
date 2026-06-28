// capUploader.js — NUMA Record uploader for Cap self-hosted platform
//
// Drop-in replacement for bunnyTusUploader.js that talks to Cap API instead
// of Bunny CDN TUS. Designed to expose the same external API surface so
// CloudRecorder.jsx / OffscreenRecorder / messaging handlers can be migrated
// with minimal changes.
//
// Flow (MVP, single-PUT MP4):
//   1. POST {CAP_API}/api/desktop/video/create?recordingMode=desktopMP4
//        → { id: videoId }
//   2. POST {CAP_API}/api/upload/signed/batch  body: { videoId, subpaths }
//        → { [subpath]: { presignedUrl, ... } }
//   3. PUT each track blob to its presigned S3 URL
//   4. POST {CAP_API}/api/upload/recording-complete  body: { videoId }
//        → triggers Cap's MP4 finalize (returns "already-complete" for desktopMP4)
//
// S3 target: bucket-numa-cs-01 on Ionos eu-central-2 (Berlin).
// Objects are written under the user/video prefix already managed by Cap
// (so no extra "cap/" prefix is needed on our side — Cap handles naming).
//
// MVP limitations:
//   - No resume. If the PUT is interrupted, the user must re-record.
//     (Acceptable because coaching videos are short — 10-20 min / 100-300 MB.)
//   - No chunked upload. Single PUT up to S3's 5 GB hard limit, fine for MVP.
//   - No retry beyond transient 5xx/429. Permanent errors surface to caller.
//   - No journal persistence. State lives in memory only.

const CAP_API = process.env.CAP_API_BASE_URL;

// Track kind → subpath in Cap storage layout.
// Cap's desktop layout (post-recording) uses subpaths like
// `result.mp4`, `screen.mp4`, `camera.mp4`, `audio.mp4` (or `audio.webm`).
// We default to desktopMP4 single-track upload for MVP — each trackType
// becomes its own MP4 subpath. Cap stitches them on recording-complete.
const TRACK_SUBPATH = {
  screen: "screen.mp4",
  camera: "camera.mp4",
  audio: "audio.mp4",
};

export default class CapUploader {
  constructor(options = {}) {
    // External surface — same shape as BunnyTusUploader so the rest of
    // CloudRecorder.jsx keeps working. We just don't honor most of these
    // (chunked upload, resume, journals) because Cap MVP = single PUT.
    this.trackType = options.trackType || null;
    this.CHUNK_SIZE = options.chunkSize || 512 * 1024; // unused, kept for API compat
    this.MAX_RETRIES = options.maxRetries || 3;
    this.RETRY_DELAY = options.retryDelay || 1000;
    this.UPLOAD_TIMEOUT_MS = options.uploadTimeoutMs || 5 * 60 * 1000; // 5 min for MVP
    this.onProgress = options.onProgress || null;
    this.onStall = options.onStall || null;
    this.onTelemetry = options.onTelemetry || null;
    this.onStateChange = options.onStateChange || null;
    this.sessionId = options.sessionId || null;

    // Internal state
    this.videoId = null;
    this.uploadUrl = null;
    this.offset = 0;
    this.totalBytes = 0;
    this.status = "idle";
    this.error = null;
    this.abortController = null;
    this.metadata = {};
    this.sceneId = null;
    this.projectId = null;
    this.createdAt = null;
    this.finalizedAt = null;
    this.bytesLostAfterFinalize = 0;
    this.lastErrorAt = null;
    this.lastErrorCode = null;
  }

  // ────────────────────────────────────────────────────────────
  // External API — imitates BunnyTusUploader
  // ────────────────────────────────────────────────────────────

  getUploaderType() {
    return this.trackType || this.metadata?.type || null;
  }

  emitTelemetry(event, payload = {}) {
    if (typeof this.onTelemetry !== "function") return;
    try {
      this.onTelemetry({
        uploaderType: "cap_single_put",
        trackType: this.getUploaderType(),
        videoId: this.videoId,
        status: this.status,
        offset: this.offset,
        totalBytes: this.totalBytes,
        ...payload,
      });
    } catch {
      // Telemetry is best-effort.
    }
  }

  notifyStateChange(reason = null, extra = {}) {
    if (typeof this.onStateChange !== "function") return;
    try {
      this.onStateChange({ reason, ...extra });
    } catch {
      // ignore
    }
  }

  setUploaderError(errorCode, err = null) {
    this.status = "error";
    this.error = errorCode;
    this.lastErrorAt = Date.now();
    this.lastErrorCode = errorCode;
    this.emitTelemetry("upload_error", { errorCode, message: err?.message });
  }

  /**
   * Initialize: check auth, create the Cap video, request a presigned
   * upload URL for this track's subpath.
   *
   * @param {string} projectId  Cap project identifier (we reuse CloudRecorder's
   *                            per-project grouping; not used by Cap API MVP)
   * @param {object} options    { title, type, width, height, sceneId, sessionId, ... }
   * @returns {Promise<{videoId: string, mediaId: string}>}
   */
  async initialize(projectId, options = {}) {
    if (this.status !== "idle" && this.status !== "error") {
      throw new Error("Uploader has already been initialized");
    }

    try {
      this.projectId = projectId;
      this.metadata = options || {};
      this.sceneId = options.sceneId || null;
      this.sessionId = options.sessionId || this.sessionId || null;
      this.createdAt = Date.now();
      this.status = "initializing";
      this.error = null;
      this.offset = 0;
      this.totalBytes = 0;
      this.lastErrorAt = null;
      this.lastErrorCode = null;

      if (!CAP_API) {
        throw new Error(
          "CAP_API_BASE_URL is not configured. Set it in webpack DefinePlugin.",
        );
      }
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        throw new Error("Chrome extension runtime is not available");
      }

      // Step 1: ask Cap to create the video. Auth via NextAuth session
      // cookie (sent automatically by the browser for same-origin /
      // externally_connectable origins).
      const createUrl = new URL(`${CAP_API}/api/desktop/video/create`);
      createUrl.searchParams.set("recordingMode", "desktopMP4");
      createUrl.searchParams.set("name", options.title || "NUMA Recording");
      if (options.width) createUrl.searchParams.set("width", String(options.width));
      if (options.height) createUrl.searchParams.set("height", String(options.height));
      if (options.fps) createUrl.searchParams.set("fps", String(options.fps));

      const createRes = await this._fetchWithRetry(createUrl.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!createRes.ok) {
        const errBody = await createRes.text();
        throw new Error(
          `Cap video/create failed: ${createRes.status} ${errBody.slice(0, 200)}`,
        );
      }
      const createData = await createRes.json();
      this.videoId = createData.id;
      if (!this.videoId) {
        throw new Error("Cap video/create returned no id");
      }

      // Step 2: request a presigned PUT URL for our track's subpath.
      // We always request batch — Cap returns the URLs for whatever subpaths
      // we ask for. For MVP single-track, we ask for one.
      const subpath = TRACK_SUBPATH[this.trackType] || "result.mp4";
      const batchRes = await this._fetchWithRetry(
        `${CAP_API}/api/upload/signed/batch`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: this.videoId,
            subpaths: [subpath],
          }),
        },
      );
      if (!batchRes.ok) {
        const errBody = await batchRes.text();
        throw new Error(
          `Cap upload/signed/batch failed: ${batchRes.status} ${errBody.slice(0, 200)}`,
        );
      }
      const batchData = await batchRes.json();
      const uploadInfo =
        batchData?.presignedUrls?.[subpath] || batchData?.[subpath] || batchData;
      this.uploadUrl = uploadInfo?.presignedUrl || uploadInfo?.url || null;
      if (!this.uploadUrl) {
        throw new Error(
          `Cap upload/signed/batch returned no presigned URL for ${subpath}. Got: ${JSON.stringify(batchData).slice(0, 200)}`,
        );
      }

      this.status = "ready";
      this.emitTelemetry("upload_started", { videoId: this.videoId });
      this.notifyStateChange("initialized");
      // Cap uses videoId only — surface it as both videoId and mediaId so
      // the existing callers don't need to know the difference.
      return { videoId: this.videoId, mediaId: this.videoId };
    } catch (err) {
      this.setUploaderError("initialize-failed", err);
      throw err;
    }
  }

  /**
   * Receive a track chunk from MediaRecorder. For Cap MVP, we just queue
   * it. The actual upload happens once write() is called with the final
   * chunk — at which point we flush everything as a single PUT.
   *
   * (If the caller writes the entire blob at once via write(blob), we
   * upload immediately — same end result, less memory.)
   */
  async write(chunk) {
    if (this.status !== "ready" && this.status !== "uploading") {
      throw new Error(`Cannot write in status: ${this.status}`);
    }
    if (!this._buffer) {
      this._buffer = [];
      this._bufferedBytes = 0;
    }
    const data = chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk;
    this._buffer.push(data);
    this._bufferedBytes += data.byteLength;
    this.totalBytes = this._bufferedBytes;
    this.recordProgress(data.byteLength);
  }

  /**
   * Upload the buffered chunks. For MVP, we treat the buffered chunks as
   * a single concatenated blob and PUT it once to the presigned URL.
   * If no chunks were written, this is a no-op (the caller might upload
   * directly in some flows).
   */
  async flush() {
    if (!this._buffer || this._buffer.length === 0) {
      return;
    }
    if (!this.uploadUrl) {
      throw new Error("No upload URL — call initialize() first");
    }

    this.status = "uploading";
    this.abortController = new AbortController();
    const timeoutId = setTimeout(
      () => this.abortController.abort("upload-timeout"),
      this.UPLOAD_TIMEOUT_MS,
    );

    try {
      const blob = new Blob(this._buffer, {
        type: this.metadata?.mimeType || "video/mp4",
      });
      const res = await fetch(this.uploadUrl, {
        method: "PUT",
        body: blob,
        signal: this.abortController.signal,
        // Note: NO Authorization header — it's a presigned S3 URL.
      });
      clearTimeout(timeoutId);
      this.abortController = null;

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        // S3 returns 403 if the presigned URL expired; 4xx is permanent.
        if (res.status >= 500 || res.status === 429) {
          throw new Error(
            `Cap S3 upload transient failure: ${res.status} ${errBody.slice(0, 200)}`,
          );
        }
        throw new Error(
          `Cap S3 upload failed: ${res.status} ${errBody.slice(0, 200)}`,
        );
      }

      this.offset = this.totalBytes;
      this._buffer = null;
      this._bufferedBytes = 0;
      this.emitTelemetry("upload_bytes_sent", {
        bytes: this.offset,
      });
      this.recordProgress(0);
    } catch (err) {
      clearTimeout(timeoutId);
      this.abortController = null;
      if (err?.name === "AbortError") {
        this.setUploaderError("upload-timeout", err);
      } else {
        this.setUploaderError("upload-failed", err);
      }
      throw err;
    }
  }

  /**
   * Finalize the upload. Tells Cap the recording is complete and ready
   * for processing/transcoding.
   */
  async finalize() {
    if (this.status === "completed") return;
    if (this.status !== "ready" && this.status !== "uploading") {
      throw new Error(`Cannot finalize in status: ${this.status}`);
    }
    try {
      // Flush any buffered chunks before signaling completion.
      if (this._buffer && this._buffer.length > 0) {
        await this.flush();
      }
      this.status = "finalizing";
      this.emitTelemetry("upload_finalize_started");
      this.notifyStateChange("finalize-started");

      const res = await fetch(`${CAP_API}/api/upload/recording-complete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: this.videoId }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        // 4xx (except 429) is permanent; 5xx and 429 are transient.
        if (res.status >= 500 || res.status === 429) {
          throw new Error(
            `Cap recording-complete transient failure: ${res.status} ${errBody.slice(0, 200)}`,
          );
        }
        throw new Error(
          `Cap recording-complete failed: ${res.status} ${errBody.slice(0, 200)}`,
        );
      }

      this.status = "completed";
      this.finalizedAt = Date.now();
      this.emitTelemetry("upload_finalize_completed", {
        videoId: this.videoId,
      });
      this.emitTelemetry("upload_complete_client", {
        videoId: this.videoId,
      });
      this.notifyStateChange("finalize-completed");
    } catch (err) {
      this.setUploaderError("finalize-failed", err);
      throw err;
    }
  }

  pause() {
    // No-op for MVP (single PUT). Surfacing here for API parity.
    if (this.status !== "uploading") return;
    if (this.abortController) {
      this.abortController.abort("paused");
    }
    this.status = "paused";
    this.notifyStateChange("paused");
  }

  resume() {
    // No-op for MVP. The next write() will re-trigger upload.
    if (this.status !== "paused") return;
    this.status = "ready";
    this.notifyStateChange("resumed");
  }

  async abort(reason = null) {
    if (this.abortController) {
      this.abortController.abort(reason || "aborted");
      this.abortController = null;
    }
    this.status = "aborted";
    this.error = reason || "aborted";
    this._buffer = null;
    this._bufferedBytes = 0;
    this.notifyStateChange("aborted");
    this.emitTelemetry("upload_aborted", { reason: this.error });
  }

  /**
   * Return metadata about the upload — used by CloudRecorder's metadata
   * panel and editor.
   */
  getMeta() {
    return {
      videoId: this.videoId,
      mediaId: this.videoId, // backwards compat
      uploadUrl: this.uploadUrl,
      offset: this.offset,
      totalBytes: this.totalBytes,
      status: this.status,
      error: this.error,
      trackType: this.trackType,
    };
  }

  /**
   * BunnyTusUploader compat: pause/resume/abort/updateEncoderInfo.
   * NUMA Record's CloudRecorder calls these; we ignore most but accept them.
   */
  updateEncoderInfo(_info) {
    // No-op: encoder info is computed by Cap's transcoding pipeline.
  }

  async setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  async getResumeJournal() {
    // No journal in MVP. Always return null so the caller creates a fresh
    // video on retry rather than trying to resume a non-existent chunked
    // upload.
    return null;
  }

  async persistUploadJournal() {
    // No-op.
  }

  async clearUploadJournal() {
    // No-op.
  }

  async waitForPendingUploads() {
    // No-op for MVP (single PUT, no pending chunks).
  }

  /**
   * BunnyTusUploader compat — processQueue is called by CloudRecorder to
   * drain chunked uploads. With Cap MVP there's no queue, so this is a
   * no-op that resolves immediately.
   */
  async processQueue() {
    return;
  }

  async refreshTusAuth() {
    // No-op — S3 presigned URLs are obtained once at initialize() and
    // don't need refreshing unless they expire (default 1h, plenty of
    // margin for MVP screencasts). If you ever hit expiry, re-call
    // initialize().
  }

  async initTusUpload() {
    // No-op.
  }

  async checkAuthExpiration() {
    // No-op.
  }

  async uploadChunk(_chunk) {
    // Implemented via write() + flush() for Cap. If someone calls
    // uploadChunk directly (legacy code path), redirect through write.
    if (this._buffer && this._buffer.length > 0) {
      await this.flush();
    }
  }

  startHeartbeat() {
    // No-op — single PUT has no stall to detect.
  }

  stopHeartbeat() {
    // No-op.
  }

  // ────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────

  recordProgress(deltaBytes) {
    // Emit progress events at the same cadence as BunnyTusUploader so the
    // UI progress bars keep working.
    if (typeof this.onProgress === "function") {
      try {
        this.onProgress({
          offset: this.offset,
          totalBytes: this.totalBytes,
          deltaBytes,
          trackType: this.trackType,
        });
      } catch {
        // ignore
      }
    }
  }

  async _fetchWithRetry(url, init, attempt = 0) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const transient = res.status >= 500 || res.status === 429;
      if (!transient || attempt >= this.MAX_RETRIES) return res;
      await new Promise((r) => setTimeout(r, this.RETRY_DELAY * (attempt + 1)));
      return this._fetchWithRetry(url, init, attempt + 1);
    } catch (err) {
      if (attempt >= this.MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, this.RETRY_DELAY * (attempt + 1)));
      return this._fetchWithRetry(url, init, attempt + 1);
    }
  }
}

// ────────────────────────────────────────────────────────────
// Re-exported helpers — same surface as bunnyTusUploader.js
// ────────────────────────────────────────────────────────────

export async function getThumbnailFromBlob(blob, seekTo = 0.1) {
  // Identical implementation to bunnyTusUploader — kept for drop-in compat.
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.crossOrigin = "anonymous";

    const url = URL.createObjectURL(blob);
    video.src = url;

    let timeoutId = setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error("Thumbnail timed out"));
    }, 2000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      URL.revokeObjectURL(url);
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Failed to load video for thumbnail"));
    };

    video.onloadedmetadata = () => {
      if (video.duration === Infinity) {
        video.currentTime = 0;
      }
      const targetTime = Math.min(seekTo, video.duration - 0.01);
      video.currentTime = targetTime;
    };

    video.onseeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(
        (thumbnailBlob) => {
          cleanup();
          if (thumbnailBlob) resolve(thumbnailBlob);
          else reject(new Error("Failed to create thumbnail blob"));
        },
        "image/jpeg",
        0.8,
      );
    };
  });
}
