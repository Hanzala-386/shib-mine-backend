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

# shib-mine-backend/ is a full app copy, but only its server/ ships
`shib-mine-backend/` contains a complete duplicate of the Expo app (its own `app/`,
`app.json`, package name "expo-app"), but Railway deploys/runs only its `server/`.
The shipped APK and the Replit dev workflows both build from the repository ROOT.

**Why:** It looks like you must mirror frontend edits into the copy, but its
`context/`, `app/`, etc. are dead code at runtime — Railway never bundles the RN
frontend.
**How to apply:** Frontend changes go in the ROOT only. The thing that genuinely must
stay mirrored across locations is the backend REWARD/VIP logic: `server/routes.ts`
(local Express), `shib-mine-backend/server/routes.ts` (Railway), the PB-direct
fallback in root `context/MiningContext.tsx`, and `shared/vip.ts` in both roots. Only
mirror frontend context into shib-mine-backend/ if a future build actually targets
that directory.
