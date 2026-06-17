/**
 * Play Integrity client — requests an on-device attestation token from
 * Google Play Services, which the server then verifies via Google's
 * Play Integrity API.
 *
 * ──────────────────────────────────────────────────────────────────────
 * HOW TO ACTIVATE IN PRODUCTION
 * ──────────────────────────────────────────────────────────────────────
 * 1. Install the native module:
 *      npx expo install react-native-integrity
 *    (requires a custom EAS build — not available in Expo Go)
 *
 * 2. Set your Google Cloud project number below where indicated.
 *
 * 3. Enable the Play Integrity API in Google Cloud Console and create
 *    an API key. Set it as GOOGLE_PLAY_INTEGRITY_KEY on Railway.
 *
 * 4. Build: eas build --platform android --profile production
 *
 * Until then this module returns null (fail-open / skip integrity check).
 * ──────────────────────────────────────────────────────────────────────
 *
 * Play Store Compliance (Step 4 of security spec):
 *   We deliberately do NOT request QUERY_ALL_PACKAGES permission.
 *   All environment checks rely on:
 *     • Native binary signals (jail-monkey)
 *     • expo-device OS flags
 *     • Play Integrity token verdict
 *   …NOT filesystem app enumeration. Fully Google Play policy compliant.
 */

import { Platform } from 'react-native';

// react-native-integrity is not in the Expo Go compatible list.
// We require it lazily so the app does not crash without a custom build.
let Integrity: any = null;

if (Platform.OS === 'android' && !__DEV__) {
  try {
    Integrity = require('react-native-integrity');
  } catch {
    // Package not installed — will skip integrity check gracefully.
  }
}

/**
 * Request a Play Integrity token for the given nonce string.
 *
 * Returns a base64-encoded JWT string on success, or null when the
 * native module is unavailable (Expo Go, iOS, web, __DEV__).
 *
 * The caller should send the returned token to
 * POST /api/app/security/verify-integrity for server-side verdict.
 */
export async function requestIntegrityToken(nonce: string): Promise<string | null> {
  if (!Integrity) return null;

  try {
    // Replace 'YOUR_CLOUD_PROJECT_NUMBER' with your numeric Google Cloud
    // project ID (found at console.cloud.google.com → Project settings).
    const token: string = await Integrity.requestIntegrityToken(
      nonce,
      // 'YOUR_CLOUD_PROJECT_NUMBER',   // ← uncomment & fill in before EAS build
    );
    return token ?? null;
  } catch {
    // Google Play Services unavailable or device not certified — fail open.
    return null;
  }
}
