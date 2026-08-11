/**
 * DECKSHOT — ZOMBIES HUD layer.
 *
 * Owner: zombies (full rewrite; replaces the deleted SurvivalHUD).
 *
 * Rendered on top of the standard HUD when the lobby mode is Zombies:
 * the round counter (with Blood Fog dress), the points balance and its
 * floating +/- deltas, perk and forge chips, active power-up pills, the
 * contextual interact prompt, the downed/bleedout banner, the revive
 * progress ring and squadmate down callouts.
 */

import { useEffect, useRef, useState } from 'react';
import type { ZombiesStateMsg } from '../../../../shared/protocol.js';
import {
  BLEEDOUT_TIME,
  PERK_NAMES,
  POWERUP_NAMES,
  PerkId,
  PowerupId,
  ZombiesPhase,
  hasPerk,
  isFogRound,
} from '../../../../shared/zombies.js';
import { newKey, useUI } from '../store.js';
import { useNow } from './hooks.js';

const PERK_ORDER: PerkId[] = [
  PerkId.Bulwark,
  PerkId.Handloader,
  PerkId.SecondWind,
  PerkId.Adrenaline,
  PerkId.HairTrigger,
];

interface PointsDelta {
  key: number;
  delta: number;
}

/** Floating popups kept at most this long; animationend prunes sooner. */
const MAX_DELTAS = 6;

export function ZombiesHUD(): JSX.Element | null {
  const zombies: ZombiesStateMsg | null = useUI((s) => s.zombies);
  const prompt: string | null = useUI((s) => s.zombiesPrompt);
  const downedNames: string[] = useUI((s) => s.zombiesDowned);
  const local = useUI((s) => s.local);
  const lobby = useUI((s) => s.lobby);
  useNow(250); // keeps the intermission countdown and power-up timers moving

  // Floating "+N"/"−N" popups: diff points against the previous message.
  const points = zombies ? zombies.points : null;
  const prevPoints = useRef<number | null>(null);
  const [deltas, setDeltas] = useState<PointsDelta[]>([]);
  useEffect(() => {
    if (points === null) {
      prevPoints.current = null; // match ended: don't diff across sessions
      return;
    }
    const prev = prevPoints.current;
    prevPoints.current = points;
    if (prev === null || points === prev) return;
    setDeltas((d) => [...d.slice(-(MAX_DELTAS - 1)), { key: newKey(), delta: points - prev }]);
  }, [points]);

  if (!zombies) return null;

  const downed = local.downed === true;
  const fog = isFogRound(zombies.round);
  const intermission = zombies.phase === ZombiesPhase.Intermission;
  const solo = (lobby?.players.length ?? 1) <= 1;
  const forgedHeld = (zombies.forged & (1 << zombies.held)) !== 0;

  return (
    <>
      {/* Bottom-left stack: perks over points over the big round number. */}
      <div className="ds-z-left">
        <div className="ds-z-perks">
          {PERK_ORDER.filter((p) => hasPerk(zombies.perks, p)).map((p) => (
            <span key={p} className={`chip p${p}`}>
              {PERK_NAMES[p]}
            </span>
          ))}
          {forgedHeld ? <span className="chip forged">FORGED</span> : null}
        </div>

        <div className="ds-z-points">
          {zombies.points.toLocaleString()}
          {deltas.map((d) => (
            <span
              key={d.key}
              className={`delta${d.delta < 0 ? ' neg' : ''}`}
              onAnimationEnd={() => setDeltas((list) => list.filter((x) => x.key !== d.key))}
            >
              {d.delta > 0
                ? `+${d.delta.toLocaleString()}`
                : `−${Math.abs(d.delta).toLocaleString()}`}
            </span>
          ))}
        </div>

        <div className={`ds-z-round${fog ? ' fog' : ''}`}>
          {/* Keyed on the round so the pop animation re-runs each round. */}
          <div key={zombies.round} className="num">
            {Math.max(1, zombies.round)}
          </div>
          {fog ? <div className="fogtag">BLOOD FOG</div> : null}
          {intermission ? (
            <div className="wave">
              ROUND {zombies.round + 1} IN {Math.ceil(zombies.timeRemaining)}s
            </div>
          ) : (
            <div className="wave">{zombies.zombiesRemaining} LEFT</div>
          )}
          {!zombies.powerOn ? <div className="power">POWER OFF</div> : null}
        </div>
      </div>

      {/* Active squad-wide power-ups, centre-top under the topbar. */}
      {zombies.effects.length > 0 ? (
        <div className="ds-z-effects">
          {zombies.effects.map(([kind, remaining]) => (
            <span key={kind} className={`fx${remaining < 5 ? ' low' : ''}`}>
              {POWERUP_NAMES[kind as PowerupId] ?? '?'} {Math.ceil(remaining)}s
            </span>
          ))}
        </div>
      ) : null}

      {/* Squadmates currently down. */}
      {downedNames.length > 0 ? (
        <div className="ds-z-callouts">
          {downedNames.map((name) => (
            <span key={name} className="callout">
              {name.toUpperCase()} IS DOWN
            </span>
          ))}
        </div>
      ) : null}

      {/* Contextual buy / interact prompt (formatted upstream). */}
      {prompt && !downed ? <div className="ds-z-prompt">{prompt}</div> : null}

      {/* Revive progress ring while the recipient is reviving someone. */}
      {zombies.reviveProgress > 0 ? <ReviveRing progress={zombies.reviveProgress} /> : null}

      {/* Downed: full-width banner with the draining bleedout bar. */}
      {downed ? <DownedBanner zombies={zombies} solo={solo} /> : null}
    </>
  );
}

function ReviveRing({ progress }: { progress: number }): JSX.Element {
  const r = 26;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <div className="ds-z-revive">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle className="track" cx="36" cy="36" r={r} fill="none" strokeWidth="5" />
        <circle
          className="arc"
          cx="36"
          cy="36"
          r={r}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          transform="rotate(-90 36 36)"
        />
      </svg>
      <div className="lbl">REVIVING…</div>
    </div>
  );
}

function DownedBanner({ zombies, solo }: { zombies: ZombiesStateMsg; solo: boolean }): JSX.Element {
  const frac = Math.max(0, Math.min(1, zombies.bleedout / BLEEDOUT_TIME));
  return (
    <div className="ds-z-downed">
      <div className="line1">YOU&rsquo;RE DOWN — FIGHT FOR YOUR LIFE</div>
      <div className="bleed">
        <div className="fill" style={{ width: `${frac * 100}%` }} />
      </div>
      {zombies.beingRevived ? <div className="line2">A TEAMMATE IS ON THE WAY</div> : null}
      {solo && zombies.selfRevives > 0 ? (
        <div className="line2 wind">SECOND WIND: {zombies.selfRevives} LEFT</div>
      ) : null}
    </div>
  );
}
