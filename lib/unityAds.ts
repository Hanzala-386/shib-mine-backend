/**
 * unityAds.ts - Direct Unity Ads bridge (Android-only, Yodo1 fallback-compatible)
 *
 * Promise-based wrapper around the local modules/unity-ads native Expo module.
 * Every helper is a safe no-op off-device (web/iOS/Expo Go).
 * Unity is the FALLBACK network when Yodo1 is unavailable.
 */

import { Platform } from 'react-native';
import {
  getUnityNativeModule,
  isUnityNativeAvailable,
  UnityBannerNativeView,
} from '@/modules/unity-ads';

export const UNITY_PLACEMENTS = {
  interstitial: 'Shib_Interstitial_Android',
  rewarded: 'Shib_Rewarded_Android',
  banner: 'Shib_Banner_Android',
};

export function isUnityAvailable(): boolean {
  return Platform.OS === 'android' && isUnityNativeAvailable();
}

export async function loadUnityInterstitial(placementId: string): Promise<boolean> {
  const mod = getUnityNativeModule();
  if (!mod) return false;
  return mod.load(placementId).catch(() => false);
}

export async function showUnityInterstitial(placementId: string): Promise<boolean> {
  const mod = getUnityNativeModule();
  if (!mod) return false;
  return mod.show(placementId).catch(() => false);
}

export async function loadUnityRewarded(placementId: string): Promise<boolean> {
  const mod = getUnityNativeModule();
  if (!mod) return false;
  return mod.load(placementId).catch(() => false);
}

export async function showUnityRewarded(placementId: string): Promise<boolean> {
  const mod = getUnityNativeModule();
  if (!mod) return false;
  return mod.show(placementId).catch(() => false);
}

export { UnityBannerNativeView };
