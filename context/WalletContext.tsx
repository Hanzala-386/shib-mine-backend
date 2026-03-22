import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import storage from '@/lib/storage';
import { useAuth } from './AuthContext';
import { api } from '@/lib/api';
import { pb } from '@/lib/pocketbase';

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

function calcMinAmount(completedCount: number): number {
  if (completedCount === 0) return 100;
  if (completedCount === 1) return 1000;
  return 8000;
}

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
    if (pbId) fetchWalletData();
  }, [pbId]);

  async function fetchWalletData() {
    if (!pbId) return;
    setIsLoading(true);
    try {
      // Try Express first
      const [wds, tier] = await Promise.all([
        api.getWithdrawals(pbId),
        api.getWithdrawalTier(pbId),
      ]);
      setWithdrawals(wds);
      setWithdrawalTier(tier.tier);
      setMinWithdrawalAmount(tier.minAmount);
    } catch {
      // PB SDK fallback — query withdrawals collection directly
      try {
        const res = await pb.collection('withdrawals').getList(1, 50, {
          filter: `user="${pbId}"`,
          sort: '-created',
        });
        const wds: WithdrawalRecord[] = (res.items || []).map((w: any) => ({
          id: w.id,
          method: w.method,
          addressOrEmail: w.address_or_email,
          amount: w.amount,
          status: w.status,
          created: w.created,
        }));
        setWithdrawals(wds);

        const completedCount = wds.filter(w => w.status === 'completed').length;
        const tier = completedCount === 0 ? 1 : completedCount === 1 ? 2 : 3;
        setWithdrawalTier(tier);
        setMinWithdrawalAmount(calcMinAmount(completedCount));

        // Cache withdrawals locally
        if (uid) {
          try { await storage.setItem(`shib_withdrawals_${uid}`, JSON.stringify(wds)); } catch { }
        }
      } catch {
        // Last resort: load cached withdrawals
        if (uid) {
          try {
            const raw = await storage.getItem(`shib_withdrawals_${uid}`);
            if (raw) setWithdrawals(JSON.parse(raw));
          } catch { }
        }
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function spendPowerTokens(amount: number): Promise<boolean> {
    if (!pbId) {
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
    } catch {
      // PB SDK fallback
      try {
        const userRec = await pb.collection('users').getOne(pbId, { fields: 'id,power_tokens' });
        const current = userRec.power_tokens || 0;
        if (current < amount) return false;
        await pb.collection('users').update(pbId, { power_tokens: current - amount });
        await refreshBalance();
        return true;
      } catch (e) {
        console.warn('[Wallet] spendPowerTokens PB fallback failed', e);
        return false;
      }
    }
  }

  async function addPowerTokens(amount: number, type = 'game_win'): Promise<void> {
    if (!pbId) return;
    try {
      await api.gameReward(pbId, amount, type);
      await refreshBalance();
    } catch {
      // PB SDK fallback — increment power_tokens directly
      try {
        const userRec = await pb.collection('users').getOne(pbId, { fields: 'id,power_tokens' });
        await pb.collection('users').update(pbId, {
          power_tokens: (userRec.power_tokens || 0) + amount,
        });
        await refreshBalance();
      } catch (e) {
        console.warn('[Wallet] addPowerTokens PB fallback failed', e);
      }
    }
  }

  async function createWithdrawal(
    method: string,
    addressOrEmail: string,
    amount: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Not authenticated' };
    try {
      await api.createWithdrawal({ pbId, method, addressOrEmail, amount });
      await refreshBalance();
      await fetchWalletData();
      return { success: true };
    } catch {
      // PB SDK fallback — write directly to PocketBase
      try {
        const userRec = await pb.collection('users').getOne(pbId, {
          fields: 'id,shib_balance',
        });
        const currentBalance = userRec.shib_balance || 0;

        if (currentBalance < amount) {
          return { success: false, error: 'Insufficient balance' };
        }

        const completedRes = await pb.collection('withdrawals').getList(1, 200, {
          filter: `user="${pbId}" && status="completed"`,
          fields: 'id',
        });
        const completedCount = completedRes.totalItems || 0;
        const minAmount = calcMinAmount(completedCount);

        if (amount < minAmount) {
          return { success: false, error: `Minimum withdrawal is ${minAmount} SHIB` };
        }

        // Deduct balance first
        await pb.collection('users').update(pbId, {
          shib_balance: currentBalance - amount,
        });

        // Create withdrawal record
        try {
          await pb.collection('withdrawals').create({
            user: pbId,
            method,
            address_or_email: addressOrEmail,
            amount,
            status: 'pending',
          });
        } catch (createErr) {
          // Rollback balance on failure
          await pb.collection('users').update(pbId, { shib_balance: currentBalance }).catch(() => {});
          throw createErr;
        }

        await refreshBalance();
        await fetchWalletData();
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e?.message ?? 'Withdrawal failed' };
      }
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
