import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pbAPI, type PBSettings } from '@/lib/pocketbase';
import { configureAds } from '@/lib/AdService';

export interface AdminSettings {
  pbId?: string;
  miningEntryFee: number;
  baseMiningRate: number;
  boosterCosts: { '2x': number; '4x': number; '6x': number; '10x': number };
  admob: {
    appId: string;
    bannerId: string;
    interstitialId: string;
    rewardedId: string;
  };
  unity: {
    gameId: string;
    interstitialPlacementId: string;
  };
  withdrawal: {
    binanceFeePercent: number;
    bep20FlatFee: number;
    minTier1: number;
    minTier2: number;
    minTier3: number;
  };
}

const DEFAULT_SETTINGS: AdminSettings = {
  miningEntryFee: 5,
  baseMiningRate: 500000,
  boosterCosts: { '2x': 10, '4x': 25, '6x': 50, '10x': 100 },
  admob: { appId: '', bannerId: '', interstitialId: '', rewardedId: '' },
  unity: { gameId: '', interstitialPlacementId: '' },
  withdrawal: {
    binanceFeePercent: 2,
    bep20FlatFee: 5,
    minTier1: 1000000,
    minTier2: 500000,
    minTier3: 250000,
  },
};

const CACHE_KEY = 'shib_admin_settings_cache';

function pbSettingsToLocal(pb: PBSettings): AdminSettings {
  return {
    pbId: pb.id,
    miningEntryFee: pb.miningEntryFee,
    baseMiningRate: pb.baseMiningRate,
    boosterCosts: {
      '2x': pb.boosterCost2x,
      '4x': pb.boosterCost4x,
      '6x': pb.boosterCost6x,
      '10x': pb.boosterCost10x,
    },
    admob: {
      appId: pb.admobAppId ?? '',
      bannerId: pb.admobBannerId ?? '',
      interstitialId: pb.admobInterstitialId ?? '',
      rewardedId: pb.admobRewardedId ?? '',
    },
    unity: {
      gameId: pb.unityGameId ?? '',
      interstitialPlacementId: pb.unityInterstitialPlacementId ?? '',
    },
    withdrawal: {
      binanceFeePercent: pb.binanceFeePercent,
      bep20FlatFee: pb.bep20FlatFee,
      minTier1: pb.minTier1,
      minTier2: pb.minTier2,
      minTier3: pb.minTier3,
    },
  };
}

interface AdminContextValue {
  settings: AdminSettings;
  isLoading: boolean;
  updateSettings: (updates: Partial<AdminSettings>) => Promise<void>;
  refetch: () => Promise<void>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const cached = await AsyncStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        setSettings(parsed);
        applyAdsConfig(parsed);
      }

      const pbSettings = await pbAPI.getSettings();
      if (pbSettings) {
        const local = pbSettingsToLocal(pbSettings);
        setSettings(local);
        applyAdsConfig(local);
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(local));
      }
    } catch (e) {
      console.warn('[Admin] PocketBase unavailable, using cache', e);
    } finally {
      setIsLoading(false);
    }
  }

  function applyAdsConfig(s: AdminSettings) {
    configureAds({
      admobBannerId: s.admob.bannerId,
      admobInterstitialId: s.admob.interstitialId,
      admobRewardedId: s.admob.rewardedId,
      unityGameId: s.unity.gameId,
      unityInterstitialPlacementId: s.unity.interstitialPlacementId,
    });
  }

  async function updateSettings(updates: Partial<AdminSettings>) {
    const merged = { ...settings, ...updates };

    if (updates.boosterCosts) merged.boosterCosts = { ...settings.boosterCosts, ...updates.boosterCosts };
    if (updates.admob) merged.admob = { ...settings.admob, ...updates.admob };
    if (updates.unity) merged.unity = { ...settings.unity, ...updates.unity };
    if (updates.withdrawal) merged.withdrawal = { ...settings.withdrawal, ...updates.withdrawal };

    setSettings(merged);
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(merged));
    applyAdsConfig(merged);

    if (merged.pbId) {
      try {
        await pbAPI.updateSettings(merged.pbId, {
          miningEntryFee: merged.miningEntryFee,
          baseMiningRate: merged.baseMiningRate,
          boosterCost2x: merged.boosterCosts['2x'],
          boosterCost4x: merged.boosterCosts['4x'],
          boosterCost6x: merged.boosterCosts['6x'],
          boosterCost10x: merged.boosterCosts['10x'],
          admobAppId: merged.admob.appId,
          admobBannerId: merged.admob.bannerId,
          admobInterstitialId: merged.admob.interstitialId,
          admobRewardedId: merged.admob.rewardedId,
          unityGameId: merged.unity.gameId,
          unityInterstitialPlacementId: merged.unity.interstitialPlacementId,
          binanceFeePercent: merged.withdrawal.binanceFeePercent,
          bep20FlatFee: merged.withdrawal.bep20FlatFee,
          minTier1: merged.withdrawal.minTier1,
          minTier2: merged.withdrawal.minTier2,
          minTier3: merged.withdrawal.minTier3,
        });
      } catch (e) {
        console.warn('[Admin] Failed to sync settings to PocketBase', e);
      }
    }
  }

  const value = useMemo(() => ({ settings, isLoading, updateSettings, refetch: load }), [settings, isLoading]);

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used within AdminProvider');
  return ctx;
}
