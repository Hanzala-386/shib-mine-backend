/**
 * TournamentContext — Weekly Tournament state management
 *
 * Fetches tournament_config from PocketBase, tracks user join/reject status,
 * and provides the tournament leaderboard. All operations use PB SDK directly
 * (APK-compatible, no Express dependency).
 */
import React, {
  createContext, useContext, useState, useEffect,
  useCallback, useRef, ReactNode,
} from 'react';
import { pb, POCKETBASE_URL } from '@/lib/pocketbase';
import { useAuth } from './AuthContext';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TournamentConfig {
  id: string;
  prize_pool_total: number;
  winners_count: number;
  reward_structure: Record<string, number>;
  banner_url: string;
  week_start: string;
  is_active: boolean;
}

export interface TournamentEntry {
  rank: number;
  id: string;
  displayName: string;
  points: number;
  prize: number;
}

interface TournamentContextValue {
  config: TournamentConfig | null;
  userJoined: boolean;
  userPoints: number;
  hasRejected: boolean;
  showPopup: boolean;
  leaderboard: TournamentEntry[];
  leaderboardLoading: boolean;
  loadingConfig: boolean;
  joinTournament: () => Promise<void>;
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
  const mounted = useRef(true);

  const [config, setConfig]                     = useState<TournamentConfig | null>(null);
  const [userJoined, setUserJoined]             = useState(false);
  const [userPoints, setUserPoints]             = useState(0);
  const [hasRejected, setHasRejected]           = useState(false);
  const [leaderboard, setLeaderboard]           = useState<TournamentEntry[]>([]);
  const [leaderboardLoading, setLbLoading]      = useState(false);
  const [loadingConfig, setLoadingConfig]       = useState(true);
  // userStatsChecked: true only AFTER refreshUserStats() has confirmed join status.
  // Without this guard, the popup can fire during the async gap between config load
  // and user-stats load — showing for users who have already joined.
  const [userStatsChecked, setUserStatsChecked] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // ── Load tournament config ───────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const res = await pb.collection('tournament_config').getList(1, 1, {
        sort: '-created',
      });
      const raw = res.items[0];
      if (!raw || !mounted.current) return;

      let rewardStructure: Record<string, number> = {};
      try { rewardStructure = JSON.parse(raw.reward_structure || '{}'); } catch {}

      // Build banner URL: prefer the uploaded file field, fall back to legacy banner_url text
      let bannerUrl = '';
      if (raw.banner) {
        const filename = Array.isArray(raw.banner) ? raw.banner[0] : raw.banner;
        if (filename) {
          bannerUrl = `${POCKETBASE_URL}/api/files/tournament_config/${raw.id}/${filename}`;
        }
      }
      if (!bannerUrl && raw.banner_url) bannerUrl = raw.banner_url;

      const cfg: TournamentConfig = {
        id:               raw.id,
        prize_pool_total: Number(raw.prize_pool_total) || 0,
        winners_count:    Number(raw.winners_count)    || 3,
        reward_structure: rewardStructure,
        banner_url:       bannerUrl,
        week_start:       raw.week_start || new Date().toISOString(),
        is_active:        !!raw.is_active,
      };

      if (mounted.current) setConfig(cfg);

      // NOTE: hasRejected is intentionally NOT read from AsyncStorage here.
      // Per spec: the popup must appear every time the user opens the app until
      // they either REGISTER (permanent) or REJECT (session-only dismiss).
      // Persisting the rejection across sessions prevented the popup from ever
      // reappearing after the first rejection — fixed by keeping it in memory only.
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
    } catch {
      // Network error — treat as "not joined" so popup can show
      if (mounted.current) setUserJoined(false);
    } finally {
      // Signal that join-status has been confirmed (or best-effort attempted).
      // showPopup gates on this to avoid the race where popup fires
      // before we know if the user already joined.
      if (mounted.current) setUserStatsChecked(true);
    }
  }, [user?.pbId]);

  // ── Reset all user-specific state immediately when the logged-in user changes ─
  // Without this, stale state from the previous user session (e.g. userJoined=true)
  // suppresses the popup for the new user during the async gap while refreshUserStats
  // is in flight. Resetting synchronously ensures a clean slate before the fetch.
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
        sort: '-weekly_tournament_points',
        filter: 'tournament_joined = true && weekly_tournament_points > 0',
        fields: 'id,display_name,weekly_tournament_points',
      });
      if (!mounted.current) return;

      const rewardMap = config?.reward_structure ?? {};
      const entries: TournamentEntry[] = res.items.map((u: any, i: number) => {
        let name: string = u.display_name || 'Miner';
        if (name.includes('@')) name = name.split('@')[0];
        const rank = i + 1;
        return {
          rank,
          id: u.id,
          displayName: name,
          points: Number(u.weekly_tournament_points) || 0,
          prize: Number(rewardMap[String(rank)]) || 0,
        };
      });
      if (mounted.current) setLeaderboard(entries);
    } catch {} finally {
      if (mounted.current) setLbLoading(false);
    }
  }, [config]);

  // ── Join tournament ──────────────────────────────────────────────────────
  const joinTournament = useCallback(async () => {
    if (!user?.pbId) return;
    await pb.collection('users').update(user.pbId, { tournament_joined: true });
    if (mounted.current) setUserJoined(true);

    // Track participation — non-critical, best-effort
    const displayName = (user as any).displayName || (user as any).email || 'Miner';
    pb.collection('tournament_participants').create({
      user_id:      user.pbId,
      display_name: typeof displayName === 'string' ? displayName.split('@')[0] : 'Miner',
      week_start:   config?.week_start || new Date().toISOString(),
      joined_at:    new Date().toISOString(),
      points:       0,
    }).catch(() => {});
  }, [user?.pbId, config?.week_start]);

  // ── Reject tournament (session-only dismiss) ─────────────────────────────
  // Rejection is stored in-memory only — NOT in AsyncStorage — so the popup
  // re-appears the next time the user opens the app. This matches the spec:
  // "every time the user opens the app, this banner must keep showing up
  //  until they click REGISTER or REJECT."
  const rejectTournament = useCallback(async () => {
    if (mounted.current) setHasRejected(true);
  }, []);

  // Derived: show popup only once ALL async checks have settled.
  // userStatsChecked guards against the race condition where the popup
  // briefly fires before we confirm the user hasn't already joined.
  const showPopup = !!(
    config?.is_active &&
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
