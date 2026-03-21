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
 *
 * Layout: StickyBannerAd sits in the NORMAL FLEX FLOW below the tab bar.
 * Never use position: 'absolute' here — that causes the ad to overlay navigation.
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

/* ── Sticky banner — sits in flex flow BELOW the tab bar ─────────────────── */
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
    width: '100%',
    alignItems: 'center',
    backgroundColor: 'transparent',
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
