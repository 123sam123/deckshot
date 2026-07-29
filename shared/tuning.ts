/**
 * DECKSHOT — all gameplay tuning constants.
 *
 * FROZEN CONTRACT. This is the ONE definition of every number in the game.
 * Client and server both import from here. If a value exists in two places,
 * that is a bug.
 *
 * Units: meters, seconds, radians. Mass is ignored (kinematic character).
 */

import { AttachmentId, HitboxPart, Stance, WeaponId } from './types.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** How often the server broadcasts world snapshots. */
export const SNAPSHOT_RATE = 20;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

/** Client renders remote entities this far in the past, in ms. */
export const INTERP_DELAY_MS = 100;

/** Max extrapolation before a remote entity freezes, in ms. */
export const MAX_EXTRAPOLATION_MS = 250;

/** Ring buffer size for unacknowledged client inputs. */
export const INPUT_BUFFER_SIZE = 128;

/** Inputs re-sent in each packet for redundancy against loss. */
export const INPUT_REDUNDANCY = 3;

/** Position error (meters) above which the client hard-reconciles. */
export const RECONCILE_EPSILON = 0.01;

/** Visual smoothing window for a reconciliation correction, in ms. */
export const RECONCILE_SMOOTH_MS = 100;

/** How much hitbox history the server retains, in ms. */
export const LAGCOMP_HISTORY_MS = 500;

/** Hard cap on how far back a shot may be rewound, in ms. */
export const LAGCOMP_MAX_REWIND_MS = 250;

// ---------------------------------------------------------------------------
// Player capsule
// ---------------------------------------------------------------------------

export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT_STAND = 1.75;
export const PLAYER_HEIGHT_CROUCH = 1.15;
export const PLAYER_HEIGHT_PRONE = 0.6;
export const EYE_HEIGHT_STAND = 1.62;
export const EYE_HEIGHT_CROUCH = 1.02;
export const EYE_HEIGHT_PRONE = 0.42;

/** Seconds to blend the camera between stance eye heights. */
export const STANCE_BLEND_TIME = 0.12;

export const PITCH_LIMIT = 89 * DEG;

export function heightForStance(s: Stance): number {
  switch (s) {
    case Stance.Crouch:
    case Stance.Slide:
      return PLAYER_HEIGHT_CROUCH;
    case Stance.Prone:
      return PLAYER_HEIGHT_PRONE;
    default:
      return PLAYER_HEIGHT_STAND;
  }
}

export function eyeHeightForStance(s: Stance): number {
  switch (s) {
    case Stance.Crouch:
    case Stance.Slide:
      return EYE_HEIGHT_CROUCH;
    case Stance.Prone:
      return EYE_HEIGHT_PRONE;
    default:
      return EYE_HEIGHT_STAND;
  }
}

// ---------------------------------------------------------------------------
// Movement — arcade-fast, BO2-era feel. Not milsim.
// ---------------------------------------------------------------------------

export const SPEED_WALK = 5.0;
export const SPEED_SPRINT = 7.4;
export const SPEED_ADS = 2.6;
export const SPEED_CROUCH = 2.9;
export const SPEED_PRONE = 1.1;

export const GRAVITY = 18.0;
export const JUMP_IMPULSE = 6.1; // ~1.05m apex
export const AIR_CONTROL = 0.35;

export const ACCEL_GROUND = 60.0;
export const ACCEL_AIR = 14.0;
export const FRICTION = 9.0;

/** Below this horizontal speed on the ground, velocity is zeroed. */
export const STOP_SPEED = 0.3;

/** Deliberately absent: an air-speed cap. Strafe-jumping is a feature. */

export const SLIDE_DURATION = 0.55;
export const SLIDE_SPEED_MULT = 1.35; // of sprint speed, at slide start
export const SLIDE_FRICTION = 3.2; // lower than FRICTION, so you carry speed
export const SLIDE_COOLDOWN = 1.1;
/** Minimum speed required to initiate a slide. */
export const SLIDE_MIN_SPEED = 5.5;

/** Time to transition into prone (drop-shot). */
export const PRONE_TRANSITION = 0.18;

/** Seconds of held sprint input before sprint speed engages. */
export const SPRINT_RAMP = 0.12;

/** Max step height the character controller auto-climbs. */
export const STEP_HEIGHT = 0.4;
/** Slopes steeper than this are not walkable. */
export const MAX_SLOPE = 50 * DEG;

/** Fall damage is disabled by design — it punishes the movement this mode wants. */
export const FALL_DAMAGE_ENABLED = false;

// ---------------------------------------------------------------------------
// Camera feel
// ---------------------------------------------------------------------------

export const FOV_WORLD = 90 * DEG;
export const FOV_VIEWMODEL = 65 * DEG;
/** World FOV when fully scoped with the default 3.5x scope. */
export const FOV_SCOPED_3_5X = 26 * DEG;
export const FOV_SCOPED_8X = 12 * DEG;
export const FOV_IRONSIGHT = 64 * DEG;

/** Camera roll applied at full strafe. */
export const CAMERA_STRAFE_ROLL = 1.2 * DEG;
export const CAMERA_ROLL_SPEED = 8.0;
/** Downward camera dip on landing, scaled by impact speed. */
export const CAMERA_LAND_DIP = 0.09;

export const DEFAULT_SENSITIVITY = 2.4;
export const SENSITIVITY_MIN = 0.2;
export const SENSITIVITY_MAX = 12.0;
/** Multiplier applied to sensitivity while scoped, per zoom level. */
export const ADS_SENS_MULT_3_5X = 0.55;
export const ADS_SENS_MULT_8X = 0.32;

// No aim assist. No mouse smoothing. No acceleration. This is not tunable.

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  /** Seconds from hip to fully scoped, before attachment modifiers. */
  adsTime: number;
  /**
   * THE quickscope number. Fraction of adsProgress at which the shot becomes
   * pinpoint-accurate. Fire below this and you get the hipfire cone scaled by
   * how far off you were. This single value defines the skill ceiling.
   */
  accuracyLockAt: number;
  /** Seconds between shots (bolt cycle / fire interval). */
  cycleTime: number;
  magSize: number;
  reserveAmmo: number;
  reloadTime: number;
  reloadTimeEmpty: number;
  /** Damage per hitbox part. */
  damage: Record<HitboxPart, number>;
  /** Fraction of damage retained after passing through one penetrable surface. */
  penetrationDamage: number;
  /** How many surfaces a round can pass through. */
  penetrationCount: number;
  /** Idle sway amplitude while scoped, radians. */
  swayAmplitude: number;
  swayFrequency: number;
  /** Fraction sway settles to after holding the scope for swaySettleTime. */
  swaySettleFactor: number;
  swaySettleTime: number;
  /** Vertical recoil kick, radians. */
  recoilVertical: number;
  /** Horizontal recoil, +/- radians. */
  recoilHorizontal: number;
  recoilRecovery: number;
  /** Camera punch distance, meters. */
  recoilPunch: number;
  /** Hipfire cone half-angle, radians. */
  hipSpreadStand: number;
  hipSpreadCrouch: number;
  hipSpreadMoving: number;
  /** Flinch applied when hit while scoped, radians. */
  flinch: number;
  /** Seconds to raise this weapon when swapped to. */
  swapTime: number;
  /** Muzzle velocity, m/s. Above this threshold we treat shots as hitscan. */
  hitscan: boolean;
}

const TALON: WeaponSpec = {
  id: WeaponId.Talon,
  name: 'MK-7 Talon',
  adsTime: 0.34,
  accuracyLockAt: 0.82,
  cycleTime: 0.9,
  magSize: 5,
  reserveAmmo: 25,
  reloadTime: 2.8,
  reloadTimeEmpty: 3.4,
  damage: {
    [HitboxPart.Head]: 100,
    [HitboxPart.Chest]: 100,
    [HitboxPart.Stomach]: 100,
    [HitboxPart.ArmL]: 70,
    [HitboxPart.ArmR]: 70,
    [HitboxPart.LegL]: 70,
    [HitboxPart.LegR]: 70,
  },
  penetrationDamage: 0.65,
  penetrationCount: 1,
  swayAmplitude: 0.9 * DEG,
  swayFrequency: 0.6,
  swaySettleFactor: 0.25,
  swaySettleTime: 0.7,
  recoilVertical: 3.1 * DEG,
  recoilHorizontal: 0.5 * DEG,
  recoilRecovery: 0.38,
  recoilPunch: 0.08,
  hipSpreadStand: 6.5 * DEG,
  hipSpreadCrouch: 4.0 * DEG,
  hipSpreadMoving: 11.0 * DEG,
  flinch: 2.2 * DEG,
  swapTime: 0.45,
  hitscan: true,
};

const KESTREL: WeaponSpec = {
  id: WeaponId.Kestrel,
  name: 'Kestrel .40',
  adsTime: 0.22,
  accuracyLockAt: 0.6,
  cycleTime: 0.14,
  magSize: 12,
  reserveAmmo: 48,
  reloadTime: 1.6,
  reloadTimeEmpty: 2.1,
  damage: {
    [HitboxPart.Head]: 88, // 40 * 2.2
    [HitboxPart.Chest]: 40,
    [HitboxPart.Stomach]: 40,
    [HitboxPart.ArmL]: 32,
    [HitboxPart.ArmR]: 32,
    [HitboxPart.LegL]: 32,
    [HitboxPart.LegR]: 32,
  },
  penetrationDamage: 0.4,
  penetrationCount: 1,
  swayAmplitude: 0.4 * DEG,
  swayFrequency: 0.9,
  swaySettleFactor: 0.4,
  swaySettleTime: 0.5,
  recoilVertical: 1.1 * DEG,
  recoilHorizontal: 0.35 * DEG,
  recoilRecovery: 0.18,
  recoilPunch: 0.02,
  hipSpreadStand: 3.2 * DEG,
  hipSpreadCrouch: 2.2 * DEG,
  hipSpreadMoving: 5.5 * DEG,
  flinch: 0.9 * DEG,
  swapTime: 0.45,
  hitscan: true,
};

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  [WeaponId.Talon]: TALON,
  [WeaponId.Kestrel]: KESTREL,
  [WeaponId.Knife]: {
    ...KESTREL,
    id: WeaponId.Knife,
    name: 'Knife',
    magSize: 0,
    reserveAmmo: 0,
    cycleTime: 0.6,
    swapTime: 0.3,
  },
};

export const MELEE_RANGE = 2.2;
export const MELEE_TIME = 0.6;
export const MELEE_DAMAGE = 150;

export const MAX_HEALTH = 100;
/** Seconds after last damage before regeneration begins. */
export const HEALTH_REGEN_DELAY = 4.0;
export const HEALTH_REGEN_RATE = 40; // per second

// ---------------------------------------------------------------------------
// Attachments — pure multipliers into the weapon state machine.
// No attachment gets a special case in gameplay code.
// ---------------------------------------------------------------------------

export interface AttachmentSpec {
  id: AttachmentId;
  name: string;
  description: string;
  /** Multiplicative modifiers applied to the base WeaponSpec. */
  mods: Partial<{
    adsTimeMult: number;
    adsTimeAdd: number;
    swayAmplitudeMult: number;
    swaySettleTimeMult: number;
    penetrationDamage: number;
    penetrationCount: number;
    magSizeAdd: number;
    reloadTimeAdd: number;
    damageMult: number;
    hipSpreadMult: number;
    adsMoveSpeed: number;
    recoilMult: number;
    cycleTimeMult: number;
  }>;
  /** Non-numeric behaviour flags read by presentation/scoring systems. */
  flags?: Partial<{
    variableZoom: boolean;
    suppressed: boolean;
    laserVisible: boolean;
    ironSights: boolean;
  }>;
}

export const ATTACHMENTS: Record<AttachmentId, AttachmentSpec> = {
  [AttachmentId.None]: {
    id: AttachmentId.None,
    name: '—',
    description: 'Empty slot.',
    mods: {},
  },
  [AttachmentId.FastDraw]: {
    id: AttachmentId.FastDraw,
    name: 'Fast Draw',
    description: 'Dramatically faster aim-down-sight. The quickscoper pick.',
    mods: { adsTimeMult: 0.62 },
  },
  [AttachmentId.VariableZoom]: {
    id: AttachmentId.VariableZoom,
    name: 'Variable Zoom',
    description: 'Toggle 3.5x / 8x while scoped. Slightly slower to aim.',
    mods: { adsTimeAdd: 0.06 },
    flags: { variableZoom: true },
  },
  [AttachmentId.StabilizerCPU]: {
    id: AttachmentId.StabilizerCPU,
    name: 'Stabilizer CPU',
    description: 'Near-eliminates idle sway and settles twice as fast.',
    mods: { swayAmplitudeMult: 0.25, swaySettleTimeMult: 0.5 },
  },
  [AttachmentId.FMJ]: {
    id: AttachmentId.FMJ,
    name: 'FMJ',
    description: 'Rounds punch through two surfaces with far less falloff.',
    mods: { penetrationDamage: 0.9, penetrationCount: 2 },
  },
  [AttachmentId.ExtendedMag]: {
    id: AttachmentId.ExtendedMag,
    name: 'Extended Mag',
    description: 'Three extra rounds, marginally slower reload.',
    mods: { magSizeAdd: 3, reloadTimeAdd: 0.3 },
  },
  [AttachmentId.Suppressor]: {
    id: AttachmentId.Suppressor,
    name: 'Suppressor',
    description: 'No muzzle direction in the feed. Costs damage and aim speed.',
    mods: { damageMult: 0.9, adsTimeAdd: 0.05 },
    flags: { suppressed: true },
  },
  [AttachmentId.Laser]: {
    id: AttachmentId.Laser,
    name: 'Laser',
    description: 'Much tighter hipfire. Enemies can see the beam.',
    mods: { hipSpreadMult: 0.55 },
    flags: { laserVisible: true },
  },
  [AttachmentId.LightweightStock]: {
    id: AttachmentId.LightweightStock,
    name: 'Lightweight Stock',
    description: 'Move much faster while scoped.',
    mods: { adsMoveSpeed: 3.6 },
  },
  [AttachmentId.IronSightSwap]: {
    id: AttachmentId.IronSightSwap,
    name: 'Iron Sight Swap',
    description: 'Strips the scope. Fastest possible aim, almost no zoom.',
    mods: { adsTimeMult: 0.56 },
    flags: { ironSights: true },
  },
  [AttachmentId.BallisticCompensator]: {
    id: AttachmentId.BallisticCompensator,
    name: 'Ballistic Compensator',
    description: 'Tames recoil and speeds up the bolt.',
    mods: { recoilMult: 0.6, cycleTimeMult: 0.92 },
  },
};

// ---------------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------------

export const MAX_PLAYERS = 12;
export const MIN_PLAYERS_TO_START = 2;

export const FFA_SCORE_LIMIT = 30;
export const TDM_SCORE_LIMIT = 50;
export const MATCH_TIME_LIMIT = 10 * 60;
export const COUNTDOWN_TIME = 5;
export const POST_MATCH_TIME = 15;

export const RESPAWN_DELAY = 2.5;

/** No enemy may be within this radius of a chosen spawn. */
export const SPAWN_MIN_ENEMY_DIST = 12.0;
/** Spawns visible to a living enemy are heavily penalised, not banned. */
export const SPAWN_LOS_PENALTY = 1000;
/** Penalty weight falls off with distance up to this range. */
export const SPAWN_DANGER_RANGE = 30.0;

/** Seconds out of bounds (in the water) before forced respawn. */
export const OOB_COUNTDOWN = 3.0;

// ---------------------------------------------------------------------------
// Trickshot scoring
// ---------------------------------------------------------------------------

/** A shot fired within this window after accuracy lock counts as a quickscope. */
export const QUICKSCOPE_WINDOW = 0.25;
/** Yaw rotation accumulated in the lookback window, in radians. */
export const SPIN_LOOKBACK = 1.5;
export const SPIN_360 = 2 * Math.PI;
export const SPIN_540 = 3 * Math.PI;
export const SPIN_720 = 4 * Math.PI;
export const CROSSMAP_DISTANCE = 45.0;
export const FEED_WINDOW = 12.0;
export const FEED_KILLS = 3;

export const TRICKSHOT_SCORE = {
  base: 100,
  quickscope: 50,
  noscope: 150,
  spin360: 300,
  spin540: 500,
  spin720: 800,
  collateralPerExtraKill: 250,
  crossmap: 200,
  airborne: 75,
  dropshot: 50,
  jumpshot: 50,
  feed: 150,
  headshot: 50,
} as const;

// ---------------------------------------------------------------------------
// Networking budget
// ---------------------------------------------------------------------------

/** Positions quantized to this resolution, in meters (16-bit fixed point). */
export const POS_QUANTIZATION = 1 / 256;
/** World half-extent used by the fixed-point encoding. Must contain the map. */
export const WORLD_HALF_EXTENT = 128;
/** Angles quantized to 16 bits over 2*PI. */
export const ANGLE_QUANTIZATION = (2 * Math.PI) / 65536;

/** Target upstream per client at MAX_PLAYERS, bytes/sec. Enforced by a test. */
export const BANDWIDTH_TARGET_BPS = 12 * 1024;

// ---------------------------------------------------------------------------
// Performance budget
// ---------------------------------------------------------------------------

export const FRAME_BUDGET_MS = 16.6;
export const MAX_PARTICLES = 2000;
export const MAX_DECALS = 128;
export const SHADOW_CASCADES = 3;
export const SHADOW_MAP_SIZE = 2048;
