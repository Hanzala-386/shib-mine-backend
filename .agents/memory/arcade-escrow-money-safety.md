---
name: Arcade PvP escrow & score money-safety
description: Durable money-safety rules for the async score-match PvP arcade engine (arcadehub.ts) — shared-PB boot sweeps, delete-as-claim refunds, checked PB writes, and the limits of rate-clamp anti-cheat.
---

# Arcade PvP money-safety invariants

The async score-matching arcade engine escrows both players' Power-Token stakes in
memory during a live match and pays the winner Hit Tickets at settlement. In-memory
escrow is lost on crash/redeploy, so there is a PB `arcade_escrow` journal + a boot
sweep. The rules below are the non-obvious lessons; the mechanics are in the code.

## 1. Dev & prod SHARE one PocketBase → every boot sweep MUST be age-gated
`api.webcod.in` is the SAME PocketBase for the Replit dev server AND the Railway prod
server. A boot-time reconciliation/sweep that refunds "unresolved" escrows will, if
naive, refund the *other* environment's currently-LIVE matches.
**Why:** a dev restart while a real player is mid-match in prod (or vice-versa) would
otherwise wipe a live match's stakes back to the players and desync the match.
**How to apply:** gate the sweep on age — only refund escrows older than the match
lifetime cap + margin (`ARCADE_MAX_MATCH_MS + 60s`). The lifetime cap force-settles
EVERY live match by 10min, so any escrow younger than the cutoff is still in flight
somewhere and must never be touched. PB datetime filters use a SPACE separator, not
ISO `T` (else the filter matches 0 rows and the sweep silently no-ops).

## 2. DELETE-as-claim for exactly-once refunds across concurrent boots
Use a PB record DELETE as the atomic claim in the sweep: DELETE first, and only the
process whose DELETE returns success refunds; a loser gets 404 and skips.
**Why:** PATCH-ing a `resolved=true` flag is NOT a claim — an idempotent PATCH lets two
overlapping boots (dev restart coinciding with a prod redeploy) both list the same
`resolved=false` orphan and both refund it → double-refund of real money. DELETE is
single-winner: only one caller gets the 204.
**How to apply:** in the sweep, `pbDeleteChecked(record)` → on success refund both
sides; on throw `continue`. Accept the bounded residual: a crash between the DELETE and
the refund loses that one orphan's refund (record already gone) — matches the existing
`safeRefund` best-effort/CRITICAL-log trust model.

## 3. pbHttp NEVER rejects on HTTP errors → money writes need *Checked wrappers
`pbHttp` resolves on ALL statuses: JSON error → `{code,...}`; a 204 (empty body) →
`{raw:''}`; a non-JSON proxy/CDN error page (502 HTML) → `{raw:'<html>…'}`. It only
rejects on a network throw.
**Why:** a raw `pbPatch`/`pbPost`/`pbDelete` therefore reports silent SUCCESS on a
4xx/5xx. That makes any retry loop dead code AND, for the escrow-resolve path, leaves a
settled match marked unresolved forever → every later boot re-refunds it (repeatable
double-pay).
**How to apply:** every money-affecting write/delete goes through a checked wrapper:
`pbPatchChecked`/`pbPost` verify PB echoed a real `id`; `pbDeleteChecked` treats ONLY
an empty body `{raw:''}` as success and throws on `{code}` OR a non-empty `{raw:...}`.
Mark/remove the escrow at the TOP of settle (after the settled latch, before any
credit/refund) so a settled match is never re-swept.

## 4. A rate clamp bounds throughput, NOT honesty
Server score anti-cheat is a hard time-bounded clamp: `windows = floor(elapsed /
minIntervalMs)`, `allowedDelta = windows * maxIncrement`; reject an over-fast update
WITHOUT advancing the score or resetting `lastScoreAt` (so honest cadence is still
measured from the last genuine accept). This closes burst-spam and post-RESUME
arbitrary-jump cheats.
**Why/limit:** it bounds the *rate* of scoring, not the *truth* of it. A scripted
client holding its own PB token can connect directly, never send PLAYER_OUT, and drip
one point every `minIntervalMs` — it wins every match with zero violations flagged.
**How to apply:** treat the clamp as necessary-not-sufficient; the open future
hardening is to flag perfectly metronomic (exactly-at-limit) cadence to
`suspicious_users`, not to tighten the clamp.
