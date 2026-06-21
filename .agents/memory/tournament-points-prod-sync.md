---
name: Tournament points prod sync
description: Why weekly_tournament_points needs a client-side PocketBase recompute, not just an Express route or a read-only fallback.
---

# Authoritative server-computed fields need a client PocketBase recompute in prod

`users.weekly_tournament_points` is the field the tournament leaderboard sorts by and
end-of-cycle payout reads. Formula: sum `mining_sessions.claimed_amount` for the user
where `claimed_amount > 0 && updated >= <cycle start, SPACE-formatted>`.

## Two bugs that kept points at 0 forever (both required to fix)
1. **Filter FIELD must be `updated`, not `start_time`.** A claim writes `claimed_amount`
   (bumping PB's `updated` to claim-time) but never touches `start_time`. A 60-min session
   started BEFORE the cycle but claimed INSIDE it must still score. `start_time >= cycleStart`
   implies `updated >= cycleStart`, so `updated` is the strict superset = "earned this cycle".
2. **PocketBase datetime filters parse a SPACE separator, NOT the ISO `T`.** `tournament_config.start_time`
   is a TEXT field storing `2026-06-21T06:18:00.000Z` (with `T`). Passed raw into a `mining_sessions`
   datetime filter it matched ZERO rows (proven live: `>= "...T..."` → 0, `>= "... ..."` → correct).
   The `user="id"` and `claimed_amount>0` clauses worked; only the date clause silently zeroed results.
   **Fix:** `.replace('T', ' ')` the comparison value before building any PB datetime filter.
   **Why it matters broadly:** any PB filter built from an ISO/`toISOString()` value (or a text field
   holding ISO-T) is a latent zero-match bug. Always space-separate datetime filter values.

**The trap:** the published APK has NO Express server. `getApiUrl()` in prod resolves to
the Railway host (`backend.webcod.in`), which has NO tournament logic, so any
`/api/app/tournament/...` route 404s silently. A "fallback" that only READS the field
(e.g. a refresh that reads + mirrors) can never repair it → points stay 0 forever in prod.

**Why:** dev Express (`server/`) runs all tournament logic against the SHARED live PB,
but that code path does not exist in production at all. It is not enough for an
`/api/app/*` call to have *a* PocketBase fallback — if the only fallback is read-only,
an authoritative write-side computation is still missing in prod.

**How to apply:** mirror the server formula client-side (`syncTournamentPointsToPb` in
`lib/api.ts`). Gate on `tournament_config.is_active === true` (server-controlled — the
real guard against resurrecting points that end-of-cycle payout already zeroed) plus an
end-time check; require `user.tournament_joined`; write `weekly_tournament_points` in a
STANDALONE update (never bundle it with the balance credit); skip the write when
unchanged; keep the whole thing best-effort try/catch so it never blocks a claim. Wire it
into the claim path, the join path, and the leaderboard-refresh path (self-heal).
Client-writing this field adds NO new trust risk: prod is already fully client-trusted —
`claimed_amount` and `shib_balance` are client-written via the
`users.updateRule = "@request.auth.id = id"` self-update rule.
