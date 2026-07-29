/**
 * DECKSHOT UI — Tab scoreboard.
 *
 * Owner: lobby-ui-hud.
 *
 * Rows come from UIHandle.setScoreboard (assembled by the game loop from
 * snapshots), falling back to lobby membership before any exist. Ping is
 * merged in from the lobby roster; best trickshot uses describeTrickshot.
 */

import { describeTrickshot } from '../../../../shared/trickshot.js';
import type { ScoreboardEntry } from '../../../../shared/protocol.js';
import { GameMode, TeamId } from '../../../../shared/types.js';
import { useUI } from '../store.js';

function rowsFromState(
  scoreboard: ScoreboardEntry[],
  lobbyPlayers: Array<{ id: number; name: string; team: TeamId }> | undefined,
): ScoreboardEntry[] {
  if (scoreboard.length > 0) return scoreboard;
  if (!lobbyPlayers) return [];
  return lobbyPlayers.map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    score: 0,
    kills: 0,
    deaths: 0,
    bestTrickshotScore: 0,
    bestTrickshotFlags: 0,
  }));
}

export function Scoreboard({ title, inline }: { title?: string; inline?: boolean }): JSX.Element {
  const scoreboard = useUI((s) => s.scoreboard);
  const lobby = useUI((s) => s.lobby);
  const localId = useUI((s) => s.localId);

  const rows = rowsFromState(scoreboard, lobby?.players);
  const isTdm = lobby?.mode === GameMode.TeamDeathmatch;
  const pingFor = (id: number): string => {
    const p = lobby?.players.find((x) => x.id === id);
    return p ? (p.ping >= 999 ? '—' : String(p.ping)) : '—';
  };

  const renderRows = (entries: ScoreboardEntry[]): JSX.Element[] =>
    entries.map((e) => (
      <tr key={e.id} className={e.id === localId ? 'me' : ''}>
        <td style={{ fontWeight: 700 }}>{e.name}</td>
        <td>{e.score}</td>
        <td>{e.kills}</td>
        <td>{e.deaths}</td>
        <td>{pingFor(e.id)}</td>
        <td className="trickcell">
          {e.bestTrickshotFlags ? describeTrickshot(e.bestTrickshotFlags) : '—'}
        </td>
      </tr>
    ));

  const header = (
    <tr>
      <th>Player</th>
      <th>Score</th>
      <th>Kills</th>
      <th>Deaths</th>
      <th>Ping</th>
      <th>Best trickshot</th>
    </tr>
  );

  return (
    <div className={`ds-board ds-hud-text${inline ? ' inline' : ''}`}>
      <h3>{title ?? 'Scoreboard'}</h3>
      <table>
        <thead>{header}</thead>
        <tbody>
          {isTdm ? (
            <>
              <tr className="teamhead">
                <td colSpan={6} style={{ color: 'var(--ui-alpha-team)', textAlign: 'left' }}>
                  ALPHA
                </td>
              </tr>
              {renderRows(rows.filter((r) => r.team === TeamId.Alpha))}
              <tr className="teamhead">
                <td colSpan={6} style={{ color: 'var(--ui-bravo-team)', textAlign: 'left' }}>
                  BRAVO
                </td>
              </tr>
              {renderRows(rows.filter((r) => r.team === TeamId.Bravo))}
            </>
          ) : (
            renderRows(rows)
          )}
        </tbody>
      </table>
    </div>
  );
}
