---
name: Tournament Zero-Trust Architecture
description: Security decisions for the weekly tournament — server-side scoring, dual calendar crons, intermission state, server-time anti-hack.
---

## The rule
`weekly_tournament_points` is NEVER written by the client (APK). Only the server may update this field.

**Why:** A client-side write means any user can set arbitrary points. Closed in this session by removing the `pb.collection('users').update(pbId, { weekly_tournament_points: ... })` call from `MiningContext.tsx` and replacing it with a fire-and-forget `POST /api/app/tournament/sync-points/:pbId`.

**How to apply:** The sync-points route reads `mining_sessions` directly from PocketBase (filter: `user = "${pbId}" && claimed_amount > 0 && start_time >= "${weekStart}"`), sums `claimed_amount`, and atomically writes the total. This is the ONLY allowed write path.

---

## Dual calendar-aligned crons (server/tournament.ts)

Two `setTimeout`-based crons fire at precise UTC wall-clock times (not relative intervals):

- **Cron A — Sunday 18:00 UTC**: `runEndOfWeek()` — sets `is_active=false`, distributes prizes, exports to `tournament_history`, resets all participants.
- **Cron B — Monday 00:00 UTC**: `startNewTournamentWeek()` — sets `is_active=true`, writes new `start_time` + `end_time` on the config record.

On server boot, a catch-up check runs: if `end_time` has already passed while the server was down and `is_active` is still true, `runEndOfWeek()` fires immediately.

**Why not setInterval:** A weekly setInterval drifts, fires at wrong times after server restarts, and doesn't align to calendar boundaries.

---

## Intermission state

The gap between Sunday 18:00 UTC and Monday 00:00 UTC is the "intermission" — `is_active=false` but the next week hasn't started yet.

- `GET /api/app/tournament/config` returns `isIntermission: !raw.is_active`.
- `TournamentContext` exposes `isIntermission: boolean` and `serverOffset: number`.
- The popup (`TournamentBannerPopup`) shows during both active AND intermission, with different wording ("NEXT WEEK STARTS IN" vs "TOURNAMENT ENDS IN").
- The leaderboard shows a frozen last-week view with a purple "TOURNAMENT FROZEN" banner during intermission.
- Joining during intermission sets `registered_during_intermission: true` on the `tournament_participants` record.

---

## Server-time anti-hack (device clock manipulation)

`GET /api/app/tournament/config` returns `serverTime: Date.now()` alongside config.

Client computes: `serverOffset = serverTime - Date.now()` at load time.

All countdown math: `Date.now() + serverOffset` — compensates for device clock manipulation.

**Why this works:** If the user moves their device clock forward, `Date.now()` increases, but `serverTime` (captured at load) stays fixed, so `serverOffset` becomes more negative, cancelling the manipulation.

---

## PocketBase field additions (tournament_config)
- `start_time` (text) — ISO datetime of current week start
- `end_time` (text) — ISO datetime of current week end (next Sunday 18:00 UTC)

## PocketBase field additions (tournament_participants)
- `registered_during_intermission` (bool)

## New collection: tournament_history
Permanent record of past winners: `week_end`, `rank`, `user_id`, `display_name`, `points`, `prize`.
