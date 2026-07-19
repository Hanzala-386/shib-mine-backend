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
  mobileAds,
  InterstitialAd,
  RewardedAd,
  AdEventType,
  RewardedAdEventType,
  isAdMobAvailable,
} from '@/lib/admob';
import { ADMOB_AD_UNIT_IDS } from '@/lib/AdService';

/* ─── Types ─────────────────────────────────────────────────────────────── */
export interface AdSettings {
  showAds: boolean;
  admobBannerUnitId: string;
  admobUnitId: string;
  admobRewardedId: string;
}

interface AdContextValue {
  settings: AdSettings;
  sdkReady: boolean;
  isAdLoading: boolean;
  showGameInterstitial: (onDone: (shown: boolean) => void) => void;
  showMiningInterstitial: (onDone: (shown: boolean) => void) => void;
  showRewarded: (onDone: (watched: boolean) => void) => void;
  showInterstitial: (onDone: (shown: boolean) => void) => void;
}

const DEFAULT_SETTINGS: AdSettings = {
  showAds: false,
  admobBannerUnitId: '',
  admobUnitId: '',
  admobRewardedId: '',
};

/* How long a show*() call will wait for an ad to finish loading before it
 * gives up and lets the caller proceed without an ad. Never blocks a claim. */
const AD_LOAD_TIMEOUT_MS = 6_000;

const AdContext = createContext<AdContextValue>({
  settings: DEFAULT_SETTINGS,
  sdkReady: false,
  isAdLoading: false,
  showGameInterstitial: (cb) => setTimeout(() => cb(true), 1500),
  showMiningInterstitial: (cb) => setTimeout(() => cb(true), 1500),
  showRewarded: (cb) => setTimeout(() => cb(true), 3000),
  showInterstitial: (cb) => setTimeout(() => cb(true), 1500),
});

export function useAds() { return useContext(AdContext); }

/* ─── Provider — AdMob ONLY (Android: LIVE unit IDs; iOS: Google test IDs) ── */
export function AdProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AdSettings>(DEFAULT_SETTINGS);
  const [sdkReady, setSdkReady] = useState(false);
  const [isAdLoading, setAdLoading] = useState(false);

  const adMobOk = isAdMobAvailable();

  // Interstitial slot
  const interRef = useRef<any>(null);
  const interLoadedRef = useRef(false);
  const interPendingRef = useRef<((shown: boolean) => void) | null>(null);

  // Rewarded slot
  const rewRef = useRef<any>(null);
  const rewLoadedRef = useRef(false);
  const rewEarnedRef = useRef(false);
  const rewPendingRef = useRef<((watched: boolean) => void) | null>(null);

  /* ── 1. Fetch Ad settings (display/config only — unit IDs stay TEST) ── */
  useEffect(() => {
    const url = new URL('/api/app/settings', getApiUrl()).href;
    fetch(url)
      .then(r => r.json())
      .then((s: Record<string, any>) => {
        setSettings({
          showAds: !!s.showAds,
          admobBannerUnitId: s.admobBannerUnitId || '',
          admobUnitId: s.admobUnitId || '',
          admobRewardedId: s.admobRewardedId || '',
        });
        console.log('[AdContext] Settings loaded from Express/PB');
      })
      .catch(() => {
        pb.collection('settings').getList(1, 1).then(res => {
          const s = res.items[0] as any;
          if (!s) return;
          setSettings({
            showAds: !!s.show_ads,
            admobBannerUnitId: s.admob_banner_unit_id || '',
            admobUnitId: s.admob_unit_id || '',
            admobRewardedId: s.admob_rewarded_id || '',
          });
          console.log('[AdContext] Settings loaded from PB fallback');
        }).catch(() => {});
      });
  }, []);

  /* ── 2. Initialize Google Mobile Ads SDK + preload both formats ── */
  useEffect(() => {
    if (!adMobOk) {
      // web / Expo Go — no native SDK, ads are simulated
      setSdkReady(true);
      return;
    }
    const unsubs: (() => void)[] = [];

    mobileAds()
      .initialize()
      .then((statuses: { name: string; state: number; description: string }[]) => {
        // initialize() resolves with MobileAds.getInitializationStatus() —
        // one entry per registered adapter. state 1 = READY, 0 = NOT_READY.
        console.log('[AdContext] Google Mobile Ads SDK initialized');
        for (const s of statuses ?? []) {
          console.log(
            `[AdContext] Adapter ${s.name}: ${s.state === 1 ? 'READY' : 'NOT_READY'} (${s.description})`
          );
        }
        // Unity mediation adapter — registers as com.google.ads.mediation.unity.UnityMediationAdapter
        // (older GMA versions report it as com.unity3d.ads.UnityAds)
        const unity = (statuses ?? []).find(
          (s) => s.name.toLowerCase().includes('unity'),
        );
        if (unity) {
          console.log(
            `[AdContext] UNITY MEDIATION CHECK — ${unity.name} → ${unity.state === 1 ? 'READY ✓' : 'NOT READY ✗'}`
          );
        } else {
          console.warn(
            '[AdContext] UNITY MEDIATION CHECK — no com.unity3d.ads adapter registered (expected in Expo Go / builds without the adapter dependency)'
          );
        }
        setSdkReady(true);
      })
      .catch((e: Error) => { console.warn('[AdContext] SDK init failed:', e.message); setSdkReady(true); });

    // Interstitial — unit ID from ADMOB_AD_UNIT_IDS (live on Android, test on iOS)
    const inter = InterstitialAd.createForAdRequest(ADMOB_AD_UNIT_IDS.interstitial, {
      requestNonPersonalizedAdsOnly: true,
    });
    interRef.current = inter;
    unsubs.push(inter.addAdEventListener(AdEventType.LOADED, () => {
      interLoadedRef.current = true;
    }));
    unsubs.push(inter.addAdEventListener(AdEventType.CLOSED, () => {
      interLoadedRef.current = false;
      const cb = interPendingRef.current;
      interPendingRef.current = null;
      setAdLoading(false);
      cb?.(true);
      try { inter.load(); } catch {}
    }));
    unsubs.push(inter.addAdEventListener(AdEventType.ERROR, (e: any) => {
      console.warn('[AdContext] Interstitial error:', e?.message ?? e);
      interLoadedRef.current = false;
      const cb = interPendingRef.current;
      interPendingRef.current = null;
      setAdLoading(false);
      cb?.(false);
      setTimeout(() => { try { inter.load(); } catch {} }, 30_000);
    }));
    try { inter.load(); } catch {}

    // Rewarded — unit ID from ADMOB_AD_UNIT_IDS (live on Android, test on iOS)
    const rew = RewardedAd.createForAdRequest(ADMOB_AD_UNIT_IDS.rewarded, {
      requestNonPersonalizedAdsOnly: true,
    });
    rewRef.current = rew;
    unsubs.push(rew.addAdEventListener(RewardedAdEventType.LOADED, () => {
      rewLoadedRef.current = true;
    }));
    unsubs.push(rew.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
      rewEarnedRef.current = true;
    }));
    unsubs.push(rew.addAdEventListener(AdEventType.CLOSED, () => {
      rewLoadedRef.current = false;
      const cb = rewPendingRef.current;
      rewPendingRef.current = null;
      setAdLoading(false);
      cb?.(rewEarnedRef.current);
      rewEarnedRef.current = false;
      try { rew.load(); } catch {}
    }));
    unsubs.push(rew.addAdEventListener(AdEventType.ERROR, (e: any) => {
      console.warn('[AdContext] Rewarded error:', e?.message ?? e);
      rewLoadedRef.current = false;
      const cb = rewPendingRef.current;
      rewPendingRef.current = null;
      setAdLoading(false);
      cb?.(false);
      setTimeout(() => { try { rew.load(); } catch {} }, 30_000);
    }));
    try { rew.load(); } catch {}

    return () => { unsubs.forEach(u => u()); };
  }, [adMobOk]);

  /* ── 3. Interstitial (waits ≤6s for load; NEVER blocks the claim) ── */
  const showInterstitialInternal = useCallback((onDone: (shown: boolean) => void) => {
    if (!adMobOk) { setTimeout(() => onDone(true), 1500); return; } // simulate
    const inter = interRef.current;
    if (!inter || interPendingRef.current) { onDone(false); return; }
    interPendingRef.current = onDone;
    setAdLoading(true);

    const tryShow = () => { try { inter.show(); } catch {
      interPendingRef.current = null; setAdLoading(false); onDone(false);
    } };

    if (interLoadedRef.current) { tryShow(); return; }
    try { inter.load(); } catch {}
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (interPendingRef.current !== onDone) { clearInterval(poll); return; }
      if (interLoadedRef.current) { clearInterval(poll); tryShow(); return; }
      if (Date.now() - t0 > AD_LOAD_TIMEOUT_MS) {
        clearInterval(poll);
        interPendingRef.current = null;
        setAdLoading(false);
        onDone(false); // no fill — claim proceeds without an ad
      }
    }, 250);
  }, [adMobOk]);

  /* ── 4. Rewarded (watched=true ONLY after EARNED_REWARD) ── */
  const showRewarded = useCallback((onDone: (watched: boolean) => void) => {
    if (!adMobOk) { setTimeout(() => onDone(true), 3000); return; } // simulate
    const rew = rewRef.current;
    if (!rew || rewPendingRef.current) { onDone(false); return; }
    rewEarnedRef.current = false;
    rewPendingRef.current = onDone;
    setAdLoading(true);

    const tryShow = () => { try { rew.show(); } catch {
      rewPendingRef.current = null; setAdLoading(false); onDone(false);
    } };

    if (rewLoadedRef.current) { tryShow(); return; }
    try { rew.load(); } catch {}
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (rewPendingRef.current !== onDone) { clearInterval(poll); return; }
      if (rewLoadedRef.current) { clearInterval(poll); tryShow(); return; }
      if (Date.now() - t0 > AD_LOAD_TIMEOUT_MS) {
        clearInterval(poll);
        rewPendingRef.current = null;
        setAdLoading(false);
        onDone(false); // no fill — 2× not granted without a completed ad
      }
    }, 250);
  }, [adMobOk]);

  /* ── 5. Public API (same surface for every game mode) ── */
  const showGameInterstitial = showInterstitialInternal;
  const showMiningInterstitial = showInterstitialInternal;
  const showInterstitial = showInterstitialInternal;

  return (
    <AdContext.Provider value={{
      settings,
      sdkReady,
      isAdLoading,
      showGameInterstitial,
      showMiningInterstitial,
      showRewarded,
      showInterstitial,
    }}>
      {children}
    </AdContext.Provider>
  );
}
