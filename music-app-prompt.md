# Project: Self-hosted music request + streaming platform ("Jellyseerr for music")

Build a complete, self-hostable music platform consisting of a **web app (PWA)** and a **backend service**, designed to run on a Kubernetes homelab (deployed via ArgoCD) with a NAS for storage. The app is inspired by **Jellyseerr** (request management) and **Spotify** (playback UX).

## High-level architecture

- **Frontend**: TypeScript + Vite PWA (React or Svelte — pick one and stay consistent). Wrapped with **Capacitor** to produce an Android APK and (later) an iOS app from the same codebase. Must be fully installable/usable as a plain PWA in a browser too.
- **Backend**: Single API service (TypeScript preferred, e.g. Fastify/NestJS, to keep one language across the stack — justify if you choose otherwise). Owns: auth sessions, request management, acquisition pipeline, metadata, playlists/favorites sync, smart shuffle.
- **Media server**: an existing **Jellyfin** instance. Audio playback streams **directly from Jellyfin** to the client via Jellyfin's audio/universal-audio API (transcoding handled by Jellyfin). The backend never proxies audio.
- **Acquisition**: an existing **slskd** (Soulseek daemon) instance, driven via its HTTP API.
- **Storage**: NAS mounted into the backend pod (PVC/hostPath). Jellyfin reads its music library from the same NAS path.
- **Database**: PostgreSQL (or SQLite for small deployments — support both if cheap, else Postgres only).

## Authentication

- Users log in with their **Jellyfin credentials**. Backend authenticates against Jellyfin (`/Users/AuthenticateByName`), stores the Jellyfin access token, and issues its own session token (JWT) for the app.
- User roles mirror Jellyfin: Jellyfin admins are platform admins. No separate user registration — Jellyfin is the source of truth for accounts.

## Features — playback (Spotify-inspired)

- Browse/search the **existing Jellyfin library** (artists, albums, tracks) and stream them.
- Full audio player: queue, seek, gapless where possible, background playback (Media Session API on web; proper background audio in the Capacitor Android build with media notification/lockscreen controls).
- **Playlists**: create/edit/delete. Use **Jellyfin-native playlists** via its API so they stay visible to other Jellyfin clients.
- **Favorites/liked songs**: use Jellyfin's favorites API (same reason).
- **Shuffle** and **Smart Shuffle**: smart shuffle is a weighted shuffle using play counts, skip history, favorites, and recency (backend tracks play/skip events). Keep the algorithm simple, documented, and tunable.

## Features — requests (Jellyseerr-inspired)

- **Search for music not yet in the library** via **MusicBrainz** (canonical metadata source) with **Cover Art Archive** for artwork (optionally enrich images via Deezer/Last.fm APIs). Respect MusicBrainz rate limits (1 req/s) — cache aggressively in the DB and set a proper User-Agent.
- Requestable units:
  - a single **track**
  - an **album**
  - an **artist's entire discography**
  - a **playlist by URL** from **Spotify or YouTube Music**: resolve the playlist via the respective public APIs (Spotify Web API with client credentials; YouTube Data API), match each entry to a MusicBrainz recording, and create per-track requests. Show a match-review screen for ambiguous matches.
- Request lifecycle: `pending → approved → searching → downloading → processing → available` (+ `failed` with a reason and retry). Real-time status updates in the UI (SSE or WebSocket).
- Admin settings: auto-approve per role, per-user request quotas, request management dashboard (approve/deny/retry/delete), deduplication against library and existing requests.

## Acquisition pipeline (backend)

For each approved track/album request:

1. Search **slskd** for candidates. Score results by: format/bitrate preferences (configurable, e.g. prefer FLAC then 320 mp3), filename/duration match against MusicBrainz data, uploader queue/slot availability.
2. Download via slskd to a staging directory, with retry/fallback to next-best candidate on failure or stall.
3. **Post-process**: verify audio, tag files with full MusicBrainz metadata (artist, album, track number, release year, MBIDs, embedded cover art), then rename and move to the NAS library using the standard layout:
   `Artist/Album/<tracknumber> - <track name>.<ext>` (sanitize filesystem-unsafe characters; handle multi-disc albums and various-artists releases sensibly).
4. Trigger a **Jellyfin library scan** for the new path; mark the request `available` once Jellyfin has indexed it.
5. Everything runs through a persistent job queue (survives pod restarts), with concurrency limits and observable per-job logs in the admin UI.

## Deployment

- Dockerfiles for frontend and backend (frontend can also be served by the backend — your call, justify it).
- Kubernetes manifests via **Kustomize or a Helm chart** suitable for ArgoCD: Deployment(s), Service, Ingress, PVC for the NAS music path, ConfigMap for settings, Secrets for Jellyfin/slskd/Spotify/YouTube credentials. All external endpoints (Jellyfin URL, slskd URL) configurable via env.
- Health/readiness endpoints; sensible structured logging.

## Non-goals / constraints

- Do not build user registration, a separate media scanner, or audio transcoding — Jellyfin handles those.
- Do not proxy audio through the backend.
- iOS is a "should work later" target: keep the Capacitor setup iOS-compatible but Android + web are the deliverables to actually build and test.

## Deliverables & milestones

1. **M1**: Backend skeleton + Jellyfin auth + library browse/search + working web player streaming from Jellyfin.
2. **M2**: MusicBrainz search + request creation/lifecycle + admin approval UI.
3. **M3**: slskd acquisition pipeline + tagging/renaming + Jellyfin scan integration, end-to-end request → playable.
4. **M4**: Playlists, favorites, shuffle + smart shuffle, Spotify/YT playlist import.
5. **M5**: Capacitor Android build with background playback; K8s/ArgoCD manifests; README with setup docs.

Write tests for the non-trivial backend logic (auth flow, request lifecycle, candidate scoring, file naming/sanitization). Ask before making irreversible design decisions not covered above.
