/**
 * lib/admob.ts — single gateway to the react-native-google-mobile-ads SDK.
 *
 * The ONLY ad SDK in this app is the official Google Mobile Ads SDK (AdMob).
 * Yodo1 MAS and Unity Ads have been fully removed.
 *
 * Loading rules:
 *  - web:      never loaded (metro.config.js also redirects the package to a
 *              stub so the web bundle can't pull native code in).
 *  - Expo Go:  the require() throws because the native module is absent —
 *              caught here, everything exports null and callers simulate ads.
 *  - EAS/APK:  real SDK, real (test) ads.
 */
import { Platform } from 'react-native';

let gma: any = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    gma = require('react-native-google-mobile-ads');
    if (!gma?.InterstitialAd) gma = null;
  } catch {
    gma = null; // Expo Go / native module missing — simulate gracefully
  }
}

export const mobileAds = gma?.default ?? null;
export const InterstitialAd = gma?.InterstitialAd ?? null;
export const RewardedAd = gma?.RewardedAd ?? null;
export const BannerAd = gma?.BannerAd ?? null;
export const BannerAdSize = gma?.BannerAdSize ?? null;
export const AdEventType = gma?.AdEventType ?? null;
export const RewardedAdEventType = gma?.RewardedAdEventType ?? null;

export function isAdMobAvailable(): boolean {
  return Platform.OS !== 'web' && !!gma;
}
