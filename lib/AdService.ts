import { Platform } from 'react-native';

/**
 * AdMob ad unit IDs — the ONLY unit IDs used anywhere in the app.
 *
 * ANDROID: LIVE production unit IDs (AdMob app ca-app-pub-7314448641809053).
 *   NOTE: live ads only serve when app.json's `androidAppId` is this AdMob
 *   app's ~App ID (ca-app-pub-7314448641809053~XXXXXXXXXX) — unit IDs from one
 *   AdMob app never fill under another app's manifest App ID.
 * iOS: official Google TEST IDs (no iOS AdMob app registered yet).
 *   https://developers.google.com/admob/android/test-ads
 */
export const ADMOB_AD_UNIT_IDS = {
  banner: Platform.OS === 'android'
    ? 'ca-app-pub-7314448641809053/4666652323'
    : 'ca-app-pub-3940256099942544/2934735716',
  interstitial: Platform.OS === 'android'
    ? 'ca-app-pub-7314448641809053/2310185360'
    : 'ca-app-pub-3940256099942544/4411468910',
  rewarded: Platform.OS === 'android'
    ? 'ca-app-pub-7314448641809053/7506671725'
    : 'ca-app-pub-3940256099942544/1712485313',
};

/* Dynamic config — kept for the admin panel's configureAds() call. The IDs
 * are stored but NOT used for ad requests (unit IDs above are compiled in). */
let cfg: Record<string, string> = {};

/** Called by AdminContext once PocketBase settings are fetched at launch */
export function configureAds(config: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string') cfg[k] = v;
  }
  console.log('[AdService] configureAds: IDs stored (compiled-in unit IDs are used for requests)');
}

export function getConfiguredAdIds(): Record<string, string> {
  return { ...cfg };
}
