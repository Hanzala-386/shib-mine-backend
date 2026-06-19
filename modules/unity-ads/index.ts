import { requireOptionalNativeModule } from 'expo-modules-core';
import { requireNativeView } from 'expo';
import { Platform } from 'react-native';
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

export interface UnityBannerViewProps extends ViewProps {
  placementId: string;
  onBannerLoaded?: (event: { nativeEvent: Record<string, never> }) => void;
  onBannerFailed?: (event: { nativeEvent: { message: string } }) => void;
}

interface ShibaUnityAdsNativeModule {
  isInitialized(): Promise<boolean>;
  initialize(gameId: string, testMode: boolean): Promise<boolean>;
  load(placementId: string): Promise<boolean>;
  /** Resolves true only when the ad was fully COMPLETED (rewarded contract). */
  show(placementId: string): Promise<boolean>;
}

// Android-only local Expo module wrapping com.unity3d.ads:4.13.0. Absent on
// web / iOS / Expo Go (no native runtime) — requireOptionalNativeModule()
// returns null instead of throwing, so the JS wrapper (lib/unityAds.ts) and
// every consumer degrade to a safe no-op off-device.
const nativeModule: ShibaUnityAdsNativeModule | null =
  Platform.OS === 'android'
    ? (requireOptionalNativeModule('ShibaUnityAds') as ShibaUnityAdsNativeModule | null)
    : null;

/** True only when the compiled native module is present (production Android APK). */
export function isUnityNativeAvailable(): boolean {
  return nativeModule != null;
}

export function getUnityNativeModule(): ShibaUnityAdsNativeModule | null {
  return nativeModule;
}

// The native banner view is only resolvable when the module is compiled in.
let resolvedBannerView: ComponentType<UnityBannerViewProps> | null = null;
if (nativeModule) {
  try {
    resolvedBannerView = requireNativeView('ShibaUnityAds') as ComponentType<UnityBannerViewProps>;
  } catch {
    resolvedBannerView = null;
  }
}

/** Native Unity banner component, or null when the module isn't available. */
export const UnityBannerNativeView = resolvedBannerView;
