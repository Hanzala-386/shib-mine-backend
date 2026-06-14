---
name: Tournament system
description: Weekly tournament architecture — PB schema, CRON, context, UI components.
---

## Rule
All tournament user ops (join, points, leaderboard) use PB SDK directly — never Express.

**Why:** Express (port 5000) is dev-only; the published APK cannot reach it.

## Collections
- `tournament_config` — single admin-controlled record: prize_pool_total, winners_count, reward_structure (JSON text), banner_url (text URL), week_start (text ISO), is_active (bool). listRule/viewRule = "" (public read).
- `users.tournament_joined` (bool) — set true when user registers.
- `users.weekly_tournament_points` (number) — incremented at mining claim if tournament_joined = true.

## Mining claim flow
In `pbClaimMining` (context/MiningContext.tsx): if `user.tournament_joined`, spread `weekly_tournament_points` into the same `pb.collection('users').update()` call as shib_balance.

## Rejection flag
`AsyncStorage.setItem('tournament_rejected_${config.week_start}', 'true')` — prevents popup reappearance until next week's week_start changes.

## CRON
`server/tournament.ts` → `startTournamentCron()` checks on startup if 7 days elapsed since `week_start`; runs distribution if overdue, else schedules remaining time. After each run, schedules exactly 7 days. Min delay 60s to prevent tight loops.

## Prize distribution
Server reads top N users (sorted by weekly_tournament_points, filter tournament_joined=true), credits shib_balance per rank from reward_structure JSON, then resets ALL tournament_joined users to false + weekly_tournament_points = 0 in batches of 100, then bumps week_start to now.

## Admin panel
`app/admin.tsx` "Weekly Tournament Setup" section — banner URL, prize pool, winners cap (3/50/100), rank 1/2/3 prizes. Save calls `pb.collection('tournament_config').update/create`. Saving sets week_start=now, triggers fresh week for all users.
