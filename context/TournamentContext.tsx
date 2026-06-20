/**
 * TournamentContext — Zero-Trust Weekly Tournament state management
 *
 * Security additions over v1:
 *  - Server time offset: fetches `GET /api/app/server-time` on init; all
 *    countdown math uses `Date.now() + serverOffset` so device-clock
 *    manipulation doesn't affect the displayed deadline.
 *  - isIntermission: derived from server-authoritative is_active flag.
 *    True during the Sunday 18:00 → Monday 00:00 UTC gap.
 *  - end_time: populated by the server (next Sunday 18:00 UTC);
 *    the popup and leaderboard countdown to this instead of week_start + 7d.
 *
 * All write operations still use PB SDK directly (APK-compatible).
 */
import React, {
  createContext, useContext, useState, useEffect,
  useCallback, useRef, ReactNode,
} from 'react';
import { pb, POCKETBASE_URL } from '@/lib/pocketbase';
import { getApiUrl } from '@/lib/query-client';
import { useAuth } from './AuthContext';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TournamentConfig {
  id: string;
  prize_pool_total: number;
  winners_count: number;
  reward_structure: Record<string, number>;
  banner_url: string;
  week_start: string;
  start_time: string;
  end_time: string;        // server-set: next Sunday 18:00 UTC
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
  isRegistered: boolean;         // authoritative: a tournament_participants ROW exists
  userPoints: number;
  hasRejected: boolean;
  showPopup: boolean;
  isIntermission: boolean;       // true during Sunday 6PM – Monday 12AM UTC gap
  serverOffset: number;          // ms offset: serverTime - Date.now() at load
  leaderboard: TournamentEntry[];
  leaderboardLoading: boolean;
  loadingConfig: boolean;
  joinTournament: (duringIntermission?: boolean) => Promise<void>;
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
  isIntermission: false,
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
  // Last seen `${week_start}|${is_active}` cycle signature; used to invalidate a
  // cached registration the instant config crosses a weekly boundary.
  const configSigRef = useRef<string | null>(null);

  const [config, setConfig]                     = useState<TournamentConfig | null>(null);
  const [userJoined, setUserJoined]             = useState(false);
  // The ISO week_start of the participant ROW we last confirmed for this user,
  // or null if no row exists. `isRegistered` is DERIVED from this vs the current
  // cycle (see below) so a leftover row from a previous cycle — or a stale value
  // surviving the weekly wipe — can never unlock the current leaderboard.
  const [registeredWeek, setRegisteredWeek]     = useState<string | null>(null);
  const [userPoints, setUserPoints]             = useState(0);
  const [hasRejected, setHasRejected]           = useState(false);
  const [leaderboard, setLeaderboard]           = useState<TournamentEntry[]>([]);
  const [leaderboardLoading, setLbLoading]      = useState(false);
  const [loadingConfig, setLoadingConfig]       = useState(true);
  const [isIntermission, setIsIntermission]     = useState(false);
  const [serverOffset, setServerOffset]         = useState(0);

  // userStatsChecked guards popup race: don't show popup until we know
  // whether the user has already joined this week.
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
      let intermission = false;

      try {
        const apiUrl = getApiUrl();
        const url    = new URL('/api/app/tournament/config', apiUrl).href;
        const r      = await fetch(url, { signal: AbortSignal.timeout?.(5000) });
        if (r.ok) {
          const j = await r.json();
          raw          = j.config;
          serverTime   = j.serverTime ?? Date.now();
          intermission = !!j.isIntermission;
        }
      } catch {}

      // 2. PocketBase SDK fallback (APK / Express down)
      if (!raw) {
        try {
          const res = await pb.collection('tournament_config').getList(1, 1, { sort: '-created' });
          raw          = res.items[0] ?? null;
          intermission = raw ? !raw.is_active : false;
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

      // Compute monotonic offset: how far ahead/behind server clock is from device clock
      const offset = serverTime - Date.now();
      if (mounted.current) setServerOffset(offset);

      if (!raw) return;

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
        prize_pool_total: Number(raw.prize_pool_total) || 0,
        winners_count:    Number(raw.winners_count)    || 3,
        reward_structure: rewardStructure,
        banner_url:       bannerUrl,
        week_start:       raw.week_start   || new Date().toISOString(),
        start_time:       raw.start_time   || raw.week_start || new Date().toISOString(),
        end_time:         raw.end_time     || '',
        is_active:        !!raw.is_active,
      };

      // ── Cycle-boundary invalidation (hard gate) ──────────────────────────
      // If the cycle signature changed since we last loaded config — the Sunday
      // freeze (is_active true→false, rows wiped) or the Monday reset (new
      // week_start) — drop the cached registration SYNCHRONOUSLY so the leaderboard
      // can never render with a stale isRegistered=true across the wipe. The very
      // next refreshUserStats re-confirms against the actual row (a surviving
      // intermission pre-registration re-validates true; a wiped row stays false).
      const newSig  = `${cfg.week_start}|${cfg.is_active}`;
      const prevSig = configSigRef.current;
      if (prevSig !== null && prevSig !== newSig && mounted.current) {
        setRegisteredWeek(null);
      }
      configSigRef.current = newSig;

      if (mounted.current) {
        setConfig(cfg);
        setIsIntermission(intermission);
      }
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
      const u = await pb.collection('users').getOne(user.pbId, {
        fields: 'id,tournament_joined,weekly_tournament_points',
      });
      if (mounted.current) {
        setUserJoined(!!u.tournament_joined);
        setUserPoints(Number(u.weekly_tournament_points) || 0);
      }

      // ── REGISTRATION GATE ────────────────────────────────────────────────
      // The AUTHORITATIVE signal is the participant ROW, NOT the tournament_joined
      // flag. The flag could historically be set even when the row create failed
      // (silent .catch), leaving a user "joined" with no row → registration looked
      // bypassed and the DB stayed empty. Rows are wiped weekly, so the existence
      // of any row for this user_id means "registered for the current cycle".
      let participant: any = null;
      try {
        participant = await pb
          .collection('tournament_participants')
          .getFirstListItem(`user_id = "${user.pbId}"`, { sort: '-created' });
      } catch { participant = null; }

      if (mounted.current) setRegisteredWeek(participant?.id ? (participant.week_start ?? '') : null);

      if (participant?.id) {
        // Self-heal: keep the joined flag in lock-step with the row (the leaderboard
        // filter requires tournament_joined=true to include this user).
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
      if (mounted.current) { setUserJoined(false); setRegisteredWeek(null); }
    } finally {
      if (mounted.current) setUserStatsChecked(true);
    }
  }, [user?.pbId]);

  // ── Reset all user-specific state when the logged-in user changes ────────
  useEffect(() => {
    setUserJoined(false);
    setRegisteredWeek(null);
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

      const rewardMap = config?.reward_structure ?? {};
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
  }, [config]);

  // ── Join tournament ──────────────────────────────────────────────────────
  // ORDER MATTERS. The participant ROW is the authoritative proof of registration
  // and is created FIRST (awaited, not fire-and-forget). Only once it exists do we
  // set the tournament_joined flag and mark the user registered. If the row create
  // fails, this THROWS so the caller keeps the lock screen up and shows an error —
  // never the old bug where the flag was set with no row behind it.
  const joinTournament = useCallback(async (duringIntermission = false) => {
    if (!user?.pbId) throw new Error('Not signed in');

    const cycleKey = config?.week_start || new Date().toISOString();

    // 1. Dedupe — reuse any existing row for this user. The server wipes all rows
    //    at the Sunday freeze, so a surviving row is the current registration
    //    (re-tapping REGISTER must never create a duplicate row).
    let existing: any = null;
    try {
      existing = await pb
        .collection('tournament_participants')
        .getFirstListItem(`user_id = "${user.pbId}"`, { sort: '-created' });
    } catch { existing = null; }

    // 2. Create the row (throws on failure → caller handles it).
    if (!existing?.id) {
      const displayName = (user as any).displayName || (user as any).email || 'Miner';
      await pb.collection('tournament_participants').create({
        user_id:                        user.pbId,
        display_name:                   typeof displayName === 'string' ? displayName.split('@')[0] : 'Miner',
        week_start:                     cycleKey,
        joined_at:                      new Date().toISOString(),
        points:                         0,
        registered_during_intermission: duringIntermission,
      });
    }

    // 3. Row confirmed — set the joined flag (controls leaderboard inclusion).
    try { await pb.collection('users').update(user.pbId, { tournament_joined: true }); } catch {}

    if (mounted.current) {
      setRegisteredWeek(cycleKey);
      setUserJoined(true);
    }
  }, [user?.pbId, config?.week_start]);

  // ── Reject tournament (session-only dismiss) ─────────────────────────────
  const rejectTournament = useCallback(async () => {
    if (mounted.current) setHasRejected(true);
  }, []);

  // ── DERIVED registration gate ────────────────────────────────────────────
  // isRegistered is true when a confirmed participant ROW exists for this user.
  // We deliberately use plain row-existence (not a cycle-key match): the server
  // WIPES every participant row at the Sunday freeze, so any surviving row is a
  // genuine registration — including an intermission "pre-register for next week"
  // row, whose week_start intentionally predates the Monday config update.
  // Staleness across the wipe is handled by re-validating on tab focus
  // (refreshUserStats + loadConfig), which nulls registeredWeek once the row is
  // gone — so a wiped user falls back to the lock screen.
  const isRegistered = registeredWeek != null;

  // Popup shows during active tournament OR intermission (pre-register for next week).
  // Gates on userStatsChecked to avoid the race before join-status is confirmed.
  const showPopup = !!(
    (config?.is_active || isIntermission) &&
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
      isIntermission,
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
// server-corrected clock (serverNowMs = Date.now() + serverOffset).
//   - 'none'         no config / no active tournament and not in the weekly gap
//   - 'prestart'     active but not yet started (serverNow < start_time) → "STARTS IN"
//   - 'live'         active and running (start_time <= serverNow < end_time) → "ENDS IN"
//   - 'intermission' weekly gap (is_active=false, Sun 18:00 → Mon 00:00) → "STARTS IN"
export type TournamentPhase = 'none' | 'prestart' | 'live' | 'intermission';

export function getTournamentPhase(
  config: TournamentConfig | null,
  isIntermission: boolean,
  serverNowMs: number,
): TournamentPhase {
  if (isIntermission) return 'intermission';
  if (!config || !config.is_active) return 'none';
  const startMs = config.start_time ? new Date(config.start_time).getTime() : 0;
  if (startMs && serverNowMs < startMs) return 'prestart';
  return 'live';
}
