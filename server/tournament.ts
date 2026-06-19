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
        listRule: '', viewRule: '', createRule: '@request.auth.id != ""', updateRule: null, deleteRule: null,
      });
      console.log('[tournament] tournament_participants created ✓');
    } else {
      await ensureField('tournament_participants', 'registered_during_intermission', userBoolOpt);
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
        current_version:      '1.0.1',
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
export async function runEndOfWeek(): Promise<void> {
  console.log('[tournament] ── Running end-of-week: freeze → payout → history → reset ──');
  try {
    // 1. Load config
    const cfgRes = await pbGet('/api/collections/tournament_config/records?sort=-created&perPage=1');
    const cfg    = cfgRes?.items?.[0];
    if (!cfg) { console.log('[tournament] No config — skipping.'); return; }

    // 2. Freeze immediately — any new mining claims won't count
    await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, { is_active: false });
    console.log('[tournament] Frozen (is_active=false) ✓');

    // 3. Load reward config
    let rewardMap: Record<string, number> = {};
    try { rewardMap = JSON.parse(cfg.reward_structure || '{}'); } catch {}
    const winnersCount = Math.max(Number(cfg.winners_count) || 3, 1);

    // 4. Fetch top players sorted by weekly_tournament_points
    const filter  = encodeURIComponent('tournament_joined=true&&weekly_tournament_points>0');
    const perPage = Math.min(Math.max(winnersCount, 10), 100);
    const usersRes = await pbGet(
      `/api/collections/users/records?sort=-weekly_tournament_points&filter=${filter}&perPage=${perPage}&fields=id,display_name,weekly_tournament_points,shib_balance`,
    );
    const topUsers: any[] = (usersRes?.items ?? []).slice(0, winnersCount);

    const weekEnd = new Date().toISOString();

    // 5. Export winners to tournament_history
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

    // 6. Distribute prizes atomically
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

    // 7. Reset ALL joined users in batches of 100
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

    // 8. Wipe tournament_participants
    let pPage = 1;
    while (true) {
      const pBatch = await pbGet(`/api/collections/tournament_participants/records?perPage=100&page=${pPage}&fields=id`);
      const pItems: any[] = pBatch?.items ?? [];
      if (!pItems.length) break;
      await Promise.allSettled(pItems.map((r: any) => pbDelete(`/api/collections/tournament_participants/records/${r.id}`)));
      if (pItems.length < 100) break;
      pPage++;
    }
    console.log('[tournament] Participants wiped ✓');

    console.log('[tournament] ── End-of-week complete ──');
  } catch (e: any) {
    console.error('[tournament] runEndOfWeek error:', e.message);
  }
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
