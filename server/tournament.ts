/**
 * tournament.ts — Zero-Trust, Fully-Manual Tournament Cycles
 *
 * Model:
 *  - There is NO automatic weekly cycle. A tournament exists ONLY when the admin
 *    starts one (writes tournament_config with is_active=true + a fresh cycle_id
 *    + an arbitrary start_time/end_time). When a cycle's end_time passes the
 *    engine instantly pays out, wipes participants, and drops to the inactive
 *    (red "Tournament will start soon") state until the admin starts the next one.
 *
 * Security model:
 *  - Points are NEVER accepted from the client. The server reads mining_sessions
 *    directly and computes each user's points atomically.
 *  - Each cycle is identified by a unique `cycle_id`. Payout is finalized exactly
 *    once per cycle_id (payout_finalized_cycle marker), so the same cycle can
 *    NEVER be paid twice — even across server restarts or overlapping runs.
 *  - A single dynamic end-of-cycle timer is driven by the active cycle's end_time
 *    (re)scheduled on boot and via a 60s reconciler poll that also detects
 *    admin-started cycles written directly to PocketBase by the production APK.
 *
 * Exports:
 *  setupTournamentSchema()      — idempotent schema creation on server boot
 *  syncUserTournamentPoints()   — server-side point recalculation from mining_sessions
 *  runEndOfCycle()              — freeze + prize payout + history export + wipe
 *  startTournamentCron()        — boot catch-up + dynamic end-of-cycle reconciler
 */

import https from 'node:https';
import http  from 'node:http';

const PB_URL = 'https://api.webcod.in';

// ── PocketBase HTTP helpers ─────────────────────────────────────────────────

function pbHttp(method: string, path: string, body: object | null, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    if (data)  headers['Content-Length'] = String(Buffer.byteLength(data));

    const url  = new URL(path, PB_URL);
    const lib  = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } });
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('PB timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let _adminToken  = '';
let _tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (_adminToken && Date.now() < _tokenExpiry) return _adminToken;
  const res = await pbHttp('POST', '/api/admins/auth-with-password', {
    identity: process.env.PB_ADMIN_EMAIL,
    password: process.env.PB_ADMIN_PASSWORD,
  });
  if (!res.token) throw new Error(`PB admin auth failed: ${JSON.stringify(res)}`);
  _adminToken  = res.token;
  _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return _adminToken;
}

async function pbGet(path: string)                    { return pbHttp('GET',    path, null,  await getAdminToken()); }
async function pbPost(path: string, body: object)     { return pbHttp('POST',   path, body,  await getAdminToken()); }
async function pbPatch(path: string, body: object)    { return pbHttp('PATCH',  path, body,  await getAdminToken()); }
async function pbDelete(path: string)                 { return pbHttp('DELETE', path, null,  await getAdminToken()); }

// ── Cycle helpers ───────────────────────────────────────────────────────────

/**
 * Generate a unique per-cycle id. Each admin "start" produces a fresh one; the
 * payout finalization marker is keyed to it so a cycle can never be paid twice.
 */
function generateCycleId(): string {
  return `cyc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the permanent finalization key for a config row. Prefers the explicit
 * cycle_id; falls back to a start_time-derived legacy key only for pre-migration
 * configs that have no cycle_id yet (the reconciler backfills cycle_id before a
 * cycle can end, so the fallback is just belt-and-suspenders).
 */
function cycleKeyOf(cfg: any): string {
  if (cfg?.cycle_id) return String(cfg.cycle_id);
  const iso = cfg?.start_time || cfg?.week_start;
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `legacy_${d.toISOString().slice(0, 10)}`;
}

// ── Participant cleanup helpers ─────────────────────────────────────────────

/**
 * Deletes every tournament_participants row (superuser-authed). Reads all ids
 * FIRST (stable — no mutation during pagination), then deletes, so no row is
 * ever skipped by index shift. Returns the count removed.
 */
async function wipeAllParticipants(): Promise<number> {
  const ids: string[] = [];
  let page = 1;
  while (true) {
    const batch = await pbGet(`/api/collections/tournament_participants/records?perPage=200&page=${page}&fields=id`).catch(() => null);
    const items: any[] = batch?.items ?? [];
    if (!items.length) break;
    for (const r of items) ids.push(r.id);
    if (items.length < 200) break;
    page++;
  }
  for (const id of ids) {
    await pbDelete(`/api/collections/tournament_participants/records/${id}`).catch(() => {});
  }
  return ids.length;
}

/** Cheap existence probe — returns true if ANY participant row remains. */
async function anyParticipantsExist(): Promise<boolean> {
  const batch = await pbGet('/api/collections/tournament_participants/records?perPage=1&fields=id').catch(() => null);
  return (batch?.items?.length ?? 0) > 0;
}

// ── Schema helpers ─────────────────────────────────────────────────────────

async function ensureField(collectionName: string, fieldName: string, fieldDef: object): Promise<void> {
  try {
    const col = await pbGet(`/api/collections/${collectionName}`);
    if (!col?.id) return;
    if ((col.schema || []).some((f: any) => f.name === fieldName)) {
      console.log(`[tournament] ${collectionName}.${fieldName} ✓`);
      return;
    }
    await pbPatch(`/api/collections/${col.id}`, { schema: [...(col.schema || []), { name: fieldName, ...fieldDef }] });
    console.log(`[tournament] Added ${collectionName}.${fieldName} ✓`);
  } catch (e: any) {
    console.warn(`[tournament] ensureField ${collectionName}.${fieldName}:`, e.message);
  }
}

async function ensureCollection(name: string, schema: object[], rules: Record<string, string | null> = {}): Promise<string | null> {
  try {
    const existing = await pbGet(`/api/collections/${name}`);
    if (existing?.id) { console.log(`[tournament] ${name} ✓`); return existing.id; }
  } catch {}
  try {
    const res = await pbPost('/api/collections', { name, type: 'base', schema, listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null, ...rules });
    console.log(`[tournament] Created ${name} ✓`);
    return res?.id ?? null;
  } catch (e: any) {
    console.warn(`[tournament] ensureCollection ${name}:`, e.message);
    return null;
  }
}

// ── Public: schema setup ───────────────────────────────────────────────────

export async function setupTournamentSchema(): Promise<void> {
  try {
    // ── users collection fields ──────────────────────────────────────────
    const userTextOpt  = { type: 'text',   required: false, options: { min: null, max: null, pattern: '' } };
    const userNumOpt   = { type: 'number', required: false, options: { min: null, max: null } };
    const userBoolOpt  = { type: 'bool',   required: false, options: {} };
    const fileOpts     = { type: 'file', required: false, options: { maxSelect: 1, maxSize: 5242880, mimeTypes: ['image/jpeg','image/png','image/webp','image/gif'], thumbs: ['100x100'], protected: false } };

    await ensureField('users', 'tournament_joined',           userBoolOpt);
    await ensureField('users', 'weekly_tournament_points',    userNumOpt);
    await ensureField('users', 'avatar',                      fileOpts);
    await ensureField('users', 'avatar2',                     fileOpts);
    await ensureField('users', 'daily_streak',                userNumOpt);
    await ensureField('users', 'last_daily_claim',            userTextOpt);

    // ── settings collection: daily reward amounts ────────────────────────
    for (const f of ['daily_reward_day1_shib','daily_reward_day2_pt','daily_reward_day3_shib','daily_reward_day4_pt','daily_reward_day5_shib','daily_reward_day6_pt','daily_reward_day7_shib','daily_reward_day7_pt']) {
      await ensureField('settings', f, userNumOpt);
    }

    // ── tournament_config collection ─────────────────────────────────────
    const tcExisting = await pbGet('/api/collections/tournament_config').catch(() => null);
    if (!tcExisting?.id) {
      await pbPost('/api/collections', {
        name: 'tournament_config', type: 'base',
        schema: [
          { name: 'prize_pool_total', type: 'number', required: false, options: { min: null, max: null } },
          { name: 'winners_count',    type: 'number', required: false, options: { min: null, max: null } },
          { name: 'reward_structure', type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'banner',           type: 'file',   required: false, options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ['image/jpeg','image/png','image/gif','image/webp'], thumbs: [], protected: false } },
          { name: 'banner_url',       type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'week_start',       type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'start_time',       type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'end_time',         type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'is_active',        type: 'bool',   required: false, options: {} },
          { name: 'payout_finalized_bucket', type: 'text', required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'cycle_id',               type: 'text', required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'payout_finalized_cycle', type: 'text', required: false, options: { min: null, max: null, pattern: '' } },
        ],
        listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null,
      });
      // Fully-manual model: do NOT seed an active tournament. A fresh DB starts
      // in the inactive (red "Tournament will start soon") state until the admin
      // launches the first cycle.
      console.log('[tournament] tournament_config created (no auto-seed — manual cycles) ✓');
    } else {
      // Ensure new fields exist on existing collection (additive migration)
      await ensureField('tournament_config', 'start_time', userTextOpt);
      await ensureField('tournament_config', 'end_time',   userTextOpt);
      await ensureField('tournament_config', 'banner',     { type: 'file', required: false, options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ['image/jpeg','image/png','image/gif','image/webp'], thumbs: [], protected: false } });
      await ensureField('tournament_config', 'payout_finalized_bucket', userTextOpt);
      await ensureField('tournament_config', 'cycle_id',               userTextOpt);
      await ensureField('tournament_config', 'payout_finalized_cycle', userTextOpt);
      // NOTE: end_time is NEVER auto-back-filled in the manual model — the admin
      // owns start_time/end_time. The reconciler backfills only cycle_id (so a
      // pre-migration live cycle gets a permanent payout-lock key).
    }

    // ── tournament_participants collection ───────────────────────────────
    const tpExisting = await pbGet('/api/collections/tournament_participants').catch(() => null);
    if (!tpExisting?.id) {
      await pbPost('/api/collections', {
        name: 'tournament_participants', type: 'base',
        schema: [
          { name: 'user_id',                     type: 'text',   required: true,  options: { min: null, max: null, pattern: '' } },
          { name: 'display_name',                type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'week_start',                  type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'cycle_id',                    type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'joined_at',                   type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'points',                      type: 'number', required: false, options: { min: null, max: null } },
          { name: 'registered_during_intermission', type: 'bool', required: false, options: {} },
        ],
        // points is NON-AUTHORITATIVE (leaderboard + winners read users.weekly_tournament_points).
        // Self-update lets a client mirror its OWN points into this cosmetic row.
        listRule: '', viewRule: '', createRule: '@request.auth.id != ""',
        updateRule: 'user_id = @request.auth.id', deleteRule: null,
      });
      console.log('[tournament] tournament_participants created ✓');
    } else {
      await ensureField('tournament_participants', 'registered_during_intermission', userBoolOpt);
      await ensureField('tournament_participants', 'cycle_id', userTextOpt);
      // Migrate the existing (shared-PB) collection: allow self-update so clients can
      // mirror their own points. Cosmetic field — authoritative points live on users.
      try {
        await pbPatch(`/api/collections/${tpExisting.id}`, { updateRule: 'user_id = @request.auth.id' });
        console.log('[tournament] tournament_participants.updateRule → self-update ✓');
      } catch (e: any) {
        console.warn('[tournament] could not patch tournament_participants.updateRule:', e?.message);
      }
    }

    // ── tournament_history collection (permanent winners log) ────────────
    await ensureCollection('tournament_history', [
      { name: 'week_end',      type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
      { name: 'rank',          type: 'number', required: false, options: { min: null, max: null } },
      { name: 'user_id',       type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
      { name: 'display_name',  type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
      { name: 'points',        type: 'number', required: false, options: { min: null, max: null } },
      { name: 'prize',         type: 'number', required: false, options: { min: null, max: null } },
    ]);

    // ── daily_claim_settings collection ─────────────────────────────────
    await ensureDailyClaimSettingsCollection();
    await ensureDailyClaimsCollection();

    // ── app_config (Force Update gate) ──────────────────────────────────
    await ensureAppConfigCollection();

    // ── announcements (banner modal) ────────────────────────────────────
    await ensureAnnouncementsCollection();

    console.log('[tournament] setupTournamentSchema complete ✓');
  } catch (e: any) {
    console.warn('[tournament] setupTournamentSchema error:', e.message);
  }
}

// ── app_config (Force Update) collection ───────────────────────────────────
// Single-row system config that drives the non-bypassable force-update gate.
// Public read (listRule/viewRule = '') so the APK can fetch it without auth.
async function ensureAppConfigCollection(): Promise<void> {
  try {
    const existing = await pbGet('/api/collections/app_config').catch(() => null);
    if (!existing?.id) {
      await pbPost('/api/collections', {
        name: 'app_config', type: 'base',
        schema: [
          { name: 'current_version',      type: 'text', required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'min_required_version', type: 'text', required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'play_store_url',       type: 'text', required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'update_message',       type: 'text', required: false, options: { min: null, max: null, pattern: '' } },
        ],
        listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null,
      });
      console.log('[app_config] Created app_config ✓');
    } else {
      console.log('[app_config] app_config ✓');
    }

    // Seed the single config row ONCE. NEVER overwrite — the admin edits
    // min_required_version directly in PB to trigger the force update, and a
    // server restart must not reset it back to the safe default.
    const recs = await pbGet('/api/collections/app_config/records?perPage=1');
    if (!recs?.items?.length) {
      await pbPost('/api/collections/app_config/records', {
        current_version:      '1.0.2',
        min_required_version: '1.0.1', // SAFE: matches the live build so nobody is locked out
        play_store_url:       'https://play.google.com/store/apps/details?id=com.hanzalasha.shibmine',
        update_message:       'A critical new update is available. Please update to continue playing!',
      });
      console.log('[app_config] Seeded app_config row (min_required_version=1.0.1) ✓');
    }
  } catch (e: any) {
    console.warn('[app_config] ensureAppConfigCollection:', e.message);
  }
}

// ── announcements (Banner Modal) collection ────────────────────────────────
// Admin-managed banner popups. Public read so the APK can fetch without auth.
async function ensureAnnouncementsCollection(): Promise<void> {
  try {
    const existing = await pbGet('/api/collections/announcements').catch(() => null);
    if (!existing?.id) {
      await pbPost('/api/collections', {
        name: 'announcements', type: 'base',
        schema: [
          { name: 'poster_image',    type: 'file',   required: false, options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ['image/jpeg','image/png','image/webp','image/gif'], thumbs: [], protected: false } },
          { name: 'redirect_url',    type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
          { name: 'frequency_limit', type: 'number', required: false, options: { min: 0, max: null } },
          { name: 'is_active',       type: 'bool',   required: false },
        ],
        listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null,
      });
      console.log('[announcements] Created announcements ✓');
    } else {
      // Ensure public read + admin-only writes on every boot (re-lock in case a
      // pre-existing collection was created with permissive write rules).
      await pbPatch(`/api/collections/${existing.id}`, {
        listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null,
      }).catch(() => {});
      console.log('[announcements] announcements ✓');
    }
  } catch (e: any) {
    console.warn('[announcements] ensureAnnouncementsCollection:', e.message);
  }
}

// ── Daily reward collections (unchanged from original) ─────────────────────

async function ensureDailyClaimSettingsCollection(): Promise<void> {
  try {
    const existing = await pbGet('/api/collections/daily_claim_settings');
    if (existing?.id) { console.log('[daily] daily_claim_settings ✓'); return; }
    const fileOpts = { maxSelect: 1, maxSize: 5242880, mimeTypes: ['image/jpeg','image/png','image/webp','image/gif'], thumbs: [], protected: false };
    await pbPost('/api/collections', {
      name: 'daily_claim_settings', type: 'base',
      schema: [
        { name: 'day_1_image',         type: 'file',   required: false, options: fileOpts },
        { name: 'day_1_amount',         type: 'number', required: false, options: { min: null, max: null } },
        { name: 'day_2_image',         type: 'file',   required: false, options: fileOpts },
        { name: 'day_2_amount',         type: 'number', required: false, options: { min: null, max: null } },
        { name: 'day_3_image',         type: 'file',   required: false, options: fileOpts },
        { name: 'day_3_amount',         type: 'number', required: false, options: { min: null, max: null } },
        { name: 'day_4_image',         type: 'file',   required: false, options: fileOpts },
        { name: 'day_4_amount',         type: 'number', required: false, options: { min: null, max: null } },
        { name: 'day_5_image',         type: 'file',   required: false, options: fileOpts },
        { name: 'day_5_amount',         type: 'number', required: false, options: { min: null, max: null } },
        { name: 'day_6_image',         type: 'file',   required: false, options: fileOpts },
        { name: 'day_6_amount',         type: 'number', required: false, options: { min: null, max: null } },
        { name: 'day_7_shiba_image',   type: 'file',   required: false, options: fileOpts },
        { name: 'day_7_shiba_amount',  type: 'number', required: false, options: { min: null, max: null } },
        { name: 'day_7_power_image',   type: 'file',   required: false, options: fileOpts },
        { name: 'day_7_power_amount',  type: 'number', required: false, options: { min: null, max: null } },
      ],
      listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null,
    });
    await pbPost('/api/collections/daily_claim_settings/records', {
      day_1_amount: 1000, day_2_amount: 50,  day_3_amount: 3000, day_4_amount: 100,
      day_5_amount: 5000, day_6_amount: 200, day_7_shiba_amount: 10000, day_7_power_amount: 500,
    });
    console.log('[daily] daily_claim_settings seeded ✓');
  } catch (e: any) { console.warn('[daily] ensureDailyClaimSettingsCollection:', e.message); }
}

async function ensureDailyClaimsCollection(): Promise<void> {
  try {
    const existing = await pbGet('/api/collections/daily_claims');
    if (existing?.id) {
      try { await pbPatch(`/api/collections/${existing.id}`, { createRule: '@request.auth.id != ""' }); } catch {}
      console.log('[daily] daily_claims ✓');
      return;
    }
    await pbPost('/api/collections', {
      name: 'daily_claims', type: 'base',
      schema: [
        { name: 'user_id',     type: 'text',   required: true,  options: { min: null, max: null, pattern: '' } },
        { name: 'day_number',  type: 'number', required: true,  options: { min: 1, max: 7 } },
        { name: 'reward_shib', type: 'number', required: false, options: { min: null, max: null } },
        { name: 'reward_pt',   type: 'number', required: false, options: { min: null, max: null } },
      ],
      listRule: null, viewRule: null, createRule: '@request.auth.id != ""', updateRule: null, deleteRule: null,
    });
    console.log('[daily] daily_claims created ✓');
  } catch (e: any) { console.warn('[daily] ensureDailyClaimsCollection:', e.message); }
}

// ── Public: Server-side point sync (ANTI-CHEAT) ────────────────────────────
/**
 * Reads all mining_sessions for `pbId` that were claimed during the current
 * tournament week, sums their claimed_amount, and atomically writes the result
 * to users.weekly_tournament_points.
 *
 * Called by the Express route POST /api/app/tournament/sync-points/:pbId after
 * each mining claim. The client NEVER pushes points directly.
 */
export async function syncUserTournamentPoints(pbId: string): Promise<number> {
  try {
    // 1. Get current tournament config — need week start time + active status
    const cfgRes = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
    const cfg    = cfgRes?.items?.[0];
    if (!cfg) return 0;

    // 2. Check user is participating
    const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,tournament_joined,shib_balance`);
    if (!user?.id || !user.tournament_joined) return 0;

    // 3. Determine week start — prefer start_time, fall back to week_start
    const weekStart = cfg.start_time || cfg.week_start;
    if (!weekStart) return 0;

    // 4. Sum every session CLAIMED during this cycle. Three things baked in (must
    //    stay identical to the client helper syncTournamentPointsToPb in lib/api.ts):
    //    (a) key off `updated` (claim-time) NOT `start_time`, so a session started
    //        before the cycle but claimed inside it still scores;
    //    (b) PB datetime filters need a SPACE separator, not the ISO `T`. The config
    //        stores start_time as text with a `T`, which matched zero rows → points 0;
    //    (c) upper-bound `updated < end_time` (only when valid) so a claim landing
    //        after the cycle ends (clock skew / payout lag) isn't miscounted into it.
    const weekStartFilter = weekStart.replace('T', ' ');
    const endMs = cfg.end_time ? new Date(cfg.end_time).getTime() : NaN;
    const endClause = Number.isFinite(endMs)
      ? ` && updated < "${String(cfg.end_time).replace('T', ' ')}"`
      : '';
    const filter = encodeURIComponent(
      `user = "${pbId}" && claimed_amount > 0 && updated >= "${weekStartFilter}"${endClause}`,
    );
    const sessRes = await pbGet(
      `/api/collections/mining_sessions/records?filter=${filter}&perPage=500&fields=claimed_amount`,
    );
    const sessions: any[] = sessRes?.items ?? [];
    const totalPoints = sessions.reduce((sum, s) => sum + (Number(s.claimed_amount) || 0), 0);

    // 5. Atomically write back — server is the single source of truth
    await pbPatch(`/api/collections/users/records/${pbId}`, {
      weekly_tournament_points: totalPoints,
    });

    // 5b. Mirror into the user's tournament_participants row so the column the admin
    //     panel / DB shows matches the leaderboard. Secondary/cosmetic — leaderboard +
    //     winners read users.weekly_tournament_points. runEndOfCycle wipes participant
    //     rows each cycle, so each user has exactly one row per cycle → match by user_id.
    try {
      const pRes = await pbGet(
        `/api/collections/tournament_participants/records?filter=${encodeURIComponent(
          `user_id = "${pbId}"`,
        )}&sort=-created&perPage=1`,
      );
      const participant = pRes?.items?.[0];
      if (participant?.id) {
        await pbPatch(`/api/collections/tournament_participants/records/${participant.id}`, {
          points: totalPoints,
        });
      }
    } catch (e: any) {
      console.warn('[tournament] participant points mirror failed:', e?.message);
    }

    console.log(`[tournament] sync-points ${pbId}: ${sessions.length} sessions → ${totalPoints.toFixed(2)} pts`);
    return totalPoints;
  } catch (e: any) {
    console.warn('[tournament] syncUserTournamentPoints error:', e.message);
    return 0;
  }
}

// ── Public: End-of-cycle finalization ─────────────────────────────────────
/**
 * Runs when a manual cycle's end_time passes (reconciler timer/poll or boot
 * catch-up). Fully-manual model — NO calendar logic:
 * 1. Immediately sets is_active=false (freeze the tournament).
 * 2. Distributes prizes to top N users atomically.
 * 3. Exports winners to tournament_history (permanent record).
 * 4. Resets all participants' points + joined flags.
 * 5. Wipes tournament_participants.
 * 6. STAYS inactive — no next cycle is auto-created. The leaderboard shows the
 *    red "Tournament will start soon" state until the admin launches a new one.
 *
 * Payout is locked to the config's `cycle_id`: it can NEVER pay twice for the
 * same cycle, no matter how many times this runs (timer + poll + boot races).
 */
// In-process concurrency lock. Callers (reconciler timer, 60s poll, boot
// catch-up) all run inside this single Node process. Serializing them here makes
// the payout finalization atomic: two overlapping runs can NEVER both pass the
// marker check before it is written, so winners can never be double-credited.
let endOfCycleInFlight: Promise<void> | null = null;

export async function runEndOfCycle(): Promise<void> {
  if (endOfCycleInFlight) {
    console.log('[tournament] runEndOfCycle already running — joining in-flight run (concurrency lock) ✓');
    return endOfCycleInFlight;
  }
  endOfCycleInFlight = runEndOfCycleImpl().finally(() => { endOfCycleInFlight = null; });
  return endOfCycleInFlight;
}

async function runEndOfCycleImpl(): Promise<void> {
  console.log('[tournament] ── Running end-of-cycle: freeze → payout → history → reset → wipe ──');

  // 1. Load config (hard requirement — without it there is nothing to finalize)
  let cfg: any;
  try {
    const cfgRes = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
    cfg = cfgRes?.items?.[0];
  } catch (e: any) {
    console.error('[tournament] runEndOfCycle: could not load config:', e.message);
  }
  if (!cfg) { console.log('[tournament] No config — skipping.'); return; }

  // 2. Freeze immediately — any new mining claims won't count. Best-effort: even
  //    if the freeze write fails we still proceed to the participant wipe below.
  try {
    await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, { is_active: false });
    console.log('[tournament] Frozen (is_active=false) ✓');
  } catch (e: any) {
    console.error('[tournament] runEndOfCycle: freeze failed (continuing):', e.message);
  }

  // 3-6. Payout + history — guarded by a ONE-TIME finalization lock so the same
  //      cycle can NEVER be paid twice (a retry, or an overlapping timer/poll
  //      run). The lock is a self-contained check on tournament_config — it does
  //      NOT touch points calculation, mining tracking, the participant wipe, or
  //      any DB hook. Still wrapped in try/catch so a failure here can never skip
  //      the participant wipe (steps 7-8).
  //
  //      Cycle key = the config's unique `cycle_id` (manual model). Each admin
  //      launch mints a fresh cycle_id, so storing the PAID cycle_id naturally
  //      re-arms payout for the next cycle with no separate reset step. Legacy
  //      configs with no cycle_id fall back to the start_time-derived key.
  const cycleKey         = cycleKeyOf(cfg);
  const alreadyFinalized = !!cycleKey && cfg.payout_finalized_cycle === cycleKey;

  if (alreadyFinalized) {
    console.log(`[tournament] Payout already finalized for cycle ${cycleKey} — skipping distribution (double-credit guard) ✓`);
  } else {
    try {
      let rewardMap: Record<string, number> = {};
      try { rewardMap = JSON.parse(cfg.reward_structure || '{}'); } catch {}
      const winnersCount = Math.max(Number(cfg.winners_count) || 3, 1);

      const filter  = encodeURIComponent('tournament_joined=true&&weekly_tournament_points>0');
      const perPage = Math.min(Math.max(winnersCount, 10), 100);
      const usersRes = await pbGet(
        `/api/collections/users/records?sort=-weekly_tournament_points&filter=${filter}&perPage=${perPage}&fields=id,display_name,weekly_tournament_points,shib_balance`,
      );
      const topUsers: any[] = (usersRes?.items ?? []).slice(0, winnersCount);
      const weekEnd = new Date().toISOString();

      for (let i = 0; i < topUsers.length; i++) {
        const u     = topUsers[i];
        const rank  = i + 1;
        const prize = Number(rewardMap[String(rank)]) || 0;
        await pbPost('/api/collections/tournament_history/records', {
          week_end:     weekEnd,
          rank,
          user_id:      u.id,
          display_name: u.display_name || 'Miner',
          points:       Number(u.weekly_tournament_points) || 0,
          prize,
        }).catch(() => {}); // non-fatal
      }
      console.log(`[tournament] History exported: ${topUsers.length} winners ✓`);

      for (let i = 0; i < topUsers.length; i++) {
        const u     = topUsers[i];
        const prize = Number(rewardMap[String(i + 1)]) || 0;
        if (prize > 0) {
          await pbPatch(`/api/collections/users/records/${u.id}`, {
            shib_balance: (Number(u.shib_balance) || 0) + prize,
          });
          console.log(`[tournament] Rank #${i + 1} (${u.display_name || u.id}): +${prize.toLocaleString()} SHIB`);
        }
      }

      // Loop completed successfully → commit the finalization lock immediately.
      // From this instant any re-entry for this cycle short-circuits above, so
      // winners can never be credited a second time.
      if (cycleKey) {
        await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, {
          payout_finalized_cycle:  cycleKey,
          payout_finalized_bucket: cycleKey, // keep legacy field mirrored
        });
        console.log(`[tournament] Payout finalized + locked for cycle ${cycleKey} ✓`);
      } else {
        console.warn('[tournament] Payout ran but cycle key was unresolvable — lock NOT written (config missing cycle_id/start_time).');
      }
    } catch (e: any) {
      console.error('[tournament] runEndOfCycle payout/history error (continuing to cleanup):', e.message);
    }
  }

  // 7. Reset ALL joined users (best-effort — must not abort the wipe)
  try {
    let page = 1;
    while (true) {
      const batch = await pbGet(
        `/api/collections/users/records?filter=${encodeURIComponent('tournament_joined=true')}&perPage=100&page=${page}&fields=id`,
      );
      const items: any[] = batch?.items ?? [];
      if (!items.length) break;
      await Promise.allSettled(items.map((u: any) =>
        pbPatch(`/api/collections/users/records/${u.id}`, {
          tournament_joined: false,
          weekly_tournament_points: 0,
        }),
      ));
      if (items.length < 100) break;
      page++;
    }
    console.log('[tournament] All points + joined flags reset ✓');
  } catch (e: any) {
    console.error('[tournament] runEndOfCycle reset error (continuing to wipe):', e.message);
  }

  // 8. ALWAYS wipe tournament_participants — the user-critical guarantee that
  //    the next cycle starts with a 100% empty participant set.
  try {
    const wiped = await wipeAllParticipants();
    console.log(`[tournament] Participants wiped: ${wiped} ✓`);
  } catch (e: any) {
    console.error('[tournament] runEndOfCycle participant wipe error:', e.message);
  }

  console.log('[tournament] ── End-of-cycle complete — staying INACTIVE until admin launches next cycle ──');
}

// ── Dynamic end-of-cycle reconciler ───────────────────────────────────────
// Fully-manual model: there is NO calendar cron. The single source of truth is
// the active config's `end_time`. The reconciler:
//   • backfills a cycle_id onto a live cycle that predates this migration,
//   • runs runEndOfCycle immediately if end_time has already passed,
//   • otherwise arms a single precise (capped) timer for the exact end moment.
// A 60s poll re-runs this so an admin-started cycle (written straight to PB,
// out-of-process) is always picked up without a restart.

const MAX_TIMEOUT_MS = 2_000_000_000; // ~23 days — setTimeout 32-bit cap guard
let cycleEndTimer: ReturnType<typeof setTimeout> | null = null;
let armedEndMs: number | null = null;

async function reconcileCycleSchedule(): Promise<void> {
  let cfg: any;
  try {
    const cfgRes = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
    cfg = cfgRes?.items?.[0];
  } catch (e: any) {
    console.warn('[tournament] reconcile: could not load config:', e?.message);
    return;
  }

  // No config at all → nothing to schedule. Clear any stale timer.
  if (!cfg) {
    if (cycleEndTimer) { clearTimeout(cycleEndTimer); cycleEndTimer = null; armedEndMs = null; }
    return;
  }

  // Inactive config. Normally this is the steady "no tournament" state, BUT it can
  // also be a cycle whose finalization was interrupted AFTER the freeze step
  // (is_active was set false first, then payout/reset/wipe failed). Because
  // runEndOfCycle freezes before paying, we must retry independent of is_active or
  // the cycle could be left unpaid/uncleared forever. Retry when EITHER:
  //   • payout was never committed for this cycle_id (payout_finalized_cycle mismatch), OR
  //   • participants still exist (a prior wipe didn't complete).
  // runEndOfCycle is idempotent (payout is cycle_id-locked), so a retry never
  // double-pays — it just completes whatever step was missed.
  if (!cfg.is_active) {
    if (cycleEndTimer) { clearTimeout(cycleEndTimer); cycleEndTimer = null; armedEndMs = null; }
    // Scope the retry to manual-model cycles (cycle_id minted at launch). A legacy
    // pre-migration config has no cycle_id; never auto-finalize it here (its stale
    // participant rows must not trigger an unintended payout — the old weekly path
    // owned that).
    if (cfg.cycle_id) {
      const unfinalizedPayout = cfg.payout_finalized_cycle !== cfg.cycle_id;
      let leftoverParticipants = false;
      try { leftoverParticipants = await anyParticipantsExist(); } catch {}
      if (unfinalizedPayout || leftoverParticipants) {
        console.log(
          `[tournament] reconcile: detected interrupted finalization (unfinalizedPayout=${unfinalizedPayout}, leftoverParticipants=${leftoverParticipants}) — retrying runEndOfCycle.`,
        );
        await runEndOfCycle();
      }
    }
    return;
  }

  // Backfill a permanent cycle_id onto a live cycle that has none (pre-migration
  // record), so its payout lock has a stable key.
  if (!cfg.cycle_id) {
    const newId = generateCycleId();
    try {
      await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, { cycle_id: newId });
      cfg.cycle_id = newId;
      console.log(`[tournament] reconcile: backfilled cycle_id ${newId} onto live cycle ✓`);
    } catch (e: any) {
      console.warn('[tournament] reconcile: cycle_id backfill failed:', e?.message);
    }
  }

  const endMs = cfg.end_time ? new Date(cfg.end_time).getTime() : NaN;
  if (!Number.isFinite(endMs)) {
    // Active cycle with no/invalid end_time → cannot auto-finalize. Leave it to
    // the admin "End now" control. Do not guess a calendar end.
    if (cycleEndTimer) { clearTimeout(cycleEndTimer); cycleEndTimer = null; armedEndMs = null; }
    console.warn('[tournament] reconcile: active cycle has no valid end_time — no auto-end armed.');
    return;
  }

  const now = Date.now();
  if (now >= endMs) {
    console.log('[tournament] reconcile: end_time reached — finalizing cycle now.');
    if (cycleEndTimer) { clearTimeout(cycleEndTimer); cycleEndTimer = null; armedEndMs = null; }
    await runEndOfCycle();
    return;
  }

  // Future end — (re)arm a precise timer if the target moved or none is armed.
  if (armedEndMs === endMs && cycleEndTimer) return; // already armed for this end
  if (cycleEndTimer) { clearTimeout(cycleEndTimer); cycleEndTimer = null; }
  const delay = Math.min(endMs - now, MAX_TIMEOUT_MS);
  armedEndMs = endMs;
  cycleEndTimer = setTimeout(() => {
    cycleEndTimer = null; armedEndMs = null;
    // Re-reconcile rather than blindly finalizing: handles the capped-delay
    // case (re-arms for the remaining time) and confirms the cycle is still due.
    reconcileCycleSchedule().catch((e) =>
      console.warn('[tournament] reconcile (timer) error:', e?.message));
  }, delay);
  const hrs = (endMs - now) / 3_600_000;
  console.log(`[tournament] reconcile: cycle "${cfg.cycle_id}" ends in ~${hrs.toFixed(1)}h (${new Date(endMs).toUTCString()})${delay < endMs - now ? ' [capped — will re-arm]' : ''}`);
}

export function startTournamentCron(): void {
  // Delay 15s after server boot so PB auth + DB are warm, then reconcile once
  // (boot catch-up) and poll every 60s to pick up admin-started cycles.
  setTimeout(() => {
    reconcileCycleSchedule().catch((e) =>
      console.warn('[tournament] reconcile (boot) error:', e?.message));
    setInterval(() => {
      reconcileCycleSchedule().catch((e) =>
        console.warn('[tournament] reconcile (poll) error:', e?.message));
    }, 60_000);
  }, 15_000);
  console.log('[tournament] Manual-cycle reconciler armed (boot in 15s, poll every 60s) ✓');
}
