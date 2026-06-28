# NUMA Record

> Screen recorder extension for NUMA coaches.
> Fork of [Screenity](https://github.com/alyssaxuu/screenity) (GPL v3), rebranded and integrated with a self-hosted [Cap](https://cap.so) backend.

---

## What is NUMA Record?

NUMA Record is the screen-recording extension installed by NUMA coaches on Chrome/Chromium browsers. It captures the screen, camera, and microphone, then uploads the video to a NUMA-hosted Cap server (`cap.numa.co`) so coaches can share the recording with their participants via a short link.

## Architecture

```
┌──────────────────┐       presigned URLs       ┌──────────────────┐
│  NUMA Record     │   ────────────────────────► │  Cap Web         │
│  (this repo)     │                             │  (Ionos/Coolify) │
│  Chrome ext      │ ◄─────── share link ─────── │  AGPLv3 self-host│
└──────────────────┘                             └────────┬─────────┘
                                                          │ S3
                                                          ▼
                                                   ┌─────────────┐
                                                   │  NUMA S3    │
                                                   └─────────────┘
```

- **Client** (this extension): forked from Screenity, capture UX kept intact, upload target switched to NUMA Cap.
- **Server**: Cap Web self-hosted on NUMA infrastructure (VPS Ionos Paris via Coolify). Stores videos in NUMA S3, exposes share pages on `cap.numa.co`.

## Why a fork of Screenity?

- **UX maturity** — Screenity is one of the most polished screen recorders in the Chrome Web Store (~10k+ stars, used by hundreds of thousands of people). Building the capture UI from scratch would take weeks.
- **GPL v3 license** — permissive enough to fork and rebrand for internal use, as long as the fork stays open.
- **Self-host Cap backend** — replaces Screenity Cloud with NUMA-controlled infrastructure.

## Status

🚧 **Pre-alpha — early development**

- [x] Repo created from Screenity fork
- [x] Initial branding swap (name, description, NOTICE, PLAN.md)
- [ ] Remove Screenity Pro / Screenity Cloud / Google Drive integration
- [ ] Switch upload target to NUMA Cap API
- [ ] NUMA Cap self-hosted backend deployment
- [ ] Auth integration (magic link via Cap)
- [ ] French locale (`fr-FR`)
- [ ] Chrome Web Store dev account + submission
- [ ] Pilot with 2-3 NUMA coaches

See [PLAN.md](./PLAN.md) for the full execution plan.

## Development

```bash
npm install
npm run dev       # Hot-reload dev build
npm run build     # Production build
```

## License

GNU GPL v3 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Original copyright: Alyssa X (Screenity)
Fork modifications: NUMA (2026)

## Related projects

- Upstream Screenity: <https://github.com/alyssaxuu/screenity>
- Upstream Cap backend: <https://github.com/CapSoftware/Cap>
- Cap self-hosting docs: <https://cap.so/docs/self-hosting>
