/**
 * DECKSHOT — ZOMBIES mode: every constant, curve and pure rule.
 *
 * Owner: zombies (full rewrite; replaces the deleted shared/survival.ts).
 *
 * Engine-free and side-effect free: no time, no randomness, no mutation.
 * The server director and the client HUD/prediction import the SAME numbers
 * from here, so a cost shown on a prompt can never disagree with the cost
 * charged. Design values are pinned by tests/zombies.test.ts — change a
 * number here and the test that quotes ZOMBIES.md fails on purpose.
 */

import { InputButton, WeaponId, type HitboxPart } from './types.js';

// ---------------------------------------------------------------------------
// Squad and entity partition
// ---------------------------------------------------------------------------

/** Canon squad size. The lobby refuses a 5th seat in this mode. */
export const MAX_PLAYERS_ZOMBIES = 4;
export const MIN_PLAYERS_ZOMBIES = 1;

/**
 * Entity id partition: players are 1..199 (enforced by the lobby allocator),
 * the horde is ZOMBIE_ID_BASE.. on the same snapshot channel. Ids are u8 on
 * the wire, so the whole partition must stay under 255.
 */
export const ZOMBIE_ID_BASE = 200;
export const isZombieId = (id: number): boolean => id >= ZOMBIE_ID_BASE;

/** Canon's concurrent cap — and our render/bandwidth budget. */
export const ZOMBIES_ALIVE_MAX = 24;
/** Pool headroom so a death mid-tick never blocks a pending spawn. */
export const ZOMBIE_POOL_SIZE = ZOMBIES_ALIVE_MAX + 4;
/** Lag-comp ring width: MAX_PLAYERS player slots + the zombie pool. */
export const MAX_ENTITIES = 40;

/** Round/score limits pinned so the generic phase machine can never end us. */
export const ZOMBIES_SCORE_LIMIT = 0xffff;
export const ZOMBIES_TIME_LIMIT = 0xffff;

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

export enum ZombiesPhase {
  /** Between rounds; timeRemaining counts down to the next wave. */
  Intermission = 0,
  Wave = 1,
}

export const INTERMISSION_TIME = 10;
/** The opening breather before round 1 is shorter — get moving. */
export const FIRST_INTERMISSION = 3;

export const ZOMBIE_HEALTH_CAP = 100_000;

/** Canon curve: +100/round through 9, then x1.1 compounding, capped. */
export function healthForRound(round: number): number {
  if (round <= 9) return 150 + (round - 1) * 100;
  const h = Math.round(950 * Math.pow(1.1, round - 9));
  return Math.min(ZOMBIE_HEALTH_CAP, h);
}

const COUNT_MULT = [1, 1.55, 1.95, 2.3] as const;

/** Total zombies in a round. Quadratic late growth, gentle early rounds. */
export function zombiesForRound(round: number, players: number): number {
  const p = Math.min(Math.max(1, players), MAX_PLAYERS_ZOMBIES);
  const base = 6 + 0.85 * round + 0.075 * round * round;
  return Math.floor(base * COUNT_MULT[p - 1]);
}

/** Seconds between spawn attempts while the round has zombies left to field. */
export function spawnInterval(round: number): number {
  return Math.max(0.35, 2.2 - round * 0.06);
}

export function spawnIntervalTicks(round: number, tickRate: number): number {
  return Math.max(1, Math.round(spawnInterval(round) * tickRate));
}

// --- Speed cohorts -----------------------------------------------------------

export enum ZombieGait {
  Walker = 0,
  Jogger = 1,
  Runner = 2,
  /** Blood Fog rounds only. */
  Sprinter = 3,
}

export const GAIT_SPEED: Record<ZombieGait, number> = {
  [ZombieGait.Walker]: 1.7,
  [ZombieGait.Jogger]: 3.0,
  [ZombieGait.Runner]: 4.6,
  [ZombieGait.Sprinter]: 6.2,
};

/** Fraction of runners in a normal round. */
export function runnerFraction(round: number): number {
  return Math.min(0.75, Math.max(0, (round - 3) * 0.09));
}

/** Fraction of joggers (walkers make up the remainder). */
export function joggerFraction(round: number): number {
  const jog = Math.min(0.6, Math.max(0, 0.2 + round * 0.05));
  return Math.min(jog, 1 - runnerFraction(round));
}

/**
 * Deterministic cohort pick from a 0..1 roll: runners claim the top of the
 * range, joggers the middle, walkers the rest.
 */
export function gaitForRoll(round: number, roll: number): ZombieGait {
  if (isFogRound(round)) return ZombieGait.Sprinter;
  const run = runnerFraction(round);
  const jog = joggerFraction(round);
  if (roll < run) return ZombieGait.Runner;
  if (roll < run + jog) return ZombieGait.Jogger;
  return ZombieGait.Walker;
}

// --- Blood Fog rounds --------------------------------------------------------

/** Every 5th round from 5: a sprinting horde of frail bodies, red fog. */
export function isFogRound(round: number): boolean {
  return round >= 5 && round % 5 === 0;
}

export const FOG_HEALTH_MULT = 0.35;

// ---------------------------------------------------------------------------
// Zombie melee
// ---------------------------------------------------------------------------

export const ZOMBIE_MELEE_DAMAGE = 40;
/** Seconds of telegraphed wind-up before the damage lands. */
export const ZOMBIE_MELEE_WINDUP = 0.35;
/** Seconds between swings. */
export const ZOMBIE_MELEE_INTERVAL = 0.9;
export const ZOMBIE_MELEE_REACH = 1.5;
/** Max |dy| for a swing to connect — no hitting through decks. */
export const ZOMBIE_MELEE_REACH_Y = 1.6;
/** Grace period after spawning before the first swing can start. */
export const ZOMBIE_FIRST_SWING_DELAY = 0.5;

// ---------------------------------------------------------------------------
// Economy — canon flat payouts
// ---------------------------------------------------------------------------

export const POINTS_START = 500;
export const POINTS_HIT = 10;
export const POINTS_KILL = 60;
export const POINTS_KILL_HEAD = 100;
export const POINTS_KILL_KNIFE = 130;
export const POINTS_REVIVE = 50;
export const POINTS_NUKE = 400;
export const POINTS_CARPENTER = 200;
export const POINTS_REPAIR = 10;
/** Repair income cap per player per round. */
export const REPAIR_BUDGET_PER_ROUND = 100;

export function killPoints(part: HitboxPart, melee: boolean): number {
  if (melee) return POINTS_KILL_KNIFE;
  // HitboxPart.Head === 0; avoid importing the enum value into hot paths.
  return part === 0 ? POINTS_KILL_HEAD : POINTS_KILL;
}

// ---------------------------------------------------------------------------
// Wall buys, mystery box, the Forge
// ---------------------------------------------------------------------------

export const WALL_COSTS: Partial<Record<WeaponId, number>> = {
  [WeaponId.Osprey]: 500,
  [WeaponId.Shrike]: 900,
  [WeaponId.Harrier]: 1200,
  [WeaponId.Talon]: 1400,
  [WeaponId.Condor]: 1750,
};

/** Wall ammo refill is half the gun; a forged gun's ammo costs flat 4500. */
export const FORGED_AMMO_COST = 4500;
export function ammoCostFor(weapon: WeaponId, forged: boolean): number {
  if (forged) return FORGED_AMMO_COST;
  const wall = WALL_COSTS[weapon];
  return wall === undefined ? 0 : Math.floor(wall / 2);
}

export const BOX_COST = 950;
export const BOX_POOL: readonly WeaponId[] = [
  WeaponId.Talon,
  WeaponId.Osprey,
  WeaponId.Shrike,
  WeaponId.Condor,
  WeaponId.Harrier,
];
/** Seconds a rolled weapon waits in the box lid before it is withdrawn. */
export const BOX_OFFER_TIME = 12;
/** Seeded uses before the box relocates to the other spot. */
export const BOX_MOVE_USES_MIN = 4;
export const BOX_MOVE_USES_MAX = 8;

export const FORGE_COST = 5000;
export const FORGE_DAMAGE_MULT = 2.0;
export const FORGE_MAG_MULT = 2.0;
export const FORGE_RESERVE_MULT = 2.0;

/** Headshots against the horde. */
export const ZOMBIE_HEADSHOT_MULT = 2.5;

// ---------------------------------------------------------------------------
// Perks — one machine per zone, all need power, max 4, lost on down
// ---------------------------------------------------------------------------

export enum PerkId {
  Bulwark = 0, // max health 250
  Handloader = 1, // reload x0.5
  SecondWind = 2, // revive x2 speed; solo self-revive
  Adrenaline = 3, // move speed x1.07
  HairTrigger = 4, // damage x2
}

export const PERK_COUNT = 5;
export const MAX_PERKS = 4;

export const PERK_COSTS: Record<PerkId, number> = {
  [PerkId.Bulwark]: 2500,
  [PerkId.Handloader]: 3000,
  [PerkId.SecondWind]: 1500,
  [PerkId.Adrenaline]: 2000,
  [PerkId.HairTrigger]: 2000,
};

/** SECOND WIND is cheap when you have nobody to pick you up. */
export const PERK_COST_SECOND_WIND_SOLO = 500;

export const PERK_NAMES: Record<PerkId, string> = {
  [PerkId.Bulwark]: 'BULWARK',
  [PerkId.Handloader]: 'HANDLOADER',
  [PerkId.SecondWind]: 'SECOND WIND',
  [PerkId.Adrenaline]: 'ADRENALINE',
  [PerkId.HairTrigger]: 'HAIR TRIGGER',
};

export const hasPerk = (perks: number, perk: PerkId): boolean => (perks & (1 << perk)) !== 0;

export function perkCount(perks: number): number {
  let n = 0;
  for (let p = 0; p < PERK_COUNT; p++) if (perks & (1 << p)) n++;
  return n;
}

export const MAX_HEALTH_BASE = 100;
export const MAX_HEALTH_BULWARK = 250;

export function maxHealthForPerks(perks: number): number {
  return hasPerk(perks, PerkId.Bulwark) ? MAX_HEALTH_BULWARK : MAX_HEALTH_BASE;
}

export const ADRENALINE_SPEED_MULT = 1.07;

/** The optional PlayerState.speedMult both sides must agree on. */
export function speedMultForPerks(perks: number): number {
  return hasPerk(perks, PerkId.Adrenaline) ? ADRENALINE_SPEED_MULT : 1;
}

export const HAIR_TRIGGER_DAMAGE_MULT = 2.0;

/** The structural subset of a weapon spec the mode is allowed to modify. */
export interface ZombiesWeaponMods {
  reloadTime: number;
  reloadTimeEmpty: number;
  magSize: number;
  reserveAmmo: number;
}

/**
 * Weapon-spec mods that must run identically in client prediction and on the
 * server: HANDLOADER's reload halving and the Forge's magazine growth.
 * Damage is server-only (zombieDamageMult) and deliberately NOT here.
 * accuracyLockAt is spread through untouched — it is the game's one sacred
 * number and no perk may move it (pinned by test).
 */
export function applyZombiesWeaponMods<T extends ZombiesWeaponMods>(
  base: T,
  perks: number,
  forged: boolean,
): T {
  const handloader = hasPerk(perks, PerkId.Handloader);
  if (!handloader && !forged) return base;
  return {
    ...base,
    reloadTime: base.reloadTime * (handloader ? 0.5 : 1),
    reloadTimeEmpty: base.reloadTimeEmpty * (handloader ? 0.5 : 1),
    magSize: forged ? Math.round(base.magSize * FORGE_MAG_MULT) : base.magSize,
    reserveAmmo: forged ? Math.round(base.reserveAmmo * FORGE_RESERVE_MULT) : base.reserveAmmo,
  };
}

/** Damage multiplier stack for a bullet into a zombie. */
export function zombieDamageMult(
  perks: number,
  forged: boolean,
  headshot: boolean,
  instaKill: boolean,
): number {
  if (instaKill) return 1e6;
  let m = 1;
  if (hasPerk(perks, PerkId.HairTrigger)) m *= HAIR_TRIGGER_DAMAGE_MULT;
  if (forged) m *= FORGE_DAMAGE_MULT;
  if (headshot) m *= ZOMBIE_HEADSHOT_MULT;
  return m;
}

// ---------------------------------------------------------------------------
// Power-up drops — real pickup entities
// ---------------------------------------------------------------------------

export enum PowerupId {
  MaxAmmo = 0,
  InstaKill = 1,
  DoublePoints = 2,
  Nuke = 3,
  Carpenter = 4,
}

export const POWERUP_NAMES: Record<PowerupId, string> = {
  [PowerupId.MaxAmmo]: 'MAX AMMO',
  [PowerupId.InstaKill]: 'INSTA-KILL',
  [PowerupId.DoublePoints]: 'DOUBLE POINTS',
  [PowerupId.Nuke]: 'NUKE',
  [PowerupId.Carpenter]: 'CARPENTER',
};

/** Chance a kill drops a power-up. */
export const POWERUP_CHANCE = 0.02;
/** Seconds a drop lies on the deck before fading out. */
export const DROP_LIFETIME = 30;
/** Blink warning window at the end of a drop's life. */
export const DROP_BLINK_TIME = 8;
/** Walk-over pickup radius. */
export const DROP_RADIUS = 1.2;
export const MAX_DROPS = 4;
/** Seconds Insta-Kill and Double Points stay active. */
export const POWERUP_DURATION = 30;

// ---------------------------------------------------------------------------
// Window barriers
// ---------------------------------------------------------------------------

export const PLANKS_MAX = 6;
/** Seconds per plank a zombie spends tearing. */
export const PLANK_TEAR_INTERVAL = 1.2;
/** Seconds per plank a player spends rebuilding (holding Use). */
export const PLANK_REPAIR_INTERVAL = 0.8;
/** Repair reach from the inside face of the window. */
export const REPAIR_RADIUS = 2.0;

// ---------------------------------------------------------------------------
// Downs, revives, the wipe
// ---------------------------------------------------------------------------

export const BLEEDOUT_TIME = 40;
export const REVIVE_TIME = 3.75;
export const REVIVE_RADIUS = 2.0;
export const REVIVE_HEALTH = 50;
/** SECOND WIND revives others in half the time. */
export const SECOND_WIND_REVIVE_MULT = 0.5;
/** Solo SECOND WIND: automatic self-revive after this many seconds down. */
export const SOLO_REVIVE_DELAY = 10;
export const SOLO_REVIVE_USES = 3;

/**
 * Input mask while downed: crawl and shoot the pistol, nothing else. Applied
 * by BOTH the server sim and client prediction so the crawl never desyncs.
 */
export function filterDownedButtons(buttons: number): number {
  return (
    buttons &
    (InputButton.Fire | InputButton.Ads | InputButton.Reload | InputButton.Use)
  );
}

// ---------------------------------------------------------------------------
// Purchases and interactions (wire vocabulary for opcodes 13/14)
// ---------------------------------------------------------------------------

export enum PurchaseKind {
  /** itemId = zone index. */
  Zone = 0,
  /** itemId = WeaponId; wall buy if not owned, ammo refill if owned. */
  Weapon = 1,
  /** itemId = PerkId. */
  Perk = 2,
  /** Upgrade the held weapon. itemId ignored. */
  Forge = 3,
  /** Spin the mystery box. itemId ignored. */
  Box = 4,
}

export enum InteractTarget {
  /** Flip the power switch. */
  Power = 0,
  /** Take the weapon the box rolled for you. */
  BoxTake = 1,
}

/** Interaction reach for machines, wall buys, the box and the switch. */
export const INTERACT_RADIUS = 3.0;
/** Doors are bought from either side of a wider threshold. */
export const DOOR_BUY_RADIUS = 4.0;

export interface PurchaseContext {
  kind: PurchaseKind;
  itemId: number;
  points: number;
  perks: number;
  powerOn: boolean;
  zoneMask: number;
  /** Zones adjacent-open to the target zone (precomputed by the caller). */
  zoneReachable: boolean;
  /** Player already owns this weapon (Weapon purchases). */
  ownsWeapon: boolean;
  /** The held weapon has already been through the Forge (Forge purchases). */
  heldForged: boolean;
  /** Solo lobby (SECOND WIND price break). */
  solo: boolean;
  /** A box spin is already in progress or an offer is waiting. */
  boxBusy: boolean;
  /** Cost of the target zone's door (Zone purchases). */
  zoneCost: number;
}

export interface PurchaseVerdict {
  ok: boolean;
  cost: number;
  reason?:
    | 'poor'
    | 'owned'
    | 'power'
    | 'unreachable'
    | 'perk-limit'
    | 'busy'
    | 'invalid';
}

/**
 * The one purchase rulebook. The server enforces it authoritatively; the
 * client runs the same function to decide whether a prompt gets its [F].
 * Position/radius checks are the caller's job — this is the rules, not the
 * geometry.
 */
export function validatePurchase(ctx: PurchaseContext): PurchaseVerdict {
  switch (ctx.kind) {
    case PurchaseKind.Zone: {
      if ((ctx.zoneMask & (1 << ctx.itemId)) !== 0) return { ok: false, cost: 0, reason: 'owned' };
      if (!ctx.zoneReachable) return { ok: false, cost: ctx.zoneCost, reason: 'unreachable' };
      if (ctx.points < ctx.zoneCost) return { ok: false, cost: ctx.zoneCost, reason: 'poor' };
      return { ok: true, cost: ctx.zoneCost };
    }
    case PurchaseKind.Weapon: {
      const weapon = ctx.itemId as WeaponId;
      const wall = WALL_COSTS[weapon];
      if (wall === undefined) return { ok: false, cost: 0, reason: 'invalid' };
      const cost = ctx.ownsWeapon ? ammoCostFor(weapon, ctx.heldForged) : wall;
      if (ctx.points < cost) return { ok: false, cost, reason: 'poor' };
      return { ok: true, cost };
    }
    case PurchaseKind.Perk: {
      const perk = ctx.itemId as PerkId;
      if (perk < 0 || perk >= PERK_COUNT) return { ok: false, cost: 0, reason: 'invalid' };
      if (!ctx.powerOn) return { ok: false, cost: 0, reason: 'power' };
      if (hasPerk(ctx.perks, perk)) return { ok: false, cost: 0, reason: 'owned' };
      const cost =
        perk === PerkId.SecondWind && ctx.solo ? PERK_COST_SECOND_WIND_SOLO : PERK_COSTS[perk];
      if (perkCount(ctx.perks) >= MAX_PERKS) return { ok: false, cost, reason: 'perk-limit' };
      if (ctx.points < cost) return { ok: false, cost, reason: 'poor' };
      return { ok: true, cost };
    }
    case PurchaseKind.Forge: {
      if (!ctx.powerOn) return { ok: false, cost: FORGE_COST, reason: 'power' };
      if (ctx.heldForged) return { ok: false, cost: FORGE_COST, reason: 'owned' };
      if (ctx.points < FORGE_COST) return { ok: false, cost: FORGE_COST, reason: 'poor' };
      return { ok: true, cost: FORGE_COST };
    }
    case PurchaseKind.Box: {
      if (ctx.boxBusy) return { ok: false, cost: BOX_COST, reason: 'busy' };
      if (ctx.points < BOX_COST) return { ok: false, cost: BOX_COST, reason: 'poor' };
      return { ok: true, cost: BOX_COST };
    }
    default:
      return { ok: false, cost: 0, reason: 'invalid' };
  }
}

// ---------------------------------------------------------------------------
// Zombie AI tuning
// ---------------------------------------------------------------------------

/** Inside this flat range (and near-level), skip the graph and walk straight. */
export const DIRECT_CHASE_RANGE = 10;
export const DIRECT_CHASE_MAX_DY = 1.2;
/** Ticks between repaths (0.8 s at 60 Hz). */
export const REPATH_TICKS = 48;
/** Horde-wide budget of graph queries per tick. */
export const REPATHS_PER_TICK = 4;
/** A waypoint counts as reached inside this horizontal distance. */
export const WAYPOINT_RADIUS = 0.8;
/** Fall speed when walked off an edge. */
export const ZOMBIE_FALL_SPEED = 12;
/** Step-up and drop-down probe heights for ground snapping. */
export const ZOMBIE_STEP_UP = 0.5;
export const ZOMBIE_DROP_DOWN = 2.0;
