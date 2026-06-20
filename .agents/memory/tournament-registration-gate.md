---
name: Tournament registration gate
description: Why the Shiba Hit weekly-tournament leaderboard must gate on a CURRENT-CYCLE participant row (per-cycle bucket match), how the intermission carry-over works, and the root cause of the leaderboard infinite-refresh loop
---

The leaderboard unlocks only when a `tournament_participants` row exists FOR THE CURRENT CYCLE — gated by comparing the row's week to the active week, not by the `tournament_joined` flag, not by plain row-existence, and not by exact `week_start` equality. Unregistered users (prestart/live/intermission) see only the poster + JOIN CTA + countdown.

## Why per-cycle bucket matching, and why the obvious alternatives fail
- **Plain row-existence is WRONG (the actual bug):** the server mutates a SINGLETON `tournament_config` (same id every cycle) and does NOT re-wipe participant rows on the Monday reset. A leftover row from a PAST tournament therefore survives and silently bypasses the new-cycle register prompt. The gate must compare the row's cycle to the active cycle.
- **Exact `week_start` equality is WRONG too:** the server stamps `week_start`/`start_time` with a precise per-Monday timestamp, so string compare is fragile and a mid-week admin start mismatches.
- **Fix:** normalize any timestamp to its UTC-week Monday ("bucket") and compare buckets. Keep the gate declarative (derived in render), not a separate stateful signature gate.
  **Why:** declarative re-derivation has no stale-render window the instant fresh config loads.

## Intermission carry-over
- During the Sun 18:00 → Mon 00:00 gap, registration must target the UPCOMING Monday's bucket (not the current/old one) so it equals the bucket the server stamps at the Monday reset → the pre-registration carries seamlessly into the new active week. A returning user's stale row should be RE-POINTED to the current cycle, never duplicated.

## Cycle math MUST use server-corrected time
- Any "next Monday" / cycle calculation for the gate must use `Date.now() + serverOffset`, never the raw device clock. A skewed/manual clock would target the wrong Monday and lock out legit users or admit stale rows — this app's whole tournament timing is server-authoritative by design.
  **How to apply:** render bodies read the `serverOffset` state; deps-free stable callbacks read a ref mirror of it kept in lock-step.

## Leaderboard infinite-refresh loop ("Maximum update depth exceeded")
- **Root cause:** a context refresh callback depended on the `config` object. Every config reload calls `setConfig(newObject)`, so the callback identity churned on every refresh → the dependent `refreshTournament` churned → the leaderboard screen's effects (which depend on it) re-fired → loop. A `serverOffset` recomputed from `Date.now()` each refresh compounded it via boundary effects.
  **Why:** `setConfig` always produces a NEW object; any callback or effect keyed on `config` identity is unstable across every single refresh.
  **How to apply:** keep context refresh callbacks STABLE (empty/minimal deps) and have them read latest config from a ref mirror instead of closing over `config`. Threshold `serverOffset` commits (only when it moves more than ~1.5s) so it stops churning boundary-effect deps.

## Reject = close only
- Rejecting the tournament popup must ONLY dismiss it (local flag); it must NOT insert a participant row. The single participant-create path is the join action.
