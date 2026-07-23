/* ────────────────────────────────────────────────────────────────────────────
 * shared/arcade.ts — Asynchronous score-matching PvP arcade engine: shared
 * contract used by BOTH the authoritative socket server (server/arcadehub.ts)
 * and the RN client (lib/arcadeClient.ts).
 *
 * Economy is IDENTICAL to the 8-Ball pool hub: players stake equal Power Tokens
 * for a tier, the winner is paid Hit Tickets after a 10% platform commission,
 * and a draw refunds both stakes fee-free. The money math is reused from
 * ./gamehub so there is ONE source of truth for the platform fee.
 *
 * Win rules (no gameplay timer):
 *   Case A — early win: the still-alive player's score exceeds the out player's
 *            locked score → that player is FROZEN and wins immediately.
 *   Case B — both out:  the higher locked score wins.
 *   Case C — tie:       equal locked scores → draw, both stakes refunded.
 * ──────────────────────────────────────────────────────────────────────────── */

import {
  POOL_TIERS, TIER_CONFIGS, computePoolSettlement, winnerTicketsForTier,
  type PoolTierPT, type TierConfig, type Seat,
} from './gamehub';

// Re-export so the client has a single import site for the arcade + shared economy.
export { TIER_CONFIGS, computePoolSettlement, winnerTicketsForTier };
export type { TierConfig, Seat };

export const ARCADE_WS_PATH = '/api/ws/hub-arcade';

/** Arcade reuses the pool economy tiers (same PT stake / ticket payout / 10% fee). */
export const ARCADE_TIERS = POOL_TIERS;
export type ArcadeTierPT = PoolTierPT;

/* ── Per-game registry ─────────────────────────────────────────────────────
 * Adding a new CodeCanyon game = one entry here + a ~9-line adapter in its JS +
 * the hosted static folder + an icon. The engine itself is game-agnostic. */
export interface ScoreDeltaSpec {
  /** Largest legit single score jump the server will accept (Flappy: 1). */
  maxIncrement: number;
  /** Smallest legit gap between two score increments, ms (Flappy pipe cadence). */
  minIntervalMs: number;
}
export interface GameSpec {
  gameId: string;
  name: string;
  /** Static folder name — dev: `/<path>/index.html`, prod: `<host>/<path>/index.html`. */
  path: string;
  lives: number;
  /** Hard sanity ceiling; any reported score above this is clamped + flagged. */
  maxScore: number;
  scoreDelta: ScoreDeltaSpec;
  /** null = no gameplay timer (the frozen spec for Flappy). */
  timerSeconds: number | null;
  /** TAP-TO-START ready window (seconds): a seat that never engages within this
   *  window is server-side forfeited — locked at its current score (0). */
  readyAfkSeconds: number;
}

export const ARCADE_GAMES: Record<string, GameSpec> = {
  flappy: {
    gameId: 'flappy',
    name: 'Flappy Bounce',
    path: 'flappy',
    // PvP is 1-life sudden death (server-authoritative; sent in MATCH_START).
    // Offline/practice mode keeps 3 lives client-side (see script.js MAX_LIVES).
    lives: 1,
    maxScore: 999999,
    // Flappy spawns a scoring pipe roughly every ~1.5s and only ever scores +1.
    scoreDelta: { maxIncrement: 1, minIntervalMs: 1200 },
    timerSeconds: null,
    readyAfkSeconds: 45,
  },
  fruitcut: {
    gameId: 'fruitcut',
    name: 'Fruit Cut',
    path: 'fruitcut',
    // Matches the game's native NUM_LIVES (3): a missed fruit costs a life,
    // slicing a bomb is an instant game over regardless of lives left.
    lives: 3,
    maxScore: 999999,
    // Fruit waves launch every ~3s (up to 10 fruits at max difficulty); each fruit
    // scores 10–40 and combos add +10×n. The game adapter reports the CUMULATIVE
    // score throttled to one message per ~600ms, so with 500ms windows every
    // message earns ≥1 window. 120/window ≈ 240 pts/s budget — comfortably above
    // the ~170 pts/s theoretical honest peak, and a 3s quiet gap banks 6 windows
    // (720) so a monster multi-slice never gets clamped.
    scoreDelta: { maxIncrement: 120, minIntervalMs: 500 },
    timerSeconds: null,
    readyAfkSeconds: 47,
  },
  stack: {
    gameId: 'stack',
    name: 'Tower Stack',
    path: 'stack',
    // No lives concept — one collapse (or the 5:00 timer) ends the run.
    lives: 1,
    // A block lands every ~1–2s scoring ~+10 (with perfect-drop combo bonuses on
    // top — live matches show ~7–10 pts/s honest pace). Uncapped by product
    // decision (Jul 2026): the scoreDelta rate clamp is the cheat bound now.
    maxScore: 999999,
    // Adapter reports the CUMULATIVE score throttled to one message per ~600ms
    // (same recipe as Fruit Cut). Real per-block gain is ~10 pts (NOT +1 — the
    // C3 template multiplies score_to_add), with combo spikes above that.
    // 60/window (~120 pts/s budget) gives honest play ~10x headroom — the old
    // 5/window budget sat BELOW the honest rate, so the server-accepted score
    // (which both the opponent display AND settlement use) crawled behind the
    // real score and produced wrong on-screen totals / unfair settles. A
    // scripted teleport is still bounded (maxScore in ~8s) and always flagged.
    scoreDelta: { maxIncrement: 60, minIntervalMs: 500 },
    // Two-stage client-enforced timing (adapter overlay). Stage 2: a 5-minute
    // active-match countdown armed on the FIRST gameplay tap; at 0:00 the
    // adapter triggers the native game-over and reports PLAYER_OUT — the normal
    // both-out settle picks the higher locked score. The server still has no
    // gameplay timer.
    timerSeconds: 300,
    // Stage 1 backstop: the adapter forfeits at 45s pre-game (menu + TAP-TO-
    // START), the RN client at 50s — this server backstop MUST sit above both
    // plus first-score latency (server clears AFK only on the first SCORE).
    readyAfkSeconds: 60,
  },
  '2048': {
    gameId: '2048',
    name: '2048',
    path: '2048',
    // One board, no lives — the 5:00 match timer (client-enforced) ends the run.
    lives: 1,
    // Uncapped by product decision (Jul 2026) — scores must support arbitrary
    // integers. NOTE the tradeoff: acceptScore never flags a drip at exactly
    // the allowed rate, so with the ceiling gone the scoreDelta rate clamp
    // (1024/500ms) is the only bound on a scripted client. Both seats face the
    // same clamp and settlement is relative, so match fairness is preserved.
    maxScore: 999999,
    // Merges can jump a lot in a single swipe (1024+1024 = +2048). The adapter
    // reports the CUMULATIVE score throttled to one message per ~600ms; the
    // clamp banks quiet windows (merges always follow non-scoring setup swipes)
    // so 1024/window covers the biggest common merge in one window and a rare
    // +2048 catches up within ~2 windows of continued reporting.
    scoreDelta: { maxIncrement: 1024, minIntervalMs: 500 },
    // Single-stage: the board is immediately playable, so the 5:00 match timer
    // arms on match start (not on a Play tap). At 0:00 the adapter freezes the
    // board and locks the final score; the normal both-out settle picks higher.
    timerSeconds: 300,
    // No adapter pre-game AFK (no menu). The RN client (50s) and this backstop
    // cover a seat that never moves; both clear on the first SCORE, which the
    // adapter emits (onScore(0)) on the first genuine gameplay tap.
    readyAfkSeconds: 60,
  },
  iceblock: {
    gameId: 'iceblock',
    name: 'Ice Block Puzzle',
    path: 'iceblock',
    // One board, no lives — the 5:00 match timer (client-enforced) ends the run.
    lives: 1,
    // Line-clear puzzle. Uncapped by product decision (Jul 2026); the
    // scoreDelta rate clamp is the cheat bound.
    maxScore: 999999,
    // Score jumps per line-clear / combo. Adapter reports CUMULATIVE score
    // throttled to ~600ms; 150/window with quiet-window banking covers a big
    // multi-line combo. (De-risk 150 with a practice run logging Score deltas.)
    scoreDelta: { maxIncrement: 150, minIntervalMs: 500 },
    // Two-stage client-enforced timing (identical to Tower Stack): Stage 1 = 45s
    // pre-game AFK armed on match start (menu + Play screen); Stage 2 = 5:00
    // active match armed on the first gameplay tap. Server has no gameplay timer.
    timerSeconds: 300,
    // Stage 1 backstop: adapter forfeits at 45s pre-game, RN at 50s — this MUST
    // sit above both plus first-score latency (server clears AFK on first SCORE,
    // which the adapter emits onScore(0) on the first gameplay tap).
    readyAfkSeconds: 60,
  },
  color: {
    gameId: 'color',
    name: 'Color Rush',
    path: 'color',
    // Sudden death — one wrong-colour collision ends the endless run.
    lives: 1,
    // Endless +1-per-ball game. Uncapped by product decision (Jul 2026); the
    // scoreDelta rate clamp is the cheat bound.
    maxScore: 999999,
    // Scores +1 per same-colour ball collected, but balls arrive in clusters,
    // so 5/window (~10 pts/s budget vs ~2–3 honest) never clamps honest play
    // while still catching a scripted drip. Cumulative report throttled ~600ms.
    scoreDelta: { maxIncrement: 5, minIntervalMs: 500 },
    // 90-second gameplay timer (1 min 30 sec). The adapter and RN solo host both
    // enforce it. Run ends on wrong-colour hit OR timer expiry — whichever first.
    timerSeconds: 90,
    // Stage 1 pre-game AFK: adapter forfeits at 45s on the start screen, RN at
    // 50s — this backstop MUST sit above both (ordering invariant), cleared by
    // the first SCORE (adapter emits onScore(0) on the Play tap).
    readyAfkSeconds: 60,
  },
};
export function getGameSpec(gameId: string): GameSpec | null {
  return ARCADE_GAMES[gameId] ?? null;
}
export const ARCADE_GAME_LIST: GameSpec[] = Object.values(ARCADE_GAMES);

/* ── Match lifecycle timing (server hygiene — NOT a gameplay timer) ─────────
 * There is deliberately no per-match gameplay timer. These two caps only exist
 * so a dropped or idle player can never escrow both stakes forever. */
export const ARCADE_GRACE_SECONDS = 30;             // disconnect grace before forfeit
export const ARCADE_MAX_MATCH_MS = 10 * 60 * 1000;  // hard lifetime cap → settle by current scores
/* Idle-lock while the opponent is FINISHED and waiting: once one seat is locked,
 * the still-alive seat must keep making score progress. If it goes this long with
 * zero accepted score increases (e.g. app backgrounded but socket still open),
 * it is locked at its current score and the match settles by comparison — the
 * finished player is never stuck on "Waiting for opponent" until the 10-min cap.
 * Generous enough for think-pauses in 2048; reset on every accepted increment. */
export const ARCADE_WAITING_IDLE_MS = 45 * 1000;

/* ── WebSocket protocol (RN client ↔ server) ───────────────────────────────
 * The RN app owns the socket and holds the auth token; the WebView game only
 * talks postMessage to RN, which relays SCORE / PLAYER_OUT here. */
export type ArcadeOutcome = 'win' | 'lose' | 'draw';
export type ArcadeEndReason = 'early_win' | 'both_out' | 'draw' | 'forfeit' | 'timeout';

export type ArcadeClientMsg =
  | { type: 'JOIN_QUEUE'; token: string; pbId: string; gameId: string; tier: number }
  | { type: 'LEAVE_QUEUE' }
  | { type: 'RESUME'; token: string; pbId: string; matchId: string }
  | { type: 'SCORE'; matchId: string; score: number }
  | { type: 'PLAYER_OUT'; matchId: string; score: number }
  | { type: 'PING' };

export type ArcadeServerMsg =
  | { type: 'QUEUED'; gameId: string; tier: number }
  | { type: 'MATCH_START'; matchId: string; gameId: string; tier: number; youAre: Seat; opponent: { name: string }; lives: number; startAt: number }
  | { type: 'OPPONENT_SCORE'; matchId: string; score: number }
  | { type: 'OPPONENT_OUT'; matchId: string; score: number }
  | { type: 'FREEZE_INPUT'; matchId: string; reason: ArcadeEndReason }
  | { type: 'MATCH_RESULT'; matchId: string; outcome: ArcadeOutcome; reason: ArcadeEndReason; yourScore: number; opponentScore: number; winnerTickets: number; refundPT: number }
  | { type: 'OPPONENT_LEFT'; matchId: string; graceMs: number }
  | { type: 'OPPONENT_BACK'; matchId: string }
  | { type: 'REFUND'; matchId: string; reason: string; amountPT: number }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'PONG' };
