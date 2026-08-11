/**
 * DECKSHOT UI — end-of-match screen.
 *
 * Owner: lobby-ui-hud.
 *
 * Winner, final scoreboard, and the match's single best trickshot replayed
 * as a gold banner with its score.
 */

import { describeTrickshot } from '../../../../shared/trickshot.js';
import { GameMode, TeamId } from '../../../../shared/types.js';
import { useUI, useUICtx } from '../store.js';
import { Scoreboard } from '../hud/Scoreboard.js';
import { useRoundClock } from '../hud/hooks.js';
import { click } from '../util.js';

export function MatchOverScreen(): JSX.Element | null {
  const { store, bridge } = useUICtx();
  const over = useUI((s) => s.matchOver);
  const lobby = useUI((s) => s.lobby);
  const zombiesRound = useUI((s) => s.zombies?.round ?? 0);
  const { remaining } = useRoundClock();
  if (!over) return null;

  const isTdm = lobby?.mode === GameMode.TeamDeathmatch;
  const isZombies = lobby?.mode === GameMode.Zombies;
  let winnerText: string;
  let winnerClass = '';
  if (isZombies) {
    const round = Math.max(1, zombiesRound);
    winnerText = `THE YARD KEEPS YOU — ROUND ${round}`;
    winnerClass = 'bravo';
  } else if (isTdm) {
    if (over.winnerTeam === TeamId.Alpha) {
      winnerText = 'ALPHA WINS';
      winnerClass = 'alpha';
    } else if (over.winnerTeam === TeamId.Bravo) {
      winnerText = 'BRAVO WINS';
      winnerClass = 'bravo';
    } else {
      winnerText = 'DRAW';
    }
  } else {
    winnerText = `${store.nameFor(over.winnerId).toUpperCase()} WINS`;
  }

  const best = over.bestTrickshot;

  return (
    <div className="ds-overlay" style={{ zIndex: 45 }}>
      <div className="ds-panel" style={{ width: 'min(720px, 96vw)' }}>
        <h2 className={`ds-over-winner ${winnerClass}`}>{winnerText}</h2>

        {best && best.trickshot !== 0 ? (
          <div className="ds-over-best">
            <div className="lbl">Trickshot of the match</div>
            <div className="txt">{describeTrickshot(best.trickshot)}</div>
            <div className="who">
              {store.nameFor(best.killerId)} · +{best.score}
              {best.distance > 0 ? ` · ${Math.round(best.distance)}m` : ''}
            </div>
          </div>
        ) : null}

        <Scoreboard title="Final standings" inline />

        <div className="ds-row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <span className="ds-code-hint">Back to lobby in {Math.ceil(remaining)}s</span>
          <button
            className="ds-btn ghost danger"
            onClick={() => {
              click();
              store.patch({ lobby: null, matchOver: null, pending: null });
              bridge.leaveLobby();
            }}
          >
            Leave lobby
          </button>
        </div>
      </div>
    </div>
  );
}
