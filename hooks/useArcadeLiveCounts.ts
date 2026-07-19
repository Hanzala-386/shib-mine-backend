/* Short-polling hook for arcade live player counts (searching + playing).
 * Polls GET /api/app/arcade/live-counts every 5s while the screen is mounted
 * and the app is foregrounded — 12 req/min per user, far under the 60s/240
 * rate-limit window, and the endpoint is a pure in-memory Map snapshot on the
 * server (no DB). Silent-fails and keeps the last good snapshot so a dropped
 * poll never blanks the UI. */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, type ArcadeLiveCounts } from '@/lib/api';

const POLL_MS = 5000;

export function useArcadeLiveCounts(): ArcadeLiveCounts {
  const [counts, setCounts] = useState<ArcadeLiveCounts>({ games: {}, rooms: {} });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    const tick = async () => {
      if (inFlight || AppState.currentState !== 'active') return;
      inFlight = true;
      try {
        const c = await api.getArcadeLiveCounts();
        if (mounted.current && c && typeof c === 'object') {
          setCounts({ games: c.games ?? {}, rooms: c.rooms ?? {} });
        }
      } catch {
        // keep last snapshot — a missed poll is invisible to the user
      } finally {
        inFlight = false;
      }
    };

    tick();
    timer = setInterval(tick, POLL_MS);
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  return counts;
}
