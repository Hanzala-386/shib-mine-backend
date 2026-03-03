import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { pbAPI, type PBMiningSession } from '@/lib/pocketbase';

export type MiningStatus = 'idle' | 'mining' | 'ready_to_claim';

export interface MiningSession {
  pbSessionId?: string;
  startTime: number;
  duration: number;
  multiplier: number;
  status: MiningStatus;
  reward: number;
}

const MINING_DURATION_MS = 60 * 60 * 1000;

interface MiningContextValue {
  session: MiningSession | null;
  status: MiningStatus;
  timeRemaining: number;
  elapsedMs: number;
  progress: number;
  displayedShibBalance: number;
  startMining: (multiplier?: number, baseMiningRate?: number) => Promise<boolean>;
  claimReward: () => Promise<number>;
  shibReward: number;
  baseMiningRate: number;
  setBaseMiningRate: (rate: number) => void;
}

const MiningContext = createContext<MiningContextValue | null>(null);

function pbSessionToLocal(pb: PBMiningSession): MiningSession {
  const startTime = new Date(pb.startTime).getTime();
  const elapsed = Date.now() - startTime;
  const status: MiningStatus = pb.status === 'claimed'
    ? 'idle'
    : elapsed >= pb.duration
      ? 'ready_to_claim'
      : 'mining';
  return {
    pbSessionId: pb.id,
    startTime,
    duration: pb.duration,
    multiplier: pb.multiplier,
    status,
    reward: pb.reward,
  };
}

export function MiningProvider({ children }: { children: ReactNode }) {
  const { user, firebaseUser } = useAuth();
  const [session, setSession] = useState<MiningSession | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [baseMiningRate, setBaseMiningRate] = useState(500000);
  const [displayedShibBalance, setDisplayedShibBalance] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shibIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const uid = firebaseUser?.uid;
  const pbId = user?.pbId;
  const cacheKey = uid ? `shib_mining_${uid}` : null;

  useEffect(() => {
    if (uid) loadSession();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (shibIntervalRef.current) clearInterval(shibIntervalRef.current);
    };
  }, [uid]);

  async function loadSession() {
    try {
      if (pbId) {
        const pbSession = await pbAPI.getActiveMiningSession(pbId);
        if (pbSession) {
          const local = pbSessionToLocal(pbSession);
          setSession(local);
          if (local.status === 'mining') {
            const elapsed = Date.now() - local.startTime;
            const remaining = Math.max(0, local.duration - elapsed);
            setTimeRemaining(remaining);
            setElapsedMs(elapsed);
            startTimers(local);
          }
          if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(local));
          return;
        }
      }

      if (cacheKey) {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (raw) {
          const s: MiningSession = JSON.parse(raw);
          if (s.status === 'mining') {
            const elapsed = Date.now() - s.startTime;
            if (elapsed >= s.duration) {
              const completed = { ...s, status: 'ready_to_claim' as MiningStatus };
              setSession(completed);
              await AsyncStorage.setItem(cacheKey, JSON.stringify(completed));
            } else {
              const remaining = s.duration - elapsed;
              setSession(s);
              setTimeRemaining(remaining);
              setElapsedMs(elapsed);
              startTimers(s);
            }
          } else {
            setSession(s);
          }
        }
      }
    } catch (e) {
      console.warn('[Mining] Error loading session', e);
    }
  }

  function startTimers(s: MiningSession) {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (shibIntervalRef.current) clearInterval(shibIntervalRef.current);

    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - s.startTime;
      const remaining = Math.max(0, s.duration - elapsed);
      setTimeRemaining(remaining);
      setElapsedMs(elapsed);
      if (remaining === 0) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (shibIntervalRef.current) clearInterval(shibIntervalRef.current);
        setSession(prev => {
          if (!prev) return null;
          const completed = { ...prev, status: 'ready_to_claim' as MiningStatus };
          if (cacheKey) AsyncStorage.setItem(cacheKey, JSON.stringify(completed));
          return completed;
        });
      }
    }, 1000);

    shibIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - s.startTime;
      const rate = baseMiningRate * s.multiplier;
      const accumulated = Math.floor((rate * Math.min(elapsed, s.duration)) / s.duration);
      setDisplayedShibBalance(accumulated);
    }, 100);
  }

  async function startMining(multiplier: number = 1, miningRate?: number): Promise<boolean> {
    const rate = miningRate ?? baseMiningRate;
    if (miningRate) setBaseMiningRate(miningRate);

    const newSession: MiningSession = {
      startTime: Date.now(),
      duration: MINING_DURATION_MS,
      multiplier,
      status: 'mining',
      reward: Math.floor(rate * multiplier),
    };

    try {
      if (pbId) {
        const pbSession = await pbAPI.startMiningSession(pbId, multiplier, rate);
        newSession.pbSessionId = pbSession.id;
      }
    } catch (e) {
      console.warn('[Mining] PocketBase startMining failed, using local', e);
    }

    setSession(newSession);
    setTimeRemaining(MINING_DURATION_MS);
    setElapsedMs(0);
    setDisplayedShibBalance(0);
    if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(newSession));
    startTimers(newSession);
    return true;
  }

  async function claimReward(): Promise<number> {
    if (!session || session.status !== 'ready_to_claim') return 0;
    const reward = session.reward;

    try {
      if (pbId && session.pbSessionId) {
        await pbAPI.claimMiningSession(session.pbSessionId, pbId, reward);
      }
    } catch (e) {
      console.warn('[Mining] PocketBase claim failed, using local', e);
    }

    const reset: MiningSession = { ...session, status: 'idle' };
    setSession(reset);
    setTimeRemaining(0);
    setElapsedMs(0);
    setDisplayedShibBalance(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (shibIntervalRef.current) clearInterval(shibIntervalRef.current);
    if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(reset));
    return reward;
  }

  const status: MiningStatus = session?.status ?? 'idle';
  const progress = session?.status === 'mining'
    ? Math.min(1, elapsedMs / MINING_DURATION_MS)
    : session?.status === 'ready_to_claim' ? 1 : 0;

  const shibReward = session ? session.reward : Math.floor(baseMiningRate);

  const value = useMemo(() => ({
    session, status, timeRemaining, elapsedMs, progress,
    displayedShibBalance,
    startMining, claimReward, shibReward, baseMiningRate, setBaseMiningRate,
  }), [session, status, timeRemaining, elapsedMs, progress, displayedShibBalance, shibReward, baseMiningRate]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}

export function useMining() {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining must be used within MiningProvider');
  return ctx;
}
