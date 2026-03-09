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
  showAds:             boolean;
  activeAdNetwork:     string;
  admobBannerUnitId:   string;
  admobUnitId:         string;   // interstitial
  admobRewardedId:     string;   // rewarded
  unityGameId:         string;
  unityRewardedId:     string;
  applovinSdkKey:      string;
  applovinRewardedId:  string;
}

interface AdContextValue {
  settings:          AdSettings;
  sdkReady:          boolean;
  isAdLoading:       boolean;
  showInterstitial:  (onDone: (shown: boolean) => void) => void;
  showRewarded:      (onDone: (watched: boolean) => void) => void;
}

/* ─── AdMob test IDs — used as fallback when real IDs are empty ──────────────── */
export const TEST_IDS = {
  BANNER:        'ca-app-pub-3940256099942544/6300978111',
  INTERSTITIAL:  'ca-app-pub-3940256099942544/1033173712',
  REWARDED:      'ca-app-pub-3940256099942544/5224354917',
  APP_ANDROID:   'ca-app-pub-3940256099942544~3347511713',
  APP_IOS:       'ca-app-pub-3940256099942544~1458002511',
};

const DEFAULT_SETTINGS: AdSettings = {
  showAds: false,
  activeAdNetwork: '',
  admobBannerUnitId: TEST_IDS.BANNER,
  admobUnitId: TEST_IDS.INTERSTITIAL,
  admobRewardedId: TEST_IDS.REWARDED,
  unityGameId: '6061517',
  unityRewardedId: '',
  applovinSdkKey: '',
  applovinRewardedId: '',
};

/* ─── Dynamically load the native SDK — gracefully fails in Expo Go ─────────── */
let GoogleAds: any = null;
let AdEventType: any = null;
let RewardedAdEventType: any = null;
let BannerAdSize: any = null;
let InterstitialAdClass: any = null;
let RewardedAdClass: any = null;
let BannerAdComponent: any = null;
let nativeSdkAvailable = false;

if (Platform.OS !== 'web') {
  try {
    const pkg = require('react-native-google-mobile-ads');
    GoogleAds = pkg.default;
    AdEventType = pkg.AdEventType;
    RewardedAdEventType = pkg.RewardedAdEventType;
    BannerAdSize = pkg.BannerAdSize;
    InterstitialAdClass = pkg.InterstitialAd;
    RewardedAdClass = pkg.RewardedAd;
    BannerAdComponent = pkg.BannerAd;
    nativeSdkAvailable = true;
  } catch (e) {
    console.log('[AdContext] react-native-google-mobile-ads not available (Expo Go)');
  }
}

export { BannerAdComponent, BannerAdSize, nativeSdkAvailable };

/* ─── Context ────────────────────────────────────────────────────────────────── */
const AdContext = createContext<AdContextValue>({
  settings: DEFAULT_SETTINGS,
  sdkReady: false,
  isAdLoading: false,
  showInterstitial: (cb) => setTimeout(() => cb(true), 2500),
  showRewarded:     (cb) => setTimeout(() => cb(true), 4000),
});

export function useAds() {
  return useContext(AdContext);
}

/* ─── Provider ───────────────────────────────────────────────────────────────── */
export function AdProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings]     = useState<AdSettings>(DEFAULT_SETTINGS);
  const [sdkReady, setSdkReady]     = useState(false);
  const [isAdLoading, setAdLoading] = useState(false);
  const settingsRef = useRef<AdSettings>(DEFAULT_SETTINGS);

  /* ── 1. Fetch settings from PocketBase ── */
  useEffect(() => {
    const base = getApiUrl();
    const url  = new URL('/api/app/settings', base).href;
    fetch(url)
      .then(r => r.json())
      .then((s: Partial<AdSettings> & Record<string, any>) => {
        const merged: AdSettings = {
          showAds:             !!s.showAds,
          activeAdNetwork:     s.activeAdNetwork     || '',
          admobBannerUnitId:   s.admobBannerUnitId   || TEST_IDS.BANNER,
          admobUnitId:         s.admobUnitId         || TEST_IDS.INTERSTITIAL,
          admobRewardedId:     s.admobRewardedId     || TEST_IDS.REWARDED,
          unityGameId:         s.unityGameId         || '6061517',
          unityRewardedId:     s.unityRewardedId     || '',
          applovinSdkKey:      s.applovinSdkKey      || '',
          applovinRewardedId:  s.applovinRewardedId  || '',
        };
        settingsRef.current = merged;
        setSettings(merged);
        console.log('[AdContext] Settings loaded:', JSON.stringify(merged));
      })
      .catch(e => console.warn('[AdContext] Failed to fetch settings:', e));
  }, []);

  /* ── 2. Initialize SDK once settings are loaded ── */
  useEffect(() => {
    if (!nativeSdkAvailable || !GoogleAds) {
      console.log('[AdContext] SDK init skipped (not available in this env)');
      setSdkReady(false);
      return;
    }
    GoogleAds().initialize()
      .then((statuses: any[]) => {
        console.log('[AdContext] SDK initialized:', JSON.stringify(statuses));
        setSdkReady(true);
      })
      .catch((e: Error) => {
        console.warn('[AdContext] SDK init failed:', e.message);
        setSdkReady(false);
      });
  }, []);

  /* ── Show interstitial with AdMob mediation waterfall ── */
  const showInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const s = settingsRef.current;
    const unitId = s.admobUnitId || TEST_IDS.INTERSTITIAL;

    if (!nativeSdkAvailable || !InterstitialAdClass || !sdkReady) {
      console.log('[AdContext] Interstitial: simulating (3s)');
      setAdLoading(true);
      setTimeout(() => { setAdLoading(false); onDone(true); }, 3000);
      return;
    }

    console.log('[AdContext] Loading interstitial:', unitId);
    setAdLoading(true);

    let ad: any = null;
    const cleanup: Array<() => void> = [];
    try {
      ad = InterstitialAdClass.createForAdRequest(unitId, {
        requestNonPersonalizedAdsOnly: true,
      });
      cleanup.push(ad.addAdEventListener(AdEventType.LOADED, () => {
        setAdLoading(false);
        ad.show();
      }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED, () => {
        cleanup.forEach(fn => fn());
        onDone(true);
      }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR, (e: Error) => {
        console.warn('[AdContext] Interstitial error:', e.message);
        cleanup.forEach(fn => fn());
        setAdLoading(false);
        onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdContext] Interstitial exception:', e.message);
      setAdLoading(false);
      onDone(false);
    }
  }, [sdkReady]);

  /* ── Show rewarded ad with AdMob mediation waterfall ── */
  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    const s = settingsRef.current;
    const unitId = s.admobRewardedId || TEST_IDS.REWARDED;

    if (!nativeSdkAvailable || !RewardedAdClass || !sdkReady) {
      console.log('[AdContext] Rewarded: simulating (5s)');
      setAdLoading(true);
      setTimeout(() => { setAdLoading(false); onDone(true); }, 5000);
      return;
    }

    console.log('[AdContext] Loading rewarded:', unitId);
    setAdLoading(true);

    let rewarded = false;
    let ad: any = null;
    const cleanup: Array<() => void> = [];
    try {
      ad = RewardedAdClass.createForAdRequest(unitId, {
        requestNonPersonalizedAdsOnly: true,
      });
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
        setAdLoading(false);
        ad.show();
      }));
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
        rewarded = true;
      }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED, () => {
        cleanup.forEach(fn => fn());
        onDone(rewarded);
      }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR, (e: Error) => {
        console.warn('[AdContext] Rewarded error:', e.message);
        cleanup.forEach(fn => fn());
        setAdLoading(false);
        onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdContext] Rewarded exception:', e.message);
      setAdLoading(false);
      onDone(false);
    }
  }, [sdkReady]);

  return (
    <AdContext.Provider value={{ settings, sdkReady, isAdLoading, showInterstitial, showRewarded }}>
      {children}
    </AdContext.Provider>
  );
}
