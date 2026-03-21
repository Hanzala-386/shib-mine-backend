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
 * All banners now go through AdMob (react-native-google-mobile-ads).
 * Unity Ads and AppLovin run as mediation adapters inside AdMob's SDK —
 * no separate banner component is needed for either network.
 */

/* ── AdMob banner (with mediation to Unity / AppLovin) ───────────────────── */
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

/* ── Sticky banner — sits above the bottom tab bar, visible on all screens ── */
export function StickyBannerAd() {
  const { settings } = useAds();
  if (Platform.OS === 'web') return null;

  const unitId = settings.admobBannerUnitId || TEST_IDS.BANNER;
  const banner = <AdMobBanner unitId={unitId} />;
  if (!banner) return null;

  return (
    <View style={styles.wrapper}>
      {banner}
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
    zIndex: 10,
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
