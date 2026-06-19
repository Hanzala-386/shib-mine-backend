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
}

const TournamentContext = createContext<TournamentContextValue>({
  config: null,
  userJoined: false,
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
});

// ── Provider ───────────────────────────────────────────────────────────────

export function TournamentProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const mounted  = useRef(true);

  const [config, setConfig]                     = useState<TournamentConfig | null>(null);
  const [userJoined, setUserJoined]             = useState(false);
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
      // Mirror the authoritative points into the user's OWN participant row so
      // tournament_participants.points stays in sync even if the Express sync route
      // is unreachable in production. Cosmetic field; self-update (updateRule) allows
      // this. One row per user per week (weekly wipe) → match by user_id, latest.
      if (u.tournament_joined) {
        try {
          const participant = await pb
            .collection('tournament_participants')
            .getFirstListItem(`user_id = "${user.pbId}"`, { sort: '-created' });
          const pts = Number(u.weekly_tournament_points) || 0;
          if (participant?.id && Number(participant.points) !== pts) {
            await pb.collection('tournament_participants').update(participant.id, { points: pts });
          }
        } catch { /* no participant row yet / not permitted — non-critical */ }
      }
    } catch {
      if (mounted.current) setUserJoined(false);
    } finally {
      if (mounted.current) setUserStatsChecked(true);
    }
  }, [user?.pbId]);

  // ── Reset all user-specific state when the logged-in user changes ────────
  useEffect(() => {
    setUserJoined(false);
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
  const joinTournament = useCallback(async (duringIntermission = false) => {
    if (!user?.pbId) return;
    await pb.collection('users').update(user.pbId, { tournament_joined: true });
    if (mounted.current) setUserJoined(true);

    const displayName = (user as any).displayName || (user as any).email || 'Miner';
    pb.collection('tournament_participants').create({
      user_id:                      user.pbId,
      display_name:                 typeof displayName === 'string' ? displayName.split('@')[0] : 'Miner',
      week_start:                   config?.week_start || new Date().toISOString(),
      joined_at:                    new Date().toISOString(),
      points:                       0,
      registered_during_intermission: duringIntermission,
    }).catch(() => {});
  }, [user?.pbId, config?.week_start]);

  // ── Reject tournament (session-only dismiss) ─────────────────────────────
  const rejectTournament = useCallback(async () => {
    if (mounted.current) setHasRejected(true);
  }, []);

  // Popup shows during active tournament OR intermission (pre-register for next week).
  // Gates on userStatsChecked to avoid the race before join-status is confirmed.
  const showPopup = !!(
    (config?.is_active || isIntermission) &&
    !userJoined &&
    !hasRejected &&
    !loadingConfig &&
    userStatsChecked &&
    !!user?.pbId
  );

  return (
    <TournamentContext.Provider value={{
      config,
      userJoined,
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
    }}>
      {children}
    </TournamentContext.Provider>
  );
}

export function useTournament() {
  return useContext(TournamentContext);
}
