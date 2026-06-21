/**
 * tournamentHistory — read-only helpers for the LAST finalized tournament cycle.
 *
 * Source: the public `tournament_history` PocketBase collection (listRule = '',
 * so the published APK can read it directly without Express). Each cycle's
 * finalize writes one row per winner with: week_end, rank, user_id,
 * display_name, points, prize.
 *
 * Robustness note — the finalize can run more than once for the same cycle
 * (concurrent run / reconciler retry), producing DUPLICATE history rows whose
 * `week_end` timestamps differ by a few milliseconds. We therefore reconstruct
 * the standings by clustering rows on their `created` time (manual cycles are
 * days apart, retries are milliseconds apart) and deduping by rank — never by
 * assuming a single unique week_end per cycle.
 */
import { pb } from '@/lib/pocketbase';

export interface HistoryStanding {
  rank: number;
  id: string;            // user_id of the winner
  displayName: string;
  points: number;
  prize: number;         // SHIB awarded for this rank (already auto-credited server-side)
  avatarUrl?: string;    // none persisted in history → TAvatar falls back to initials
}

export interface LastCycleResult {
  /** Stable identifier for the most recent finalized cycle ('' if none yet). */
  cycleKey: string;
  standings: HistoryStanding[];
}

// Window that groups rows belonging to the SAME finalize event. Generous enough
// to absorb retries (ms–seconds apart) yet far below the spacing between manual
// cycles (days/weeks), so it can never merge two distinct tournaments.
const CLUSTER_WINDOW_MS = 30 * 60 * 1000;

// Grace subtracted from the just-ended cycle's end_time when deciding whether the
// newest history belongs to THAT cycle. Absorbs minor clock skew between the
// admin-set end_time and the server's finalize timestamp. Far smaller than the
// gap between two cycles, so a previous cycle's history never passes the cutoff.
const STALE_GRACE_MS = 10 * 60 * 1000;

/**
 * @param sinceIso  Optional end_time of the cycle that just ended. When given, the
 *   newest history row must have been written at/after (sinceIso − grace) for the
 *   standings to be returned. This guards the brief window where the server has
 *   flipped is_active=false (→ phase 'none') but has NOT yet written this cycle's
 *   history rows — without it we'd surface the PREVIOUS cycle's stale standings.
 *   Omit it (no cutoff) when there is no current cycle context (e.g. config===null).
 */
export async function fetchLastCycleStandings(sinceIso?: string): Promise<LastCycleResult> {
  try {
    const res = await pb.collection('tournament_history').getList(1, 200, {
      sort: '-created',
      fields: 'id,created,week_end,rank,user_id,display_name,points,prize',
    });
    const items: any[] = res.items || [];
    if (!items.length) return { cycleKey: '', standings: [] };

    // The newest row anchors the most recently finalized cycle.
    const t0 = new Date(items[0].created).getTime();

    // Stale-cycle guard: if the newest history predates the cycle that just ended,
    // history for it hasn't been exported yet → report "no results" so the UI keeps
    // showing the loading/inactive placeholder instead of a wrong cycle's board.
    if (sinceIso) {
      const cutoff = new Date(sinceIso).getTime() - STALE_GRACE_MS;
      if (isFinite(cutoff) && isFinite(t0) && t0 < cutoff) {
        return { cycleKey: '', standings: [] };
      }
    }

    // Keep only rows from the same finalize cluster as the newest row.
    const cluster = items.filter((h) => {
      const t = new Date(h.created).getTime();
      return isFinite(t) && t0 - t <= CLUSTER_WINDOW_MS;
    });

    // Stable per-cycle key = EARLIEST `created` in the cluster (the first finalize
    // write). Retries only APPEND later rows, so the earliest never shifts — this
    // keeps the popup's one-time dismissal key stable even when a duplicate
    // finalize lands after the user already dismissed it. (Using the NEWEST row
    // would change the key whenever a retry appended, re-showing the popup.)
    const clusterCreated = cluster
      .map((h) => String(h.created || ''))
      .filter(Boolean)
      .sort(); // ISO-8601 UTC sorts lexicographically == chronologically
    const cycleKey = clusterCreated[0] || String(items[0].week_end || items[0].id);

    // Dedupe by rank — first occurrence wins (already sorted -created → newest).
    const byRank = new Map<number, any>();
    for (const h of cluster) {
      const rank = Number(h.rank) || 0;
      if (rank <= 0) continue;
      if (!byRank.has(rank)) byRank.set(rank, h);
    }

    const standings: HistoryStanding[] = Array.from(byRank.values())
      .map((h) => {
        let name: string = h.display_name || 'Miner';
        if (name.includes('@')) name = name.split('@')[0];
        return {
          rank: Number(h.rank) || 0,
          id: h.user_id || '',
          displayName: name,
          points: Number(h.points) || 0,
          prize: Number(h.prize) || 0,
        };
      })
      .sort((a, b) => a.rank - b.rank);

    return { cycleKey, standings };
  } catch {
    return { cycleKey: '', standings: [] };
  }
}

/**
 * Resolve whether `pbId` won SHIB in the most recently finalized cycle.
 * Returns the win details + the stable cycleKey (used to persist a one-time
 * dismissal), or null when the user did not win a prize in that cycle.
 */
export async function fetchMyLastCycleWin(
  pbId: string,
): Promise<{ cycleKey: string; rank: number; prize: number; displayName: string } | null> {
  if (!pbId) return null;
  const { cycleKey, standings } = await fetchLastCycleStandings();
  if (!cycleKey || !standings.length) return null;
  const mine = standings.find((s) => s.id === pbId);
  if (!mine || mine.prize <= 0) return null;
  return { cycleKey, rank: mine.rank, prize: mine.prize, displayName: mine.displayName };
}
