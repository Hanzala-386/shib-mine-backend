import { fetch } from 'expo/fetch';
import { getApiUrl } from '@/lib/query-client';

async function request<T = any>(
  method: string,
  path: string,
  body?: object,
): Promise<T> {
  const url = new URL(path, getApiUrl()).toString();
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  // ── Settings ───────────────────────────────────────────────────────────
  getSettings: () => request<AppSettings>('GET', '/api/app/settings'),

  // ── Auth ──────────────────────────────────────────────────────────────
  // Called after Firebase emailVerified = true.
  // Creates / updates PB user with is_verified: true.
  confirmVerified: (payload: {
    firebaseUid: string;
    email: string;
    displayName?: string;
    referralCode?: string;
    referredBy?: string;
  }) => request<PBUser>('POST', '/api/app/auth/confirm-verified', payload),

  syncUser: (payload: {
    firebaseUid: string;
    email: string;
    displayName?: string;
    referralCode?: string;
    referredBy?: string;
  }) => request<PBUser>('POST', '/api/app/auth/sync', payload),

  getUser: (firebaseUid: string) =>
    request<PBUser>('GET', `/api/app/user/${encodeURIComponent(firebaseUid)}`),

  updateBalance: (pbId: string, shibBalance?: number, powerTokens?: number) =>
    request<PBUser>('PUT', `/api/app/user/${pbId}/balance`, {
      shibBalance,
      powerTokens,
    }),

  // ── Mining ────────────────────────────────────────────────────────────
  startMining: (payload: {
    pbId: string;
    multiplier?: number;
    miningRatePerSec?: number;
    durationMinutes?: number;
  }) => request<MiningSessionResponse>('POST', '/api/app/mine/start', payload),

  getActiveMining: (pbId: string) =>
    request<{ session: ActiveSession | null }>('GET', `/api/app/mine/active/${pbId}`),

  claimMining: (payload: { sessionId: string; pbId: string; reward: number }) =>
    request<{ success: boolean; newShibBalance: number; reward: number }>(
      'POST',
      '/api/app/mine/claim',
      payload,
    ),

  // ── Boosters ──────────────────────────────────────────────────────────
  activateBooster: (payload: { pbId: string; multiplier: number }) =>
    request<{
      success: boolean;
      multiplier: number;
      expiresAt: string;
      newPowerTokens: number;
    }>('POST', '/api/app/boosters/activate', payload),

  getActiveBooster: (pbId: string) =>
    request<{ multiplier: number; expiresAt: string | null }>(
      'GET',
      `/api/app/boosters/active/${pbId}`,
    ),

  // ── Withdrawals ───────────────────────────────────────────────────────
  getWithdrawalTier: (pbId: string) =>
    request<WithdrawalTier>('GET', `/api/app/withdrawals/tier/${pbId}`),

  createWithdrawal: (payload: {
    pbId: string;
    method: string;
    addressOrEmail: string;
    amount: number;
  }) => request<WithdrawalResponse>('POST', '/api/app/withdrawals', payload),

  getWithdrawals: (pbId: string) =>
    request<WithdrawalRecord[]>('GET', `/api/app/withdrawals/${pbId}`),

  // ── Game ──────────────────────────────────────────────────────────────
  gameReward: (pbId: string, amount: number, type = 'game_win') =>
    request<{ success: boolean; newPowerTokens: number }>(
      'POST',
      '/api/app/game/reward',
      { pbId, amount, type },
    ),

  gameSpend: (pbId: string, amount: number) =>
    request<{ success: boolean; newPowerTokens: number; reason?: string }>(
      'POST',
      '/api/app/game/spend',
      { pbId, amount },
    ),

  // ── Referral ──────────────────────────────────────────────────────────
  validateReferralCode: (code: string) =>
    request<{ valid: boolean; referrerName?: string }>(
      'GET',
      `/api/app/auth/validate-referral?code=${encodeURIComponent(code.trim().toUpperCase())}`,
    ),

  getReferralStats: (pbId: string) =>
    request<{ referredCount: number; totalEarnings: number }>(
      'GET',
      `/api/app/user/${pbId}/referral-stats`,
    ),

  // ── Admin ─────────────────────────────────────────────────────────────
  adminGetUsers: (page = 1) =>
    request<AdminUsersResponse>('GET', `/api/app/admin/users?page=${page}`),

  adminGetWithdrawals: (status?: string) =>
    request<AdminWithdrawalsResponse>(
      'GET',
      `/api/app/admin/withdrawals${status ? `?status=${status}` : ''}`,
    ),

  adminUpdateWithdrawal: (id: string, status: string) =>
    request('PUT', `/api/app/admin/withdrawals/${id}`, { status }),

  adminUpdateSettings: (id: string, updates: Partial<AppSettings>) =>
    request('PUT', `/api/app/admin/settings/${id}`, updates),

  adminGetStats: () => request<AdminStats>('GET', '/api/app/admin/stats'),
};

// ── Types ──────────────────────────────────────────────────────────────────
export interface PBUser {
  pbId: string;
  firebaseUid: string;
  email: string;
  displayName: string;
  referralCode: string;
  referredBy: string;
  referralEarnings: number;
  shibBalance: number;
  powerTokens: number;
  totalClaims: number;
  totalWins: number;
  is_verified: boolean;
  isVerified?: boolean;
  created: string;
}

export interface AppSettings {
  id: string;
  miningRatePerSec: number;
  powerTokenPerClick: number;
  miningDurationMinutes: number;
  tokensPerRound: number;
  boostCosts: { '2x': number; '4x': number; '6x': number; '10x': number };
  minWithdrawal1: number;
  minWithdrawal2: number;
  minWithdrawal3: number;
  showAds: boolean;
  activeAdNetwork: string;
  admobUnitId: string;
  admobBannerUnitId: string;
  applovinSdkKey: string;
  applovinRewardedId: string;
  unityGameId: string;
  unityRewardedId: string;
}

export interface MiningSessionResponse {
  id: string;
  pbId: string;
  startTime: string;
  durationMs: number;
  multiplier: number;
  expectedReward: number;
  miningRatePerSec: number;
  ptDeducted: number;
  newPowerTokens: number;
  status: string;
}

export interface ActiveSession {
  id: string;
  startTime: string;
  durationMs: number;
  status: 'mining' | 'ready_to_claim';
}

export interface WithdrawalTier {
  tier: number;
  minAmount: number;
  completedCount: number;
}

export interface WithdrawalResponse {
  id: string;
  status: string;
  amount: number;
  newBalance: number;
}

export interface WithdrawalRecord {
  id: string;
  method: string;
  addressOrEmail: string;
  amount: number;
  status: string;
  created: string;
}

export interface AdminUsersResponse {
  items: PBUser[];
  totalItems: number;
  totalPages: number;
  page: number;
}

export interface AdminWithdrawalsResponse {
  items: AdminWithdrawal[];
  totalItems: number;
}

export interface AdminWithdrawal {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  method: string;
  addressOrEmail: string;
  amount: number;
  status: string;
  created: string;
}

export interface AdminStats {
  totalUsers: number;
  totalSessions: number;
  totalWithdrawals: number;
  pendingWithdrawals: number;
}
