/**
 * DECKSHOT UI — the two contracts between the UI and the game loop.
 *
 * Owner: lobby-ui-hud. The orchestrator wires these in client/src/main.ts.
 *
 *   UIBridge — implemented BY THE GAME LOOP, called by the UI. Every method
 *              is an intent; the game loop translates it into protocol
 *              messages (or local engine changes, for applySettings).
 *
 *   UIHandle — returned by mountUI, called by the game loop to push server
 *              messages and per-frame local state into the UI.
 *
 * The UI never opens a socket and never touches the canvas. All methods on
 * both interfaces are synchronous and safe to call at frame rate.
 */

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
import type { AdsState, GameMode, Loadout, PlayerId, WeaponId } from '../../../shared/types.js';

/** Connection lifecycle as the netcode layer sees it. */
export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Player-tunable settings, persisted by the UI to localStorage. */
export interface UISettings {
  /** Mouse sensitivity, SENSITIVITY_MIN..SENSITIVITY_MAX. */
  sensitivity: number;
  /** World FOV in degrees (the game converts to radians). */
  fovDegrees: number;
  invertY: boolean;
  /** 0..1. The UI also forwards this to Audio.setMasterVolume itself. */
  masterVolume: number;
  /** Matches the renderer's QualityTier. */
  quality: 'low' | 'medium' | 'high';
}

/** Per-frame local-player state the HUD renders. Push from the game loop. */
export interface LocalHudState {
  health: number;
  alive: boolean;
  weapon: WeaponId;
  ammoInMag: number;
  ammoReserve: number;
  adsState: AdsState;
  /** 0..1 — used to hide the crosshair as the scope comes up. */
  adsProgress: number;
  reloading: boolean;
  kills: number;
  score: number;
  streak: number;
  /** Seconds until respawn is available; 0 when alive or ready to deploy. */
  respawnIn: number;
  /** ZOMBIES: true while in last stand (crawling, pistol only). */
  downed?: boolean;
}

/**
 * Implemented by the game loop; every UI button lands here.
 */
export interface UIBridge {
  /** Send ClientMessage.CreateLobby. UI has already validated the name. */
  createLobby(mode: GameMode, scoreLimit: number): void;
  /** Send ClientMessage.JoinLobby. `code` is normalized uppercase, 4 chars. */
  joinLobby(code: string): void;
  quickPlay(): void;
  leaveLobby(): void;
  setReady(ready: boolean): void;
  /** Host-only config change; the server enforces NotHost. */
  setMatchConfig(mode: GameMode, scoreLimit: number, timeLimit: number): void;
  setLoadout(loadout: Loadout): void;
  /** Update the display name (part of Hello / stored for the next join). */
  setName(name: string): void;
  /** Send ClientMessage.RequestRespawn once the death timer allows it. */
  requestRespawn(): void;
  /** Optional — chat UI appears only if the game loop provides this. */
  sendChat?(text: string): void;
  /**
   * Called once on mount and again on every settings edit. The game loop
   * applies sensitivity/FOV/invert/quality; volume is already applied to
   * Audio by the UI.
   */
  applySettings(settings: UISettings): void;
}

/**
 * Returned by mountUI; the game loop pushes state through it.
 */
export interface UIHandle {
  onLobbyState(msg: LobbyStateMsg): void;
  onRoundState(msg: RoundStateMsg): void;
  /** Drives the killfeed, trickshot banners, kill counter and death screen. */
  onKill(msg: KillMsg): void;
  onMatchOver(msg: MatchOverMsg): void;
  onChat(msg: ChatMsg): void;
  onError(msg: ErrorMsg): void;
  onConnectionState(phase: ConnectionPhase): void;
  /** The local player's id from the Welcome frame. */
  setLocalPlayerId(id: PlayerId): void;
  /** Call every frame (or whenever it changes). Cheap. */
  setLocalState(s: LocalHudState): void;
  /** Full scoreboard rows, assembled by the game loop from snapshots. */
  setScoreboard(entries: ScoreboardEntry[]): void;
  /**
   * Flash a damage direction indicator.
   * `angle`: radians clockwise relative to the camera forward; 0 = ahead.
   */
  showDamageFrom(angle: number): void;
  /** ZOMBIES: the per-recipient round/economy/progression message. */
  onZombiesState(msg: ZombiesStateMsg): void;
  /** ZOMBIES: contextual "[F] ..." prompt; null clears it. */
  setZombiesPrompt(text: string | null): void;
  /** ZOMBIES: names of OTHER squad members currently down (callouts). */
  setZombiesDowned(names: string[]): void;
  /** Hard reset to the landing screen (e.g. fatal disconnect). */
  reset(): void;
  /** Current persisted settings — read once at boot for engine setup. */
  getSettings(): UISettings;
  /** Current persisted loadout — send with Hello/SetLoadout at connect. */
  getLoadout(): Loadout;
  /** Current persisted player name. */
  getName(): string;
  unmount(): void;
}
