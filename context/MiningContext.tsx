import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
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

/** Parse a PocketBase booster_expires field — stored as epoch-ms string, e.g. "1710000000000" */
function parseBoosterExpires(raw: string | number | null | undefined): number {
  if (!raw) return 0;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return isFinite(n) ? n : 0;
}

/** Guard a number against NaN / Infinity, returning 0 as fallback */
function safe(n: number | undefined | null, fallback = 0): number {
  return isFinite(n as number) ? (n as number) : fallback;
}

export function MiningProvider({ children }: { children: ReactNode }) {
  const { user, pbUser, refreshBalance } = useAuth();
  const [session, setSession] = useState<MiningSession | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [miningRatePerSec, setMiningRatePerSec] = useState(0.01736);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [displayedShibBalance, setDisplayedShibBalance] = useState(0);
  const [miningEntryCost, setMiningEntryCost] = useState(24);
  const [activeBooster, setActiveBooster] = useState<{ multiplier: number; expiresAt: number } | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shibIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<MiningSession | null>(null);
  // Hard mutex: survives re-renders; prevents any concurrent claim attempt
  const isClaimingRef = useRef(false);
  const [isClaiming, setIsClaiming] = useState(false);

  // Live refs so intervals always read the latest values without stale closures
  const miningRateRef = useRef(miningRatePerSec);
  const activeBoosterRef = useRef(activeBooster);

  useEffect(() => { miningRateRef.current = miningRatePerSec; }, [miningRatePerSec]);
  useEffect(() => { activeBoosterRef.current = activeBooster; }, [activeBooster]);

  const uid = user?.uid;
  const pbId = pbUser?.pbId;
  const cacheKey = uid ? `shib_mining_${uid}` : null;

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Sync mining rate and entry cost from server settings
  useEffect(() => {
    api.getSettings().then((s) => {
      if (s.miningRatePerSec) setMiningRatePerSec(s.miningRatePerSec);
      if (s.miningDurationMinutes) setDurationMinutes(s.miningDurationMinutes);
      if (s.powerTokenPerClick) setMiningEntryCost(s.powerTokenPerClick);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (uid) {
      loadSession();
      loadActiveBooster();
    }
    return () => {
      clearAllTimers();
    };
  }, [uid, pbId]);

  async function loadActiveBooster() {
    if (!pbId) return;
    try {
      const res = await api.getActiveBooster(pbId);
      const expiresAt = parseBoosterExpires(res.expiresAt);
      if (expiresAt > Date.now()) {
        setActiveBooster({
          multiplier: safe(res.multiplier, 1),
          expiresAt,
        });
      } else {
        setActiveBooster(null);
      }
    } catch (e) {
      console.warn('[Mining] loadActiveBooster error', e);
    }
  }

  function clearAllTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (shibIntervalRef.current) { clearInterval(shibIntervalRef.current); shibIntervalRef.current = null; }
  }

  async function loadSession() {
    try {
      // Server is the single source of truth when pbId is available
      if (pbId) {
        const res = await api.getActiveMining(pbId);
        if (res.session) {
          const s = res.session;
          const rawStart = s.startTime?.includes?.('T') ? s.startTime : (s.startTime || '').replace(' ', 'T') + 'Z';
          const startTime = safe(new Date(rawStart).getTime(), Date.now());
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
          // Server says no active unclaimed session — clear stale local cache
          if (cacheKey) await AsyncStorage.removeItem(cacheKey);
          setSession(null);
        }
        return;
      }

      // No pbId yet — fall back to local cache only for 'mining' state
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
              const completed = { ...s, status: 'ready_to_claim' as MiningStatus };
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

    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, durationMs - elapsed);
      setTimeRemaining(remaining);
      setElapsedMs(elapsed);

      if (remaining === 0) {
        clearAllTimers();
        setSession((prev) => {
          if (!prev) return null;
          const done = { ...prev, status: 'ready_to_claim' as MiningStatus };
          if (cacheKey) AsyncStorage.setItem(cacheKey, JSON.stringify(done));
          return done;
        });
      }
    }, 1000);

    shibIntervalRef.current = setInterval(() => {
      const elapsed = Math.min(Date.now() - startTime, durationMs);
      // Always read the live booster from ref — not from closure
      const booster = activeBoosterRef.current;
      const effectiveMultiplier = (booster && booster.expiresAt > Date.now())
        ? safe(booster.multiplier, 1)
        : safe(s.multiplier, 1);
      const rate = safe(miningRateRef.current, 0.01736) * effectiveMultiplier;
      const accumulated = rate * (safe(elapsed, 0) / 1000);
      setDisplayedShibBalance(safe(accumulated, 0));
    }, 100);
  }

  async function startMining(): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Account not ready. Please wait.' };

    const multiplier = activeBooster && activeBooster.expiresAt > Date.now()
      ? safe(activeBooster.multiplier, 1)
      : 1;

    try {
      const res = await api.startMining({ pbId, multiplier });

      // Sync server-provided rate and refresh balance (PT was deducted server-side)
      if (res.miningRatePerSec) setMiningRatePerSec(safe(res.miningRatePerSec, 0.01736));
      await refreshBalance();

      const rawStart = res.startTime?.includes?.('T') ? res.startTime : res.startTime.replace(' ', 'T') + 'Z';
      const startTime = safe(new Date(rawStart).getTime(), Date.now());

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
      return { success: false, error: e.message || 'Failed to start mining.' };
    }
  }

  async function claimReward(): Promise<number> {
    // Hard mutex: ref check is synchronous — survives rapid re-renders
    if (isClaimingRef.current) return 0;
    const s = sessionRef.current;
    if (!s || s.status !== 'ready_to_claim' || !s.pbSessionId || !pbId) return 0;

    isClaimingRef.current = true;
    setIsClaiming(true);

    // Optimistically transition UI to idle immediately — prevents phantom Claim button
    clearAllTimers();
    setTimeRemaining(0);
    setElapsedMs(0);
    setDisplayedShibBalance(0);
    setSession(null);
    if (cacheKey) await AsyncStorage.removeItem(cacheKey);

    try {
      const res = await api.claimMining({ sessionId: s.pbSessionId, pbId });
      await refreshBalance();
      return safe(res.reward, 0);
    } catch (e: any) {
      console.warn('[Mining] claimReward server error:', e.message);
      // Session stays idle — don't revert the UI
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
      if (res.success) {
        const expiresAt = parseBoosterExpires(res.expiresAt);
        const newBooster = { multiplier: safe(res.multiplier, multiplier), expiresAt };
        // Update state AND ref immediately — shibIntervalRef reads the ref, so it picks
        // up the new multiplier on the very next 100 ms tick without needing a timer restart.
        setActiveBooster(newBooster);
        activeBoosterRef.current = newBooster;
        await refreshBalance();
        return { success: true };
      }
      return { success: false, error: res.error || 'Failed to activate booster' };
    } catch (e: any) {
      console.warn('[Mining] activateBooster failed', e);
      return { success: false, error: e.message || 'Failed to activate booster' };
    }
  }

  const status: MiningStatus = session?.status ?? 'idle';
  const progress =
    session?.status === 'mining'
      ? Math.min(1, safe(elapsedMs, 0) / safe(session.durationMs, 1))
      : session?.status === 'ready_to_claim'
        ? 1
        : 0;

  const shibReward =
    session
      ? safe(miningRatePerSec, 0) * safe(session.multiplier, 1) * (safe(session.durationMs, 0) / 1000)
      : safe(miningRatePerSec, 0) * durationMinutes * 60;

  const value = useMemo(() => ({
    session, status, timeRemaining, elapsedMs, progress,
    displayedShibBalance, isClaiming,
    startMining, claimReward, shibReward,
    miningRatePerSec, setMiningRatePerSec,
    durationMinutes, setDurationMinutes,
    miningEntryCost,
    activeBooster, activateBooster,
  }), [session, status, timeRemaining, elapsedMs, progress, displayedShibBalance, isClaiming, shibReward, miningRatePerSec, durationMinutes, miningEntryCost, activeBooster]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}

export function useMining() {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining must be used within MiningProvider');
  return ctx;
}
