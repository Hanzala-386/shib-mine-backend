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
  startMining: (multiplier?: number) => Promise<{ success: boolean; error?: string }>;
  claimReward: () => Promise<number>;
  shibReward: number;
  miningRatePerSec: number;
  setMiningRatePerSec: (rate: number) => void;
  durationMinutes: number;
  setDurationMinutes: (m: number) => void;
  miningEntryCost: number;
}

const MiningContext = createContext<MiningContextValue | null>(null);

export function MiningProvider({ children }: { children: ReactNode }) {
  const { user, pbUser, refreshBalance } = useAuth();
  const [session, setSession] = useState<MiningSession | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [miningRatePerSec, setMiningRatePerSec] = useState(0.01736);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [displayedShibBalance, setDisplayedShibBalance] = useState(0);
  const [miningEntryCost, setMiningEntryCost] = useState(24);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shibIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<MiningSession | null>(null);

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
    if (uid) loadSession();
    return () => {
      clearAllTimers();
    };
  }, [uid, pbId]);

  function clearAllTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (shibIntervalRef.current) { clearInterval(shibIntervalRef.current); shibIntervalRef.current = null; }
  }

  async function loadSession() {
    try {
      // First try server for active session
      if (pbId) {
        const res = await api.getActiveMining(pbId);
        if (res.session) {
          const s = res.session;
          const startTime = new Date(s.startTime.replace(' ', 'T').endsWith('Z') ? s.startTime : s.startTime + 'Z').getTime();
          const durationMs = s.durationMs;
          const elapsed = Date.now() - startTime;
          const status: MiningStatus = elapsed >= durationMs ? 'ready_to_claim' : 'mining';
          const local: MiningSession = {
            pbSessionId: s.id,
            startTime,
            durationMs,
            multiplier: 1,
            status,
            expectedReward: miningRatePerSec * (durationMs / 1000),
          };
          setSession(local);
          if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(local));
          if (status === 'mining') {
            setTimeRemaining(Math.max(0, durationMs - elapsed));
            setElapsedMs(elapsed);
            startTimers(local);
          }
          return;
        }
      }

      // Fall back to local cache
      if (cacheKey) {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (raw) {
          const s: MiningSession = JSON.parse(raw);
          const elapsed = Date.now() - s.startTime;
          if (s.status === 'mining') {
            if (elapsed >= s.durationMs) {
              const completed = { ...s, status: 'ready_to_claim' as MiningStatus };
              setSession(completed);
              await AsyncStorage.setItem(cacheKey, JSON.stringify(completed));
            } else {
              setSession(s);
              setTimeRemaining(s.durationMs - elapsed);
              setElapsedMs(elapsed);
              startTimers(s);
            }
          } else if (s.status === 'ready_to_claim') {
            setSession(s);
          }
        }
      }
    } catch (e) {
      console.warn('[Mining] loadSession error', e);
    }
  }

  function startTimers(s: MiningSession) {
    clearAllTimers();

    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - s.startTime;
      const remaining = Math.max(0, s.durationMs - elapsed);
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
      const elapsed = Math.min(Date.now() - s.startTime, s.durationMs);
      const rate = miningRatePerSec * s.multiplier;
      const accumulated = rate * (elapsed / 1000);
      setDisplayedShibBalance(accumulated);
    }, 100);
  }

  async function startMining(multiplier = 1): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Account not ready. Please wait.' };

    try {
      const res = await api.startMining({ pbId, multiplier });

      // Sync server-provided rate and refresh balance (PT was deducted server-side)
      if (res.miningRatePerSec) setMiningRatePerSec(res.miningRatePerSec);
      await refreshBalance();

      const startTime = new Date(
        res.startTime.includes('T') ? res.startTime : res.startTime.replace(' ', 'T') + 'Z',
      ).getTime();

      const newSession: MiningSession = {
        pbSessionId: res.id,
        startTime,
        durationMs: res.durationMs,
        multiplier,
        status: 'mining',
        expectedReward: res.expectedReward,
      };

      setSession(newSession);
      setTimeRemaining(res.durationMs);
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
    const s = sessionRef.current;
    if (!s || s.status !== 'ready_to_claim' || !pbId) return 0;

    const elapsed = Math.min(Date.now() - s.startTime, s.durationMs);
    const reward = miningRatePerSec * s.multiplier * (elapsed / 1000);

    try {
      if (s.pbSessionId) {
        const res = await api.claimMining({
          sessionId: s.pbSessionId,
          pbId,
          reward,
        });
        await refreshBalance();
        const reset: MiningSession = { ...s, status: 'idle' };
        setSession(reset);
        setTimeRemaining(0);
        setElapsedMs(0);
        setDisplayedShibBalance(0);
        clearAllTimers();
        if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(reset));
        return res.reward;
      }
    } catch (e) {
      console.warn('[Mining] claimReward failed', e);
    }

    const reset: MiningSession = { ...s, status: 'idle' };
    setSession(reset);
    setTimeRemaining(0);
    setElapsedMs(0);
    setDisplayedShibBalance(0);
    clearAllTimers();
    if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(reset));
    return reward;
  }

  const status: MiningStatus = session?.status ?? 'idle';
  const progress =
    session?.status === 'mining'
      ? Math.min(1, elapsedMs / (session.durationMs || 1))
      : session?.status === 'ready_to_claim'
        ? 1
        : 0;

  const shibReward =
    session
      ? miningRatePerSec * (session.multiplier || 1) * ((session.durationMs || 0) / 1000)
      : miningRatePerSec * durationMinutes * 60;

  const value = useMemo(() => ({
    session, status, timeRemaining, elapsedMs, progress,
    displayedShibBalance,
    startMining, claimReward, shibReward,
    miningRatePerSec, setMiningRatePerSec,
    durationMinutes, setDurationMinutes,
    miningEntryCost,
  }), [session, status, timeRemaining, elapsedMs, progress, displayedShibBalance, shibReward, miningRatePerSec, durationMinutes, miningEntryCost]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}

export function useMining() {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining must be used within MiningProvider');
  return ctx;
}
