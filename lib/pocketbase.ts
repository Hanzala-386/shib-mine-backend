import PocketBase from 'pocketbase';

export const POCKETBASE_URL = 'https://api.webcod.in';

export const pb = new PocketBase(POCKETBASE_URL);

pb.autoCancellation(false);

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

