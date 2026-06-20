---
name: Tournament participant cleanup (auto-clearing across cycles)
description: How tournament_participants rows are wiped/cleaned across cycles, why cleanup must be bucket-aware and live at every cycle-start entry point, and the carry-over invariant it must never break
---

`tournament_participants` rows must NOT survive past their cycle. Historically the only wipe was inside `runEndOfWeek` step 8, which made rows leak across cycles in two ways: (a) the wipe shared one try/catch with payout/history/reset, so any earlier throw skipped it; (b) the boot catch-up was gated on `cfg.is_active === true`, so an already-frozen-but-not-wiped state could never self-heal. Admin manual starts (client-side PB write) also never cleaned up.

## The cleanup must live at EVERY cycle-start/-end entry point
Cleanup is not a single function call — it must fire wherever a cycle ends or a new one begins, because no single path is guaranteed to run in production:
- **`runEndOfWeek` (Sunday freeze cron):** each phase (config-load, freeze, payout/history, joined-reset, participant-wipe) in its OWN try/catch so the wipe ALWAYS runs even if payout throws. The wipe is unconditional `wipeAllParticipants()` (read all ids first, THEN delete — paginating-while-deleting skips rows via index shift).
- **`startNewTournamentWeek` (Monday reset cron):** after activating config, `cleanStaleParticipants(bucket(now), inclusive=false)` — strictly-older buckets only.
- **Boot catch-up (`startTournamentCron`):** `end passed && is_active` → full `runEndOfWeek`; NEW branch `end passed && !is_active` → `cleanStaleParticipants(bucket(start_time), inclusive=true)` to recover orphans an earlier failed wipe left behind.
- **Admin manual start (`app/admin.tsx` `handleSaveTournament`):** the production APK has NO Express server, so admin start writes config client-side via PB SDK and must do the cleanup client-side too — mirror `cleanStaleParticipants(inclusive=false)` with a local `cycleBucketIso` helper (strictly-older only). Best-effort try/catch — never block the save.

## The invariant cleanup must NEVER break: future-bucket carry-over
Bucketing = normalize any ISO ts to its UTC ISO-week Monday (`YYYY-MM-DD`). The registration-gate feature deliberately creates intermission pre-registrations stamped with the UPCOMING Monday (a FUTURE bucket). So cleanup MUST be bucket-aware:
- **Strictly-older (`<` threshold), `inclusive=false`** at cycle START — removes prior cycles, keeps this-week (same bucket) + future pre-regs.
- **`<=` threshold, `inclusive=true`** only for ended-cycle recovery — removes the ended cycle AND older, still never a future bucket.
- A naive `week_start != activeConfig` or raw `< start_time` rule WOULD delete legit next-week pre-registrations. Always compare Monday buckets, and skip rows whose `week_start` is unparseable (conservative — don't delete what you can't classify).

**Why:** confirmed in prod — 6 orphaned rows across 3 cycles; boot catch-up recovery logged `Stale participants cleaned: 6 (bucket <= 2026-06-15)` and prod count went to 0.

## Known limitation (not a bug)
Admin same-UTC-week test cycles ("start in X hours") share ONE Monday bucket, so mid-week back-to-back admin cycles aren't auto-distinguished by bucket. Production tournaments are weekly, so this only affects manual same-week testing. The freeze-wipe + one-time boot recovery cover the real weekly flow.

## Payout idempotency (RESOLVED — see tournament-payout-idempotency.md)
`runEndOfWeek` now has a per-cycle finalized marker (`tournament_config.payout_finalized_bucket`) + an in-process lock so a retry/concurrent run can't double-pay. The guard gates ONLY payout/history — the participant wipe + points reset still always run when already-finalized.
