/**
 * Native Ad Bridge — nativeAds.ts
 *
 * Architecture:
 *  • Expo Go / Web  : Simulates ads with a countdown timer (no real SDK calls)
 *  • Custom Build   : Calls real native SDK via NativeModules
 *
 * How to activate real ads in a custom build:
 *  1. Run: npx expo prebuild
 *  2. Add to android/build.gradle:
 *       implementation 'com.google.android.gms:play-services-ads:22.6.0'   // AdMob
 *       implementation 'com.unity3d.ads:unity-ads:4.10.0'                   // Unity
 *       implementation 'com.applovin:applovin-sdk:+'                        // AppLovin MAX
 *  3. Create a native module (NativeAdModule.kt) that registers:
 *       showInterstitial(adUnitId: String, callback: Callback)
 *       showRewarded(adUnitId: String, callback: Callback)
 *  4. In app.json plugins array add your native module
 *  5. Uncomment the NativeModules block below
 */

import { NativeModules, Platform } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────
// Flexible config — accepts any object that has at least some of these keys.
// Compatible with AdSettings from games.tsx without requiring an exact match.
export interface AdConfig {
  admobInterstitialId?:    string;
  admobRewardedId?:        string;
  admobUnitId?:            string;     // interstitial alias used in PB settings
  admobBannerUnitId?:      string;
  unityGameId?:            string;
  unityInterstitialId?:    string;
  unityRewardedId?:        string;
  applovinSdkKey?:         string;
  applovinInterstitialId?: string;
  applovinRewardedId?:     string;
  [key: string]: string | boolean | undefined;  // allow extra keys
}

export type AdNetwork  = 'admob' | 'unity' | 'applovin';
export type AdCallback = (watched: boolean) => void;

// ─── Detect if the native module is available ─────────────────────────────────
const { ShibAds } = NativeModules as { ShibAds?: {
  showInterstitial: (unitId: string, cb: AdCallback) => void;
  showRewarded:     (unitId: string, cb: AdCallback) => void;
} };

const NATIVE_AVAILABLE = Platform.OS !== 'web' && !!ShibAds;

// ─── Simulation delays (Expo Go / dev) ───────────────────────────────────────
const SIM_INTERSTITIAL_MS = 3000;
const SIM_REWARDED_MS     = 5000;

// ─── Core: show interstitial ad ──────────────────────────────────────────────
export function showInterstitialAd(
  network: AdNetwork,
  cfg: Partial<AdConfig>,
  onDone: AdCallback,
): void {
  console.log(`[NativeAds] showInterstitial network=${network}`);

  if (NATIVE_AVAILABLE) {
    // ── Real native SDK call ──
    // Uncomment when custom build with NativeAdModule.kt is ready:
    /*
    let unitId = '';
    if (network === 'admob')    unitId = cfg.admobInterstitialId    || '';
    if (network === 'unity')    unitId = cfg.unityInterstitialId    || '';
    if (network === 'applovin') unitId = cfg.applovinInterstitialId || '';
    ShibAds!.showInterstitial(unitId, onDone);
    return;
    */
  }

  // ── Simulation (Expo Go / web) ──
  console.log(`[NativeAds] Simulating interstitial (${SIM_INTERSTITIAL_MS}ms)…`);
  setTimeout(() => {
    console.log('[NativeAds] Interstitial complete (simulated)');
    onDone(true);
  }, SIM_INTERSTITIAL_MS);
}

// ─── Core: show rewarded video ad ─────────────────────────────────────────────
// This is the TRIGGER for the "Double" button — call this from handleDouble()
export function showRewardedAd(
  network: AdNetwork,
  cfg: Partial<AdConfig>,
  onDone: AdCallback,
): void {
  console.log(`[NativeAds] showRewarded network=${network}`);

  if (NATIVE_AVAILABLE) {
    // ── Real native SDK call ──
    // Uncomment when custom build with NativeAdModule.kt is ready:
    /*
    let unitId = '';
    if (network === 'admob')    unitId = cfg.admobRewardedId    || '';
    if (network === 'unity')    unitId = cfg.unityRewardedId    || '';
    if (network === 'applovin') unitId = cfg.applovinRewardedId || '';
    ShibAds!.showRewarded(unitId, (watched: boolean) => {
      console.log('[NativeAds] Rewarded done, watched=', watched);
      onDone(watched);
    });
    return;
    */
  }

  // ── Simulation (Expo Go / web) ──
  console.log(`[NativeAds] Simulating rewarded video (${SIM_REWARDED_MS}ms)…`);
  setTimeout(() => {
    console.log('[NativeAds] Rewarded complete — watched=true (simulated)');
    onDone(true);
  }, SIM_REWARDED_MS);
}

// ─── Kotlin stub (for reference) ──────────────────────────────────────────────
// File: android/app/src/main/java/com/shibmine/ShibAdsModule.kt
/*
package com.shibmine

import com.facebook.react.bridge.*
import com.google.android.gms.ads.*
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback

class ShibAdsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ShibAds"

    @ReactMethod
    fun showInterstitial(adUnitId: String, callback: Callback) {
        val activity = currentActivity ?: return
        InterstitialAd.load(reactApplicationContext, adUnitId,
            AdRequest.Builder().build(),
            object : InterstitialAdLoadCallback() {
                override fun onAdLoaded(ad: InterstitialAd) {
                    ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                        override fun onAdDismissedFullScreenContent() { callback.invoke(true) }
                        override fun onAdFailedToShowFullScreenContent(e: AdError) { callback.invoke(false) }
                    }
                    activity.runOnUiThread { ad.show(activity) }
                }
                override fun onAdFailedToLoad(e: LoadAdError) { callback.invoke(false) }
            }
        )
    }

    @ReactMethod
    fun showRewarded(adUnitId: String, callback: Callback) {
        val activity = currentActivity ?: return
        RewardedAd.load(reactApplicationContext, adUnitId,
            AdRequest.Builder().build(),
            object : RewardedAdLoadCallback() {
                override fun onAdLoaded(ad: RewardedAd) {
                    ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                        override fun onAdDismissedFullScreenContent() { callback.invoke(true) }
                        override fun onAdFailedToShowFullScreenContent(e: AdError) { callback.invoke(false) }
                    }
                    var rewarded = false
                    ad.show(activity) { rewarded = true }
                    // callback with rewarded flag is already handled by dismiss
                }
                override fun onAdFailedToLoad(e: LoadAdError) { callback.invoke(false) }
            }
        )
    }
}
*/
