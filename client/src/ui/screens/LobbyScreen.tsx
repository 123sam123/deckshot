/**
 * DECKSHOT UI — lobby screen.
 *
 * Owner: lobby-ui-hud.
 *
 * The code is rendered VERY large: it gets read off a stream or a photo of
 * a phone. Copy-invite is one click with unmistakable confirmation.
 */

import { useEffect, useRef, useState } from 'react';
import { GameMode, TeamId } from '../../../../shared/types.js';
import { COMPETITIVE_MAPS, mapById } from '../../../../shared/maps.js';
import { MIN_PLAYERS_TO_START } from '../../../../shared/tuning.js';
import { MAX_PLAYERS_SURVIVAL, MIN_PLAYERS_SURVIVAL } from '../../../../shared/survival.js';
import { useUI, useUICtx } from '../store.js';
import { click, copyText, hover, inviteLink } from '../util.js';

const SCORE_LIMITS_FFA = [10, 20, 30, 50];
const SCORE_LIMITS_TDM = [30, 50, 75, 100];

export function LobbyScreen(): JSX.Element | null {
  const { store, bridge, setOverlay } = useUICtx();
  const lobby = useUI((s) => s.lobby);
  const localId = useUI((s) => s.localId);
  const chat = useUI((s) => s.chat);
  const [copied, setCopied] = useState(false);
  const [chatText, setChatText] = useState('');
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [chat]);

  if (!lobby) return null;
  const me = lobby.players.find((p) => p.id === localId);
  const isHost = lobby.hostId === localId;
  const isTdm = lobby.mode === GameMode.TeamDeathmatch;
  const isSurvival = lobby.mode === GameMode.Survival;
  const limits = isTdm ? SCORE_LIMITS_TDM : SCORE_LIMITS_FFA;
  const connected = lobby.players.filter((p) => p.ping < 999).length;
  const minPlayers = isSurvival ? MIN_PLAYERS_SURVIVAL : MIN_PLAYERS_TO_START;

  const doCopy = async (): Promise<void> => {
    click();
    if (await copyText(inviteLink(lobby.code))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  const sendChat = (): void => {
    const text = chatText.trim();
    if (!text || !bridge.sendChat) return;
    bridge.sendChat(text);
    setChatText('');
  };

  return (
    <div className="ds-screen">
      <div className="ds-panel" style={{ width: 'min(660px, 94vw)' }}>
        <p className="ds-code-hint">Lobby code — read it out loud</p>
        <div className="ds-code-big">{lobby.code}</div>
        <div className="ds-row" style={{ justifyContent: 'center', marginBottom: 18 }}>
          <button className="ds-btn primary" onMouseEnter={hover} onClick={doCopy}>
            {copied ? <span className="ds-copied">Copied — send it!</span> : 'Copy invite link'}
          </button>
        </div>

        <div className="ds-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div className="ds-row">
            <span className="ds-label" style={{ margin: 0 }}>
              Mode
            </span>
            <div className="ds-seg">
              <button
                className={!isTdm ? 'on' : ''}
                disabled={!isHost}
                onClick={() => {
                  click();
                  bridge.setMatchConfig(GameMode.SnipersOnlyFFA, SCORE_LIMITS_FFA[2], lobby.timeLimit, lobby.mapId);
                }}
              >
                FFA
              </button>
              <button
                className={isTdm ? 'on' : ''}
                disabled={!isHost}
                onClick={() => {
                  click();
                  bridge.setMatchConfig(GameMode.TeamDeathmatch, SCORE_LIMITS_TDM[1], lobby.timeLimit, lobby.mapId);
                }}
              >
                TDM
              </button>
              <button
                className={isSurvival ? 'on' : ''}
                disabled={!isHost || lobby.players.length > MAX_PLAYERS_SURVIVAL}
                title={
                  lobby.players.length > MAX_PLAYERS_SURVIVAL
                    ? 'Survival squads cap at 5'
                    : 'Co-op zombies on the Leviathan'
                }
                onClick={() => {
                  click();
                  bridge.setMatchConfig(GameMode.Survival, 0, 0, lobby.mapId);
                }}
              >
                SURVIVAL
              </button>
            </div>
          </div>
          {!isSurvival ? (
            <div className="ds-row">
              <span className="ds-label" style={{ margin: 0 }}>
                Score limit
              </span>
              <div className="ds-seg">
                {limits.map((l) => (
                  <button
                    key={l}
                    className={lobby.scoreLimit === l ? 'on' : ''}
                    disabled={!isHost}
                    onClick={() => {
                      click();
                      bridge.setMatchConfig(lobby.mode, l, lobby.timeLimit, lobby.mapId);
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="ds-row">
              <span className="ds-label" style={{ margin: 0 }}>
                1–5 players · survive the drowned crew · earn the Talon back
              </span>
            </div>
          )}
        </div>
        {/* SURVIVAL is pinned to Leviathan, so the picker only appears for the
            competitive modes — an empty row would read as a broken control. */}
        {lobby.mode !== GameMode.Survival ? (
          <div className="ds-maps">
            {COMPETITIVE_MAPS.map((m) => (
              <button
                key={m.id}
                className={'ds-map' + (lobby.mapId === m.id ? ' on' : '')}
                disabled={!isHost || lobby.inProgress}
                onMouseEnter={hover}
                onClick={() => {
                  click();
                  bridge.setMatchConfig(lobby.mode, lobby.scoreLimit, lobby.timeLimit, m.id);
                }}
              >
                <span className="ds-map-name">{m.name}</span>
                <span className="ds-map-tag">{m.tagline}</span>
                <span className="ds-map-credit">
                  {m.credit
                    ? `after ${m.credit.original} — ${m.credit.authors} (${m.credit.project}, ${m.credit.license})`
                    : 'Deckshot original'}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="ds-code-hint" style={{ textAlign: 'left', marginTop: 12 }}>
            Survival is played on {mapById(lobby.mapId).name}
          </p>
        )}

        {!isHost ? (
          <p className="ds-code-hint" style={{ textAlign: 'left', marginTop: 4 }}>
            Only the host changes match settings
          </p>
        ) : null}

        <table className="ds-players">
          <tbody>
            {lobby.players.map((p) => (
              <tr key={p.id} className={(p.id === localId ? 'me ' : '') + (p.ping >= 999 ? 'gone' : '')}>
                <td style={{ width: '40%', fontWeight: 700 }}>{p.name}</td>
                <td>
                  {isTdm ? (
                    <span className={`ds-tag ${p.team === TeamId.Alpha ? 'alpha' : 'bravo'}`}>
                      {p.team === TeamId.Alpha ? 'ALPHA' : 'BRAVO'}
                    </span>
                  ) : null}
                </td>
                <td>{p.isHost ? <span className="ds-tag host">HOST</span> : null}</td>
                <td>
                  {p.ping >= 999 ? (
                    <span className="ds-tag notready">RECONNECTING</span>
                  ) : (
                    <span className={`ds-tag ${p.ready ? 'ready' : 'notready'}`}>
                      {p.ready ? 'READY' : 'NOT READY'}
                    </span>
                  )}
                </td>
                <td className="ds-ping" style={{ textAlign: 'right' }}>
                  {p.ping >= 999 ? '—' : `${p.ping} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="ds-code-hint" style={{ margin: '10px 0' }}>
          {lobby.inProgress
            ? 'Match in progress — you will drop straight in'
            : connected < minPlayers
              ? `Waiting for players — ${connected}/${minPlayers} minimum`
              : 'Match starts when everyone is ready'}
        </p>

        <div className="ds-row" style={{ marginTop: 8 }}>
          <button
            className={`ds-btn big ${me?.ready ? 'ready-on' : 'primary'}`}
            style={{ flex: 2 }}
            onMouseEnter={hover}
            onClick={() => {
              click();
              bridge.setReady(!me?.ready);
            }}
          >
            {me?.ready ? 'Ready — waiting' : 'Ready up'}
          </button>
          <button
            className="ds-btn"
            style={{ flex: 1 }}
            onClick={() => {
              click();
              setOverlay('loadout');
            }}
          >
            Loadout
          </button>
          <button
            className="ds-btn"
            style={{ flex: 1 }}
            onClick={() => {
              click();
              setOverlay('settings');
            }}
          >
            Settings
          </button>
          <button
            className="ds-btn danger ghost"
            onClick={() => {
              click();
              store.patch({ lobby: null, pending: null });
              bridge.leaveLobby();
            }}
          >
            Leave
          </button>
        </div>

        {bridge.sendChat ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ maxHeight: 96, overflowY: 'auto', fontSize: 13 }}>
              {chat.map((c) => (
                <div key={c.key}>
                  <strong style={{ color: 'var(--ui-accent)' }}>{c.name}</strong>{' '}
                  <span style={{ color: 'var(--ui-dim)' }}>{c.text}</span>
                </div>
              ))}
              <div ref={chatEnd} />
            </div>
            <input
              className="ds-input"
              style={{ marginTop: 6, fontSize: 14, padding: '8px 12px' }}
              placeholder="Chat…"
              value={chatText}
              maxLength={120}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendChat();
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
