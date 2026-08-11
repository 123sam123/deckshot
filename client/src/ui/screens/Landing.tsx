/**
 * DECKSHOT UI — landing screen.
 *
 * Owner: lobby-ui-hud.
 *
 * THE journey: open URL -> CREATE LOBBY -> read 4-char code to a friend ->
 * friend opens ?lobby=CODE, types a name, is in the match. Everything here
 * exists to keep that under three seconds of friction.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { LOBBY_CODE_LENGTH } from '../../../../shared/protocol.js';
import { FFA_SCORE_LIMIT } from '../../../../shared/tuning.js';
import { GameMode } from '../../../../shared/types.js';
import { loadMode, saveMode, saveName } from '../persist.js';
import { useUI, useUICtx } from '../store.js';
import { cleanCodeInput, click, hover, lobbyCodeFromUrl } from '../util.js';

// TDM score limit mirrors LobbyScreen's SCORE_LIMITS_TDM[1]; Zombies carries none.
const SCORE_LIMIT_TDM = 50;
const scoreLimitFor = (mode: GameMode): number =>
  mode === GameMode.TeamDeathmatch
    ? SCORE_LIMIT_TDM
    : mode === GameMode.Zombies
      ? 0
      : FFA_SCORE_LIMIT;

interface ModeCard {
  mode: GameMode;
  name: string;
  desc: string;
  solo?: boolean;
}

// ZOMBIES' solo badge is the whole point — a lone visitor must see there is
// something to play with nobody else online.
const MODE_CARDS: ModeCard[] = [
  { mode: GameMode.SnipersOnlyFFA, name: 'FFA', desc: 'Free-for-all quickscoping · 2+ players' },
  { mode: GameMode.TeamDeathmatch, name: 'Team Deathmatch', desc: 'Two squads · 2+ players' },
  {
    mode: GameMode.Zombies,
    name: 'Zombies',
    desc: 'Round-based undead co-op on Shipbreak · playable solo · 1–4 players',
    solo: true,
  },
];

export function Landing(): JSX.Element {
  const { store, bridge, setOverlay } = useUICtx();
  const name = useUI((s) => s.name);
  const pending = useUI((s) => s.pending);

  const [joinOpen, setJoinOpen] = useState(false);
  const [code, setCode] = useState('');
  const [shake, setShake] = useState(0);
  const [mode, setMode] = useState<GameMode>(() => loadMode());
  const [urlCode] = useState<string | null>(() => lobbyCodeFromUrl());
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);
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
    bridge.createLobby(mode, scoreLimitFor(mode));
  };

  const pickMode = (next: GameMode): void => {
    click();
    setMode(next);
    saveMode(next); // persist immediately so the choice survives reload
  };

  // Arrow keys move selection within the radiogroup, per WAI-ARIA radio pattern.
  const onModeKey = (e: ReactKeyboardEvent, index: number): void => {
    let next = index;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (index + 1) % MODE_CARDS.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
      next = (index - 1 + MODE_CARDS.length) % MODE_CARDS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MODE_CARDS.length - 1;
    else return;
    e.preventDefault();
    pickMode(MODE_CARDS[next].mode);
    modeRefs.current[next]?.focus();
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

        {/* Mode picker — create path only; a ?lobby= joiner inherits the host's mode. */}
        {!urlCode ? (
          <>
            <span className="ds-label" id="ds-mode-label">
              Game mode
            </span>
            <div className="ds-modes" role="radiogroup" aria-labelledby="ds-mode-label">
              {MODE_CARDS.map((card, i) => {
                const on = card.mode === mode;
                return (
                  <button
                    key={card.mode}
                    ref={(el) => {
                      modeRefs.current[i] = el;
                    }}
                    type="button"
                    className={`ds-mode${on ? ' on' : ''}`}
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    onMouseEnter={hover}
                    onClick={() => pickMode(card.mode)}
                    onKeyDown={(e) => onModeKey(e, i)}
                  >
                    <span className="radio" aria-hidden="true" />
                    <span className="body">
                      <span className="n">
                        {card.name}
                        {card.solo ? <span className="solo">Solo OK</span> : null}
                      </span>
                      <span className="d">{card.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
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
