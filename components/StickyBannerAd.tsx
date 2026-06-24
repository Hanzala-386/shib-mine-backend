import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  Yodo1BannerNativeView,
  isYodo1NativeAvailable,
} from '@/modules/yodo1-mas';
import {
  isUnityAvailable,
  UnityBannerNativeView,
  UNITY_PLACEMENTS,
} from '@/lib/unityAds';
import { useAds } from '@/context/AdContext';

export const BANNER_HEIGHT = 50;

/* ── Yodo1 banner (Android APK only — null off-device) ──────────────────── */
function Yodo1Banner() {
  if (!isYodo1NativeAvailable() || !Yodo1BannerNativeView) return null;
  return (
    <Yodo1BannerNativeView
      placementId="banner"
      style={bannerStyles.native}
      onBannerLoaded={() => console.log('[Banner/Yodo1] Loaded')}
      onBannerFailed={(e: any) =>
        console.warn('[Banner/Yodo1] Failed:', e?.nativeEvent?.message)
      }
    />
  );
}

/* ── Unity banner (Android APK only — null off-device) ──────────────────── */
function UnityBanner() {
  if (!isUnityAvailable() || !UnityBannerNativeView) return null;
  return (
    <UnityBannerNativeView
      placementId={UNITY_PLACEMENTS.banner}
      style={bannerStyles.unity}
      onBannerLoaded={() => console.log('[Banner/Unity] Loaded')}
      onBannerFailed={(e: any) =>
        console.warn('[Banner/Unity] Failed:', e?.nativeEvent?.message)
      }
    />
  );
}

/* ── Banner slot — picks the active network ─────────────────────────────── */
function BannerSlot() {
  const { settings } = useAds();

  // Phase A: forceUnityOnly → Unity only
  if (settings.forceUnityOnly && Platform.OS === 'android') return <UnityBanner />;

  // Normal: Yodo1 primary, Unity fallback
  if (isYodo1NativeAvailable()) return <Yodo1Banner />;
  if (isUnityAvailable()) return <UnityBanner />;

  return null;
}

/* ── Sticky banner — absolute at bottom, below tab bar ──────────────────── */
export function StickyBannerAd() {
  if (Platform.OS === 'web') return null;
  if (!isYodo1NativeAvailable() && !isUnityAvailable()) return null;

  return (
    <View style={styles.wrapper}>
      <BannerSlot />
    </View>
  );
}

/* ── Inline banner — renders in content flow ────────────────────────────── */
export function InlineBannerAd() {
  if (Platform.OS === 'web') return null;
  if (!isYodo1NativeAvailable() && !isUnityAvailable()) return null;

  return (
    <View style={inlineStyles.wrapper}>
      <BannerSlot />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    minHeight: BANNER_HEIGHT,
    alignItems: 'center',
    backgroundColor: 'transparent',
    zIndex: 5,
    elevation: 5,
  },
});

const inlineStyles = StyleSheet.create({
  wrapper: {
    width: '100%',
    minHeight: BANNER_HEIGHT,
    alignItems: 'center',
    backgroundColor: 'transparent',
    marginVertical: 8,
  },
});

const bannerStyles = StyleSheet.create({
  native: {
    width: '100%',
    height: BANNER_HEIGHT,
  },
  unity: {
    width: 320,
    height: BANNER_HEIGHT,
  },
});
