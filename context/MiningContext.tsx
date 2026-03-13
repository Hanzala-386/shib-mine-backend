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
  startTime: number;
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

/** Return 0 (or `fallback`) for anything that is NaN / Infinity / null / undefined */
function safe(n: number | undefined | null, fallback = 0): number {
  return typeof n === 'number' && isFinite(n) ? n : fallback;
}

/** Parse PocketBase booster_expires — stored as epoch-ms string, e.g. "1710000000000" */
function parseBoosterTs(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return isFinite(n) ? n : 0;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function MiningProvider({ children }: { children: ReactNode }) {
  const { user, pbUser, refreshBalance } = useAuth();

  // Session / timer state
  const [session, setSession] = useState<MiningSession | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [displayedShibBalance, setDisplayedShibBalance] = useState(0);
  const [isClaiming, setIsClaiming] = useState(false);

  // Settings state (loaded once from server)
  const [miningRatePerSec, setMiningRatePerSec] = useState(0.01736);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [miningEntryCost, setMiningEntryCost] = useState(24);

  // Booster state — derived reactively from pbUser (updated after every refreshBalance call)
  const [activeBooster, setActiveBooster] = useState<{ multiplier: number; expiresAt: number } | null>(null);

  // Interval refs
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shibIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Claim mutex (ref survives re-renders without stale closure problems)
  const isClaimingRef = useRef(false);
  const sessionRef = useRef<MiningSession | null>(null);

  // Live refs — intervals always read fresh values without stale closures
  const miningRateRef = useRef(miningRatePerSec);
  const activeBoosterRef = useRef(activeBooster);

  const uid = user?.uid ?? null;
  const pbId = pbUser?.pbId ?? null;
  const cacheKey = uid ? `shib_mining_${uid}` : null;

  // ── Keep refs in sync ───────────────────────────────────────────────────────
  useEffect(() => { miningRateRef.current = miningRatePerSec; }, [miningRatePerSec]);
  useEffect(() => { activeBoosterRef.current = activeBooster; }, [activeBooster]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // ── REACTIVE: derive booster state from pbUser whenever it updates ──────────
  // This is the key to instant UI refresh after booster purchase — no logout needed.
  // refreshBalance() updates pbUser → this effect fires → UI ticks update immediately.
  useEffect(() => {
    if (!pbUser) return;
    const multiplier = safe(pbUser.activeBoosterMultiplier, 1);
    const expiresAt = parseBoosterTs(pbUser.boosterExpires);
    if (expiresAt > Date.now() && multiplier > 1) {
      const booster = { multiplier, expiresAt };
      setActiveBooster(booster);
      activeBoosterRef.current = booster;    // update ref immediately for running intervals
    } else {
      setActiveBooster(null);
      activeBoosterRef.current = null;
    }
  }, [pbUser]);

  // ── Load settings once ──────────────────────────────────────────────────────
  useEffect(() => {
    api.getSettings().then((s) => {
      if (s?.miningRatePerSec) setMiningRatePerSec(safe(s.miningRatePerSec, 0.01736));
      if (s?.miningDurationMinutes) setDurationMinutes(safe(s.miningDurationMinutes, 60));
      if (s?.powerTokenPerClick) setMiningEntryCost(safe(s.powerTokenPerClick, 24));
    }).catch(() => {});
  }, []);

  // ── Load session when user signs in ────────────────────────────────────────
  useEffect(() => {
    if (uid) loadSession();
    return () => clearAllTimers();
  }, [uid, pbId]);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function clearAllTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (shibIntervalRef.current) { clearInterval(shibIntervalRef.current); shibIntervalRef.current = null; }
  }

  function toMs(raw: string | undefined): number {
    if (!raw) return Date.now();
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
    return safe(new Date(iso).getTime(), Date.now());
  }

  async function loadSession() {
    try {
      if (pbId) {
        const res = await api.getActiveMining(pbId);
        if (res?.session) {
          const s = res.session;
          const startTime = toMs(s.startTime);
          const durationMs = safe(s.durationMs, 3600000);
          const elapsed = Date.now() - startTime;
          const status: MiningStatus = elapsed >= durationMs ? 'ready_to_claim' : 'mining';
          const local: MiningSession = {
            pbSessionId: s.id,
            startTime,
            durationMs,
            multiplier: safe(s.multiplier, 1),
            status,
            expectedReward: safe(miningRatePerSec * (durationMs / 1000), 0),
          };
          setSession(local);
          if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(local));
          if (status === 'mining') {
            setTimeRemaining(Math.max(0, durationMs - elapsed));
            setElapsedMs(elapsed);
            startTimers(local);
          }
        } else {
          if (cacheKey) await AsyncStorage.removeItem(cacheKey);
          setSession(null);
        }
        return;
      }

      // No pbId yet — local cache only for 'mining' state
      if (cacheKey) {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (raw) {
          const s: MiningSession = JSON.parse(raw);
          const startTime = safe(s.startTime, Date.now());
          const durationMs = safe(s.durationMs, 3600000);
          const elapsed = Date.now() - startTime;
          if (s.status === 'mining') {
            if (elapsed < durationMs) {
              setSession(s);
              setTimeRemaining(durationMs - elapsed);
              setElapsedMs(elapsed);
              startTimers(s);
            } else {
              const completed: MiningSession = { ...s, status: 'ready_to_claim' };
              setSession(completed);
              await AsyncStorage.setItem(cacheKey, JSON.stringify(completed));
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Mining] loadSession error', e);
    }
  }

  function startTimers(s: MiningSession) {
    clearAllTimers();

    const startTime = safe(s.startTime, Date.now());
    const durationMs = safe(s.durationMs, 3600000);

    // ── Countdown timer (1 s tick) ────────────────────────────────────────────
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, durationMs - elapsed);
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

    // ── Live SHIB balance animation (100 ms tick) ─────────────────────────────
    // Reads activeBoosterRef and miningRateRef on every tick — no stale closure.
    shibIntervalRef.current = setInterval(() => {
      const elapsed = Math.min(Date.now() - startTime, durationMs);

      // Use live booster multiplier if still valid; otherwise fall back to session multiplier
      const booster = activeBoosterRef.current;
      const effectiveMultiplier =
        booster && booster.expiresAt > Date.now()
          ? safe(booster.multiplier, 1)
          : safe(s.multiplier, 1);

      const rate = safe(miningRateRef.current, 0.01736) * effectiveMultiplier;
      const accumulated = rate * (safe(elapsed, 0) / 1000);
      setDisplayedShibBalance(safe(accumulated, 0));
    }, 100);
  }

  // ── Public actions ────────────────────────────────────────────────────────

  async function startMining(): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Account not ready. Please wait.' };

    const booster = activeBoosterRef.current;
    const multiplier =
      booster && booster.expiresAt > Date.now() ? safe(booster.multiplier, 1) : 1;

    try {
      const res = await api.startMining({ pbId, multiplier });
      if (res?.miningRatePerSec) setMiningRatePerSec(safe(res.miningRatePerSec, 0.01736));
      await refreshBalance();

      const startTime = toMs(res.startTime);
      const newSession: MiningSession = {
        pbSessionId: res.id,
        startTime,
        durationMs: safe(res.durationMs, 3600000),
        multiplier,
        status: 'mining',
        expectedReward: safe(res.expectedReward, 0),
      };

      setSession(newSession);
      setTimeRemaining(safe(res.durationMs, 3600000));
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

    // Optimistically clear everything immediately — no phantom Claim button
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
        // refreshBalance updates pbUser → the useEffect([pbUser]) fires → activeBooster updates
        // The ref is also updated immediately so the shibInterval picks it up on the next 100ms tick
        const expiresAt = parseBoosterTs(res.expiresAt);
        const newBooster = { multiplier: safe(res.multiplier, multiplier), expiresAt };
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

  // ── Derived values ────────────────────────────────────────────────────────

  const status: MiningStatus = session?.status ?? 'idle';

  const progress =
    session?.status === 'mining'
      ? Math.min(1, safe(elapsedMs) / safe(session.durationMs, 1))
      : session?.status === 'ready_to_claim'
        ? 1
        : 0;

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
