# NUMA Record — Plan de mise en œuvre

> Alternative self-hosted à Loom pour la pédagogie NUMA
> Architecture mixte : backend Cap (self-hosté) + frontend extension Chrome (fork Screenity)

---

## 1. Contexte & objectifs

**Demande** : trouver une alternative OSS self-hosted à Loom pour NUMA, avec :
- UI/UX très simple pour coachs non-tech
- Capture écran + stockage + partage
- Branding NUMA (white-label sur la share page + l'extension)
- Auto-hébergement sur infra NUMA (Ionos Paris)

**Contraintes identifiées** :
- 3-4 vidéos / semaine par coach (≈ 30 personnes)
- Usage pédagogique interne
- Pas d'engagement sur un SaaS tiers
- NUMA est B Corp (sensibilité éthique sur les licences)

## 2. Décision d'architecture

**Architecture client/serveur** :
- **Serveur** : Cap Web self-hosté sur VPS Ionos (Docker Compose via Coolify) → backend complet (storage S3 NUMA, partage, transcripts, custom domain)
- **Client** : extension Chrome basée sur un fork de Screenity (GPL-3.0) → UX de capture rebrandée NUMA, qui upload via l'API Cap

**Pourquoi cette archi** :
- Pas de mélange de copyleft : les deux projets communiquent par HTTP/REST, pas par import de code
- Coût marginal : $5 one-time (Chrome Web Store dev account) — pas de notarisation Apple
- Cross-platform : l'extension marche sur Mac/Win/Linux/Chromebook
- Branding 100% NUMA : nom app, logo, couleurs, copy FR, custom domain `cap.numa.co`
- UX premium pour non-tech : "Add to Chrome" en 30 sec, pas d'install desktop

## 3. Stack technique

| Couche | Techno | Licence |
|---|---|---|
| Backend web | Cap Web (Next.js + SolidStart) | AGPLv3 |
| Base de données | MySQL (via Docker Compose Cap) | GPLv2 |
| Stockage objet | S3 NUMA (config Cap custom S3) | — |
| Media processing | Cap Media Server (FFmpeg) | AGPLv3 |
| Reverse proxy | Coolify (Traefik intégré) | Apache 2.0 |
| Frontend extension | Fork Screenity | GPLv3 |
| Hébergement | VPS Ionos Paris (même que Forgejo) | — |
| Domaine | `cap.numa.co` | — |

## 4. Licence — analyse

| Composant | Licence | Implications NUMA |
|---|---|---|
| Cap Web (serveur) | AGPLv3 | Self-host = OK, zéro modif = zéro copyleft triggered pour redistribution |
| Screenity (extension) | GPLv3 | Fork + redistribution → publication du fork sous GPLv3 obligatoire (overhead copyleft classique, pas network-use) |
| Communication inter-projets | HTTP/REST | Pas de contamination copyleft entre les deux |

**Pas de risque juridique** si :
- Cap Web est utilisé tel quel (sans modif du code source)
- Le fork Screenity est publié sur GitHub public NUMA-org sous GPLv3
- Aucune modif du code Cap serveur

## 5. Flow utilisateur final (coachs NUMA)

1. NUMA envoie email "Installer NUMA Record" + lien Chrome Web Store
2. Coach clique → "Add to Chrome" (1 clic, 30 sec)
3. Setup unique : saisir `https://cap.numa.co` comme serveur + login magic link
4. Click icône NUMA Record dans Chrome → "Enregistrer"
5. Sélection écran + cam + micro → start record
6. Stop → upload automatique vers cap.numa.co (via presigned URLs S3)
7. Popup avec lien partageable `cap.numa.co/v/xyz` → copy → envoie aux participants
8. Participants voient la vidéo sur `cap.numa.co` avec branding NUMA

## 6. Plan d'exécution (par étapes)

| # | Étape | Temps estimé | Statut |
|---|---|---|---|
| 0 | Note de synthèse (ce document) | ✅ | fait |
| 1 | Vérifier API Cap upload + auth | 30 min | ✅ |
| 2 | Créer repo GitHub `pierre-marie-git/numa-record` | 5 min | 🔜 |
| 3 | Créer issue avec ce plan | 5 min | 🔜 |
| 4 | Forker Screenity → base du repo | 30 min | 🔜 |
| 5 | Explorer code fork + lister questions | 2-3h | 🔜 |
| 6 | Setup serveur Cap sur Ionos via Coolify | 2h | à faire |
| 7 | DNS `cap.numa.co` + SSL + secrets prod | 1h | à faire |
| 8 | Branding NUMA dans extension (nom/logo/couleurs) | 1 jour | à faire |
| 9 | Adapter extension pour uploader vers API Cap | 1-2 jours | à faire |
| 10 | Auth Magic Link + intégration | 1 jour | à faire |
| 11 | Tests E2E + soumission Chrome Web Store | 1-2 jours | à faire |
| 12 | Pilote 2-3 coachs NUMA | 1 sem | à faire |

**Estimation MVP** : ~1-2 semaines dev

## 7. Coûts

| Poste | Coût | Récurrence |
|---|---|---|
| VPS Ionos | déjà payé (Forgejo) | inclus |
| Stockage S3 NUMA | déjà payé | inclus |
| Domaine `cap.numa.co` | inclus numa.co | inclus |
| Chrome Web Store dev account | $5 USD | **one-time** |
| Certificat SSL (Let's Encrypt) | $0 | gratuit |
| Apple Developer ID (pas requis) | $0 | — |
| Maintenance dev (~30-40h/an) | temps humain | annuel |

## 8. Risques identifiés

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| Sync upstream Screenity complexe | moyenne | moyen | Limiter le diff, accepter un délai sur les features upstream |
| Cap self-host instable | faible | moyen | Tester en pilote avant généralisation |
| Chrome Web Store rejette l'extension | faible | moyen | Bien lire les guidelines, branding neutre |
| Cap change l'API | faible | moyen | On pin une version Cap, pas de rolling upgrade |
| Maintenance fork abandonnée | moyenne | faible | L'option C (web brandée sans fork) reste fallback |

## 9. Alternatives écartées

- **Cap Desktop build from source** : $99/an Apple Developer + notarisation + fork AGPLv3 = trop de friction
- **Cap Web seul (recording natif OS)** : UX moins intégrée, pas de bouton custom dans Chrome
- **From-scratch extension** : 2-4 jours de plus, valeur marginale vs fork Screenity
- **SaaS type Loom/Vimeo** : à l'opposé de la demande (self-hosted)

## 10. Décisions à prendre

À clarifier avec PM avant étape 6 :

1. **Domaine final** : `cap.numa.co` ou autre ?
2. **S3 cible** : AWS S3 / Cloudflare R2 / Backblaze B2 / MinIO self-host ?
3. **Stockage vidéos** : bucket dédié `numa-videos` ou existant ?
4. **Auth coachs** : Magic Link email / Google OAuth / credentials ?
5. **Sous-domaine pour share pages** : `cap.numa.co/v/...` ou autre pattern ?
6. **Branding** : nom app extension ("NUMA Record" / "NUMA Cast" / autre) ?
7. **Politique de rétention** : suppression auto après X jours ?
8. **Visibilité des vidéos** : par défaut public (avec lien) ou privé par défaut ?

## 11. Notes techniques sur l'API Cap

Endpoints clés identifiés dans le source `apps/web/app/api/` :

| Endpoint | Méthode | Usage |
|---|---|---|
| `/api/desktop/video/create` | GET | Crée un video record (avec query params : recordingMode, duration, etc.) |
| `/api/upload/signed` | POST | Génère une presigned URL S3 pour upload simple (1 fichier) |
| `/api/upload/signed/batch` | POST | Batch de plusieurs presigned URLs |
| `/api/upload/multipart/initiate` | POST | Init upload multipart (gros fichiers) |
| `/api/upload/multipart/{part}` | POST | Upload d'une partie |
| `/api/upload/multipart/complete` | POST | Finalise multipart |
| `/api/upload/multipart/abort` | POST | Annule multipart |
| `/api/upload/recording-complete` | POST | Notifie Cap que l'upload est fini (déclenche processing/transcoding) |
| `/api/video/metadata` | PUT | Update metadata d'une video |
| `/api/auth/[...nextauth]` | * | NextAuth — magic link, Google, credentials |

**Flow d'upload typique** :
1. POST `/api/desktop/video/create?durationInSecs=X&width=Y&height=Z&fps=30` → récupère `videoId`
2. POST `/api/upload/signed` avec `{videoId, subpath: "result.mp4"}` → récupère presigned URL S3
3. PUT vers la presigned URL avec le binaire `.mp4`
4. POST `/api/upload/recording-complete` avec `{videoId}` → Cap lance le transcoding

**Auth** : toutes les routes sont protégées par middleware `withAuth` → l'extension doit maintenir une session authentifiée (cookie NextAuth).

## 12. Liens utiles

- Cap upstream : https://github.com/CapSoftware/Cap
- Screenity upstream : https://github.com/alyssaxuu/screenity
- Cap self-hosting docs : https://cap.so/docs/self-hosting
- Cap licence commerciale : https://cap.so/docs/commercial-license
- Coolify : https://coolify.io

---

_Document vivant — mis à jour à chaque étape._
