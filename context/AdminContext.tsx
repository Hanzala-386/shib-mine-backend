import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AdminSettings {
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

const STORAGE_KEY = 'shib_admin_settings';

interface AdminContextValue {
  settings: AdminSettings;
  isLoading: boolean;
  updateSettings: (updates: Partial<AdminSettings>) => Promise<void>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function updateSettings(updates: Partial<AdminSettings>) {
    const merged = { ...settings, ...updates };
    setSettings(merged);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  }

  const value = useMemo(() => ({ settings, isLoading, updateSettings }), [settings, isLoading]);

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used within AdminProvider');
  return ctx;
}
