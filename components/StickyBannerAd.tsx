import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  BannerAdComponent,
  BannerAdSize,
  nativeSdkAvailable,
  TEST_IDS,
  useAds,
  type BannerProvider,
} from '@/context/AdContext';

export const BANNER_HEIGHT = 50;

/*
 * StickyBannerAd — rotates between AdMob, Unity Ads, and AppLovin MAX every 30s.
 *
 * Rotation is driven by `bannerProvider` from AdContext (incremented on a 30s timer there).
 *
 * AdMob: rendered via react-native-google-mobile-ads <BannerAd> component.
 * Unity / AppLovin: rendered via their respective SDK components once installed.
 *   Replace the stub <View> blocks below with the real SDK banner components.
 *
 * Unity banner (uncomment when SDK is installed):
 *   import { BannerView } from 'react-native-unity-ads';
 *   <BannerView placementId={settings.unityBannerId} size="BANNER" />
 *
 * AppLovin banner (uncomment when SDK is installed):
 *   import AppLovinMAX from 'applovin-max-react-native-plugin';
 *   <AppLovinMAX.AdView adUnitId={settings.applovinBannerId} adFormat="Banner" />
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

function UnityBanner({ placementId }: { placementId: string }) {
  /*
   * REAL Unity banner (uncomment when 'react-native-unity-ads' is installed):
   * const { BannerView } = require('react-native-unity-ads');
   * return (
   *   <BannerView
   *     placementId={placementId}
   *     size="BANNER"
   *     onLoad={() => console.log('[Banner/Unity] Loaded')}
   *     onError={(e: any) => console.warn('[Banner/Unity] Error:', e)}
   *   />
   * );
   */
  console.log('[Banner/Unity] Stub — SDK not yet installed. PlacementId:', placementId);
  return null; // Shows nothing until SDK is installed
}

function AppLovinBanner({ adUnitId }: { adUnitId: string }) {
  /*
   * REAL AppLovin banner (uncomment when 'applovin-max-react-native-plugin' is installed):
   * const AppLovinMAX = require('applovin-max-react-native-plugin').default;
   * return (
   *   <AppLovinMAX.AdView
   *     adUnitId={adUnitId}
   *     adFormat="Banner"
   *     onAdLoaded={() => console.log('[Banner/AppLovin] Loaded')}
   *     onAdLoadFailed={(errorCode: string) => console.warn('[Banner/AppLovin] Error:', errorCode)}
   *   />
   * );
   */
  console.log('[Banner/AppLovin] Stub — SDK not yet installed. AdUnitId:', adUnitId);
  return null; // Shows nothing until SDK is installed
}

export function StickyBannerAd() {
  const { settings, bannerProvider } = useAds();

  if (Platform.OS === 'web') return null;

  const renderBanner = (provider: BannerProvider) => {
    switch (provider) {
      case 'unity':
        return <UnityBanner placementId={settings.unityBannerId} />;
      case 'applovin':
        return <AppLovinBanner adUnitId={settings.applovinBannerId} />;
      case 'admob':
      default: {
        const unitId = settings.admobBannerUnitId || TEST_IDS.BANNER;
        return <AdMobBanner unitId={unitId} />;
      }
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
