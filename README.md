# Encore

Self-hosted music request + streaming platform — "Jellyseerr for music". Users browse and play the existing **Jellyfin** music library from a Spotify-style web/Android app, and request anything that's missing; Encore finds it on Soulseek via **slskd**, tags and files it, and it appears in the library ready to play.

- **Playback**: queue, seek, near-gapless preloading, Media Session (lockscreen/hardware keys), volume, repeat. Audio streams **directly from Jellyfin** (`/Audio/{id}/universal`) — the backend never proxies audio.
- **Playlists & favorites** are Jellyfin-native (visible in every other Jellyfin client).
- **Shuffle + smart shuffle**: weighted by play counts, skips, favorites and recency (tunable in admin settings).
- **Requests**: single track, album, or full artist discography, backed by MusicBrainz metadata + Cover Art Archive artwork, with admin approval, quality profiles (preferred formats / minimum bitrate), retry and progress streamed live over SSE.
- **Refetch**: got the wrong version from Soulseek? One click deletes it from Jellyfin, blocklists that source, and grabs a different one automatically.
- **Playlist import**: paste a Spotify or YouTube playlist URL; entries are matched to MusicBrainz recordings with a review screen for ambiguous matches, then in-library tracks are linked and missing ones become requests.
- **Auth**: users log in with their Jellyfin credentials; Jellyfin admins are Encore admins. No separate accounts.
- Installable **PWA** and a **Capacitor Android** app with background playback + media notification.

## Architecture

```
        ┌───────────────┐   audio (direct)   ┌──────────┐
        │  web / PWA /  │◄──────────────────►│ Jellyfin │◄─── reads NAS music library
        │  Android app  │                    └────▲─────┘
        └──────┬────────┘                         │ auth, library, playlists,
               │ REST + SSE                       │ favorites, scans
        ┌──────▼────────┐                         │
        │ Encore server │◄────────────────────────┘
        │   (Fastify)   │──────► MusicBrainz + Cover Art Archive (1 req/s, cached in PG)
        └┬─────┬───────┬┘──────► Spotify / YouTube APIs (playlist import)
         │     │       │
         │     │       └──────► slskd HTTP API (search + download)
    ┌────▼──┐ ┌▼────────────┐
    │Postgres│ │ NAS storage │  staging dir ──(tag + rename)──► music library ──► Jellyfin scan
    └────────┘ └─────────────┘
```

- **`server/`** — Fastify + TypeScript API. Owns sessions (JWT wrapping a Jellyfin access token), request lifecycle, the acquisition worker, MusicBrainz cache, playlist/favorite proxying, play/skip tracking, settings.
- **`web/`** — React + Vite + Tailwind PWA. Also the source for the Capacitor Android app (`web/android/`).
- **`shared/`** — types + pure helpers shared by both (naming, URL builders).
- **`test-stack/`** — disposable local stack: real Jellyfin + Postgres in Docker, deterministic mock slskd / Spotify servers, and a generated flac library.
- **`deploy/`** — Dockerfile (repo root), Kustomize manifests, ArgoCD Application.

### Request lifecycle

`pending → approved → searching → downloading → processing → available` (or `denied` / `failed`, both retryable). Admins approve from the requests screen; every state change streams to clients over SSE. The acquisition worker:

1. Searches slskd, scores candidates — format rank from the quality profile, peer slot/queue/speed, tracklist match (track numbers, then titles, then position), duration agreement, bitrate — one candidate per peer so retries move to a *different* source.
2. Downloads to slskd, moves files into `STAGING_PATH`, retags with MusicBrainz metadata (proper track/disc numbers, album artist, cover art) and renames to `Artist/Album/NN - Title.ext`.
3. Moves the album into `MUSIC_LIBRARY_PATH` and triggers a Jellyfin library scan, then polls until the items are visible and marks the request `available`.

### Smart shuffle

Weighted sampling without replacement (Efraimidis–Spirakis). Per track:

```
weight = 1 + playCountWeight·log2(1+plays) + favoriteBoost − skipPenalty·log2(1+skips)
if played within recencyHours:  weight /= 1 + recencyPenalty·(1 − age/recencyHours)
floor 0.05 — nothing is ever excluded
```

All knobs are editable in **Settings → Smart shuffle** (`server/src/shuffle/smart.ts`).

## Development

Prereqs: Node 22+, Docker (compose), ~1 GB free for images.

```bash
npm install

# 1. real Jellyfin + Postgres
cd test-stack
docker compose up -d
node generate-library.mjs      # synthesizes a small flac library into ./library
node setup-jellyfin.mjs        # first-run wizard, users (admin/testpass, stoat/testpass), music library, API key
node slskd-mock.mjs &          # mock Soulseek daemon on :5030 (MOCK_FLAKY=1 adds an always-failing peer)
node import-mock.mjs &         # mock Spotify API on :5031 (playlist MOCKPL01)
cd ..

# 2. server + web
cp server/.env.example server/.env   # setup-jellyfin.mjs prints the values to fill in
npm run dev:server                   # api on :8080 (test env uses :8687)
npm run dev:web                      # vite on :5173
```

Log in at `http://localhost:5173` with `admin` / `testpass`.

### Tests

```bash
npm test              # server unit/integration suite (vitest; needs the test-stack Postgres)
npm run typecheck
node web/scripts/browser-test.mjs      # M1: login → browse → play (headless Chrome)
node web/scripts/browser-test-m2.mjs   # M2: search → request → approve
node web/scripts/browser-test-m3.mjs   # M3: request → acquisition → playable
node web/scripts/browser-test-m4.mjs   # M4: playlists, favorites, smart shuffle, import
```

The browser scripts drive the real UI end-to-end against the test stack (they expect the dev servers + mocks above to be running).

## Configuration

All configuration is environment variables (see `server/.env.example`).

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres connection string |
| `JELLYFIN_URL` | ✅ | Jellyfin as reached by the **backend** |
| `JELLYFIN_PUBLIC_URL` | | Jellyfin as reached by **clients** (audio/artwork). Defaults to `JELLYFIN_URL` |
| `JELLYFIN_API_KEY` | | Server-side scans + session validation (recommended) |
| `JWT_SECRET` | ✅ | Signs Encore session tokens |
| `MUSIC_LIBRARY_PATH` | ✅ | Where finished music lands — same directory Jellyfin's music library points at |
| `STAGING_PATH` | ✅ | Scratch space for tagging (same filesystem as the library ⇒ atomic moves) |
| `SLSKD_URL` / `SLSKD_API_KEY` | ✅ | slskd HTTP API |
| `SLSKD_DOWNLOADS_PATH` | | slskd's completed-downloads dir as seen by *this* server |
| `MUSICBRAINZ_USER_AGENT` | | Identify yourself per MusicBrainz ToS |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | | Spotify playlist import (client-credentials app) |
| `YOUTUBE_API_KEY` | | YouTube playlist import (Data API v3) |
| `PORT` | | Default `8080` |
| `WEB_DIST` | | Path to the built web app; when set the server serves it (single container) |

MusicBrainz is limited to 1 req/s and responses are cached in Postgres (`mb_cache`, 24 h TTL), so repeated searches cost nothing.

## Self-host it (Kubernetes + ArgoCD)

Prebuilt images are published to `ghcr.io/stoaties/encore` — you only need to build your own if you want to modify the code. Latest release: `ghcr.io/stoaties/encore:v0.3.1`.

**Prerequisites in-cluster:**

- Jellyfin with a music library — Encore uses it for playback, auth, playlists, favorites, and library scans.
- [slskd](https://github.com/slskd/slskd) with the HTTP API enabled — Encore searches and downloads through it.
- Postgres (any 14+; one small database, single connection).
- Two PVCs: a media share both Encore and Jellyfin can read/write (Jellyfin needs to see what Encore writes), and slskd's completed-downloads directory mounted into the Encore pod.

**Fast path (use the published image):**

```bash
git clone https://github.com/Stoaties/encore.git
cd encore/deploy/k8s/overlays/example

cp encore-secrets.env.example encore-secrets.env   # fill in — this file is gitignored
$EDITOR kustomization.yaml                          # set image tag, ingress host, JELLYFIN_PUBLIC_URL
$EDITOR ../../base/pvc.yaml                         # set your storage class + PVC sizes

kubectl kustomize .                                 # sanity check
kubectl create ns encore
kubectl apply -k .
```

**Build your own image (optional — only if you're modifying code):**

```bash
docker build -t ghcr.io/YOU/encore:vX.Y.Z .
docker push ghcr.io/YOU/encore:vX.Y.Z
# then update the `images:` block in overlays/example/kustomization.yaml
```

**ArgoCD:** fork this repo (or copy `deploy/k8s/overlays/example` into your own GitOps repo), then point `deploy/argocd/application.yaml` at your fork's `repoURL` + overlay path. For GitOps use, replace the `secretGenerator` with [sealed-secrets](https://github.com/bitnami-labs/sealed-secrets), [external-secrets](https://external-secrets.io/), or SOPS so plaintext secrets never land in git.

Storage expectations (see `deploy/k8s/base/deployment.yaml`):

- **`/data`** — the NAS share that backs Jellyfin's music library. `MUSIC_LIBRARY_PATH=/data/music`, `STAGING_PATH=/data/encore-staging` keeps the final move atomic. Run the pod with the uid/gid that owns the share (`fsGroup`), since Jellyfin must read what Encore writes.
- **`/slskd-downloads`** — slskd's completed-downloads volume, mounted read-write (Encore moves finished files out). Cross-filesystem moves are handled (copy+delete fallback), so this may be a different share.
- One replica (`strategy: Recreate`) — the acquisition worker is in-process.

The Ingress bumps proxy read timeouts because `/api/events` is a long-lived SSE stream. `/healthz` (liveness) and `/readyz` (readiness: DB + Jellyfin reachable) are wired to probes.

## Android app (Capacitor)

The Android app is the same web code in a Capacitor shell. On first launch the login screen asks for the **server URL** (your Encore URL, e.g. `https://encore.example.com`); everything else works as on the web. Background playback uses a media-session foreground service (`@capgo/capacitor-media-session`): lockscreen/notification controls, hardware media keys, and playback that survives backgrounding. Plain-http servers are allowed (`usesCleartextTraffic`) for LAN-only setups.

Build requirements: Android SDK (platform 36 + build-tools 36), **JDK 21**, `ANDROID_HOME` set.

```bash
cd web
npm run android:sync   # build web assets + copy into android/
npm run android:apk    # android/app/build/outputs/apk/debug/app-debug.apk
```

For a Play-signable release build: `cd android && ./gradlew assembleRelease` with your signing config in `android/app/build.gradle` (see [Capacitor's docs](https://capacitorjs.com/docs/android/deploying-to-google-play)). The iOS project can be added later with `npx cap add ios` — no web-side code changes are Android-specific.

## Notes

- The backend holds each user's Jellyfin access token server-side (DB) and issues its own JWT to clients; clients receive the Jellyfin token only to stream audio/images directly from Jellyfin.
- Soulseek results depend entirely on what peers share. The quality profile (Settings) controls acceptable formats/bitrate; album candidates must cover the full MusicBrainz tracklist to be considered.
- Use responsibly and only for content you have the right to download.
