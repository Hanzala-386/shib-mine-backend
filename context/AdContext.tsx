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
  admobBannerUnitId:     string;
  admobUnitId:           string;
  admobRewardedId:       string;
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

/* ─── AdMob SDK ───────────────────────────────────────────────────────────────── */
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

/* ─── Unity Ads + AppLovin MAX — loaded via platform-specific module ─────────
 *   lib/native-ads.native.ts → loaded on Android/iOS (requires react-native-unity-ads
 *     and react-native-applovin-max to be linked in the native build)
 *   lib/native-ads.web.ts    → loaded on web (all exports are null stubs)
 * Metro bundler resolves the correct file at build time via the .native/.web suffix.
 * ─────────────────────────────────────────────────────────────────────────────── */
import {
  UnityAds,
  AppLovinMAX,
  ALInterstitial,
  ALRewarded,
  ALAdView as _ALAdView,
  ALAdFormat as _ALAdFormat,
} from '@/lib/native-ads';

export const ALAdView   = _ALAdView;
export const ALAdFormat = _ALAdFormat;

export { BannerAdComponent, BannerAdSize, nativeSdkAvailable };

/* ─── Banner provider rotation ───────────────────────────────────────────────── */
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
  const gameIntIdxRef  = useRef(0);
  const rewardedIdxRef = useRef(0);

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

        /* ── SDK INITS DISABLED FOR EXPO GO / WEB PREVIEW ──────────────────
         *  Uncomment these blocks before building the final APK.
         * ─────────────────────────────────────────────────────────────────── */

        // /* Initialize Unity Ads */
        // if (UnityAds && merged.unityGameId) {
        //   try {
        //     UnityAds.initialize(merged.unityGameId, false);
        //     console.log('[AdContext] Unity Ads initializing with gameId:', merged.unityGameId);
        //   } catch (e: any) {
        //     console.warn('[AdContext] Unity init error:', e.message);
        //   }
        // }

        // /* Initialize AppLovin MAX */
        // if (AppLovinMAX && merged.applovinSdkKey) {
        //   try {
        //     AppLovinMAX.initialize(merged.applovinSdkKey)
        //       .then(() => console.log('[AdContext] AppLovin MAX initialized ✓'))
        //       .catch((e: any) => console.warn('[AdContext] AppLovin init error:', e.message));
        //   } catch (e: any) {
        //     console.warn('[AdContext] AppLovin init exception:', e.message);
        //   }
        // }
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
        console.log('[AdContext] AdMob initialized:', JSON.stringify(statuses));
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
      console.log('[AdMob] Interstitial simulating (3s) unitId=', unitId);
      setAdLoading(true);
      setTimeout(() => { setAdLoading(false); onDone(true); }, 3000);
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

  /* ── Unity interstitial / rewarded helper ── */
  function _tryUnityAd(placementId: string, onSuccess: () => void, onFail: () => void) {
    // Null check: if SDK or placement ID missing, skip immediately
    if (!UnityAds || !placementId) {
      console.log('[Unity] Skipped — SDK not available or placementId empty');
      onFail(); return;
    }
    try {
      UnityAds.isReady(placementId, (isReady: boolean) => {
        if (!isReady) {
          console.log('[Unity] Ad not ready for placement:', placementId);
          onFail(); return;
        }
        let done = false;
        const onFinish = (pid: string, result: string) => {
          if (done) return; done = true;
          UnityAds.removeEventListener('onFinish', onFinish);
          UnityAds.removeEventListener('onError',  onError);
          console.log('[Unity] Ad finished, placement:', pid, 'result:', result);
          onSuccess();
        };
        const onError = (error: string, message: string) => {
          if (done) return; done = true;
          UnityAds.removeEventListener('onFinish', onFinish);
          UnityAds.removeEventListener('onError',  onError);
          console.warn('[Unity] Ad error:', error, message);
          onFail();
        };
        UnityAds.addEventListener('onFinish', onFinish);
        UnityAds.addEventListener('onError',  onError);
        UnityAds.show(placementId);
        console.log('[Unity] Showing ad placement:', placementId);
      });
    } catch (e: any) {
      console.warn('[Unity] Exception:', e.message);
      onFail();
    }
  }

  /* ── AppLovin interstitial helper ── */
  function _tryAppLovinInterstitial(placementId: string, onSuccess: () => void, onFail: () => void) {
    // Null check: if SDK or ad unit ID missing, skip immediately
    if (!AppLovinMAX || !ALInterstitial || !placementId) {
      console.log('[AppLovin] Interstitial skipped — SDK not available or adUnitId empty');
      onFail(); return;
    }
    try {
      let done = false;
      const finish = (succeeded: boolean) => {
        if (done) return; done = true;
        try {
          ALInterstitial.removeAdLoadedEventListener();
          ALInterstitial.removeAdHiddenEventListener();
          ALInterstitial.removeAdLoadFailedEventListener();
          ALInterstitial.removeAdFailedToDisplayEventListener();
        } catch {}
        setAdLoading(false);
        succeeded ? onSuccess() : onFail();
      };
      ALInterstitial.addAdLoadedEventListener(() => {
        console.log('[AppLovin] Interstitial loaded, showing:', placementId);
        ALInterstitial.showAd(placementId);
      });
      ALInterstitial.addAdHiddenEventListener(() => {
        console.log('[AppLovin] Interstitial hidden');
        finish(true);
      });
      ALInterstitial.addAdLoadFailedEventListener((info: any) => {
        console.warn('[AppLovin] Interstitial load failed:', info?.code);
        finish(false);
      });
      ALInterstitial.addAdFailedToDisplayEventListener((info: any) => {
        console.warn('[AppLovin] Interstitial display failed:', info?.code);
        finish(false);
      });
      setAdLoading(true);
      ALInterstitial.loadAd(placementId);
      console.log('[AppLovin] Loading interstitial:', placementId);
    } catch (e: any) {
      console.warn('[AppLovin] Interstitial exception:', e.message);
      setAdLoading(false); onFail();
    }
  }

  /* ── AppLovin rewarded helper ── */
  function _tryAppLovinRewarded(placementId: string, onSuccess: () => void, onFail: () => void) {
    if (!AppLovinMAX || !ALRewarded || !placementId) {
      console.log('[AppLovin] Rewarded skipped — SDK not available or adUnitId empty');
      onFail(); return;
    }
    try {
      let done = false; let rewarded = false;
      const finish = (succeeded: boolean) => {
        if (done) return; done = true;
        try {
          ALRewarded.removeAdLoadedEventListener();
          ALRewarded.removeAdHiddenEventListener();
          ALRewarded.removeAdLoadFailedEventListener();
          ALRewarded.removeAdFailedToDisplayEventListener();
          ALRewarded.removeAdReceivedRewardEventListener?.();
        } catch {}
        setAdLoading(false);
        succeeded ? onSuccess() : onFail();
      };
      ALRewarded.addAdLoadedEventListener(() => {
        console.log('[AppLovin] Rewarded loaded, showing:', placementId);
        ALRewarded.showAd(placementId);
      });
      ALRewarded.addAdReceivedRewardEventListener?.((info: any) => {
        console.log('[AppLovin] Reward earned:', JSON.stringify(info));
        rewarded = true;
      });
      ALRewarded.addAdHiddenEventListener(() => {
        console.log('[AppLovin] Rewarded hidden, rewarded=', rewarded);
        finish(rewarded);
      });
      ALRewarded.addAdLoadFailedEventListener((info: any) => {
        console.warn('[AppLovin] Rewarded load failed:', info?.code);
        finish(false);
      });
      ALRewarded.addAdFailedToDisplayEventListener((info: any) => {
        console.warn('[AppLovin] Rewarded display failed:', info?.code);
        finish(false);
      });
      setAdLoading(true);
      ALRewarded.loadAd(placementId);
      console.log('[AppLovin] Loading rewarded:', placementId);
    } catch (e: any) {
      console.warn('[AppLovin] Rewarded exception:', e.message);
      setAdLoading(false); onFail();
    }
  }

  /* ── AdMob rewarded helper ── */
  function _showAdMobRewarded(unitId: string, onDone: (watched: boolean) => void) {
    if (!unitId) { onDone(false); return; }
    if (!nativeSdkAvailable || !RewardedAdClass || !sdkReady) {
      console.log('[AdMob] Rewarded simulating (5s) unitId=', unitId);
      setAdLoading(true);
      setTimeout(() => { setAdLoading(false); onDone(true); }, 5000);
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

  /* ── 3. Game interstitial — rotate AdMob → Unity → AppLovin ── */
  const showGameInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const s   = settingsRef.current;
    const idx = gameIntIdxRef.current;
    const NET: BannerProvider[] = ['admob', 'unity', 'applovin'];
    const network = NET[idx % NET.length];
    gameIntIdxRef.current = (idx + 1) % NET.length;
    console.log('[AdContext] Game interstitial via:', network);

    if (network === 'unity') {
      _tryUnityAd(s.unityInterstitialId, () => onDone(true), () =>
        _tryAppLovinInterstitial(s.applovinInterstitialId, () => onDone(true), () =>
          _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone)
        )
      );
    } else if (network === 'applovin') {
      _tryAppLovinInterstitial(s.applovinInterstitialId, () => onDone(true), () =>
        _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone)
      );
    } else {
      _showAdMobInterstitial(s.admobUnitId || TEST_IDS.INTERSTITIAL, onDone);
    }
  }, [sdkReady]);

  /* ── 4. Mining/Withdraw — Unity → AppLovin ONLY (NO AdMob per policy) ── */
  const showMiningInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const s = settingsRef.current;
    console.log('[AdContext] Mining interstitial — Unity → AppLovin (no AdMob per policy)');
    _tryUnityAd(s.unityInterstitialId, () => onDone(true), () =>
      _tryAppLovinInterstitial(s.applovinInterstitialId, () => onDone(true), () => {
        console.log('[AdContext] Mining: no Unity/AppLovin available, proceeding without ad');
        onDone(true);
      })
    );
  }, [sdkReady]);

  const showInterstitial = showGameInterstitial;

  /* ── 5. Rewarded — rotate AdMob → Unity → AppLovin ── */
  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    const s   = settingsRef.current;
    const idx = rewardedIdxRef.current;
    const NET: BannerProvider[] = ['admob', 'unity', 'applovin'];
    const network = NET[idx % NET.length];
    rewardedIdxRef.current = (idx + 1) % NET.length;
    console.log('[AdContext] Rewarded via:', network);

    if (network === 'unity') {
      _tryUnityAd(s.unityRewardedId, () => onDone(true), () =>
        _tryAppLovinRewarded(s.applovinRewardedId, () => onDone(true), () =>
          _showAdMobRewarded(s.admobRewardedId || TEST_IDS.REWARDED, onDone)
        )
      );
    } else if (network === 'applovin') {
      _tryAppLovinRewarded(s.applovinRewardedId, () => onDone(true), () =>
        _showAdMobRewarded(s.admobRewardedId || TEST_IDS.REWARDED, onDone)
      );
    } else {
      _showAdMobRewarded(s.admobRewardedId || TEST_IDS.REWARDED, onDone);
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
