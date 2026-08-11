/**
 * DECKSHOT UI — the in-game HUD.
 *
 * Owner: lobby-ui-hud.
 *
 * Root is pointer-events: none — the game owns the mouse. Only the death
 * overlay's buttons re-enable pointer events. Nothing sits in the centre of
 * the screen except the crosshair, hitmarker and (briefly) banners.
 */

import { useEffect, useState } from 'react';
import { AdsState, GameMode, RoundPhase, TeamId, WeaponId } from '../../../../shared/types.js';
import { ATTACHMENTS, MAX_HEALTH, WEAPONS } from '../../../../shared/tuning.js';
import { AttachmentId } from '../../../../shared/types.js';
import { describeTrickshot } from '../../../../shared/trickshot.js';
import { Audio } from '../../audio/index.js';
import { useUI, useUICtx } from '../store.js';
import { click, fmtClock } from '../util.js';
import { DamageIndicators } from './DamageIndicators.js';
import { useRoundClock } from './hooks.js';
import { Hitmarker } from './Hitmarker.js';
import { Killfeed, TrickshotBanner } from './Killfeed.js';
import { Scoreboard } from './Scoreboard.js';
import { ZombiesHUD } from './ZombiesHUD.js';

export function HUD(): JSX.Element {
  const local = useUI((s) => s.local);
  const lobby = useUI((s) => s.lobby);
  const { phase } = useRoundClock();
  const [boardOpen, setBoardOpen] = useState(false);
  const isZombies = lobby?.mode === GameMode.Zombies;

  // Tab holds the scoreboard. Key events still fire under pointer lock.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setBoardOpen(true);
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setBoardOpen(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Low-health heartbeat follows the vignette.
  useEffect(() => {
    const intensity = local.alive ? Math.max(0, (60 - local.health) / 60) : 0;
    Audio.setLowHealth(intensity);
    return () => Audio.setLowHealth(0);
  }, [local.health, local.alive]);

  const scoped =
    local.adsState === AdsState.Scoped ||
    (local.adsState === AdsState.Raising && local.adsProgress > 0.5);

  return (
    <div className="ds-hud">
      <Vignette health={local.alive ? local.health : MAX_HEALTH} />
      <TopBar />
      <ScoreBox />
      {/* Canon zombies HUD has no killfeed — the horde has no names. */}
      {!isZombies ? <Killfeed /> : null}
      <TrickshotBanner />
      {local.alive && !scoped && phase !== RoundPhase.Countdown ? <Crosshair /> : null}
      <Hitmarker />
      <DamageIndicators />
      {local.alive ? <HealthBar /> : null}
      {local.alive ? <AmmoBox /> : null}
      {isZombies ? <ZombiesHUD /> : null}
      {phase === RoundPhase.Countdown ? <Countdown /> : null}
      {!local.alive && phase === RoundPhase.Live && !isZombies ? <DeathOverlay /> : null}
      {!local.alive && phase === RoundPhase.Live && isZombies ? <ZombiesDeadNotice /> : null}
      {boardOpen ? <Scoreboard /> : null}
    </div>
  );
}

/** ZOMBIES: no respawn button — you come back when the next round starts. */
function ZombiesDeadNotice(): JSX.Element {
  return (
    <div className="ds-z-downed">
      <div className="line1">DOWN AND OUT</div>
      <div className="line2">You return when the next round begins</div>
    </div>
  );
}

function Crosshair(): JSX.Element {
  return (
    <div className="ds-cross">
      <span className="h l" />
      <span className="h r" />
      <span className="v t" />
      <span className="v b" />
      <span className="dot" />
    </div>
  );
}

function Vignette({ health }: { health: number }): JSX.Element | null {
  const opacity = Math.min(0.85, Math.max(0, (60 - health) / 60));
  if (opacity <= 0) return null;
  return <div className="ds-vignette" style={{ opacity }} />;
}

function TopBar(): JSX.Element {
  const round = useUI((s) => s.round);
  const lobby = useUI((s) => s.lobby);
  const scoreboard = useUI((s) => s.scoreboard);
  const { remaining } = useRoundClock();
  const zombies = useUI((s) => s.zombies);
  const isTdm = lobby?.mode === GameMode.TeamDeathmatch;
  const leaderKills = scoreboard.reduce((m, e) => Math.max(m, e.kills), 0);

  if (lobby?.mode === GameMode.Zombies) {
    return (
      <div className="ds-topbar">
        <span className="ds-limit">ZOMBIES{zombies ? ` — ROUND ${Math.max(1, zombies.round)}` : ''}</span>
      </div>
    );
  }

  return (
    <div className="ds-topbar">
      {isTdm ? (
        <>
          <span className="ds-teamscore alpha">{round.teamScores[TeamId.Alpha - 1] ?? 0}</span>
          <span className={`ds-clock${remaining < 30 && round.phase === RoundPhase.Live ? ' low' : ''}`}>
            {fmtClock(remaining)}
          </span>
          <span className="ds-teamscore bravo">{round.teamScores[TeamId.Bravo - 1] ?? 0}</span>
          <span className="ds-limit">FIRST TO {round.scoreLimit}</span>
        </>
      ) : (
        <>
          <span className={`ds-clock${remaining < 30 && round.phase === RoundPhase.Live ? ' low' : ''}`}>
            {fmtClock(remaining)}
          </span>
          <span className="ds-limit">
            LEAD {leaderKills}/{round.scoreLimit || '—'}
          </span>
        </>
      )}
    </div>
  );
}

function ScoreBox(): JSX.Element {
  const local = useUI((s) => s.local);
  const killPop = useUI((s) => s.killPop);
  return (
    <div className="ds-scorebox">
      <div>
        <span key={killPop} className={`k${killPop > 0 ? ' pop' : ''}`}>
          {local.kills}
        </span>{' '}
        <span className="lbl">kills</span>
      </div>
      <div className="row2">
        {local.score} pts
        {local.streak >= 2 ? (
          <>
            {' '}
            · <span className="ds-streak">streak x{local.streak}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function HealthBar(): JSX.Element {
  const local = useUI((s) => s.local);
  const low = local.health <= 35;
  const pct = Math.max(0, Math.min(100, (local.health / MAX_HEALTH) * 100));
  return (
    <div className={`ds-health ds-hud-text${low ? ' low' : ''}`}>
      <div className="num">{Math.max(0, Math.ceil(local.health))}</div>
      <div className="bar">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AmmoBox(): JSX.Element {
  const local = useUI((s) => s.local);
  const loadout = useUI((s) => s.loadout);
  const spec = WEAPONS[local.weapon];
  const isKnife = local.weapon === WeaponId.Knife;
  const chips =
    local.weapon === loadout.primary
      ? loadout.attachments.filter((a) => a !== AttachmentId.None)
      : [];
  return (
    <div className="ds-ammo ds-hud-text">
      {local.reloading ? <div className="ds-reload">Reloading</div> : null}
      {isKnife ? (
        <div className="mag">—</div>
      ) : (
        <div>
          <span className={`mag${local.ammoInMag === 0 ? ' empty' : ''}`}>{local.ammoInMag}</span>
          <span className="res"> / {local.ammoReserve}</span>
        </div>
      )}
      <div className="wpn">{spec?.name ?? ''}</div>
      {chips.length > 0 ? (
        <div className="chips">
          {chips.map((a) => (
            <span key={a} className="chip">
              {ATTACHMENTS[a]?.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Countdown(): JSX.Element {
  const { remaining } = useRoundClock();
  return (
    <div className="ds-count">
      <div className="n">{Math.max(1, Math.ceil(remaining))}</div>
      <div className="t">Match starting</div>
    </div>
  );
}

function DeathOverlay(): JSX.Element {
  const { store, bridge, setOverlay } = useUICtx();
  const lastDeath = useUI((s) => s.lastDeath);
  const local = useUI((s) => s.local);

  const killerName = lastDeath ? store.nameFor(lastDeath.killerId) : 'the sea';
  const trick = lastDeath ? describeTrickshot(lastDeath.trickshot) : '';
  const weaponName = lastDeath ? (WEAPONS[lastDeath.weapon]?.name ?? '') : '';
  const canDeploy = local.respawnIn <= 0;

  return (
    <div className="ds-death">
      <div className="bars" />
      <div className="card ds-hud-text">
        <div className="by">Killed by</div>
        <div className="killer">{killerName}</div>
        {lastDeath ? (
          <div className="how">
            {weaponName}
            {lastDeath.distance > 0 ? ` · ${Math.round(lastDeath.distance)}m` : ''}
          </div>
        ) : null}
        {trick ? <div className="trick">{trick}</div> : null}
        <div className="timer">{canDeploy ? 'GO' : Math.ceil(local.respawnIn)}</div>
        <div className="hint">{canDeploy ? 'Fire to deploy' : 'Respawning'}</div>
        <div className="ds-row" style={{ justifyContent: 'center' }}>
          {canDeploy ? (
            <button
              className="ds-btn primary"
              onClick={() => {
                click();
                bridge.requestRespawn();
              }}
            >
              Deploy
            </button>
          ) : null}
          <button
            className="ds-btn ghost"
            onClick={() => {
              click();
              setOverlay('loadout');
            }}
          >
            Loadout
          </button>
        </div>
      </div>
    </div>
  );
}
