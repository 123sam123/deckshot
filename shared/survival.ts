/**
 * DECKSHOT — SURVIVAL mode: round curves, economy and rule constants.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * This module is PURE and engine-free, in exactly the sense shared/trickshot.ts
 * is: no time reads, no randomness, no mutation of inputs. Every curve here is
 * unit-tested against the canonical values in the design doc. The server's
 * SurvivalDirector consumes these; the client consumes the constants for HUD
 * and prompts. Neither side invents a number this file does not define.
 */

import { InputButton, WeaponId } from './types.js';
import { TICK_MS } from './tuning.js';

// ---------------------------------------------------------------------------
// Roster and identity
// ---------------------------------------------------------------------------

/** Survival caps at a squad of five. Competitive modes keep MAX_PLAYERS. */
export const MAX_PLAYERS_SURVIVAL = 5;

/** Survival starts solo. Competitive modes keep MIN_PLAYERS_TO_START. */
export const MIN_PLAYERS_SURVIVAL = 1;

/**
 * Zombies share the player snapshot channel, partitioned by id range: players
 * are 1..199 (Lobby.allocatePlayerId is clamped), zombies 200..254.
 */
export const ZOMBIE_ID_BASE = 200;

export function isZombieId(id: number): boolean {
  return id >= ZOMBIE_ID_BASE;
}

/** Hard cap on zombies simulated/replicated at once — canon's cap and our perf budget. */
export const ZOMBIES_ALIVE_MAX = 24;

/**
 * Lag-comp slots: players occupy 0..MAX_PLAYERS-1, zombies MAX_PLAYERS..39.
 * 40 covers 12 players + 28 zombie slots (> ZOMBIES_ALIVE_MAX).
 */
export const MAX_ENTITIES = 40;

/**
 * ScoreKeeper limits for a survival match. Kills and minutes must never end
 * the match — only a squad wipe does — so both sit at the u16 wire ceiling.
 */
export const SURVIVAL_SCORE_LIMIT = 0xffff;
export const SURVIVAL_TIME_LIMIT = 0xffff; // seconds; ~18h

// ---------------------------------------------------------------------------
// Round curves — the three independent axes
// ---------------------------------------------------------------------------

export const ZOMBIE_HEALTH_CAP = 100_000;

/**
 * Canon BO1/BO2 health: 150 at round 1, +100/round through 9, ×1.1 compounding
 * from 10, capped (per BO2-Reimagined) so high rounds test movement, not DPS.
 */
export function healthForRound(round: number): number {
  const r = Math.max(1, Math.floor(round));
  if (r <= 9) return 150 + (r - 1) * 100;
  const h = 950 * Math.pow(1.1, r - 9);
  return Math.min(ZOMBIE_HEALTH_CAP, Math.round(h));
}

/** Total zombies in a round, scaling with round and squad size. */
export function zombiesForRound(round: number, players: number): number {
  const r = Math.max(1, Math.floor(round));
  const p = Math.max(1, Math.min(MAX_PLAYERS_SURVIVAL, Math.floor(players)));
  return Math.floor((6 + r * 2) * (0.55 + 0.45 * p));
}

/** Seconds between spawns, tightening with the round. */
export function spawnInterval(round: number): number {
  const r = Math.max(1, Math.floor(round));
  return Math.max(0.2, 2.0 - r * 0.06);
}

/** Zombie ground speed, m/s. Shamblers early, joggers by ~R8, never sprint-fast. */
export function zombieSpeedForRound(round: number): number {
  const r = Math.max(1, Math.floor(round));
  return Math.min(4.6, 1.8 + r * 0.18);
}

/** Every 5th round from 5: fast, low-health drowned crew. */
export function isRunnerRound(round: number): boolean {
  const r = Math.floor(round);
  return r >= 5 && r % 5 === 0;
}

export const RUNNER_SPEED = 6.2;
export const RUNNER_HEALTH_MULT = 0.35;

/** Seconds between rounds (canon ~10s breather). */
export const INTERMISSION_TIME = 10;

// ---------------------------------------------------------------------------
// Zombie melee
// ---------------------------------------------------------------------------

export const ZOMBIE_MELEE_DAMAGE = 40;
export const ZOMBIE_MELEE_INTERVAL = 1.0;
export const ZOMBIE_MELEE_RANGE = 1.4;

// ---------------------------------------------------------------------------
// Economy — trickshot points ARE Zombies points
// ---------------------------------------------------------------------------

/**
 * evaluateTrickshot() score × this = points. TRICKSHOT_SCORE.base is 100, so a
 * plain body kill pays exactly canon's 50.
 */
export const SURVIVAL_POINT_SCALE = 0.5;

/** Canon pays ~10 per non-lethal bullet hit. */
export const POINTS_PER_HIT = 10;

export const REVIVE_POINTS = 50;

export function pointsForKillScore(trickshotScore: number): number {
  return Math.max(0, Math.round(trickshotScore * SURVIVAL_POINT_SCALE));
}

// ---------------------------------------------------------------------------
// Down and revive
// ---------------------------------------------------------------------------

export const BLEEDOUT_TIME = 30;
export const REVIVE_TIME = 3.5;
export const REVIVE_RADIUS = 1.6;
/** Corpsman revives 4x faster. */
export const CORPSMAN_REVIVE_MULT = 0.25;
/** Solo Corpsman: self-revive after this many seconds, three times per match. */
export const SOLO_REVIVE_DELAY = 10;
export const SOLO_REVIVE_USES = 3;
/** Health restored on revive. */
export const REVIVE_HEALTH = 50;

/**
 * Input mask while downed: no jumping, sprinting, sliding or weapon swapping —
 * you crawl and you shoot the pistol. BOTH sides apply this (server before
 * simulation, client before prediction) so prediction stays honest while down.
 */
export function filterDownedButtons(buttons: number): number {
  return (
    buttons &
    ~(
      InputButton.Jump |
      InputButton.Crouch |
      InputButton.Sprint |
      InputButton.SwapWeapon |
      InputButton.Melee
    )
  );
}

// ---------------------------------------------------------------------------
// Perks
// ---------------------------------------------------------------------------

export enum PerkId {
  Deadeye = 0, // health 100 -> 250
  Quickhands = 1, // reload x0.5
  Doubletap = 2, // damage x1.8
  Corpsman = 3, // revive 4x faster; solo self-revive x3
  SteadyHand = 4, // ADS time x0.5 — never touches accuracyLockAt
}

export const PERK_COUNT = 5;
export const MAX_PERKS = 4;

export const PERK_COSTS: Record<PerkId, number> = {
  [PerkId.Deadeye]: 2500,
  [PerkId.Quickhands]: 3000,
  [PerkId.Doubletap]: 2000,
  [PerkId.Corpsman]: 1500,
  [PerkId.SteadyHand]: 2000,
};

/** Corpsman is cheap when you have nobody to pick you up. */
export const PERK_COST_CORPSMAN_SOLO = 500;

export const PERK_NAMES: Record<PerkId, string> = {
  [PerkId.Deadeye]: 'DEADEYE',
  [PerkId.Quickhands]: 'QUICKHANDS',
  [PerkId.Doubletap]: 'DOUBLETAP',
  [PerkId.Corpsman]: 'CORPSMAN',
  [PerkId.SteadyHand]: 'STEADY HAND',
};

export const MAX_HEALTH_DEADEYE = 250;

export const DEADEYE_BIT = 1 << PerkId.Deadeye;
export const QUICKHANDS_BIT = 1 << PerkId.Quickhands;
export const DOUBLETAP_BIT = 1 << PerkId.Doubletap;
export const CORPSMAN_BIT = 1 << PerkId.Corpsman;
export const STEADYHAND_BIT = 1 << PerkId.SteadyHand;

export function hasPerk(perks: number, perk: PerkId): boolean {
  return (perks & (1 << perk)) !== 0;
}

export function perkCount(perks: number): number {
  let n = 0;
  for (let i = 0; i < PERK_COUNT; i++) if ((perks & (1 << i)) !== 0) n++;
  return n;
}

export function maxHealthForPerks(perks: number): number {
  return hasPerk(perks, PerkId.Deadeye) ? MAX_HEALTH_DEADEYE : 100;
}

// ---------------------------------------------------------------------------
// Upgrades and crate
// ---------------------------------------------------------------------------

/** The Forge — Pack-a-Punch equivalent. */
export const FORGE_COST = 5000;
export const FORGE_DAMAGE_MULT = 2.5;
export const DOUBLETAP_DAMAGE_MULT = 1.8;
export const ZOMBIE_HEADSHOT_MULT = 2.5;

export const CRATE_COST = 950;
export const CRATE_MOVE_USES_MIN = 4;
export const CRATE_MOVE_USES_MAX = 8;
/** Weapons the crate can hand out. */
export const CRATE_POOL: readonly WeaponId[] = [
  WeaponId.Osprey,
  WeaponId.Shrike,
  WeaponId.Condor,
  WeaponId.Harrier,
  WeaponId.Talon,
];

/** Wall-buy prices. Ammo re-buy is half the wall price. */
export const WALL_BUY_COST: Partial<Record<WeaponId, number>> = {
  [WeaponId.Osprey]: 500,
  [WeaponId.Shrike]: 900,
  [WeaponId.Talon]: 1200,
  [WeaponId.Condor]: 1500,
  [WeaponId.Harrier]: 1200,
};

export function ammoCostFor(weapon: WeaponId): number {
  const wall = WALL_BUY_COST[weapon];
  return wall === undefined ? 0 : Math.floor(wall / 2);
}

// ---------------------------------------------------------------------------
// Power-ups
// ---------------------------------------------------------------------------

export enum PowerupId {
  MaxAmmo = 0,
  InstaKill = 1,
  DoublePoints = 2,
  Nuke = 3,
  Carpenter = 4,
}

export const POWERUP_DURATION = 30;
/** Chance per zombie kill of dropping a power-up. */
export const POWERUP_CHANCE = 0.02;
/** A Max Ammo is guaranteed every this many rounds. */
export const GUARANTEED_MAX_AMMO_EVERY = 10;
/** Points every living player receives from a Nuke. */
export const NUKE_POINTS = 400;

export const POWERUP_NAMES: Record<PowerupId, string> = {
  [PowerupId.MaxAmmo]: 'MAX AMMO',
  [PowerupId.InstaKill]: 'INSTA-KILL',
  [PowerupId.DoublePoints]: 'DOUBLE POINTS',
  [PowerupId.Nuke]: 'NUKE',
  [PowerupId.Carpenter]: 'CARPENTER',
};

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

export enum PurchaseKind {
  Zone = 0,
  Weapon = 1, // wall buy, or ammo re-buy when already owned
  Perk = 2,
  Forge = 3,
  Crate = 4,
}

export enum InteractTarget {
  Generator = 0,
  CrateTake = 1,
}

export enum SurvivalPhase {
  Intermission = 0,
  Wave = 1,
}

export interface PurchaseContext {
  balance: number;
  /** Bit per zone index. */
  zoneMask: number;
  powerOn: boolean;
  perks: number;
  /** Weapons the buyer already carries. */
  ownedWeapons: readonly WeaponId[];
  forged: boolean;
  /** Living squad size, for the Corpsman solo price. */
  playerCount: number;
}

export interface PurchaseVerdict {
  ok: boolean;
  cost: number;
  reason?: string;
}

const deny = (reason: string): PurchaseVerdict => ({ ok: false, cost: 0, reason });

/**
 * Pure purchase validation: can this purchase happen, and what does it cost?
 * Zone COST and power gating are the map's data, so the zone variant takes the
 * candidate zone's cost/powered flags from the caller; everything else is
 * priced here.
 */
export function validatePurchase(
  kind: PurchaseKind,
  itemId: number,
  ctx: PurchaseContext,
  zone?: { cost: number; requiresPower: boolean; open: boolean; reachable: boolean },
): PurchaseVerdict {
  switch (kind) {
    case PurchaseKind.Zone: {
      if (!zone) return deny('no such zone');
      if (zone.open) return deny('already open');
      if (!zone.reachable) return deny('not adjacent to an open zone');
      if (zone.requiresPower && !ctx.powerOn) return deny('needs power');
      if (ctx.balance < zone.cost) return deny('cannot afford');
      return { ok: true, cost: zone.cost };
    }
    case PurchaseKind.Weapon: {
      const weapon = itemId as WeaponId;
      const wall = WALL_BUY_COST[weapon];
      if (wall === undefined) return deny('not a wall buy');
      const owned = ctx.ownedWeapons.includes(weapon);
      const cost = owned ? ammoCostFor(weapon) : wall;
      if (ctx.balance < cost) return deny('cannot afford');
      return { ok: true, cost };
    }
    case PurchaseKind.Perk: {
      const perk = itemId as PerkId;
      if (!(perk >= 0 && perk < PERK_COUNT)) return deny('no such perk');
      if (!ctx.powerOn) return deny('needs power');
      if (hasPerk(ctx.perks, perk)) return deny('already owned');
      if (perkCount(ctx.perks) >= MAX_PERKS) return deny('perk limit');
      const cost =
        perk === PerkId.Corpsman && ctx.playerCount <= 1 ? PERK_COST_CORPSMAN_SOLO : PERK_COSTS[perk];
      if (ctx.balance < cost) return deny('cannot afford');
      return { ok: true, cost };
    }
    case PurchaseKind.Forge: {
      if (!ctx.powerOn) return deny('needs power');
      if (ctx.forged) return deny('already forged');
      if (ctx.balance < FORGE_COST) return deny('cannot afford');
      return { ok: true, cost: FORGE_COST };
    }
    case PurchaseKind.Crate: {
      if (ctx.balance < CRATE_COST) return deny('cannot afford');
      return { ok: true, cost: CRATE_COST };
    }
    default:
      return deny('unknown purchase');
  }
}

/**
 * Damage multiplier a survival player's bullet applies to a zombie.
 * Doubletap and The Forge multiply; Insta-Kill overrides everything.
 */
export function zombieDamageMult(
  perks: number,
  forged: boolean,
  isHead: boolean,
  instaKill: boolean,
): number {
  if (instaKill) return 1e6;
  let m = 1;
  if (hasPerk(perks, PerkId.Doubletap)) m *= DOUBLETAP_DAMAGE_MULT;
  if (forged) m *= FORGE_DAMAGE_MULT;
  if (isHead) m *= ZOMBIE_HEADSHOT_MULT;
  return m;
}

/** How many sim ticks between zombie spawns at a given round. */
export function spawnIntervalTicks(round: number): number {
  return Math.max(1, Math.round((spawnInterval(round) * 1000) / TICK_MS));
}

/** The spec fields perks and The Forge are allowed to touch. */
export interface SurvivalWeaponMods {
  reloadTime: number;
  reloadTimeEmpty: number;
  adsTime: number;
  magSize: number;
}

/**
 * Fold a player's perk/Forge modifiers into a resolved weapon spec. BOTH sides
 * call this (server authoritatively, client for prediction) so reload and ADS
 * timings agree tick for tick.
 *
 * STEADY HAND halves `adsTime` and nothing else. `accuracyLockAt` is carried
 * through by the spread untouched — the 0.82 rule is not a build choice.
 */
export function applySurvivalWeaponMods<T extends SurvivalWeaponMods>(
  base: T,
  perks: number,
  forged: boolean,
): T {
  const quick = hasPerk(perks, PerkId.Quickhands);
  const steady = hasPerk(perks, PerkId.SteadyHand);
  if (!quick && !steady && !forged) return base;
  return {
    ...base,
    reloadTime: base.reloadTime * (quick ? 0.5 : 1),
    reloadTimeEmpty: base.reloadTimeEmpty * (quick ? 0.5 : 1),
    adsTime: base.adsTime * (steady ? 0.5 : 1),
    magSize: forged ? Math.round(base.magSize * 1.5) : base.magSize,
  };
}
