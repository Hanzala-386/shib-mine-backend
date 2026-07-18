/* ────────────────────────────────────────────────────────────────────────────
 * Game History — cosmetic per-event feed backing the read-only Game History
 * screen. Rows live in the PB `game_history` collection (created server-side
 * on boot; rules: list/view/create/delete scoped to the owning user, update
 * locked). The screen shows ONLY multiplayer match results (win/loss/draw),
 * kept as a rolling window of the newest 100 rows — after each new row the
 * client prunes its own older rows. Writes are FIRE-AND-FORGET: history
 * logging must never block or fail a money flow, and no money logic ever
 * reads this data.
 * ──────────────────────────────────────────────────────────────────────────── */

import { pb } from '@/lib/pocketbase';

export type GameHistoryOutcome = 'win' | 'loss' | 'draw' | 'redeem';

export interface GameHistoryRecord {
  id: string;
  game: string;
  outcome: GameHistoryOutcome;
  tickets_won: number;
  tokens_lost: number;
  pt_won: number;
  shib_won: number;
  created: string;
}

/** gameId → display name (arcade hub games + solo). */
export const GAME_DISPLAY_NAMES: Record<string, string> = {
  flappy: 'Flappy Bounce',
  fruitcut: 'Fruit Cut',
  stack: 'Tower Stack',
  '2048': '2048',
  iceblock: 'Ice Block',
  color: 'Color Rush',
};

export function gameDisplayName(gameId: string): string {
  return GAME_DISPLAY_NAMES[gameId] ?? gameId;
}

export const HISTORY_WINDOW = 100;

/** PB filter for multiplayer match rows only (excludes legacy solo/redeem rows). */
function matchFilter(pbId: string): string {
  return `user = "${pbId}" && outcome != "redeem" && game != "Knife Hit"`;
}

/**
 * Rolling-window prune: delete this user's match rows beyond the newest 100.
 * Fire-and-forget; requires the self-scoped deleteRule on game_history.
 */
function pruneGameHistory(pbId: string): void {
  pb.collection('game_history')
    .getList(2, HISTORY_WINDOW, {
      filter: matchFilter(pbId),
      sort: '-created',
      requestKey: null,
    })
    .then((res) =>
      Promise.allSettled(
        res.items.map((r: any) =>
          pb.collection('game_history').delete(r.id, { requestKey: null })
        )
      )
    )
    .catch(() => {});
}

/**
 * Append one history row for the signed-in user, then prune the rolling
 * window. Fire-and-forget: swallows every error (offline, missing collection,
 * auth expiry) — the surrounding game flow must never be affected by history
 * logging.
 */
export function logGameHistory(entry: {
  game: string;
  outcome: GameHistoryOutcome;
  ticketsWon?: number;
  tokensLost?: number;
  ptWon?: number;
  shibWon?: number;
}): void {
  try {
    const pbId = pb.authStore.record?.id || (pb.authStore as any).model?.id;
    if (!pbId) return;
    pb.collection('game_history').create({
      user: pbId,
      game: entry.game,
      outcome: entry.outcome,
      tickets_won: Math.max(0, Math.floor(entry.ticketsWon ?? 0)),
      tokens_lost: Math.max(0, Math.floor(entry.tokensLost ?? 0)),
      pt_won: Math.max(0, Math.floor(entry.ptWon ?? 0)),
      shib_won: Math.max(0, entry.shibWon ?? 0),
    }, { requestKey: null })
      .then(() => pruneGameHistory(pbId))
      .catch(() => {});
  } catch {}
}

/** Newest-first multiplayer match history (read-only screen data, max 100). */
export async function fetchGameHistory(pbId: string, limit = HISTORY_WINDOW): Promise<GameHistoryRecord[]> {
  const res = await pb.collection('game_history').getList(1, limit, {
    filter: matchFilter(pbId),
    sort: '-created',
    requestKey: null,
  });
  return res.items.map((r: any) => ({
    id: r.id,
    game: String(r.game || ''),
    outcome: (r.outcome || 'win') as GameHistoryOutcome,
    tickets_won: Number(r.tickets_won) || 0,
    tokens_lost: Number(r.tokens_lost) || 0,
    pt_won: Number(r.pt_won) || 0,
    shib_won: Number(r.shib_won) || 0,
    created: String(r.created || ''),
  }));
}
