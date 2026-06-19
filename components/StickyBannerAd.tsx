import React, { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  BannerAdComponent,
  BannerAdSize,
  nativeSdkAvailable,
  TEST_IDS,
  useAds,
} from '@/context/AdContext';
import {
  isUnityAvailable,
  UnityBannerNativeView,
  UNITY_PLACEMENTS,
} from '@/lib/unityAds';

export const BANNER_HEIGHT = 50;

const REFRESH_INTERVAL_MS = 30_000;
const RETRY_ON_FAIL_MS    = 10_000;

/*
 * Layout contract:
 *   - StickyBannerAd: position absolute, bottom: 0, zIndex: 5  (sits at very bottom)
 *   - Tab bar (in _layout.tsx): position absolute, bottom: BANNER_HEIGHT, zIndex: 20
 *   → Tab bar always renders ON TOP of the banner. Banner is below nav.
 */

function AdMobBanner({ unitId, onUnavailable }: { unitId: string; onUnavailable?: () => void }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const timerRef  = useRef<ReturnType<typeof setInterval>  | null>(null);
  const retryRef  = useRef<ReturnType<typeof setTimeout>   | null>(null);

  const clearTimers = () => {
    if (timerRef.current)  { clearInterval(timerRef.current);  timerRef.current  = null; }
    if (retryRef.current)  { clearTimeout(retryRef.current);   retryRef.current  = null; }
  };

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setRefreshKey(k => k + 1);
    }, REFRESH_INTERVAL_MS);
    return clearTimers;
  }, []);

  const handleFailedToLoad = (e: Error) => {
    console.warn('[Banner/AdMob] Failed:', e.message);
    // If a Unity fallback is wired in, swap to it immediately instead of retrying.
    if (onUnavailable) { clearTimers(); onUnavailable(); return; }
    // Otherwise retry sooner than the normal 30 s refresh cycle.
    if (!retryRef.current) {
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        setRefreshKey(k => k + 1);
      }, RETRY_ON_FAIL_MS);
    }
  };

  if (!nativeSdkAvailable || !BannerAdComponent) return null;

  return (
    <BannerAdComponent
      key={`banner-${unitId}-${refreshKey}`}
      unitId={unitId}
      size={BannerAdSize?.ANCHORED_ADAPTIVE_BANNER || 'ANCHORED_ADAPTIVE_BANNER'}
      requestOptions={{}}
      onAdFailedToLoad={handleFailedToLoad}
      onAdLoaded={() =>
        console.log('[Banner/AdMob] Loaded unitId=', unitId, 'key=', refreshKey)
      }
    />
  );
}

/* ── Unity banner (Android APK only — null off-device) ───────────────────── */
function UnityBanner() {
  if (!isUnityAvailable() || !UnityBannerNativeView) return null;
  return (
    <UnityBannerNativeView
      placementId={UNITY_PLACEMENTS.banner}
      style={bannerStyles.unity}
      onBannerLoaded={() => console.log('[Banner/Unity] Loaded')}
      onBannerFailed={(e: any) =>
        console.warn('[Banner/Unity] Failed:', e?.nativeEvent?.error ?? e?.nativeEvent?.message)
      }
    />
  );
}

/* ── Banner slot — picks the network and handles AdMob→Unity swap ─────────
 *   • Phase A (forceUnityOnly) + Unity available → Unity only
 *   • Otherwise AdMob; on AdMob load failure (and Unity available) → swap to Unity
 *   • iOS / web / Expo Go → AdMob (or null), Unity is never available there */
function BannerSlot() {
  const { settings } = useAds();
  const unityOK = isUnityAvailable();
  const [useUnity, setUseUnity] = useState(false);

  // Phase A — forced Unity (Android only): bypass AdMob ENTIRELY. UnityBanner
  // renders null when the native module is absent (so no banner until an EAS
  // build) rather than ever falling back to an AdMob banner.
  if (settings.forceUnityOnly && Platform.OS === 'android') return <UnityBanner />;

  if (unityOK && useUnity) return <UnityBanner />;

  const unitId = settings.admobBannerUnitId || TEST_IDS.BANNER;
  return (
    <AdMobBanner
      unitId={unitId}
      onUnavailable={unityOK ? () => setUseUnity(true) : undefined}
    />
  );
}

/* ── Sticky banner — absolute at bottom, below tab bar ───────────────────── */
export function StickyBannerAd() {
  if (Platform.OS === 'web') return null;
  if (!nativeSdkAvailable && !isUnityAvailable()) return null;

  return (
    <View style={styles.wrapper}>
      <BannerSlot />
    </View>
  );
}

/* ── Inline banner — renders in content flow (tab bar, between sections) ── */
export function InlineBannerAd() {
  if (Platform.OS === 'web') return null;
  if (!nativeSdkAvailable && !isUnityAvailable()) return null;

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
  unity: {
    width: 320,
    height: BANNER_HEIGHT,
  },
});
