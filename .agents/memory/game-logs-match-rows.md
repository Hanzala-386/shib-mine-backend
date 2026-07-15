---
name: game_score one-game-one-row invariant
description: Weapon Master match persistence — game_score collection, INSERT only at GAME_START, PATCH-only lifecycle, final_tokens = is_double ? raw*2 : raw
---

# game_score "one game = one row" (supersedes game_logs)

**Rule:** Solo-game score persistence lives in the PB `game_score` collection (fields: user relation, match_id, raw_score, final_tokens, is_double, match_status; ALL API rules null = server-only). The `game_logs` collection is retired/historic — nothing writes to it anymore; its ~811K legacy rows were left untouched (never mass-delete on the shared PB). One row per game:
1. GAME_START → INSERT one row `{raw_score:0, final_tokens:0, is_double:false, match_status:"active"}` (strict clients: awaited + confirmed before SESSION_READY — hard gate).
2. Game over (wsCommitSession) → PATCH the SAME row: raw_score = server-validated score, final_tokens mirrors raw (1×), status "started". If the row id is unknown, PATCH-or-INSERT by match_id lookup — never a blind insert (legacy-only insert when no row resolves).
3. Claim → PATCH the same row: `final_tokens = is_double ? raw_score*2 : raw_score` STRICTLY, status "completed". Claim endpoints never INSERT; no resolvable match → grace pays but writes nothing.

**Why:** The old game_logs pipeline produced mismatched rows (e.g. raw_score 60 / is_double false / final_tokens 80) because the pre-snap Railway build wrote the CLIENT-sent claim amount into final_tokens; plus 811K rows of bloat. Owner demanded a total reset with the strict formula.

**How to apply:**
- `committedPT` derives from `raw_score` ONLY (never `|| final_tokens` — that reintroduces client-tainted values as payout basis).
- Double-claim intent detection: `safeAmount > committedPT * 1.5` with NO rounding (committedPT=1 must detect amount 2 as double).
- game_score has no start_time field — wall-clock grace cap uses PB's own `created` (parse with `.replace(" ","T")`; PB datetimes use a space separator).
- Sweeper expires stale active/started rows age-gated via `updated` (runs on both dev + Railway against the shared PB; idempotent).
- Never re-add an INSERT to a claim endpoint. wsCommitSession's insert is legacy-clients-only after a match_id lookup finds nothing.
- Correlation feeds the in-memory `claimedMatchIds` replay guard; the claim's completed-flip PATCH is fire-and-forget (dev+Railway have separate maps — bounded double-pay window accepted).

**VERSION-AWARE gate (keyed on APP version, NOT bridge version):** bridge.js on webcod.in is SHARED by ALL APK versions, so a bridge-level flag can NEVER distinguish app versions. Routing keys on `GAME_START.appVersion` injected by the RN app (1.0.3+ sends it) → `appVersionAtLeast(v,"1.0.3")` = strict hard gate; absent/older/garbage → legacy (immediate SESSION_READY, async best-effort row, late stray inserts deleted). Version compare must be numeric per segment (1.0.10 > 1.0.3). Never remove the legacy branch while old APKs are in the wild.

**Payout must equal the displayed score:** the server's per-hit tally UNDERCOUNTS honest play (bridge drains queued hits faster than the server's min-spacing guard; hits before the WS handshake never arrive). GAME_OVER reconciles UP to the client score, bounded by rate cap (15 pts/s vs the LARGER of client/server elapsed, clamped to session hard limit) + PT cap + impossible-rate blacklist. Per-hit counting is fraud telemetry, never the payout source. Owner explicitly prioritized payout accuracy over anti-cheat strictness.
