import React, {
  createContext, useContext, useState, useEffect,
  useRef, useMemo, ReactNode, useCallback,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import storage from '@/lib/storage';
import { useAuth } from './AuthContext';
import { useSecurity } from './SecurityContext';
import { api } from '@/lib/api';
import { pb, POCKETBASE_URL } from '@/lib/pocketbase';
import {
  effectiveRatePerSec,
  normalizeVipLevel,
} from '@shared/vip';

// ── PocketBase direct reads (session restore only) ───────────────────────────
// SECURITY: All money-moving mining actions (start / claim / booster) are
// SERVER-ONLY via Express — PocketBase collection rules now block client
// writes to balances, sessions, and booster fields entirely. The only PB
// SDK usage left here is READ-ONLY session restore (pbGetActiveMining).

const PB_DURATION_MS = 60 * 60 * 1000; // 60 minutes

async function pbGetActiveMining(pbId: string): Promise<{ session: null | { id: string; startTimeMs: number; endTimeMs: number; durationMs: number; multiplier: number; vipLevel: number; serverTime: number } }> {
  try {
    const user = await pb.collection('users').getOne(pbId);
    const sessionId = user.current_mining_session;
    if (!sessionId) return { session: null };

    const s = await pb.collection('mining_sessions').getOne(sessionId);
    // claimed_amount > 0 = normal claim; < 0 (e.g. -1) = fraud-voided.
    // Both mean the session is no longer active. (The stale user.current_mining_session
    // reference is cleared SERVER-SIDE on claim — client writes to it are now blocked
    // by PocketBase rules, so no cleanup write is attempted here.)
    if ((Number(s.claimed_amount) || 0) !== 0) {
      return { session: null };
    }

    // Use PocketBase's `created` field (server-set) as canonical start time
    const rawCreated = ((s as any).created || s.start_time || '').replace(' ', 'T');
    const parsedCreated = rawCreated.endsWith('Z') ? rawCreated : rawCreated + 'Z';
    const startTimeMs = new Date(parsedCreated).getTime() || Date.now();
    return {
      session: {
        id: s.id,
        startTimeMs,
        endTimeMs: startTimeMs + PB_DURATION_MS,
        durationMs: PB_DURATION_MS,
        multiplier: Number(s.booster_multiplier) || 1,
        vipLevel: normalizeVipLevel(s.vip_level),
        serverTime: startTimeMs,
      },
    };
  } catch {
    return { session: null };
  }
}

/**
 * Fetches the current time from the PocketBase server using the HTTP Date response header.
 * This is the authoritative clock for fraud detection — the phone's system clock is untrusted.
 * Falls back to Date.now() only if the PocketBase server is completely unreachable.
 */
async function getServerTimeMs(): Promise<number> {
  try {
    const res = await fetch(`${POCKETBASE_URL}/api/health`);
    const dateHeader = res.headers.get('date') || res.headers.get('Date');
    if (dateHeader) {
      const t = new Date(dateHeader).getTime();
      if (!isNaN(t)) return t;
    }
  } catch { /* fall back to device time */ }
  return Date.now();
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
  vipLevel: number;
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
  const { blockType } = useSecurity();

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

  // ── Load settings once — PocketBase SDK direct (primary for APK + web preview) ──
  useEffect(() => {
    (async () => {
      let s: any = null;
      try {
        // PRIMARY: read from PocketBase SDK directly — api.webcod.in, works on APK + web
        const res = await pb.collection('settings').getList(1, 1);
        const raw = res.items[0];
        if (raw) {
          s = {
            miningRatePerSec:      raw.mining_rate_per_sec,
            miningDurationMinutes: raw.mining_duration_minutes,
            powerTokenPerClick:    raw.power_token_per_click,
            ratePopupFrequency:    raw.rate_popup_frequency,
            playStoreUrl:          raw.play_store_url ?? raw.app_store_link,
          };
        }
      } catch {
        try { s = await api.getSettings(); } catch { /* keep defaults */ }
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
  // Uses PocketBase's /api/health Date header — works in APK without Express.
  async function syncClockDrift(knownServerTime?: number): Promise<void> {
    try {
      if (knownServerTime && isFinite(knownServerTime)) {
        clockDriftRef.current = knownServerTime - Date.now();
        return;
      }
      const t0 = Date.now();
      const serverTime = await getServerTimeMs(); // PB /api/health Date header
      if (serverTime && isFinite(serverTime)) {
        const rtt = Date.now() - t0;
        clockDriftRef.current = serverTime - Date.now() + Math.floor(rtt / 2);
      }
    } catch { /* non-critical — keep last known drift */ }
  }

  function clearAllTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (shibIntervalRef.current) { clearInterval(shibIntervalRef.current); shibIntervalRef.current = null; }
    if (driftSyncRef.current) { clearInterval(driftSyncRef.current); driftSyncRef.current = null; }
  }

  // Anti-cheat: freeze the local mining session whenever a security block is active
  // (auto-clicker / accessibility tap service detected). The full-screen SecurityModal
  // already blocks claiming; this stops the visible timer + SHIB counter from
  // advancing while blocked. Inert in dev (__DEV__ skips all security checks, so
  // blockType stays null) — only engages in a production APK build.
  useEffect(() => {
    if (blockType) clearAllTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockType]);

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
      // Always go PB direct — Express is unreachable on-device
      const res = await pbGetActiveMining(currentPbId);

      if (!res?.session) {
        // Server has no active session.
        // IMPORTANT: if the local cache had prematurely set status='ready_to_claim'
        // due to device clock skew, we should trust the server and clear state
        // (the session is truly gone — either claimed elsewhere or expired).
        if (currentCacheKey) await storage.removeItem(currentCacheKey);
        setSession(null);
        sessionRef.current = null;
        clearAllTimers();
        return;
      }

      // ── Session confirmed by server — use PB's server clock as single source of truth ──
      // NOTE: res.session.serverTime = startTimeMs (a historical timestamp, NOT current time).
      // DO NOT use it to update clockDrift — that corrupts serverNow() and makes the timer
      // show wrong values. clockDrift is maintained by syncClockDrift() via the PB Date header.
      const pbStart = res.session.startTimeMs;
      const pbEnd   = res.session.endTimeMs;
      const pbDur   = res.session.durationMs;

      // Use device clock only — clockDrift is already correct from syncClockDrift()
      const now       = Date.now() + clockDriftRef.current;
      const remaining = Math.max(0, pbEnd - now);
      const elapsed   = Math.min(Math.max(0, now - pbStart), pbDur);

      if (remaining <= 0) {
        // Server confirms session existed but it's now past 60 min → safe to show CLAIM
        const current = sessionRef.current;
        const done: MiningSession = {
          ...(current ?? {
            pbSessionId: res.session.id,
            startTimeMs: pbStart,
            endTimeMs: pbEnd,
            durationMs: pbDur,
            multiplier: res.session.multiplier,
            vipLevel: normalizeVipLevel(res.session.vipLevel),
            expectedReward: 0,
          }),
          startTimeMs: pbStart,
          endTimeMs: pbEnd,
          status: 'ready_to_claim',
        };
        sessionRef.current = done;
        setSession(done);
        clearAllTimers();
        if (currentCacheKey) storage.setItem(currentCacheKey, JSON.stringify(done)).catch(() => {});
        return;
      }

      // Session is still running — sync/correct timer state regardless of what the
      // local cache thought. This fixes premature CLAIM caused by device clock skew:
      // even if the cache had status='ready_to_claim', PB says there's time left → go back to mining.
      const current = sessionRef.current;
      const synced: MiningSession = {
        ...(current ?? {}),
        pbSessionId: res.session.id,
        startTimeMs: pbStart,
        endTimeMs:   pbEnd,
        durationMs:  pbDur,
        multiplier:  res.session.multiplier,
        status:      'mining',
        vipLevel:    normalizeVipLevel(res.session.vipLevel),
        expectedReward: safe(current?.expectedReward, 0),
      };
      sessionRef.current = synced;
      setSession(synced);
      setTimeRemaining(remaining);
      setElapsedMs(elapsed);
      if (currentCacheKey) storage.setItem(currentCacheKey, JSON.stringify(synced)).catch(() => {});

      // Restart timers with PB-authoritative start/end so both circle and main timer
      // track the server clock — kills any stale interval running from old closure values
      startTimers(synced);
    } catch { /* network error — stay with local state */ }
  }

  async function fetchFromServer(currentPbId: string, currentCacheKey: string | null) {
    // Go directly to PocketBase SDK — Express is unreachable from the APK
    let res: any;
    try {
      res = await pbGetActiveMining(currentPbId);
    } catch {
      res = { session: null };
    }
    if (res?.session) {
      const s = res.session;
      // NOTE: s.serverTime is startTimeMs (session start, not current time) — do NOT
      // use it to update clockDrift. clockDrift is managed by syncClockDrift() only.
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
        vipLevel: normalizeVipLevel(s.vipLevel),
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
        import('@/lib/notifications').then(({ notifyMiningComplete, scheduleMiningReminder }) => {
          notifyMiningComplete().catch(() => {});
          scheduleMiningReminder().catch(() => {});
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
      const sessionVip = normalizeVipLevel((s as Partial<MiningSession>).vipLevel ?? user?.vipLevel ?? 0);
      const rate = effectiveRatePerSec(safe(miningRateRef.current, 0.01736), sessionVip) * effectiveMultiplier;
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
      // SERVER-ONLY: the Express backend validates the caller's PB token,
      // reads the entry cost from settings, and creates the session itself.
      // PocketBase rules block client-side session/balance writes entirely.
      const res = await api.startMining({
        pbId: currentPbId,
        multiplier,
        miningRatePerSec: miningRateRef.current,
      });

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
        vipLevel: normalizeVipLevel(res.vipLevel),
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
      // Do NOT resume stale timers — if the PB call failed, there is no real session.
      // Clear any stale cache so the UI resets to idle correctly.
      clearAllTimers();
      sessionRef.current = null;
      setSession(null);
      if (currentCacheKey) storage.removeItem(currentCacheKey).catch(() => {});
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

    // ── Always resets local session state, regardless of outcome ──────────
    const resetLocalSession = () => {
      clearAllTimers();
      setTimeRemaining(0);
      setElapsedMs(0);
      setDisplayedShibBalance(0);
      setSession(null);
      sessionRef.current = null;
      storage.removeItem(currentCacheKey ?? '').catch(() => {});
    };

    // ── The actual claim work — SERVER-ONLY via Express ───────────────────
    // The server recomputes the reward from the session's server-set timestamps
    // and rate settings; the client sends only sessionId + pbId. PocketBase
    // rules block any client-side balance/session write, so there is no
    // PB-direct fallback — if the backend is unreachable the claim fails
    // closed and the user retries (the session is untouched server-side).
    const doActualClaim = async (): Promise<number> => {
      const res = await api.claimMining({ sessionId: s.pbSessionId!, pbId: currentPbId });

      // ── Success path ────────────────────────────────────────────────────
      resetLocalSession();

      // Cancel the 24-hour reminder — user has claimed
      import('@/lib/notifications').then(({ cancelMiningReminder }) => {
        cancelMiningReminder().catch(() => {});
      });

      // BUG 3 FIX: AWAIT refreshBalance() so the wallet balance is updated
      // BEFORE the success alert fires. Previously this was fire-and-forget,
      // causing the user to see old balance even after a successful claim.
      await refreshBalance().catch(() => {});

      // Rate Us: increment completed-session counter (non-critical, best-effort)
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
          if (count % freq === 0 && count > dismissedAt) setShowRateUs(true);
        }
      } catch { /* non-critical */ }

      return safe(res?.reward, 0);
    };

    try {
      // ── 10-second HARD CAP on the PocketBase claim call ───────────────
      // If PocketBase stalls due to network issues the button still unfreezes
      // within 10 s and the user sees a clear error message.
      const hardTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(
          Object.assign(new Error('Request timed out after 10 seconds.'), {
            data: { error: 'CLAIM_TIMEOUT' },
          })
        ), 10000)
      );

      return await Promise.race([doActualClaim(), hardTimeout]);

    } catch (e: any) {
      const errCode = e?.data?.error || '';

      if (errCode === 'CLAIM_TIMEOUT') {
        // Network stall — clear local state so the user can retry. The server
        // still holds the unclaimed session; it will restore on next login and
        // the reward remains claimable (server clears the ref only on claim).
        resetLocalSession();
        throw e; // handleClaim shows "try again" message
      }

      if (errCode === 'FRAUD_DETECTED' || errCode === 'ACCOUNT_BLOCKED' || errCode === 'SESSION_EXPIRED') {
        resetLocalSession();
        // The server voids the session (claimed_amount=-1) itself; pbGetActiveMining
        // treats ≠0 as inactive, so the session won't auto-restore on next login.
        if (errCode === 'FRAUD_DETECTED' || errCode === 'ACCOUNT_BLOCKED') throw e;
        console.warn('[Mining] Session expired/voided — reset to idle');
        return 0;
      }

      // Any other error (e.g. "already claimed", 404 session not found):
      // reset locally — the server owns the session reference and clears or
      // voids it on its side, so no client-side PB write is needed here.
      console.warn('[Mining] claimReward error:', e?.message);
      resetLocalSession();
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
      // SERVER-ONLY: the server validates the multiplier against its whitelist
      // (2/4/6/10) and reads the cost from settings itself — the client sends
      // only the multiplier. Forged values are rejected with 400.
      const res = await api.activateBooster({ pbId: currentPbId, multiplier });
      if (res?.success) {
        const expiresAt = parseBoosterTs(res.expiresAt);
        const newBooster = { multiplier: safe(res.multiplier, multiplier), expiresAt };
        setActiveBooster(newBooster);
        activeBoosterRef.current = newBooster;
        refreshBalance().catch(() => {});
        return { success: true };
      }
      return { success: false, error: 'Failed to activate booster' };
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
      // SERVER-ONLY: one atomic Express round-trip. The server whitelists the
      // multiplier, reads booster + entry costs from settings, deducts PT, and
      // creates the session — no client-side PB writes anywhere in this path.
      const res = await api.activateAndMine({ pbId: currentPbId, multiplier });

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
        vipLevel: normalizeVipLevel(res.vipLevel),
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
      // Do NOT resume stale timers — PB call failed so no real session exists.
      // Clear any stale cache so the UI resets to idle correctly.
      clearAllTimers();
      sessionRef.current = null;
      setSession(null);
      if (currentCacheKey) storage.removeItem(currentCacheKey).catch(() => {});
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

  const displayVip = normalizeVipLevel(
    session ? ((session as Partial<MiningSession>).vipLevel ?? user?.vipLevel ?? 0) : (user?.vipLevel ?? 0),
  );
  const displayVipRate = effectiveRatePerSec(safe(miningRatePerSec), displayVip);
  const shibReward = session
    ? safe(displayVipRate) * safe(session.multiplier, 1) * (safe(session.durationMs) / 1000)
    : safe(displayVipRate) * durationMinutes * 60;

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
