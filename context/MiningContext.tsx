import React, {
  createContext, useContext, useState, useEffect,
  useRef, useMemo, ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { api } from '@/lib/api';

export type MiningStatus = 'idle' | 'mining' | 'ready_to_claim';

export interface MiningSession {
  pbSessionId?: string;
  startTimeMs: number;   // Unix ms — drives shib animation
  endTimeMs: number;     // Unix ms — drives countdown: remaining = endTimeMs - Date.now()
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
}

const MiningContext = createContext<MiningContextValue | null>(null);

// ── Math helpers ─────────────────────────────────────────────────────────────

/** Returns `fallback` for anything that is NaN / Infinity / null / undefined */
function safe(n: number | undefined | null, fallback = 0): number {
  return typeof n === 'number' && isFinite(n) ? n : fallback;
}

/** Parse PocketBase booster_expires — stored as epoch-ms string e.g. "1710000000000" */
function parseBoosterTs(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return isFinite(n) ? n : 0;
}

/**
 * Derive a reliable startTimeMs from a server response.
 * Priority: explicit startTimeMs number → compute from endTimeMs − durationMs → Date.now() fallback
 */
function resolveStartMs(
  startTimeMs: number | undefined,
  endTimeMs: number | undefined,
  durationMs: number,
): number {
  if (typeof startTimeMs === 'number' && isFinite(startTimeMs) && startTimeMs > 0) return startTimeMs;
  if (typeof endTimeMs === 'number' && isFinite(endTimeMs) && endTimeMs > 0) return endTimeMs - durationMs;
  return Date.now();
}

/**
 * Derive a reliable endTimeMs from a server response.
 * Priority: explicit endTimeMs number → startTimeMs + durationMs → Date.now() + durationMs
 */
function resolveEndMs(
  endTimeMs: number | undefined,
  startTimeMs: number | undefined,
  durationMs: number,
): number {
  if (typeof endTimeMs === 'number' && isFinite(endTimeMs) && endTimeMs > 0) return endTimeMs;
  if (typeof startTimeMs === 'number' && isFinite(startTimeMs) && startTimeMs > 0) return startTimeMs + durationMs;
  return Date.now() + durationMs;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function MiningProvider({ children }: { children: ReactNode }) {
  const { user, pbUser, refreshBalance } = useAuth();

  const [session, setSession] = useState<MiningSession | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [displayedShibBalance, setDisplayedShibBalance] = useState(0);
  const [isClaiming, setIsClaiming] = useState(false);

  const [miningRatePerSec, setMiningRatePerSec] = useState(0.01736);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [miningEntryCost, setMiningEntryCost] = useState(24);
  const [activeBooster, setActiveBooster] = useState<{ multiplier: number; expiresAt: number } | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shibIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isClaimingRef = useRef(false);
  const sessionRef = useRef<MiningSession | null>(null);

  // Live refs — intervals always read the freshest value without stale closures
  const miningRateRef = useRef(miningRatePerSec);
  const activeBoosterRef = useRef(activeBooster);

  const uid = user?.uid ?? null;
  const pbId = pbUser?.pbId ?? null;
  const cacheKey = uid ? `shib_mining_v2_${uid}` : null; // v2 = endTimeMs-based schema

  useEffect(() => { miningRateRef.current = miningRatePerSec; }, [miningRatePerSec]);
  useEffect(() => { activeBoosterRef.current = activeBooster; }, [activeBooster]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // ── Reactive booster: re-derive from pbUser on every refreshBalance() call ──
  useEffect(() => {
    if (!pbUser) return;
    const multiplier = safe(pbUser.activeBoosterMultiplier, 1);
    const expiresAt = parseBoosterTs(pbUser.boosterExpires);
    if (expiresAt > Date.now() && multiplier > 1) {
      const booster = { multiplier, expiresAt };
      setActiveBooster(booster);
      activeBoosterRef.current = booster;
    } else {
      setActiveBooster(null);
      activeBoosterRef.current = null;
    }
  }, [pbUser]);

  // ── Load settings once ─────────────────────────────────────────────────────
  useEffect(() => {
    api.getSettings().then((s) => {
      if (s?.miningRatePerSec) setMiningRatePerSec(safe(s.miningRatePerSec, 0.01736));
      if (s?.miningDurationMinutes) setDurationMinutes(safe(s.miningDurationMinutes, 60));
      if (s?.powerTokenPerClick) setMiningEntryCost(safe(s.powerTokenPerClick, 24));
    }).catch(() => {});
  }, []);

  // ── Load session on sign-in ───────────────────────────────────────────────
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
    try {
      if (pbId) {
        const res = await api.getActiveMining(pbId);
        if (res?.session) {
          const s = res.session;
          const durationMs = safe(s.durationMs, 3600000);

          // Use explicit Unix-ms fields from server — no string parsing
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
            expectedReward: safe(miningRatePerSec * (durationMs / 1000), 0),
          };

          setSession(local);
          if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(local));

          if (status === 'mining') {
            setTimeRemaining(Math.max(0, remaining));
            setElapsedMs(Math.max(0, Date.now() - startTimeMs));
            startTimers(local);
          } else {
            // Already done — make sure timers are cleared and state is consistent
            clearAllTimers();
            setTimeRemaining(0);
          }
        } else {
          // Server says no active session — clear everything
          if (cacheKey) await AsyncStorage.removeItem(cacheKey);
          setSession(null);
        }
        return;
      }

      // No pbId yet — try local cache (only for 'mining', never for 'ready_to_claim')
      if (cacheKey) {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (raw) {
          try {
            const s: MiningSession = JSON.parse(raw);
            const endTimeMs = safe(s.endTimeMs, 0);
            const durationMs = safe(s.durationMs, 3600000);
            if (s.status === 'mining' && endTimeMs > 0) {
              const remaining = endTimeMs - Date.now();
              if (remaining > 0) {
                setSession(s);
                setTimeRemaining(remaining);
                setElapsedMs(Date.now() - safe(s.startTimeMs, endTimeMs - durationMs));
                startTimers(s);
              } else {
                // Expired locally — wait for server confirmation on next load
                const done: MiningSession = { ...s, status: 'ready_to_claim' };
                setSession(done);
                await AsyncStorage.setItem(cacheKey, JSON.stringify(done));
              }
            }
          } catch { /* corrupt cache — ignore */ }
        }
      }
    } catch (e) {
      console.warn('[Mining] loadSession error', e);
    }
  }

  /**
   * Start countdown and SHIB animation timers.
   * Both intervals derive time from endTimeMs — survives any re-render or re-attach.
   */
  function startTimers(s: MiningSession) {
    clearAllTimers();

    const endTimeMs = safe(s.endTimeMs, Date.now() + s.durationMs);
    const startTimeMs = safe(s.startTimeMs, endTimeMs - s.durationMs);
    const durationMs = safe(s.durationMs, 3600000);

    // ── 1-second countdown ─────────────────────────────────────────────────
    intervalRef.current = setInterval(() => {
      // Always compute from endTimeMs — consistent across logout/login/device switches
      const remaining = Math.max(0, endTimeMs - Date.now());
      const elapsed = Math.min(Date.now() - startTimeMs, durationMs);
      setTimeRemaining(remaining);
      setElapsedMs(elapsed);

      if (remaining === 0) {
        clearAllTimers();
        setSession((prev) => {
          if (!prev) return null;
          const done: MiningSession = { ...prev, status: 'ready_to_claim' };
          if (cacheKey) AsyncStorage.setItem(cacheKey, JSON.stringify(done));
          return done;
        });
      }
    }, 1000);

    // ── 100ms SHIB balance animation ───────────────────────────────────────
    // Reads live refs so that booster changes appear instantly without timer restart
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
    if (!pbId) return { success: false, error: 'Account not ready. Please wait.' };

    const booster = activeBoosterRef.current;
    const multiplier = booster && booster.expiresAt > Date.now() ? safe(booster.multiplier, 1) : 1;

    try {
      const res = await api.startMining({ pbId, multiplier });
      if (res?.miningRatePerSec) setMiningRatePerSec(safe(res.miningRatePerSec, 0.01736));
      await refreshBalance();

      const durationMs = safe(res.durationMs, 3600000);
      // Use server-provided explicit timestamps — no string parsing
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

      setSession(newSession);
      setTimeRemaining(Math.max(0, endTimeMs - Date.now()));
      setElapsedMs(0);
      setDisplayedShibBalance(0);
      if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(newSession));
      startTimers(newSession);
      return { success: true };
    } catch (e: any) {
      console.warn('[Mining] startMining failed', e);
      return { success: false, error: e?.message || 'Failed to start mining.' };
    }
  }

  async function claimReward(): Promise<number> {
    if (isClaimingRef.current) return 0;
    const s = sessionRef.current;
    if (!s || s.status !== 'ready_to_claim' || !s.pbSessionId || !pbId) return 0;

    isClaimingRef.current = true;
    setIsClaiming(true);

    // Optimistically wipe everything immediately — no phantom Claim button
    clearAllTimers();
    setTimeRemaining(0);
    setElapsedMs(0);
    setDisplayedShibBalance(0);
    setSession(null);
    if (cacheKey) await AsyncStorage.removeItem(cacheKey);

    try {
      const res = await api.claimMining({ sessionId: s.pbSessionId, pbId });
      await refreshBalance();
      return safe(res?.reward, 0);
    } catch (e: any) {
      console.warn('[Mining] claimReward error:', e?.message);
      return 0;
    } finally {
      isClaimingRef.current = false;
      setIsClaiming(false);
    }
  }

  async function activateBooster(multiplier: number): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Account not ready. Please wait.' };
    try {
      const res = await api.activateBooster({ pbId, multiplier });
      if (res?.success) {
        const expiresAt = parseBoosterTs(res.expiresAt);
        const newBooster = { multiplier: safe(res.multiplier, multiplier), expiresAt };
        // Update state AND ref simultaneously — shibInterval picks it up on next 100ms tick
        setActiveBooster(newBooster);
        activeBoosterRef.current = newBooster;
        await refreshBalance();
        return { success: true };
      }
      return { success: false, error: res?.error || 'Failed to activate booster' };
    } catch (e: any) {
      console.warn('[Mining] activateBooster failed', e);
      return { success: false, error: e?.message || 'Failed to activate booster' };
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
    activeBooster, activateBooster,
  }), [
    session, status, timeRemaining, elapsedMs, progress,
    displayedShibBalance, isClaiming, shibReward,
    miningRatePerSec, durationMinutes, miningEntryCost, activeBooster,
  ]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}

export function useMining() {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining must be used within MiningProvider');
  return ctx;
}
