import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
import storage from '@/lib/storage';
import { useAuth } from './AuthContext';
import { api } from '@/lib/api';
import { pb } from '@/lib/pocketbase';
import { notifyWithdrawalCancelled } from '@/lib/notifications';
import { lockedBalanceForVipLevel, availableBalanceAfterVipLock, normalizeVipLevel } from '@shared/vip';

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
  lockedShibBalance: number;
  availableShibBalance: number;
  powerTokens: number;
  withdrawals: WithdrawalRecord[];
  withdrawalTier: number;
  minWithdrawalAmount: number;
  isLoading: boolean;
  spendPowerTokens: (amount: number) => Promise<boolean>;
  addPowerTokens: (amount: number, type?: string) => Promise<void>;
  createWithdrawal: (method: string, addressOrEmail: string, amount: number, netAmount: number) => Promise<{ success: boolean; error?: string }>;
  refetch: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

async function fetchMinAmountFromPB(completedCount: number): Promise<number> {
  try {
    const res = await pb.collection('settings').getFirstListItem('');
    if (completedCount === 0) return Number(res.min_withdrawal_1) || 100;
    if (completedCount === 1) return Number(res.min_withdrawal_2) || 1000;
    return Number(res.min_withdrawal_3) || 8000;
  } catch {
    if (completedCount === 0) return 100;
    if (completedCount === 1) return 1000;
    return 8000;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { pbUser, user, refreshBalance } = useAuth();
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [withdrawalTier, setWithdrawalTier] = useState(1);
  const [minWithdrawalAmount, setMinWithdrawalAmount] = useState(100);
  const [isLoading, setIsLoading] = useState(false);

  // Track previous statuses to detect admin cancellations
  const prevStatusMapRef = useRef<Record<string, string>>({});

  const pbId = pbUser?.pbId ?? null;
  const uid = user?.uid ?? null;
  const rawShib = pbUser?.shibBalance;
  const rawPT = pbUser?.powerTokens;
  const shibBalance = typeof rawShib === 'number' && isFinite(rawShib) ? rawShib : 0;
  const powerTokens = typeof rawPT === 'number' && isFinite(rawPT) ? rawPT : 10;
  // VIP wallet lock: the active tier's required SHIB balance is locked; only the
  // remainder is withdrawable. Mirrors the server-side withdrawal gate.
  const vipLevel = normalizeVipLevel(pbUser?.vipLevel);
  const lockedShibBalance = lockedBalanceForVipLevel(vipLevel);
  const availableShibBalance = availableBalanceAfterVipLock(shibBalance, vipLevel);

  useEffect(() => {
    if (pbId) fetchWalletData();
  }, [pbId]);

  // Compares fetched withdrawals against previous statuses; fires push if any
  // moved from 'pending' → 'rejected' (admin cancellation).
  function detectCancellations(freshWds: WithdrawalRecord[]) {
    const prev = prevStatusMapRef.current;
    const isFirstLoad = Object.keys(prev).length === 0;
    const next: Record<string, string> = {};
    freshWds.forEach(w => { next[w.id] = w.status; });
    if (!isFirstLoad) {
      freshWds.forEach(w => {
        const wasStatus = prev[w.id];
        if (wasStatus === 'pending' && w.status === 'rejected') {
          // Fire local push — reason from PB field if available
          const reason = (w as any).cancellationReason || (w as any).cancellation_reason || undefined;
          notifyWithdrawalCancelled(reason).catch(() => {});
        }
      });
    }
    prevStatusMapRef.current = next;
  }

  async function fetchWalletData() {
    if (!pbId) return;
    setIsLoading(true);
    try {
      // Try Express first
      const [wds, tier] = await Promise.all([
        api.getWithdrawals(pbId),
        api.getWithdrawalTier(pbId),
      ]);
      detectCancellations(wds);
      setWithdrawals(wds);
      setWithdrawalTier(tier.tier);
      setMinWithdrawalAmount(tier.minAmount);
    } catch {
      // PB SDK fallback — query withdrawals collection directly
      try {
        const res = await pb.collection('withdrawals').getList(1, 50, {
          filter: `user="${pbId}"`,
          sort: '-created',
          fields: 'id,method,address_or_email,amount,status,cancellation_reason,created',
        });
        const wds: WithdrawalRecord[] = (res.items || []).map((w: any) => ({
          id: w.id,
          method: w.method,
          addressOrEmail: w.address_or_email,
          amount: w.amount,
          status: w.status,
          cancellation_reason: w.cancellation_reason,
          created: w.created,
        }));
        detectCancellations(wds);
        setWithdrawals(wds);

        const completedCount = wds.filter(w => w.status === 'completed').length;
        const tier = completedCount === 0 ? 1 : completedCount === 1 ? 2 : 3;
        setWithdrawalTier(tier);
        const minAmt = await fetchMinAmountFromPB(completedCount);
        setMinWithdrawalAmount(minAmt);

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
      // PocketBase SDK direct fallback — used when Express backend is unreachable.
      // Replicates the server's cap logic exactly using last_session_score stored
      // by the game WebSocket session, so anti-cheat is preserved even offline.
      try {
        const userRec = await pb.collection('users').getOne(pbId, {
          fields: 'id,power_tokens,last_session_score,total_accumulated_score,total_wins',
        });

        // ABSOLUTE_MAX_SCORE * 2 — matches server constant
        const ABSOLUTE_MAX = 4000;
        let safeAmount = Math.min(Math.max(0, Math.round(Number(amount) || 0)), ABSOLUTE_MAX);

        // Replicate server anti-cheat: cap at 2× server-validated session score
        const serverScore = Number(userRec.last_session_score) || 0;
        if (serverScore > 0 && safeAmount > serverScore * 2) {
          safeAmount = serverScore * 2;
        }

        if (safeAmount <= 0) {
          await refreshBalance().catch(() => {});
          return;
        }

        await pb.collection('users').update(pbId, {
          power_tokens:            (Number(userRec.power_tokens) || 0) + safeAmount,
          total_accumulated_score: (Number(userRec.total_accumulated_score) || 0) + safeAmount,
          total_wins:              type === 'game_win' ? (userRec.total_wins || 0) + 1 : userRec.total_wins || 0,
          last_session_score:      0, // reset after claim — matches server behaviour
        });
        await refreshBalance();
      } catch (e) {
        await refreshBalance().catch(() => {});
        throw e;
      }
    }
  }

  async function createWithdrawal(
    method: string,
    addressOrEmail: string,
    amount: number,
    netAmount: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Not authenticated' };
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: 'Invalid withdrawal amount' };
    try {
      await api.createWithdrawal({ pbId, method, addressOrEmail, amount, netAmount });
      await refreshBalance();
      await fetchWalletData();
      return { success: true };
    } catch {
      // PB SDK fallback — write directly to PocketBase
      try {
        const userRec = await pb.collection('users').getOne(pbId, {
          fields: 'id,shib_balance,vip_level',
        });
        const currentBalance = userRec.shib_balance || 0;

        if (currentBalance < amount) {
          return { success: false, error: 'Insufficient balance' };
        }

        // VIP wallet lock: required SHIB balance for the active tier cannot be withdrawn.
        const locked = lockedBalanceForVipLevel(userRec.vip_level);
        const available = Math.max(0, currentBalance - locked);
        if (amount > available) {
          return {
            success: false,
            error: `VIP ${normalizeVipLevel(userRec.vip_level)} locks ${locked} SHIB in your wallet. You can withdraw up to ${available} SHIB. Contact support@shibahit.com to remove your VIP tier.`,
          };
        }

        const completedRes = await pb.collection('withdrawals').getList(1, 200, {
          filter: `user="${pbId}" && status="completed"`,
          fields: 'id',
        });
        const completedCount = completedRes.totalItems || 0;
        const minAmount = await fetchMinAmountFromPB(completedCount);

        if (amount < minAmount) {
          return { success: false, error: `Minimum withdrawal is ${minAmount} SHIB` };
        }

        // Deduct balance first
        await pb.collection('users').update(pbId, {
          shib_balance: currentBalance - amount,
        });

        // Create withdrawal record — store net amount (after fees)
        try {
          await pb.collection('withdrawals').create({
            user: pbId,
            method,
            address_or_email: addressOrEmail,
            amount: netAmount,
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
    lockedShibBalance,
    availableShibBalance,
    powerTokens,
    withdrawals,
    withdrawalTier,
    minWithdrawalAmount,
    isLoading,
    spendPowerTokens,
    addPowerTokens,
    createWithdrawal,
    refetch: fetchWalletData,
  }), [shibBalance, lockedShibBalance, availableShibBalance, powerTokens, withdrawals, withdrawalTier, minWithdrawalAmount, isLoading, pbId]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
