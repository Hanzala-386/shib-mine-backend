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
  getYodo1NativeModule,
  isYodo1NativeAvailable,
} from '@/modules/yodo1-mas';
import {
  isUnityAvailable,
  loadUnityInterstitial,
  showUnityInterstitial,
  loadUnityRewarded,
  showUnityRewarded,
} from '@/lib/unityAds';

/* ─── Types ─────────────────────────────────────────────────────────────── */
export interface AdSettings {
  showAds: boolean;
  activeAdNetwork: string;
  forceUnityOnly: boolean;
  admobBannerUnitId: string;
  admobUnitId: string;
  admobRewardedId: string;
  unityGameId: string;
  unityRewardedId: string;
  unityInterstitialId: string;
  unityBannerId: string;
  applovinSdkKey: string;
  applovinRewardedId: string;
  applovinBannerId: string;
  applovinInterstitialId: string;
}

export type BannerProvider = 'yodo1' | 'unity';

interface AdContextValue {
  settings: AdSettings;
  sdkReady: boolean;
  isAdLoading: boolean;
  bannerProvider: BannerProvider;
  showGameInterstitial: (onDone: (shown: boolean) => void) => void;
  showMiningInterstitial: (onDone: (shown: boolean) => void) => void;
  showRewarded: (onDone: (watched: boolean) => void) => void;
  showInterstitial: (onDone: (shown: boolean) => void) => void;
}

/* ─── Test IDs (Yodo1 placement IDs from dashboard) ─────────────────────── */
export const TEST_IDS = {
  BANNER: 'banner_test',
  INTERSTITIAL: 'interstitial_test',
  REWARDED: 'rewarded_test',
};

const YODO1_APP_KEY = 'wUO7rM9IND';

const DEFAULT_SETTINGS: AdSettings = {
  showAds: false,
  activeAdNetwork: '',
  forceUnityOnly: false,
  admobBannerUnitId: '',
  admobUnitId: '',
  admobRewardedId: '',
  unityGameId: '',
  unityRewardedId: '',
  unityInterstitialId: '',
  unityBannerId: '',
  applovinSdkKey: '',
  applovinRewardedId: '',
  applovinBannerId: '',
  applovinInterstitialId: '',
};

/* ─── Legacy exports for backward compatibility ───────────────────────── */
export const BannerAdComponent: any = null;
export const BannerAdSize: any = null;
export const nativeSdkAvailable = isYodo1NativeAvailable();

const AdContext = createContext<AdContextValue>({
  settings: DEFAULT_SETTINGS,
  sdkReady: false,
  isAdLoading: false,
  bannerProvider: 'yodo1',
  showGameInterstitial: (cb) => setTimeout(() => cb(true), 2500),
  showMiningInterstitial: (cb) => setTimeout(() => cb(true), 2500),
  showRewarded: (cb) => setTimeout(() => cb(true), 4000),
  showInterstitial: (cb) => setTimeout(() => cb(true), 2500),
});

export function useAds() { return useContext(AdContext); }

/* ─── Provider ────────────────────────────────────────────────────────── */
export function AdProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AdSettings>(DEFAULT_SETTINGS);
  const [sdkReady, setSdkReady] = useState(false);
  const [isAdLoading, setAdLoading] = useState(false);
  const [bannerProvider, setBannerProvider] = useState<BannerProvider>('yodo1');

  const settingsRef = useRef<AdSettings>(DEFAULT_SETTINGS);
  const yodo1 = getYodo1NativeModule();

  /* ── 1. Fetch Ad settings from PocketBase at launch ── */
  useEffect(() => {
    const url = new URL('/api/app/settings', getApiUrl()).href;
    fetch(url)
      .then(r => r.json())
      .then((s: Partial<AdSettings> & Record<string, any>) => {
        const merged: AdSettings = {
          showAds: !!s.showAds,
          activeAdNetwork: s.activeAdNetwork || '',
          forceUnityOnly: !!s.forceUnityOnly,
          admobBannerUnitId: s.admobBannerUnitId || '',
          admobUnitId: s.admobUnitId || '',
          admobRewardedId: s.admobRewardedId || '',
          unityGameId: s.unityGameId || '',
          unityRewardedId: s.unityRewardedId || '',
          unityInterstitialId: s.unityInterstitialId || '',
          unityBannerId: s.unityBannerId || '',
          applovinSdkKey: s.applovinSdkKey || '',
          applovinRewardedId: s.applovinRewardedId || '',
          applovinBannerId: s.applovinBannerId || '',
          applovinInterstitialId: s.applovinInterstitialId || '',
        };
        settingsRef.current = merged;
        setSettings(merged);
        console.log('[AdContext] Settings loaded from Express/PB (forceUnityOnly=' + merged.forceUnityOnly + ')');
      })
      .catch(e => {
        console.warn('[AdContext] Express settings failed, trying PB fallback:', e);
        pb.collection('settings').getList(1, 1).then(res => {
          if (res.items[0]) {
            const s = res.items[0] as any;
            const merged: AdSettings = {
              showAds: !!s.show_ads,
              activeAdNetwork: s.active_ad_network || '',
              forceUnityOnly: !!s.force_unity_only,
              admobBannerUnitId: s.admob_banner_unit_id || '',
              admobUnitId: s.admob_unit_id || '',
              admobRewardedId: s.admob_rewarded_id || '',
              unityGameId: s.unity_game_id || '',
              unityRewardedId: s.unity_rewarded_id || '',
              unityInterstitialId: s.unity_interstitial_id || '',
              unityBannerId: s.unity_banner_id || '',
              applovinSdkKey: s.applovin_sdk_key || '',
              applovinRewardedId: s.applovin_rewarded_id || '',
              applovinBannerId: s.applovin_banner_id || '',
              applovinInterstitialId: s.applovin_interstitial_id || '',
            };
            settingsRef.current = merged;
            setSettings(merged);
            console.log('[AdContext] Settings loaded from PB fallback');
          }
        }).catch(() => {});
      });
  }, []);

  /* ── 2. Initialize Yodo1 SDK ── */
  useEffect(() => {
    if (Platform.OS === 'web') {
      setSdkReady(true);
      return;
    }
    if (!yodo1) {
      console.log('[AdContext] Yodo1 native module not available — Unity fallback / sim');
      setSdkReady(true);
      return;
    }
    yodo1.initialize(YODO1_APP_KEY)
      .then(() => {
        console.log('[AdContext] Yodo1 MAS initialized');
        setSdkReady(true);
        yodo1.loadInterstitial().catch(() => {});
        yodo1.loadRewarded().catch(() => {});
      })
      .catch((e: Error) => {
        console.warn('[AdContext] Yodo1 init failed:', e.message);
        setSdkReady(true);
      });
  }, []);

  /* ── 3. Yodo1 interstitial ── */
  const _showYodo1Interstitial = useCallback((onDone: (shown: boolean) => void) => {
    if (!yodo1) { onDone(false); return; }
    setAdLoading(true);
    yodo1.loadInterstitial()
      .then(() => yodo1.showInterstitial())
      .then((shown: boolean) => {
        setAdLoading(false);
        onDone(shown);
      })
      .catch((e: Error) => {
        console.warn('[AdContext] Yodo1 interstitial failed:', e.message);
        setAdLoading(false);
        onDone(false);
      });
  }, [yodo1, sdkReady]);

  /* ── 4. Unity interstitial fallback ── */
  const _showUnityInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    const unityId = settingsRef.current.unityInterstitialId || 'Shib_Interstitial_Android';
    loadUnityInterstitial(unityId)
      .then(() => showUnityInterstitial(unityId))
      .then((shown: boolean) => onDone(shown))
      .catch(() => onDone(false));
  }, []);

  /* ── 5. Yodo1 rewarded ── */
  const _showYodo1Rewarded = useCallback((onDone: (watched: boolean) => void) => {
    if (!yodo1) { onDone(false); return; }
    setAdLoading(true);
    yodo1.loadRewarded()
      .then(() => yodo1.showRewarded())
      .then((earned: boolean) => {
        setAdLoading(false);
        onDone(earned);
      })
      .catch((e: Error) => {
        console.warn('[AdContext] Yodo1 rewarded failed:', e.message);
        setAdLoading(false);
        onDone(false);
      });
  }, [yodo1, sdkReady]);

  /* ── 6. Unity rewarded fallback ── */
  const _showUnityRewarded = useCallback((onDone: (watched: boolean) => void) => {
    const unityId = settingsRef.current.unityRewardedId || 'Shib_Rewarded_Android';
    loadUnityRewarded(unityId)
      .then(() => showUnityRewarded(unityId))
      .then((earned: boolean) => onDone(earned))
      .catch(() => onDone(false));
  }, []);

  /* ── 7. Public API ── */
  const showGameInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    if (Platform.OS === 'web') { setTimeout(() => onDone(true), 2500); return; }
    if (settingsRef.current.forceUnityOnly) {
      console.log('[AdContext] Game interstitial via Unity (forced)');
      _showUnityInterstitial(onDone);
    } else if (yodo1 && sdkReady) {
      console.log('[AdContext] Game interstitial via Yodo1');
      _showYodo1Interstitial(onDone);
    } else if (isUnityAvailable()) {
      console.log('[AdContext] Game interstitial via Unity fallback');
      _showUnityInterstitial(onDone);
    } else {
      console.log('[AdContext] Game interstitial — sim');
      setTimeout(() => onDone(true), 2500);
    }
  }, [yodo1, sdkReady, _showYodo1Interstitial, _showUnityInterstitial]);

  const showMiningInterstitial = useCallback((onDone: (shown: boolean) => void) => {
    if (Platform.OS === 'web') { setTimeout(() => onDone(true), 2500); return; }
    if (settingsRef.current.forceUnityOnly) {
      _showUnityInterstitial(onDone);
    } else if (yodo1 && sdkReady) {
      _showYodo1Interstitial(onDone);
    } else if (isUnityAvailable()) {
      _showUnityInterstitial(onDone);
    } else {
      setTimeout(() => onDone(true), 2500);
    }
  }, [yodo1, sdkReady, _showYodo1Interstitial, _showUnityInterstitial]);

  const showInterstitial = showGameInterstitial;

  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    if (Platform.OS === 'web') { setTimeout(() => onDone(true), 4000); return; }
    if (settingsRef.current.forceUnityOnly) {
      _showUnityRewarded(onDone);
    } else if (yodo1 && sdkReady) {
      _showYodo1Rewarded(onDone);
    } else if (isUnityAvailable()) {
      _showUnityRewarded(onDone);
    } else {
      setTimeout(() => onDone(true), 4000);
    }
  }, [yodo1, sdkReady, _showYodo1Rewarded, _showUnityRewarded]);

  /* ── 8. Banner provider rotation ── */
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const id = setInterval(() => {
      setBannerProvider(prev => prev === 'yodo1' ? 'unity' : 'yodo1');
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <AdContext.Provider value={{
      settings,
      sdkReady,
      isAdLoading,
      bannerProvider,
      showGameInterstitial,
      showMiningInterstitial,
      showRewarded,
      showInterstitial,
    }}>
      {children}
    </AdContext.Provider>
  );
}
