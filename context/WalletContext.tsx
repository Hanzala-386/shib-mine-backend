import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import storage from '@/lib/storage';
import { useAuth } from './AuthContext';
import { api } from '@/lib/api';

export interface WithdrawalRecord {
  id: string;
  method: string;
  addressOrEmail: string;
  amount: number;
  status: string;
  created: string;
}

interface WalletContextValue {
  shibBalance: number;
  powerTokens: number;
  withdrawals: WithdrawalRecord[];
  withdrawalTier: number;
  minWithdrawalAmount: number;
  isLoading: boolean;
  spendPowerTokens: (amount: number) => Promise<boolean>;
  addPowerTokens: (amount: number, type?: string) => Promise<void>;
  createWithdrawal: (method: string, addressOrEmail: string, amount: number) => Promise<{ success: boolean; error?: string }>;
  refetch: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { pbUser, user, refreshBalance } = useAuth();
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [withdrawalTier, setWithdrawalTier] = useState(1);
  const [minWithdrawalAmount, setMinWithdrawalAmount] = useState(100);
  const [isLoading, setIsLoading] = useState(false);

  const pbId = pbUser?.pbId ?? null;
  const uid = user?.uid ?? null;
  const rawShib = pbUser?.shibBalance;
  const rawPT = pbUser?.powerTokens;
  const shibBalance = typeof rawShib === 'number' && isFinite(rawShib) ? rawShib : 0;
  const powerTokens = typeof rawPT === 'number' && isFinite(rawPT) ? rawPT : 10;

  useEffect(() => {
    if (pbId) {
      fetchWalletData();
    }
  }, [pbId]);

  async function fetchWalletData() {
    if (!pbId) return;
    setIsLoading(true);
    try {
      const [wds, tier] = await Promise.all([
        api.getWithdrawals(pbId),
        api.getWithdrawalTier(pbId),
      ]);
      setWithdrawals(wds);
      setWithdrawalTier(tier.tier);
      setMinWithdrawalAmount(tier.minAmount);
    } catch (e) {
      console.warn('[Wallet] fetchWalletData failed', e);
      // Load cached withdrawals
      if (uid) {
        try {
          const raw = await storage.getItem(`shib_withdrawals_${uid}`);
          if (raw) setWithdrawals(JSON.parse(raw));
        } catch { }
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function spendPowerTokens(amount: number): Promise<boolean> {
    if (!pbId) {
      // Local-only fallback
      if ((pbUser?.powerTokens ?? 0) < amount) return false;
      return true;
    }
    try {
      const res = await api.gameSpend(pbId, amount);
      if (res.success) {
        await refreshBalance();
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[Wallet] spendPowerTokens failed', e);
      return false;
    }
  }

  async function addPowerTokens(amount: number, type = 'game_win'): Promise<void> {
    if (!pbId) return;
    try {
      await api.gameReward(pbId, amount, type);
      await refreshBalance();
    } catch (e) {
      console.warn('[Wallet] addPowerTokens failed', e);
    }
  }

  async function createWithdrawal(
    method: string,
    addressOrEmail: string,
    amount: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Not authenticated' };
    try {
      const res = await api.createWithdrawal({ pbId, method, addressOrEmail, amount });
      await refreshBalance();
      await fetchWalletData();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  const value = useMemo(() => ({
    shibBalance,
    powerTokens,
    withdrawals,
    withdrawalTier,
    minWithdrawalAmount,
    isLoading,
    spendPowerTokens,
    addPowerTokens,
    createWithdrawal,
    refetch: fetchWalletData,
  }), [shibBalance, powerTokens, withdrawals, withdrawalTier, minWithdrawalAmount, isLoading, pbId]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
