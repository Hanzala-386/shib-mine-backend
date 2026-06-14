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
import AsyncStorage from '@react-native-async-storage/async-storage';
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

      // Check local rejection flag for THIS week
      const key = `tournament_rejected_${cfg.week_start}`;
      const rejected = await AsyncStorage.getItem(key);
      if (mounted.current) setHasRejected(rejected === 'true');
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
    } catch {}
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
  }, [user?.pbId]);

  // ── Reject tournament for this week ─────────────────────────────────────
  const rejectTournament = useCallback(async () => {
    if (!config) return;
    const key = `tournament_rejected_${config.week_start}`;
    await AsyncStorage.setItem(key, 'true').catch(() => {});
    if (mounted.current) setHasRejected(true);
  }, [config]);

  // Derived: show popup only when all conditions met
  const showPopup = !!(
    config?.is_active &&
    !userJoined &&
    !hasRejected &&
    !loadingConfig &&
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
