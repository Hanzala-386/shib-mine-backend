import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  BannerAdComponent,
  BannerAdSize,
  nativeSdkAvailable,
  TEST_IDS,
  useAds,
} from '@/context/AdContext';

export const BANNER_HEIGHT = 50;

/*
 * Layout contract:
 *   - StickyBannerAd: position absolute, bottom: 0, zIndex: 5  (sits at very bottom)
 *   - Tab bar (in _layout.tsx): position absolute, bottom: BANNER_HEIGHT, zIndex: 20
 *   → Tab bar always renders ON TOP of the banner. Banner is below nav.
 */

function AdMobBanner({ unitId }: { unitId: string }) {
  if (!nativeSdkAvailable || !BannerAdComponent) return null;
  return (
    <BannerAdComponent
      unitId={unitId}
      size={BannerAdSize?.ANCHORED_ADAPTIVE_BANNER || 'ANCHORED_ADAPTIVE_BANNER'}
      requestOptions={{ requestNonPersonalizedAdsOnly: true }}
      onAdFailedToLoad={(e: Error) => console.warn('[Banner/AdMob] Failed:', e.message)}
      onAdLoaded={() => console.log('[Banner/AdMob] Loaded unitId=', unitId)}
    />
  );
}

/* ── Sticky banner — absolute at bottom, below tab bar ───────────────────── */
export function StickyBannerAd() {
  const { settings } = useAds();
  if (Platform.OS === 'web') return null;

  const unitId = settings.admobBannerUnitId || TEST_IDS.BANNER;

  return (
    <View style={styles.wrapper}>
      <AdMobBanner unitId={unitId} />
    </View>
  );
}

/* ── Inline banner — renders in content flow (between profile sections) ───── */
export function InlineBannerAd() {
  const { settings } = useAds();
  if (Platform.OS === 'web') return null;

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
    alignItems: 'center',
    backgroundColor: 'transparent',
    zIndex: 5,         // LOWER than tab bar (zIndex 20) → nav bar always on top
    elevation: 5,
  },
});

const inlineStyles = StyleSheet.create({
  wrapper: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: 'transparent',
    marginVertical: 8,
  },
});
