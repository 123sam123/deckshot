/**
 * DECKSHOT — core type vocabulary.
 *
 * FROZEN CONTRACT. Do not edit without orchestrator approval.
 * Every subsystem (client prediction, server sim, renderer, UI) speaks these types.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Server-assigned, unique within a lobby. 0 is reserved for "none". */
export type PlayerId = number;

/** Monotonic server simulation tick. Wraps at 2^32 (~2.3 years at 60Hz). */
export type TickNumber = number;

/** Client input sequence number. Wraps at 2^16; compare with `seqDiff`. */
export type InputSeq = number;

/** 4-character lobby code, e.g. "K7QX". Always uppercase. */
export type LobbyCode = string;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/** Plain vector. Never a THREE.Vector3 in shared code — shared must stay engine-free. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit quaternion. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quatIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

/**
 * Wrapping comparison for 16-bit sequence numbers.
 * Returns a - b in signed sequence space. Positive means `a` is newer.
 */
export function seqDiff(a: InputSeq, b: InputSeq): number {
  return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export enum WeaponId {
  Talon = 0, // MK-7 Talon — bolt-action sniper (primary)
  Kestrel = 1, // Kestrel .40 — semi-auto pistol (secondary)
  Knife = 2, // melee
  // --- SURVIVAL wall buys (additive; reported per INTEGRATION.md rule 1) ---
  Osprey = 3, // Osprey 9 — full-auto SMG
  Shrike = 4, // Shrike 12 — pump shotgun
  Condor = 5, // Condor MG — LMG
  Harrier = 6, // Harrier DMR — semi-auto rifle
}

export enum AttachmentId {
  None = 0,
  FastDraw = 1,
  VariableZoom = 2,
  StabilizerCPU = 3,
  FMJ = 4,
  ExtendedMag = 5,
  Suppressor = 6,
  Laser = 7,
  LightweightStock = 8,
  IronSightSwap = 9,
  BallisticCompensator = 10,
}

export const ATTACHMENT_COUNT = 11;

/** Max attachments equipped on one weapon simultaneously. */
export const MAX_ATTACHMENTS = 3;

export enum CamoId {
  Gunmetal = 0,
  Arctic = 1,
  Carbon = 2,
  Tiger = 3,
  Chrome = 4,
  Gold = 5,
}

/**
 * Player body skins — purely cosmetic (no stat, hitbox or stance effect), and
 * never overridden by team: friend/foe ID lives on teammate nameplates, not
 * body colour. Definitions live client-side in `client/src/gameplay/skins.ts`.
 */
export enum SkinId {
  Vanguard = 0, // boarding assaulter — mid olive (default)
  Frogman = 1, // combat diver — near-black
  Commodore = 2, // fleet officer — dress whites
  Fathom = 3, // hazard diver — verdigris + brass
  Breacher = 4, // hull breacher — burnt orange + steel
}

export const SKIN_COUNT = 5;

export interface Loadout {
  primary: WeaponId;
  /** Exactly MAX_ATTACHMENTS entries; unused slots are AttachmentId.None. */
  attachments: [AttachmentId, AttachmentId, AttachmentId];
  camo: CamoId;
  skin: SkinId;
}

export const DEFAULT_LOADOUT: Loadout = {
  primary: WeaponId.Talon,
  attachments: [AttachmentId.FastDraw, AttachmentId.None, AttachmentId.None],
  camo: CamoId.Gunmetal,
  skin: SkinId.Vanguard,
};

// ---------------------------------------------------------------------------
// Hitboxes
// ---------------------------------------------------------------------------

export enum HitboxPart {
  Head = 0,
  Chest = 1, // includes upper back
  Stomach = 2,
  ArmL = 3,
  ArmR = 4,
  LegL = 5,
  LegR = 6,
}

export const HITBOX_PART_COUNT = 7;

/** A capsule in player-local space (Y up, origin at feet). */
export interface HitboxCapsule {
  part: HitboxPart;
  /** Capsule segment start, local space. */
  a: Vec3;
  /** Capsule segment end, local space. */
  b: Vec3;
  radius: number;
}

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------

export enum Stance {
  Stand = 0,
  Crouch = 1,
  Prone = 2,
  Slide = 3,
}

export enum AdsState {
  Hip = 0,
  Raising = 1, // transitioning toward scoped
  Scoped = 2, // fully aimed
  Lowering = 3, // transitioning back to hip
}

/**
 * Everything needed to (a) simulate a player forward and (b) render them.
 * The movement function reads and writes ONLY the fields marked [SIM].
 * Anything else is derived and must not affect determinism.
 */
export interface PlayerState {
  id: PlayerId; // [SIM]
  position: Vec3; // [SIM] feet position
  velocity: Vec3; // [SIM]
  /** Radians. Yaw is around +Y, 0 = looking down -Z. */
  yaw: number; // [SIM]
  /** Radians, clamped to +/- PITCH_LIMIT. Positive = looking up. */
  pitch: number; // [SIM]
  stance: Stance; // [SIM]
  onGround: boolean; // [SIM]
  /** Seconds remaining in the current slide, 0 when not sliding. */
  slideTime: number; // [SIM]
  /** Seconds until slide can be used again. */
  slideCooldown: number; // [SIM]
  /** Seconds the sprint key has been held with forward input. */
  sprintTime: number; // [SIM]
  /**
   * [SIM] Buttons from the previous input, so rising edges can be detected.
   * Without this, holding jump would bunny-hop forever. Not sent on the wire —
   * it is re-derivable from the replayed input stream, but it MUST be carried
   * in the client's prediction history and the server's per-player state.
   */
  prevButtons?: number;
  /** [SIM] Seconds into the prone transition (see PRONE_TRANSITION). */
  proneTime?: number;
  /**
   * [SIM] Overrides SPEED_ADS when set. Populated by the weapons module from
   * the resolved loadout (the Lightweight Stock attachment); movement never
   * reads `loadout` itself.
   */
  adsMoveSpeedOverride?: number;

  // --- combat (server-authoritative; client predicts visuals only) ---
  health: number;
  alive: boolean;
  activeWeapon: WeaponId;
  adsState: AdsState;
  /** 0..1 progress through the ADS transition. */
  adsProgress: number;
  ammoInMag: number;
  ammoReserve: number;
  /** Server time (ms) at which the current reload/bolt action completes; 0 = idle. */
  actionEndsAt: number;

  // --- presentation ---
  name: string;
  team: TeamId;
  score: number;
  kills: number;
  deaths: number;
  streak: number;
  loadout: Loadout;
  /** Round-trip time in ms, as measured by the server. */
  ping: number;

  // --- SURVIVAL (optional, additive; reported per INTEGRATION.md rule 1) ---
  /** True while in last stand: prone crawl, pistol only, bleeding out. */
  downed?: boolean;
  /** Seconds of bleedout remaining while downed. Server-side only. */
  bleedout?: number;
  /** Spendable points balance. Mirrored into `score` for replication. */
  points?: number;
  /** Bitfield of shared/survival.ts PerkId. Server-side; replicated via SurvivalState. */
  perks?: number;
}

export enum TeamId {
  /** Free-for-all: everyone is on FFA and hostile to everyone. */
  FFA = 0,
  Alpha = 1,
  Bravo = 2,
  /** Not yet placed / spectating. */
  None = 255,
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export enum InputButton {
  Fire = 1 << 0,
  Ads = 1 << 1,
  Jump = 1 << 2,
  Crouch = 1 << 3,
  Sprint = 1 << 4,
  Reload = 1 << 5,
  SwapWeapon = 1 << 6,
  Melee = 1 << 7,
  /** Held to use the secondary zoom level of Variable Zoom. */
  ZoomToggle = 1 << 8,
  /**
   * SURVIVAL: interact/revive. `buttons` is already u16 on the wire; bits 9-15
   * were free (additive; reported per INTEGRATION.md rule 1).
   */
  Use = 1 << 9,
}

/**
 * One client tick of input. Sent at 60Hz, redundantly (last N per packet)
 * so a dropped datagram does not stall prediction.
 */
export interface ClientInput {
  seq: InputSeq;
  /** Client's estimate of the server tick this input applies to. */
  tick: TickNumber;
  /** -1..1, strafe. Quantized to int8 on the wire. */
  moveX: number;
  /** -1..1, forward/back. Quantized to int8 on the wire. */
  moveZ: number;
  /** Radians, absolute (not delta) — prevents desync from lost packets. */
  yaw: number;
  pitch: number;
  /** Bitfield of InputButton. */
  buttons: number;
}

export const emptyInput = (): ClientInput => ({
  seq: 0,
  tick: 0,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
});

export const hasButton = (buttons: number, b: InputButton): boolean => (buttons & b) !== 0;

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export enum GameMode {
  SnipersOnlyFFA = 0,
  TeamDeathmatch = 1,
  /** 1-5 player co-op Zombies (additive; reported per INTEGRATION.md rule 1). */
  Survival = 2,
}

export enum RoundPhase {
  /** In lobby, pre-match. */
  Warmup = 0,
  /** Countdown before the match begins. */
  Countdown = 1,
  Live = 2,
  /** Post-match summary. */
  Over = 3,
}
