/* ────────────────────────────────────────────────────────────────────────────
 * Deterministic 8-Ball physics engine (PURE — no RN / no Node deps).
 *
 * The SAME module runs on the server (authority) and the client (replay), so a
 * given (startState, shot) ALWAYS produces the identical outcome on both. The
 * server stores the authoritative finalState; the client animates the returned
 * trajectory. No client can fabricate a result the server did not compute.
 *
 * Units are abstract "table units"; the renderer scales them to the screen.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BallState {
  id: number;   // 0 = cue, 1..15 = object balls (8 = eight ball)
  x: number;
  y: number;
  vx: number;
  vy: number;
  active: boolean;
}

export interface TableState {
  balls: BallState[];
}

export interface ShotInput {
  angle: number;  // radians — direction the cue ball travels
  power: number;  // 0..1 — fraction of MAX_POWER_SPEED
  spin?: number;  // -1..1 reserved (english); unused in v1 physics
}

export type SimEventType = 'cue_strike' | 'ball_ball' | 'cushion' | 'pocket';

export interface SimEvent {
  type: SimEventType;
  t: number;        // ms from shot start
  x: number;
  y: number;
  speed: number;    // impact speed — drives sound volume
  ballId?: number;
  otherId?: number;
  pocketIndex?: number;
}

export interface FrameSample {
  t: number;                                          // ms from shot start
  balls: { id: number; x: number; y: number; a: boolean }[];
}

export interface SimResult {
  finalState: TableState;
  events: SimEvent[];
  frames: FrameSample[];
  pocketed: number[];       // object-ball ids pocketed this shot
  cuePocketed: boolean;     // scratch
  firstContactId: number | null; // first ball the cue struck (foul detection)
  durationMs: number;
}

/* ── Table geometry ─────────────────────────────────────────────────────── */
export const TABLE = {
  PLAY_W: 800,
  PLAY_H: 400,
  BALL_R: 11,
  CORNER_POCKET_R: 24,
  MID_POCKET_R: 20,
} as const;

export interface Pocket { x: number; y: number; r: number }
export const POCKETS: Pocket[] = [
  { x: 0,               y: 0,               r: TABLE.CORNER_POCKET_R }, // top-left
  { x: TABLE.PLAY_W / 2, y: 0,              r: TABLE.MID_POCKET_R    }, // top-mid
  { x: TABLE.PLAY_W,     y: 0,              r: TABLE.CORNER_POCKET_R }, // top-right
  { x: 0,               y: TABLE.PLAY_H,    r: TABLE.CORNER_POCKET_R }, // bottom-left
  { x: TABLE.PLAY_W / 2, y: TABLE.PLAY_H,   r: TABLE.MID_POCKET_R    }, // bottom-mid
  { x: TABLE.PLAY_W,     y: TABLE.PLAY_H,   r: TABLE.CORNER_POCKET_R }, // bottom-right
];

/* ── Simulation tuning ──────────────────────────────────────────────────── */
const DT = 1 / 240;               // fixed physics timestep (s)
const FRAME_EVERY = 4;            // sample a render frame every N steps → ~60fps
const MAX_STEPS = 240 * 20;       // 20s hard cap
const FRICTION = 0.992;           // per-step velocity damping (rolling resistance)
const STOP_SPEED = 6;             // below this a ball is snapped to rest
const REST_CUSHION = 0.9;         // cushion energy retained
const REST_BALL = 0.96;           // ball-ball energy retained
export const MAX_POWER_SPEED = 1950;

const R = TABLE.BALL_R;
const R2 = R * 2;

/* ── State helpers ──────────────────────────────────────────────────────── */
export function cloneState(s: TableState): TableState {
  return { balls: s.balls.map((b) => ({ ...b })) };
}

/** Standard rack: cue ball at the head spot, 15 balls in a triangle (8 centered). */
export function createRackState(): TableState {
  const balls: BallState[] = [];
  const footX = TABLE.PLAY_W * 0.72;
  const footY = TABLE.PLAY_H / 2;
  const gap = R2 + 0.6;
  const rowDX = (gap * Math.sqrt(3)) / 2;

  // Rack order per row (apex → back). 8-ball sits dead-center (row 2, middle).
  const rackRows: number[][] = [
    [1],
    [2, 3],
    [4, 8, 5],
    [6, 7, 9, 10],
    [11, 12, 13, 14, 15],
  ];

  for (let row = 0; row < rackRows.length; row++) {
    const ids = rackRows[row];
    const x = footX + row * rowDX;
    for (let i = 0; i < ids.length; i++) {
      const y = footY + (i - row / 2) * gap;
      balls.push({ id: ids[i], x, y, vx: 0, vy: 0, active: true });
    }
  }

  // Cue ball at head spot.
  balls.push({ id: 0, x: TABLE.PLAY_W * 0.25, y: footY, vx: 0, vy: 0, active: true });
  balls.sort((a, b) => a.id - b.id);
  return { balls };
}

function sampleFrame(t: number, balls: BallState[]): FrameSample {
  return { t, balls: balls.map((b) => ({ id: b.id, x: b.x, y: b.y, a: b.active })) };
}

function tryPocket(b: BallState): number {
  for (let i = 0; i < POCKETS.length; i++) {
    const p = POCKETS[i];
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    if (dx * dx + dy * dy <= p.r * p.r) return i;
  }
  return -1;
}

/* ── Core: simulate one shot to rest ────────────────────────────────────── */
export function simulateShot(state: TableState, shot: ShotInput): SimResult {
  const balls = cloneState(state).balls;
  const byId = (id: number) => balls.find((b) => b.id === id);

  const events: SimEvent[] = [];
  const frames: FrameSample[] = [];
  const pocketed: number[] = [];
  let cuePocketed = false;
  let firstContactId: number | null = null;

  const cue = byId(0);
  const power = Math.max(0, Math.min(1, shot.power));
  const speed = power * MAX_POWER_SPEED;
  if (cue && cue.active) {
    cue.vx = Math.cos(shot.angle) * speed;
    cue.vy = Math.sin(shot.angle) * speed;
    events.push({ type: 'cue_strike', t: 0, x: cue.x, y: cue.y, speed });
  }

  frames.push(sampleFrame(0, balls));

  let step = 0;
  for (; step < MAX_STEPS; step++) {
    const t = step * DT * 1000;
    let moving = false;

    // 1) integrate + friction
    for (const b of balls) {
      if (!b.active) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp < STOP_SPEED) {
        b.vx = 0;
        b.vy = 0;
        continue;
      }
      moving = true;
      b.vx *= FRICTION;
      b.vy *= FRICTION;
      b.x += b.vx * DT;
      b.y += b.vy * DT;
    }

    // 2) ball-ball collisions (deterministic pair order by id)
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.active) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (!b.active) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0 && dist < R2) {
          const nx = dx / dist;
          const ny = dy / dist;
          // positional de-overlap
          const overlap = (R2 - dist) / 2;
          a.x -= nx * overlap; a.y -= ny * overlap;
          b.x += nx * overlap; b.y += ny * overlap;
          // impulse along normal (equal mass)
          const relN = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (relN < 0) {
            const jimp = (-(1 + REST_BALL) * relN) / 2;
            a.vx -= jimp * nx; a.vy -= jimp * ny;
            b.vx += jimp * nx; b.vy += jimp * ny;
            const impactSpeed = Math.abs(relN);
            events.push({ type: 'ball_ball', t, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, speed: impactSpeed, ballId: a.id, otherId: b.id });
            if (firstContactId === null && (a.id === 0 || b.id === 0)) {
              firstContactId = a.id === 0 ? b.id : a.id;
            }
          }
        }
      }
    }

    // 3) pockets + cushions
    for (const b of balls) {
      if (!b.active) continue;
      const pk = tryPocket(b);
      if (pk >= 0) {
        b.active = false;
        b.vx = 0; b.vy = 0;
        events.push({ type: 'pocket', t, x: POCKETS[pk].x, y: POCKETS[pk].y, speed: 0, ballId: b.id, pocketIndex: pk });
        if (b.id === 0) cuePocketed = true;
        else pocketed.push(b.id);
        continue;
      }
      // cushions
      if (b.x < R)               { b.x = R;               b.vx = -b.vx * REST_CUSHION; events.push({ type:'cushion', t, x:b.x, y:b.y, speed:Math.abs(b.vx), ballId:b.id }); }
      else if (b.x > TABLE.PLAY_W - R) { b.x = TABLE.PLAY_W - R; b.vx = -b.vx * REST_CUSHION; events.push({ type:'cushion', t, x:b.x, y:b.y, speed:Math.abs(b.vx), ballId:b.id }); }
      if (b.y < R)               { b.y = R;               b.vy = -b.vy * REST_CUSHION; events.push({ type:'cushion', t, x:b.x, y:b.y, speed:Math.abs(b.vy), ballId:b.id }); }
      else if (b.y > TABLE.PLAY_H - R) { b.y = TABLE.PLAY_H - R; b.vy = -b.vy * REST_CUSHION; events.push({ type:'cushion', t, x:b.x, y:b.y, speed:Math.abs(b.vy), ballId:b.id }); }
    }

    // 4) sample render frame
    if (step % FRAME_EVERY === 0) frames.push(sampleFrame(t, balls));

    if (!moving) break;
  }

  const durationMs = step * DT * 1000;
  frames.push(sampleFrame(durationMs, balls));

  return {
    finalState: { balls },
    events,
    frames,
    pocketed,
    cuePocketed,
    firstContactId,
    durationMs,
  };
}

/** Trajectory preview for the aiming line: cue path until first contact/cushion. */
export function previewCuePath(state: TableState, shot: ShotInput, maxLen = 900): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const cue = state.balls.find((b) => b.id === 0);
  if (!cue || !cue.active) return pts;
  let x = cue.x, y = cue.y;
  const dx = Math.cos(shot.angle);
  const dy = Math.sin(shot.angle);
  const stepLen = 6;
  let travelled = 0;
  pts.push({ x, y });
  while (travelled < maxLen) {
    x += dx * stepLen; y += dy * stepLen; travelled += stepLen;
    // stop at cushions
    if (x < R || x > TABLE.PLAY_W - R || y < R || y > TABLE.PLAY_H - R) { pts.push({ x, y }); break; }
    // stop at first object ball
    let hit = false;
    for (const b of state.balls) {
      if (!b.active || b.id === 0) continue;
      if ((b.x - x) ** 2 + (b.y - y) ** 2 <= (R2) ** 2) { hit = true; break; }
    }
    pts.push({ x, y });
    if (hit) break;
  }
  return pts;
}
