import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';

export type MiningStatus = 'idle' | 'mining' | 'ready_to_claim';

export interface MiningSession {
  startTime: number;
  duration: number;
  multiplier: number;
  status: MiningStatus;
}

const MINING_DURATION_MS = 60 * 60 * 1000;

interface MiningContextValue {
  session: MiningSession | null;
  status: MiningStatus;
  timeRemaining: number;
  progress: number;
  startMining: (multiplier?: number, baseMiningRate?: number) => Promise<boolean>;
  claimReward: () => Promise<number>;
  shibReward: number;
  baseMiningRate: number;
  setBaseMiningRate: (rate: number) => void;
}

const MiningContext = createContext<MiningContextValue | null>(null);

export function MiningProvider({ children }: { children: ReactNode }) {
  const { firebaseUser } = useAuth();
  const [session, setSession] = useState<MiningSession | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [baseMiningRate, setBaseMiningRate] = useState(500000);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const uid = firebaseUser?.uid;
  const storageKey = uid ? `shib_mining_${uid}` : null;

  useEffect(() => {
    if (uid) loadSession();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [uid]);

  async function loadSession() {
    if (!storageKey) return;
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (raw) {
        const s: MiningSession = JSON.parse(raw);
        setSession(s);
        if (s.status === 'mining') {
          const elapsed = Date.now() - s.startTime;
          if (elapsed >= s.duration) {
            const completed = { ...s, status: 'ready_to_claim' as MiningStatus };
            setSession(completed);
            await AsyncStorage.setItem(storageKey, JSON.stringify(completed));
          } else {
            const remaining = s.duration - elapsed;
            setTimeRemaining(remaining);
            startTimer(s);
          }
        }
      }
    } catch (e) {
      console.error('Error loading mining session', e);
    }
  }

  function startTimer(s: MiningSession) {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - s.startTime;
      const remaining = Math.max(0, s.duration - elapsed);
      setTimeRemaining(remaining);
      if (remaining === 0) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setSession(prev => {
          if (!prev) return null;
          const completed = { ...prev, status: 'ready_to_claim' as MiningStatus };
          if (storageKey) AsyncStorage.setItem(storageKey, JSON.stringify(completed));
          return completed;
        });
      }
    }, 1000);
  }

  async function startMining(multiplier: number = 1, miningRate?: number): Promise<boolean> {
    if (!storageKey) return false;
    if (miningRate) setBaseMiningRate(miningRate);
    const newSession: MiningSession = {
      startTime: Date.now(),
      duration: MINING_DURATION_MS,
      multiplier,
      status: 'mining',
    };
    setSession(newSession);
    setTimeRemaining(MINING_DURATION_MS);
    await AsyncStorage.setItem(storageKey, JSON.stringify(newSession));
    startTimer(newSession);
    return true;
  }

  async function claimReward(): Promise<number> {
    if (!storageKey || !session || session.status !== 'ready_to_claim') return 0;
    const reward = Math.floor(baseMiningRate * session.multiplier);
    const resetSession: MiningSession = { ...session, status: 'idle' };
    setSession(resetSession);
    setTimeRemaining(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
    await AsyncStorage.setItem(storageKey, JSON.stringify(resetSession));
    return reward;
  }

  const status: MiningStatus = session?.status ?? 'idle';
  const progress = session?.status === 'mining'
    ? Math.min(1, (session.duration - timeRemaining) / session.duration)
    : session?.status === 'ready_to_claim' ? 1 : 0;

  const shibReward = session ? Math.floor(baseMiningRate * session.multiplier) : baseMiningRate;

  const value = useMemo(() => ({
    session, status, timeRemaining, progress,
    startMining, claimReward, shibReward, baseMiningRate, setBaseMiningRate,
  }), [session, status, timeRemaining, progress, shibReward, baseMiningRate]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}

export function useMining() {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining must be used within MiningProvider');
  return ctx;
}
