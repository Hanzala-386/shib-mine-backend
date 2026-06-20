---
name: Tournament weekly-payout idempotency (double-credit guard)
description: How runEndOfWeek avoids paying the same cycle's SHIB prizes twice, why the marker is a per-cycle bucket (not a bool), and the in-process lock that closes the concurrency gap
---

`runEndOfWeek` credits weekly SHIB prizes to winners. It must pay each cycle EXACTLY once, even on a retry or an overlapping run, because prize crediting is real money.

## The guard: a per-cycle finalization marker, NOT a bool
`tournament_config.payout_finalized_bucket` (text) stores the UTC ISO-week-Monday bucket (`YYYY-MM-DD`) of the cycle that was last paid — the SAME bucket key the rest of the tournament uses (participant cleanup, registration gate). Before distributing prizes, compute `cycleKey = mondayBucket(cfg.start_time || cfg.week_start)`; if `payout_finalized_bucket === cycleKey`, skip distribution + history. Otherwise pay, then patch the marker to `cycleKey` the instant the prize loop completes.

**Why a bucket string, not a `payout_processed` bool:** the next cycle's Monday is a different bucket, so a new week auto-re-arms payout with NO reset step. `startNewTournamentWeek` / admin start change `start_time` to a new bucket and naturally re-arm; they must NOT clear the marker.

**Why it must not gate reset/wipe:** when already-finalized, the function STILL proceeds to the user-points reset + participant wipe (those are idempotent and were a prior leak source — see tournament-participant-cleanup.md). Only payout+history are skipped. The guard sits inside the existing per-phase try/catch so a payout failure never skips the wipe.

## Concurrency: in-process lock makes it atomic
The marker is check-then-set with an await gap, so two overlapping calls could both pass the check before either writes. The ONLY callers of `runEndOfWeek` are the Sunday freeze cron and the boot catch-up — both in the SAME single Node process (admin "start" writes config via PB SDK and never calls `runEndOfWeek`). So a module-level in-flight `Promise` lock (`endOfWeekInFlight`) that makes concurrent calls join the running one fully serializes them and makes finalization atomic. freeze-first (`is_active=false` before payout) + boot catch-up only calling `runEndOfWeek` when `is_active===true` already gate most overlap; the lock + marker close the rest.

**How to apply:** any new caller of `runEndOfWeek` must go through the locked public entry, never the inner impl. Any change to payout must keep: check marker → pay → set marker LAST, all inside the lock.

## Known limitation (not a bug)
Admin same-UTC-week test restart shares one Monday bucket → would skip payout (marker already matches). Production tournaments are weekly so this only affects manual same-week testing. Lives only in dev Replit `server/tournament.ts`; Railway `shib-mine-backend/` has NO tournament payout/cron. Restarting "Start Backend" migrates the live shared PB (adds the field).
