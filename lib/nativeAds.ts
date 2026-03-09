/**
 * nativeAds.ts — Google Mobile Ads SDK wrapper
 *
 * Works in 3 environments:
 *  1. Expo Go / web  : Simulates ads with a countdown timer
 *  2. Custom build   : Uses real react-native-google-mobile-ads SDK
 *  3. Build with mediation: SDK calls AdMob which waterfalls to Unity / AppLovin
 *
 * To activate real ads, run `eas build` (or `npx expo prebuild && npx react-native run-android`).
 * The admob_unit_id, admob_rewarded_id values in PocketBase settings are used as unit IDs.
 */

import { Platform } from 'react-native';

/* ─── Types ─────────────────────────────────────────────────────────────────── */
export type AdNetwork  = 'admob' | 'unity' | 'applovin';
export type AdCallback = (completed: boolean) => void;

export interface AdConfig {
  admobUnitId?:        string;   // interstitial
  admobRewardedId?:    string;   // rewarded
  admobBannerUnitId?:  string;   // banner
  unityGameId?:        string;
  unityRewardedId?:    string;
  applovinSdkKey?:     string;
  applovinRewardedId?: string;
  showAds?:            boolean;
  [key: string]: string | boolean | undefined;
}

/* ─── AdMob test IDs ─────────────────────────────────────────────────────────── */
const TEST_INTERSTITIAL = 'ca-app-pub-3940256099942544/1033173712';
const TEST_REWARDED     = 'ca-app-pub-3940256099942544/5224354917';

/* ─── Try to load the native SDK ─────────────────────────────────────────────── */
let _AdEventType: any        = null;
let _RewardedEventType: any  = null;
let _InterstitialAd: any     = null;
let _RewardedAd: any         = null;
let _sdkAvailable            = false;
let _sdkInitialized          = false;

if (Platform.OS !== 'web') {
  try {
    const pkg = require('react-native-google-mobile-ads');
    _AdEventType       = pkg.AdEventType;
    _RewardedEventType = pkg.RewardedAdEventType;
    _InterstitialAd    = pkg.InterstitialAd;
    _RewardedAd        = pkg.RewardedAd;
    _sdkAvailable      = true;
    console.log('[NativeAds] react-native-google-mobile-ads loaded');
  } catch (e) {
    console.log('[NativeAds] SDK not available (Expo Go / web)');
  }
}

/* ─── Initialize SDK (idempotent) ────────────────────────────────────────────── */
async function ensureSdkInitialized(): Promise<boolean> {
  if (!_sdkAvailable) return false;
  if (_sdkInitialized) return true;
  try {
    const { default: mobileAds } = require('react-native-google-mobile-ads');
    await mobileAds().initialize();
    _sdkInitialized = true;
    console.log('[NativeAds] SDK initialized');
    return true;
  } catch (e: any) {
    console.warn('[NativeAds] SDK init failed:', e.message);
    return false;
  }
}

/* ─── Show interstitial ad ───────────────────────────────────────────────────── */
export function showInterstitialAd(
  _network: AdNetwork,
  cfg: Partial<AdConfig>,
  onDone: AdCallback,
): void {
  const unitId = cfg.admobUnitId || TEST_INTERSTITIAL;
  console.log(`[NativeAds] showInterstitial unitId=${unitId}`);

  if (!_sdkAvailable || !_InterstitialAd) {
    console.log('[NativeAds] Simulating interstitial (3s)');
    setTimeout(() => { console.log('[NativeAds] Interstitial done (sim)'); onDone(true); }, 3000);
    return;
  }

  ensureSdkInitialized().then(ready => {
    if (!ready) {
      setTimeout(() => onDone(true), 3000);
      return;
    }

    const cleanup: Array<() => void> = [];
    try {
      const ad = _InterstitialAd.createForAdRequest(unitId, {
        requestNonPersonalizedAdsOnly: true,
      });

      cleanup.push(ad.addAdEventListener(_AdEventType.LOADED, () => {
        console.log('[NativeAds] Interstitial loaded — showing');
        ad.show();
      }));
      cleanup.push(ad.addAdEventListener(_AdEventType.CLOSED, () => {
        cleanup.forEach(fn => fn());
        console.log('[NativeAds] Interstitial closed');
        onDone(true);
      }));
      cleanup.push(ad.addAdEventListener(_AdEventType.ERROR, (e: Error) => {
        console.warn('[NativeAds] Interstitial error:', e.message, '— falling back to sim');
        cleanup.forEach(fn => fn());
        setTimeout(() => onDone(true), 1000);
      }));

      ad.load();
    } catch (e: any) {
      console.warn('[NativeAds] Interstitial exception:', e.message);
      setTimeout(() => onDone(true), 1000);
    }
  });
}

/* ─── Show rewarded video ad ─────────────────────────────────────────────────── */
export function showRewardedAd(
  _network: AdNetwork,
  cfg: Partial<AdConfig>,
  onDone: AdCallback,
): void {
  const unitId = cfg.admobRewardedId || TEST_REWARDED;
  console.log(`[NativeAds] showRewarded unitId=${unitId}`);

  if (!_sdkAvailable || !_RewardedAd) {
    console.log('[NativeAds] Simulating rewarded (5s)');
    setTimeout(() => { console.log('[NativeAds] Rewarded done — watched=true (sim)'); onDone(true); }, 5000);
    return;
  }

  ensureSdkInitialized().then(ready => {
    if (!ready) {
      setTimeout(() => onDone(true), 5000);
      return;
    }

    let rewarded = false;
    const cleanup: Array<() => void> = [];
    try {
      const ad = _RewardedAd.createForAdRequest(unitId, {
        requestNonPersonalizedAdsOnly: true,
      });

      cleanup.push(ad.addAdEventListener(_RewardedEventType.LOADED, () => {
        console.log('[NativeAds] Rewarded loaded — showing');
        ad.show();
      }));
      cleanup.push(ad.addAdEventListener(_RewardedEventType.EARNED_REWARD, (reward: any) => {
        console.log('[NativeAds] Reward earned:', JSON.stringify(reward));
        rewarded = true;
      }));
      cleanup.push(ad.addAdEventListener(_AdEventType.CLOSED, () => {
        cleanup.forEach(fn => fn());
        console.log('[NativeAds] Rewarded closed, rewarded=', rewarded);
        onDone(rewarded);
      }));
      cleanup.push(ad.addAdEventListener(_AdEventType.ERROR, (e: Error) => {
        console.warn('[NativeAds] Rewarded error:', e.message, '— falling back');
        cleanup.forEach(fn => fn());
        onDone(false);
      }));

      ad.load();
    } catch (e: any) {
      console.warn('[NativeAds] Rewarded exception:', e.message);
      onDone(false);
    }
  });
}

/* ─── Initialize SDK at app start (call from AdProvider or app boot) ─────────── */
export function initializeMobileAds(): void {
  if (!_sdkAvailable) return;
  ensureSdkInitialized().catch(() => {});
}
