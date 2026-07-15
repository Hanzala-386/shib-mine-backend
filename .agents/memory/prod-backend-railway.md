---
name: Prod backend = Railway (git push deploys); VPS bundle prepared; TWO Express copies
description: Prod APK hits Express /api/app/* via https://backend.webcod.in — still Railway; git push github main auto-deploys it. VPS single-file bundle prepared but not cut over. Two diverged Express copies must both be patched.
---

# The real backend topology (updated Jul 15 2026 — Railway still live)

- The shipped APK's API base = `getApiUrl()` → resolves to **`https://backend.webcod.in`** (older builds baked the railway.app host, which the filter in `lib/query-client.ts` redirects to the same domain). In PRODUCTION the APK **does** hit the Express `/api/app/*` routes — client-side PocketBase-SDK paths are fallbacks only.
- **Railway is STILL live prod (verified Jul 15 2026):** `curl -I https://backend.webcod.in` returns `server: railway-hikari` — the planned VPS cutover has NOT happened (no VPS SSH creds exist in this workspace). **`git push github main` DOES auto-deploy Railway** (~2-4 min build): pushing a commit changed live `/api/ws/game` behavior with no other action. The earlier "push no longer deploys" note was wrong. Deploy-verify trick: WS-play a tiny full game (GAME_START→GAME_OVER, no claim) against prod and poll the created game_score row for the new behavior.
- VPS single-file bundle (below) is PREPARED but not serving traffic until the DNS flip.

# VPS deploy model — single-file bundle, no package install

- `scripts/build-vps.sh` → `dist/shib-backend-vps.zip`: esbuild **full** bundle (`--bundle --format=cjs --external:pg-native`, NOT `--packages=external`) of `shib-mine-backend/server/index.ts` → one `server.cjs`. The VPS runs `node server.cjs` under systemd behind nginx (WS upgrade headers + `client_max_body_size 12m` required); zero network at deploy time so the "build" cannot fail.
- Runtime paths are `process.cwd()`-relative: the package must ship `public/`, `server/templates/`, `app.json` next to `server.cjs` and run from that dir.
- Server port: `SERVER_PORT` beats `PORT`.
- **Updating prod now = rebuild bundle on Replit → scp `server.cjs` → `systemctl restart shib-backend`.** Git push to the old Railway GitHub repo no longer deploys anything.
- Cutover safety order: same `SESSION_SECRET` as old host (HMAC match-sig continuity) → pre-issue TLS via certbot DNS-01 BEFORE the DNS flip → verify → only then kill the old host.

# getApiUrl trailing-slash gotcha

`new URL('https://host').href` ends with `/`; string-concat consumers (hubClient/arcadeClient `+'/api/ws/hub-arcade'`, KnifeShop `+'/game/'`) then build `//`-paths the server never matches. `getApiUrl()` must return `.origin` (never has a trailing slash). This was latent while every prod build fell through to the hardcoded PRODUCTION_URL constant; it bites the moment EXPO_PUBLIC_DOMAIN passes the filter.

# TWO Express copies — they have diverged

- **`server/`** (repo root) = Replit DEV backend (`Start Backend` workflow, port 5000).
- **`shib-mine-backend/`** = PROD backend source (now the source for the VPS bundle). It is **NOT a nested git repo** — the whole workspace is ONE repo whose `github` remote points at `Hanzala-386/shib-mine-backend.git`; `git push github main` pushes everything (PAT is embedded in the remote URL — never print it unmasked).
- **Rule:** any backend route/logic change must be applied to **BOTH** `server/routes.ts` and `shib-mine-backend/server/routes.ts` (line numbers differ — they drifted). Verify game/hub sections with `diff -q` and both esbuilds exit 0.

# PB admin auth endpoint on this PocketBase

`api.webcod.in` admin login = `POST /api/admins/auth-with-password` (pre-v0.23 API). The newer `/api/collections/_superusers/auth-with-password` path FAILS on this instance — scripts using env `PB_ADMIN_EMAIL`/`PB_ADMIN_PASSWORD` must hit `/api/admins`.

# Referral commission policy (this app)
- 10% referral commission is paid **only** on a referee's **mining** claim (`/api/app/mine/claim`, base `serverReward * 0.1`). Gameplay / power-token earnings must **never** credit referral.
- SEPARATE and intentional: one-time **+30 Power Token signup bonus** to the referrer in `/api/app/auth/sync` — not the 10% commission; do not conflate or remove.

# Pool + Arcade Game Hubs
Both server-authoritative real-money hubs exist in BOTH Express copies, kept BYTE-IDENTICAL (`diff -q` after any change): Pool 8-Ball `gamehub.ts` (WS `/api/ws/hub`), arcade `arcadehub.ts` (WS `/api/ws/hub-arcade`) + `shared/arcade.ts`. They go live on the VPS when a freshly built `server.cjs` is uploaded. See `arcade-escrow-money-safety.md` for the money-safety invariants.
