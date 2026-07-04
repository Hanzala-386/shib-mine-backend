/* ────────────────────────────────────────────────────────────────────────────
 * Authoritative 8-Ball rules engine (PURE — no RN / no Node deps).
 *
 * The SAME module runs on the server (authority) and the client (offline
 * practice + display), so a given (ruleState, shotResult) ALWAYS produces the
 * identical turn transition on both. It is intentionally SEAT-AGNOSTIC: it
 * reasons about "the shooter" and "the opponent", never A/B, so the server maps
 * the result onto seats and the single-player practice screen reuses it as-is.
 *
 * It consumes a SimResult from shared/pool/physics.ts (the deterministic engine)
 * plus the pre-shot rule state, and returns the transition ONLY — it never
 * mutates balances or match state and never computes settlement money.
 * ──────────────────────────────────────────────────────────────────────────── */

import type { SimResult, TableState, SimEvent } from './physics';

export type Group = 'solids' | 'stripes';

export const EIGHT_BALL = 8;

/** Object-ball ids for a group. Solids 1-7, stripes 9-15 (8 is neither). */
export function groupIds(g: Group): number[] {
  return g === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
}

/** Which group an id belongs to (null for the cue and the 8). */
export function ballGroup(id: number): Group | null {
  if (id >= 1 && id <= 7) return 'solids';
  if (id >= 9 && id <= 15) return 'stripes';
  return null;
}

/** True when EVERY ball of the group is off the table (pocketed) in this state. */
export function groupCleared(state: TableState, g: Group): boolean {
  return groupIds(g).every((id) => {
    const b = state.balls.find((x) => x.id === id);
    return !b || !b.active;
  });
}

/** True when this is the opening break — all 15 object balls are still racked. */
export function isBreakState(state: TableState): boolean {
  for (let id = 1; id <= 15; id++) {
    const b = state.balls.find((x) => x.id === id);
    if (b && b.active) { /* still racked */ } else { return false; }
  }
  return true;
}

export type FoulType =
  | 'scratch'         // cue ball pocketed
  | 'no_contact'      // cue struck nothing
  | 'wrong_ball_first'// first contact was not a legal ball
  | 'no_cushion'      // after contact, nothing potted and no rail hit
  | 'eight_early';    // pocketed the 8 before clearing own group (loss)

export interface RuleState {
  openTable: boolean;          // groups not yet assigned
  shooterGroup: Group | null;  // shooter's assigned group (null while open)
  shooterOnEight: boolean;     // shooter had cleared their whole group BEFORE this shot
  isBreak: boolean;            // this is the opening break shot
}

export interface RuleTransition {
  fouls: FoulType[];
  foul: boolean;
  foulReason: string | null;      // short human label for a banner
  assignedGroup: Group | null;    // group assigned to the SHOOTER on this shot (else null)
  openTableAfter: boolean;        // whether the table is still open after this shot
  pottedOwn: boolean;             // shooter legally pocketed a ball they may continue on
  keepTurn: boolean;              // shooter shoots again
  ballInHand: boolean;            // incoming player gets ball-in-hand (always the case on a foul)
  gameOver: { shooterWins: boolean; reason: 'eight_ball' } | null;
}

const FOUL_LABELS: Record<FoulType, string> = {
  scratch: 'Scratch — cue ball pocketed',
  no_contact: 'No ball hit',
  wrong_ball_first: 'Wrong ball hit first',
  no_cushion: 'No rail after contact',
  eight_early: 'Early 8-ball',
};

/** Timestamp of the cue ball's first object-ball contact, or null. */
function firstCueContactTime(events: SimEvent[]): number | null {
  for (const e of events) {
    if (e.type === 'ball_ball' && (e.ballId === 0 || e.otherId === 0)) return e.t;
  }
  return null;
}

/**
 * Compute the full turn transition for one shot. Pure & deterministic.
 * Order matters: 8-ball resolution is evaluated with the fouls already known,
 * BEFORE any open-table group assignment (matches the authoritative server).
 */
export function applyShotRules(rs: RuleState, sim: SimResult): RuleTransition {
  const { pocketed, cuePocketed, firstContactId, finalState, events } = sim;
  const nonEight = pocketed.filter((id) => id !== EIGHT_BALL);
  const fouls: FoulType[] = [];

  // ── Foul detection ──────────────────────────────────────────────────────
  if (cuePocketed) fouls.push('scratch');
  if (firstContactId === null) fouls.push('no_contact');

  // Wrong-ball-first: depends on whether the shooter is on the 8.
  if (firstContactId !== null) {
    const firstIsEight = firstContactId === EIGHT_BALL;
    if (rs.shooterOnEight) {
      // Must strike the 8 first once the group is cleared.
      if (!firstIsEight) fouls.push('wrong_ball_first');
    } else if (firstIsEight) {
      // Cannot legally strike the 8 first before clearing the group (open table too).
      fouls.push('wrong_ball_first');
    } else if (!rs.openTable && rs.shooterGroup) {
      const fg = ballGroup(firstContactId);
      if (fg && fg !== rs.shooterGroup) fouls.push('wrong_ball_first');
    }
  }

  // Cushion-after-contact: after a legal first contact, either a ball must be
  // pocketed OR some ball must reach a rail. Exempt the break (soft breaks are legal).
  if (!rs.isBreak && firstContactId !== null && pocketed.length === 0 && !cuePocketed) {
    const tFirst = firstCueContactTime(events);
    const cushionAfter = tFirst !== null && events.some((e) => e.type === 'cushion' && e.t >= tFirst);
    if (!cushionAfter) fouls.push('no_cushion');
  }

  const foul = fouls.length > 0;
  const foulReason = foul ? FOUL_LABELS[fouls[0]] : null;

  // ── 8-ball resolution (evaluated BEFORE group assignment) ────────────────
  if (pocketed.includes(EIGHT_BALL)) {
    // Legal win ONLY if the shooter had already cleared their whole group before
    // this shot AND committed no foul (scratch-on-8, wrong-first, etc. all lose).
    const legalWin = rs.shooterOnEight && !foul;
    if (!legalWin && !fouls.includes('eight_early') && !rs.shooterOnEight) fouls.push('eight_early');
    return {
      fouls,
      foul: foul || !legalWin,
      foulReason: legalWin ? null : (foulReason ?? FOUL_LABELS.eight_early),
      assignedGroup: null,
      openTableAfter: rs.openTable,
      pottedOwn: false,
      keepTurn: false,
      ballInHand: false,
      gameOver: { shooterWins: legalWin, reason: 'eight_ball' },
    };
  }

  // ── Open-table group assignment on a clean pot ───────────────────────────
  let assignedGroup: Group | null = null;
  let openTableAfter = rs.openTable;
  if (rs.openTable && !foul && nonEight.length > 0) {
    const groups = new Set(nonEight.map((id) => ballGroup(id)).filter((g): g is Group => g !== null));
    // Assign only when every pocketed object ball is the SAME group; mixed → table stays open.
    if (groups.size === 1) {
      assignedGroup = [...groups][0];
      openTableAfter = false;
    }
  }

  // ── Turn continuation ────────────────────────────────────────────────────
  const effGroup = rs.shooterGroup ?? assignedGroup;
  let pottedOwn = false;
  if (!foul && nonEight.length > 0) {
    if (rs.openTable) {
      // On an open table any legally pocketed object ball keeps the shooter in.
      pottedOwn = true;
    } else if (effGroup) {
      pottedOwn = nonEight.some((id) => groupIds(effGroup).includes(id));
    }
  }

  const keepTurn = !foul && pottedOwn;
  const ballInHand = foul; // any foul hands the cue ball to the opponent

  return {
    fouls,
    foul,
    foulReason,
    assignedGroup,
    openTableAfter,
    pottedOwn,
    keepTurn,
    ballInHand,
    gameOver: null,
  };
}
