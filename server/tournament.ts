/**
 * tournament.ts — Weekly Tournament: Schema Setup + Prize Distribution CRON
 *
 * setupTournamentSchema() — Creates tournament_config collection + adds user fields
 * runWeeklyDistribution() — Distributes prizes, resets all points & joined flags
 * startTournamentCron()   — On startup, checks schedule and fires at correct time
 */

import https from 'node:https';
import http from 'node:http';

const PB_URL = 'https://api.webcod.in';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ── PocketBase HTTP helpers (self-contained, no shared state with routes.ts) ──
function pbHttp(
  method: string,
  path: string,
  body: object | null,
  token?: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (data) headers['Content-Length'] = String(Buffer.byteLength(data));

    const url = new URL(path, PB_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); }
        });
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('PB request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let _adminToken = '';
let _tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
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

async function pbGet(path: string): Promise<any> {
  const t = await getAdminToken();
  return pbHttp('GET', path, null, t);
}

async function pbPost(path: string, body: object): Promise<any> {
  const t = await getAdminToken();
  return pbHttp('POST', path, body, t);
}

async function pbPatch(path: string, body: object): Promise<any> {
  const t = await getAdminToken();
  return pbHttp('PATCH', path, body, t);
}

// ── Schema helpers ─────────────────────────────────────────────────────────

async function ensureCollectionField(
  collectionName: string,
  fieldName: string,
  fieldDef: object,
): Promise<void> {
  try {
    const col = await pbGet(`/api/collections/${collectionName}`);
    if (!col.id) return;
    const already = (col.schema || []).some((f: any) => f.name === fieldName);
    if (already) {
      console.log(`[tournament] ${collectionName}.${fieldName} already exists ✓`);
      return;
    }
    const updated = [...(col.schema || []), { name: fieldName, ...fieldDef }];
    await pbPatch(`/api/collections/${collectionName}`, { schema: updated });
    console.log(`[tournament] Added ${collectionName}.${fieldName} ✓`);
  } catch (e: any) {
    console.warn(`[tournament] ensureCollectionField ${fieldName}:`, e.message);
  }
}

async function ensureUserField(fieldName: string, fieldDef: object): Promise<void> {
  return ensureCollectionField('users', fieldName, fieldDef);
}

async function ensureTournamentParticipantsCollection(): Promise<void> {
  try {
    const existing = await pbGet('/api/collections/tournament_participants');
    if (existing.id) {
      console.log('[tournament] tournament_participants collection already exists ✓');
      return;
    }
    await pbPost('/api/collections', {
      name: 'tournament_participants',
      type: 'base',
      schema: [
        { name: 'user_id',      type: 'text',   required: true,  options: { min: null, max: null, pattern: '' } },
        { name: 'display_name', type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
        { name: 'week_start',   type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
        { name: 'joined_at',    type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
        { name: 'points',       type: 'number', required: false, options: { min: null, max: null } },
      ],
      listRule:   '',        // public read — admin can see all registrants
      viewRule:   '',
      createRule: '@request.auth.id != ""',  // any authenticated user can register
      updateRule: null,
      deleteRule: null,
    });
    console.log('[tournament] tournament_participants collection created ✓');
  } catch (e: any) {
    console.warn('[tournament] ensureTournamentParticipantsCollection:', e.message);
  }
}

// ── Public: schema setup ───────────────────────────────────────────────────

export async function setupTournamentSchema(): Promise<void> {
  try {
    // 1. Add tournament fields to users collection
    await ensureUserField('tournament_joined', {
      type: 'bool', required: false, options: {},
    });
    await ensureUserField('weekly_tournament_points', {
      type: 'number', required: false, options: { min: null, max: null },
    });

    // 2. Create / ensure tournament_config collection
    const existing = await pbGet('/api/collections/tournament_config');
    if (existing.id) {
      console.log('[tournament] tournament_config collection already exists ✓');
      await ensureCollectionField('tournament_config', 'banner', {
        type: 'file',
        required: false,
        options: {
          maxSelect: 1,
          maxSize: 10485760,
          mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
          thumbs: [],
          protected: false,
        },
      });
      // Also ensure tournament_participants exists before returning
      await ensureTournamentParticipantsCollection();
      return;
    }

    await pbPost('/api/collections', {
      name: 'tournament_config',
      type: 'base',
      schema: [
        { name: 'prize_pool_total', type: 'number', required: false, options: { min: null, max: null } },
        { name: 'winners_count',    type: 'number', required: false, options: { min: null, max: null } },
        { name: 'reward_structure', type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
        {
          name: 'banner', type: 'file', required: false,
          options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], thumbs: [], protected: false },
        },
        { name: 'week_start',       type: 'text',   required: false, options: { min: null, max: null, pattern: '' } },
        { name: 'is_active',        type: 'bool',   required: false, options: {} },
      ],
      listRule:   '',
      viewRule:   '',
      createRule: null,
      updateRule: null,
      deleteRule: null,
    });
    console.log('[tournament] tournament_config collection created ✓');

    // 3. Seed a default config record (no banner image yet — admin uploads one)
    await pbPost('/api/collections/tournament_config/records', {
      prize_pool_total: 500000,
      winners_count: 3,
      reward_structure: JSON.stringify({ '1': 250000, '2': 150000, '3': 100000 }),
      week_start: new Date().toISOString(),
      is_active: true,
    });
    console.log('[tournament] Default tournament config seeded ✓');

    // 4. Create tournament_participants collection for fresh installs too
    await ensureTournamentParticipantsCollection();
  } catch (e: any) {
    console.warn('[tournament] setupTournamentSchema error:', e.message);
  }
}

// ── Public: weekly prize distribution ─────────────────────────────────────

export async function runWeeklyDistribution(): Promise<void> {
  console.log('[tournament] Running weekly prize distribution...');
  try {
    // 1. Load config
    const cfgRes = await pbGet(
      '/api/collections/tournament_config/records?sort=-created&perPage=1',
    );
    const cfg = cfgRes.items?.[0];
    if (!cfg) { console.log('[tournament] No config found — skipping.'); return; }

    let rewardMap: Record<string, number> = {};
    try { rewardMap = JSON.parse(cfg.reward_structure || '{}'); } catch {}

    const winnersCount = Number(cfg.winners_count) || 3;

    // 2. Fetch top users sorted by weekly_tournament_points (only joined users)
    const filter = encodeURIComponent(
      'tournament_joined=true&&weekly_tournament_points>0',
    );
    const perPage = Math.min(Math.max(winnersCount, 10), 100);
    const usersRes = await pbGet(
      `/api/collections/users/records?sort=-weekly_tournament_points&filter=${filter}&perPage=${perPage}&fields=id,display_name,weekly_tournament_points,shib_balance`,
    );
    const topUsers = (usersRes.items || []).slice(0, winnersCount);

    // 3. Distribute prizes to winners
    for (let i = 0; i < topUsers.length; i++) {
      const u = topUsers[i];
      const rank = String(i + 1);
      const prize = Number(rewardMap[rank]) || 0;
      if (prize > 0) {
        await pbPatch(`/api/collections/users/records/${u.id}`, {
          shib_balance: (Number(u.shib_balance) || 0) + prize,
        });
        console.log(`[tournament] Rank #${rank} (${u.display_name || u.id}) +${prize.toLocaleString()} SHIB`);
      }
    }

    // 4. Reset all tournament-joined users in batches of 100
    let page = 1;
    while (true) {
      const joinedFilter = encodeURIComponent('tournament_joined=true');
      const batch = await pbGet(
        `/api/collections/users/records?filter=${joinedFilter}&perPage=100&page=${page}&fields=id`,
      );
      const items: any[] = batch.items || [];
      if (!items.length) break;

      await Promise.allSettled(
        items.map((u: any) =>
          pbPatch(`/api/collections/users/records/${u.id}`, {
            tournament_joined: false,
            weekly_tournament_points: 0,
          }),
        ),
      );

      if (items.length < 100) break;
      page++;
    }

    // 5. Bump week_start to now so the next cycle begins fresh
    await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, {
      week_start: new Date().toISOString(),
    });

    // 6. Wipe tournament_participants — delete all records for the completed week
    //    This resets the registrant list so the new week starts clean.
    try {
      const delToken = await getAdminToken();
      let pPage = 1;
      while (true) {
        const pBatch = await pbGet(
          `/api/collections/tournament_participants/records?perPage=100&page=${pPage}&fields=id`,
        );
        const pItems: any[] = pBatch.items || [];
        if (!pItems.length) break;
        await Promise.allSettled(
          pItems.map((r: any) =>
            pbHttp('DELETE', `/api/collections/tournament_participants/records/${r.id}`, null, delToken),
          ),
        );
        if (pItems.length < 100) break;
        pPage++;
      }
      console.log('[tournament] tournament_participants wiped for new week ✓');
    } catch (e: any) {
      console.warn('[tournament] participants wipe error (non-fatal):', e.message);
    }

    console.log(
      `[tournament] Distribution complete — ${topUsers.length} winners rewarded, all points reset.`,
    );
  } catch (e: any) {
    console.error('[tournament] runWeeklyDistribution error:', e.message);
  }
}

// ── Public: start the weekly CRON ─────────────────────────────────────────

function scheduleNext(delayMs: number): void {
  setTimeout(async () => {
    await runWeeklyDistribution();
    scheduleNext(WEEK_MS);
  }, Math.max(delayMs, 60_000)); // min 60s to avoid accidental tight loops
}

export function startTournamentCron(): void {
  // Wait 15s after server start so admin auth and DB are fully warm
  setTimeout(async () => {
    try {
      const cfgRes = await pbGet(
        '/api/collections/tournament_config/records?sort=-created&perPage=1',
      );
      const cfg = cfgRes.items?.[0];
      if (!cfg) {
        console.log('[tournament] CRON: no config found — idle until config created.');
        scheduleNext(WEEK_MS);
        return;
      }

      const weekStart = cfg.week_start ? new Date(cfg.week_start).getTime() : 0;
      const elapsed = Date.now() - weekStart;

      if (elapsed >= WEEK_MS) {
        console.log('[tournament] CRON: overdue — running distribution now.');
        await runWeeklyDistribution();
        scheduleNext(WEEK_MS);
      } else {
        const remaining = WEEK_MS - elapsed;
        const hours = Math.round(remaining / 3_600_000);
        console.log(`[tournament] CRON: next distribution in ~${hours}h`);
        scheduleNext(remaining);
      }
    } catch (e: any) {
      console.warn('[tournament] CRON startup error:', e.message);
      scheduleNext(WEEK_MS);
    }
  }, 15_000);
}
