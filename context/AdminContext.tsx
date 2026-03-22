import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import storage from '@/lib/storage';
import { api, type AppSettings } from '@/lib/api';
import { configureAds } from '@/lib/AdService';
import { pb } from '@/lib/pocketbase';

// Maps raw PocketBase settings record (snake_case) → AppSettings (camelCase)
// Mirrors the formatSettings logic in server/routes.ts so both paths produce identical shape.
function formatPbSettings(s: any): AppSettings {
  return {
    id: s.id ?? '',
    miningRatePerSec:      s.mining_rate_per_sec      ?? 0.01736,
    powerTokenPerClick:    s.power_token_per_click    ?? 24,
    miningDurationMinutes: s.mining_duration_minutes  ?? 60,
    tokensPerRound:        s.tokens_per_round         ?? 3,
    boostCosts: {
      '2x':  s.boost_2x_cost  ?? 200,
      '4x':  s.boost_4x_cost  ?? 400,
      '6x':  s.boost_6x_cost  ?? 600,
      '10x': s.boost_10x_cost ?? 800,
    },
    minWithdrawal1:          s.min_withdrawal_1          ?? 100,
    minWithdrawal2:          s.min_withdrawal_2          ?? 1000,
    minWithdrawal3:          s.min_withdrawal_3          ?? 8000,
    showAds:                 s.show_ads                  ?? false,
    activeAdNetwork:         s.active_ad_network         ?? '',
    admobUnitId:             s.admob_unit_id             ?? '',
    admobBannerUnitId:       s.admob_banner_unit_id      ?? '',
    admobRewardedId:         s.admob_rewarded_id         ?? '',
    unityGameId:             s.unity_game_id             ?? '',
    unityRewardedId:         s.unity_rewarded_id         ?? '',
    unityInterstitialId:     s.unity_interstitial_id     ?? '',
    applovinSdkKey:          s.applovin_sdk_key          ?? '',
    applovinRewardedId:      s.applovin_rewarded_id      ?? '',
    applovinBannerId:        s.applovin_banner_id        ?? '',
    applovinInterstitialId:  s.applovin_interstitial_id  ?? '',
    appStoreLink:            s.app_store_link            ?? '',
    playStoreUrl:            s.play_store_url ?? s.app_store_link ?? '',
    ratePopupFrequency:      s.rate_popup_frequency      ?? 5,
  };
}

async function fetchSettingsFromPb(): Promise<AppSettings> {
  const res = await pb.collection('settings').getList(1, 1);
  if (!res.items[0]) throw new Error('No settings record found');
  return formatPbSettings(res.items[0]);
}

export type { AppSettings };

interface AdminContextValue {
  settings: AppSettings | null;
  isLoading: boolean;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  refetch: () => Promise<void>;
}

const DEFAULT_SETTINGS: AppSettings = {
  id: '',
  miningRatePerSec: 0.01736,
  powerTokenPerClick: 24,
  miningDurationMinutes: 60,
  tokensPerRound: 3,
  boostCosts: { '2x': 200, '4x': 400, '6x': 600, '10x': 800 },
  minWithdrawal1: 100,
  minWithdrawal2: 1000,
  minWithdrawal3: 8000,
  showAds: false,
  activeAdNetwork: '',
  admobUnitId: '',
  admobBannerUnitId: '',
  admobRewardedId: '',
  unityGameId: '',
  unityRewardedId: '',
  unityInterstitialId: '',
  applovinSdkKey: '',
  applovinRewardedId: '',
  applovinBannerId: '',
  applovinInterstitialId: '',
  appStoreLink: '',
  playStoreUrl: '',
  ratePopupFrequency: 5,
};

const CACHE_KEY = 'shib_settings_cache_v2';

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      // Load cache first for instant UI
      const cached = await storage.getItem(CACHE_KEY);
      if (cached) {
        const parsed: AppSettings = JSON.parse(cached);
        setSettings(parsed);
        applyAdsConfig(parsed);
      } else {
        setSettings(DEFAULT_SETTINGS);
      }

      // Fetch live — try Express first, fall back to PocketBase SDK directly
      let fresh: AppSettings;
      try {
        fresh = await api.getSettings();
      } catch {
        console.warn('[Admin] Express unreachable, fetching settings direct from PocketBase');
        fresh = await fetchSettingsFromPb();
      }
      setSettings(fresh);
      applyAdsConfig(fresh);
      await storage.setItem(CACHE_KEY, JSON.stringify(fresh));
    } catch (e) {
      console.warn('[Admin] Failed to fetch settings, using cache/defaults', e);
      if (!settings) setSettings(DEFAULT_SETTINGS);
    } finally {
      setIsLoading(false);
    }
  }

  function applyAdsConfig(s: AppSettings) {
    configureAds({
      admobBannerId:        s.admobBannerUnitId,
      admobInterstitialId:  s.admobUnitId,
      admobRewardedId:      s.admobRewardedId,
      unityGameId:          s.unityGameId,
      unityInterstitialId:  s.unityInterstitialId ?? '',
      applovinSdkKey:       s.applovinSdkKey,
      applovinInterstitialId: s.applovinInterstitialId ?? '',
    });
  }

  async function updateSettings(updates: Partial<AppSettings>) {
    const current = settings || DEFAULT_SETTINGS;
    const merged: AppSettings = {
      ...current,
      ...updates,
      boostCosts: updates.boostCosts
        ? { ...current.boostCosts, ...updates.boostCosts }
        : current.boostCosts,
    };

    setSettings(merged);
    await storage.setItem(CACHE_KEY, JSON.stringify(merged));
    applyAdsConfig(merged);

    if (merged.id) {
      try {
        await api.adminUpdateSettings(merged.id, updates);
      } catch (e) {
        console.warn('[Admin] Failed to sync settings to server', e);
      }
    }
  }

  const value = useMemo(() => ({
    settings,
    isLoading,
    updateSettings,
    refetch: load,
  }), [settings, isLoading]);

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used within AdminProvider');
  return ctx;
}
