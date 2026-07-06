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
    maxScore: 9999,
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
    maxScore: 99999,
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
