---
name: Shiba Hit display paths & deploy topology
description: Two gotchas in Shiba Hit — mining yield renders via two independent code paths, and shib-mine-backend/ is a full app copy where only server/ is deployed.
---

# Mining yield is displayed via TWO independent paths
In `context/MiningContext.tsx` the per-session SHIB yield reaches the UI through two
separate computations that must stay in sync:
1. `shibReward` (a render-time value, fed into the context `useMemo`) — drives the
   idle "Earns ~X", the progress label, and the "Claim ~X" button.
2. The live rolling counter `displayedShibBalance`, computed inside `startTimers()`'s
   100ms interval — drives the animated ticking balance during active mining.

**Why:** A VIP fix once updated only `shibReward`; the rolling counter kept ticking at
the base (VIP-0) rate, so the animated number disagreed with the claim button.
**How to apply:** Any change to mining economics (rate, booster, VIP increment) must be
applied to BOTH places. The correct rate is `effectiveRatePerSec(base, level)` =
base + increment(level), never bare base. For active sessions use the session-locked
VIP (`session.vipLevel`, sourced from `mining_sessions.vip_level`), and current
`user.vipLevel` only for the idle preview. Don't reuse `session.expectedReward` as a
UI source — restore paths set it without VIP, so it's unreliable.

# shib-mine-backend/ is a full app copy — which server/ Railway actually deploys is UNCONFIRMED
`shib-mine-backend/` is a complete in-repo duplicate of the whole project (its own
`app/`, `app.json`, `server/`, `shared/`, package name "expo-app"). It IS git-tracked
(~470 files), so it ships to the GitHub repo Railway pulls from. The shipped APK and
the Replit dev workflows build from the repository ROOT.

Production API base: `getApiUrl()` (lib/query-client.ts) → `PRODUCTION_URL =
https://backend.webcod.in` in BOTH dev and the EAS APK (host is empty / a *.replit.dev
tunnel, so it never uses the local host). `backend.webcod.in` is a CNAME →
`shib-mine-backend-production.up.railway.app` (Railway). So the APK talks to Railway in
production — NOT PocketBase-only. The git remote is `github.com/Hanzala-386/shib-mine-backend`
(repo name == Railway service name == the subdirectory name → genuinely ambiguous).

**UNRESOLVED:** whether Railway builds from the repo ROOT `server/` or the nested
`shib-mine-backend/server/`. Can't be determined from the repo — it's the Railway
dashboard "Root Directory" + custom build/start command (both package.json `start`
scripts are `npx expo start`, so a custom start is definitely set there). Contradicting
evidence: root `server/` has the full tournament system (tournament.ts + routes + CRON);
the subdirectory has ZERO tournament refs. If the subdirectory were prod, tournaments
would 404 in the APK. An earlier note here asserted "Railway runs the subdirectory" —
treat that as unverified.
**How to apply:** Do NOT delete either server copy or recommend doing so until the
Railway dashboard Root Directory is confirmed. Until then keep mirroring backend
REWARD/VIP logic across `server/routes.ts`, `shib-mine-backend/server/routes.ts`, the
PB-direct fallback in root contexts, and `shared/vip.ts` in both roots. Frontend
changes still go in ROOT only.
**Stale doc:** replit.md still claims "Express runs ONLY in Replit dev / APK 404s on
/api/app/*" — that's outdated; the APK hits Railway via backend.webcod.in.

# One shared PocketBase + collection-creation uses `schema:` not `fields:`
All servers (root dev Express, root Railway, subdir Railway) point at the SAME
PocketBase, `https://api.webcod.in`. So a collection/seed provisioned by ANY server's
boot exists for ALL of them — mirroring schema-provisioning code into both servers is
defensive only; restarting the local root "Start Backend" already creates the
collection in production PB. **Gotcha:** this PB version's REST collection-create API
expects the legacy `schema:` array key (NOT `fields:`) and rejects rules inline — set
listRule/viewRule/etc. in a SEPARATE PATCH after create. The subdir routes.ts mixes
both styles (some ensure* use `fields:`); trust `schema:` — it's the confirmed-working
one (root tournament.ts creates with `schema:` successfully against api.webcod.in).
