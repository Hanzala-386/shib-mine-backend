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
import { configureAds } from '@/lib/AdService';

/* ─── Types ─────────────────────────────────────────────────────────────────── */
export interface AdSettings {
  showAds:               boolean;
  activeAdNetwork:       string;
  /* AdMob */
  admobBannerUnitId:     string;
  admobUnitId:           string;   // interstitial (boosters / rewarded)
  admobRewardedId:       string;   // rewarded video
  /* Unity Ads — loaded from PocketBase, SDK stub ready */
  unityGameId:           string;
  unityRewardedId:       string;
  unityInterstitialId:   string;   // used on Mining/Withdraw buttons
  /* AppLovin MAX — loaded from PocketBase, SDK stub ready */
  applovinSdkKey:        string;
  applovinRewardedId:    string;
  applovinBannerId:      string;
  applovinInterstitialId: string;  // used on Mining/Withdraw buttons
}

interface AdContextValue {
  settings:                 AdSettings;
  sdkReady:                 boolean;
  isAdLoading:              boolean;
  /** For booster purchases / general use — uses AdMob */
  showInterstitial:         (onDone: (shown: boolean) => void) => void;
  /** For Mining & Withdraw buttons — Unity → AppLovin → AdMob waterfall */
  showMiningInterstitial:   (onDone: (shown: boolean) => void) => void;
  showRewarded:             (onDone: (watched: boolean) => void) => void;
}

/* ─── AdMob test IDs — fallback when real IDs are empty ─────────────────────── */
export const TEST_IDS = {
  BANNER:       'ca-app-pub-3940256099942544/6300978111',
  INTERSTITIAL: 'ca-app-pub-3940256099942544/1033173712',
  REWARDED:     'ca-app-pub-3940256099942544/5224354917',
  APP_ANDROID:  'ca-app-pub-3940256099942544~3347511713',
  APP_IOS:      'ca-app-pub-3940256099942544~1458002511',
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
  applovinSdkKey:         '',
  applovinRewardedId:     '',
  applovinBannerId:       '',
  applovinInterstitialId: '',
};

/* ─── AdMob SDK — dynamic require so Expo Go doesn't crash ──────────────────── */
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
  } catch {
    console.log('[AdContext] react-native-google-mobile-ads not available (Expo Go)');
  }
}

/*
 * Unity Ads SDK stub — uncomment and replace with real import when the
 * 'react-native-unity-ads' (or equivalent) package is installed via EAS Build:
 *
 *   let UnityAds: any = null;
 *   try { UnityAds = require('react-native-unity-ads').default; } catch {}
 */
let UnityAds: any = null; // STUB — SDK not yet installed

/*
 * AppLovin MAX SDK stub — uncomment and replace with real import when
 * 'applovin-max-react-native-plugin' is installed via EAS Build:
 *
 *   let AppLovinMAX: any = null;
 *   try { AppLovinMAX = require('applovin-max-react-native-plugin').default; } catch {}
 */
let AppLovinMAX: any = null; // STUB — SDK not yet installed

export { BannerAdComponent, BannerAdSize, nativeSdkAvailable };

/* ─── Context ────────────────────────────────────────────────────────────────── */
const AdContext = createContext<AdContextValue>({
  settings:               DEFAULT_SETTINGS,
  sdkReady:               false,
  isAdLoading:            false,
  showInterstitial:       (cb) => setTimeout(() => cb(true), 2500),
  showMiningInterstitial: (cb) => setTimeout(() => cb(true), 2500),
  showRewarded:           (cb) => setTimeout(() => cb(true), 4000),
});

export function useAds() { return useContext(AdContext); }

/* ─── Provider ───────────────────────────────────────────────────────────────── */
export function AdProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings]     = useState<AdSettings>(DEFAULT_SETTINGS);
  const [sdkReady, setSdkReady]     = useState(false);
  const [isAdLoading, setAdLoading] = useState(false);
  const settingsRef = useRef<AdSettings>(DEFAULT_SETTINGS);

  /* ── 1. Fetch all Ad IDs from PocketBase at launch ── */
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
          applovinSdkKey:        s.applovinSdkKey          || '',
          applovinRewardedId:    s.applovinRewardedId      || '',
          applovinBannerId:      s.applovinBannerId        || '',
          applovinInterstitialId: s.applovinInterstitialId || '',
        };
        settingsRef.current = merged;
        setSettings(merged);

        /* Wire all IDs into AdService so it uses PocketBase values */
        configureAds({
          admobBannerId:          merged.admobBannerUnitId,
          admobInterstitialId:    merged.admobUnitId,
          admobRewardedId:        merged.admobRewardedId,
          unityGameId:            merged.unityGameId,
          unityInterstitialId:    merged.unityInterstitialId,
          unityRewardedId:        merged.unityRewardedId,
          applovinSdkKey:         merged.applovinSdkKey,
          applovinInterstitialId: merged.applovinInterstitialId,
          applovinBannerId:       merged.applovinBannerId,
          applovinRewardedId:     merged.applovinRewardedId,
        });

        console.log('[AdContext] Settings loaded from PocketBase ✓');

        /* ── Initialize Unity Ads once Game ID is known ── */
        if (UnityAds && merged.unityGameId) {
          try {
            /*
             * REAL Unity init (uncomment when SDK is installed):
             * UnityAds.initialize(merged.unityGameId, false, true);
             */
            console.log('[AdContext] Unity stub: would init with gameId', merged.unityGameId);
          } catch (e: any) {
            console.warn('[AdContext] Unity init error:', e.message);
          }
        }

        /* ── Initialize AppLovin MAX once SDK key is known ── */
        if (AppLovinMAX && merged.applovinSdkKey) {
          try {
            /*
             * REAL AppLovin init (uncomment when SDK is installed):
             * AppLovinMAX.initialize(merged.applovinSdkKey, () => {
             *   console.log('[AdContext] AppLovin initialized ✓');
             * });
             */
            console.log('[AdContext] AppLovin stub: would init with sdk key');
          } catch (e: any) {
            console.warn('[AdContext] AppLovin init error:', e.message);
          }
        }
      })
      .catch(e => console.warn('[AdContext] Failed to fetch settings:', e));
  }, []);

  /* ── 2. Initialize AdMob SDK ── */
  useEffect(() => {
    if (!nativeSdkAvailable || !GoogleAds) {
      console.log('[AdContext] SDK init skipped (not available in this env)');
      setSdkReady(false);
      return;
    }
    GoogleAds().initialize()
      .then((statuses: any[]) => {
        console.log('[AdContext] AdMob SDK initialized:', JSON.stringify(statuses));
        setSdkReady(true);
      })
      .catch((e: Error) => {
        console.warn('[AdContext] AdMob SDK init failed:', e.message);
        setSdkReady(false);
      });
  }, []);

  /* ── Helper: show AdMob interstitial ── */
  function _showAdMobInterstitial(unitId: string, onDone: (shown: boolean) => void) {
    if (!nativeSdkAvailable || !InterstitialAdClass || !sdkReady) {
      console.log('[AdContext] AdMob Interstitial: simulating (3s)');
      setAdLoading(true);
      setTimeout(() => { setAdLoading(false); onDone(true); }, 3000);
      return;
    }
    setAdLoading(true);
    const cleanup: Array<() => void> = [];
    try {
      const ad = InterstitialAdClass.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true });
      cleanup.push(ad.addAdEventListener(AdEventType.LOADED, () => { setAdLoading(false); ad.show(); }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED, () => { cleanup.forEach(fn => fn()); onDone(true); }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR, (e: Error) => {
        console.warn('[AdContext] AdMob Interstitial error:', e.message);
        cleanup.forEach(fn => fn()); setAdLoading(false); onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdContext] AdMob Interstitial exception:', e.message);
      setAdLoading(false);
      onDone(false);
    }
  }

  /* ── 3. General interstitial — AdMob (for boosters etc.) ── */
  const showInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const s = settingsRef.current;
    _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone);
  }, [sdkReady]);

  /* ── 4. Mining/Withdraw interstitial — Unity → AppLovin → AdMob waterfall ── */
  const showMiningInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const s = settingsRef.current;

    /* ── Try Unity Ads first ── */
    if (UnityAds && s.unityInterstitialId) {
      console.log('[AdContext] Mining: trying Unity interstitial', s.unityInterstitialId);
      try {
        /*
         * REAL Unity interstitial (uncomment when SDK is installed):
         * UnityAds.show(s.unityInterstitialId, {
         *   onStart:    () => console.log('[Unity] Ad started'),
         *   onFinish:   () => onDone(true),
         *   onError:    () => _tryAppLovin(),
         * });
         */
        // SDK stub — fall through to AppLovin
        _tryAppLovin();
      } catch {
        _tryAppLovin();
      }
      return;
    }
    _tryAppLovin();

    /* ── AppLovin MAX fallback ── */
    function _tryAppLovin() {
      if (AppLovinMAX && s.applovinInterstitialId) {
        console.log('[AdContext] Mining: trying AppLovin interstitial', s.applovinInterstitialId);
        try {
          /*
           * REAL AppLovin interstitial (uncomment when SDK is installed):
           * AppLovinMAX.showInterstitial(s.applovinInterstitialId);
           * AppLovinMAX.addAdHiddenEventListener(() => onDone(true));
           * AppLovinMAX.addAdLoadFailedEventListener(() => _tryAdMob());
           */
          // SDK stub — fall through to AdMob
          _tryAdMob();
        } catch {
          _tryAdMob();
        }
        return;
      }
      _tryAdMob();
    }

    /* ── AdMob final fallback ── */
    function _tryAdMob() {
      console.log('[AdContext] Mining: falling back to AdMob interstitial');
      _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone);
    }
  }, [sdkReady]);

  /* ── 5. Rewarded video — AdMob ── */
  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    const s = settingsRef.current;
    const unitId = s.admobRewardedId || TEST_IDS.REWARDED;

    if (!nativeSdkAvailable || !RewardedAdClass || !sdkReady) {
      console.log('[AdContext] Rewarded: simulating (5s)');
      setAdLoading(true);
      setTimeout(() => { setAdLoading(false); onDone(true); }, 5000);
      return;
    }

    setAdLoading(true);
    let rewarded = false;
    const cleanup: Array<() => void> = [];
    try {
      const ad = RewardedAdClass.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true });
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.LOADED, () => { setAdLoading(false); ad.show(); }));
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => { rewarded = true; }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED, () => { cleanup.forEach(fn => fn()); onDone(rewarded); }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR, (e: Error) => {
        console.warn('[AdContext] Rewarded error:', e.message);
        cleanup.forEach(fn => fn()); setAdLoading(false); onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdContext] Rewarded exception:', e.message);
      setAdLoading(false);
      onDone(false);
    }
  }, [sdkReady]);

  return (
    <AdContext.Provider value={{ settings, sdkReady, isAdLoading, showInterstitial, showMiningInterstitial, showRewarded }}>
      {children}
    </AdContext.Provider>
  );
}
