import { Platform } from 'react-native';
import { getApiUrl } from '@/lib/query-client';
import { pb } from '@/lib/pocketbase';
import {
  normalizeVipLevel,
  meetsVipRequirements,
  unmetVipRequirements,
  MAX_VIP_LEVEL,
  type VipMetrics,
} from '@shared/vip';

// ── Network guard (VPN/proxy/geo block) ─────────────────────────────────────
// SecurityContext registers a handler; any API response with status 403 and
// code NETWORK_BLOCKED immediately triggers the full-screen security overlay.
let networkBlockHandler: (() => void) | null = null;
export function setNetworkBlockHandler(fn: (() => void) | null) {
  networkBlockHandler = fn;
}
function maybeTriggerNetworkBlock(status: number, data: any) {
  if (status === 403 && data?.code === 'NETWORK_BLOCKED') {
    try {
      networkBlockHandler?.();
    } catch {}
  }
}

// Never call res.json() directly: when a server is mid-deploy or a route is
// missing, it answers with an HTML error page ("<!DOCTYPE ...") and res.json()
// crashes with "Unexpected token '<'". Parse text first and convert non-JSON
// responses into a clean, user-readable error instead.
async function parseJsonSafe(res: Response): Promise<any> {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const err: any = new Error(
      res.ok
        ? 'The server sent an unexpected response. Please try again.'
        : 'The server is being updated. Please try again in a few minutes.',
    );
    err.status = res.status;
    err.nonJson = true;
    throw err;
  }
}

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
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      maybeTriggerNetworkBlock(res.status, data);
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
      const data = await parseJsonSafe(res);
      if (!res.ok) {
        maybeTriggerNetworkBlock(res.status, data);
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

  // ── Security: network guard verdict (VPN / proxy / geo) ────────────────
  networkCheck: () =>
    request<{ blocked: boolean; reason: string | null }>(
      'GET',
      '/api/app/security/network-check',
      undefined,
      8000,
    ),

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

  // Destination + net amount are resolved SERVER-SIDE from the user's
  // KYC-verified record — only the method preference + gross amount are sent.
  createWithdrawal: (payload: {
    pbId: string;
    method: string;
    amount: number;
  }) => request<WithdrawalResponse>('POST', '/api/app/withdrawals', payload),

  getWithdrawals: (pbId: string) =>
    request<WithdrawalRecord[]>('GET', `/api/app/withdrawals/${pbId}`),

  // ── Game ──────────────────────────────────────────────────────────────
  gameReward: (pbId: string, amount: number, type = 'game_win', matchId?: string) =>
    request<{ success: boolean; newPowerTokens: number }>(
      'POST',
      '/api/app/game/reward',
      { pbId, amount, type, ...(matchId ? { matchId } : {}) },
    ),

  gameSpend: (pbId: string, amount: number) =>
    request<{ success: boolean; newPowerTokens: number; reason?: string }>(
      'POST',
      '/api/app/game/spend',
      { pbId, amount },
    ),

  // ── Ad reward tokens ──────────────────────────────────────────────────
  // matchId binds the 2× ad reward to the server-committed game session so the
  // same match cannot be double-claimed via the ad path AND the regular path.
  requestAdToken: (pbId: string, matchId?: string) =>
    request<{ token: string; reward: number }>(
      'POST',
      '/api/app/ad/token',
      { pbId, ...(matchId ? { matchId } : {}) },
    ),

  claimAdToken: (pbId: string, token: string, matchId?: string) =>
    request<{ success: boolean; newPowerTokens: number; reward: number }>(
      'POST',
      '/api/app/ad/claim',
      { pbId, token, ...(matchId ? { matchId } : {}) },
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

  // ── KYC Verification ──────────────────────────────────────────────────
  submitVerification: (payload: {
    pbId: string;
    fullName: string;
    country: string;
    phone: string;
    binanceEmail?: string;
    bep20Address: string;
  }) =>
    robustPost<{ success: boolean; status: string; requestId: string }>(
      '/api/app/verification/submit',
      payload,
    ),

  getVerificationStatus: (pbId: string) =>
    request<{
      kycStatus: KycStatus;
      rejectReason: string;
      request: VerificationRequestRecord | null;
    }>('GET', `/api/app/verification/status/${encodeURIComponent(pbId)}`),

  adminGetVerifications: (status = 'under_review') =>
    request<{ items: VerificationRequestRecord[]; totalItems: number }>(
      'GET',
      `/api/app/admin/verification?status=${encodeURIComponent(status)}`,
    ),

  adminApproveVerification: (id: string) =>
    request<{ success: boolean }>('POST', `/api/app/admin/verification/${id}/approve`, {}),

  adminRejectVerification: (id: string, reason: string) =>
    request<{ success: boolean }>('POST', `/api/app/admin/verification/${id}/reject`, { reason }),

  adminUnverifyUser: (pbId: string) =>
    request<{ success: boolean }>('POST', '/api/app/admin/verification/unverify', { pbId }),

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
        // Return ALL active tasks with submission status attached.
        // The DB unique index + server duplicate check are the authoritative
        // guards; the frontend decides how to render each status (locked state,
        // pending pill, or upload button).
        return (tasksRes.items || []).map((t: any) => ({
          id:            t.id,
          title:         t.title         || '',
          description:   t.description   || '',
          link:          t.link          || '',
          reward_amount: Number(t.reward_amount) || 0,
          reward_type:   (t.reward_type  || 'PT') as 'SHIB' | 'PT',
          submission:    subByTask[t.id] ?? null,
        }));
      } catch {
        return [];
      }
    }
  },

  submitTaskProof: async (params: {
    pbId: string;
    taskId: string;
    uri: string;
    base64: string;
    taskTitle: string;
    userEmail: string;
    rewardAmount: number;
    rewardType: string;
  }): Promise<{ success: boolean; submissionId: string }> => {
    // Primary production endpoint — Railway server fetches task/user metadata as
    // PocketBase admin on the server side, so no field can collapse to 0 or null.
    const RAILWAY_URL =
      process.env.EXPO_PUBLIC_RAILWAY_URL ||
      'https://backend.webcod.in';
    const RAILWAY_ENDPOINT = `${RAILWAY_URL}/api/app/tasks/submit`;
    const PB_ENDPOINT = 'https://api.webcod.in/api/collections/task_submissions/records';

    const fetchWithTimeout = (url: string, opts: RequestInit, ms = 30_000): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      return globalThis.fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    };

    // Platform-aware file appender.
    // Web: real Blob required — { uri, name, type } is RN-only and breaks in browsers.
    // Native: { uri, name, type } object is read as binary by the RN bridge.
    const appendProof = async (form: FormData, fieldName: string): Promise<void> => {
      if (Platform.OS === 'web') {
        const blob = await globalThis.fetch(`data:image/jpeg;base64,${params.base64}`).then(r => r.blob());
        (form as any).append(fieldName, blob, 'proof.jpg');
      } else {
        (form as any).append(fieldName, {
          uri:  `data:image/jpeg;base64,${params.base64}`,
          name: 'proof.jpg',
          type: 'image/jpeg',
        });
      }
    };

    // ── PATH 1 · Railway (PRIMARY — production server) ────────────────────
    // Server fetches metadata from PocketBase authoritatively. Client fields
    // are sent as a belt-and-suspenders fallback so the server can use them
    // if its own PB fetch yields empty values (e.g., stale task cache).
    try {
      const form = new FormData();
      form.append('pbId',          params.pbId);
      form.append('taskId',        params.taskId);
      form.append('task_title',    params.taskTitle);
      form.append('user_email',    params.userEmail);
      form.append('reward_amount', String(params.rewardAmount));
      form.append('reward_type',   params.rewardType);
      await appendProof(form, 'proof_screenshot');
      const res = await fetchWithTimeout(RAILWAY_ENDPOINT, { method: 'POST', body: form });
      const data = await res.json();
      if (data.submissionId) return { success: true, submissionId: data.submissionId };
      throw new Error(data?.error || `Railway ${res.status}`);
    } catch (e1: any) {
      console.warn('[submitTaskProof] railway failed:', e1?.message);
    }

    // ── Helper: look up any existing submission for this user + task ─────
    // Used by Paths 2 & 3 when PocketBase rejects with a unique-constraint
    // violation — the user already submitted, so we return their existing
    // record instead of hard-failing (idempotent behaviour).
    const fetchExisting = async (): Promise<{ success: boolean; submissionId: string } | null> => {
      try {
        const pbToken = pb.authStore.token;
        const filter = encodeURIComponent(`user_id="${params.pbId}" && task_id="${params.taskId}"`);
        const existRes = await globalThis.fetch(
          `${PB_ENDPOINT}?filter=${filter}&perPage=1`,
          { headers: pbToken ? { Authorization: pbToken } : {} },
        );
        const existData = await existRes.json();
        const existing = existData?.items?.[0];
        if (existing?.id) {
          console.log('[submitTaskProof] idempotent — returning existing submission:', existing.id);
          return { success: true, submissionId: existing.id };
        }
      } catch { /* ignore — let the outer error propagate */ }
      return null;
    };

    // ── PATH 2 · Direct PocketBase REST (fallback) ────────────────────────
    // Client supplies all fields explicitly so no value is missing if Railway
    // is temporarily unreachable.
    try {
      const form = new FormData();
      form.append('user_id',       params.pbId);
      form.append('task_id',       params.taskId);
      form.append('status',        'pending');
      form.append('task_title',    params.taskTitle);
      form.append('user_email',    params.userEmail);
      form.append('reward_amount', String(params.rewardAmount));
      form.append('reward_type',   params.rewardType);
      await appendProof(form, 'proof_screenshot');
      const pbToken = pb.authStore.token;
      const res = await fetchWithTimeout(PB_ENDPOINT, {
        method:  'POST',
        headers: pbToken ? { Authorization: pbToken } : {},
        body:    form,
      });
      const data = await res.json();
      if (data.id) return { success: true, submissionId: data.id };
      // Unique-constraint → return existing submission (idempotent)
      if (res.status === 400) {
        const isUnique = data?.data && Object.values(data.data as Record<string, any>)
          .some((v: any) => v?.code === 'validation_not_unique');
        if (isUnique) {
          const existing = await fetchExisting();
          if (existing) return existing;
        }
      }
      throw new Error(data?.message || `PB REST ${res.status}`);
    } catch (e2: any) {
      console.warn('[submitTaskProof] pb-rest failed:', e2?.message);
    }

    // ── PATH 3 · PocketBase SDK (last-resort fallback) ────────────────────
    try {
      const form = new FormData();
      form.append('user_id',       params.pbId);
      form.append('task_id',       params.taskId);
      form.append('status',        'pending');
      form.append('task_title',    params.taskTitle);
      form.append('user_email',    params.userEmail);
      form.append('reward_amount', String(params.rewardAmount));
      form.append('reward_type',   params.rewardType);
      await appendProof(form, 'proof_screenshot');
      const rec = await pb.collection('task_submissions').create(form);
      return { success: true, submissionId: rec.id };
    } catch (e3: any) {
      console.warn('[submitTaskProof] pb-sdk failed:', e3?.message);
      // Unique-constraint from PB SDK → idempotent fallback
      if (e3?.status === 400 || e3?.message?.includes('Failed to create')) {
        const existing = await fetchExisting();
        if (existing) return existing;
      }
      throw e3;
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

  // ── VIP Tier System ────────────────────────────────────────────────────
  getVipStatus: (pbId: string) => getVipStatusImpl(pbId),
  vipUpgrade: (pbId: string) => vipUpgradeImpl(pbId),
  adminSetUserVip: (pbId: string, level: number) => adminSetUserVipImpl(pbId, level),
  adminSearchUsers: (q: string) => adminSearchUsersImpl(q),
};

// ── Tournament points sync (PRODUCTION-SAFE, client-side) ────────────────────
// The published APK has NO Express server, so the dev-only `/api/app/tournament/
// sync-points` route is unreachable and `users.weekly_tournament_points` — the
// AUTHORITATIVE field the leaderboard sorts by — never updates → points stuck at 0.
// This mirrors the server's `syncUserTournamentPoints` via the PocketBase SDK so
// points are recomputed on every claim in production too. `users.updateRule` is a
// self-update rule (`@request.auth.id = id`), so the signed-in user may write its
// own record.
//
// Anti-resurrection: only writes while the current cycle is ACTIVE and in-window,
// so it never re-creates points that `runEndOfCycle` already zeroed after payout.
// Best-effort: any failure returns 0 and must never block the claim or the balance
// credit that already completed before this runs.
export async function syncTournamentPointsToPb(pbId: string): Promise<number> {
  if (!pbId) return 0;
  try {
    // 1. Latest tournament config — need the cycle window + id.
    const cfgList = await pb.collection('tournament_config').getList(1, 1, { sort: '-created' });
    const cfg: any = cfgList?.items?.[0];
    if (!cfg) return 0;

    const startIso = cfg.start_time || cfg.week_start;
    if (!startIso) return 0;

    // Only accrue inside an active, not-yet-ended cycle. This matches the server's
    // intent and prevents resurrecting points that the end-of-cycle payout wiped.
    const endMs = cfg.end_time ? new Date(cfg.end_time).getTime() : Infinity;
    if (cfg.is_active !== true || Date.now() >= endMs) return 0;

    const cycleId = cfg.cycle_id || '';

    // 2. Only participants earn points (server gates on tournament_joined too).
    const u: any = await pb.collection('users').getOne(pbId, {
      fields: 'id,tournament_joined,display_name,email,weekly_tournament_points',
    });
    if (!u?.tournament_joined) return 0;

    // 3. Sum every session CLAIMED during this cycle. TWO independent bugs lived
    //    here — both had to be fixed or points stayed 0:
    //    (a) FIELD: key off `updated` (the claim writes claimed_amount, bumping PB's
    //        `updated` to claim-time) NOT `start_time`. A 60-min session started
    //        BEFORE the cycle but claimed INSIDE it must still score. `start_time >=
    //        cycleStart` implies `updated >= cycleStart`, so `updated` is the strict
    //        superset and the correct "earned during the cycle" signal.
    //    (b) FORMAT: PocketBase datetime filters parse a SPACE separator, NOT the ISO
    //        `T`. tournament_config.start_time is stored as TEXT with a `T`
    //        (e.g. "2026-06-21T06:18:00.000Z"); passed raw it matched ZERO rows, so
    //        points stuck at 0 forever. Convert `T`→space before comparing. Verified
    //        live: T-form → 0 rows, space-form → correct rows.
    //    `claimed_amount > 0` excludes the -1 fraud/void sentinel and unclaimed rows.
    const filterStart = startIso.replace('T', ' ');
    // (c) Upper-bound on end_time (only when it's a valid date) so a claim that lands
    //     AFTER the cycle ends — device-clock skew or end-of-cycle payout lag — can't
    //     be miscounted into this cycle. `endMs` was computed above; reuse it as the
    //     validity guard (Infinity/NaN ⇒ no bound, never an empty "updated < ''").
    const filterEnd = Number.isFinite(endMs)
      ? ` && updated < "${String(cfg.end_time).replace('T', ' ')}"`
      : '';
    const sessions = await pb.collection('mining_sessions').getFullList({
      filter: `user = "${pbId}" && claimed_amount > 0 && updated >= "${filterStart}"${filterEnd}`,
      fields: 'claimed_amount',
      batch: 500,
    });
    const total = sessions.reduce(
      (sum: number, s: any) => sum + (Number(s.claimed_amount) || 0),
      0,
    );

    // 4. AUTHORITATIVE write — standalone update (NEVER bundle with balance credit).
    //    Skip when unchanged so repeated calls (claim + leaderboard refresh) don't churn.
    if (Number(u.weekly_tournament_points) !== total) {
      await pb.collection('users').update(pbId, { weekly_tournament_points: total });
    }

    // 5. Mirror into the cosmetic participant row for the active cycle (create it if
    //    missing — the admin DB column reads from here). Non-critical.
    try {
      let row: any = null;
      try {
        row = await pb
          .collection('tournament_participants')
          .getFirstListItem(`user_id = "${pbId}"`, { sort: '-created' });
      } catch {
        row = null;
      }

      const rowMatchesCycle =
        !!row?.id && (cycleId === '' || (row.cycle_id ?? '') === cycleId);

      if (rowMatchesCycle) {
        if (Number(row.points) !== total) {
          await pb.collection('tournament_participants').update(row.id, { points: total });
        }
      } else if (cycleId) {
        const dn = u.display_name || u.email || 'Miner';
        await pb.collection('tournament_participants').create({
          user_id:      pbId,
          display_name: typeof dn === 'string' ? dn.split('@')[0] : 'Miner',
          cycle_id:     cycleId,
          week_start:   startIso,
          joined_at:    new Date().toISOString(),
          points:       total,
        });
      }
    } catch {
      /* cosmetic mirror — never blocks the authoritative write */
    }

    return total;
  } catch {
    return 0;
  }
}

// ── VIP wrappers: try Express/Railway first, fall back to PocketBase SDK ──────
export interface VipStatusResult {
  vipLevel: number;
  isAdminPromoted: boolean;
  adminPromotedLevel: number;
  metrics: VipMetrics;
}

export interface VipUpgradeResult {
  success: boolean;
  vipLevel: number;
  metrics?: VipMetrics;
  unmet?: string[];
  error?: string;
}

function pbFormatUserLite(u: any): PBUser {
  return {
    pbId: u.id,
    firebaseUid: u.firebase_uid,
    email: u.email,
    displayName: u.display_name || u.name || '',
    referralCode: u.referral_code || '',
    referredBy: u.referred_by || '',
    referralEarnings: u.referral_earnings || 0,
    shibBalance: u.shib_balance || 0,
    powerTokens: u.power_tokens ?? 10,
    hitTickets: u.hit_tickets ?? 0,
    totalClaims: u.total_claims || 0,
    totalWins: u.total_wins || 0,
    is_verified: !!u.is_verified,
    isVerified: !!u.is_verified,
    created: u.created,
    activeBoosterMultiplier: u.active_booster_multiplier || 1,
    boosterExpires: u.booster_expires || '',
    referralBalance: u.referral_balance || 0,
    fraudAttempts: u.fraud_attempts || 0,
    status: u.status || 'active',
    vipLevel: normalizeVipLevel(u.vip_level),
    isAdminPromoted: !!u.is_admin_promoted,
    adminPromotedLevel: normalizeVipLevel(u.admin_promoted_level),
    isBlacklist1: !!u.is_blacklist_1,
    isBlacklist2: !!u.is_blacklist_2,
  };
}

async function pbComputeVipMetrics(user: any): Promise<VipMetrics> {
  const pbId = user.id;
  const code = user.referral_code || '';
  const balance = Number(user.shib_balance) || 0;
  let refs = 0, tasks = 0, withdrawals = 0;
  try {
    const filter = code
      ? `referred_by="${code}" || referred_by="${pbId}"`
      : `referred_by="${pbId}"`;
    refs = (await pb.collection('users').getList(1, 1, { filter })).totalItems;
  } catch { /* metric stays 0 */ }
  try {
    tasks = (await pb.collection('task_submissions').getList(1, 1, {
      filter: `user_id="${pbId}" && status="approved"`,
    })).totalItems;
  } catch { /* metric stays 0 */ }
  try {
    withdrawals = (await pb.collection('withdrawals').getList(1, 1, {
      filter: `user="${pbId}" && status="completed"`,
    })).totalItems;
  } catch { /* metric stays 0 */ }
  const refIncome = Number(user.referral_earnings) || 0;
  return { refs, balance, refIncome, tasks, withdrawals };
}

async function getVipStatusImpl(pbId: string): Promise<VipStatusResult> {
  try {
    return await request<VipStatusResult>('GET', `/api/app/vip/status/${pbId}`);
  } catch {
    const user = await pb.collection('users').getOne(pbId);
    const metrics = await pbComputeVipMetrics(user);
    return {
      vipLevel: normalizeVipLevel(user.vip_level),
      isAdminPromoted: !!user.is_admin_promoted,
      adminPromotedLevel: normalizeVipLevel(user.admin_promoted_level),
      metrics,
    };
  }
}

async function vipUpgradeImpl(pbId: string): Promise<VipUpgradeResult> {
  try {
    return await request<VipUpgradeResult>('POST', '/api/app/vip/upgrade', { pbId });
  } catch (err: any) {
    // Server explicitly rejected (e.g. requirements not met) — surface it; do NOT
    // silently retry via PB-direct, which would re-check and reject identically.
    if (err?.status === 400 && err?.data) {
      return {
        success: false,
        vipLevel: err.data.vipLevel ?? 0,
        metrics: err.data.metrics,
        unmet: err.data.unmet,
        error: err.data.error,
      };
    }
    // Network/unreachable → PB-direct fallback with the SAME gating logic.
    const user = await pb.collection('users').getOne(pbId);
    const current = normalizeVipLevel(user.vip_level);
    const target = current + 1;
    if (target > MAX_VIP_LEVEL) {
      return { success: false, vipLevel: current, error: 'Already at maximum VIP level' };
    }
    const metrics = await pbComputeVipMetrics(user);
    if (!meetsVipRequirements(target, metrics)) {
      return {
        success: false,
        vipLevel: current,
        metrics,
        unmet: unmetVipRequirements(target, metrics) as string[],
        error: 'Requirements not met',
      };
    }
    await pb.collection('users').update(pbId, { vip_level: target });
    return { success: true, vipLevel: target, metrics };
  }
}

async function adminSetUserVipImpl(pbId: string, level: number): Promise<PBUser> {
  const lvl = normalizeVipLevel(level);
  try {
    return await request<PBUser>('POST', '/api/admin/users/vip', { pbId, level: lvl });
  } catch {
    const updated = await pb.collection('users').update(pbId, {
      vip_level: lvl,
      is_admin_promoted: true,
      admin_promoted_level: lvl,
    });
    return pbFormatUserLite(updated);
  }
}

async function adminSearchUsersImpl(q: string): Promise<PBUser[]> {
  const query = (q || '').trim();
  if (!query) return [];
  try {
    const r = await request<{ items: PBUser[] }>(
      'GET',
      `/api/admin/users/search?q=${encodeURIComponent(query)}`,
    );
    return r.items || [];
  } catch {
    const r = await pb.collection('users').getList(1, 20, {
      filter: `email~"${query}" || referral_code~"${query}" || display_name~"${query}"`,
      sort: '-created',
    });
    return (r.items || []).map(pbFormatUserLite);
  }
}

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
  hitTickets: number;
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
  vipLevel: number;
  isAdminPromoted: boolean;
  adminPromotedLevel: number;
  isBlacklist1?: boolean;
  isBlacklist2?: boolean;
  // ── KYC verification (server-managed) ──
  kycStatus?: KycStatus;
  kycRejectReason?: string;
  kycFullName?: string;
  kycCountry?: string;
  kycCountryCode?: string;
  kycPhone?: string;
  kycBinanceEmail?: string;
  kycBep20Address?: string;
}

export type KycStatus = 'none' | 'under_review' | 'verified' | 'rejected';

export interface VerificationRequestRecord {
  id: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  fullName: string;
  country: string;
  countryCode: string;
  phone: string;
  binanceEmail: string;
  bep20Address: string;
  status: string;
  rejectReason: string;
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
  /* Master ad-network override — when true, bypass AdMob and serve Unity Ads only */
  forceUnityOnly: boolean;
  /* Network guard kill-switch — when true, server blocks VPN/proxy/datacenter/geo IPs */
  networkGuardEnabled: boolean;
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
