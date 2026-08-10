/**
 * DECKSHOT UI — a tiny external store the UIHandle pushes into.
 *
 * Owner: lobby-ui-hud.
 *
 * No state library: an immutable state object, a listener set, and
 * useSyncExternalStore. Selectors must return references held inside the
 * state object (never freshly built objects) or React will loop.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import { describeTrickshot } from '../../../shared/trickshot.js';
import type {
  ChatMsg,
  KillMsg,
  LobbyStateMsg,
  MatchOverMsg,
  RoundStateMsg,
  ScoreboardEntry,
  SurvivalStateMsg,
} from '../../../shared/protocol.js';
import { ErrorCode, TrickshotFlag } from '../../../shared/protocol.js';
import { AdsState, HitboxPart, RoundPhase, WeaponId } from '../../../shared/types.js';
import type { Loadout, PlayerId } from '../../../shared/types.js';
import { WEAPONS } from '../../../shared/tuning.js';
import type { ConnectionPhase, LocalHudState, UIBridge, UISettings } from './bridge.js';
import { loadLoadout, loadName, loadSettings } from './persist.js';

export interface FeedItem {
  key: number;
  killerName: string;
  victimName: string;
  weaponName: string;
  headshot: boolean;
  trickshot: string; // '' for a plain kill
  score: number;
  byMe: boolean;
  at: number; // performance.now() ms
}

export interface BannerItem {
  key: number;
  text: string;
  score: number;
  at: number;
}

export interface DamageMark {
  key: number;
  angle: number; // radians clockwise from camera forward
  at: number;
}

export interface ChatLine {
  key: number;
  name: string;
  text: string;
}

export interface ErrorToast {
  code: ErrorCode;
  message: string;
  at: number;
}

export const DEFAULT_LOCAL: LocalHudState = {
  health: 100,
  alive: true,
  weapon: WeaponId.Talon,
  ammoInMag: 5,
  ammoReserve: 25,
  adsState: AdsState.Hip,
  adsProgress: 0,
  reloading: false,
  kills: 0,
  score: 0,
  streak: 0,
  respawnIn: 0,
};

export interface UIState {
  connection: ConnectionPhase;
  /** Set by the UI while a create/join/quickplay is in flight. */
  pending: string | null;
  localId: PlayerId;
  name: string;
  lobby: LobbyStateMsg | null;
  round: RoundStateMsg;
  /** performance.now() when `round` arrived; timers extrapolate from it. */
  roundAt: number;
  killfeed: FeedItem[];
  banner: BannerItem | null;
  /** The KillMsg that killed the local player, for the death screen. */
  lastDeath: KillMsg | null;
  matchOver: MatchOverMsg | null;
  local: LocalHudState;
  scoreboard: ScoreboardEntry[];
  damage: DamageMark[];
  chat: ChatLine[];
  error: ErrorToast | null;
  settings: UISettings;
  loadout: Loadout;
  /** Bumped on each local kill so the counter re-runs its pop animation. */
  killPop: number;
  /** SURVIVAL: the latest per-recipient round/economy state, or null. */
  survival: SurvivalStateMsg | null;
  /** SURVIVAL: contextual "hold F to ..." prompt. */
  survivalPrompt: string | null;
}

export function initialState(): UIState {
  return {
    connection: 'idle',
    pending: null,
    localId: 0,
    name: loadName(),
    lobby: null,
    round: { phase: RoundPhase.Warmup, timeRemaining: 0, scoreLimit: 0, teamScores: [0, 0] },
    roundAt: 0,
    killfeed: [],
    banner: null,
    lastDeath: null,
    matchOver: null,
    local: { ...DEFAULT_LOCAL },
    scoreboard: [],
    damage: [],
    chat: [],
    error: null,
    settings: loadSettings(),
    loadout: loadLoadout(),
    killPop: 0,
    survival: null,
    survivalPrompt: null,
  };
}

let nextKey = 1;
export const newKey = (): number => nextKey++;

export class UIStore {
  state: UIState = initialState();
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getState = (): UIState => this.state;

  patch(p: Partial<UIState>): void {
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }

  // ----- message ingestion (called from the UIHandle) ----------------------

  ingestLobbyState(msg: LobbyStateMsg): void {
    this.patch({ lobby: msg, pending: null });
  }

  ingestRoundState(msg: RoundStateMsg): void {
    const p: Partial<UIState> = { round: msg, roundAt: performance.now() };
    if (msg.phase === RoundPhase.Warmup) {
      // Back in the lobby: scrub the previous match's transient state.
      p.matchOver = null;
      p.killfeed = [];
      p.banner = null;
      p.lastDeath = null;
    }
    this.patch(p);
  }

  ingestKill(msg: KillMsg): void {
    const now = performance.now();
    const byMe = msg.killerId === this.state.localId && msg.killerId !== msg.victimId;
    const item: FeedItem = {
      key: newKey(),
      killerName: this.nameFor(msg.killerId),
      victimName: this.nameFor(msg.victimId),
      weaponName: WEAPONS[msg.weapon]?.name ?? 'unknown',
      headshot: (msg.trickshot & TrickshotFlag.Headshot) !== 0 || msg.part === HitboxPart.Head,
      trickshot: describeTrickshot(msg.trickshot),
      score: msg.score,
      byMe,
      at: now,
    };
    const feed = [...this.state.killfeed.slice(-5), item];
    const p: Partial<UIState> = { killfeed: feed };
    if (byMe) {
      p.killPop = this.state.killPop + 1;
      if (msg.trickshot !== 0) {
        p.banner = { key: newKey(), text: item.trickshot, score: msg.score, at: now };
      }
    }
    if (msg.victimId === this.state.localId) p.lastDeath = msg;
    this.patch(p);
  }

  ingestChat(msg: ChatMsg): void {
    const line: ChatLine = { key: newKey(), name: this.nameFor(msg.playerId), text: msg.text };
    this.patch({ chat: [...this.state.chat.slice(-29), line] });
  }

  ingestDamage(angle: number): void {
    const mark: DamageMark = { key: newKey(), angle, at: performance.now() };
    this.patch({ damage: [...this.state.damage.slice(-7), mark] });
  }

  nameFor(id: PlayerId): string {
    if (id >= 200) return 'Drowned'; // SURVIVAL horde id range
    const inLobby = this.state.lobby?.players.find((p) => p.id === id);
    if (inLobby) return inLobby.name;
    const inBoard = this.state.scoreboard.find((e) => e.id === id);
    if (inBoard) return inBoard.name;
    const inOver = this.state.matchOver?.scoreboard.find((e) => e.id === id);
    if (inOver) return inOver.name;
    return id === 0 ? 'the sea' : `Player ${id}`;
  }
}

// ---------------------------------------------------------------------------
// React plumbing
// ---------------------------------------------------------------------------

export type Overlay = 'none' | 'settings' | 'loadout';

export interface UICtxValue {
  store: UIStore;
  bridge: UIBridge;
  overlay: Overlay;
  setOverlay: (o: Overlay) => void;
}

export const UICtx = createContext<UICtxValue | null>(null);

export function useUICtx(): UICtxValue {
  const v = useContext(UICtx);
  if (!v) throw new Error('UI component rendered outside UICtx');
  return v;
}

/** Subscribe to a slice. The selector must return a reference held in state. */
export function useUI<T>(selector: (s: UIState) => T): T {
  const { store } = useUICtx();
  return useSyncExternalStore(store.subscribe, () => selector(store.state));
}
