import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import { Platform } from 'react-native';
import { getApiUrl } from '@/lib/query-client';

/* ─── Types ─────────────────────────────────────────────────────────────────── */
export interface AdSettings {
  showAds:               boolean;
  activeAdNetwork:       string;
  admobBannerUnitId:     string;
  admobUnitId:           string;
  admobRewardedId:       string;
  /* Unity / AppLovin IDs are still stored in DB for mediation reference */
  unityGameId:           string;
  unityRewardedId:       string;
  unityInterstitialId:   string;
  unityBannerId:         string;
  applovinSdkKey:        string;
  applovinRewardedId:    string;
  applovinBannerId:      string;
  applovinInterstitialId: string;
}

export type BannerProvider = 'admob' | 'unity' | 'applovin';

interface AdContextValue {
  settings:               AdSettings;
  sdkReady:               boolean;
  isAdLoading:            boolean;
  bannerProvider:         BannerProvider;
  showGameInterstitial:   (onDone: (shown: boolean) => void) => void;
  showMiningInterstitial: (onDone: (shown: boolean) => void) => void;
  showRewarded:           (onDone: (watched: boolean) => void) => void;
  showInterstitial:       (onDone: (shown: boolean) => void) => void;
}

/* ─── AdMob test IDs ─────────────────────────────────────────────────────────── */
export const TEST_IDS = {
  BANNER:       'ca-app-pub-3940256099942544/6300978111',
  INTERSTITIAL: 'ca-app-pub-3940256099942544/1033173712',
  REWARDED:     'ca-app-pub-3940256099942544/5224354917',
};

const DEFAULT_SETTINGS: AdSettings = {
  showAds: false,
  activeAdNetwork: '',
  admobBannerUnitId:      TEST_IDS.BANNER,
  admobUnitId:            TEST_IDS.INTERSTITIAL,
  admobRewardedId:        TEST_IDS.REWARDED,
  unityGameId:            '',
  unityRewardedId:        '',
  unityInterstitialId:    '',
  unityBannerId:          '',
  applovinSdkKey:         '',
  applovinRewardedId:     '',
  applovinBannerId:       '',
  applovinInterstitialId: '',
};

/* ─── AdMob SDK (react-native-google-mobile-ads) ────────────────────────────── */
let GoogleAds: any            = null;
let AdEventType: any          = null;
let RewardedAdEventType: any  = null;
let BannerAdSize: any         = null;
let InterstitialAdClass: any  = null;
let RewardedAdClass: any      = null;
let BannerAdComponent: any    = null;
let nativeSdkAvailable        = false;

if (Platform.OS !== 'web') {
  try {
    const pkg = require('react-native-google-mobile-ads');
    GoogleAds           = pkg.default;
    AdEventType         = pkg.AdEventType;
    RewardedAdEventType = pkg.RewardedAdEventType;
    BannerAdSize        = pkg.BannerAdSize;
    InterstitialAdClass = pkg.InterstitialAd;
    RewardedAdClass     = pkg.RewardedAd;
    BannerAdComponent   = pkg.BannerAd;
    nativeSdkAvailable  = true;
    console.log('[AdContext] AdMob SDK loaded ✓');
  } catch {
    console.log('[AdContext] react-native-google-mobile-ads not available (Expo Go / web)');
  }
}

/*
 * Unity Ads and AppLovin MAX are handled via AdMob Mediation Gradle adapters:
 *   com.google.ads.mediation:unity     — injected by withAndroidConfig plugin
 *   com.applovin:applovin-sdk          — injected by withAndroidConfig plugin
 *   com.google.ads.mediation:applovin  — injected by withAndroidConfig plugin
 *
 * AdMob's SDK automatically picks the winning network at runtime.
 * No direct Unity / AppLovin SDK calls are needed.
 */
export const ALAdView   = null;
export const ALAdFormat = null;
export { BannerAdComponent, BannerAdSize, nativeSdkAvailable };

/* ─── Banner provider rotation (cosmetic — mediation picks the real network) ── */
const BANNER_PROVIDERS: BannerProvider[] = ['admob', 'unity', 'applovin'];

/* ─── Context ────────────────────────────────────────────────────────────────── */
const AdContext = createContext<AdContextValue>({
  settings:               DEFAULT_SETTINGS,
  sdkReady:               false,
  isAdLoading:            false,
  bannerProvider:         'admob',
  showGameInterstitial:   (cb) => setTimeout(() => cb(true), 2500),
  showMiningInterstitial: (cb) => setTimeout(() => cb(true), 2500),
  showRewarded:           (cb) => setTimeout(() => cb(true), 4000),
  showInterstitial:       (cb) => setTimeout(() => cb(true), 2500),
});

export function useAds() { return useContext(AdContext); }

/* ─── Provider ───────────────────────────────────────────────────────────────── */
export function AdProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings]         = useState<AdSettings>(DEFAULT_SETTINGS);
  const [sdkReady, setSdkReady]         = useState(false);
  const [isAdLoading, setAdLoading]     = useState(false);
  const [bannerProvider, setBannerProvider] = useState<BannerProvider>('admob');

  const settingsRef  = useRef<AdSettings>(DEFAULT_SETTINGS);
  const bannerIdxRef = useRef(0);

  /* ── Banner provider rotation every 30s (visual only — mediation picks network) ── */
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const id = setInterval(() => {
      bannerIdxRef.current = (bannerIdxRef.current + 1) % BANNER_PROVIDERS.length;
      setBannerProvider(BANNER_PROVIDERS[bannerIdxRef.current]);
      console.log('[AdContext] Banner slot rotated to:', BANNER_PROVIDERS[bannerIdxRef.current]);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  /* ── 1. Fetch Ad IDs from PocketBase at launch ── */
  useEffect(() => {
    const url = new URL('/api/app/settings', getApiUrl()).href;
    fetch(url)
      .then(r => r.json())
      .then((s: Partial<AdSettings> & Record<string, any>) => {
        const merged: AdSettings = {
          showAds:               !!s.showAds,
          activeAdNetwork:       s.activeAdNetwork         || '',
          admobBannerUnitId:     s.admobBannerUnitId       || TEST_IDS.BANNER,
          admobUnitId:           s.admobUnitId             || TEST_IDS.INTERSTITIAL,
          admobRewardedId:       s.admobRewardedId         || TEST_IDS.REWARDED,
          unityGameId:           s.unityGameId             || '',
          unityRewardedId:       s.unityRewardedId         || '',
          unityInterstitialId:   s.unityInterstitialId     || '',
          unityBannerId:         s.unityBannerId           || '',
          applovinSdkKey:        s.applovinSdkKey          || '',
          applovinRewardedId:    s.applovinRewardedId      || '',
          applovinBannerId:      s.applovinBannerId        || '',
          applovinInterstitialId: s.applovinInterstitialId || '',
        };
        settingsRef.current = merged;
        setSettings(merged);
        console.log('[AdContext] Settings loaded from PocketBase ✓');
      })
      .catch(e => console.warn('[AdContext] Failed to fetch settings:', e));
  }, []);

  /* ── 2. Initialize AdMob SDK ── */
  useEffect(() => {
    if (!nativeSdkAvailable || !GoogleAds) {
      setSdkReady(false);
      return;
    }
    GoogleAds().initialize()
      .then((statuses: any[]) => {
        console.log('[AdContext] AdMob initialized (mediation ready):', JSON.stringify(statuses));
        setSdkReady(true);
      })
      .catch((e: Error) => {
        console.warn('[AdContext] AdMob init failed:', e.message);
        setSdkReady(false);
      });
  }, []);

  /* ── AdMob interstitial helper ── */
  function _showAdMobInterstitial(unitId: string, onDone: (shown: boolean) => void) {
    if (!unitId) { onDone(false); return; }
    if (!nativeSdkAvailable || !InterstitialAdClass || !sdkReady) {
      onDone(true);
      return;
    }
    setAdLoading(true);
    const cleanup: Array<() => void> = [];
    try {
      const ad = InterstitialAdClass.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true });
      cleanup.push(ad.addAdEventListener(AdEventType.LOADED,  () => { setAdLoading(false); ad.show(); }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED,  () => { cleanup.forEach(fn => fn()); onDone(true); }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR,   (e: Error) => {
        console.warn('[AdMob] Interstitial error:', e.message);
        cleanup.forEach(fn => fn()); setAdLoading(false); onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdMob] Interstitial exception:', e.message);
      setAdLoading(false); onDone(false);
    }
  }

  /* ── AdMob rewarded helper ── */
  function _showAdMobRewarded(unitId: string, onDone: (watched: boolean) => void) {
    if (!unitId) { onDone(false); return; }
    if (!nativeSdkAvailable || !RewardedAdClass || !sdkReady) {
      onDone(true);
      return;
    }
    setAdLoading(true);
    let rewarded = false;
    const cleanup: Array<() => void> = [];
    try {
      const ad = RewardedAdClass.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true });
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.LOADED,        () => { setAdLoading(false); ad.show(); }));
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => { rewarded = true; }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED, () => { cleanup.forEach(fn => fn()); onDone(rewarded); }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR,  (e: Error) => {
        console.warn('[AdMob] Rewarded error:', e.message);
        cleanup.forEach(fn => fn()); setAdLoading(false); onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdMob] Rewarded exception:', e.message);
      setAdLoading(false); onDone(false);
    }
  }

  /* ── 3. Game interstitial — AdMob (mediation picks Unity / AppLovin automatically) ── */
  const showGameInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const unitId = settingsRef.current.admobUnitId || TEST_IDS.INTERSTITIAL;
    console.log('[AdContext] Game interstitial via AdMob mediation, unitId:', unitId);
    _showAdMobInterstitial(unitId, onDone);
  }, [sdkReady]);

  /* ── 4. Mining/Withdraw/Booster interstitial — AdMob mediation (Unity/AppLovin auto-selected) ── */
  const showMiningInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const unitId = settingsRef.current.admobUnitId || TEST_IDS.INTERSTITIAL;
    console.log('[AdContext] Mining interstitial via AdMob mediation, unitId:', unitId);
    _showAdMobInterstitial(unitId, onDone);
  }, [sdkReady]);

  const showInterstitial = showGameInterstitial;

  /* ── 5. Rewarded — AdMob (mediation picks Unity / AppLovin automatically) ── */
  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    const unitId = settingsRef.current.admobRewardedId || TEST_IDS.REWARDED;
    console.log('[AdContext] Rewarded via AdMob mediation, unitId:', unitId);
    _showAdMobRewarded(unitId, onDone);
  }, [sdkReady]);

  return (
    <AdContext.Provider value={{
      settings, sdkReady, isAdLoading, bannerProvider,
      showGameInterstitial, showMiningInterstitial, showRewarded, showInterstitial,
    }}>
      {children}
    </AdContext.Provider>
  );
}
