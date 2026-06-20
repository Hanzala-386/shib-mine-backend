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

// ── Cycle helpers ────────────────────────────────────────────────────────────
// Normalize any ISO timestamp to the UTC date (YYYY-MM-DD) of THAT week's Monday.
// This is the per-cycle "bucket". The server stamps week_start/start_time with a
// precise timestamp at every Monday reset, so exact string equality is fragile —
// bucketing to the week's Monday makes a participant row's cycle comparable to the
// active config's cycle regardless of sub-second/scheduling differences, and also
// folds a mid-week admin start into the same ISO-week bucket.
function cycleBucket(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day  = d.getUTCDay();           // 0=Sun … 1=Mon
  const back = day === 0 ? 6 : day - 1; // days since Monday
  const mon  = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
  return mon.toISOString().slice(0, 10);
}

// ISO for the upcoming Monday 00:00 UTC — the cycle a user pre-registers INTO
// during the Sunday→Monday intermission gap. Its bucket equals the bucket the
// server writes at the Monday reset, so an intermission pre-registration carries
// seamlessly into the new active week. Takes a SERVER-corrected `nowMs`
// (Date.now() + serverOffset) — never the raw device clock — so a skewed/manual
// device clock cannot target the wrong Monday and mis-gate registration.
function nextMondayIso(nowMs: number): string {
  const now = new Date(nowMs);
  const day = now.getUTCDay();
  const daysUntil = day === 1 ? 0 : (8 - day) % 7;
  const cand = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil, 0, 0, 0, 0,
  ));
  if (cand.getTime() <= now.getTime()) cand.setUTCDate(cand.getUTCDate() + 7);
  return cand.toISOString();
}

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
  // Always-current mirrors of config + intermission. They let the STABLE
  // (deps-free) refreshLeaderboard / refreshUserStats callbacks read the latest
  // cycle WITHOUT taking `config` as a dependency. Taking `config` churned those
  // callbacks' identity on every config refresh, which churned refreshTournament,
  // which re-fired the leaderboard screen's effects → the infinite refresh loop.
  // Kept in lock-step with state synchronously inside loadConfig.
  const configRef         = useRef<TournamentConfig | null>(null);
  const isIntermissionRef = useRef(false);
  // Mirror of the committed serverOffset so the STABLE callbacks can derive the
  // intermission cycle from SERVER-corrected time without depending on the state.
  const serverOffsetRef   = useRef(0);

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

      // Compute monotonic offset: how far ahead/behind server clock is from device
      // clock. Only commit when it shifts meaningfully (>1.5s) — recomputing every
      // refresh (Date.now keeps advancing) would needlessly churn serverOffset and
      // re-fire the leaderboard screen's boundary effects that depend on it. The ref
      // is the source of truth and mirrors the committed state in lock-step, so the
      // stable callbacks derive the intermission cycle from server-corrected time.
      const offset = serverTime - Date.now();
      if (Math.abs(offset - serverOffsetRef.current) > 1500) {
        serverOffsetRef.current = offset;
        if (mounted.current) setServerOffset(offset);
      }

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

      // Keep the latest-value refs in lock-step with state so the STABLE
      // refreshLeaderboard / refreshUserStats callbacks always read the current
      // cycle. No separate signature gate is needed: per-cycle registration
      // matching (see isRegistered) makes a leftover row from a previous cycle
      // fail to unlock the board DECLARATIVELY the instant fresh config loads.
      configRef.current         = cfg;
      isIntermissionRef.current = intermission;

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

      // ── REGISTRATION GATE (per-cycle) ────────────────────────────────────
      // The AUTHORITATIVE signal is the participant ROW, NOT the tournament_joined
      // flag. But a row ONLY counts for the CURRENT cycle: its week_start bucket
      // must match the active week (or, during intermission, the upcoming week the
      // user pre-registers into). A leftover row from a PAST tournament keeps a
      // non-matching bucket → its week_start is still stored (so re-tapping JOIN
      // de-dupes onto it) but isRegistered (derived) stays false → the poster
      // re-appears instead of silently unlocking the board on stale data.
      let participant: any = null;
      try {
        participant = await pb
          .collection('tournament_participants')
          .getFirstListItem(`user_id = "${user.pbId}"`, { sort: '-created' });
      } catch { participant = null; }

      const rowWeek         = participant?.id ? (participant.week_start ?? '') : null;
      const currentCycleIso = isIntermissionRef.current
        ? nextMondayIso(Date.now() + serverOffsetRef.current)
        : (configRef.current?.start_time || configRef.current?.week_start || '');
      const currentBucket   = cycleBucket(currentCycleIso);
      const matchesCurrent  = !!rowWeek && !!currentBucket && cycleBucket(rowWeek) === currentBucket;

      if (mounted.current) setRegisteredWeek(rowWeek);

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
  const joinTournament = useCallback(async (duringIntermission = false) => {
    if (!user?.pbId) throw new Error('Not signed in');

    // Target cycle to register INTO, written as week_start so the per-cycle match
    // in isRegistered unlocks the board: the UPCOMING week during intermission,
    // otherwise the active cycle. Bucketed comparison tolerates the server's
    // precise per-Monday timestamp, and the intermission target's bucket equals the
    // one the server stamps at the Monday reset → seamless carry-over.
    const intermitting = duringIntermission || isIntermission;
    const targetIso = intermitting
      ? nextMondayIso(Date.now() + serverOffsetRef.current)
      : (config?.start_time || config?.week_start || new Date().toISOString());
    const targetBucket = cycleBucket(targetIso);

    // Dedupe by user. A surviving row from a PAST cycle is RE-POINTED at the
    // current cycle (update week_start) rather than left stale or duplicated, so a
    // returning user who taps JOIN for the new week registers cleanly.
    let existing: any = null;
    try {
      existing = await pb
        .collection('tournament_participants')
        .getFirstListItem(`user_id = "${user.pbId}"`, { sort: '-created' });
    } catch { existing = null; }

    if (existing?.id) {
      if (cycleBucket(existing.week_start ?? '') !== targetBucket) {
        await pb.collection('tournament_participants').update(existing.id, {
          week_start:                     targetIso,
          joined_at:                      new Date().toISOString(),
          registered_during_intermission: intermitting,
        });
      }
    } else {
      // Create the row (throws on failure → caller keeps the lock up + shows error).
      const displayName = (user as any).displayName || (user as any).email || 'Miner';
      await pb.collection('tournament_participants').create({
        user_id:                        user.pbId,
        display_name:                   typeof displayName === 'string' ? displayName.split('@')[0] : 'Miner',
        week_start:                     targetIso,
        joined_at:                      new Date().toISOString(),
        points:                         0,
        registered_during_intermission: intermitting,
      });
    }

    // Row confirmed — set the joined flag (controls leaderboard inclusion).
    try { await pb.collection('users').update(user.pbId, { tournament_joined: true }); } catch {}

    if (mounted.current) {
      setRegisteredWeek(targetIso);
      setUserJoined(true);
    }
  }, [user?.pbId, config?.start_time, config?.week_start, isIntermission]);

  // ── Reject tournament (session-only dismiss) ─────────────────────────────
  const rejectTournament = useCallback(async () => {
    if (mounted.current) setHasRejected(true);
  }, []);

  // ── DERIVED per-cycle registration gate ──────────────────────────────────
  // A participant row only unlocks the leaderboard when its week_start bucket
  // matches the CURRENT cycle — the active week, or (during the Sun→Mon
  // intermission) the upcoming week the user pre-registers into. Bucketing to the
  // week's Monday (cycleBucket) tolerates the server's precise per-Monday
  // timestamp. A leftover row from a PAST tournament therefore fails to register
  // the user for the new cycle → the registration poster shows again. This is
  // fully declarative: it re-derives the instant fresh config loads, with no
  // stale-render window and no separate cycle-signature gate.
  const registrationCycleIso = isIntermission
    ? nextMondayIso(Date.now() + serverOffset)
    : (config?.start_time || config?.week_start || '');
  const currentCycleBucket = cycleBucket(registrationCycleIso);
  const isRegistered = !!registeredWeek
    && !!currentCycleBucket
    && cycleBucket(registeredWeek) === currentCycleBucket;

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
