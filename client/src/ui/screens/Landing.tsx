/**
 * DECKSHOT UI — landing screen.
 *
 * Owner: lobby-ui-hud.
 *
 * THE journey: open URL -> CREATE LOBBY -> read 4-char code to a friend ->
 * friend opens ?lobby=CODE, types a name, is in the match. Everything here
 * exists to keep that under three seconds of friction.
 */

import { useEffect, useRef, useState } from 'react';
import { LOBBY_CODE_LENGTH } from '../../../../shared/protocol.js';
import { FFA_SCORE_LIMIT } from '../../../../shared/tuning.js';
import { GameMode } from '../../../../shared/types.js';
import { saveName } from '../persist.js';
import { useUI, useUICtx } from '../store.js';
import { cleanCodeInput, click, hover, lobbyCodeFromUrl } from '../util.js';

export function Landing(): JSX.Element {
  const { store, bridge, setOverlay } = useUICtx();
  const name = useUI((s) => s.name);
  const pending = useUI((s) => s.pending);

  const [joinOpen, setJoinOpen] = useState(false);
  const [code, setCode] = useState('');
  const [shake, setShake] = useState(0);
  const [urlCode] = useState<string | null>(() => lobbyCodeFromUrl());
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const autoJoined = useRef(false);

  const nameOk = name.trim().length > 0;

  const commitName = (): void => {
    const clean = name.trim().slice(0, 16);
    saveName(clean);
    bridge.setName(clean);
  };

  const doCreate = (): void => {
    if (!nameOk) return focusName();
    click();
    commitName();
    store.patch({ pending: 'Creating lobby' });
    bridge.createLobby(GameMode.SnipersOnlyFFA, FFA_SCORE_LIMIT);
  };

  const doQuickPlay = (): void => {
    if (!nameOk) return focusName();
    click();
    commitName();
    store.patch({ pending: 'Finding a match' });
    bridge.quickPlay();
  };

  const doJoin = (joinCode: string): void => {
    if (!nameOk) return focusName();
    click();
    commitName();
    store.patch({ pending: `Joining ${joinCode}` });
    bridge.joinLobby(joinCode);
  };

  const focusName = (): void => {
    nameRef.current?.focus();
    setShake((s) => s + 1);
  };

  const onCodeChange = (raw: string): void => {
    const { code: clean, rejected } = cleanCodeInput(raw);
    setCode(clean);
    if (rejected) setShake((s) => s + 1); // ambiguous chars refused, visibly
    if (clean.length === LOBBY_CODE_LENGTH) doJoin(clean); // auto-submit at 4
  };

  // ?lobby=CODE deep link: straight to the name prompt, then join.
  useEffect(() => {
    if (!urlCode) return;
    setJoinOpen(true);
    setCode(urlCode);
    if (name.trim()) {
      // Name already known from a previous visit — join immediately, once.
      if (!autoJoined.current) {
        autoJoined.current = true;
        doJoin(urlCode);
      }
    } else {
      nameRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCode]);

  useEffect(() => {
    if (joinOpen && !urlCode) codeRef.current?.focus();
  }, [joinOpen, urlCode]);

  return (
    <div className="ds-screen">
      <div className="ds-panel" style={{ width: 'min(420px, 92vw)' }}>
        <h1 className="ds-title">
          DECK<span className="accent">SHOT</span>
        </h1>
        <p className="ds-sub">Quickscopes on the high seas — no install, no account</p>

        <label className="ds-label" htmlFor="ds-name">
          Callsign
        </label>
        <input
          id="ds-name"
          ref={nameRef}
          className={`ds-input${shake % 2 === 1 && !nameOk ? ' shake' : ''}`}
          value={name}
          maxLength={16}
          placeholder="Enter your name"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => store.patch({ name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (urlCode) doJoin(urlCode);
              else if (joinOpen && code.length === LOBBY_CODE_LENGTH) doJoin(code);
              else doQuickPlay();
            }
          }}
        />
        {urlCode ? (
          <p className="ds-code-hint" style={{ marginTop: 10 }}>
            Invited to lobby <strong style={{ color: 'var(--ui-accent)' }}>{urlCode}</strong> — enter
            a name to drop in
          </p>
        ) : null}

        <div className="ds-col" style={{ marginTop: 20 }}>
          {urlCode ? (
            <button className="ds-btn primary big" onMouseEnter={hover} onClick={() => doJoin(urlCode)}>
              Join match {urlCode}
            </button>
          ) : null}
          <button className="ds-btn primary big" onMouseEnter={hover} onClick={doCreate}>
            Create lobby
          </button>
          <div className="ds-row">
            <button
              className={`ds-btn big${joinOpen ? ' ghost' : ''}`}
              style={{ flex: 1 }}
              onMouseEnter={hover}
              onClick={() => {
                click();
                setJoinOpen((v) => !v);
              }}
            >
              Join lobby
            </button>
            <button className="ds-btn big" style={{ flex: 1 }} onMouseEnter={hover} onClick={doQuickPlay}>
              Quick play
            </button>
          </div>
          {joinOpen && !urlCode ? (
            <div>
              <label className="ds-label" htmlFor="ds-code">
                Lobby code
              </label>
              <input
                id="ds-code"
                ref={codeRef}
                className={`ds-input code${shake % 2 === 1 ? ' shake' : ''}`}
                value={code}
                placeholder="····"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => onCodeChange(e.target.value)}
              />
              <p className="ds-code-hint" style={{ marginTop: 6 }}>
                4 letters — no O/0 or I/1, joins automatically
              </p>
            </div>
          ) : null}
        </div>

        <div className="ds-row" style={{ marginTop: 22, justifyContent: 'center' }}>
          <button
            className="ds-btn ghost"
            onClick={() => {
              click();
              setOverlay('settings');
            }}
          >
            Settings
          </button>
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
      {pending ? (
        <div className="ds-busy">
          <div className="txt">{pending}…</div>
        </div>
      ) : null}
    </div>
  );
}
