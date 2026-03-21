/**
 * native-ads.native.ts
 *
 * react-native-unity-ads and react-native-applovin-max have been removed.
 * Unity Ads and AppLovin now run via AdMob Mediation Gradle adapters:
 *   com.google.ads.mediation:unity  (in withAndroidConfig.js)
 *   com.applovin:applovin-sdk       (in withAndroidConfig.js)
 *
 * AdMob's SDK picks the winning network automatically at runtime.
 * No direct Unity / AppLovin SDK calls are needed in JS.
 * All exports are null so existing null-checks in AdContext remain valid.
 */

export const UnityAds: null       = null;
export const AppLovinMAX: null    = null;
export const ALInterstitial: null = null;
export const ALRewarded: null     = null;
export const ALAdView: null       = null;
export const ALAdFormat: null     = null;
