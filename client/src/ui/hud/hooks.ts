/**
 * DECKSHOT UI — HUD hooks.
 * Owner: lobby-ui-hud.
 */

import { useEffect, useState } from 'react';
import { RoundPhase } from '../../../../shared/types.js';
import { useUI } from '../store.js';

/** A coarse clock for expiring feed items / running timers. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(performance.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Seconds remaining in the current phase, extrapolated between updates. */
export function useRoundClock(): { phase: RoundPhase; remaining: number } {
  const round = useUI((s) => s.round);
  const roundAt = useUI((s) => s.roundAt);
  const now = useNow(200);
  const elapsed = roundAt > 0 ? (now - roundAt) / 1000 : 0;
  return { phase: round.phase, remaining: Math.max(0, round.timeRemaining - elapsed) };
}
