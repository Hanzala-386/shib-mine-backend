---
name: tournament history & finalize quirks
description: Non-obvious server-runtime behaviors of the Shiba Hit tournament finalize/history flow that the frontend must defend against.
---

# Tournament finalize → history reconstruction

These are SERVER runtime behaviors (in `server/` + `shib-mine-backend/`) that are
not obvious from the frontend code but that any client reading `tournament_history`
must defend against.

## Duplicate finalize rows
- The end-of-cycle finalize can run more than once for the SAME cycle (concurrent
  run / reconciler retry). Each run writes one row per winner, so a single cycle
  can have N×(winners) rows whose `created`/`week_end` differ by milliseconds.
- `tournament_history` has **no `cycle_id` field** — only `created, week_end, rank,
  user_id, display_name, points, prize`. So you cannot key a cycle by an id.
- Reconstruct standings by: cluster rows on `created` within a 30-min window
  (manual cycles are days apart, retries ms–seconds apart → window can't merge two
  cycles), then dedupe by `rank`.

## Stable per-cycle key (for one-time dismissals)
- Use the **EARLIEST** `created` in the cluster as the cycle key, NOT the newest.
  **Why:** retries only APPEND later rows; the earliest never shifts. Keying off the
  newest row makes the key change whenever a retry lands, which re-shows a
  "show once per cycle" popup the user already dismissed.

## phase 'none' can lead history (stale-cycle window)
- Client phase is `getTournamentPhase(config)` → `'none'` whenever
  `!config.is_active` (or config===null). The server finalize sets
  `is_active=false` **before** it writes the history rows.
- So there is a brief window where phase is already `'none'` but the newest
  `tournament_history` rows still belong to the PREVIOUS cycle → showing them is
  stale/wrong.
- **How to apply:** when surfacing "last cycle" standings during phase `'none'`,
  pass the just-ended `config.end_time` as a cutoff and require the newest history
  `created >= end_time − grace` (~10 min); otherwise treat as "not exported yet"
  and show the loading/inactive placeholder. Skip the cutoff only when there is no
  current cycle context (config===null).

## Reward crediting
- Prizes are auto-credited to winners' balances server-side at finalize. Any
  winner "claim"/celebration UI must be cosmetic (refresh balance only) — calling
  a reward endpoint would double-credit.
