---
name: Tournament config serialization & prize source
description: Why tournament leaderboard prizes go blank; the reward_structure string-vs-object contract between the Express config endpoint and the app.
---

# Tournament leaderboard prizes — where they come from & how they break

## Prize is CLIENT-computed, not from /api/app/leaderboard
- The leaderboard screen has TWO tabs. The **All-Time** tab comes from Express
  `/api/app/leaderboard` (top users by `shib_balance`, NO prize field).
- The **Tournament** tab is built in `TournamentContext.refreshLeaderboard()`:
  it reads `users` directly from PB (sorted by `weekly_tournament_points`,
  filtered `tournament_joined = true && weekly_tournament_points > 0`) and sets
  `prize = Number(rewardMap[String(rank)])` where
  `rewardMap = configRef.current?.reward_structure`.
- So "winning amounts blank on the app but visible in admin" is almost never an
  `/api/app/leaderboard` problem. It is an empty/missing `reward_structure`, OR
  an empty participant list (points stuck at 0 → no rows at all).

## reward_structure MUST be a raw JSON STRING over the wire
**Rule:** `/api/app/tournament/config` must return `config.reward_structure` as the
RAW JSON STRING exactly as stored in PocketBase (e.g. `"{\"1\":400000,...}"`),
NOT a pre-parsed object.

**Why:** `TournamentContext.loadConfig` does `JSON.parse(raw.reward_structure || '{}')`.
If the endpoint pre-parses it into an object, `JSON.parse(anObject)` coerces to
`JSON.parse("[object Object]")` → throws → the catch swallows it → `rewardMap = {}`
→ every rank prize is 0 → all winning amounts render blank. Admin is unaffected
because it reads PocketBase directly (string) and parses it itself.

**How to apply:** keep the endpoint's `config` shape byte-identical to a raw PB
record: `reward_structure` (string), plus `banner` (file field) AND `banner_url`
(legacy) so banner images survive the Express path too. The PB-direct fallback in
the app is the reference shape.

## Dev vs prod divergence that masked this
- The buggy parsed-object version lived ONLY in the dev/root `server/routes.ts`.
- The prod copy `shib-mine-backend/server/routes.ts` originally had NO
  `/api/app/tournament/config` route at all, so the APK fell back to PB-direct
  (string) and parsed fine — prod prizes worked via fallback. The bug was visible
  in the Replit dev preview / anywhere the root server is the backend.
- Fix kept both copies in lockstep: dev returns the string; prod got the same
  endpoint added (also returning the string) for parity + robustness.
