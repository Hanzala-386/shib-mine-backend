---
name: game_logs one-game-one-row invariant
description: Weapon Master match logging — INSERT only at GAME_START, claims correlate & UPDATE, no legacy rows
---

# game_logs "one game = one row"

**Rule:** A game_logs row is INSERTed in exactly ONE place — the WS GAME_START handler, awaited and confirmed before SESSION_READY (hard gate; failure → `ERROR match_create_failed`, game blocked client-side by the bridge.js gate overlay). Every claim path (1x reward, 2x ad/claim) only UPDATEs that row. Claims arriving WITHOUT a matchId (old APKs) are correlated to the user's newest OPEN row (`match_status="started"||"active"`, sort=-created, perPage=1); if nothing resolves, grace mode pays but writes NOTHING.

**Why:** Old flow produced two rows per game (WS row stuck "started" + a "legacy" INSERT from no-matchId claims), polluting admin analytics and hiding fraud. User explicitly demanded no row without a verified match.

**How to apply:**
- Never re-add an INSERT to a claim endpoint or to wsCommitSession — the "PB blip" fallback INSERT there was deliberately deleted (logId is guaranteed by the gate).
- Correlation feeds the existing Layer-1 in-memory `claimedMatchIds` guard (synchronous check-and-set → concurrent claims on the same open row can't double-pay) and short-circuits Layer 2 with the correlated record.
- Grace-mode replays are currently invisible in game_logs (paid, no trace) — flip PB `settings.strict_match_enforcement` once bridge.js (webcod.in /arcade/) + new APK ship. Bridge gate ordering: 20s boot / 12s post-WS < nothing server-side (no server AFK for solo) — gate is purely client UX.
- Anti-cheat rate clamp still applies before commit: unrealistic scores get `blacklisted` rows and clamped serverPT; tests must use honest scores (~0.75 PT/s).
