import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import storage from '@/lib/storage';
import { api, type AppSettings } from '@/lib/api';
import { configureAds } from '@/lib/AdService';

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

      // Fetch live from server
      const fresh = await api.getSettings();
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
