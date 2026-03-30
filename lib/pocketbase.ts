import PocketBase from 'pocketbase';

export const POCKETBASE_URL = 'https://api.webcod.in';

export const pb = new PocketBase(POCKETBASE_URL);

pb.autoCancellation(false);

// ─── Process pending referral commission entries ────────────────────────────
// Called on login for the referrer's client (self-update, always allowed).
// Reads unprocessed referral_earnings_log records where referrer_id = this user,
// credits their own shib_balance / referral_balance / referral_earnings, then marks processed.
export async function processPendingReferralEarnings(pbId: string): Promise<number> {
  try {
    const pending = await pb.collection('referral_earnings_log').getFullList({
      filter: `referrer_id = "${pbId}" && processed = false`,
      sort:   '-created',
    });
    if (!pending.length) return 0;

    const total = pending.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    if (total <= 0) return 0;

    // Read current balances fresh to avoid stale-closure overwrites
    const user = await pb.collection('users').getOne(pbId);
    await pb.collection('users').update(pbId, {
      shib_balance:      (Number(user.shib_balance)      || 0) + total,
      referral_balance:  (Number(user.referral_balance)  || 0) + total,
      referral_earnings: (Number(user.referral_earnings) || 0) + total,
    });

    // Mark all entries processed (best-effort, parallel)
    await Promise.allSettled(
      pending.map((r) =>
        pb.collection('referral_earnings_log').update(r.id, { processed: true })
      )
    );

    return total;
  } catch {
    return 0; // non-critical — user will retry on next open
  }
}

/* ── PocketBase record shapes (snake_case matches actual PB field names) ── */

export interface PBUser {
  id: string;
  firebase_uid: string;
  email: string;
  display_name: string;
  referral_code: string;
  referred_by?: string;
  referral_balance: number;
  referral_earnings: number;
  shib_balance: number;
  power_tokens: number;
  total_claims: number;
  total_wins: number;
  active_booster_multiplier: number;
  booster_expires: string;
  fraud_attempts: number;
  is_verified: boolean;
  status: string;
  created: string;
}

