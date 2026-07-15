---
name: Solo-game claim guards
description: Money-safety rules for solo (non-PvP) game reward claims validated against WS-committed scores.
---

# Solo-game claim guards (Knife Hit / Weapon Master pattern)

## Rule 1 — Validate claims against the server-committed score, never wall-clock heuristics
**Why:** A "duration × N PT/s" heuristic uses wall-clock time from match start to *claim*, which includes ad-watching and idle time. The server's own WS validator allows much higher in-play rates, so a heuristic threshold WILL blacklist legit high scorers (architect caught this before it shipped in strict mode).
**How to apply:** The WS commit stores the validated score on the match row; the claim endpoint checks `claim ≤ 2× committed` (2× = ad double). Keep any wall-clock heuristic only as a CAP fallback when no committed score exists — never as a blacklist trigger.

## Rule 2 — In-memory claim-slot locks must be released when nothing was awarded
**Why:** Setting a `claimedMatchIds`-style slot before async work is correct (TOCTOU), but if the award fails (PB timeout → 500), an unreleased slot 403s every legit retry until TTL (hours) while the row later sweeps to expired — the reward is permanently lost.
**How to apply:** Track `lockedMatchId` + `awarded` flags outside the try; in the outer catch, delete the slot iff `!awarded`. Keep the slot on business-rule 403s (duplicate/expired/blacklisted) — those are final.

## Rule 3 — Strictness must be a remote toggle when artifacts deploy independently
**Why:** Backend (Railway), game bridge (webcod.in manual upload), and APK ship on separate timelines; rejecting matchId-less claims immediately would brick every not-yet-updated client.
**How to apply:** Gate hard rejections behind a PB settings bool (default = grace mode preserving exact legacy behavior); flip it only after all artifacts ship the new chain end-to-end.

## Rule 4 — Sign the match id itself (uuid.hmac16 bound to uuid:pbId)
**Why:** Embedding the HMAC inside the matchId string means every client/bridge passes it through untouched — a signature layer with ZERO client changes. Binding pbId into the HMAC input kills cross-account claims at the gate (no DB read needed). 16 hex chars (64 bits) is enough because every guess is an online 403 — no offline oracle.
**How to apply:** Verify at every claim entry point BEFORE any DB work; treat "unsigned" (no dot) as legacy-grace, "invalid" as hard 403. A sig rejection must NOT lock the in-memory claim slot (the true owner must still be able to claim). Signing key = SESSION_SECRET → must exist in EVERY deploy env (rotation hard-403s in-flight matches); warn loudly at boot if unset.
