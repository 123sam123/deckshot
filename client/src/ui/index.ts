/**
 * DECKSHOT UI — public entry point.
 *
 * Owner: lobby-ui-hud. Contract (wired by the orchestrator in main.ts):
 *
 *   import { mountUI } from './ui/index.js';
 *   const handle = mountUI(document.getElementById('ui')!, bridge);
 *   // push server messages / local state through `handle`,
 *   // receive player intents through your `bridge` implementation.
 *
 * The UI mounts into #ui only, keeps its root pointer-events: none (the
 * canvas owns the mouse), and re-enables pointer events per interactive
 * surface. Styles are injected as a single <style> tag — no external
 * fonts, images or CSS frameworks.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ChatMsg,
  ErrorMsg,
  KillMsg,
  LobbyStateMsg,
  MatchOverMsg,
  RoundStateMsg,
  ScoreboardEntry,
  ZombiesStateMsg,
} from '../../../shared/protocol.js';
import type { Loadout, PlayerId } from '../../../shared/types.js';
import { App } from './App.js';
import type { ConnectionPhase, LocalHudState, UIBridge, UIHandle, UISettings } from './bridge.js';
import { loadLoadout, loadName, loadSettings } from './persist.js';
import { UIStore } from './store.js';
import { UI_CSS } from './styles.js';

export type {
  ConnectionPhase,
  LocalHudState,
  UIBridge,
  UIHandle,
  UISettings,
} from './bridge.js';

const STYLE_ID = 'deckshot-ui-styles';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = UI_CSS;
  document.head.appendChild(style);
}

/**
 * Mount the React UI into `root` (normally the #ui div) and return the
 * handle the game loop uses to push state in. See bridge.ts for both
 * interface contracts.
 */
export function mountUI(root: HTMLElement, bridge: UIBridge): UIHandle {
  ensureStyles();
  const store = new UIStore();
  const reactRoot = createRoot(root);
  reactRoot.render(createElement(App, { store, bridge }));

  // Hand the game loop the persisted settings immediately so the engine
  // boots with the player's sensitivity/FOV/quality without a round-trip.
  try {
    bridge.applySettings(store.state.settings);
  } catch {
    /* the bridge may not be fully wired yet; getSettings() still works */
  }

  return {
    onLobbyState: (msg: LobbyStateMsg): void => store.ingestLobbyState(msg),
    onRoundState: (msg: RoundStateMsg): void => store.ingestRoundState(msg),
    onKill: (msg: KillMsg): void => store.ingestKill(msg),
    onMatchOver: (msg: MatchOverMsg): void => store.patch({ matchOver: msg }),
    onChat: (msg: ChatMsg): void => store.ingestChat(msg),
    onError: (msg: ErrorMsg): void =>
      store.patch({
        error: { code: msg.code, message: msg.message, at: performance.now() },
        pending: null,
      }),
    onConnectionState: (phase: ConnectionPhase): void => store.patch({ connection: phase }),
    setLocalPlayerId: (id: PlayerId): void => store.patch({ localId: id }),
    setLocalState: (s: LocalHudState): void => store.patch({ local: s }),
    setScoreboard: (entries: ScoreboardEntry[]): void => store.patch({ scoreboard: entries }),
    showDamageFrom: (angle: number): void => store.ingestDamage(angle),
    onZombiesState: (msg: ZombiesStateMsg): void => store.patch({ zombies: msg }),
    setZombiesPrompt: (text: string | null): void => {
      if (store.state.zombiesPrompt !== text) store.patch({ zombiesPrompt: text });
    },
    setZombiesDowned: (names: string[]): void => {
      const cur = store.state.zombiesDowned;
      if (cur.length === names.length && cur.every((n, i) => n === names[i])) return;
      store.patch({ zombiesDowned: names });
    },
    reset: (): void => {
      const keep = store.state;
      store.patch({
        lobby: null,
        matchOver: null,
        pending: null,
        killfeed: [],
        banner: null,
        lastDeath: null,
        scoreboard: [],
        damage: [],
        chat: [],
        localId: 0,
        settings: keep.settings,
        zombies: null,
        zombiesPrompt: null,
        zombiesDowned: [],
      });
    },
    getSettings: (): UISettings => loadSettings(),
    getLoadout: (): Loadout => loadLoadout(),
    getName: (): string => (store.state.name || loadName()).trim(),
    unmount: (): void => reactRoot.unmount(),
  };
}
