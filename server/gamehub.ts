/**
 * gamehub.ts — Server-authoritative 8-Ball Pool multiplayer hub.
 *
 * WebSocket path: /api/ws/hub  (see HUB_WS_PATH in shared/gamehub.ts)
 *
 * Authority model:
 *  - The SAME deterministic physics engine (shared/pool/physics.ts) runs here and
 *    on the client. The server computes every shot outcome; the client only
 *    re-simulates the identical (state, shot) pair to animate. No client can
 *    fabricate a result the server did not produce.
 *  - Money moves ONLY here: on match start both players' power_tokens are debited
 *    by the tier stake; on match end the winner is credited Hit Tickets using the
 *    locked settlement math (10% commission → 1,000 PT match pays 18 tickets).
 *  - PUBG-style reconnect: a disconnect starts a grace window; if the player does
 *    not RESUME in time the opponent wins by forfeit. Turn shot-clock + a max
 *    consecutive-skip cap also end stalled matches.
 *
 * Scope note (vertical slice): a pragmatic 8-ball ruleset is enforced
 * server-side (open-table group assignment, foul → ball-in-hand, on-the-8 win /
 * early-8 loss). It is intentionally simpler than full WPA rules.
 */

import https from 'node:https';
import http from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';

import {
  createRackState, simulateShot, TABLE,
  type TableState, type ShotInput,
} from '../shared/pool/physics';
import {
  POOL_TIERS, computePoolSettlement, TURN_SECONDS, GRACE_SECONDS, MAX_SKIPPED_TURNS,
  type Seat, type HubServerMsg, type HubClientMsg, type MatchPhase,
} from '../shared/gamehub';
import {
  applyShotRules, groupCleared, isBreakState,
  type Group, type RuleState,
} from '../shared/pool/rules';

const PB_URL = 'https://api.webcod.in';

/* ── PocketBase admin HTTP helpers (mirrors tournament.ts pattern) ────────── */
function pbHttp(method: string, path: string, body: object | null, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    if (data) headers['Content-Length'] = String(Buffer.byteLength(data));
    const url = new URL(path, PB_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } }); },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('PB timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let _adminToken = '';
let _tokenExpiry = 0;
export async function getAdminToken(): Promise<string> {
  if (_adminToken && Date.now() < _tokenExpiry) return _adminToken;
  const res = await pbHttp('POST', '/api/admins/auth-with-password', {
    identity: process.env.PB_ADMIN_EMAIL,
    password: process.env.PB_ADMIN_PASSWORD,
  });
  if (!res.token) throw new Error(`PB admin auth failed: ${JSON.stringify(res)}`);
  _adminToken = res.token;
  _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return _adminToken;
}
export async function pbGet(path: string) { return pbHttp('GET', path, null, await getAdminToken()); }
export async function pbPost(path: string, body: object) { return pbHttp('POST', path, body, await getAdminToken()); }
export async function pbPatch(path: string, body: object) { return pbHttp('PATCH', path, body, await getAdminToken()); }

/* ── Schema: ensure users.hit_tickets exists ──────────────────────────────── */
export async function ensureGameHubSchema(): Promise<void> {
  try {
    const col = await pbGet('/api/collections/users');
    if (!col?.id) { console.warn('[gamehub] users collection not found — skipping schema'); return; }
    if ((col.schema || []).some((f: any) => f.name === 'hit_tickets')) {
      console.log('[gamehub] users.hit_tickets ✓');
    } else {
      await pbPatch(`/api/collections/${col.id}`, {
        schema: [...(col.schema || []), { name: 'hit_tickets', type: 'number', required: false, options: { min: null, max: null } }],
      });
      console.log('[gamehub] Added users.hit_tickets ✓');
    }
    console.log('[gamehub] schema ready ✓');
  } catch (e: any) {
    console.warn('[gamehub] ensureGameHubSchema failed:', e?.message);
  }
}

/* ── User balance helpers ─────────────────────────────────────────────────── */
export interface HubUser { id: string; power_tokens: number; hit_tickets: number; display_name: string }
export async function fetchUser(pbId: string): Promise<HubUser | null> {
  try {
    const r = await pbGet(`/api/collections/users/records/${pbId}`);
    if (!r?.id) return null;
    return { id: r.id, power_tokens: Number(r.power_tokens) || 0, hit_tickets: Number(r.hit_tickets) || 0, display_name: r.display_name || 'Player' };
  } catch { return null; }
}
/** Verify a PB auth token actually belongs to pbId (real-money safety). */
export async function verifyToken(token: string, pbId: string): Promise<boolean> {
  try {
    const r = await pbHttp('GET', `/api/collections/users/records/${pbId}`, null, token);
    return r?.id === pbId;
  } catch { return false; }
}
/** PATCH that THROWS on any PB error response. pbHttp resolves on ALL HTTP statuses, so any
 *  money write MUST verify PB echoed the record back (failures return {code,message}, no id). */
export async function pbPatchChecked(path: string, body: object): Promise<any> {
  const r = await pbPatch(path, body);
  if (!r || r.code || !r.id) throw new Error(`PB PATCH failed (${path}): ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}
/** Debit via an ATOMIC field modifier (never read-modify-write) so concurrent balance writes
 *  can't clobber each other. Returns false only for insufficient funds; THROWS on write failure. */
export async function debitPT(pbId: string, amount: number): Promise<boolean> {
  const u = await fetchUser(pbId);
  if (!u || u.power_tokens < amount) return false;
  await pbPatchChecked(`/api/collections/users/records/${pbId}`, { 'power_tokens-': amount });
  return true;
}
export async function creditPT(pbId: string, amount: number): Promise<void> {
  await pbPatchChecked(`/api/collections/users/records/${pbId}`, { 'power_tokens+': amount });
}
export async function creditTickets(pbId: string, amount: number): Promise<void> {
  await pbPatchChecked(`/api/collections/users/records/${pbId}`, { 'hit_tickets+': amount });
}
/** Refund that never throws — logs CRITICAL on failure so a lost stake is at least recoverable by hand. */
export async function safeRefund(pbId: string, amount: number, ctx: string): Promise<void> {
  try { await creditPT(pbId, amount); console.log(`[gamehub] refunded ${amount} PT → ${pbId} (${ctx})`); }
  catch (e: any) { console.error(`[gamehub] CRITICAL refund FAILED ${amount} PT → ${pbId} (${ctx}):`, e?.message); }
}

/* ── In-memory match state ────────────────────────────────────────────────── */
interface Player {
  seat: Seat;
  pbId: string;
  name: string;
  ws: WebSocket | null;
  connected: boolean;
  group: Group | null;
  skipped: number;
}
interface Match {
  id: string;
  tier: number;
  state: TableState;
  turn: Seat;
  phase: MatchPhase;
  players: Record<Seat, Player>;
  openTable: boolean;
  ballInHand: boolean;
  settled: boolean;
  turnTimer: ReturnType<typeof setTimeout> | null;
  turnEndsAt: number;
  graceTimer: Partial<Record<Seat, ReturnType<typeof setTimeout>>>;
}

interface QueueEntry { ws: WebSocket; pbId: string; name: string; tier: number }

interface WsCtx { pbId?: string; matchId?: string }

const queues = new Map<number, QueueEntry[]>();   // key: tier
const matches = new Map<string, Match>();
const ctxOf = new WeakMap<WebSocket, WsCtx>();

const other = (s: Seat): Seat => (s === 'A' ? 'B' : 'A');

function send(ws: WebSocket | null, msg: HubServerMsg): void {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch { /* noop */ }
}
function broadcast(m: Match, msg: HubServerMsg): void {
  send(m.players.A.ws, msg);
  send(m.players.B.ws, msg);
}

/* ── Turn clock ───────────────────────────────────────────────────────────── */
function startTurnTimer(m: Match): void {
  if (m.turnTimer) clearTimeout(m.turnTimer);
  m.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
  m.turnTimer = setTimeout(() => onTurnTimeout(m), TURN_SECONDS * 1000);
}
function stopTurnTimer(m: Match): void {
  if (m.turnTimer) { clearTimeout(m.turnTimer); m.turnTimer = null; }
}
function onTurnTimeout(m: Match): void {
  if (m.settled || m.phase !== 'active') return;
  const p = m.players[m.turn];
  // A disconnected player's clock is paused; guard just in case.
  if (!p.connected) return;
  p.skipped += 1;
  if (p.skipped >= MAX_SKIPPED_TURNS) {
    settleMatch(m, other(m.turn), 'timeout');
    return;
  }
  m.turn = other(m.turn);
  // If the cue is off the table (the timed-out player had scratched), the incoming player MUST
  // inherit ball-in-hand — otherwise SHOT is rejected ('place_cue_first') AND PLACE_CUE is rejected
  // (!ballInHand), deadlocking the match into an unearned skip-cap forfeit.
  const cueBall = m.state.balls.find((b) => b.id === 0);
  m.ballInHand = !cueBall || !cueBall.active;
  startTurnTimer(m);
  send(m.players.A.ws, { type: 'TURN', matchId: m.id, turn: m.turn, turnEndsAt: m.turnEndsAt });
  send(m.players.B.ws, { type: 'TURN', matchId: m.id, turn: m.turn, turnEndsAt: m.turnEndsAt });
}

/* ── Settlement ───────────────────────────────────────────────────────────── */
async function settleMatch(m: Match, winner: Seat, reason: 'eight_ball' | 'forfeit' | 'timeout'): Promise<void> {
  if (m.settled) return;
  m.settled = true;
  m.phase = 'done';
  stopTurnTimer(m);
  for (const s of ['A', 'B'] as Seat[]) { const t = m.graceTimer[s]; if (t) clearTimeout(t); }

  const settlement = computePoolSettlement(m.tier);
  const winnerId = m.players[winner].pbId;
  // Retry the payout — a silently-dropped credit means the winner staked PT and got nothing.
  let credited = false;
  for (let attempt = 1; attempt <= 3 && !credited; attempt++) {
    try {
      await creditTickets(winnerId, settlement.winnerTickets);
      credited = true;
      console.log(`[gamehub] match ${m.id.slice(0, 8)} settled: winner=${winner} reason=${reason} +${settlement.winnerTickets} tickets → ${winnerId}`);
    } catch (e: any) {
      console.error(`[gamehub] settlement credit attempt ${attempt}/3 failed (${winnerId}):`, e?.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!credited) {
    console.error(`[gamehub] CRITICAL: winner ${winnerId} NOT credited ${settlement.winnerTickets} tickets — match ${m.id} tier ${m.tier} — manual reconciliation required`);
  }

  broadcast(m, { type: 'GAME_OVER', matchId: m.id, winner, reason, winnerTickets: settlement.winnerTickets });
  setTimeout(() => matches.delete(m.id), 15_000);
}

/* ── Matchmaking ──────────────────────────────────────────────────────────── */
async function tryJoinQueue(ws: WebSocket, msg: Extract<HubClientMsg, { type: 'JOIN_QUEUE' }>): Promise<void> {
  if (msg.game !== 'pool8') { send(ws, { type: 'ERROR', code: 'bad_game', message: 'Unsupported game' }); return; }
  if (!POOL_TIERS.includes(msg.tier as any)) { send(ws, { type: 'ERROR', code: 'bad_tier', message: 'Invalid tier' }); return; }

  const ok = await verifyToken(msg.token, msg.pbId);
  if (!ok) { send(ws, { type: 'ERROR', code: 'auth', message: 'Authentication failed' }); return; }

  const u = await fetchUser(msg.pbId);
  if (!u) { send(ws, { type: 'ERROR', code: 'no_user', message: 'User not found' }); return; }
  if (u.power_tokens < msg.tier) { send(ws, { type: 'ERROR', code: 'insufficient_pt', message: 'Not enough Power Tokens for this tier' }); return; }

  // Reject if already mid-match.
  for (const m of matches.values()) {
    if (!m.settled && (m.players.A.pbId === msg.pbId || m.players.B.pbId === msg.pbId)) {
      send(ws, { type: 'ERROR', code: 'already_in_match', message: 'You are already in a match' });
      return;
    }
  }

  const q = queues.get(msg.tier) ?? [];
  // Dedupe: drop any stale entry for this user or dead socket.
  const cleaned = q.filter((e) => e.pbId !== msg.pbId && e.ws.readyState === 1);

  // Try to pair with a waiting opponent (different user).
  const opponentIdx = cleaned.findIndex((e) => e.pbId !== msg.pbId);
  if (opponentIdx >= 0) {
    const opp = cleaned.splice(opponentIdx, 1)[0];
    queues.set(msg.tier, cleaned);
    ctxOf.set(ws, { pbId: msg.pbId });
    await createMatch(msg.tier, { ws: opp.ws, pbId: opp.pbId, name: opp.name }, { ws, pbId: msg.pbId, name: u.display_name });
    return;
  }

  cleaned.push({ ws, pbId: msg.pbId, name: u.display_name, tier: msg.tier });
  queues.set(msg.tier, cleaned);
  ctxOf.set(ws, { pbId: msg.pbId });
  send(ws, { type: 'QUEUED', tier: msg.tier, game: 'pool8' });
}

function leaveQueue(ws: WebSocket): void {
  for (const [tier, q] of queues) {
    const next = q.filter((e) => e.ws !== ws);
    if (next.length !== q.length) queues.set(tier, next);
  }
}

async function createMatch(
  tier: number,
  a: { ws: WebSocket; pbId: string; name: string },
  b: { ws: WebSocket; pbId: string; name: string },
): Promise<void> {
  // Re-verify affordability, then debit BOTH stakes.
  const [ua, ub] = await Promise.all([fetchUser(a.pbId), fetchUser(b.pbId)]);
  if (!ua || ua.power_tokens < tier) {
    send(a.ws, { type: 'ERROR', code: 'insufficient_pt', message: 'Not enough Power Tokens' });
    // Re-queue the affordable opponent.
    if (ub && ub.power_tokens >= tier) { const q = queues.get(tier) ?? []; q.unshift({ ws: b.ws, pbId: b.pbId, name: b.name, tier }); queues.set(tier, q); send(b.ws, { type: 'QUEUED', tier, game: 'pool8' }); }
    return;
  }
  if (!ub || ub.power_tokens < tier) {
    send(b.ws, { type: 'ERROR', code: 'insufficient_pt', message: 'Not enough Power Tokens' });
    if (ua.power_tokens >= tier) { const q = queues.get(tier) ?? []; q.unshift({ ws: a.ws, pbId: a.pbId, name: a.name, tier }); queues.set(tier, q); send(a.ws, { type: 'QUEUED', tier, game: 'pool8' }); }
    return;
  }

  const requeueB = () => { if (ub.power_tokens >= tier) { const q = queues.get(tier) ?? []; q.unshift({ ws: b.ws, pbId: b.pbId, name: b.name, tier }); queues.set(tier, q); send(b.ws, { type: 'QUEUED', tier, game: 'pool8' }); } };

  // Debit A. A write failure here charges nobody — abort and requeue B.
  let debitedA = false;
  try { debitedA = await debitPT(a.pbId, tier); }
  catch (e: any) {
    console.error('[gamehub] debit A failed:', e?.message);
    send(a.ws, { type: 'ERROR', code: 'debit_failed', message: 'Could not start match, please retry' });
    requeueB();
    return;
  }
  if (!debitedA) {
    send(a.ws, { type: 'ERROR', code: 'insufficient_pt', message: 'Not enough Power Tokens' });
    requeueB();
    return;
  }

  // Debit B. ANY failure past this point MUST refund A's stake (guaranteed, never-throwing path).
  let debitedB = false;
  try { debitedB = await debitPT(b.pbId, tier); }
  catch (e: any) {
    console.error('[gamehub] debit B failed — refunding A:', e?.message);
    await safeRefund(a.pbId, tier, 'debitB_threw');
    send(a.ws, { type: 'REFUND', matchId: '', reason: 'opponent_unavailable', amountPT: tier });
    send(b.ws, { type: 'ERROR', code: 'debit_failed', message: 'Could not start match, please retry' });
    return;
  }
  if (!debitedB) {
    await safeRefund(a.pbId, tier, 'debitB_insufficient');
    send(a.ws, { type: 'REFUND', matchId: '', reason: 'opponent_unavailable', amountPT: tier });
    send(b.ws, { type: 'ERROR', code: 'insufficient_pt', message: 'Not enough Power Tokens' });
    return;
  }

  const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const breaker: Seat = Math.random() < 0.5 ? 'A' : 'B';
  const m: Match = {
    id, tier,
    state: createRackState(),
    turn: breaker,
    phase: 'active',
    players: {
      A: { seat: 'A', pbId: a.pbId, name: a.name, ws: a.ws, connected: true, group: null, skipped: 0 },
      B: { seat: 'B', pbId: b.pbId, name: b.name, ws: b.ws, connected: true, group: null, skipped: 0 },
    },
    openTable: true,
    ballInHand: false,
    settled: false,
    turnTimer: null,
    turnEndsAt: 0,
    graceTimer: {},
  };
  matches.set(id, m);
  ctxOf.set(a.ws, { pbId: a.pbId, matchId: id });
  ctxOf.set(b.ws, { pbId: b.pbId, matchId: id });

  const startAt = Date.now() + 1500;
  send(a.ws, { type: 'MATCH_FOUND', matchId: id, tier, youAre: 'A', opponent: { name: b.name }, state: m.state, turn: m.turn, startAt });
  send(b.ws, { type: 'MATCH_FOUND', matchId: id, tier, youAre: 'B', opponent: { name: a.name }, state: m.state, turn: m.turn, startAt });
  startTurnTimer(m);
}

/* ── Shot resolution (authoritative 8-ball rules via shared/pool/rules.ts) ── */
function seatOf(m: Match, ws: WebSocket): Seat | null {
  if (m.players.A.ws === ws) return 'A';
  if (m.players.B.ws === ws) return 'B';
  return null;
}

function handleShot(ws: WebSocket, msg: Extract<HubClientMsg, { type: 'SHOT' }>): void {
  const m = matches.get(msg.matchId);
  if (!m || m.settled || m.phase !== 'active') { send(ws, { type: 'ERROR', code: 'no_match', message: 'Match not active' }); return; }
  const seat = seatOf(m, ws);
  if (!seat) { send(ws, { type: 'ERROR', code: 'not_in_match', message: 'Not in this match' }); return; }
  if (seat !== m.turn) { send(ws, { type: 'ERROR', code: 'not_your_turn', message: 'Not your turn' }); return; }

  const cue = m.state.balls.find((b) => b.id === 0);
  if (!cue || !cue.active) { send(ws, { type: 'ERROR', code: 'place_cue_first', message: 'Place the cue ball first' }); return; }

  const shot: ShotInput = { angle: Number(msg.shot?.angle) || 0, power: Math.max(0, Math.min(1, Number(msg.shot?.power) || 0)) };

  // Snapshot the pre-shot rule state — shooter-on-8 and break detection MUST read
  // the state BEFORE the balls move (finalState has already sunk them).
  const preState = m.state;
  const shooterGroupBefore = m.players[seat].group;
  const rs: RuleState = {
    openTable: m.openTable,
    shooterGroup: shooterGroupBefore,
    shooterOnEight: shooterGroupBefore !== null && groupCleared(preState, shooterGroupBefore),
    isBreak: isBreakState(preState),
  };

  const result = simulateShot(preState, shot);
  m.state = result.finalState;
  m.players[seat].skipped = 0;

  // Authoritative turn transition from the SHARED rules engine (the same module
  // the client replays for offline practice — one source of truth).
  const tr = applyShotRules(rs, result);

  // Apply an open-table group assignment.
  if (tr.assignedGroup) {
    m.players[seat].group = tr.assignedGroup;
    m.players[other(seat)].group = tr.assignedGroup === 'solids' ? 'stripes' : 'solids';
    m.openTable = false;
  }

  // 8-ball resolution ends the match.
  if (tr.gameOver) {
    const winner: Seat = tr.gameOver.shooterWins ? seat : other(seat);
    broadcast(m, {
      type: 'SHOT_RESULT', matchId: m.id, by: seat, shot,
      events: result.events, finalState: m.state, pocketed: result.pocketed,
      cuePocketed: result.cuePocketed, nextTurn: winner, ballInHand: false,
    });
    settleMatch(m, winner, 'eight_ball');
    return;
  }

  const nextTurn: Seat = tr.keepTurn ? seat : other(seat);
  m.turn = nextTurn;
  m.ballInHand = tr.ballInHand;

  broadcast(m, {
    type: 'SHOT_RESULT', matchId: m.id, by: seat, shot,
    events: result.events, finalState: m.state, pocketed: result.pocketed,
    cuePocketed: result.cuePocketed, nextTurn, ballInHand: tr.ballInHand,
  });
  startTurnTimer(m);
  send(m.players.A.ws, { type: 'TURN', matchId: m.id, turn: nextTurn, turnEndsAt: m.turnEndsAt });
  send(m.players.B.ws, { type: 'TURN', matchId: m.id, turn: nextTurn, turnEndsAt: m.turnEndsAt });
}

function handlePlaceCue(ws: WebSocket, msg: Extract<HubClientMsg, { type: 'PLACE_CUE' }>): void {
  const m = matches.get(msg.matchId);
  if (!m || m.settled || m.phase !== 'active') return;
  const seat = seatOf(m, ws);
  if (!seat || seat !== m.turn || !m.ballInHand) return;

  const R = TABLE.BALL_R;
  let x = Math.max(R, Math.min(TABLE.PLAY_W - R, Number(msg.x) || 0));
  let y = Math.max(R, Math.min(TABLE.PLAY_H - R, Number(msg.y) || 0));
  // Avoid overlap with an active ball (small nudge outward if needed).
  for (const b of m.state.balls) {
    if (!b.active || b.id === 0) continue;
    const dx = x - b.x, dy = y - b.y;
    const d = Math.hypot(dx, dy);
    if (d < R * 2 && d > 0) { x = b.x + (dx / d) * R * 2; y = b.y + (dy / d) * R * 2; }
  }
  const cue = m.state.balls.find((b) => b.id === 0);
  if (cue) { cue.x = x; cue.y = y; cue.vx = 0; cue.vy = 0; cue.active = true; }
}

/* ── Reconnect / disconnect ───────────────────────────────────────────────── */
async function handleResume(ws: WebSocket, msg: Extract<HubClientMsg, { type: 'RESUME' }>): Promise<void> {
  const ok = await verifyToken(msg.token, msg.pbId);
  if (!ok) { send(ws, { type: 'ERROR', code: 'auth', message: 'Authentication failed' }); return; }
  const m = matches.get(msg.matchId);
  if (!m || m.settled) { send(ws, { type: 'ERROR', code: 'no_match', message: 'Match no longer available' }); return; }
  const seat = (['A', 'B'] as Seat[]).find((s) => m.players[s].pbId === msg.pbId);
  if (!seat) { send(ws, { type: 'ERROR', code: 'not_in_match', message: 'Not a player in this match' }); return; }

  const p = m.players[seat];
  p.ws = ws;
  p.connected = true;
  const g = m.graceTimer[seat];
  if (g) { clearTimeout(g); delete m.graceTimer[seat]; }
  ctxOf.set(ws, { pbId: msg.pbId, matchId: m.id });

  const oppName = m.players[other(seat)].name;
  send(ws, { type: 'MATCH_FOUND', matchId: m.id, tier: m.tier, youAre: seat, opponent: { name: oppName }, state: m.state, turn: m.turn, ballInHand: m.ballInHand, startAt: Date.now() });
  send(ws, { type: 'TURN', matchId: m.id, turn: m.turn, turnEndsAt: m.turnEndsAt });
  send(m.players[other(seat)].ws, { type: 'OPPONENT_BACK', matchId: m.id });

  // Resume the shot clock if it had been paused by the disconnect.
  if (m.turn === seat && !m.turnTimer) startTurnTimer(m);
}

function handleDisconnect(ws: WebSocket): void {
  leaveQueue(ws);
  const ctx = ctxOf.get(ws);
  if (!ctx?.matchId) return;
  const m = matches.get(ctx.matchId);
  if (!m || m.settled) return;
  const seat = (['A', 'B'] as Seat[]).find((s) => m.players[s].ws === ws);
  if (!seat) return;

  m.players[seat].connected = false;
  m.players[seat].ws = null;
  // Pause the shot clock while we wait for a reconnect.
  if (m.turn === seat) stopTurnTimer(m);

  send(m.players[other(seat)].ws, { type: 'OPPONENT_LEFT', matchId: m.id, graceMs: GRACE_SECONDS * 1000 });
  m.graceTimer[seat] = setTimeout(() => {
    if (m.settled) return;
    if (!m.players[seat].connected) settleMatch(m, other(seat), 'forfeit');
  }, GRACE_SECONDS * 1000);
}

/* ── WebSocket wiring ─────────────────────────────────────────────────────── */
export function setupGameHubWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket) => {
    ctxOf.set(ws, {});
    ws.on('message', (raw: any) => {
      let msg: HubClientMsg;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as HubClientMsg; } catch { return; }
      switch (msg.type) {
        case 'PING': send(ws, { type: 'PONG' }); break;
        case 'JOIN_QUEUE': tryJoinQueue(ws, msg).catch((e) => console.error('[gamehub] JOIN_QUEUE:', e?.message)); break;
        case 'LEAVE_QUEUE': leaveQueue(ws); break;
        case 'SHOT': handleShot(ws, msg); break;
        case 'PLACE_CUE': handlePlaceCue(ws, msg); break;
        case 'RESUME': handleResume(ws, msg).catch((e) => console.error('[gamehub] RESUME:', e?.message)); break;
        default: break;
      }
    });
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
  });
  console.log('[gamehub] WebSocket handler attached (/api/ws/hub) ✓');
}
