/**
 * tournament.ts — Zero-Trust Weekly Tournament
 *
 * Security model:
 *  - Points are NEVER accepted from the client. The server reads mining_sessions
 *    directly and computes each user's weekly points atomically.
 *  - Two calendar-precise crons (not relative timers):
 *      Cron A: Sunday 18:00 UTC  — freeze, payout, export history, wipe participants
 *      Cron B: Monday 00:00 UTC  — create new week, set is_active=true
 *  - Intermission = is_active=false window between Sunday 6PM and Monday 12AM
 *
 * Exports:
 *  setupTournamentSchema()      — idempotent schema creation on server boot
 *  syncUserTournamentPoints()   — server-side point recalculation from mining_sessions
 *  runEndOfWeek()               — freeze + prize payout + history export
 *  startNewTournamentWeek()     — activate next week with fresh start/end times
 *  startTournamentCron()        — schedules both calendar-aligned crons
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

// ── Calendar helpers ────────────────────────────────────────────────────────

/** Returns the next UTC Sunday at 18:00:00 (tournament end / freeze time) */
function nextSunday6PM(): Date {
  const now = new Date();
  // UTC day: 0=Sunday … 6=Saturday
  const daysUntil = (7 - now.getUTCDay()) % 7; // 0 if today is Sunday
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil,
    18, 0, 0, 0,
  ));
  // If the candidate is in the past (today is Sunday but already past 6PM), go +7 days
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate;
}

/** Returns the next UTC Monday at 00:00:00 (new week start time) */
function nextMonday12AM(): Date {
  const now  = new Date();
  const day  = now.getUTCDay(); // 1=Monday
  const daysUntil = day === 1 ? 0 : (8 - day) % 7;
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil,
    0, 0, 0, 0,
  ));
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate;
}

function msUntil(target: Date): number {
  return Math.max(target.getTime() - Date.now(), 60_000); // min 60s buffer
}

// ── Participant cleanup helpers ─────────────────────────────────────────────

/**
 * UTC ms of the Monday 00:00 of the ISO-week containing `iso`. Mirrors the
 * client's cycleBucket() EXACTLY so server-side cleanup uses the same per-cycle
 * "bucket" the leaderboard registration gate uses. This is what makes cleanup
 * safe: a FUTURE cycle's intermission pre-registrations live in a later bucket
 * and are therefore never deleted. Returns NaN for missing/invalid input.
 */
function mondayBucketMs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return NaN;
  const day  = d.getUTCDay();           // 0=Sun … 1=Mon
  const back = day === 0 ? 6 : day - 1; // days since Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

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

/**
 * Deletes ONLY participant rows whose cycle bucket is strictly older than
 * `thresholdBucketMs` (or older-or-equal when `inclusive`). Bucket-aware, so a
 * future cycle's pre-registrations (the intermission carry-over the registration
 * gate relies on) are NEVER touched. Rows with an unparseable week_start are
 * skipped on purpose (left for the freeze-time wipeAllParticipants). Reads all
 * matching ids first, then deletes. Returns the count removed.
 */
async function cleanStaleParticipants(thresholdBucketMs: number, inclusive = false): Promise<number> {
  if (!Number.isFinite(thresholdBucketMs)) return 0;
  const staleIds: string[] = [];
  let page = 1;
  while (true) {
    const batch = await pbGet(`/api/collections/tournament_participants/records?perPage=200&page=${page}&fields=id,week_start`).catch(() => null);
    const items: any[] = batch?.items ?? [];
    if (!items.length) break;
    for (const r of items) {
      const b = mondayBucketMs(r.week_start);
      if (!Number.isFinite(b)) continue; // conservative: never delete unparseable rows
      if (inclusive ? b <= thresholdBucketMs : b < thresholdBucketMs) staleIds.push(r.id);
    }
    if (items.length < 200) break;
    page++;
  }
  for (const id of staleIds) {
    await pbDelete(`/api/collections/tournament_participants/records/${id}`).catch(() => {});
  }
  if (staleIds.length) {
    console.log(`[tournament] Stale participants cleaned: ${staleIds.length} (bucket ${inclusive ? '<=' : '<'} ${new Date(thresholdBucketMs).toISOString().slice(0, 10)}) ✓`);
  }
  return staleIds.length;
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
        ],
        listRule: '', viewRule: '', createRule: null, updateRule: null, deleteRule: null,
      });
      const now = new Date();
      const endTime = nextSunday6PM();
      await pbPost('/api/collections/tournament_config/records', {
        prize_pool_total: 500000, winners_count: 3,
        reward_structure: JSON.stringify({ '1': 250000, '2': 150000, '3': 100000 }),
        week_start: now.toISOString(), start_time: now.toISOString(),
        end_time: endTime.toISOString(), is_active: true,
      });
      console.log('[tournament] tournament_config seeded — ends', endTime.toUTCString());
    } else {
      // Ensure new fields exist on existing collection
      await ensureField('tournament_config', 'start_time', userTextOpt);
      await ensureField('tournament_config', 'end_time',   userTextOpt);
      await ensureField('tournament_config', 'banner',     { type: 'file', required: false, options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ['image/jpeg','image/png','image/gif','image/webp'], thumbs: [], protected: false } });
      await ensureField('tournament_config', 'payout_finalized_bucket', userTextOpt);

      // Back-fill end_time if missing on existing config record
      const recs = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
      const rec  = recs?.items?.[0];
      if (rec && !rec.end_time) {
        const endTime = nextSunday6PM();
        await pbPatch(`/api/collections/tournament_config/records/${rec.id}`, {
          start_time: rec.week_start || new Date().toISOString(),
          end_time:   endTime.toISOString(),
        });
        console.log('[tournament] Back-filled end_time on existing config ✓');
      }
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

    // 4. Sum all claimed sessions for this user since week_start
    //    PB relation filter: user = "pbId" (direct ID match on the relation field)
    const filter = encodeURIComponent(
      `user = "${pbId}" && claimed_amount > 0 && start_time >= "${weekStart}"`,
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
    //     winners read users.weekly_tournament_points. runEndOfWeek wipes participant
    //     rows weekly, so each user has exactly one row per week → match by user_id.
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

// ── Public: End-of-week (Sunday 18:00 UTC) ────────────────────────────────
/**
 * Called by Cron A (Sunday 18:00 UTC).
 * 1. Immediately sets is_active=false (freeze the tournament).
 * 2. Distributes prizes to top N users atomically.
 * 3. Exports winners to tournament_history (permanent record).
 * 4. Resets all participants' points + joined flags.
 * 5. Wipes tournament_participants ready for next-week registration.
 */
// In-process concurrency lock. The ONLY callers of runEndOfWeek are the Sunday
// freeze cron and the boot catch-up — both run inside this single Node process
// (the admin "start" path writes tournament_config directly via PB and never
// calls this). Serializing them here makes the payout finalization atomic: two
// overlapping runs can NEVER both pass the marker check before it is written, so
// winners can never be double-credited even under a cron + manual-trigger race.
let endOfWeekInFlight: Promise<void> | null = null;

export async function runEndOfWeek(): Promise<void> {
  if (endOfWeekInFlight) {
    console.log('[tournament] runEndOfWeek already running — joining in-flight run (concurrency lock) ✓');
    return endOfWeekInFlight;
  }
  endOfWeekInFlight = runEndOfWeekImpl().finally(() => { endOfWeekInFlight = null; });
  return endOfWeekInFlight;
}

async function runEndOfWeekImpl(): Promise<void> {
  console.log('[tournament] ── Running end-of-week: freeze → payout → history → reset ──');

  // 1. Load config (hard requirement — without it there is nothing to finalize)
  let cfg: any;
  try {
    const cfgRes = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
    cfg = cfgRes?.items?.[0];
  } catch (e: any) {
    console.error('[tournament] runEndOfWeek: could not load config:', e.message);
  }
  if (!cfg) { console.log('[tournament] No config — skipping.'); return; }

  // 2. Freeze immediately — any new mining claims won't count. Best-effort: even
  //    if the freeze write fails we still proceed to the participant wipe below.
  try {
    await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, { is_active: false });
    console.log('[tournament] Frozen (is_active=false) ✓');
  } catch (e: any) {
    console.error('[tournament] runEndOfWeek: freeze failed (continuing):', e.message);
  }

  // 3-6. Payout + history — guarded by a ONE-TIME finalization lock so the same
  //      cycle can NEVER be paid twice (a retry, or an overlapping cron/manual
  //      run). The lock is a self-contained check on tournament_config — it does
  //      NOT touch points calculation, mining tracking, the participant wipe, or
  //      any DB hook. Still wrapped in try/catch so a failure here can never skip
  //      the participant wipe (steps 7-8).
  //
  //      Cycle key = the UTC ISO-week Monday of this config's start_time, i.e.
  //      the same per-cycle "bucket" the rest of the tournament already uses.
  //      Storing the PAID bucket string (not a plain bool) means next week's
  //      different bucket naturally re-arms payout with no separate reset step.
  const cycleBucketMs    = mondayBucketMs(cfg.start_time || cfg.week_start);
  const cycleKey         = Number.isFinite(cycleBucketMs)
    ? new Date(cycleBucketMs).toISOString().slice(0, 10)
    : '';
  const alreadyFinalized = !!cycleKey && cfg.payout_finalized_bucket === cycleKey;

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
          payout_finalized_bucket: cycleKey,
        });
        console.log(`[tournament] Payout finalized + locked for cycle ${cycleKey} ✓`);
      } else {
        console.warn('[tournament] Payout ran but cycle key was unresolvable — lock NOT written (config missing start_time/week_start).');
      }
    } catch (e: any) {
      console.error('[tournament] runEndOfWeek payout/history error (continuing to cleanup):', e.message);
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
    console.error('[tournament] runEndOfWeek reset error (continuing to wipe):', e.message);
  }

  // 8. ALWAYS wipe tournament_participants — the user-critical guarantee that
  //    the next cycle starts with a 100% empty participant set.
  try {
    const wiped = await wipeAllParticipants();
    console.log(`[tournament] Participants wiped: ${wiped} ✓`);
  } catch (e: any) {
    console.error('[tournament] runEndOfWeek participant wipe error:', e.message);
  }

  console.log('[tournament] ── End-of-week complete ──');
}

// ── Public: New week (Monday 00:00 UTC) ───────────────────────────────────
/**
 * Called by Cron B (Monday 00:00 UTC).
 * Sets is_active=true, updates start_time + end_time for the new week.
 */
export async function startNewTournamentWeek(): Promise<void> {
  console.log('[tournament] Starting new tournament week...');
  try {
    const now     = new Date();
    const endTime = nextSunday6PM(); // This Sunday coming up at 18:00 UTC

    const cfgRes = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
    const cfg    = cfgRes?.items?.[0];

    if (cfg) {
      await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, {
        is_active:  true,
        start_time: now.toISOString(),
        week_start: now.toISOString(), // keep week_start in sync for legacy code
        end_time:   endTime.toISOString(),
      });
    } else {
      await pbPost('/api/collections/tournament_config/records', {
        prize_pool_total: 500000, winners_count: 3,
        reward_structure: JSON.stringify({ '1': 250000, '2': 150000, '3': 100000 }),
        is_active: true, start_time: now.toISOString(),
        week_start: now.toISOString(), end_time: endTime.toISOString(),
      });
    }
    console.log(`[tournament] New week live — ends ${endTime.toUTCString()} ✓`);

    // Defensive cross-cycle cleanup: now that this week is the active cycle,
    // delete any participant rows left over from STRICTLY OLDER cycles (e.g. a
    // prior cycle whose freeze-wipe failed, or an admin-restarted window). This
    // is bucket-aware (strictly-older only) so intermission pre-registrations
    // for THIS new week — same bucket — are preserved.
    await cleanStaleParticipants(mondayBucketMs(now.toISOString()), false);
  } catch (e: any) {
    console.error('[tournament] startNewTournamentWeek error:', e.message);
  }
}

// ── Public: dual calendar-aligned crons ───────────────────────────────────

function scheduleSunday6PMCron(): void {
  const target = nextSunday6PM();
  const ms     = msUntil(target);
  console.log(`[tournament] CRON-FREEZE: Sunday 6PM in ~${Math.round(ms / 3_600_000)}h (${target.toUTCString()})`);
  setTimeout(async () => {
    await runEndOfWeek();
    scheduleSunday6PMCron(); // reschedule for next Sunday
  }, ms);
}

function scheduleMonday12AMCron(): void {
  const target = nextMonday12AM();
  const ms     = msUntil(target);
  console.log(`[tournament] CRON-RESET:  Monday 12AM in ~${Math.round(ms / 3_600_000)}h (${target.toUTCString()})`);
  setTimeout(async () => {
    await startNewTournamentWeek();
    scheduleMonday12AMCron(); // reschedule for next Monday
  }, ms);
}

export function startTournamentCron(): void {
  // Delay 15s after server boot so PB auth + DB are warm
  setTimeout(async () => {
    try {
      // ── Catch-up check: if end_time passed while server was down ──────
      const cfgRes = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
      const cfg    = cfgRes?.items?.[0];

      if (cfg) {
        const endTime = cfg.end_time ? new Date(cfg.end_time).getTime() : 0;
        const now     = Date.now();

        if (endTime > 0 && now > endTime && cfg.is_active) {
          console.log('[tournament] CRON: missed end-of-week during downtime — running catch-up now.');
          await runEndOfWeek();
        } else if (endTime > 0 && now > endTime && !cfg.is_active) {
          // Already frozen but the cycle has ended — recover any participant rows
          // that were orphaned (e.g. a freeze whose wipe failed, or an admin who
          // manually ended the window). Bucket-aware + inclusive: removes this
          // ended cycle's rows AND older, but NEVER a future (intermission)
          // cycle's pre-registrations.
          const cleaned = await cleanStaleParticipants(
            mondayBucketMs(cfg.start_time || cfg.week_start), true,
          );
          if (cleaned) console.log(`[tournament] CRON: recovered ${cleaned} orphaned participant row(s) from an ended cycle ✓`);
        } else if (endTime === 0) {
          // Legacy config without end_time — back-fill it
          const newEnd = nextSunday6PM();
          await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, {
            start_time: cfg.week_start || new Date().toISOString(),
            end_time:   newEnd.toISOString(),
          });
          console.log('[tournament] CRON: back-filled end_time ✓');
        }
      }
    } catch (e: any) {
      console.warn('[tournament] CRON startup check error:', e.message);
    }

    // ── Schedule both calendar-aligned crons ─────────────────────────────
    scheduleSunday6PMCron();
    scheduleMonday12AMCron();
  }, 15_000);
}
