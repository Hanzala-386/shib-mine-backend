/**
 * arcadehub.ts — Server-authoritative ASYNC score-matching PvP arcade hub.
 *
 * WebSocket path: /api/ws/hub-arcade  (ARCADE_WS_PATH in shared/arcade.ts)
 *
 * Authority model (differs from pool8, which re-simulates physics):
 *  - Each player plays a single-player HTML5 game locally in a WebView. The RN
 *    app owns this socket and relays the game's score to the server. There is no
 *    shared simulation; the server is authoritative over the MATCH LIFECYCLE and
 *    MONEY, and applies plausibility limits to the reported score.
 *  - Money moves ONLY here: on match start both players' power_tokens are debited
 *    by the tier stake; on settlement the winner is credited Hit Tickets using the
 *    shared 10%-commission settlement math; a draw refunds both stakes fee-free.
 *
 * Win rules (no gameplay timer):
 *   Case A — early win: the still-alive player's score passes the out player's
 *            locked score → that player is FROZEN and wins instantly.
 *   Case B — both out:  the higher locked score wins.
 *   Case C — tie:       equal locked scores → draw, both stakes refunded.
 *
 * Reconnect (v1 policy): RN owns the socket. An unexpected drop starts a 30s
 * grace; RESUME re-attaches and the run continues (a short catch-up jump is
 * tolerated). If grace expires the run is locked at the last server-known score
 * and the match resolves by comparison — the player is NOT force-forfeited, so a
 * lead they earned still wins and is credited server-side.
 *
 * Anti-cheat is SOFT (matches the app-wide trust model): scores are monotonic,
 * clamped to a per-game max increment and ceiling, and any anomaly is recorded to
 * the admin-only `suspicious_users` collection — it never blocks a payout.
 */

import type { WebSocket, WebSocketServer } from 'ws';

import {
  fetchUser, verifyToken, debitPT, creditTickets, safeRefund,
  pbGet, pbPost,
} from './gamehub';
import {
  ARCADE_TIERS, ARCADE_GRACE_SECONDS, ARCADE_MAX_MATCH_MS,
  computePoolSettlement, getGameSpec,
  type ArcadeClientMsg, type ArcadeServerMsg, type ArcadeEndReason,
  type Seat, type GameSpec,
} from '../shared/arcade';

/* ── suspicious_users collection (admin-only anti-cheat log) ──────────────── */
export async function ensureSuspiciousUsersCollection(): Promise<void> {
  try {
    const existing = await pbGet('/api/collections/suspicious_users');
    if (existing?.id) { console.log('[arcade] suspicious_users ✓'); return; }
    await pbPost('/api/collections', {
      name: 'suspicious_users',
      type: 'base',
      schema: [
        { name: 'pb_user', type: 'text', required: false },
        { name: 'display_name', type: 'text', required: false },
        { name: 'reason', type: 'text', required: false },
        { name: 'evidence', type: 'json', required: false },
      ],
      // Admin-only: the app never reads or writes this from the client.
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    });
    console.log('[arcade] created suspicious_users ✓');
  } catch (e: any) {
    console.warn('[arcade] ensureSuspiciousUsersCollection failed:', e?.message);
  }
}

/** Fire-and-forget anti-cheat log. Must NEVER throw into the money/gameplay path. */
function flagSuspicious(pbId: string, name: string, reason: string, evidence: object): void {
  pbPost('/api/collections/suspicious_users/records', {
    pb_user: pbId, display_name: name, reason, evidence,
  }).catch(() => { /* swallow — logging failures must not affect a match */ });
}

/* ── In-memory match state ────────────────────────────────────────────────── */
interface ArcadePlayer {
  seat: Seat;
  pbId: string;
  name: string;
  ws: WebSocket | null;
  connected: boolean;
  alive: boolean;         // false once the run is over
  locked: boolean;        // final score locked in
  score: number;          // server-authoritative running score
  lastScoreAt: number;    // ms of last accepted increment (rate check)
  resumeGraceUntil: number; // window after a RESUME during which a score jump is tolerated
  violations: number;
}
interface ArcadeMatch {
  id: string;
  gameId: string;
  tier: number;
  spec: GameSpec;
  players: Record<Seat, ArcadePlayer>;
  settled: boolean;
  startedAt: number;
  graceTimer: Partial<Record<Seat, ReturnType<typeof setTimeout>>>;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
}
interface QueueEntry { ws: WebSocket; pbId: string; name: string; gameId: string; tier: number }
interface WsCtx { pbId?: string; matchId?: string }

const queues = new Map<string, QueueEntry[]>();   // key: `${gameId}:${tier}`
const matches = new Map<string, ArcadeMatch>();
const ctxOf = new WeakMap<WebSocket, WsCtx>();

const other = (s: Seat): Seat => (s === 'A' ? 'B' : 'A');
const qKey = (gameId: string, tier: number) => `${gameId}:${tier}`;

function send(ws: WebSocket | null, msg: ArcadeServerMsg): void {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch { /* noop */ }
}

/* ── Score plausibility (soft anti-cheat) ─────────────────────────────────── */
/** Returns the accepted (possibly clamped) score. Never throws. Flags anomalies. */
function acceptScore(m: ArcadeMatch, p: ArcadePlayer, raw: number): number {
  const now = Date.now();
  const spec = m.spec.scoreDelta;
  let s = Math.floor(Number(raw));
  if (!Number.isFinite(s) || s <= p.score) return p.score; // ignore garbage / replays / non-increases

  const resuming = now < p.resumeGraceUntil;
  if (!resuming) {
    const delta = s - p.score;
    const violations: string[] = [];
    if (delta > spec.maxIncrement) { violations.push(`delta ${delta}>${spec.maxIncrement}`); }
    if (p.lastScoreAt && (now - p.lastScoreAt) < spec.minIntervalMs) {
      violations.push(`interval ${now - p.lastScoreAt}ms<${spec.minIntervalMs}ms`);
    }
    if (s > m.spec.maxScore) { violations.push(`score ${s}>${m.spec.maxScore}`); }
    if (violations.length) {
      p.violations += 1;
      flagSuspicious(p.pbId, p.name, 'arcade_score_anomaly', {
        gameId: m.gameId, matchId: m.id, reported: raw, prevScore: p.score,
        delta, intervalMs: p.lastScoreAt ? now - p.lastScoreAt : null, detail: violations.join('; '),
      });
    }
    // Clamp to the max legit increment so a forged jump cannot inflate the win.
    if (delta > spec.maxIncrement) s = p.score + spec.maxIncrement;
  }
  if (s > m.spec.maxScore) s = m.spec.maxScore;
  p.score = s;
  p.lastScoreAt = now;
  return s;
}

/* ── Settlement (latch `settled` BEFORE the first await — money invariant) ── */
function clearMatchTimers(m: ArcadeMatch): void {
  for (const s of ['A', 'B'] as Seat[]) { const t = m.graceTimer[s]; if (t) { clearTimeout(t); delete m.graceTimer[s]; } }
  if (m.lifetimeTimer) { clearTimeout(m.lifetimeTimer); m.lifetimeTimer = null; }
}

function sendResult(m: ArcadeMatch, seat: Seat, outcome: 'win' | 'lose' | 'draw', reason: ArcadeEndReason, winnerTickets: number, refundPT: number): void {
  const me = m.players[seat];
  const opp = m.players[other(seat)];
  send(me.ws, {
    type: 'MATCH_RESULT', matchId: m.id, outcome, reason,
    yourScore: me.score, opponentScore: opp.score, winnerTickets, refundPT,
  });
}

async function settleMatch(m: ArcadeMatch, winner: Seat | null, reason: ArcadeEndReason): Promise<void> {
  if (m.settled) return;
  m.settled = true;              // ← synchronous latch before any await (no double-credit)
  clearMatchTimers(m);
  const tier = m.tier;

  if (winner === null) {
    // Draw → refund BOTH stakes, fee-free, never-throwing.
    await safeRefund(m.players.A.pbId, tier, `arcade_draw_${m.id}`);
    await safeRefund(m.players.B.pbId, tier, `arcade_draw_${m.id}`);
    sendResult(m, 'A', 'draw', reason, 0, tier);
    sendResult(m, 'B', 'draw', reason, 0, tier);
    console.log(`[arcade] match ${m.id.slice(0, 8)} DRAW (${reason}) — refunded ${tier} PT × 2`);
  } else {
    const settlement = computePoolSettlement(tier);
    const winnerId = m.players[winner].pbId;
    // Retry the payout — a silently dropped credit means a staked player got nothing.
    let credited = false;
    for (let attempt = 1; attempt <= 3 && !credited; attempt++) {
      try {
        await creditTickets(winnerId, settlement.winnerTickets);
        credited = true;
        console.log(`[arcade] match ${m.id.slice(0, 8)} settled: winner=${winner} reason=${reason} +${settlement.winnerTickets} tickets → ${winnerId}`);
      } catch (e: any) {
        console.error(`[arcade] settlement credit attempt ${attempt}/3 failed (${winnerId}):`, e?.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (!credited) {
      console.error(`[arcade] CRITICAL: winner ${winnerId} NOT credited ${settlement.winnerTickets} tickets — match ${m.id} tier ${tier} — manual reconciliation required`);
    }
    sendResult(m, winner, 'win', reason, settlement.winnerTickets, 0);
    sendResult(m, other(winner), 'lose', reason, 0, 0);
  }

  setTimeout(() => matches.delete(m.id), 15_000);
}

/**
 * Inspect the match and settle if a terminal condition is met. Safe to call after
 * every SCORE / PLAYER_OUT event; the `settled` latch makes concurrent triggers idempotent.
 */
function checkSettlement(m: ArcadeMatch): void {
  if (m.settled) return;
  const A = m.players.A, B = m.players.B;

  if (A.locked && B.locked) {
    if (A.score > B.score) settleMatch(m, 'A', 'both_out');
    else if (B.score > A.score) settleMatch(m, 'B', 'both_out');
    else settleMatch(m, null, 'draw');
    return;
  }
  // Exactly one out → Case A the moment the alive player passes the locked score.
  if (A.locked && !B.locked && B.score > A.score) {
    send(B.ws, { type: 'FREEZE_INPUT', matchId: m.id, reason: 'early_win' });
    settleMatch(m, 'B', 'early_win');
    return;
  }
  if (B.locked && !A.locked && A.score > B.score) {
    send(A.ws, { type: 'FREEZE_INPUT', matchId: m.id, reason: 'early_win' });
    settleMatch(m, 'A', 'early_win');
  }
}

/** Hard lifetime cap — settle by current scores so a match can never escrow forever. */
function onLifetimeCap(m: ArcadeMatch): void {
  if (m.settled) return;
  const A = m.players.A, B = m.players.B;
  if (A.score > B.score) settleMatch(m, 'A', 'timeout');
  else if (B.score > A.score) settleMatch(m, 'B', 'timeout');
  else settleMatch(m, null, 'timeout');
}

/* ── Matchmaking ──────────────────────────────────────────────────────────── */
async function handleJoinQueue(ws: WebSocket, msg: Extract<ArcadeClientMsg, { type: 'JOIN_QUEUE' }>): Promise<void> {
  const spec = getGameSpec(msg.gameId);
  if (!spec) { send(ws, { type: 'ERROR', code: 'bad_game', message: 'Unsupported game' }); return; }
  if (!(ARCADE_TIERS as readonly number[]).includes(msg.tier)) { send(ws, { type: 'ERROR', code: 'bad_tier', message: 'Invalid tier' }); return; }

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

  const key = qKey(msg.gameId, msg.tier);
  const q = queues.get(key) ?? [];
  const cleaned = q.filter((e) => e.pbId !== msg.pbId && e.ws.readyState === 1);

  const opponentIdx = cleaned.findIndex((e) => e.pbId !== msg.pbId);
  if (opponentIdx >= 0) {
    const opp = cleaned.splice(opponentIdx, 1)[0];
    queues.set(key, cleaned);
    ctxOf.set(ws, { pbId: msg.pbId });
    await createMatch(spec, msg.tier, { ws: opp.ws, pbId: opp.pbId, name: opp.name }, { ws, pbId: msg.pbId, name: u.display_name });
    return;
  }

  cleaned.push({ ws, pbId: msg.pbId, name: u.display_name, gameId: msg.gameId, tier: msg.tier });
  queues.set(key, cleaned);
  ctxOf.set(ws, { pbId: msg.pbId });
  send(ws, { type: 'QUEUED', gameId: msg.gameId, tier: msg.tier });
}

function leaveQueue(ws: WebSocket): void {
  for (const [key, q] of queues) {
    const next = q.filter((e) => e.ws !== ws);
    if (next.length !== q.length) queues.set(key, next);
  }
}

function newPlayer(seat: Seat, pbId: string, name: string, ws: WebSocket): ArcadePlayer {
  return { seat, pbId, name, ws, connected: true, alive: true, locked: false, score: 0, lastScoreAt: 0, resumeGraceUntil: 0, violations: 0 };
}

async function createMatch(
  spec: GameSpec,
  tier: number,
  a: { ws: WebSocket; pbId: string; name: string },
  b: { ws: WebSocket; pbId: string; name: string },
): Promise<void> {
  const key = qKey(spec.gameId, tier);
  const requeue = (side: { ws: WebSocket; pbId: string; name: string }) => {
    const q = queues.get(key) ?? [];
    q.unshift({ ws: side.ws, pbId: side.pbId, name: side.name, gameId: spec.gameId, tier });
    queues.set(key, q);
    send(side.ws, { type: 'QUEUED', gameId: spec.gameId, tier });
  };

  // Debit A. A failure here charges nobody — abort and requeue B.
  let debitedA = false;
  try { debitedA = await debitPT(a.pbId, tier); }
  catch (e: any) {
    console.error('[arcade] debit A failed:', e?.message);
    send(a.ws, { type: 'ERROR', code: 'debit_failed', message: 'Could not start match, please retry' });
    requeue(b);
    return;
  }
  if (!debitedA) {
    send(a.ws, { type: 'ERROR', code: 'insufficient_pt', message: 'Not enough Power Tokens' });
    requeue(b);
    return;
  }

  // Debit B. ANY failure past this point MUST refund A (guaranteed, never-throwing).
  let debitedB = false;
  try { debitedB = await debitPT(b.pbId, tier); }
  catch (e: any) {
    console.error('[arcade] debit B failed — refunding A:', e?.message);
    await safeRefund(a.pbId, tier, 'arcade_debitB_threw');
    send(a.ws, { type: 'REFUND', matchId: '', reason: 'opponent_unavailable', amountPT: tier });
    send(b.ws, { type: 'ERROR', code: 'debit_failed', message: 'Could not start match, please retry' });
    return;
  }
  if (!debitedB) {
    await safeRefund(a.pbId, tier, 'arcade_debitB_insufficient');
    send(a.ws, { type: 'REFUND', matchId: '', reason: 'opponent_unavailable', amountPT: tier });
    send(b.ws, { type: 'ERROR', code: 'insufficient_pt', message: 'Not enough Power Tokens' });
    return;
  }

  const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const m: ArcadeMatch = {
    id, gameId: spec.gameId, tier, spec,
    players: { A: newPlayer('A', a.pbId, a.name, a.ws), B: newPlayer('B', b.pbId, b.name, b.ws) },
    settled: false,
    startedAt: Date.now(),
    graceTimer: {},
    lifetimeTimer: null,
  };
  matches.set(id, m);
  ctxOf.set(a.ws, { pbId: a.pbId, matchId: id });
  ctxOf.set(b.ws, { pbId: b.pbId, matchId: id });

  const startAt = Date.now() + 1500;
  send(a.ws, { type: 'MATCH_START', matchId: id, gameId: spec.gameId, tier, youAre: 'A', opponent: { name: b.name }, lives: spec.lives, startAt });
  send(b.ws, { type: 'MATCH_START', matchId: id, gameId: spec.gameId, tier, youAre: 'B', opponent: { name: a.name }, lives: spec.lives, startAt });

  m.lifetimeTimer = setTimeout(() => onLifetimeCap(m), ARCADE_MAX_MATCH_MS);
}

/* ── In-match events ──────────────────────────────────────────────────────── */
function seatOf(m: ArcadeMatch, ws: WebSocket): Seat | null {
  if (m.players.A.ws === ws) return 'A';
  if (m.players.B.ws === ws) return 'B';
  return null;
}

function handleScore(ws: WebSocket, msg: Extract<ArcadeClientMsg, { type: 'SCORE' }>): void {
  const m = matches.get(msg.matchId);
  if (!m || m.settled) return;
  const seat = seatOf(m, ws);
  if (!seat) return;
  const p = m.players[seat];
  if (!p.alive || p.locked) return;

  const accepted = acceptScore(m, p, msg.score);
  send(m.players[other(seat)].ws, { type: 'OPPONENT_SCORE', matchId: m.id, score: accepted });
  checkSettlement(m);
}

function handlePlayerOut(ws: WebSocket, msg: Extract<ArcadeClientMsg, { type: 'PLAYER_OUT' }>): void {
  const m = matches.get(msg.matchId);
  if (!m || m.settled) return;
  const seat = seatOf(m, ws);
  if (!seat) return;
  const p = m.players[seat];
  if (p.locked) return;

  // The locked score is the SERVER-tracked score (validated increments), never the
  // client's out-message number — that message is only a signal that the run ended.
  acceptScore(m, p, msg.score); // absorb a possible final +1
  p.alive = false;
  p.locked = true;

  const opp = m.players[other(seat)];
  if (!opp.locked) send(opp.ws, { type: 'OPPONENT_OUT', matchId: m.id, score: p.score });
  checkSettlement(m);
}

/* ── Reconnect / disconnect ───────────────────────────────────────────────── */
async function handleResume(ws: WebSocket, msg: Extract<ArcadeClientMsg, { type: 'RESUME' }>): Promise<void> {
  const ok = await verifyToken(msg.token, msg.pbId);
  if (!ok) { send(ws, { type: 'ERROR', code: 'auth', message: 'Authentication failed' }); return; }
  const m = matches.get(msg.matchId);
  if (!m || m.settled) { send(ws, { type: 'ERROR', code: 'no_match', message: 'Match no longer available' }); return; }
  const seat = (['A', 'B'] as Seat[]).find((s) => m.players[s].pbId === msg.pbId);
  if (!seat) { send(ws, { type: 'ERROR', code: 'not_in_match', message: 'Not a player in this match' }); return; }

  const p = m.players[seat];
  p.ws = ws;
  p.connected = true;
  p.resumeGraceUntil = Date.now() + 3000; // tolerate one score catch-up jump
  const g = m.graceTimer[seat];
  if (g) { clearTimeout(g); delete m.graceTimer[seat]; }
  ctxOf.set(ws, { pbId: msg.pbId, matchId: m.id });

  const opp = m.players[other(seat)];
  send(ws, { type: 'MATCH_START', matchId: m.id, gameId: m.gameId, tier: m.tier, youAre: seat, opponent: { name: opp.name }, lives: m.spec.lives, startAt: Date.now() });
  if (opp.locked) send(ws, { type: 'OPPONENT_OUT', matchId: m.id, score: opp.score });
  else send(ws, { type: 'OPPONENT_SCORE', matchId: m.id, score: opp.score });
  send(opp.ws, { type: 'OPPONENT_BACK', matchId: m.id });
}

function handleDisconnect(ws: WebSocket): void {
  leaveQueue(ws);
  const ctx = ctxOf.get(ws);
  if (!ctx?.matchId) return;
  const m = matches.get(ctx.matchId);
  if (!m || m.settled) return;
  const seat = (['A', 'B'] as Seat[]).find((s) => m.players[s].ws === ws);
  if (!seat) return;
  const p = m.players[seat];
  p.connected = false;
  p.ws = null;
  if (p.locked) return; // already resolved — result credits server-side regardless

  send(m.players[other(seat)].ws, { type: 'OPPONENT_LEFT', matchId: m.id, graceMs: ARCADE_GRACE_SECONDS * 1000 });
  const t = setTimeout(() => {
    if (m.settled) return;
    const pp = m.players[seat];
    if (pp.connected || pp.locked) return; // reconnected or finished during grace
    // Lock the run at the last server-known score (NOT a forfeit — a lead still wins).
    pp.alive = false;
    pp.locked = true;
    const opp = m.players[other(seat)];
    if (!opp.locked) send(opp.ws, { type: 'OPPONENT_OUT', matchId: m.id, score: pp.score });
    checkSettlement(m);
  }, ARCADE_GRACE_SECONDS * 1000);
  m.graceTimer[seat] = t;
}

/* ── WebSocket wiring ─────────────────────────────────────────────────────── */
export function setupArcadeHubWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data: unknown) => {
      let msg: ArcadeClientMsg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      switch (msg?.type) {
        case 'JOIN_QUEUE':  handleJoinQueue(ws, msg).catch((e) => console.error('[arcade] join error:', e?.message)); break;
        case 'LEAVE_QUEUE': leaveQueue(ws); break;
        case 'RESUME':      handleResume(ws, msg).catch((e) => console.error('[arcade] resume error:', e?.message)); break;
        case 'SCORE':       handleScore(ws, msg); break;
        case 'PLAYER_OUT':  handlePlayerOut(ws, msg); break;
        case 'PING':        send(ws, { type: 'PONG' }); break;
        default: break;
      }
    });
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
  });
  console.log('[arcade] hub WebSocket ready (/api/ws/hub-arcade)');
}
