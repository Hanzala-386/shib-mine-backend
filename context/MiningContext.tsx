import React, {
  createContext, useContext, useState, useEffect,
  useRef, useMemo, ReactNode, useCallback,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import storage from '@/lib/storage';
import { useAuth } from './AuthContext';
import { api } from '@/lib/api';
import { pb } from '@/lib/pocketbase';

// ── PocketBase direct mining (fallback when Express is unreachable) ──────────
// Mining sessions schema: user (relation), start_time (date),
// claimed_amount (number), booster_multiplier (number), is_verified (bool)

const PB_DURATION_MS = 60 * 60 * 1000; // 60 minutes

async function pbStartMining(
  pbId: string,
  multiplier: number,
  miningRatePerSec: number,
  entryCost: number,
): Promise<{ id: string; startTimeMs: number; endTimeMs: number; durationMs: number; multiplier: number; expectedReward: number; newPowerTokens: number; serverTime: number; miningRatePerSec: number }> {
  const user = await pb.collection('users').getOne(pbId);
  const currentPt = Number(user.power_tokens) || 0;
  if (currentPt < entryCost) throw new Error(`Not enough Power Tokens. Need ${entryCost} PT.`);

  // Deduct PT first (optimistic; session creation may still fail)
  await pb.collection('users').update(pbId, { power_tokens: currentPt - entryCost });

  const now = new Date();
  const session = await pb.collection('mining_sessions').create({
    user: pbId,
    start_time: now.toISOString(),
    booster_multiplier: multiplier,
    claimed_amount: 0,
    is_verified: false,
  });

  await pb.collection('users').update(pbId, { current_mining_session: session.id });

  const startTimeMs = now.getTime();
  return {
    id: session.id,
    startTimeMs,
    endTimeMs: startTimeMs + PB_DURATION_MS,
    durationMs: PB_DURATION_MS,
    multiplier,
    expectedReward: miningRatePerSec * (PB_DURATION_MS / 1000) * multiplier,
    newPowerTokens: currentPt - entryCost,
    serverTime: Date.now(),
    miningRatePerSec,
  };
}

async function pbGetActiveMining(pbId: string): Promise<{ session: null | { id: string; startTimeMs: number; endTimeMs: number; durationMs: number; multiplier: number; serverTime: number } }> {
  try {
    const user = await pb.collection('users').getOne(pbId);
    const sessionId = user.current_mining_session;
    if (!sessionId) return { session: null };

    const s = await pb.collection('mining_sessions').getOne(sessionId);
    if ((Number(s.claimed_amount) || 0) > 0) {
      // already claimed — clear the reference
      await pb.collection('users').update(pbId, { current_mining_session: null }).catch(() => {});
      return { session: null };
    }

    const startTimeMs = new Date(s.start_time).getTime();
    return {
      session: {
        id: s.id,
        startTimeMs,
        endTimeMs: startTimeMs + PB_DURATION_MS,
        durationMs: PB_DURATION_MS,
        multiplier: Number(s.booster_multiplier) || 1,
        serverTime: Date.now(),
      },
    };
  } catch {
    return { session: null };
  }
}

async function pbClaimMining(
  sessionId: string,
  pbId: string,
  miningRatePerSec: number,
): Promise<{ reward: number }> {
  // Fetch session and user together
  const [s, user] = await Promise.all([
    pb.collection('mining_sessions').getOne(sessionId),
    pb.collection('users').getOne(pbId),
  ]);

  // ── Anti-fraud: block banned accounts immediately ──────────────────────────
  const userStatus = (user.status || '').toLowerCase();
  if (userStatus === 'blocked' || userStatus === 'banned') {
    throw Object.assign(new Error('Account is blocked due to suspicious activity.'), {
      data: { error: 'ACCOUNT_BLOCKED' },
    });
  }

  // ── Anti-fraud: reject double-claims ──────────────────────────────────────
  if ((Number(s.claimed_amount) || 0) > 0) {
    throw new Error('Session already claimed.');
  }

  // ── Anti-fraud: use server start_time, not device clock ───────────────────
  // The session's start_time is stored in PocketBase at session creation time.
  // Using it (not Date.now()) prevents users from back-dating their device clock
  // to make a 5-minute session appear as a full 60-minute session.
  const startTimeMs = new Date(s.start_time).getTime();
  if (isNaN(startTimeMs)) throw new Error('Invalid session start time.');

  const nowMs = Date.now();
  const elapsedMs = nowMs - startTimeMs;

  // Grace window: allow up to 5 minutes beyond the nominal mining duration
  const GRACE_MS = 5 * 60 * 1000;

  // Suspicious if claimed impossibly early (< 30 s) or impossibly late (> duration + grace)
  const isSuspicious = elapsedMs < 30_000 || elapsedMs > PB_DURATION_MS + GRACE_MS;
  if (isSuspicious) {
    const fraudAttempts = (Number(user.fraud_attempts) || 0) + 1;
    const shouldBlock   = fraudAttempts >= 3;
    await pb.collection('users').update(pbId, {
      fraud_attempts: fraudAttempts,
      ...(shouldBlock ? { status: 'blocked' } : {}),
    }).catch(() => {});
    // Mark session so it can't be retried
    await pb.collection('mining_sessions').update(sessionId, { claimed_amount: -1 }).catch(() => {});
    throw Object.assign(
      new Error(shouldBlock
        ? 'Account blocked after repeated clock manipulation attempts.'
        : 'Invalid claim time detected. Please do not modify your device clock.'),
      { data: { error: shouldBlock ? 'ACCOUNT_BLOCKED' : 'FRAUD_DETECTED' } },
    );
  }

  const multiplier = Number(s.booster_multiplier) || 1;
  const reward = miningRatePerSec * (Math.min(elapsedMs, PB_DURATION_MS) / 1000) * multiplier;

  await pb.collection('mining_sessions').update(sessionId, {
    claimed_amount: reward,
    is_verified: true,
  });

  await pb.collection('users').update(pbId, {
    shib_balance: (Number(user.shib_balance) || 0) + reward,
    total_claims: (Number(user.total_claims) || 0) + 1,
    current_mining_session: null,
  });

  // Referral commission (10%) — best-effort
  if (user.referred_by && reward > 0) {
    try {
      const referrer = await pb.collection('users').getFirstListItem(
        `referral_code="${user.referred_by}"`,
      );
      const commission = reward * 0.1;
      await pb.collection('users').update(referrer.id, {
        shib_balance: (Number(referrer.shib_balance) || 0) + commission,
        referral_balance: (Number(referrer.referral_balance) || 0) + commission,
        referral_earnings: (Number(referrer.referral_earnings) || 0) + commission,
      }).catch(() => {});
    } catch { /* non-critical */ }
  }

  return { reward };
}

async function pbActivateBooster(
  pbId: string,
  multiplier: number,
  boosterCost: number,
): Promise<{ success: boolean; multiplier: number; expiresAt: number }> {
  const user = await pb.collection('users').getOne(pbId);
  const currentPt = Number(user.power_tokens) || 0;
  if (currentPt < boosterCost) throw new Error(`Not enough Power Tokens. Need ${boosterCost} PT.`);

  const expiresAt = Date.now() + 3600000; // 1 hour
  await pb.collection('users').update(pbId, {
    power_tokens: currentPt - boosterCost,
    active_booster_multiplier: multiplier,
    booster_expires: String(expiresAt),
  });

  return { success: true, multiplier, expiresAt };
}

async function pbActivateAndMine(
  pbId: string,
  multiplier: number,
  miningRatePerSec: number,
  miningCost: number,
  boosterCost: number,
): Promise<{ id: string; startTimeMs: number; endTimeMs: number; durationMs: number; multiplier: number; boosterExpiresAt: number; expectedReward: number; newPowerTokens: number; serverTime: number; miningRatePerSec: number }> {
  const totalCost = miningCost + boosterCost;
  const user = await pb.collection('users').getOne(pbId);
  const currentPt = Number(user.power_tokens) || 0;
  if (currentPt < totalCost) throw new Error(`Not enough Power Tokens. Need ${totalCost} PT.`);

  const expiresAt = Date.now() + 3600000; // booster active 1 hour
  await pb.collection('users').update(pbId, {
    power_tokens: currentPt - totalCost,
    active_booster_multiplier: multiplier,
    booster_expires: String(expiresAt),
  });

  const now = new Date();
  const session = await pb.collection('mining_sessions').create({
    user: pbId,
    start_time: now.toISOString(),
    booster_multiplier: multiplier,
    claimed_amount: 0,
    is_verified: false,
  });
  await pb.collection('users').update(pbId, { current_mining_session: session.id });

  const startTimeMs = now.getTime();
  return {
    id: session.id,
    startTimeMs,
    endTimeMs: startTimeMs + PB_DURATION_MS,
    durationMs: PB_DURATION_MS,
    multiplier,
    boosterExpiresAt: expiresAt,
    expectedReward: miningRatePerSec * (PB_DURATION_MS / 1000) * multiplier,
    newPowerTokens: currentPt - totalCost,
    serverTime: Date.now(),
    miningRatePerSec,
  };
}

const SESSIONS_COUNT_KEY = 'shib_mine_sessions_v1';
const RATED_APP_KEY = 'shib_app_rated';
const RATE_DISMISSED_AT_KEY = 'shib_rate_dismissed_at_claims';

export type MiningStatus = 'idle' | 'mining' | 'ready_to_claim';

export interface MiningSession {
  pbSessionId?: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  multiplier: number;
  status: MiningStatus;
  expectedReward: number;
}

interface MiningContextValue {
  session: MiningSession | null;
  status: MiningStatus;
  timeRemaining: number;
  elapsedMs: number;
  progress: number;
  displayedShibBalance: number;
  isClaiming: boolean;
  startMining: () => Promise<{ success: boolean; error?: string }>;
  claimReward: () => Promise<number>;
  shibReward: number;
  miningRatePerSec: number;
  setMiningRatePerSec: (rate: number) => void;
  durationMinutes: number;
  setDurationMinutes: (m: number) => void;
  miningEntryCost: number;
  activeBooster: { multiplier: number; expiresAt: number } | null;
  activateBooster: (multiplier: number) => Promise<{ success: boolean; error?: string }>;
  startMiningWithBooster: (multiplier: number) => Promise<{ success: boolean; error?: string }>;
  showRateUs: boolean;
  dismissRateUs: () => void;
  markAppRated: () => Promise<void>;
}

const MiningContext = createContext<MiningContextValue | null>(null);

function safe(n: number | undefined | null, fallback = 0): number {
  return typeof n === 'number' && isFinite(n) ? n : fallback;
}

function parseBoosterTs(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return isFinite(n) ? n : 0;
}

function resolveStartMs(s?: number, e?: number, dur = 0): number {
  if (typeof s === 'number' && isFinite(s) && s > 0) return s;
  if (typeof e === 'number' && isFinite(e) && e > 0) return e - dur;
  return Date.now();
}

function resolveEndMs(e?: number, s?: number, dur = 0): number {
  if (typeof e === 'number' && isFinite(e) && e > 0) return e;
  if (typeof s === 'number' && isFinite(s) && s > 0) return s + dur;
  return Date.now() + dur;
}

export function MiningProvider({ children }: { children: ReactNode }) {
  const { user, pbUser, refreshBalance, optimisticUpdatePt } = useAuth();

  const [session, setSession] = useState<MiningSession | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [displayedShibBalance, setDisplayedShibBalance] = useState(0);
  const [isClaiming, setIsClaiming] = useState(false);

  const [miningRatePerSec, setMiningRatePerSec] = useState(0.01736);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [miningEntryCost, setMiningEntryCost] = useState(24);
  const [activeBooster, setActiveBooster] = useState<{ multiplier: number; expiresAt: number } | null>(null);
  const [showRateUs, setShowRateUs] = useState(false);
  const ratePopupFrequencyRef = useRef(5);
  const playStoreUrlRef = useRef('');

  const dismissRateUs = useCallback(async () => {
    setShowRateUs(false);
    // Store the claim count at which user dismissed so we skip until next interval
    try {
      const raw = await AsyncStorage.getItem(SESSIONS_COUNT_KEY);
      const count = parseInt(raw || '0', 10) || 0;
      await AsyncStorage.setItem(RATE_DISMISSED_AT_KEY, String(count));
    } catch { /* non-critical */ }
  }, []);

  const markAppRated = useCallback(async () => {
    try {
      await AsyncStorage.setItem(RATED_APP_KEY, 'true');
    } catch { /* non-critical */ }
    setShowRateUs(false);
  }, []);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shibIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const driftSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isClaimingRef = useRef(false);
  const sessionRef = useRef<MiningSession | null>(null);
  const miningRateRef = useRef(miningRatePerSec);
  const activeBoosterRef = useRef(activeBooster);
  const pbIdRef = useRef<string | null>(null);
  // clockDrift = serverTime - phoneTime. Non-zero when device clock is manipulated.
  const clockDriftRef = useRef(0);
  const cacheKeyRef = useRef<string | null>(null);

  const uid = user?.uid ?? null;
  const pbId = pbUser?.pbId ?? null;
  const cacheKey = uid ? `shib_mining_v2_${uid}` : null;

  // Sync all refs on every render — async functions always see current values
  pbIdRef.current = pbId;
  cacheKeyRef.current = cacheKey;
  miningRateRef.current = miningRatePerSec;
  activeBoosterRef.current = activeBooster;
  sessionRef.current = session;

  // ── Derive booster from refreshed pbUser ──────────────────────────────────
  useEffect(() => {
    if (!pbUser) return;
    const multiplier = safe(pbUser.activeBoosterMultiplier, 1);
    const expiresAt = parseBoosterTs(pbUser.boosterExpires);
    if (expiresAt > Date.now() && multiplier > 1) {
      const b = { multiplier, expiresAt };
      setActiveBooster(b);
      activeBoosterRef.current = b;
    } else {
      setActiveBooster(null);
      activeBoosterRef.current = null;
    }
  }, [pbUser]);

  // ── Load settings once ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      let s: any = null;
      try {
        s = await api.getSettings();
      } catch {
        // Express unreachable — fall back to PocketBase directly
        try {
          const res = await pb.collection('settings').getList(1, 1);
          const raw = res.items[0];
          if (raw) {
            // Map snake_case PB fields → camelCase AppSettings shape
            s = {
              miningRatePerSec:      raw.mining_rate_per_sec,
              miningDurationMinutes: raw.mining_duration_minutes,
              powerTokenPerClick:    raw.power_token_per_click,
              ratePopupFrequency:    raw.rate_popup_frequency,
              playStoreUrl:          raw.play_store_url ?? raw.app_store_link,
            };
          }
        } catch { /* keep defaults */ }
      }
      if (!s) return;
      if (s.miningRatePerSec)      setMiningRatePerSec(safe(s.miningRatePerSec, 0.01736));
      if (s.miningDurationMinutes) setDurationMinutes(safe(s.miningDurationMinutes, 60));
      if (s.powerTokenPerClick)    setMiningEntryCost(safe(s.powerTokenPerClick, 24));
      if (s.ratePopupFrequency)    ratePopupFrequencyRef.current = s.ratePopupFrequency;
      if (s.playStoreUrl)          playStoreUrlRef.current = s.playStoreUrl;
    })();
  }, []);

  // ── Restore session on sign-in (local cache first, then server) ──────────
  // Backend is ONLY contacted here on startup and during claim.
  // During active mining the UI runs entirely from local state + setInterval.
  useEffect(() => {
    if (uid) loadSession();
    return () => clearAllTimers();
  }, [uid, pbId]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Returns the current time adjusted by the measured server clock drift.
  // If the user has changed their device clock, Date.now() will be wrong —
  // serverNow() compensates so timers always track server time.
  function serverNow(): number {
    return Date.now() + clockDriftRef.current;
  }

  // Syncs clockDrift with the server. Can be seeded with a serverTime already
  // in a network response to avoid an extra round-trip.
  async function syncClockDrift(knownServerTime?: number): Promise<void> {
    try {
      const t0 = Date.now();
      let serverTime = knownServerTime;
      if (!serverTime) {
        const res = await api.getServerTime();
        serverTime = res?.serverTime;
      }
      if (serverTime && isFinite(serverTime)) {
        // If we made a round-trip, estimate RTT and mid-point correction
        const rtt = knownServerTime ? 0 : (Date.now() - t0);
        clockDriftRef.current = serverTime - Date.now() + Math.floor(rtt / 2);
      }
    } catch { /* non-critical — keep last known drift */ }
  }

  function clearAllTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (shibIntervalRef.current) { clearInterval(shibIntervalRef.current); shibIntervalRef.current = null; }
    if (driftSyncRef.current) { clearInterval(driftSyncRef.current); driftSyncRef.current = null; }
  }

  async function loadSession() {
    const currentPbId = pbIdRef.current;
    const currentCacheKey = cacheKeyRef.current;
    try {
      // Sync clock drift immediately on session load (non-blocking)
      syncClockDrift().catch(() => {});

      // Try local cache first for instant UI restore
      if (currentCacheKey) {
        const raw = await storage.getItem(currentCacheKey);
        if (raw) {
          try {
            const s: MiningSession = JSON.parse(raw);
            const endTimeMs = safe(s.endTimeMs, 0);
            const durationMs = safe(s.durationMs, 3600000);
            if (endTimeMs > 0) {
              const now = serverNow();
              const remaining = endTimeMs - now;
              if (s.status === 'mining' && remaining > 0) {
                // Timer is still running — restore UI immediately from cache
                setSession(s);
                sessionRef.current = s;
                setTimeRemaining(remaining);
                setElapsedMs(Math.max(0, now - safe(s.startTimeMs, endTimeMs - durationMs)));
                startTimers(s);
              } else if (s.status === 'mining' && remaining <= 0) {
                // Timer expired while app was closed — mark ready to claim
                const done: MiningSession = { ...s, status: 'ready_to_claim' };
                setSession(done);
                sessionRef.current = done;
                await storage.setItem(currentCacheKey, JSON.stringify(done));
              } else if (s.status === 'ready_to_claim') {
                setSession(s);
                sessionRef.current = s;
              }
              // Cache restored — verify with server in background only if online
              if (currentPbId) {
                verifyWithServer(currentPbId, currentCacheKey).catch(() => {});
              }
              return;
            }
          } catch { /* corrupt cache */ }
        }
      }

      // No local cache — fetch from server (Express then PB fallback)
      if (currentPbId) {
        await fetchFromServer(currentPbId, currentCacheKey);
      }
    } catch (e) {
      console.warn('[Mining] loadSession error', e);
    }
  }

  async function verifyWithServer(currentPbId: string, currentCacheKey: string | null) {
    try {
      const res = await api.getActiveMining(currentPbId);
      // Sync drift from background verification
      if (res?.session?.serverTime && isFinite(res.session.serverTime)) {
        clockDriftRef.current = res.session.serverTime - Date.now();
      }
      if (!res?.session) {
        // Server says no session — only clear if we're in ready_to_claim (server confirmed)
        const current = sessionRef.current;
        if (current?.status === 'ready_to_claim') return; // Keep local until user claims
        if (currentCacheKey) await storage.removeItem(currentCacheKey);
        setSession(null);
        sessionRef.current = null;
        clearAllTimers();
      }
      // If server has a session, we trust local cache for timer continuity
    } catch { /* ignore — stay with local state */ }
  }

  async function fetchFromServer(currentPbId: string, currentCacheKey: string | null) {
    // Try Express backend first, then fall back to PocketBase direct
    let res: any;
    try {
      res = await api.getActiveMining(currentPbId);
    } catch {
      res = await pbGetActiveMining(currentPbId);
    }
    if (res?.session) {
      const s = res.session;
      // Sync clock drift from server's response time — free, no extra round-trip
      if (s.serverTime && isFinite(s.serverTime)) {
        clockDriftRef.current = s.serverTime - Date.now();
      }
      const durationMs = safe(s.durationMs, 3600000);
      const endTimeMs = resolveEndMs(s.endTimeMs, s.startTimeMs, durationMs);
      const startTimeMs = resolveStartMs(s.startTimeMs, s.endTimeMs, durationMs);
      const now = serverNow();
      const remaining = endTimeMs - now;
      const status: MiningStatus = remaining <= 0 ? 'ready_to_claim' : 'mining';

      const local: MiningSession = {
        pbSessionId: s.id,
        startTimeMs,
        endTimeMs,
        durationMs,
        multiplier: safe(s.multiplier, 1),
        status,
        expectedReward: safe(miningRateRef.current * (durationMs / 1000), 0),
      };

      sessionRef.current = local;
      setSession(local);
      if (currentCacheKey) await storage.setItem(currentCacheKey, JSON.stringify(local));

      if (status === 'mining') {
        setTimeRemaining(Math.max(0, remaining));
        setElapsedMs(Math.max(0, now - startTimeMs));
        startTimers(local);
      } else {
        clearAllTimers();
        setTimeRemaining(0);
      }
    } else {
      if (currentCacheKey) await storage.removeItem(currentCacheKey);
      setSession(null);
      sessionRef.current = null;
    }
  }

  /**
   * Starts the local countdown and SHIB animation timers.
   * The entire mining UI runs from these — NO server calls during mining.
   * endTimeMs is captured in closure — safe across re-renders.
   */
  function startTimers(s: MiningSession) {
    clearAllTimers();

    const endTimeMs = safe(s.endTimeMs, serverNow() + s.durationMs);
    const startTimeMs = safe(s.startTimeMs, endTimeMs - s.durationMs);
    const durationMs = safe(s.durationMs, 3600000);

    // 1-second countdown — uses serverNow() so phone clock changes have no effect
    intervalRef.current = setInterval(() => {
      const now = serverNow();
      const remaining = Math.max(0, endTimeMs - now);
      const elapsed = Math.min(now - startTimeMs, durationMs);
      setTimeRemaining(remaining);
      setElapsedMs(elapsed);

      if (remaining === 0) {
        clearAllTimers();
        import('@/lib/notifications').then(({ notifyMiningComplete }) => {
          notifyMiningComplete().catch(() => {});
        });
        setSession((prev) => {
          if (!prev) return null;
          const done: MiningSession = { ...prev, status: 'ready_to_claim' };
          sessionRef.current = done;
          const key = cacheKeyRef.current;
          if (key) storage.setItem(key, JSON.stringify(done)).catch(() => {});
          return done;
        });
      }
    }, 1000);

    // 100ms SHIB animation — reads live refs so booster upgrades appear instantly
    shibIntervalRef.current = setInterval(() => {
      const now = serverNow();
      const elapsed = Math.min(Math.max(0, now - startTimeMs), durationMs);
      const booster = activeBoosterRef.current;
      const effectiveMultiplier =
        booster && booster.expiresAt > serverNow()
          ? safe(booster.multiplier, 1)
          : safe(s.multiplier, 1);
      const rate = safe(miningRateRef.current, 0.01736) * effectiveMultiplier;
      setDisplayedShibBalance(safe(rate * (elapsed / 1000), 0));
    }, 100);

    // Re-sync clock drift every 60 seconds during active mining.
    // This catches users who change device clock AFTER mining starts.
    driftSyncRef.current = setInterval(() => {
      syncClockDrift().catch(() => {});
    }, 60 * 1000);
  }

  // ── Public actions ─────────────────────────────────────────────────────────

  async function startMining(): Promise<{ success: boolean; error?: string }> {
    const currentPbId = pbIdRef.current;
    const currentCacheKey = cacheKeyRef.current;
    if (!currentPbId) return { success: false, error: 'Account not ready. Please wait.' };

    const booster = activeBoosterRef.current;
    const multiplier = booster && booster.expiresAt > serverNow() ? safe(booster.multiplier, 1) : 1;

    clearAllTimers();

    try {
      let res: any;
      try {
        res = await api.startMining({ pbId: currentPbId, multiplier });
      } catch {
        // Express unreachable — use PocketBase direct
        res = await pbStartMining(currentPbId, multiplier, miningRateRef.current, miningEntryCost);
      }

      // Sync clock drift immediately from the server response
      if (res?.serverTime && isFinite(res.serverTime)) {
        clockDriftRef.current = res.serverTime - Date.now();
      }

      if (res?.miningRatePerSec) setMiningRatePerSec(safe(res.miningRatePerSec, 0.01736));

      const durationMs = safe(res.durationMs, 3600000);
      const endTimeMs = resolveEndMs(res.endTimeMs, res.startTimeMs, durationMs);
      const startTimeMs = resolveStartMs(res.startTimeMs, res.endTimeMs, durationMs);

      const newSession: MiningSession = {
        pbSessionId: res.id,
        startTimeMs,
        endTimeMs,
        durationMs,
        multiplier,
        status: 'mining',
        expectedReward: safe(res.expectedReward, 0),
      };

      sessionRef.current = newSession;
      setSession(newSession);
      setTimeRemaining(Math.max(0, endTimeMs - serverNow()));
      setElapsedMs(0);
      setDisplayedShibBalance(0);
      startTimers(newSession);

      if (typeof res.newPowerTokens === 'number' && isFinite(res.newPowerTokens)) {
        optimisticUpdatePt(res.newPowerTokens);
      }

      if (currentCacheKey) storage.setItem(currentCacheKey, JSON.stringify(newSession)).catch(() => {});
      refreshBalance().catch(() => {});

      return { success: true };
    } catch (e: any) {
      if (sessionRef.current?.status === 'mining') startTimers(sessionRef.current);
      console.warn('[Mining] startMining failed', e);
      return { success: false, error: e?.message || 'Failed to start mining.' };
    }
  }

  async function claimReward(): Promise<number> {
    if (isClaimingRef.current) return 0;
    const s = sessionRef.current;
    const currentPbId = pbIdRef.current;
    const currentCacheKey = cacheKeyRef.current;
    if (!s || s.status !== 'ready_to_claim' || !s.pbSessionId || !currentPbId) return 0;

    isClaimingRef.current = true;
    setIsClaiming(true);

    // ─── DO NOT clear session state here ───────────────────────────────────
    // State is only cleared after the server confirms a successful claim.
    // Clearing before the API call means fraud / network errors leave the UI
    // in a blank idle state with no visible feedback to the user.
    // ────────────────────────────────────────────────────────────────────────

    try {
      let res: any;
      try {
        res = await api.claimMining({ sessionId: s.pbSessionId!, pbId: currentPbId });
      } catch (expressErr: any) {
        const errCode = expressErr?.data?.error || '';
        const isHardBlock = errCode === 'FRAUD_DETECTED' || errCode === 'ACCOUNT_BLOCKED' || errCode === 'SESSION_EXPIRED';
        if (isHardBlock) throw expressErr; // don't fall through on fraud
        // Express unreachable — use PocketBase direct
        res = await pbClaimMining(s.pbSessionId!, currentPbId, miningRateRef.current);
      }

      // ── Success: now safe to wipe local session state ──────────────────
      clearAllTimers();
      setTimeRemaining(0);
      setElapsedMs(0);
      setDisplayedShibBalance(0);
      setSession(null);
      sessionRef.current = null;
      if (currentCacheKey) await storage.removeItem(currentCacheKey);

      await refreshBalance();

      /* ── Rate Us: increment completed session count ── */
      try {
        const [rawCount, hasRated, rawDismissedAt] = await Promise.all([
          AsyncStorage.getItem(SESSIONS_COUNT_KEY),
          AsyncStorage.getItem(RATED_APP_KEY),
          AsyncStorage.getItem(RATE_DISMISSED_AT_KEY),
        ]);
        if (!hasRated) {
          const count = (parseInt(rawCount || '0', 10) || 0) + 1;
          await AsyncStorage.setItem(SESSIONS_COUNT_KEY, String(count));
          const freq = ratePopupFrequencyRef.current || 5;
          const dismissedAt = parseInt(rawDismissedAt || '0', 10) || 0;
          if (count % freq === 0 && count > dismissedAt) {
            setShowRateUs(true);
          }
        }
      } catch { /* non-critical */ }

      return safe(res?.reward, 0);
    } catch (e: any) {
      // e.data is populated by lib/api.ts request() — see err.data = data
      const errCode = e?.data?.error || '';

      // For any fraud or session-expiry error: clear local state so UI returns to "Start Mining"
      if (errCode === 'FRAUD_DETECTED' || errCode === 'ACCOUNT_BLOCKED' || errCode === 'SESSION_EXPIRED') {
        clearAllTimers();
        setTimeRemaining(0);
        setElapsedMs(0);
        setDisplayedShibBalance(0);
        setSession(null);
        sessionRef.current = null;
        try { if (currentCacheKey) await storage.removeItem(currentCacheKey); } catch { /* ignore */ }

        // Only re-throw fraud/blocked so handleClaim can show alert;
        // SESSION_EXPIRED returns 0 (user just needs to start fresh, no strike shown)
        if (errCode === 'FRAUD_DETECTED' || errCode === 'ACCOUNT_BLOCKED') throw e;
        console.warn('[Mining] Session expired/voided — reset to idle');
        return 0;
      }
      console.warn('[Mining] claimReward error:', e?.message);
      return 0;
    } finally {
      isClaimingRef.current = false;
      setIsClaiming(false);
    }
  }

  async function activateBooster(multiplier: number): Promise<{ success: boolean; error?: string }> {
    const currentPbId = pbIdRef.current;
    if (!currentPbId) return { success: false, error: 'Account not ready. Please wait.' };
    try {
      let res: any;
      try {
        res = await api.activateBooster({ pbId: currentPbId, multiplier });
      } catch {
        // Express unreachable — fetch booster cost from settings then use PB direct
        const settings = await api.getSettings().catch(() => null);
        const costMap: Record<number, number> = {
          2: safe(settings?.boostCosts?.['2x'], 48),
          4: safe(settings?.boostCosts?.['4x'], 96),
          6: safe(settings?.boostCosts?.['6x'], 144),
          10: safe(settings?.boostCosts?.['10x'], 240),
        };
        res = await pbActivateBooster(currentPbId, multiplier, costMap[multiplier] ?? 96);
      }
      if (res?.success) {
        const expiresAt = parseBoosterTs(res.expiresAt ?? res.boosterExpiresAt);
        const newBooster = { multiplier: safe(res.multiplier, multiplier), expiresAt };
        setActiveBooster(newBooster);
        activeBoosterRef.current = newBooster;
        refreshBalance().catch(() => {});
        return { success: true };
      }
      return { success: false, error: res?.error || 'Failed to activate booster' };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to activate booster' };
    }
  }

  // Atomic: activate booster + start mining in one server round-trip.
  // After API returns all state updates are SYNCHRONOUS — UI flips to mining in 0ms.
  async function startMiningWithBooster(multiplier: number): Promise<{ success: boolean; error?: string }> {
    const currentPbId = pbIdRef.current;
    const currentCacheKey = cacheKeyRef.current;
    if (!currentPbId) return { success: false, error: 'Account not ready. Please wait.' };

    clearAllTimers();

    try {
      let res: any;
      try {
        res = await api.activateAndMine({ pbId: currentPbId, multiplier });
      } catch {
        // Express unreachable — fetch costs from settings then use PB direct
        const settings = await api.getSettings().catch(() => null);
        const costMap: Record<number, number> = {
          2: safe(settings?.boostCosts?.['2x'], 48),
          4: safe(settings?.boostCosts?.['4x'], 96),
          6: safe(settings?.boostCosts?.['6x'], 144),
          10: safe(settings?.boostCosts?.['10x'], 240),
        };
        const boosterCost = costMap[multiplier] ?? 96;
        const miningCost = miningEntryCost;
        res = await pbActivateAndMine(
          currentPbId, multiplier, miningRateRef.current, miningCost, boosterCost,
        );
      }

      // Sync clock drift from server response
      if (res?.serverTime && isFinite(res.serverTime)) {
        clockDriftRef.current = res.serverTime - Date.now();
      }

      if (res?.miningRatePerSec) setMiningRatePerSec(safe(res.miningRatePerSec, 0.01736));

      const expiresAt = parseBoosterTs(res.boosterExpiresAt);
      const newBooster = { multiplier: safe(res.multiplier, multiplier), expiresAt };

      const durationMs = safe(res.durationMs, 3600000);
      const endTimeMs = resolveEndMs(res.endTimeMs, res.startTimeMs, durationMs);
      const startTimeMs = resolveStartMs(res.startTimeMs, res.endTimeMs, durationMs);

      const newSession: MiningSession = {
        pbSessionId: res.id,
        startTimeMs,
        endTimeMs,
        durationMs,
        multiplier,
        status: 'mining',
        expectedReward: safe(res.expectedReward, 0),
      };

      // Update refs BEFORE state so timers read correct values immediately
      activeBoosterRef.current = newBooster;
      sessionRef.current = newSession;

      // All state updates synchronous — React batches these together
      setActiveBooster(newBooster);
      setSession(newSession);
      setTimeRemaining(Math.max(0, endTimeMs - serverNow()));
      setElapsedMs(0);
      setDisplayedShibBalance(0);

      // Start local timers — no more server calls until claim
      startTimers(newSession);

      if (typeof res.newPowerTokens === 'number' && isFinite(res.newPowerTokens)) {
        optimisticUpdatePt(res.newPowerTokens);
      }

      if (currentCacheKey) storage.setItem(currentCacheKey, JSON.stringify(newSession)).catch(() => {});
      refreshBalance().catch(() => {});

      return { success: true };
    } catch (e: any) {
      if (sessionRef.current?.status === 'mining') startTimers(sessionRef.current);
      console.warn('[Mining] startMiningWithBooster failed', e);
      return { success: false, error: e?.message || 'Failed to start mining with booster.' };
    }
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const status: MiningStatus = session?.status ?? 'idle';

  const progress =
    session?.status === 'mining'
      ? Math.min(1, safe(elapsedMs) / safe(session.durationMs, 1))
      : session?.status === 'ready_to_claim' ? 1 : 0;

  const shibReward = session
    ? safe(miningRatePerSec) * safe(session.multiplier, 1) * (safe(session.durationMs) / 1000)
    : safe(miningRatePerSec) * durationMinutes * 60;

  const value = useMemo<MiningContextValue>(() => ({
    session, status, timeRemaining, elapsedMs, progress,
    displayedShibBalance, isClaiming,
    startMining, claimReward, shibReward,
    miningRatePerSec, setMiningRatePerSec,
    durationMinutes, setDurationMinutes,
    miningEntryCost,
    activeBooster, activateBooster, startMiningWithBooster,
    showRateUs, dismissRateUs, markAppRated,
  }), [
    session, status, timeRemaining, elapsedMs, progress,
    displayedShibBalance, isClaiming, shibReward,
    miningRatePerSec, durationMinutes, miningEntryCost, activeBooster,
    showRateUs, dismissRateUs, markAppRated,
  ]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}

export function useMining() {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining must be used within MiningProvider');
  return ctx;
}
