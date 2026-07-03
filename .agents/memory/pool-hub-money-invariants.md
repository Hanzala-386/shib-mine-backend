---
name: Pool/Game-Hub money-path invariants
description: Non-obvious safety rules for the server-authoritative real-money game hub (PT stakes, Hit Tickets payout, reconnect). Read before touching gamehub balance or match-lifecycle code.
---

# Game-Hub money-path invariants

The 8-Ball Pool hub stakes real Power Tokens and pays out Hit Tickets, so every
balance write and match-lifecycle transition is a money path. These rules are not
obvious from the code and were the source of severe review findings.

## Balance writes MUST be atomic PocketBase field modifiers
Use `power_tokens-`/`power_tokens+`/`hit_tickets+` modifier syntax, never
read-modify-write. Two concurrent matches (or a claim happening mid-match) will
clobber each other's balance if you read-then-write.

## pbHttp resolves ALL HTTP statuses — it never rejects
A raw PB write via the hub's http helper returns a "success" promise even on 4xx/5xx.
Any write on a money path must go through a *checked* wrapper that asserts the echoed
record (missing/`code`/no `id` ⇒ throw). Otherwise failed debits/credits pass silently.
Refund paths, by contrast, must be genuinely never-throwing (swallow + CRITICAL log)
so a refund failure can't crash the settlement flow.

## Two-sided debit ordering: guarantee a refund
When debiting two stakers (A then B): if A fails, nobody is charged — abort and
requeue B. If B fails for ANY reason (throw OR insufficient), A has already been
charged and MUST be refunded before returning. There is no path that leaves a player
charged without either a match or a refund attempt.

## settleMatch must latch `settled=true` synchronously BEFORE any await
Multiple triggers converge on settlement (eight-ball pot, turn-timeout, grace
forfeit). The idempotency guard must be set on the match object *before* the first
`await`, or the payout retry loop / concurrent triggers double-credit the winner.
**Why:** payout retry is at-least-once; a lost PB response after a successful credit
can still double-pay. Real idempotency needs the deferred `token_ledger` +
idempotency-key work.

## Reconnect / RESUME rules
- **Why reconnect exists:** a transient socket drop must not forfeit a staked match.
- Client auto-reconnect window must stay strictly *inside* `GRACE_SECONDS` (30s).
  Current: ~10 attempts, 500ms→3s cap ≈ 24s. Reconnect only on *unexpected* close;
  an intentional `close()` (leave / switch to practice) must suppress it.
- Distinguish first-connect from reconnect at the socket layer; on reconnect send
  `RESUME{token,pbId,matchId}` (re-attach), never `JOIN_QUEUE` (would re-stake).
- Server `handleResume` re-binds the socket by seat/pbId and re-sends the full
  `MATCH_FOUND`. **`MATCH_FOUND` MUST carry `ballInHand`.** If a player reconnects
  after the opponent scratched, the cue ball is inactive; without `ballInHand` the
  resumer can neither aim nor place the cue → deadlock into an unearned skip-cap
  forfeit (a real-money loss). Initial break MATCH_FOUND is always `ballInHand:false`.
- `handleDisconnect` matches the seat by *ws identity*, so a late close of the OLD
  socket after a re-bind cannot clobber the new one.
