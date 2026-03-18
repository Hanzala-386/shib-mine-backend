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
  admobUnitId:           string;
  admobRewardedId:       string;
  /* Unity Ads */
  unityGameId:           string;
  unityRewardedId:       string;
  unityInterstitialId:   string;
  unityBannerId:         string;
  /* AppLovin MAX */
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
  /** Game claim / general — rotates AdMob → Unity → AppLovin */
  showGameInterstitial:   (onDone: (shown: boolean) => void) => void;
  /** Mining & Withdraw ONLY — Unity → AppLovin (NO AdMob per policy) */
  showMiningInterstitial: (onDone: (shown: boolean) => void) => void;
  /** Rewarded (game double tokens) — rotates AdMob → Unity → AppLovin */
  showRewarded:           (onDone: (watched: boolean) => void) => void;
  /** @deprecated Use showGameInterstitial */
  showInterstitial:       (onDone: (shown: boolean) => void) => void;
}

/* ─── AdMob test IDs ─────────────────────────────────────────────────────────── */
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
  unityBannerId:          '',
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
 * Unity Ads SDK stub — uncomment when 'react-native-unity-ads' is installed via EAS Build:
 *   let UnityAds: any = null;
 *   try { UnityAds = require('react-native-unity-ads').default; } catch {}
 */
let UnityAds: any = null; // STUB — SDK not yet installed

/*
 * AppLovin MAX SDK stub — uncomment when 'applovin-max-react-native-plugin' is installed:
 *   let AppLovinMAX: any = null;
 *   try { AppLovinMAX = require('applovin-max-react-native-plugin').default; } catch {}
 */
let AppLovinMAX: any = null; // STUB — SDK not yet installed

export { BannerAdComponent, BannerAdSize, nativeSdkAvailable };

/* ─── Banner provider rotation order ────────────────────────────────────────── */
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

  const settingsRef    = useRef<AdSettings>(DEFAULT_SETTINGS);
  const bannerIdxRef   = useRef(0);
  const gameIntIdxRef  = useRef(0); // rotation index for game interstitial
  const rewardedIdxRef = useRef(0); // rotation index for rewarded

  /* ── Banner provider rotation every 30s ── */
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const id = setInterval(() => {
      bannerIdxRef.current = (bannerIdxRef.current + 1) % BANNER_PROVIDERS.length;
      setBannerProvider(BANNER_PROVIDERS[bannerIdxRef.current]);
      console.log('[AdContext] Banner rotated to:', BANNER_PROVIDERS[bannerIdxRef.current]);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

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
          unityBannerId:         s.unityBannerId           || '',
          applovinSdkKey:        s.applovinSdkKey          || '',
          applovinRewardedId:    s.applovinRewardedId      || '',
          applovinBannerId:      s.applovinBannerId        || '',
          applovinInterstitialId: s.applovinInterstitialId || '',
        };
        settingsRef.current = merged;
        setSettings(merged);

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

  /* ── Helper: try Unity interstitial ── */
  function _tryUnityInterstitial(placementId: string, onSuccess: () => void, onFail: () => void) {
    if (!UnityAds || !placementId) { onFail(); return; }
    try {
      /*
       * REAL Unity interstitial (uncomment when SDK is installed):
       * UnityAds.show(placementId, {
       *   onStart:  () => console.log('[Unity] Interstitial started'),
       *   onFinish: () => { console.log('[Unity] Interstitial finished'); onSuccess(); },
       *   onError:  (e: any) => { console.warn('[Unity] Interstitial error:', e); onFail(); },
       * });
       */
      console.log('[AdContext] Unity stub: would show interstitial', placementId);
      onFail(); // SDK not installed — fall through
    } catch (e: any) {
      console.warn('[AdContext] Unity Interstitial exception:', e.message);
      onFail();
    }
  }

  /* ── Helper: try AppLovin interstitial ── */
  function _tryAppLovinInterstitial(placementId: string, onSuccess: () => void, onFail: () => void) {
    if (!AppLovinMAX || !placementId) { onFail(); return; }
    try {
      /*
       * REAL AppLovin interstitial (uncomment when SDK is installed):
       * AppLovinMAX.showInterstitial(placementId);
       * AppLovinMAX.setInterstitialListener({
       *   onAdHidden:     () => { console.log('[AppLovin] Interstitial hidden'); onSuccess(); },
       *   onAdLoadFailed: (code: string) => { console.warn('[AppLovin] Interstitial load failed:', code); onFail(); },
       * });
       */
      console.log('[AdContext] AppLovin stub: would show interstitial', placementId);
      onFail(); // SDK not installed — fall through
    } catch (e: any) {
      console.warn('[AdContext] AppLovin Interstitial exception:', e.message);
      onFail();
    }
  }

  /* ── 3. Game interstitial — rotate AdMob → Unity → AppLovin ── */
  const showGameInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const s   = settingsRef.current;
    const idx = gameIntIdxRef.current;
    const NET: BannerProvider[] = ['admob', 'unity', 'applovin'];
    const network = NET[idx % NET.length];
    gameIntIdxRef.current = (idx + 1) % NET.length;
    console.log('[AdContext] Game interstitial using network:', network);

    if (network === 'unity') {
      _tryUnityInterstitial(s.unityInterstitialId, () => onDone(true), () => {
        _tryAppLovinInterstitial(s.applovinInterstitialId, () => onDone(true), () => {
          _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone);
        });
      });
    } else if (network === 'applovin') {
      _tryAppLovinInterstitial(s.applovinInterstitialId, () => onDone(true), () => {
        _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone);
      });
    } else {
      _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone);
    }
  }, [sdkReady]);

  /* ── 4. Mining/Withdraw interstitial — Unity → AppLovin ONLY (NO AdMob per policy) ── */
  const showMiningInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const s = settingsRef.current;
    console.log('[AdContext] Mining interstitial — Unity → AppLovin (no AdMob per policy)');

    _tryUnityInterstitial(s.unityInterstitialId, () => onDone(true), () => {
      _tryAppLovinInterstitial(s.applovinInterstitialId, () => onDone(true), () => {
        // Neither Unity nor AppLovin available — proceed without ad (no AdMob here per policy)
        console.log('[AdContext] Mining: no Unity/AppLovin available, proceeding without ad');
        onDone(true);
      });
    });
  }, [sdkReady]);

  /* ── Deprecated alias ── */
  const showInterstitial = showGameInterstitial;

  /* ── 5. Rewarded video — rotate AdMob → Unity → AppLovin ── */
  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    const s   = settingsRef.current;
    const idx = rewardedIdxRef.current;
    const NET: BannerProvider[] = ['admob', 'unity', 'applovin'];
    const network = NET[idx % NET.length];
    rewardedIdxRef.current = (idx + 1) % NET.length;
    console.log('[AdContext] Rewarded using network:', network);

    const unitId = s.admobRewardedId || TEST_IDS.REWARDED;

    /* Unity rewarded stub */
    function _tryUnityRewarded(onSuccess: () => void, onFail: () => void) {
      if (!UnityAds || !s.unityRewardedId) { onFail(); return; }
      try {
        /*
         * REAL Unity rewarded (uncomment when SDK is installed):
         * UnityAds.show(s.unityRewardedId, {
         *   onStart:    () => {},
         *   onFinish:   (state: string) => { onSuccess(); },
         *   onError:    () => onFail(),
         * });
         */
        console.log('[AdContext] Unity stub: would show rewarded', s.unityRewardedId);
        onFail();
      } catch { onFail(); }
    }

    /* AppLovin rewarded stub */
    function _tryAppLovinRewarded(onSuccess: () => void, onFail: () => void) {
      if (!AppLovinMAX || !s.applovinRewardedId) { onFail(); return; }
      try {
        /*
         * REAL AppLovin rewarded (uncomment when SDK is installed):
         * AppLovinMAX.showRewardedAd(s.applovinRewardedId);
         * AppLovinMAX.setRewardedAdListener({
         *   onAdReceived:     () => {},
         *   onUserRewarded:   () => onSuccess(),
         *   onAdLoadFailed:   () => onFail(),
         * });
         */
        console.log('[AdContext] AppLovin stub: would show rewarded', s.applovinRewardedId);
        onFail();
      } catch { onFail(); }
    }

    /* AdMob rewarded */
    function _showAdMobRewarded() {
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
    }

    if (network === 'unity') {
      _tryUnityRewarded(() => onDone(true), () => {
        _tryAppLovinRewarded(() => onDone(true), () => _showAdMobRewarded());
      });
    } else if (network === 'applovin') {
      _tryAppLovinRewarded(() => onDone(true), () => _showAdMobRewarded());
    } else {
      _showAdMobRewarded();
    }
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
