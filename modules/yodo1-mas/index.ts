import { requireOptionalNativeModule } from 'expo-modules-core';
import { requireNativeView } from 'expo';
import { Platform } from 'react-native';
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// Yodo1 MAS — clean TypeScript surface for the RN/Expo side.
// ─────────────────────────────────────────────────────────────────────────────
// Android-only local Expo module wrapping com.yodo1.mas (Yodo1 MAS Full SDK).
// Absent on web / iOS / Expo Go (no native runtime), where
// requireOptionalNativeModule() returns null instead of throwing — so every
// consumer degrades to a safe no-op off-device.
//
// PHASE 1 (current): the native side compiles a DORMANT STUB whose isAvailable()
// returns false, so isYodo1NativeAvailable() is false and nothing here actually
// touches Yodo1. PHASE 2 flips the `yodo1Enabled` gradle flag → the real bridge
// is compiled, isAvailable() returns true, and these methods drive real ads.

export interface Yodo1BannerViewProps extends ViewProps {
  /** Yodo1 banner placement id (configured in the Yodo1 dashboard). */
  placementId: string;
  onBannerLoaded?: (event: { nativeEvent: Record<string, never> }) => void;
  onBannerFailed?: (event: { nativeEvent: { message: string } }) => void;
}

interface ShibaYodo1MasNativeModule {
  /** Synchronous: true only when the REAL Yodo1 bridge is compiled in (Phase 2). */
  isAvailable(): boolean;
  isInitialized(): Promise<boolean>;
  /** Initialize Yodo1 MAS with the app key; resolves true once ready. */
  initialize(appKey: string): Promise<boolean>;
  loadInterstitial(): Promise<boolean>;
  /** Resolves true once the interstitial has been shown and closed. */
  showInterstitial(): Promise<boolean>;
  loadRewarded(): Promise<boolean>;
  /** Resolves true ONLY when the user earned the reward (rewarded contract). */
  showRewarded(): Promise<boolean>;
}

const nativeModule: ShibaYodo1MasNativeModule | null =
  Platform.OS === 'android'
    ? (requireOptionalNativeModule('ShibaYodo1Mas') as ShibaYodo1MasNativeModule | null)
    : null;

/**
 * True only when the compiled native module is present AND the real Yodo1 bridge
 * is active (Phase 2). Returns false on web / iOS / Expo Go and while the Phase-1
 * dormant stub is compiled — so callers can confidently fall back.
 */
export function isYodo1NativeAvailable(): boolean {
  try {
    return nativeModule != null && nativeModule.isAvailable() === true;
  } catch {
    return false;
  }
}

/** The native module, or null when Yodo1 isn't actually available. */
export function getYodo1NativeModule(): ShibaYodo1MasNativeModule | null {
  return isYodo1NativeAvailable() ? nativeModule : null;
}

// The native banner view is only resolvable when the real module is compiled in.
let resolvedBannerView: ComponentType<Yodo1BannerViewProps> | null = null;
if (isYodo1NativeAvailable()) {
  try {
    resolvedBannerView = requireNativeView('ShibaYodo1Mas') as ComponentType<Yodo1BannerViewProps>;
  } catch {
    resolvedBannerView = null;
  }
}

/** Native Yodo1 banner component, or null when the module isn't available. */
export const Yodo1BannerNativeView = resolvedBannerView;
