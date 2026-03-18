/**
 * Native-only ad SDK loaders (Android / iOS).
 * Metro loads this file only on native platforms, never on web.
 * Each SDK is wrapped in try/catch so Expo Go failures are silent.
 */

/* ── Unity Ads ─────────────────────────────────────────────────────────────── */
let _unityAds: any = null;
try {
  _unityAds = require('react-native-unity-ads').default;
  console.log('[native-ads] react-native-unity-ads loaded ✓');
} catch {
  console.log('[native-ads] react-native-unity-ads not available (Expo Go / not linked)');
}
export const UnityAds = _unityAds;

/* ── AppLovin MAX ───────────────────────────────────────────────────────────── */
let _appLovinMAX: any     = null;
let _alInterstitial: any  = null;
let _alRewarded: any      = null;
let _alAdView: any        = null;
let _alAdFormat: any      = null;

try {
  const pkg    = require('react-native-applovin-max');
  _appLovinMAX    = pkg.AppLovinMAX ?? pkg.default ?? null;
  _alInterstitial = pkg.InterstitialAd ?? null;
  _alRewarded     = pkg.RewardedAd ?? null;
  _alAdView       = pkg.AdView ?? null;
  _alAdFormat     = pkg.AdFormat ?? null;
  console.log('[native-ads] react-native-applovin-max loaded ✓');
} catch {
  console.log('[native-ads] react-native-applovin-max not available (Expo Go / not linked)');
}

export const AppLovinMAX   = _appLovinMAX;
export const ALInterstitial = _alInterstitial;
export const ALRewarded     = _alRewarded;
export const ALAdView       = _alAdView;
export const ALAdFormat     = _alAdFormat;
