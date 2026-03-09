import React, { useRef, useEffect, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  BannerAdComponent,
  BannerAdSize,
  nativeSdkAvailable,
  TEST_IDS,
  useAds,
} from '@/context/AdContext';

export const BANNER_HEIGHT = 50;

export function StickyBannerAd() {
  const { settings } = useAds();
  const bannerKey = useRef(0);
  const [tick, setTick]     = useState(0);

  /* Auto-refresh every 30 seconds by remounting the BannerAd */
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const id = setInterval(() => {
      bannerKey.current += 1;
      setTick(t => t + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  /* Don't render on web */
  if (Platform.OS === 'web') return null;

  /* Don't render if native SDK is not available (Expo Go) */
  if (!nativeSdkAvailable || !BannerAdComponent) return null;

  const unitId = settings.admobBannerUnitId || TEST_IDS.BANNER;

  return (
    <View style={styles.wrapper}>
      <BannerAdComponent
        key={`banner-${bannerKey.current}-${tick}`}
        unitId={unitId}
        size={BannerAdSize?.ANCHORED_ADAPTIVE_BANNER || 'ANCHORED_ADAPTIVE_BANNER'}
        requestOptions={{ requestNonPersonalizedAdsOnly: true }}
        onAdFailedToLoad={(e: Error) => console.warn('[Banner] Failed:', e.message)}
        onAdLoaded={() => console.log('[Banner] Loaded unitId=', unitId)}
      />
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
