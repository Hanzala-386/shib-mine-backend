---
name: Tournament points prod sync
description: Why weekly_tournament_points needs a client-side PocketBase recompute, not just an Express route or a read-only fallback.
---

# Authoritative server-computed fields need a client PocketBase recompute in prod

`users.weekly_tournament_points` is the field the tournament leaderboard sorts by and
end-of-cycle payout reads. Formula: sum `mining_sessions.claimed_amount` for the user
where `claimed_amount > 0 && start_time >= tournament_config.start_time`.

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
