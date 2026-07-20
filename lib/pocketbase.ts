import PocketBase from 'pocketbase';
import { Platform } from 'react-native';

// ─── EventSource polyfill (native only) ─────────────────────────────────────
// PocketBase realtime subscriptions use SSE (EventSource), which React Native
// lacks. react-native-sse is a pure-JS polyfill (no native module — Expo Go
// safe). This enables INSTANT single-session logout pushes in the APK.
// Web already has a native EventSource, so it is untouched there.
if (Platform.OS !== 'web' && typeof (global as any).EventSource === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RNEventSource = require('react-native-sse');
  (global as any).EventSource = RNEventSource.default ?? RNEventSource;
}

export const POCKETBASE_URL = 'https://api.webcod.in';

export const pb = new PocketBase(POCKETBASE_URL);

pb.autoCancellation(false);

// SECURITY: processPendingReferralEarnings (client-side self-credit of referral
// commissions) was REMOVED. Pending referral_earnings_log entries are now
// processed SERVER-SIDE by the Express claim-referral route; PocketBase rules
// block client writes to referral_balance / referral_earnings entirely.
// Clients may still READ unprocessed log entries to display a pending total.

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

