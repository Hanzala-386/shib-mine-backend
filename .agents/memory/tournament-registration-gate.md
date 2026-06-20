---
name: Tournament registration gate
description: How the Shiba Hit weekly tournament leaderboard is locked behind a real participant row, and why row-existence (not week_start matching) is the correct gate
---

Leaderboard visibility is gated on the existence of a `tournament_participants` ROW for the user — NOT on the `tournament_joined` flag (which had a silent-create bug) and NOT on strict `week_start` matching. Unregistered users (prestart/live/intermission) see only poster + REGISTER + countdown; the board unlocks only once a row exists.

## Weekly lifecycle quirk (the reason row-existence beats week_start matching)
- **Sunday freeze (`runEndOfWeek`)**: wipes ALL `tournament_participants` rows AND sets `is_active=false`.
- **Monday reset (`startNewTournamentWeek`)**: sets a NEW `week_start`/`start_time` and `is_active=true`, but does **NOT** re-wipe rows.
- **Consequence**: a user who pre-registers DURING intermission (Sunday 18:00 → Monday 00:00) gets a row stamped with the OLD `week_start`. That row survives into the new week. So matching `row.week_start === config.week_start` FALSELY locks out intermission pre-registrants.
  **Why:** verified in `server/tournament.ts` — intermission rows intentionally carry the prior cycle's `week_start`.
  **How to apply:** gate on plain row existence (`registeredWeek != null`). Do NOT reintroduce strict `week_start` equality unless the server's row lifecycle changes to re-stamp/re-wipe on Monday.

## Client must re-fetch config at the live→end boundary
- `getTournamentPhase()` returns `'live'` as long as `is_active` is true and now ≥ start — it keeps returning `'live'` even after `end_time` passes. Only the SERVER flipping `is_active=false`/intermission ends it.
  **Why:** `end_time` alone never changes the client-computed phase, so a user sitting on the screen across the Sunday wipe would keep seeing the (now wiped) board unless the client re-pulls config.
  **How to apply:** at the live→end boundary fire a one-shot config refresh, backed by a visible-only (focused + AppState active + tournament tab) ~60s poll for cron lag. One-shot guard keyed by `end_time` prevents a refresh loop, because `refreshConfig` can nudge `serverOffset` (a boundary-effect dep).

## Cycle-signature hard gate (closes the cross-wipe stale-render window)
- On every config load, compare `${week_start}|${is_active}` to the previous signature; if it changed (Sunday freeze or Monday reset) clear the cached registration SYNCHRONOUSLY before re-confirming the row.
  **Why:** without this, cached `isRegistered=true` survives the async revalidation window and the wiped board flashes. Registering does NOT change the config signature, so a genuinely-registered mid-cycle user is never spuriously locked.
