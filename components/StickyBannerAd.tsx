import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Platform, AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { BannerAd, BannerAdSize, isAdMobAvailable } from '@/lib/admob';
import { ADMOB_TEST_IDS } from '@/lib/AdService';

export const BANNER_HEIGHT = 50;

/* True when a real AdMob banner can render (native + SDK present). Screens
 * use this to skip empty banner bars on web / Expo Go. */
export const BANNERS_AVAILABLE =
  Platform.OS !== 'web' && isAdMobAvailable() && !!BannerAd;

/* 60-second HARD refresh — the banner is fully re-created (key remount →
 * native view destroyed + new ad request), independent of AdMob's own
 * server-side refresh setting. */
const BANNER_REFRESH_MS = 60_000;

/* ── Active-visibility gate ───────────────────────────────────────────────
 * A banner may only load/run while its screen is focused AND the app is in
 * the foreground. On blur/background the component unmounts the native
 * BannerAd view entirely (destroy) and clears the refresh timer — zero ad
 * requests from invisible placements. */
function useBannerVisible(): boolean {
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) =>
      setAppActive(s === 'active')
    );
    return () => sub.remove();
  }, []);

  return isFocused && appActive;
}

/* ── The actual AdMob banner (official Google TEST unit ID) ─────────────── */
export function AdMobBanner() {
  const visible = useBannerVisible();
  const [refreshKey, setRefreshKey] = useState(0);

  // 60s hard-refresh timer — runs ONLY while visible; cleared on blur.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setRefreshKey(k => k + 1), BANNER_REFRESH_MS);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible) return null; // blur/background → native banner destroyed

  return (
    <BannerAd
      key={refreshKey}
      unitId={ADMOB_TEST_IDS.banner}
      size={BannerAdSize.BANNER}
      requestOptions={{ requestNonPersonalizedAdsOnly: true }}
      onAdLoaded={() => console.log('[Banner/AdMob] Loaded')}
      onAdFailedToLoad={(e: any) => console.warn('[Banner/AdMob] Failed:', e?.message ?? e)}
    />
  );
}

/* ── Sticky banner — absolute at bottom ─────────────────────────────────── */
export function StickyBannerAd() {
  if (Platform.OS === 'web' || !isAdMobAvailable() || !BannerAd) return null;
  return (
    <View style={styles.wrapper}>
      <AdMobBanner />
    </View>
  );
}

/* ── Inline banner — renders in content flow (hub top/bottom, tab bar) ──── */
export function InlineBannerAd() {
  if (Platform.OS === 'web' || !isAdMobAvailable() || !BannerAd) return null;
  return (
    <View style={inlineStyles.wrapper}>
      <AdMobBanner />
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
