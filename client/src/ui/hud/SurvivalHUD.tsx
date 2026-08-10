/**
 * DECKSHOT — SURVIVAL HUD layer.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * Rendered on top of the standard HUD when the lobby mode is Survival:
 * the round counter, points balance, perks, power-ups, the intermission
 * countdown, the contextual buy prompt and the last-stand overlay.
 */

import { useUI, useUICtx } from '../store.js';
import { useNow } from './hooks.js';
import {
  PERK_NAMES,
  POWERUP_NAMES,
  PerkId,
  PowerupId,
  SurvivalPhase,
  hasPerk,
} from '../../../../shared/survival.js';

const PERK_ORDER: PerkId[] = [
  PerkId.Deadeye,
  PerkId.Quickhands,
  PerkId.Doubletap,
  PerkId.Corpsman,
  PerkId.SteadyHand,
];

export function SurvivalHUD(): JSX.Element | null {
  const survival = useUI((s) => s.survival);
  const prompt = useUI((s) => s.survivalPrompt);
  const local = useUI((s) => s.local);
  const { store } = useUICtx();
  useNow(250); // keeps the intermission countdown and power-up timers moving
  if (!survival) return null;

  const downed = local.downed === true;
  const intermission = survival.phase === SurvivalPhase.Intermission;

  return (
    <>
      {/* Round + horde counter, anchored bottom-left above the health bar. */}
      <div className="ds-srv-round">
        <div className="num">{Math.max(1, survival.round)}</div>
        <div className="meta">
          {intermission ? (
            <span className="wave">ROUND {survival.round + 1} IN {Math.ceil(survival.timeRemaining)}</span>
          ) : (
            <span className="wave">{survival.zombiesRemaining} IN THE WATER</span>
          )}
          {!survival.powerOn ? <span className="power">POWER OFF</span> : null}
        </div>
      </div>

      {/* Points, big and always visible: the whole mode is this number. */}
      <div className="ds-srv-points">{survival.yourPoints.toLocaleString()}</div>

      {/* Perk chips. */}
      <div className="ds-srv-perks">
        {PERK_ORDER.filter((p) => hasPerk(survival.yourPerks, p)).map((p) => (
          <span key={p} className="chip">
            {PERK_NAMES[p]}
          </span>
        ))}
        {survival.yourForged ? <span className="chip forged">FORGED</span> : null}
      </div>

      {/* Active power-ups, centre-top. */}
      {survival.powerups.length > 0 ? (
        <div className="ds-srv-powerups">
          {survival.powerups.map(([kind, remaining]) => (
            <span key={kind} className="pow">
              {POWERUP_NAMES[(kind as PowerupId) ?? PowerupId.MaxAmmo] ?? '?'}{' '}
              {Math.ceil(remaining)}s
            </span>
          ))}
        </div>
      ) : null}

      {/* Contextual buy / interact prompt. */}
      {prompt && !downed ? <div className="ds-srv-prompt">{prompt}</div> : null}

      {/* Last stand. */}
      {downed ? (
        <div className="ds-srv-downed">
          <div className="line1">YOU ARE DOWN</div>
          <div className="line2">
            {survival.yourBleedout > 0
              ? `Bleeding out — ${Math.ceil(survival.yourBleedout)}s`
              : 'Hold on…'}
          </div>
          <div className="line3">{squadHint(store.state.scoreboard.length)}</div>
        </div>
      ) : null}
    </>
  );
}

function squadHint(squadSize: number): string {
  return squadSize > 0 ? 'A teammate can revive you — crawl to them' : 'Fight with the pistol';
}
