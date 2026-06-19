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
import { pb } from '@/lib/pocketbase';
import {
  isUnityAvailable,
  preloadUnityAds,
  showUnityInterstitial,
  showUnityRewarded,
} from '@/lib/unityAds';

/* ─── Types ─────────────────────────────────────────────────────────────────── */
export interface AdSettings {
  showAds:               boolean;
  /* Master override — true = bypass AdMob entirely, serve Unity Ads only */
  forceUnityOnly:        boolean;
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

export interface AdapterStatus {
  name:  string;
  state: 'READY' | 'NOT_READY' | 'UNKNOWN';
}

interface AdContextValue {
  settings:               AdSettings;
  sdkReady:               boolean;
  isAdLoading:            boolean;
  bannerProvider:         BannerProvider;
  adapterStatuses:        AdapterStatus[];
  showGameInterstitial:   (onDone: (shown: boolean) => void) => void;
  showMiningInterstitial: (onDone: (shown: boolean) => void) => void;
  showRewarded:           (onDone: (watched: boolean) => void) => void;
  showInterstitial:       (onDone: (shown: boolean) => void) => void;
}

/* ─── AdMob production unit IDs ─────────────────────────────────────────────── */
export const TEST_IDS = {
  BANNER:       'ca-app-pub-7314448641809053/4666652323',
  INTERSTITIAL: 'ca-app-pub-7314448641809053/2310185360',
  REWARDED:     'ca-app-pub-7314448641809053/7506671725',
};

/* Phase B race window: if AdMob can't PRESENT an ad within this window, fall
 * back to Unity instantly. Only applies on Android when the Unity native module
 * is compiled in and forceUnityOnly is false. */
const ADMOB_RACE_MS = 3000;

const DEFAULT_SETTINGS: AdSettings = {
  showAds: false,
  forceUnityOnly: false,
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

/* ─── Settings mappers ──────────────────────────────────────────────────────── */
/* Express /api/app/settings response (camelCase). */
function fromCamel(s: any): AdSettings {
  return {
    showAds:                !!s.showAds,
    forceUnityOnly:         !!s.forceUnityOnly,
    activeAdNetwork:        s.activeAdNetwork        || '',
    admobBannerUnitId:      s.admobBannerUnitId      || TEST_IDS.BANNER,
    admobUnitId:            s.admobUnitId            || TEST_IDS.INTERSTITIAL,
    admobRewardedId:        s.admobRewardedId        || TEST_IDS.REWARDED,
    unityGameId:            s.unityGameId            || '',
    unityRewardedId:        s.unityRewardedId        || '',
    unityInterstitialId:    s.unityInterstitialId    || '',
    unityBannerId:          s.unityBannerId          || '',
    applovinSdkKey:         s.applovinSdkKey         || '',
    applovinRewardedId:     s.applovinRewardedId     || '',
    applovinBannerId:       s.applovinBannerId       || '',
    applovinInterstitialId: s.applovinInterstitialId || '',
  };
}
/* Raw PocketBase 'settings' record (snake_case) — used on the APK where Express is unreachable. */
function fromSnake(s: any): AdSettings {
  return {
    showAds:                !!s.show_ads,
    forceUnityOnly:         !!s.force_unity_only,
    activeAdNetwork:        s.active_ad_network      || '',
    admobBannerUnitId:      s.admob_banner_unit_id   || TEST_IDS.BANNER,
    admobUnitId:            s.admob_unit_id          || TEST_IDS.INTERSTITIAL,
    admobRewardedId:        s.admob_rewarded_id      || TEST_IDS.REWARDED,
    unityGameId:            s.unity_game_id          || '',
    unityRewardedId:        s.unity_rewarded_id      || '',
    unityInterstitialId:    s.unity_interstitial_id  || '',
    unityBannerId:          s.unity_banner_id        || '',
    applovinSdkKey:         s.applovin_sdk_key       || '',
    applovinRewardedId:     s.applovin_rewarded_id   || '',
    applovinBannerId:       s.applovin_banner_id     || '',
    applovinInterstitialId: s.applovin_interstitial_id || '',
  };
}

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
  adapterStatuses:        [],
  showGameInterstitial:   (cb) => setTimeout(() => cb(true), 2500),
  showMiningInterstitial: (cb) => setTimeout(() => cb(true), 2500),
  showRewarded:           (cb) => setTimeout(() => cb(true), 4000),
  showInterstitial:       (cb) => setTimeout(() => cb(true), 2500),
});

export function useAds() { return useContext(AdContext); }

/* ─── Provider ───────────────────────────────────────────────────────────────── */
export function AdProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings]               = useState<AdSettings>(DEFAULT_SETTINGS);
  const [sdkReady, setSdkReady]               = useState(false);
  const [isAdLoading, setAdLoading]           = useState(false);
  const [bannerProvider, setBannerProvider]   = useState<BannerProvider>('admob');
  const [adapterStatuses, setAdapterStatuses] = useState<AdapterStatus[]>([]);

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

  /* ── 1. Load Ad settings at launch (Express → PocketBase fallback) ──
   * In Replit dev the Express route answers. On the published APK every
   * /api/app/* route 404s, so we fall back to reading the 'settings'
   * collection directly via the PocketBase SDK — otherwise force_unity_only
   * and the real ad unit IDs would never reach the device. If both fail
   * (fully offline) we keep DEFAULT_SETTINGS, i.e. hybrid mode. */
  useEffect(() => {
    let cancelled = false;
    const apply = (merged: AdSettings, source: string) => {
      if (cancelled) return;
      settingsRef.current = merged;
      setSettings(merged);
      console.log(`[AdContext] Settings loaded from ${source} ✓ (forceUnityOnly=${merged.forceUnityOnly})`);
    };

    (async () => {
      // 1. Express
      try {
        const url = new URL('/api/app/settings', getApiUrl()).href;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        apply(fromCamel(await r.json()), 'Express');
        return;
      } catch (e: any) {
        console.warn('[AdContext] Express settings unavailable, trying PocketBase:', e?.message);
      }
      // 2. PocketBase SDK (APK path)
      try {
        const rec = await pb.collection('settings').getList(1, 1);
        const row = rec.items?.[0];
        if (!row) throw new Error('no settings record');
        apply(fromSnake(row), 'PocketBase');
      } catch (e: any) {
        console.warn('[AdContext] PocketBase settings failed — keeping defaults (hybrid mode):', e?.message);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  /* ── 2. Initialize AdMob SDK + parse per-adapter mediation status ── */
  useEffect(() => {
    if (!nativeSdkAvailable || !GoogleAds) {
      setSdkReady(false);
      return;
    }
    GoogleAds().initialize()
      .then((statuses: any[]) => {
        // Parse the adapter initialization report — each entry has adapterName + state.
        // state === 'READY' means the mediation adapter initialized successfully and
        // can fill ads for that network.  Log each adapter so we can confirm the
        // waterfall is working in production crash logs / Sentry.
        const parsed: AdapterStatus[] = (Array.isArray(statuses) ? statuses : []).map(s => {
          const raw  = (s.adapterName || s.name || 'unknown') as string;
          // Shorten com.google.ads.mediation.unity.UnityMediationAdapter → Unity Ads, etc.
          const name = raw.includes('unity')    ? 'Unity Ads'
                     : raw.includes('applovin') ? 'AppLovin MAX'
                     : raw.includes('admob')    ? 'AdMob'
                     : raw.split('.').pop() || raw;
          const state: AdapterStatus['state'] =
            s.state === 'READY' ? 'READY' : s.state === 'NOT_READY' ? 'NOT_READY' : 'UNKNOWN';
          return { name, state };
        });

        setAdapterStatuses(parsed);
        setSdkReady(true);

        const ready    = parsed.filter(a => a.state === 'READY').map(a => a.name);
        const notReady = parsed.filter(a => a.state !== 'READY').map(a => a.name);
        console.log('[AdContext] Mediation initialized ✓');
        if (ready.length)    console.log('[AdContext]  READY    →', ready.join(', '));
        if (notReady.length) console.log('[AdContext]  NOT READY→', notReady.join(', '));
      })
      .catch((e: Error) => {
        console.warn('[AdContext] AdMob init failed:', e.message);
        setSdkReady(false);
      });
  }, []);

  /* ── 2b. Preload Unity placements (Android APK only — no-op everywhere else) ──
   * Unity is the fallback network in BOTH phases, so warm it up at launch for an
   * instant show when AdMob misses or forceUnityOnly is on. Safe no-op when the
   * native module is absent (web / iOS / Expo Go). */
  useEffect(() => {
    if (!isUnityAvailable()) return;
    preloadUnityAds();
  }, []);

  /* ── AdMob interstitial helper ──
   * opts (hybrid race only):
   *   onPresent   — fired on LOADED, just before show() (AdMob "won" the race)
   *   isCancelled — checked on LOADED; if true the ad is discarded, NOT shown
   *                 (Unity already took over after the 3s timeout)
   *   onError     — replaces the default onDone(false) so a failure routes to Unity */
  function _showAdMobInterstitial(
    unitId: string,
    onDone: (shown: boolean) => void,
    opts?: { onPresent?: () => void; isCancelled?: () => boolean; onError?: () => void },
  ) {
    if (!unitId) { if (opts?.onError) opts.onError(); else onDone(false); return; }
    if (!nativeSdkAvailable || !InterstitialAdClass || !sdkReady) {
      onDone(true);
      return;
    }
    setAdLoading(true);
    const cleanup: Array<() => void> = [];
    try {
      const ad = InterstitialAdClass.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true });
      cleanup.push(ad.addAdEventListener(AdEventType.LOADED,  () => {
        if (opts?.isCancelled?.()) { cleanup.forEach(fn => fn()); setAdLoading(false); return; }
        setAdLoading(false);
        opts?.onPresent?.();
        ad.show();
      }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED,  () => { cleanup.forEach(fn => fn()); onDone(true); }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR,   (e: Error) => {
        console.warn('[AdMob] Interstitial error:', e.message);
        cleanup.forEach(fn => fn()); setAdLoading(false);
        if (opts?.onError) opts.onError(); else onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdMob] Interstitial exception:', e.message);
      setAdLoading(false);
      if (opts?.onError) opts.onError(); else onDone(false);
    }
  }

  /* ── AdMob rewarded helper ── (opts identical contract to interstitial above) */
  function _showAdMobRewarded(
    unitId: string,
    onDone: (watched: boolean) => void,
    opts?: { onPresent?: () => void; isCancelled?: () => boolean; onError?: () => void },
  ) {
    if (!unitId) { if (opts?.onError) opts.onError(); else onDone(false); return; }
    if (!nativeSdkAvailable || !RewardedAdClass || !sdkReady) {
      onDone(true);
      return;
    }
    setAdLoading(true);
    let rewarded = false;
    const cleanup: Array<() => void> = [];
    try {
      const ad = RewardedAdClass.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true });
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.LOADED,        () => {
        if (opts?.isCancelled?.()) { cleanup.forEach(fn => fn()); setAdLoading(false); return; }
        setAdLoading(false);
        opts?.onPresent?.();
        ad.show();
      }));
      cleanup.push(ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => { rewarded = true; }));
      cleanup.push(ad.addAdEventListener(AdEventType.CLOSED, () => { cleanup.forEach(fn => fn()); onDone(rewarded); }));
      cleanup.push(ad.addAdEventListener(AdEventType.ERROR,  (e: Error) => {
        console.warn('[AdMob] Rewarded error:', e.message);
        cleanup.forEach(fn => fn()); setAdLoading(false);
        if (opts?.onError) opts.onError(); else onDone(false);
      }));
      ad.load();
    } catch (e: any) {
      console.warn('[AdMob] Rewarded exception:', e.message);
      setAdLoading(false);
      if (opts?.onError) opts.onError(); else onDone(false);
    }
  }

  /* ── Hybrid router ─────────────────────────────────────────────────────────────
   * Decides AdMob vs Unity per call:
   *   • iOS / no Unity native module   → pure AdMob (behavior identical to before)
   *   • Phase A (forceUnityOnly=true)  → Unity only, AdMob bypassed
   *   • AdMob SDK not ready on-device  → straight to Unity
   *   • Phase B (default)              → AdMob first; if it can't PRESENT within
   *                                      ADMOB_RACE_MS (or errors), fall back to Unity
   * The race hinges on AdMob PRESENTING (LOADED→show), not completing, so a normal
   * AdMob ad the user watches for >3s never wrongly triggers a second Unity ad. */
  function _routeInterstitial(unitId: string, onDone: (shown: boolean) => void) {
    // Phase A — forced Unity (Android only): bypass AdMob ENTIRELY. Checked BEFORE
    // the isUnityAvailable() bailout so the toggle is honored even on a build where
    // the Unity native module is absent (then showUnityInterstitial no-ops →
    // onDone(false), i.e. no ad — which is the explicit "AdMob bypassed" intent).
    if (settingsRef.current.forceUnityOnly && Platform.OS === 'android') {
      console.log('[AdContext] forceUnityOnly (Android) → Unity interstitial, AdMob bypassed');
      showUnityInterstitial().then(onDone);
      return;
    }
    if (!isUnityAvailable()) { _showAdMobInterstitial(unitId, onDone); return; }

    if (!nativeSdkAvailable || !sdkReady) {
      showUnityInterstitial().then(onDone);
      return;
    }

    let settled = false;
    let cancelled = false;        // stops a late AdMob LOADED from showing over Unity
    let adMobPresented = false;   // AdMob won the race — never fall back to Unity
    let fallbackStarted = false;  // a Unity fallback is already in flight — never start a 2nd
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      onDone(v);
    };
    const goUnity = () => {
      if (settled || fallbackStarted || adMobPresented) return;
      fallbackStarted = true;
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      console.log('[AdContext] AdMob miss → Unity interstitial fallback');
      showUnityInterstitial().then(settle);
    };

    _showAdMobInterstitial(unitId, settle, {
      onPresent: () => { adMobPresented = true; if (timer) { clearTimeout(timer); timer = null; } },
      isCancelled: () => cancelled,
      // After AdMob has presented, a late error must settle (not start Unity over a shown ad).
      onError: () => { if (adMobPresented) settle(false); else goUnity(); },
    });
    timer = setTimeout(() => { if (!adMobPresented) goUnity(); }, ADMOB_RACE_MS);
  }

  function _routeRewarded(unitId: string, onDone: (watched: boolean) => void) {
    // Phase A — forced Unity (Android only): bypass AdMob ENTIRELY. Checked BEFORE
    // the isUnityAvailable() bailout so the toggle is honored even on a build where
    // the Unity native module is absent (then showUnityRewarded no-ops →
    // onDone(false), i.e. no reward — the explicit "AdMob bypassed" intent).
    if (settingsRef.current.forceUnityOnly && Platform.OS === 'android') {
      console.log('[AdContext] forceUnityOnly (Android) → Unity rewarded, AdMob bypassed');
      showUnityRewarded().then(onDone);
      return;
    }
    if (!isUnityAvailable()) { _showAdMobRewarded(unitId, onDone); return; }

    if (!nativeSdkAvailable || !sdkReady) {
      showUnityRewarded().then(onDone);
      return;
    }

    let settled = false;
    let cancelled = false;        // stops a late AdMob LOADED from showing over Unity
    let adMobPresented = false;   // AdMob won the race — never fall back to Unity
    let fallbackStarted = false;  // a Unity fallback is already in flight — never start a 2nd
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      onDone(v);
    };
    const goUnity = () => {
      if (settled || fallbackStarted || adMobPresented) return;
      fallbackStarted = true;
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      console.log('[AdContext] AdMob miss → Unity rewarded fallback');
      showUnityRewarded().then(settle);
    };

    _showAdMobRewarded(unitId, settle, {
      onPresent: () => { adMobPresented = true; if (timer) { clearTimeout(timer); timer = null; } },
      isCancelled: () => cancelled,
      // After AdMob has presented, a late error must settle false (no reward), not start Unity.
      onError: () => { if (adMobPresented) settle(false); else goUnity(); },
    });
    timer = setTimeout(() => { if (!adMobPresented) goUnity(); }, ADMOB_RACE_MS);
  }

  /* ── 3. Game interstitial — hybrid AdMob→Unity (Phase A/B) ── */
  const showGameInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const unitId = settingsRef.current.admobUnitId || TEST_IDS.INTERSTITIAL;
    console.log('[AdContext] Game interstitial, unitId:', unitId);
    _routeInterstitial(unitId, onDone);
  }, [sdkReady]);

  /* ── 4. Mining/Withdraw/Booster interstitial — hybrid AdMob→Unity (Phase A/B) ── */
  const showMiningInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const unitId = settingsRef.current.admobUnitId || TEST_IDS.INTERSTITIAL;
    console.log('[AdContext] Mining interstitial, unitId:', unitId);
    _routeInterstitial(unitId, onDone);
  }, [sdkReady]);

  const showInterstitial = showGameInterstitial;

  /* ── 5. Rewarded — hybrid AdMob→Unity (Phase A/B) ── */
  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    const unitId = settingsRef.current.admobRewardedId || TEST_IDS.REWARDED;
    console.log('[AdContext] Rewarded, unitId:', unitId);
    _routeRewarded(unitId, onDone);
  }, [sdkReady]);

  return (
    <AdContext.Provider value={{
      settings, sdkReady, isAdLoading, bannerProvider, adapterStatuses,
      showGameInterstitial, showMiningInterstitial, showRewarded, showInterstitial,
    }}>
      {children}
    </AdContext.Provider>
  );
}
