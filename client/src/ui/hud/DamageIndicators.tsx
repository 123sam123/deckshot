/**
 * DECKSHOT UI — damage direction indicators.
 *
 * Owner: lobby-ui-hud.
 *
 * Each hit flashes a red arc on a ring around the crosshair, rotated to the
 * attacker's direction relative to the camera (0 = ahead, clockwise). The
 * game loop supplies the angle via UIHandle.showDamageFrom.
 */

import { useUI } from '../store.js';
import { useNow } from './hooks.js';

const MARK_TTL_MS = 900;

export function DamageIndicators(): JSX.Element {
  const marks = useUI((s) => s.damage);
  const now = useNow(200);
  const live = marks.filter((m) => now - m.at < MARK_TTL_MS);
  return (
    <div className="ds-dmg">
      {live.map((m) => (
        <svg
          key={m.key}
          className="arc"
          viewBox="0 0 120 120"
          style={{ transform: `rotate(${m.angle}rad)` }}
        >
          <path
            d="M 38 20 A 46 46 0 0 1 82 20"
            fill="none"
            stroke="rgba(255, 60, 70, 0.95)"
            strokeWidth="7"
            strokeLinecap="round"
          />
        </svg>
      ))}
    </div>
  );
}
