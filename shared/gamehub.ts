/* ────────────────────────────────────────────────────────────────────────────
 * Game Hub — shared economy contract + WebSocket protocol.
 *
 * SINGLE SOURCE OF TRUTH for the money math, used by BOTH the server (authority)
 * and the client (display). All balances/tickets are mutated ONLY server-side;
 * the client uses these helpers purely to render expected values.
 *
 * Economy (locked spec):
 *   100 PT of pool value = 1 Hit Ticket   (1,000 PT = 10 tickets)
 *   Entry: both players stake equal PT for the room tier.
 *   Platform commission: 10% of the gross ticket pool.
 *   1,000 PT match  → gross 20 tickets → 2 commission → winner gets 18 tickets.
 *   Redeem: 1 Hit Ticket = 10 SHIB, min 50 / max 5,000 tickets per transaction.
 * ──────────────────────────────────────────────────────────────────────────── */

import type { TableState, ShotInput, SimEvent } from './pool/physics';

export const POOL_TIERS = [1000, 5000, 10000, 50000, 100000] as const;
export type PoolTierPT = (typeof POOL_TIERS)[number];

export const COMMISSION_RATE = 0.1;
export const PT_PER_TICKET = 100;     // 100 PT of pool value = 1 Hit Ticket
export const SHIB_PER_TICKET = 10;    // redeem conversion
export const REDEEM_MIN_TICKETS = 50;
export const REDEEM_MAX_TICKETS = 5000;
export const REDEEM_BOXES = [50, 100, 250, 500, 1000, 2500, 5000] as const;

export interface PoolSettlement {
  entryPT: number;
  totalStakePT: number;
  grossTickets: number;
  commissionTickets: number;
  winnerTickets: number;
}

/** Authoritative settlement math. Winner of a 1,000 PT match receives 18 tickets. */
export function computePoolSettlement(entryPT: number): PoolSettlement {
  const totalStakePT = entryPT * 2;
  const grossTickets = totalStakePT / PT_PER_TICKET;
  const commissionTickets = Math.round(grossTickets * COMMISSION_RATE);
  const winnerTickets = Math.round(grossTickets - commissionTickets);
  return { entryPT, totalStakePT, grossTickets, commissionTickets, winnerTickets };
}

export function winnerTicketsForTier(entryPT: number): number {
  return computePoolSettlement(entryPT).winnerTickets;
}

export function ticketsToShib(tickets: number): number {
  return Math.max(0, Math.floor(tickets)) * SHIB_PER_TICKET;
}

export interface RedeemValidation { ok: boolean; error?: string }
export function validateRedeem(tickets: number, balance: number): RedeemValidation {
  if (!Number.isFinite(tickets) || !Number.isInteger(tickets)) return { ok: false, error: 'Whole tickets only' };
  if (tickets < REDEEM_MIN_TICKETS) return { ok: false, error: `Minimum ${REDEEM_MIN_TICKETS} tickets` };
  if (tickets > REDEEM_MAX_TICKETS) return { ok: false, error: `Maximum ${REDEEM_MAX_TICKETS} tickets per transaction` };
  if (tickets > balance) return { ok: false, error: 'Not enough Hit Tickets' };
  return { ok: true };
}

export function formatPT(n: number): string {
  if (n >= 1000) return `${n / 1000}k`;
  return String(n);
}

export interface TierConfig {
  entryPT: number;
  label: string;         // e.g. "1k"
  winnerTickets: number; // e.g. 18
  winnerShib: number;    // e.g. 180
}
export function tierConfig(entryPT: number): TierConfig {
  const winnerTickets = winnerTicketsForTier(entryPT);
  return { entryPT, label: formatPT(entryPT), winnerTickets, winnerShib: ticketsToShib(winnerTickets) };
}
export const TIER_CONFIGS: TierConfig[] = POOL_TIERS.map(tierConfig);

/* ── WebSocket protocol (client ↔ server) ───────────────────────────────── */
export const HUB_WS_PATH = '/api/ws/hub';

export type HubGameId = 'pool8';
export type Seat = 'A' | 'B';
export type MatchPhase = 'waiting' | 'active' | 'settling' | 'done' | 'aborted';

/** Ledger reason codes (append-only token_ledger). */
export type LedgerReason =
  | 'match_entry'      // debit PT stake on match start
  | 'match_win'        // credit Hit Tickets to winner
  | 'match_refund'     // refund PT stake (room failed to start)
  | 'redeem_debit';    // debit Hit Tickets on redemption

export type HubClientMsg =
  | { type: 'JOIN_QUEUE'; token: string; pbId: string; game: HubGameId; tier: number }
  | { type: 'LEAVE_QUEUE' }
  | { type: 'RESUME'; token: string; pbId: string; matchId: string }
  | { type: 'SHOT'; matchId: string; shot: ShotInput }
  | { type: 'PLACE_CUE'; matchId: string; x: number; y: number } // ball-in-hand after a scratch
  | { type: 'PING' };

export type HubServerMsg =
  | { type: 'QUEUED'; tier: number; game: HubGameId }
  | { type: 'MATCH_FOUND'; matchId: string; tier: number; youAre: Seat; opponent: { name: string }; state: TableState; turn: Seat; ballInHand?: boolean; startAt: number }
  | { type: 'TURN'; matchId: string; turn: Seat; turnEndsAt: number }
  | { type: 'SHOT_RESULT'; matchId: string; by: Seat; shot: ShotInput; events: SimEvent[]; finalState: TableState; pocketed: number[]; cuePocketed: boolean; nextTurn: Seat; ballInHand: boolean }
  | { type: 'GAME_OVER'; matchId: string; winner: Seat; reason: 'eight_ball' | 'forfeit' | 'timeout'; winnerTickets: number }
  | { type: 'OPPONENT_LEFT'; matchId: string; graceMs: number }
  | { type: 'OPPONENT_BACK'; matchId: string }
  | { type: 'REFUND'; matchId: string; reason: string; amountPT: number }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'PONG' };

/* ── Reconnect / forfeit timing ─────────────────────────────────────────── */
export const TURN_SECONDS = 30;          // per-turn shot clock
export const GRACE_SECONDS = 30;         // disconnect grace before forfeit
export const MAX_SKIPPED_TURNS = 2;      // consecutive skips before forfeit
