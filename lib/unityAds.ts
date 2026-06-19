/**
 * unityAds.ts — direct Unity Ads bridge (Android-only)
 *
 * Promise-based wrapper around the local `modules/unity-ads` native Expo module
 * (com.unity3d.ads:4.13.0). Every helper is a safe no-op off-device:
 *   - web / iOS / Expo Go    → native module absent → resolves false
 *   - production Android APK  → real Unity Ads
 *
 * Unity is the FALLBACK network behind AdMob (see context/AdContext.tsx). It is
 * Android-only by design — iOS continues to use AdMob exclusively.
 */

import { Platform } from 'react-native';
import {
  getUnityNativeModule,
  isUnityNativeAvailable,
  UnityBannerNativeView,
} from '@/modules/unity-ads';

/* ─── Constants ──────────────────────────────────────────────────────────────── */
export const UNITY_GAME_ID = '6061517';
/* Production build serves real Unity ads. Flip to true only for local ad debugging. */
export const UNITY_TEST_MODE = false;

export const UNITY_PLACEMENTS = {
  interstitial: 'Shib_Interstitial_Android',
  rewarded:     'Shib_Rewarded_Android',
  banner:       'Shib_Banner_Android',
} as const;

/* Re-export the native banner component (null off-device) for StickyBannerAd. */
export { UnityBannerNativeView };

const mod = getUnityNativeModule();

/** True only on a production Android APK where the native module is compiled in. */
export function isUnityAvailable(): boolean {
  return Platform.OS === 'android' && isUnityNativeAvailable() && mod != null;
}

/* ─── Initialization (idempotent) ────────────────────────────────────────────── */
let initPromise: Promise<boolean> | null = null;

export function ensureUnityInitialized(): Promise<boolean> {
  if (!isUnityAvailable() || !mod) return Promise.resolve(false);
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (await mod.isInitialized()) return true;
      await mod.initialize(UNITY_GAME_ID, UNITY_TEST_MODE);
      console.log('[UnityAds] initialized ✓');
      return true;
    } catch (e: any) {
      console.warn('[UnityAds] init failed:', e?.message);
      initPromise = null; // allow a later retry
      return false;
    }
  })();
  return initPromise;
}

/* ─── Preload (best-effort caching ahead of show) ────────────────────────────── */
export async function preloadUnity(placementId: string): Promise<boolean> {
  if (!isUnityAvailable() || !mod) return false;
  if (!(await ensureUnityInitialized())) return false;
  try {
    await mod.load(placementId);
    return true;
  } catch (e: any) {
    console.warn('[UnityAds] preload failed:', placementId, e?.message);
    return false;
  }
}

export function preloadUnityAds(): void {
  if (!isUnityAvailable()) return;
  preloadUnity(UNITY_PLACEMENTS.interstitial).catch(() => {});
  preloadUnity(UNITY_PLACEMENTS.rewarded).catch(() => {});
}

/* ─── Show helpers ───────────────────────────────────────────────────────────── */

/**
 * Interstitial — resolves true if the ad was DISPLAYED (completed OR skipped),
 * false only on a real failure. Matches AdMob interstitial "shown" semantics.
 */
export async function showUnityInterstitial(): Promise<boolean> {
  if (!isUnityAvailable() || !mod) return false;
  if (!(await ensureUnityInitialized())) return false;
  try {
    try { await mod.load(UNITY_PLACEMENTS.interstitial); } catch {}
    await mod.show(UNITY_PLACEMENTS.interstitial); // resolves(bool) on shown; rejects on failure
    return true;
  } catch (e: any) {
    console.warn('[UnityAds] interstitial show failed:', e?.message);
    return false;
  } finally {
    preloadUnity(UNITY_PLACEMENTS.interstitial).catch(() => {});
  }
}

/**
 * Rewarded — resolves true ONLY when the user fully COMPLETED the ad
 * (the native show() resolves true only on UnityAdsShowCompletionState.COMPLETED).
 */
export async function showUnityRewarded(): Promise<boolean> {
  if (!isUnityAvailable() || !mod) return false;
  if (!(await ensureUnityInitialized())) return false;
  try {
    try { await mod.load(UNITY_PLACEMENTS.rewarded); } catch {}
    const completed = await mod.show(UNITY_PLACEMENTS.rewarded);
    return !!completed;
  } catch (e: any) {
    console.warn('[UnityAds] rewarded show failed:', e?.message);
    return false;
  } finally {
    preloadUnity(UNITY_PLACEMENTS.rewarded).catch(() => {});
  }
}
