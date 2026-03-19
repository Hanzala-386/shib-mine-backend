import React, {
  createContext, useContext, useState, useEffect,
  useRef, useMemo, ReactNode, useCallback,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import storage from '@/lib/storage';
import { useAuth } from './AuthContext';
import { api } from '@/lib/api';

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
  const isClaimingRef = useRef(false);
  const sessionRef = useRef<MiningSession | null>(null);
  const miningRateRef = useRef(miningRatePerSec);
  const activeBoosterRef = useRef(activeBooster);
  const pbIdRef = useRef<string | null>(null);
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
    api.getSettings().then((s) => {
      if (s?.miningRatePerSec) setMiningRatePerSec(safe(s.miningRatePerSec, 0.01736));
      if (s?.miningDurationMinutes) setDurationMinutes(safe(s.miningDurationMinutes, 60));
      if (s?.powerTokenPerClick) setMiningEntryCost(safe(s.powerTokenPerClick, 24));
      if (s?.ratePopupFrequency) ratePopupFrequencyRef.current = s.ratePopupFrequency;
      if (s?.playStoreUrl) playStoreUrlRef.current = s.playStoreUrl;
    }).catch(() => {});
  }, []);

  // ── Restore session on sign-in (local cache first, then server) ──────────
  // Backend is ONLY contacted here on startup and during claim.
  // During active mining the UI runs entirely from local state + setInterval.
  useEffect(() => {
    if (uid) loadSession();
    return () => clearAllTimers();
  }, [uid, pbId]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function clearAllTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (shibIntervalRef.current) { clearInterval(shibIntervalRef.current); shibIntervalRef.current = null; }
  }

  async function loadSession() {
    const currentPbId = pbIdRef.current;
    const currentCacheKey = cacheKeyRef.current;
    try {
      // Try local cache first for instant UI restore
      if (currentCacheKey) {
        const raw = await storage.getItem(currentCacheKey);
        if (raw) {
          try {
            const s: MiningSession = JSON.parse(raw);
            const endTimeMs = safe(s.endTimeMs, 0);
            const durationMs = safe(s.durationMs, 3600000);
            if (endTimeMs > 0) {
              const remaining = endTimeMs - Date.now();
              if (s.status === 'mining' && remaining > 0) {
                // Timer is still running — restore UI immediately from cache
                setSession(s);
                sessionRef.current = s;
                setTimeRemaining(remaining);
                setElapsedMs(Math.max(0, Date.now() - safe(s.startTimeMs, endTimeMs - durationMs)));
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

      // No local cache — fetch from server
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
    const res = await api.getActiveMining(currentPbId);
    if (res?.session) {
      const s = res.session;
      const durationMs = safe(s.durationMs, 3600000);
      const endTimeMs = resolveEndMs(s.endTimeMs, s.startTimeMs, durationMs);
      const startTimeMs = resolveStartMs(s.startTimeMs, s.endTimeMs, durationMs);
      const remaining = endTimeMs - Date.now();
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
        setElapsedMs(Math.max(0, Date.now() - startTimeMs));
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

    const endTimeMs = safe(s.endTimeMs, Date.now() + s.durationMs);
    const startTimeMs = safe(s.startTimeMs, endTimeMs - s.durationMs);
    const durationMs = safe(s.durationMs, 3600000);

    // 1-second countdown — derived from endTimeMs (wall-clock accurate)
    intervalRef.current = setInterval(() => {
      const remaining = Math.max(0, endTimeMs - Date.now());
      const elapsed = Math.min(Date.now() - startTimeMs, durationMs);
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
      const elapsed = Math.min(Math.max(0, Date.now() - startTimeMs), durationMs);
      const booster = activeBoosterRef.current;
      const effectiveMultiplier =
        booster && booster.expiresAt > Date.now()
          ? safe(booster.multiplier, 1)
          : safe(s.multiplier, 1);
      const rate = safe(miningRateRef.current, 0.01736) * effectiveMultiplier;
      setDisplayedShibBalance(safe(rate * (elapsed / 1000), 0));
    }, 100);
  }

  // ── Public actions ─────────────────────────────────────────────────────────

  async function startMining(): Promise<{ success: boolean; error?: string }> {
    const currentPbId = pbIdRef.current;
    const currentCacheKey = cacheKeyRef.current;
    if (!currentPbId) return { success: false, error: 'Account not ready. Please wait.' };

    const booster = activeBoosterRef.current;
    const multiplier = booster && booster.expiresAt > Date.now() ? safe(booster.multiplier, 1) : 1;

    clearAllTimers();

    try {
      const res = await api.startMining({ pbId: currentPbId, multiplier });

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
      setTimeRemaining(Math.max(0, endTimeMs - Date.now()));
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

    clearAllTimers();
    setTimeRemaining(0);
    setElapsedMs(0);
    setDisplayedShibBalance(0);
    setSession(null);
    sessionRef.current = null;
    if (currentCacheKey) await storage.removeItem(currentCacheKey);

    try {
      const res = await api.claimMining({ sessionId: s.pbSessionId, pbId: currentPbId });
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
          // Show only if: count hits a multiple of freq AND user hasn't dismissed at this count
          if (count % freq === 0 && count > dismissedAt) {
            setShowRateUs(true);
          }
        }
      } catch { /* non-critical */ }

      return safe(res?.reward, 0);
    } catch (e: any) {
      const errCode = e?.data?.error || e?.message || '';
      // Re-throw fraud/blocked errors so the UI can show proper alerts
      if (errCode === 'FRAUD_DETECTED' || errCode === 'ACCOUNT_BLOCKED') throw e;
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
      const res = await api.activateBooster({ pbId: currentPbId, multiplier });
      if (res?.success) {
        const expiresAt = parseBoosterTs(res.expiresAt);
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
      const res = await api.activateAndMine({ pbId: currentPbId, multiplier });

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
      setTimeRemaining(Math.max(0, endTimeMs - Date.now()));
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
