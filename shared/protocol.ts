/**
 * DECKSHOT — wire protocol.
 *
 * FROZEN CONTRACT. Do not edit without orchestrator approval.
 *
 * Transport: one WebSocket per client, binary frames only.
 * Byte order: little-endian everywhere.
 * Every frame begins with a u8 MessageType, followed by that type's payload.
 *
 * Two channels of traffic share the socket:
 *   - HOT PATH (Input, Snapshot) — hand-rolled binary via DataView, no JSON.
 *   - COLD PATH (lobby, chat, loadout) — also binary, but string-heavy and
 *     infrequent; encode strings as u8 length + UTF-8 bytes.
 *
 * Quantization helpers live in `shared/quantize.ts` and MUST be used by the
 * codec so client and server agree bit-for-bit.
 */

import type {
  AdsState,
  ClientInput,
  GameMode,
  HitboxPart,
  Loadout,
  LobbyCode,
  PlayerId,
  PlayerState,
  Quat,
  RoundPhase,
  Stance,
  TeamId,
  TickNumber,
  Vec3,
  WeaponId,
} from './types.js';

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export enum ClientMessage {
  /** First message on connect. Cold path. */
  Hello = 1,
  /** Create a new lobby and join it as host. */
  CreateLobby = 2,
  /** Join an existing lobby by code. */
  JoinLobby = 3,
  /** Join any lobby with an open slot; server picks. */
  QuickPlay = 4,
  LeaveLobby = 5,
  SetReady = 6,
  /** Host only. */
  SetMatchConfig = 7,
  SetLoadout = 8,
  Chat = 9,
  /** Hot path, 60Hz. Carries INPUT_REDUNDANCY recent inputs. */
  Input = 10,
  /** Latency probe reply. */
  Pong = 11,
  /** Client asks to respawn after the death timer expires. */
  RequestRespawn = 12,
  /** ZOMBIES: buy a door, wall weapon, perk, Forge upgrade, ammo or box spin. */
  Purchase = 13,
  /** ZOMBIES: flip the power switch, take a box weapon. */
  Interact = 14,
}

export enum ServerMessage {
  /** Assigns the client its PlayerId and echoes server config. */
  Welcome = 64,
  /** Full lobby state; sent on any lobby membership/config change. */
  LobbyState = 65,
  /** Error with a human-readable reason (bad code, lobby full, ...). */
  Error = 66,
  /** Hot path, 20Hz. Delta-compressed world snapshot. */
  Snapshot = 67,
  /** Round phase transitions, score limits, timers. */
  RoundState = 68,
  /** Someone died. Drives killfeed, killcam, trickshot banners. */
  Kill = 69,
  /** You (or someone) got hit. Drives hitmarkers and flinch. */
  Hit = 70,
  /** A player spawned. */
  Spawn = 71,
  Chat = 72,
  /** Latency probe. */
  Ping = 73,
  /** Server rejected a predicted action (fire while reloading, etc). */
  Correction = 74,
  /** Match ended; carries final scoreboard and best trickshot. */
  MatchOver = 75,
  /** ZOMBIES: round machine, zones, drops, windows, per-recipient economy. ~1Hz + on change. */
  ZombiesState = 76,
}

// ---------------------------------------------------------------------------
// Client -> Server payloads
// ---------------------------------------------------------------------------

export interface HelloMsg {
  /** Client build hash. Server rejects mismatches with Error. */
  version: string;
  name: string;
  /** Present when reconnecting; server restores the session if still valid. */
  resumeToken?: string;
}

export interface CreateLobbyMsg {
  mode: GameMode;
  scoreLimit: number;
}

export interface JoinLobbyMsg {
  code: LobbyCode;
}

export interface SetMatchConfigMsg {
  mode: GameMode;
  scoreLimit: number;
  timeLimit: number;
}

export interface SetLoadoutMsg {
  loadout: Loadout;
}

/**
 * ZOMBIES purchases. What `itemId` means depends on `kind`:
 * Zone -> zone index, Weapon -> WeaponId (wall buy or ammo re-buy),
 * Perk -> PerkId, Forge/Box -> ignored.
 */
export interface PurchaseMsg {
  kind: number; // shared/zombies.ts PurchaseKind
  itemId: number;
}

/** ZOMBIES interactions that are not purchases. */
export interface InteractMsg {
  target: number; // shared/zombies.ts InteractTarget
}

/**
 * HOT PATH. Wire layout (little-endian):
 *   u8   ClientMessage.Input
 *   u8   count            (1..INPUT_REDUNDANCY)
 *   u16  baseSeq          (seq of the FIRST input in the list)
 *   u32  tick             (client's estimated server tick for baseSeq)
 *   -- repeated `count` times, each input's seq is baseSeq + i --
 *   i8   moveX            (-127..127 maps to -1..1)
 *   i8   moveZ
 *   u16  yaw              (quantized, ANGLE_QUANTIZATION)
 *   i16  pitch            (quantized, ANGLE_QUANTIZATION)
 *   u16  buttons          (InputButton bitfield)
 * = 2 + 4 + count * 8 bytes. At count=3: 30 bytes. At 60Hz: 1.8 KB/s up.
 */
export interface InputMsg {
  inputs: ClientInput[];
}

// ---------------------------------------------------------------------------
// Server -> Client payloads
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
  playerId: PlayerId;
  /** Opaque token the client stores to reconnect within RECONNECT_GRACE. */
  resumeToken: string;
  serverTime: number;
  tickRate: number;
  snapshotRate: number;
}

export interface LobbyPlayerInfo {
  id: PlayerId;
  name: string;
  team: TeamId;
  ready: boolean;
  isHost: boolean;
  ping: number;
  loadout: Loadout;
}

export interface LobbyStateMsg {
  code: LobbyCode;
  hostId: PlayerId;
  mode: GameMode;
  scoreLimit: number;
  timeLimit: number;
  players: LobbyPlayerInfo[];
  /** True once the match has started; late joiners spawn immediately. */
  inProgress: boolean;
}

export interface ErrorMsg {
  code: ErrorCode;
  message: string;
}

export enum ErrorCode {
  Unknown = 0,
  LobbyNotFound = 1,
  LobbyFull = 2,
  VersionMismatch = 3,
  NameInvalid = 4,
  NotHost = 5,
  NoLobbiesAvailable = 6,
  RateLimited = 7,
}

/**
 * Per-player state as it appears in a snapshot. This is the subset of
 * PlayerState that is replicated. Everything else is either local-only or
 * derived on the client.
 */
export interface SnapshotPlayer {
  id: PlayerId;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  onGround: boolean;
  alive: boolean;
  health: number;
  activeWeapon: WeaponId;
  adsState: AdsState;
  adsProgress: number;
  /** Set for one snapshot on the tick the player fired; drives remote VFX. */
  firedThisTick: boolean;
  /** ZOMBIES: last stand. Rides Flags bit 3 (additive; bits 3-7 were free). */
  downed?: boolean;
}

/**
 * HOT PATH. Wire layout:
 *   u8   ServerMessage.Snapshot
 *   u32  tick
 *   u16  ackedSeq        (latest client input this snapshot accounts for)
 *   u16  baselineTick    (tick this delta is against; 0 = full state)
 *   u8   playerCount
 *   -- per player --
 *   u8   playerId
 *   u16  fieldMask       (bit per field; only changed fields follow)
 *   ...  present fields, in the fixed order below
 *
 * Field order and mask bits are defined by SNAPSHOT_FIELD. The codec MUST
 * emit fields in ascending bit order.
 */
export enum SnapshotField {
  Position = 1 << 0, // 3 x u16 fixed-point (POS_QUANTIZATION)
  Velocity = 1 << 1, // 3 x i16, 1/64 m/s resolution
  Yaw = 1 << 2, // u16 quantized
  Pitch = 1 << 3, // i16 quantized
  Stance = 1 << 4, // u8
  Flags = 1 << 5, // u8: bit0 onGround, bit1 alive, bit2 firedThisTick, bit3 downed (ZOMBIES)
  Health = 1 << 6, // u8
  Weapon = 1 << 7, // u8
  Ads = 1 << 8, // u8 state (2 bits) + u8 progress (0..255)
  Score = 1 << 9, // u16 score, u8 kills, u8 deaths, u8 streak
  Identity = 1 << 10, // u8 team + name string + loadout (sent on join only)
  Ping = 1 << 11, // u16
}

export interface SnapshotMsg {
  tick: TickNumber;
  ackedSeq: number;
  baselineTick: TickNumber;
  players: SnapshotPlayer[];
  /** Players who left since the baseline. */
  removed: PlayerId[];
}

export interface RoundStateMsg {
  phase: RoundPhase;
  /** Seconds remaining in the current phase. */
  timeRemaining: number;
  scoreLimit: number;
  /** Index by TeamId for TDM; ignored in FFA. */
  teamScores: [number, number];
}

/** Trickshot modifiers, evaluated server-side. Bitfield. */
export enum TrickshotFlag {
  Quickscope = 1 << 0,
  Noscope = 1 << 1,
  Spin360 = 1 << 2,
  Spin540 = 1 << 3,
  Spin720 = 1 << 4,
  Collateral = 1 << 5,
  Crossmap = 1 << 6,
  Airborne = 1 << 7,
  Dropshot = 1 << 8,
  Jumpshot = 1 << 9,
  Feed = 1 << 10,
  Headshot = 1 << 11,
}

export interface KillMsg {
  killerId: PlayerId;
  victimId: PlayerId;
  weapon: WeaponId;
  part: HitboxPart;
  /** Meters between killer and victim at time of death. */
  distance: number;
  /** Bitfield of TrickshotFlag. */
  trickshot: number;
  /** Number of players killed by this single bullet (>=2 means collateral). */
  collateralCount: number;
  score: number;
  /** Suppressed kills omit the muzzle direction from the feed. */
  suppressed: boolean;
  /** Killer position, for the killcam camera lerp. */
  killerPosition: Vec3;
}

export interface HitMsg {
  /** Who fired. */
  attackerId: PlayerId;
  /** Who was hit. */
  victimId: PlayerId;
  part: HitboxPart;
  damage: number;
  /** True if the shot passed through a surface first. */
  penetrated: boolean;
  /** World position of the impact, for decals and particles. */
  point: Vec3;
  normal: Vec3;
}

export interface SpawnMsg {
  playerId: PlayerId;
  position: Vec3;
  yaw: number;
  loadout: Loadout;
}

export interface ChatMsg {
  playerId: PlayerId;
  text: string;
}

export interface CorrectionMsg {
  /** The input seq that was rejected. */
  seq: number;
  reason: CorrectionReason;
  /** Authoritative state to snap to. */
  state: SnapshotPlayer;
}

export enum CorrectionReason {
  IllegalFire = 0,
  IllegalMove = 1,
  IllegalStance = 2,
  RateLimited = 3,
}

export interface ScoreboardEntry {
  id: PlayerId;
  name: string;
  team: TeamId;
  score: number;
  kills: number;
  deaths: number;
  bestTrickshotScore: number;
  bestTrickshotFlags: number;
}

export interface MatchOverMsg {
  scoreboard: ScoreboardEntry[];
  winnerId: PlayerId;
  winnerTeam: TeamId;
  /** The single highest-scoring trickshot of the match. */
  bestTrickshot: KillMsg | null;
}

/** A power-up lying on the deck, waiting to be walked over. */
export interface PowerupDrop {
  /** Stable id while the drop lives (drives client spawn/expire animation). u8. */
  id: number;
  /** shared/zombies.ts PowerupId. */
  kind: number;
  /** World position, quantized like everything else. */
  pos: Vec3;
  /** Seconds until it fades out. */
  secondsLeft: number;
}

/**
 * ZOMBIES round machine + map progression, assembled PER RECIPIENT (the
 * recipient-specific block differs per client). Sent on any change and at
 * ~1Hz. Everything squad-wide that the snapshot channel does not carry lives
 * here; zombie positions ride the ordinary snapshot as id >= ZOMBIE_ID_BASE
 * entities.
 */
export interface ZombiesStateMsg {
  round: number;
  /** shared/zombies.ts ZombiesPhase. */
  phase: number;
  /** Seconds remaining in the current phase (intermission countdown; 0 mid-wave). */
  timeRemaining: number;
  /** Zombies not yet killed this round (alive + still to spawn). */
  zombiesRemaining: number;
  powerOn: boolean;
  /** Bit per zone index; bit set = purchased/open. */
  zoneMask: number;
  /** CrateSpot `spot` index the mystery box currently sits at; 255 = none. */
  boxSpot: number;
  /** Active squad-wide power-ups: [PowerupId, secondsRemaining] pairs. */
  effects: Array<[number, number]>;
  /** Power-up drops on the deck (<= MAX_DROPS). */
  drops: PowerupDrop[];
  /** Planks per window, dense by WindowDef id, 0..PLANKS_MAX (u4 packed). */
  planks: number[];

  // --- per-recipient -------------------------------------------------------
  /** Spendable balance (u32 — `score` saturates at 65535). */
  points: number;
  /** PerkId bitfield. */
  perks: number;
  /** Seconds of bleedout left; 0 when not downed. */
  bleedout: number;
  /** SECOND WIND self-revives remaining (solo). */
  selfRevives: number;
  /** Bit per WeaponId: this recipient's Forge-upgraded guns. */
  forged: number;
  /**
   * Recipient's authoritative arsenal. Ammo is not in the snapshot, and the
   * mode grants/refills weapons server-side, so prediction syncs from here
   * (a refill only ever RAISES a counter — the client keeps its own
   * prediction when it is ahead).
   */
  held: WeaponId;
  /** 255 = no stowed weapon. */
  stowed: number;
  ammoMag: number;
  ammoReserve: number;
  stowedMag: number;
  stowedReserve: number;
  /** WeaponId the box rolled for the recipient, or 255 when no offer stands. */
  boxOffer: number;
  /** Plank-repair points income left this round (REPAIR_BUDGET_PER_ROUND cap). */
  repairBudget: number;
  /** 0..1 progress of the revive the recipient is performing; 0 = none. */
  reviveProgress: number;
  /** True while a teammate is actively reviving the (downed) recipient. */
  beingRevived: boolean;
}

// ---------------------------------------------------------------------------
// Session / reconnect
// ---------------------------------------------------------------------------

/** How long a disconnected player's slot is held open, in ms. */
export const RECONNECT_GRACE_MS = 30_000;

/** How long an empty lobby survives before being reclaimed, in ms. */
export const LOBBY_EMPTY_TTL_MS = 10 * 60_000;

/** Unambiguous code alphabet: no O/0/I/1. */
export const LOBBY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LOBBY_CODE_LENGTH = 4;

/** Bumped on any protocol change. Server rejects mismatched clients. */
export const PROTOCOL_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// Typed message unions — used by the dispatch layer.
// ---------------------------------------------------------------------------

export type AnyClientMessage =
  | { type: ClientMessage.Hello; data: HelloMsg }
  | { type: ClientMessage.CreateLobby; data: CreateLobbyMsg }
  | { type: ClientMessage.JoinLobby; data: JoinLobbyMsg }
  | { type: ClientMessage.QuickPlay; data: Record<string, never> }
  | { type: ClientMessage.LeaveLobby; data: Record<string, never> }
  | { type: ClientMessage.SetReady; data: { ready: boolean } }
  | { type: ClientMessage.SetMatchConfig; data: SetMatchConfigMsg }
  | { type: ClientMessage.SetLoadout; data: SetLoadoutMsg }
  | { type: ClientMessage.Chat; data: { text: string } }
  | { type: ClientMessage.Input; data: InputMsg }
  | { type: ClientMessage.Pong; data: { time: number } }
  | { type: ClientMessage.RequestRespawn; data: Record<string, never> }
  | { type: ClientMessage.Purchase; data: PurchaseMsg }
  | { type: ClientMessage.Interact; data: InteractMsg };

export type AnyServerMessage =
  | { type: ServerMessage.Welcome; data: WelcomeMsg }
  | { type: ServerMessage.LobbyState; data: LobbyStateMsg }
  | { type: ServerMessage.Error; data: ErrorMsg }
  | { type: ServerMessage.Snapshot; data: SnapshotMsg }
  | { type: ServerMessage.RoundState; data: RoundStateMsg }
  | { type: ServerMessage.Kill; data: KillMsg }
  | { type: ServerMessage.Hit; data: HitMsg }
  | { type: ServerMessage.Spawn; data: SpawnMsg }
  | { type: ServerMessage.Chat; data: ChatMsg }
  | { type: ServerMessage.Ping; data: { time: number } }
  | { type: ServerMessage.Correction; data: CorrectionMsg }
  | { type: ServerMessage.MatchOver; data: MatchOverMsg }
  | { type: ServerMessage.ZombiesState; data: ZombiesStateMsg };

/**
 * The codec contract. Implemented once in shared/codec.ts by netcode-core and
 * used by BOTH sides. No other module may touch bytes.
 */
export interface Codec {
  encodeClient(msg: AnyClientMessage): ArrayBuffer;
  decodeClient(buf: ArrayBuffer): AnyClientMessage;
  encodeServer(msg: AnyServerMessage): ArrayBuffer;
  decodeServer(buf: ArrayBuffer): AnyServerMessage;
}

/** Unused in the hot path, but referenced by SnapshotPlayer consumers. */
export type { Quat };
