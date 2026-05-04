import React, { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  BannerAdComponent,
  BannerAdSize,
  nativeSdkAvailable,
  TEST_IDS,
  useAds,
} from '@/context/AdContext';

export const BANNER_HEIGHT = 50;

const REFRESH_INTERVAL_MS = 30_000;
const RETRY_ON_FAIL_MS    = 10_000;

/*
 * Layout contract:
 *   - StickyBannerAd: position absolute, bottom: 0, zIndex: 5  (sits at very bottom)
 *   - Tab bar (in _layout.tsx): position absolute, bottom: BANNER_HEIGHT, zIndex: 20
 *   → Tab bar always renders ON TOP of the banner. Banner is below nav.
 */

function AdMobBanner({ unitId }: { unitId: string }) {
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
    // Retry sooner than the normal 30 s refresh cycle
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

/* ── Sticky banner — absolute at bottom, below tab bar ───────────────────── */
export function StickyBannerAd() {
  const { settings } = useAds();
  if (Platform.OS === 'web') return null;
  if (!nativeSdkAvailable) return null;

  const unitId = settings.admobBannerUnitId || TEST_IDS.BANNER;

  return (
    <View style={styles.wrapper}>
      <AdMobBanner unitId={unitId} />
    </View>
  );
}

/* ── Inline banner — renders in content flow (tab bar, between sections) ── */
export function InlineBannerAd() {
  const { settings } = useAds();
  if (Platform.OS === 'web') return null;
  if (!nativeSdkAvailable) return null;

  const unitId = settings.admobBannerUnitId || TEST_IDS.BANNER;

  return (
    <View style={inlineStyles.wrapper}>
      <AdMobBanner unitId={unitId} />
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
