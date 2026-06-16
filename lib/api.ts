import { getApiUrl } from '@/lib/query-client';
import { pb } from '@/lib/pocketbase';

async function request<T = any>(
  method: string,
  path: string,
  body?: object,
  timeoutMs = 12000,
): Promise<T> {
  const url = new URL(path, getApiUrl()).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      const err: any = new Error(data?.error || `HTTP ${res.status}`);
      err.data = data;
      err.status = res.status;
      if (data?.code) err.code = data.code;
      throw err;
    }
    return data as T;
  } catch (err: any) {
    // expo/fetch throws a plain Error with message containing "cancel" or "abort"
    // rather than a proper AbortError — catch both forms.
    const msg: string = err?.message ?? '';
    const isAbort =
      err?.name === 'AbortError' ||
      msg.toLowerCase().includes('cancel') ||
      msg.toLowerCase().includes('abort') ||
      msg.toLowerCase().includes('timed out');
    if (isAbort) throw new Error('Request timed out. Check your connection.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Robust POST — uses globalThis.fetch (standard RN fetch, no expo/fetch streaming
// layer) so it is immune to the expo/fetch AbortController cancellation bug on
// Android. Used for critical user-action endpoints like delete-account OTP where
// a spurious "Fetch request has been canceled" would be highly confusing.
async function robustPost<T = any>(
  path: string,
  body: object,
  timeoutMs = 30000,
  retries = 1,
): Promise<T> {
  const url = new URL(path, getApiUrl()).toString();
  let lastErr: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // globalThis.fetch = React Native's built-in fetch (not expo/fetch streaming)
      const res = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) {
        const err: any = new Error(data?.error || `HTTP ${res.status}`);
        err.data = data;
        err.status = res.status;
        if (data?.code) err.code = data.code;
        throw err;
      }
      return data as T;
    } catch (err: any) {
      lastErr = err;
      const msg: string = err?.message ?? '';
      const isCanceled =
        err?.name === 'AbortError' ||
        msg.toLowerCase().includes('cancel') ||
        msg.toLowerCase().includes('abort');
      // Only retry on cancellation errors, not on real HTTP errors
      if (!isCanceled || attempt >= retries) break;
      console.warn(`[robustPost] Attempt ${attempt + 1} canceled — retrying...`);
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      clearTimeout(timer);
    }
  }

  const msg: string = lastErr?.message ?? '';
  const isCanceled =
    lastErr?.name === 'AbortError' ||
    msg.toLowerCase().includes('cancel') ||
    msg.toLowerCase().includes('abort');
  if (isCanceled) throw new Error('Request timed out. Check your connection and try again.');
  throw lastErr;
}

export const api = {
  // ── Settings ───────────────────────────────────────────────────────────
  getSettings: () => request<AppSettings>('GET', '/api/app/settings'),

  // ── Daily Rewards ─────────────────────────────────────────────────────
  getDailyStatus: (pbId: string) =>
    request<DailyStatus>('GET', `/api/app/daily/status/${encodeURIComponent(pbId)}`),
  claimDailyReward: (pbId: string) =>
    request<DailyClaimResult>('POST', `/api/app/daily/claim/${encodeURIComponent(pbId)}`, {}),
  getDailySettings: () =>
    request<DailyClaimSettings>('GET', '/api/app/daily/settings'),

  // ── Server time — anti-clock-manipulation ──────────────────────────────
  getServerTime: () => request<{ serverTime: number }>('GET', '/api/app/server-time'),

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

  checkEmailExists: (email: string) =>
    request<{ found: boolean; verified: boolean }>('POST', '/api/app/auth/check-email', { email }),

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

  // reward is calculated 100% server-side — only sessionId + pbId sent
  claimMining: (payload: { sessionId: string; pbId: string }) =>
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
      error?: string;
    }>('POST', '/api/app/boosters/activate', payload),

  // Atomic: deducts booster + mining cost, sets booster, creates session — one round-trip
  activateAndMine: (payload: { pbId: string; multiplier: number }) =>
    request<{
      id: string;
      pbId: string;
      startTimeMs: number;
      endTimeMs: number;
      durationMs: number;
      multiplier: number;
      expectedReward: number;
      miningRatePerSec: number;
      boosterExpiresAt: string;
      ptDeducted: number;
      newPowerTokens: number;
      serverTime: number;
      status: string;
    }>('POST', '/api/app/boosters/activate-and-mine', payload),

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
    netAmount: number;
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

  // ── Ad reward tokens ──────────────────────────────────────────────────
  requestAdToken: (pbId: string) =>
    request<{ token: string; reward: number }>(
      'POST',
      '/api/app/ad/token',
      { pbId },
    ),

  claimAdToken: (pbId: string, token: string) =>
    request<{ success: boolean; newPowerTokens: number; reward: number }>(
      'POST',
      '/api/app/ad/claim',
      { pbId, token },
    ),

  // ── Shop ──────────────────────────────────────────────────────────────
  shopGetItems: (pbId: string) =>
    request<{ purchasedItems: string[] }>('GET', `/api/app/shop/items/${pbId}`),

  shopBuyKnife: (pbId: string, itemId: string) =>
    request<{ success: boolean; newPowerTokens: number; purchasedItems: string[] }>(
      'POST', '/api/app/shop/buy', { pbId, itemId },
    ),

  // ── Referral ──────────────────────────────────────────────────────────
  validateReferralCode: (code: string) =>
    request<{ valid: boolean; referrerName?: string }>(
      'GET',
      `/api/app/auth/validate-referral?code=${encodeURIComponent(code.trim().toUpperCase())}`,
    ),

  getReferralStats: (pbId: string) =>
    request<{
      referredCount: number;
      totalEarnings: number;
      referralBalance: number;
      referredUsers: { id: string; email: string; joined: string; claims: number }[];
    }>(
      'GET',
      `/api/app/user/${pbId}/referral-stats`,
    ),

  claimReferral: (pbId: string) =>
    request<{ success: boolean; claimed: number; newShibBalance: number }>(
      'POST',
      `/api/app/user/${pbId}/claim-referral`,
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

  // ── Tasks ─────────────────────────────────────────────────────────────
  getTasks: async (pbId: string): Promise<TaskItem[]> => {
    try {
      return await request<TaskItem[]>('GET', `/api/app/tasks?userId=${encodeURIComponent(pbId)}`);
    } catch {
      // PocketBase SDK fallback — replicates server logic exactly:
      // fetch active tasks + user submissions, then merge by task_id.
      try {
        const [tasksRes, subsRes] = await Promise.all([
          pb.collection('tasks').getList(1, 50, { filter: 'is_active=true', sort: 'created' }),
          pbId
            ? pb.collection('task_submissions').getList(1, 200, {
                filter: `user_id="${pbId}"`,
                fields: 'id,task_id,status,admin_notes',
              })
            : Promise.resolve({ items: [] } as any),
        ]);
        const subByTask: Record<string, any> = {};
        for (const s of subsRes.items || []) {
          // approved submission wins if multiple exist (matches server logic)
          if (!subByTask[s.task_id] || s.status === 'approved') {
            subByTask[s.task_id] = { id: s.id, status: s.status, admin_notes: s.admin_notes || '' };
          }
        }
        return (tasksRes.items || []).map((t: any) => ({
          id: t.id,
          title: t.title || '',
          description: t.description || '',
          link: t.link || '',
          reward_amount: Number(t.reward_amount) || 0,
          reward_type: (t.reward_type || 'PT') as 'SHIB' | 'PT',
          submission: subByTask[t.id] ?? null,
        }));
      } catch {
        return [];
      }
    }
  },

  submitTaskProof: async (params: { pbId: string; taskId: string; uri: string; base64: string }): Promise<{ success: boolean; submissionId: string }> => {
    // PRIMARY: PocketBase SDK direct upload — works on APK without Express.
    // Uses the React Native native FormData { uri, name, type } object — the only
    // supported way to attach a local file URI in React Native (Hermes engine).
    // new Blob([ArrayBuffer/Uint8Array]) is explicitly NOT supported in Hermes and
    // throws "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported".
    try {
      const form = new FormData();
      form.append('user_id', params.pbId);
      form.append('task_id', params.taskId);
      form.append('status', 'pending');
      // React Native native file attachment — no Blob, no ArrayBuffer
      form.append('proof_screenshot', {
        uri: params.uri,
        name: 'proof.jpg',
        type: 'image/jpeg',
      } as any);
      const rec = await pb.collection('task_submissions').create(form);
      return { success: true, submissionId: rec.id };
    } catch (pbErr: any) {
      // FALLBACK: Express backend with the same URI-based FormData trick
      const url = new URL('/api/app/tasks/submit', getApiUrl()).toString();
      const form = new FormData();
      form.append('pbId',   params.pbId);
      form.append('taskId', params.taskId);
      form.append('proof_screenshot', {
        uri: params.uri,
        name: 'proof.jpg',
        type: 'image/jpeg',
      } as any);
      const res = await globalThis.fetch(url, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (!data.submissionId) throw new Error('Upload failed — screenshot was not saved on the server');
      return data;
    }
  },

  // ── Admin: Tasks ──────────────────────────────────────────────────────
  adminGetTasks: () => request<AdminTask[]>('GET', '/api/admin/tasks'),

  adminCreateTask: (payload: {
    title: string; description: string; link: string;
    reward_amount: number; reward_type: 'SHIB' | 'PT'; is_active: boolean;
  }) => request<AdminTask>('POST', '/api/admin/tasks', payload),

  adminToggleTask: (id: string, is_active: boolean) =>
    request('PATCH', `/api/admin/tasks/${id}`, { is_active }),

  adminGetSubmissions: (status = 'pending') =>
    request<AdminTaskSubmission[]>('GET', `/api/admin/tasks/submissions?status=${status}`),

  getMiningHistory: (pbId: string) =>
    request<MiningHistoryRecord[]>('GET', `/api/app/mine/history/${encodeURIComponent(pbId)}`),

  adminApproveSubmission: (id: string, notes?: string) =>
    request<{ success: boolean }>('POST', `/api/admin/tasks/submissions/${id}/approve`, { notes: notes || '' }),

  adminRejectSubmission: (id: string, notes: string) =>
    request<{ success: boolean }>('POST', `/api/admin/tasks/submissions/${id}/reject`, { notes }),

  // Uses robustPost (globalThis.fetch, 30s timeout, 1 retry) — avoids expo/fetch
  // AbortController cancellation bug on Android for this critical user action.
  requestDeleteOtp: (pbId: string, email: string) =>
    robustPost<{ success: boolean }>('/api/auth/request-delete-otp', { pbId, email }),

  confirmDelete: (pbId: string, code: string) =>
    robustPost<{ success: boolean }>('/api/auth/confirm-delete', { pbId, code }),

  // ── Admin: Support Tickets ─────────────────────────────────────────────
  adminGetSupportTickets: () =>
    request<SupportTicketRecord[]>('GET', '/api/admin/support-tickets'),

  adminReplySupportTicket: (id: string, reply: string) =>
    request<{ success: boolean }>('PUT', `/api/admin/support-tickets/${id}/reply`, { reply }),
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
  activeBoosterMultiplier: number;
  boosterExpires: string;
  referralBalance: number;
  fraudAttempts: number;
  status: string;
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
  admobRewardedId: string;
  /* Unity Ads — IDs from PocketBase */
  unityGameId: string;
  unityRewardedId: string;
  unityInterstitialId: string;
  /* AppLovin MAX — IDs from PocketBase */
  applovinSdkKey: string;
  applovinRewardedId: string;
  applovinBannerId: string;
  applovinInterstitialId: string;
  appStoreLink: string;
  playStoreUrl: string;
  ratePopupFrequency: number;
  minimumVersion: string;
  dailyRewardDay1Shib: number;
  dailyRewardDay2Pt:   number;
  dailyRewardDay3Shib: number;
  dailyRewardDay4Pt:   number;
  dailyRewardDay5Shib: number;
  dailyRewardDay6Pt:   number;
  dailyRewardDay7Shib: number;
  dailyRewardDay7Pt:   number;
}

export interface DailyRewards {
  day1Shib: number;
  day2Pt:   number;
  day3Shib: number;
  day4Pt:   number;
  day5Shib: number;
  day6Pt:   number;
  day7Shib: number;
  day7Pt:   number;
}

export interface DailyStatus {
  streak: number;
  activeDay: number;
  canClaim: boolean;
  nextClaimAt: string | null;
  serverTime: string;
  rewards: DailyRewards;
}

export interface DailyClaimResult {
  success: boolean;
  claimDay: number;
  newStreak: number;
  rewardShib: number;
  rewardPt: number;
  newShibBalance: number;
  newPt: number;
  nextClaimAt: string;
  serverTime: string;
}

export interface DailyClaimSettings {
  id: string;
  day1ImageUrl: string | null;
  day1Amount: number;
  day2ImageUrl: string | null;
  day2Amount: number;
  day3ImageUrl: string | null;
  day3Amount: number;
  day4ImageUrl: string | null;
  day4Amount: number;
  day5ImageUrl: string | null;
  day5Amount: number;
  day6ImageUrl: string | null;
  day6Amount: number;
  day7ShibImageUrl: string | null;
  day7ShibAmount: number;
  day7PowerImageUrl: string | null;
  day7PowerAmount: number;
}

export interface MiningSessionResponse {
  id: string;
  pbId: string;
  startTime: string;
  startTimeMs: number;   // Unix ms — derived from PB's server-assigned `created`
  endTimeMs: number;     // Unix ms deadline
  durationMs: number;
  serverTime: number;    // Server Unix ms at response time — use to sync clock drift
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
  startTimeMs: number;   // Unix ms — derived from PB's created
  endTimeMs: number;     // Unix ms deadline
  durationMs: number;
  serverTime: number;    // Server Unix ms — use to sync clock drift
  multiplier: number;
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

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  link: string;
  reward_amount: number;
  reward_type: 'SHIB' | 'PT';
  submission: { id: string; status: 'pending' | 'approved' | 'rejected'; admin_notes: string } | null;
}

export interface AdminTask {
  id: string;
  title: string;
  description: string;
  link: string;
  reward_amount: number;
  reward_type: string;
  is_active: boolean;
  created: string;
}

export interface MiningHistoryRecord {
  id: string;
  startTime: string;
  claimedAmount: number;
  boosterMultiplier: number;
  created: string;
}

export interface AdminTaskSubmission {
  id: string;
  user_id: string;
  task_id: string;
  task_title: string;
  user_email: string;
  proof_screenshot: string;
  status: string;
  admin_notes: string;
  reward_amount: number;
  reward_type: string;
  created: string;
}

export interface SupportTicketRecord {
  id: string;
  user_pb_id: string;
  user_name: string;
  user_email: string;
  question: string;
  reply: string;
  status: 'Pending' | 'Replied';
  is_read_by_user: boolean;
  created: string;
}
