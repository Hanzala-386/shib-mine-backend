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

## 5. A cosmetic client-side delay between MATCH_START and game-start is money-safe
The arcade-match screen may hold a short reveal (e.g. a ~2s "VS" animation) AFTER the
server's MATCH_START and BEFORE it injects `ARCADE_MATCH_START` into the game WebView.
**Why:** the server debits BOTH stakes BEFORE it emits MATCH_START, and settlement is
gated on either the 30s disconnect grace (ARCADE_GRACE_SECONDS) or real gameplay
scores — so no REFUND/MATCH_RESULT can arrive inside a short reveal window, and the
delayed start is never penalized. The staked player therefore cannot be stranded by a
UI delay as long as it stays well under the grace period.
**How to apply:** keep any pre-start reveal ≪ 30s; guard the reveal timer with
`if (modeRef.current !== 'matchfound') return;` so a result/error that DID land can't
be clobbered; on mid-match RESUME (matchAcked) skip the reveal entirely. Keep the game
WebView in ONE positionally-stable JSX slot toggled visible/offscreen (never a second
mount) so it doesn't reload at match start.

## 6. The scoreDelta budget must EXCEED the game's honest scoring pace — validate, don't guess
A per-game `scoreDelta.maxIncrement` set BELOW the real honest rate makes the clamp
silently eat legitimate points: the server-accepted score (which feeds BOTH the
opponent's live display AND settlement) crawls behind real play, so both players see
a "stuck" opponent and the settle can pick the wrong winner.
**Why:** Stack's spec assumed +1/block but the C3 template scores ~+10/block with combo
spikes — the budget sat under honest pace and every match desynced. Docs/assumptions
about a template's scoring lie; only a real practice run tells the truth.
**How to apply:** before real stakes, measure the honest peak pts/s in a practice run
and set the budget ~5–10x above it (a teleport cheat is still clamped at the cap and
flagged). Also: the accept-clock must be remainder-preserving — advance `lastScoreAt`
by `windows * minIntervalMs` actually consumed, NOT to `now`; resetting to `now`
discards the sub-window remainder (~17% of budget at a 600ms report cadence vs a
500ms window) and compounds the lag. Never advances past `now`, so nothing banks.
