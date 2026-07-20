/**
 * Security remediation script — direct-PB injection attack cleanup.
 *
 * Context: an attacker (users record ykuszks5w83uxr0) used a derived PB user
 * token to write money fields directly to PocketBase (forged
 * mining_sessions.booster_multiplier values far above the legit whitelist and
 * an inflated shib_balance of ~1.46M). PB rules + Express routes are now
 * locked down; this script cleans up the data that was injected BEFORE the
 * lockdown.
 *
 * Usage:
 *   npx tsx scripts/security-remediation.ts             # DRY RUN (report only, no writes)
 *   npx tsx scripts/security-remediation.ts --apply     # void fraud sessions (claimed_amount = -1)
 *   npx tsx scripts/security-remediation.ts --apply --reset-attacker
 *       # also reset the known attacker's balances to starter values
 *       # (shib_balance=100, power_tokens=500, referral_* = 0) and flag is_blacklist_2
 *
 * Requires: PB_ADMIN_EMAIL + PB_ADMIN_PASSWORD in env (same creds the server uses).
 */

const PB_URL = process.env.POCKETBASE_URL || 'https://api.webcod.in';
const ATTACKER_ID = 'ykuszks5w83uxr0';
const LEGIT_MULTIPLIERS = new Set([1, 2, 4, 6, 10]);
const SUSPECT_BALANCE_THRESHOLD = 500_000; // report any user above this

const APPLY = process.argv.includes('--apply');
const RESET_ATTACKER = process.argv.includes('--reset-attacker');

async function pbFetch(method: string, path: string, token?: string, body?: any) {
  const res = await fetch(`${PB_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function adminAuth(): Promise<string> {
  const email = process.env.PB_ADMIN_EMAIL;
  const pass = process.env.PB_ADMIN_PASSWORD;
  if (!email || !pass) throw new Error('PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD not set');
  const r = await pbFetch('POST', '/api/admins/auth-with-password', undefined, {
    identity: email,
    password: pass,
  });
  if (!r.token) throw new Error('PB admin auth failed');
  return r.token as string;
}

async function getAllPages(token: string, collection: string, filter: string, fields: string) {
  const items: any[] = [];
  let page = 1;
  for (;;) {
    const r = await pbFetch(
      'GET',
      `/api/collections/${collection}/records?page=${page}&perPage=200` +
        `&filter=${encodeURIComponent(filter)}&fields=${encodeURIComponent(fields)}`,
      token,
    );
    items.push(...(r.items || []));
    if (page >= (r.totalPages || 1)) break;
    page++;
  }
  return items;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (report only)'}\n`);
  const token = await adminAuth();
  console.log('✓ Admin authenticated\n');

  // ── 1. Fraudulent mining sessions: booster_multiplier outside whitelist ──
  console.log('── Mining sessions with forged booster_multiplier ──');
  // Server-side filter: only fetch sessions whose multiplier is OUTSIDE the
  // whitelist (0/unset counts as "no booster" = legit). Full-table scans of
  // mining_sessions are too slow.
  const whitelistFilter = [0, ...LEGIT_MULTIPLIERS]
    .map((m) => `booster_multiplier != ${m}`)
    .join(' && ');
  const sessions = await getAllPages(
    token,
    'mining_sessions',
    `claimed_amount != -1 && ${whitelistFilter}`,
    'id,user,booster_multiplier,claimed_amount,created,updated',
  );
  const fraudSessions = sessions.filter(
    (s) => !LEGIT_MULTIPLIERS.has(Number(s.booster_multiplier) || 1),
  );
  console.log(`${fraudSessions.length} sessions with invalid multiplier:`);
  const byUser: Record<string, { count: number; claimed: number; multipliers: Set<number> }> = {};
  for (const s of fraudSessions) {
    const u = (byUser[s.user] ??= { count: 0, claimed: 0, multipliers: new Set() });
    u.count++;
    u.claimed += Number(s.claimed_amount) || 0;
    u.multipliers.add(Number(s.booster_multiplier));
    console.log(
      `  ${s.id}  user=${s.user}  multiplier=${s.booster_multiplier}  claimed=${s.claimed_amount}  created=${s.created}`,
    );
  }
  console.log('\nPer-user fraud summary:');
  for (const [uid, agg] of Object.entries(byUser)) {
    console.log(
      `  ${uid}${uid === ATTACKER_ID ? '  ← KNOWN ATTACKER' : ''}: ${agg.count} sessions, ` +
        `${agg.claimed} SHIB claimed via forged multipliers ${[...agg.multipliers].join(',')}`,
    );
  }

  if (APPLY && fraudSessions.length) {
    console.log('\nVoiding fraud sessions (claimed_amount = -1)…');
    let ok = 0;
    for (const s of fraudSessions) {
      try {
        await pbFetch('PATCH', `/api/collections/mining_sessions/records/${s.id}`, token, {
          claimed_amount: -1,
        });
        ok++;
      } catch (e: any) {
        console.error(`  ✗ ${s.id}: ${e.message}`);
      }
    }
    console.log(`✓ Voided ${ok}/${fraudSessions.length} sessions`);
  }

  // ── 2. Known attacker report ──
  console.log(`\n── Attacker record ${ATTACKER_ID} ──`);
  let attacker: any = null;
  try {
    attacker = await pbFetch(
      'GET',
      `/api/collections/users/records/${ATTACKER_ID}?fields=` +
        encodeURIComponent(
          'id,email,display_name,shib_balance,power_tokens,referral_balance,referral_earnings,' +
            'vip_level,total_claims,is_blacklist_1,is_blacklist_2,status,created',
        ),
      token,
    );
    console.log(JSON.stringify(attacker, null, 2));
  } catch (e: any) {
    console.log(`Could not load attacker record: ${e.message}`);
  }

  if (APPLY && RESET_ATTACKER && attacker) {
    console.log('\nResetting attacker balances to starter values + blacklist tier 2…');
    await pbFetch('PATCH', `/api/collections/users/records/${ATTACKER_ID}`, token, {
      shib_balance: 100,
      power_tokens: 500,
      referral_balance: 0,
      referral_earnings: 0,
      is_blacklist_1: true,
      is_blacklist_2: true,
    });
    console.log('✓ Attacker balances reset and account blacklisted');
  } else if (attacker) {
    console.log('(attacker balances untouched — pass --apply --reset-attacker to reset)');
  }

  // ── 3. Suspect balances (report only, never auto-reset) ──
  console.log(`\n── Users with shib_balance > ${SUSPECT_BALANCE_THRESHOLD.toLocaleString()} ──`);
  const suspects = await getAllPages(
    token,
    'users',
    `shib_balance > ${SUSPECT_BALANCE_THRESHOLD}`,
    'id,email,display_name,shib_balance,power_tokens,vip_level,total_claims,created',
  );
  if (!suspects.length) console.log('None found.');
  for (const u of suspects) {
    console.log(
      `  ${u.id}${u.id === ATTACKER_ID ? '  ← KNOWN ATTACKER' : ''}  ${u.email || u.display_name || ''}` +
        `  shib=${u.shib_balance}  pt=${u.power_tokens}  claims=${u.total_claims}  vip=${u.vip_level}`,
    );
  }
  console.log(
    '\n(Suspect balances are REPORT-ONLY — review manually before resetting anyone beyond the known attacker.)',
  );

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
