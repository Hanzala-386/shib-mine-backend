import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  BannerAdComponent,
  BannerAdSize,
  nativeSdkAvailable,
  TEST_IDS,
  ALAdView,
  ALAdFormat,
  useAds,
  type BannerProvider,
} from '@/context/AdContext';

export const BANNER_HEIGHT = 50;

/* ── AdMob banner ─────────────────────────────────────────────────────────── */
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

/* ── AppLovin MAX banner (react-native-applovin-max AdView) ─────────────── */
function AppLovinBanner({ adUnitId }: { adUnitId: string }) {
  if (!adUnitId || !ALAdView || !ALAdFormat) {
    console.log('[Banner/AppLovin] Skipped — SDK not available or adUnitId empty');
    return null;
  }
  try {
    return (
      <ALAdView
        adUnitId={adUnitId}
        adFormat={ALAdFormat?.BANNER ?? 'BANNER'}
        onAdLoaded={() => console.log('[Banner/AppLovin] Loaded adUnitId=', adUnitId)}
        onAdLoadFailed={(errorCode: any) => console.warn('[Banner/AppLovin] Failed:', errorCode)}
        style={{ width: '100%', height: BANNER_HEIGHT }}
      />
    );
  } catch (e: any) {
    console.warn('[Banner/AppLovin] Render error:', e.message);
    return null;
  }
}

/* ── Unity Ads — no React Native banner component in this SDK; fall through to AdMob ── */
function UnityBannerFallback({ fallbackUnitId }: { fallbackUnitId: string }) {
  console.log('[Banner/Unity] No banner component in react-native-unity-ads; showing AdMob fallback');
  return <AdMobBanner unitId={fallbackUnitId} />;
}

/* ── Main sticky banner component ─────────────────────────────────────────── */
export function StickyBannerAd() {
  const { settings, bannerProvider } = useAds();

  if (Platform.OS === 'web') return null;

  const renderBanner = (provider: BannerProvider) => {
    switch (provider) {
      case 'unity':
        return (
          <UnityBannerFallback
            fallbackUnitId={settings.admobBannerUnitId || TEST_IDS.BANNER}
          />
        );
      case 'applovin':
        if (settings.applovinBannerId && ALAdView) {
          return <AppLovinBanner adUnitId={settings.applovinBannerId} />;
        }
        return <AdMobBanner unitId={settings.admobBannerUnitId || TEST_IDS.BANNER} />;
      case 'admob':
      default:
        return <AdMobBanner unitId={settings.admobBannerUnitId || TEST_IDS.BANNER} />;
    }
  };

  const banner = renderBanner(bannerProvider);
  if (!banner) return null;

  return (
    <View style={styles.wrapper} key={`banner-${bannerProvider}`}>
      {banner}
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
