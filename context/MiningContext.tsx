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
      if (res.expiresAt) {
        setActiveBooster({
          multiplier: res.multiplier,
          expiresAt: new Date(res.expiresAt).getTime(),
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
          const startTime = new Date(s.startTime.replace(' ', 'T').endsWith('Z') ? s.startTime : s.startTime + 'Z').getTime();
          const durationMs = s.durationMs;
          const elapsed = Date.now() - startTime;
          const status: MiningStatus = elapsed >= durationMs ? 'ready_to_claim' : 'mining';
          const local: MiningSession = {
            pbSessionId: s.id,
            startTime,
            durationMs,
            multiplier: s.multiplier || 1,
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
        } else {
          // Server says no active unclaimed session — clear stale local cache
          // This prevents a phantom "Claim" button after logout/login
          if (cacheKey) await AsyncStorage.removeItem(cacheKey);
          setSession(null);
        }
        return;
      }

      // No pbId yet — fall back to local cache only for 'mining' state (not 'ready_to_claim')
      // We never show the Claim button from local cache alone to prevent phantom claims
      if (cacheKey) {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (raw) {
          const s: MiningSession = JSON.parse(raw);
          const elapsed = Date.now() - s.startTime;
          if (s.status === 'mining') {
            if (elapsed < s.durationMs) {
              setSession(s);
              setTimeRemaining(s.durationMs - elapsed);
              setElapsedMs(elapsed);
              startTimers(s);
            } else {
              // Timed out locally but no server yet — mark as completed locally,
              // server will confirm on next load when pbId is available
              const completed = { ...s, status: 'ready_to_claim' as MiningStatus };
              setSession(completed);
              await AsyncStorage.setItem(cacheKey, JSON.stringify(completed));
            }
          }
          // Do NOT restore 'ready_to_claim' from cache without server confirmation
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

  async function startMining(): Promise<{ success: boolean; error?: string }> {
    if (!pbId) return { success: false, error: 'Account not ready. Please wait.' };

    const multiplier = activeBooster && activeBooster.expiresAt > Date.now() 
      ? activeBooster.multiplier 
      : 1;

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
    // Hard mutex: ref check is synchronous — survives rapid re-renders
    if (isClaimingRef.current) return 0;
    const s = sessionRef.current;
    if (!s || s.status !== 'ready_to_claim' || !s.pbSessionId || !pbId) return 0;

    isClaimingRef.current = true;
    setIsClaiming(true);

    // Optimistically transition UI to idle immediately — prevents phantom Claim button
    const reset: MiningSession = { ...s, status: 'idle' };
    setSession(reset);
    clearAllTimers();
    setTimeRemaining(0);
    setElapsedMs(0);
    setDisplayedShibBalance(0);
    if (cacheKey) await AsyncStorage.setItem(cacheKey, JSON.stringify(reset));

    try {
      // Send ONLY sessionId + pbId — server calculates reward authoritatively
      const res = await api.claimMining({ sessionId: s.pbSessionId, pbId });
      await refreshBalance();
      return res.reward;
    } catch (e: any) {
      console.warn('[Mining] claimReward server error:', e.message);
      // Session stays idle — don't revert the UI; user should see idle state
      // If it was already claimed (409), this is correct behavior
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
        setActiveBooster({
          multiplier: res.multiplier,
          expiresAt: new Date(res.expiresAt).getTime(),
        });
        await refreshBalance();
        return { success: true };
      }
      return { success: false, error: 'Failed to activate booster' };
    } catch (e: any) {
      console.warn('[Mining] activateBooster failed', e);
      return { success: false, error: e.message || 'Failed to activate booster' };
    }
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
    displayedShibBalance, isClaiming,
    startMining, claimReward, shibReward,
    miningRatePerSec, setMiningRatePerSec,
    durationMinutes, setDurationMinutes,
    miningEntryCost,
    activeBooster, activateBooster,
  }), [session, status, timeRemaining, elapsedMs, progress, displayedShibBalance, isClaiming, shibReward, miningRatePerSec, durationMinutes, miningEntryCost, activeBooster, activateBooster]);

  return <MiningContext.Provider value={value}>{children}</MiningContext.Provider>;
}

export function useMining() {
  const ctx = useContext(MiningContext);
  if (!ctx) throw new Error('useMining must be used within MiningProvider');
  return ctx;
}
