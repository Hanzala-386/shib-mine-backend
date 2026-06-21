/**
 * TournamentContext — Zero-Trust MANUAL-CYCLE Tournament state management
 *
 * Fully-manual model (NO weekly calendar):
 *  - A tournament exists ONLY while the admin has one running. Each launch mints
 *    a unique `cycle_id`. When the cycle's end_time passes the server finalizes
 *    it (payout + wipe) and stays inactive until the admin starts a new one.
 *  - Phase is derived client-side (see getTournamentPhase): none / prestart /
 *    live. There is NO intermission state.
 *  - isRegistered is keyed to `cycle_id`: a participant row only unlocks the
 *    board when its cycle_id equals the active config's cycle_id. A row left
 *    over from a previous cycle can never unlock the current one.
 *  - Server time offset: countdown math uses `Date.now() + serverOffset` so a
 *    manipulated device clock can't affect the displayed deadline.
 *
 * All write operations use the PB SDK directly (APK-compatible).
 */
import React, {
  createContext, useContext, useState, useEffect,
  useCallback, useRef, ReactNode,
} from 'react';
import { pb, POCKETBASE_URL } from '@/lib/pocketbase';
import { syncTournamentPointsToPb } from '@/lib/api';
import { getApiUrl } from '@/lib/query-client';
import { useAuth } from './AuthContext';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TournamentConfig {
  id: string;
  cycle_id: string;        // unique per manual launch; '' for legacy configs
  prize_pool_total: number;
  winners_count: number;
  reward_structure: Record<string, number>;
  banner_url: string;
  week_start: string;
  start_time: string;
  end_time: string;        // admin-set absolute end of THIS cycle
  is_active: boolean;
}

export interface TournamentEntry {
  rank: number;
  id: string;
  displayName: string;
  points: number;
  prize: number;
  avatarUrl?: string;
}

interface TournamentContextValue {
  config: TournamentConfig | null;
  userJoined: boolean;
  isRegistered: boolean;         // authoritative: a participant ROW for the CURRENT cycle_id exists
  userPoints: number;
  hasRejected: boolean;
  showPopup: boolean;
  serverOffset: number;          // ms offset: serverTime - Date.now() at load
  leaderboard: TournamentEntry[];
  leaderboardLoading: boolean;
  loadingConfig: boolean;
  joinTournament: () => Promise<void>;
  rejectTournament: () => Promise<void>;
  refreshLeaderboard: () => Promise<void>;
  refreshUserStats: () => Promise<void>;
  refreshConfig: () => Promise<void>;   // re-fetch config + server time (cycle/phase freshness)
}

const TournamentContext = createContext<TournamentContextValue>({
  config: null,
  userJoined: false,
  isRegistered: false,
  userPoints: 0,
  hasRejected: false,
  showPopup: false,
  serverOffset: 0,
  leaderboard: [],
  leaderboardLoading: false,
  loadingConfig: true,
  joinTournament: async () => {},
  rejectTournament: async () => {},
  refreshLeaderboard: async () => {},
  refreshUserStats: async () => {},
  refreshConfig: async () => {},
});

// ── Provider ───────────────────────────────────────────────────────────────

export function TournamentProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const mounted  = useRef(true);
  // Always-current mirror of config. Lets the STABLE (deps-free)
  // refreshLeaderboard / refreshUserStats callbacks read the latest cycle WITHOUT
  // taking `config` as a dependency. Taking `config` churned those callbacks'
  // identity on every config refresh, which churned refreshTournament, which
  // re-fired the leaderboard screen's effects → the infinite refresh loop.
  // Kept in lock-step with state synchronously inside loadConfig.
  const configRef         = useRef<TournamentConfig | null>(null);

  const [config, setConfig]                     = useState<TournamentConfig | null>(null);
  const [userJoined, setUserJoined]             = useState(false);
  // The cycle_id of the participant ROW we last confirmed for this user, or null
  // if no row exists. `isRegistered` is DERIVED from this vs the active config's
  // cycle_id (see below) so a leftover row from a previous cycle can never unlock
  // the current leaderboard.
  const [registeredCycleId, setRegisteredCycleId] = useState<string | null>(null);
  const [userPoints, setUserPoints]             = useState(0);
  const [hasRejected, setHasRejected]           = useState(false);
  const [leaderboard, setLeaderboard]           = useState<TournamentEntry[]>([]);
  const [leaderboardLoading, setLbLoading]      = useState(false);
  const [loadingConfig, setLoadingConfig]       = useState(true);
  const [serverOffset, setServerOffset]         = useState(0);
  // Mirror of the committed serverOffset (kept for any time-corrected math).
  const serverOffsetRef   = useRef(0);

  // userStatsChecked guards popup race: don't show popup until we know
  // whether the user has already joined this cycle.
  const [userStatsChecked, setUserStatsChecked] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // ── Load tournament config + server time ─────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      // 1. Try the Express route first — it returns config + serverTime atomically
      let raw: any = null;
      let serverTime = Date.now();

      try {
        const apiUrl = getApiUrl();
        const url    = new URL('/api/app/tournament/config', apiUrl).href;
        const r      = await fetch(url, { signal: AbortSignal.timeout?.(5000) });
        if (r.ok) {
          const j = await r.json();
          raw        = j.config;
          serverTime = j.serverTime ?? Date.now();
        }
      } catch {}

      // 2. PocketBase SDK fallback (APK / Express down)
      if (!raw) {
        try {
          const res = await pb.collection('tournament_config').getList(1, 1, { sort: '-created' });
          raw = res.items[0] ?? null;
        } catch {}

        // Also fetch server time from dedicated endpoint as fallback
        try {
          const apiUrl = getApiUrl();
          const stUrl  = new URL('/api/app/server-time', apiUrl).href;
          const sr     = await fetch(stUrl, { signal: AbortSignal.timeout?.(3000) });
          if (sr.ok) { const sj = await sr.json(); serverTime = sj.serverTime ?? serverTime; }
        } catch {}
      }

      if (!mounted.current) return;

      // Compute monotonic offset: how far ahead/behind server clock is from device
      // clock. Only commit when it shifts meaningfully (>1.5s) — recomputing every
      // refresh (Date.now keeps advancing) would needlessly churn serverOffset and
      // re-fire the leaderboard screen's boundary effects that depend on it.
      const offset = serverTime - Date.now();
      if (Math.abs(offset - serverOffsetRef.current) > 1500) {
        serverOffsetRef.current = offset;
        if (mounted.current) setServerOffset(offset);
      }

      // No config at all → there has never been (or no longer is) a tournament.
      // Clear it so the leaderboard shows the inactive "starts soon" state.
      if (!raw) {
        configRef.current = null;
        if (mounted.current) setConfig(null);
        return;
      }

      let rewardStructure: Record<string, number> = {};
      try { rewardStructure = JSON.parse(raw.reward_structure || '{}'); } catch {}

      // Build banner URL from file field OR legacy banner_url text
      let bannerUrl = '';
      if (raw.banner) {
        const filename = Array.isArray(raw.banner) ? raw.banner[0] : raw.banner;
        if (filename) bannerUrl = `${POCKETBASE_URL}/api/files/tournament_config/${raw.id}/${filename}`;
      }
      if (!bannerUrl && raw.banner_url) bannerUrl = raw.banner_url;

      const cfg: TournamentConfig = {
        id:               raw.id,
        cycle_id:         raw.cycle_id     || '',
        prize_pool_total: Number(raw.prize_pool_total) || 0,
        winners_count:    Number(raw.winners_count)    || 3,
        reward_structure: rewardStructure,
        banner_url:       bannerUrl,
        week_start:       raw.week_start   || '',
        start_time:       raw.start_time   || raw.week_start || '',
        end_time:         raw.end_time     || '',
        is_active:        !!raw.is_active,
      };

      // Keep the latest-value ref in lock-step with state so the STABLE
      // refreshLeaderboard / refreshUserStats callbacks always read the current
      // cycle. No separate signature gate is needed: cycle_id registration
      // matching (see isRegistered) makes a leftover row from a previous cycle
      // fail to unlock the board DECLARATIVELY the instant fresh config loads.
      configRef.current = cfg;

      if (mounted.current) setConfig(cfg);
    } catch {
      // tournament_config collection may not exist yet — fail silently
    } finally {
      if (mounted.current) setLoadingConfig(false);
    }
  }, []);

  // ── Load user tournament stats ───────────────────────────────────────────
  const refreshUserStats = useCallback(async () => {
    if (!user?.pbId) return;
    try {
      // Production-safe self-heal: recompute the authoritative points from
      // mining_sessions before reading. Covers the rare case where the
      // fire-and-forget sync after a claim didn't finish (e.g. app killed). It is a
      // no-op outside an active cycle / for non-participants and skips the write when
      // the total is unchanged, so it adds no churn on normal leaderboard refreshes.
      await syncTournamentPointsToPb(user.pbId);
      const u = await pb.collection('users').getOne(user.pbId, {
        fields: 'id,tournament_joined,weekly_tournament_points',
      });
      if (mounted.current) {
        setUserJoined(!!u.tournament_joined);
        setUserPoints(Number(u.weekly_tournament_points) || 0);
      }

      // ── REGISTRATION GATE (per-cycle_id) ─────────────────────────────────
      // The AUTHORITATIVE signal is the participant ROW, NOT the tournament_joined
      // flag. But a row ONLY counts for the CURRENT cycle: its cycle_id must equal
      // the active config's cycle_id. A leftover row from a PAST tournament keeps a
      // non-matching cycle_id → its value is still stored (so re-tapping JOIN
      // de-dupes onto it) but isRegistered (derived) stays false → the poster
      // re-appears instead of silently unlocking the board on stale data.
      let participant: any = null;
      try {
        participant = await pb
          .collection('tournament_participants')
          .getFirstListItem(`user_id = "${user.pbId}"`, { sort: '-created' });
      } catch { participant = null; }

      const rowCycleId      = participant?.id ? (participant.cycle_id ?? '') : null;
      const currentCycleId  = configRef.current?.cycle_id || '';
      const matchesCurrent  = !!rowCycleId && !!currentCycleId && rowCycleId === currentCycleId;

      if (mounted.current) setRegisteredCycleId(rowCycleId);

      // Only mirror flag/points for a row that belongs to the CURRENT cycle — never
      // resurrect tournament_joined for a stale past-cycle row.
      if (participant?.id && matchesCurrent) {
        if (!u.tournament_joined) {
          try { await pb.collection('users').update(user.pbId, { tournament_joined: true }); } catch {}
          if (mounted.current) setUserJoined(true);
        }
        // Mirror the authoritative points into the cosmetic participant column so it
        // stays in sync even if the Express sync route is unreachable in production.
        const pts = Number(u.weekly_tournament_points) || 0;
        if (Number(participant.points) !== pts) {
          try { await pb.collection('tournament_participants').update(participant.id, { points: pts }); } catch {}
        }
      }
    } catch {
      if (mounted.current) { setUserJoined(false); setRegisteredCycleId(null); }
    } finally {
      if (mounted.current) setUserStatsChecked(true);
    }
  }, [user?.pbId]);

  // ── Reset all user-specific state when the logged-in user changes ────────
  useEffect(() => {
    setUserJoined(false);
    setRegisteredCycleId(null);
    setUserPoints(0);
    setHasRejected(false);
    setUserStatsChecked(false);
  }, [user?.pbId]);

  useEffect(() => { loadConfig(); }, []);
  useEffect(() => { if (user?.pbId) refreshUserStats(); }, [user?.pbId]);

  // ── Tournament leaderboard ───────────────────────────────────────────────
  const refreshLeaderboard = useCallback(async () => {
    setLbLoading(true);
    try {
      const res = await pb.collection('users').getList(1, 100, {
        sort:   '-weekly_tournament_points',
        filter: 'tournament_joined = true && weekly_tournament_points > 0',
        fields: 'id,display_name,weekly_tournament_points,avatar2',
      });
      if (!mounted.current) return;

      const rewardMap = configRef.current?.reward_structure ?? {};
      const entries: TournamentEntry[] = res.items.map((u: any, i: number) => {
        let name: string = u.display_name || 'Miner';
        if (name.includes('@')) name = name.split('@')[0];
        const rank = i + 1;

        let avatarUrl: string | undefined;
        const av2 = u.avatar2;
        if (av2) {
          const filename = Array.isArray(av2) ? av2[0] : av2;
          if (filename) avatarUrl = `${POCKETBASE_URL}/api/files/users/${u.id}/${filename}`;
        }

        return {
          rank,
          id:          u.id,
          displayName: name,
          points:      Number(u.weekly_tournament_points) || 0,
          prize:       Number(rewardMap[String(rank)])    || 0,
          avatarUrl,
        };
      });
      if (mounted.current) setLeaderboard(entries);
    } catch {} finally {
      if (mounted.current) setLbLoading(false);
    }
    // STABLE identity (empty deps): reads reward_structure from configRef, never
    // the `config` object. Depending on `config` here churned this callback's
    // identity on every refresh, cascading into the leaderboard screen's infinite
    // refresh loop (effects depend on refreshTournament → refreshLeaderboard).
  }, []);

  // ── Join tournament ──────────────────────────────────────────────────────
  // ORDER MATTERS. The participant ROW is the authoritative proof of registration
  // and is created FIRST (awaited, not fire-and-forget). Only once it exists do we
  // set the tournament_joined flag and mark the user registered. If the row create
  // fails, this THROWS so the caller keeps the lock screen up and shows an error —
  // never the old bug where the flag was set with no row behind it.
  const joinTournament = useCallback(async () => {
    if (!user?.pbId) throw new Error('Not signed in');

    // Target cycle to register INTO = the active config's cycle_id. Without an
    // active cycle there is nothing to join.
    const targetCycleId = config?.cycle_id || '';
    if (!targetCycleId) throw new Error('No active tournament to join');
    const targetIso = config?.start_time || config?.week_start || new Date().toISOString();

    // Dedupe by user. A surviving row from a PAST cycle is RE-POINTED at the
    // current cycle (update cycle_id) rather than left stale or duplicated, so a
    // returning user who taps JOIN for the new cycle registers cleanly.
    let existing: any = null;
    try {
      existing = await pb
        .collection('tournament_participants')
        .getFirstListItem(`user_id = "${user.pbId}"`, { sort: '-created' });
    } catch { existing = null; }

    if (existing?.id) {
      if ((existing.cycle_id ?? '') !== targetCycleId) {
        await pb.collection('tournament_participants').update(existing.id, {
          cycle_id:   targetCycleId,
          week_start: targetIso,
          joined_at:  new Date().toISOString(),
        });
      }
    } else {
      // Create the row (throws on failure → caller keeps the lock up + shows error).
      const displayName = (user as any).displayName || (user as any).email || 'Miner';
      await pb.collection('tournament_participants').create({
        user_id:      user.pbId,
        display_name: typeof displayName === 'string' ? displayName.split('@')[0] : 'Miner',
        cycle_id:     targetCycleId,
        week_start:   targetIso,
        joined_at:    new Date().toISOString(),
        points:       0,
      });
    }

    // Row confirmed — set the joined flag (controls leaderboard inclusion).
    try { await pb.collection('users').update(user.pbId, { tournament_joined: true }); } catch {}

    if (mounted.current) {
      setRegisteredCycleId(targetCycleId);
      setUserJoined(true);
    }

    // If the user already claimed sessions during this cycle (e.g. mined before
    // joining), surface their points immediately instead of waiting for the next
    // claim. Best-effort — never blocks joining.
    syncTournamentPointsToPb(user.pbId).catch(() => {});
  }, [user?.pbId, config?.cycle_id, config?.start_time, config?.week_start]);

  // ── Reject tournament (session-only dismiss) ─────────────────────────────
  const rejectTournament = useCallback(async () => {
    if (mounted.current) setHasRejected(true);
  }, []);

  // ── DERIVED per-cycle_id registration gate ───────────────────────────────
  // A participant row only unlocks the leaderboard when its cycle_id matches the
  // active config's cycle_id. A leftover row from a PAST tournament therefore
  // fails to register the user for the new cycle → the registration poster shows
  // again. Fully declarative: re-derives the instant fresh config loads, with no
  // stale-render window.
  const currentCycleId = config?.cycle_id || '';
  const isRegistered = !!registeredCycleId
    && !!currentCycleId
    && registeredCycleId === currentCycleId;

  // Popup shows ONLY while a tournament cycle is live or pre-start (manual model —
  // no intermission). Gates on the derived phase (not raw is_active) so a config
  // left is_active=true around finalization lag — after end_time has passed but
  // before the server flips is_active=false — never leaks an inactive-state popup.
  // Also gates on userStatsChecked to avoid the race before join-status is confirmed.
  const popupPhase = getTournamentPhase(config, Date.now() + serverOffset);
  const showPopup = !!(
    popupPhase !== 'none' &&
    !isRegistered &&
    !hasRejected &&
    !loadingConfig &&
    userStatsChecked &&
    !!user?.pbId
  );

  return (
    <TournamentContext.Provider value={{
      config,
      userJoined,
      isRegistered,
      userPoints,
      hasRejected,
      showPopup,
      serverOffset,
      leaderboard,
      leaderboardLoading,
      loadingConfig,
      joinTournament,
      rejectTournament,
      refreshLeaderboard,
      refreshUserStats,
      refreshConfig: loadConfig,
    }}>
      {children}
    </TournamentContext.Provider>
  );
}

export function useTournament() {
  return useContext(TournamentContext);
}

// ── Phase derivation ─────────────────────────────────────────────────────────
// Single source of truth for which tournament phase we're in, using the
// server-corrected clock (serverNowMs = Date.now() + serverOffset). Fully-manual
// model — there is NO intermission:
//   - 'none'      no config / not active / already past end_time → red "starts soon"
//   - 'prestart'  active but not yet started (serverNow < start_time) → "STARTS IN"
//   - 'live'      active and running (start_time <= serverNow < end_time) → "ENDS IN"
export type TournamentPhase = 'none' | 'prestart' | 'live';

export function getTournamentPhase(
  config: TournamentConfig | null,
  serverNowMs: number,
): TournamentPhase {
  if (!config || !config.is_active) return 'none';
  const startMs = config.start_time ? new Date(config.start_time).getTime() : 0;
  const endMs   = config.end_time   ? new Date(config.end_time).getTime()   : 0;
  if (endMs && serverNowMs >= endMs) return 'none';
  if (startMs && serverNowMs < startMs) return 'prestart';
  return 'live';
}
