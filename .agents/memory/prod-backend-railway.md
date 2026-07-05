---
name: Prod backend is Railway (shib-mine-backend), NOT PocketBase-only
description: The shipped APK calls the Express /api/app/* routes in PRODUCTION via Railway. There are TWO diverged Express copies. Correct the outdated replit.md "404 in prod" claim.
---

# The real backend topology

`replit.md` claims "Express runs ONLY in the Replit dev environment; all `/api/app/*` routes 404 on the published APK; api.webcod.in is PocketBase only." **That is outdated / wrong.** Ground truth:

- The shipped APK's API base = `getApiUrl()` → `EXPO_PUBLIC_DOMAIN`, which `eas.json` sets to **`shib-mine-backend-production.up.railway.app`** for every build profile. `lib/api.ts` hardcodes the same string as its fallback, and `backend.webcod.in` is a CNAME to it.
- So in PRODUCTION the APK **does** hit the Express `/api/app/*` routes (on Railway). They do **not** 404. The client-side PocketBase-SDK code paths (e.g. `MiningContext`, `games.tsx`) are **fallbacks** that only run if Railway is unreachable — the Express route is the PRIMARY prod path.

# TWO Express copies — they have diverged

- **`server/`** (repo root) = the **Replit DEV** backend. Workflow `Start Backend` → `npm run server:dev` → `server/index.ts` on port 5000. Only used in the Replit sandbox.
- **`shib-mine-backend/`** = the **Railway PROD** backend source. It is its **own nested git repo** with remote `github` → `github.com/Hanzala-386/shib-mine-backend`; Railway auto-deploys from that GitHub repo. Line numbers differ from root because the two have drifted.

**Rule:** any backend route/logic change for this app must be applied to **BOTH** `server/routes.ts` and `shib-mine-backend/server/routes.ts`. The change only reaches prod after `shib-mine-backend/` is committed and pushed to its GitHub remote (→ Railway redeploys). Restarting the Replit `Start Backend` workflow only updates DEV.

**Why:** considering only the root dev copy produced a wrong "prod is already mining-only / server edits don't affect prod" conclusion. The architect surfaced the second copy; `eas.json` + `lib/api.ts` confirmed it is the live prod host.

**How to apply:** before claiming any backend fix is "live in prod", confirm `EXPO_PUBLIC_DOMAIN` in `eas.json` (current live host) and ensure the matching `shib-mine-backend/` change is pushed to GitHub→Railway. A Replit deploy/restart is NOT the prod deploy for this backend.

# Referral commission policy (this app)
- 10% referral commission is paid **only** on a referee's **mining** claim (`/api/app/mine/claim`, base `serverReward * 0.1`). Gameplay / power-token earnings must **never** credit referral (the old `/api/app/game/reward` `safeAmount * 0.1` block was removed from both copies).
- SEPARATE and intentional: a one-time **+30 Power Token signup bonus** to the referrer fires in `/api/app/auth/sync` when a new user registers with a referrer's code. That is not the 10% commission and is unrelated — do not conflate or remove it when touching referral commission.

## Pool + Arcade Game Hubs: ported to prod SOURCE, pending Railway deploy
Both server-authoritative real-money hubs now exist in BOTH Express copies and are
kept BYTE-IDENTICAL (always verify with `diff -q` after any change):
- Pool 8-Ball: `gamehub.ts` (WS `/api/ws/hub`) + `shared/pool/{physics,rules}.ts`.
- Async score-match arcade (Flappy Bounce): `arcadehub.ts` (WS `/api/ws/hub-arcade`)
  + `shared/arcade.ts`; reuses gamehub's PB money helpers (fetchUser/debitPT/
  creditTickets/safeRefund/pbPatchChecked/pbDeleteChecked).
Each is wired in its own `server/index.ts` via `setupGameHubWebSocket` /
`setupArcadeHubWebSocket` (+ the matching `ensure*Schema`).

**Status:** the prod SOURCE (`shib-mine-backend/`) HAS both hubs, but they only go
LIVE after that nested repo is committed and pushed to GitHub → Railway (the "Deploy
backend to Railway" follow-up). Until then online modes fall back to practice/idle in
the published APK — a silent gap, not a crash.

**Rule:** any hub/engine change must be copied byte-identical into `shib-mine-backend/`
(`diff -q server/<f> shib-mine-backend/server/<f>`) AND the prod esbuild
(`cd shib-mine-backend && npm run server:build`) must exit 0 before it can be deployed.
See `arcade-escrow-money-safety.md` for the shared-PB sweep / delete-as-claim / checked-
write invariants that make these hubs money-safe.
