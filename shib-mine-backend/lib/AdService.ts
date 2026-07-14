import { Platform } from 'react-native';

/**
 * Official Google AdMob TEST unit IDs — the ONLY unit IDs used anywhere in
 * the app. Swap to production IDs only at release time.
 * https://developers.google.com/admob/android/test-ads
 */
export const ADMOB_TEST_IDS = {
  banner: Platform.OS === 'android'
    ? 'ca-app-pub-3940256099942544/6300978111'
    : 'ca-app-pub-3940256099942544/2934735716',
  interstitial: Platform.OS === 'android'
    ? 'ca-app-pub-3940256099942544/1033173712'
    : 'ca-app-pub-3940256099942544/4411468910',
  rewarded: Platform.OS === 'android'
    ? 'ca-app-pub-3940256099942544/5224354917'
    : 'ca-app-pub-3940256099942544/1712485313',
};

/* Dynamic config — kept for the admin panel's configureAds() call. The IDs
 * are stored but NOT used for ad requests while the app runs on TEST IDs. */
let cfg: Record<string, string> = {};

/** Called by AdminContext once PocketBase settings are fetched at launch */
export function configureAds(config: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string') cfg[k] = v;
  }
  console.log('[AdService] configureAds: IDs stored (app runs on AdMob TEST IDs)');
}

export function getConfiguredAdIds(): Record<string, string> {
  return { ...cfg };
}
