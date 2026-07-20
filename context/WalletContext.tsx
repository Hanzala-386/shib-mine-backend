import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
import storage from '@/lib/storage';
import { useAuth } from './AuthContext';
import { api } from '@/lib/api';
import { apiRequest } from '@/lib/query-client';
import { pb } from '@/lib/pocketbase';
import { notifyWithdrawalCancelled } from '@/lib/notifications';
import { lockedBalanceForVipLevel, availableBalanceAfterVipLock, normalizeVipLevel } from '@shared/vip';
import { ticketsToShib, validateRedeem } from '@shared/gamehub';

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
  hitTickets: number;
  withdrawals: WithdrawalRecord[];
  withdrawalTier: number;
  minWithdrawalAmount: number;
  isLoading: boolean;
  spendPowerTokens: (amount: number) => Promise<boolean>;
  addPowerTokens: (amount: number, type?: string) => Promise<void>;
  createWithdrawal: (method: string, amount: number) => Promise<{ success: boolean; error?: string }>;
  redeem: (tickets: number) => Promise<{ success: boolean; shib?: number; error?: string }>;
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
  const rawHitTickets = pbUser?.hitTickets;
  const shibBalance = typeof rawShib === 'number' && isFinite(rawShib) ? rawShib : 0;
  const powerTokens = typeof rawPT === 'number' && isFinite(rawPT) ? rawPT : 10;
  const hitTickets = typeof rawHitTickets === 'number' && isFinite(rawHitTickets) ? rawHitTickets : 0;
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
    } catch (e) {
      // SERVER-ONLY: no client-side PB fallback. power_tokens is guarded by the
      // users updateRule (`power_tokens:isset = false`) so only the server can
      // move it — fail closed and let the user retry when the backend is back.
      console.warn('[Wallet] spendPowerTokens failed (server unreachable or rejected)', e);
      return false;
    }
  }

  async function addPowerTokens(amount: number, type = 'game_win'): Promise<void> {
    if (!pbId) return;
    try {
      await api.gameReward(pbId, amount, type);
      await refreshBalance();
    } catch (e) {
      // SERVER-ONLY: no client-side PB fallback. Rewards are validated against
      // the WebSocket-committed session score on the server; PocketBase rules
      // block client writes to power_tokens entirely. Fail closed — surface the
      // error so the caller can show a retry message (nothing was credited).
      await refreshBalance().catch(() => {});
      throw e;
    }
  }

  // KYC-locked withdrawal: client sends method + gross amount only; the
  // destination is ALWAYS resolved server-side (or from the user's verified
  // kyc_* fields in the PB fallback). Fee/net are recomputed here too.
  async function createWithdrawal(
    method: string,
    amount: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Not authenticated' };
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: 'Invalid withdrawal amount' };
    try {
      await api.createWithdrawal({ pbId, method, amount });
      await refreshBalance();
      await fetchWalletData();
      return { success: true };
    } catch (expressErr: any) {
      // Express returned a real validation error (4xx) — surface it.
      const status = Number(expressErr?.status);
      if (status >= 400 && status < 500) {
        return { success: false, error: expressErr?.data?.error || expressErr?.message || 'Withdrawal rejected' };
      }
      // SERVER-ONLY: no client-side PB fallback. Withdrawals debit shib_balance,
      // which is guarded by the users updateRule (`shib_balance:isset = false`) —
      // only the server can move it. Fail closed; the balance is untouched.
      return {
        success: false,
        error: 'Withdrawals are temporarily unavailable. Please check your connection and try again.',
      };
    }
  }

  // Redeem Hit Tickets for SHIB. SERVER-ONLY (no PB fallback) — hit_tickets and
  // shib_balance are guarded fields; only the Express server can move them.
  async function redeem(
    tickets: number,
  ): Promise<{ success: boolean; shib?: number; error?: string }> {
    if (!pbId) return { success: false, error: 'Not authenticated' };

    // Validate locally against the in-memory balance first.
    const check = validateRedeem(tickets, hitTickets);
    if (!check.ok) return { success: false, error: check.error };

    const refId = `redeem_${pbId}_${Date.now()}`;
    try {
      // Express-first — apiRequest attaches the PB session cookie (credentials:'include').
      const res = await apiRequest('POST', '/api/app/hub/redeem', { pbId, tickets, refId, token: pb.authStore.token });
      const data: any = await res.json().catch(() => ({}));
      await refreshBalance();
      await fetchWalletData();
      const shibOut = typeof data?.shib === 'number' ? data.shib : ticketsToShib(tickets);
      return { success: true, shib: shibOut };
    } catch {
      // NO client-side PB fallback for redemption. Hit Tickets are guarded by the
      // users updateRule (`hit_tickets:isset = false`) so ONLY the server (admin
      // token) can move them — the same guard that stops a cheater from minting
      // tickets with their own PB token also blocks a client-side debit here.
      // Redeem is therefore server-only: if the backend is unreachable, fail
      // closed and let the user retry (tickets are untouched — nothing was sent).
      return {
        success: false,
        error: 'Redemption is temporarily unavailable. Please check your connection and try again.',
      };
    }
  }

  const value = useMemo(() => ({
    shibBalance,
    lockedShibBalance,
    availableShibBalance,
    powerTokens,
    hitTickets,
    withdrawals,
    withdrawalTier,
    minWithdrawalAmount,
    isLoading,
    spendPowerTokens,
    addPowerTokens,
    createWithdrawal,
    redeem,
    refetch: fetchWalletData,
  }), [shibBalance, lockedShibBalance, availableShibBalance, powerTokens, hitTickets, withdrawals, withdrawalTier, minWithdrawalAmount, isLoading, pbId]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
