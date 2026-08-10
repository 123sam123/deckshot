/**
 * DECKSHOT — SURVIVAL round curves, economy and purchase validation.
 *
 * Owner: survival. These pin the canonical numbers from the design doc: the
 * curves are the mode's difficulty contract, and the purchase validator is the
 * economy's anti-cheat floor.
 */

import { describe, expect, it } from 'vitest';

import {
  BLEEDOUT_TIME,
  CRATE_COST,
  FORGE_COST,
  MAX_PERKS,
  PERK_COSTS,
  PERK_COST_CORPSMAN_SOLO,
  PerkId,
  PurchaseKind,
  REVIVE_TIME,
  SURVIVAL_POINT_SCALE,
  WALL_BUY_COST,
  ZOMBIE_HEALTH_CAP,
  ammoCostFor,
  applySurvivalWeaponMods,
  filterDownedButtons,
  hasPerk,
  healthForRound,
  isRunnerRound,
  isZombieId,
  maxHealthForPerks,
  perkCount,
  pointsForKillScore,
  spawnInterval,
  validatePurchase,
  zombieDamageMult,
  zombiesForRound,
  type PurchaseContext,
} from '../shared/survival.js';
import { TRICKSHOT_SCORE, WEAPONS } from '../shared/tuning.js';
import { HitboxPart, InputButton, WeaponId } from '../shared/types.js';
import { resolveWeapon } from '../shared/weapons.js';

// ---------------------------------------------------------------------------
// Round curves
// ---------------------------------------------------------------------------

describe('round curves', () => {
  it('health follows canon: 150 at R1, +100/round to R9, x1.1 from R10', () => {
    expect(healthForRound(1)).toBe(150);
    expect(healthForRound(2)).toBe(250);
    expect(healthForRound(9)).toBe(950);
    expect(healthForRound(10)).toBe(Math.round(950 * 1.1));
    expect(healthForRound(20)).toBe(Math.round(950 * 1.1 ** 11));
  });

  it('health caps at 100,000 so high rounds stay winnable by movement', () => {
    expect(healthForRound(60)).toBeLessThanOrEqual(ZOMBIE_HEALTH_CAP);
    expect(healthForRound(200)).toBe(ZOMBIE_HEALTH_CAP);
  });

  it('zombie counts match the design table', () => {
    expect(zombiesForRound(1, 5)).toBe(22);
    expect(zombiesForRound(10, 5)).toBe(72);
    expect(zombiesForRound(20, 5)).toBe(128);
    // Solo is meaningfully lighter than a full squad.
    expect(zombiesForRound(1, 1)).toBe(8);
    expect(zombiesForRound(1, 1)).toBeLessThan(zombiesForRound(1, 5));
  });

  it('spawn interval tightens from ~2s toward the 0.2s floor', () => {
    expect(spawnInterval(1)).toBeCloseTo(1.94, 5);
    expect(spawnInterval(30)).toBeCloseTo(0.2, 5);
    expect(spawnInterval(90)).toBeCloseTo(0.2, 5);
    expect(spawnInterval(90)).toBeGreaterThanOrEqual(0.2);
  });

  it('every 5th round from 5 is a runner round', () => {
    expect(isRunnerRound(4)).toBe(false);
    expect(isRunnerRound(5)).toBe(true);
    expect(isRunnerRound(7)).toBe(false);
    expect(isRunnerRound(10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

describe('economy', () => {
  it('a plain body kill pays exactly canon 50 points', () => {
    expect(pointsForKillScore(TRICKSHOT_SCORE.base)).toBe(TRICKSHOT_SCORE.base * SURVIVAL_POINT_SCALE);
    expect(pointsForKillScore(100)).toBe(50);
  });

  it('zombie id partition: players 1..199, horde 200+', () => {
    expect(isZombieId(199)).toBe(false);
    expect(isZombieId(200)).toBe(true);
    expect(isZombieId(254)).toBe(true);
  });

  it('ammo re-buys are half the wall price', () => {
    expect(ammoCostFor(WeaponId.Osprey)).toBe(Math.floor((WALL_BUY_COST[WeaponId.Osprey] ?? 0) / 2));
    expect(ammoCostFor(WeaponId.Talon)).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// Purchase validation
// ---------------------------------------------------------------------------

const baseCtx = (over: Partial<PurchaseContext> = {}): PurchaseContext => ({
  balance: 100_000,
  zoneMask: 1,
  powerOn: false,
  perks: 0,
  ownedWeapons: [],
  forged: false,
  playerCount: 2,
  ...over,
});

describe('purchase validation', () => {
  it('cannot buy what you cannot afford', () => {
    const v = validatePurchase(PurchaseKind.Weapon, WeaponId.Osprey, baseCtx({ balance: 100 }));
    expect(v.ok).toBe(false);
  });

  it('cannot buy a zone twice, from nowhere, or unpowered', () => {
    const zone = { cost: 750, requiresPower: false, open: false, reachable: true };
    expect(validatePurchase(PurchaseKind.Zone, 1, baseCtx(), { ...zone, open: true }).ok).toBe(false);
    expect(validatePurchase(PurchaseKind.Zone, 1, baseCtx(), { ...zone, reachable: false }).ok).toBe(false);
    expect(
      validatePurchase(PurchaseKind.Zone, 4, baseCtx(), { ...zone, requiresPower: true }).ok,
    ).toBe(false);
    expect(
      validatePurchase(PurchaseKind.Zone, 4, baseCtx({ powerOn: true }), { ...zone, requiresPower: true })
        .ok,
    ).toBe(true);
    const ok = validatePurchase(PurchaseKind.Zone, 1, baseCtx(), zone);
    expect(ok.ok).toBe(true);
    expect(ok.cost).toBe(750);
  });

  it('perks need power, cap at four, and never sell twice', () => {
    expect(validatePurchase(PurchaseKind.Perk, PerkId.Deadeye, baseCtx()).ok).toBe(false); // no power
    const powered = baseCtx({ powerOn: true });
    const ok = validatePurchase(PurchaseKind.Perk, PerkId.Deadeye, powered);
    expect(ok.ok).toBe(true);
    expect(ok.cost).toBe(PERK_COSTS[PerkId.Deadeye]);
    expect(
      validatePurchase(PurchaseKind.Perk, PerkId.Deadeye, baseCtx({ powerOn: true, perks: 1 << PerkId.Deadeye })).ok,
    ).toBe(false);
    const fourPerks = (1 << PerkId.Deadeye) | (1 << PerkId.Quickhands) | (1 << PerkId.Doubletap) | (1 << PerkId.Corpsman);
    expect(perkCount(fourPerks)).toBe(MAX_PERKS);
    expect(
      validatePurchase(PurchaseKind.Perk, PerkId.SteadyHand, baseCtx({ powerOn: true, perks: fourPerks })).ok,
    ).toBe(false);
  });

  it('Corpsman is cheap solo, full price in a squad', () => {
    const solo = validatePurchase(PurchaseKind.Perk, PerkId.Corpsman, baseCtx({ powerOn: true, playerCount: 1 }));
    expect(solo.cost).toBe(PERK_COST_CORPSMAN_SOLO);
    const squad = validatePurchase(PurchaseKind.Perk, PerkId.Corpsman, baseCtx({ powerOn: true, playerCount: 3 }));
    expect(squad.cost).toBe(PERK_COSTS[PerkId.Corpsman]);
  });

  it('a wall buy becomes an ammo re-buy once owned', () => {
    const fresh = validatePurchase(PurchaseKind.Weapon, WeaponId.Shrike, baseCtx());
    expect(fresh.cost).toBe(WALL_BUY_COST[WeaponId.Shrike]);
    const again = validatePurchase(
      PurchaseKind.Weapon,
      WeaponId.Shrike,
      baseCtx({ ownedWeapons: [WeaponId.Shrike] }),
    );
    expect(again.cost).toBe(ammoCostFor(WeaponId.Shrike));
  });

  it('The Forge needs power and never sells twice; the crate just needs points', () => {
    expect(validatePurchase(PurchaseKind.Forge, 0, baseCtx()).ok).toBe(false);
    expect(validatePurchase(PurchaseKind.Forge, 0, baseCtx({ powerOn: true })).cost).toBe(FORGE_COST);
    expect(validatePurchase(PurchaseKind.Forge, 0, baseCtx({ powerOn: true, forged: true })).ok).toBe(false);
    expect(validatePurchase(PurchaseKind.Crate, 0, baseCtx()).cost).toBe(CRATE_COST);
  });
});

// ---------------------------------------------------------------------------
// Perks and damage multipliers
// ---------------------------------------------------------------------------

describe('perk effects', () => {
  it('DEADEYE takes 100 -> 250 (three-hit down becomes seven)', () => {
    expect(maxHealthForPerks(0)).toBe(100);
    expect(maxHealthForPerks(1 << PerkId.Deadeye)).toBe(250);
    // 40 damage per swing: ceil(100/40)=3 hits, ceil(250/40)=7 hits.
    expect(Math.ceil(100 / 40)).toBe(3);
    expect(Math.ceil(250 / 40)).toBe(7);
  });

  it('STEADY HAND halves adsTime and leaves accuracyLockAt at 0.82 exactly', () => {
    const base = resolveWeapon(WeaponId.Talon, []);
    const modded = applySurvivalWeaponMods(base, 1 << PerkId.SteadyHand, false);
    expect(modded.adsTime).toBeCloseTo(base.adsTime * 0.5, 10);
    expect(modded.accuracyLockAt).toBe(base.accuracyLockAt);
    expect(modded.accuracyLockAt).toBe(0.82);
    // Nothing else moved.
    expect(modded.reloadTime).toBe(base.reloadTime);
    expect(modded.magSize).toBe(base.magSize);
  });

  it('QUICKHANDS halves reloads; The Forge grows the magazine', () => {
    const base = resolveWeapon(WeaponId.Condor, []);
    const quick = applySurvivalWeaponMods(base, 1 << PerkId.Quickhands, false);
    expect(quick.reloadTime).toBeCloseTo(base.reloadTime * 0.5, 10);
    expect(quick.reloadTimeEmpty).toBeCloseTo(base.reloadTimeEmpty * 0.5, 10);
    expect(quick.adsTime).toBe(base.adsTime);
    const forged = applySurvivalWeaponMods(base, 0, true);
    expect(forged.magSize).toBe(Math.round(base.magSize * 1.5));
  });

  it('damage multipliers: doubletap x1.8, forge x2.5, head x2.5, insta-kill wins', () => {
    expect(zombieDamageMult(0, false, false, false)).toBe(1);
    expect(zombieDamageMult(1 << PerkId.Doubletap, false, false, false)).toBeCloseTo(1.8, 10);
    expect(zombieDamageMult(0, true, false, false)).toBeCloseTo(2.5, 10);
    expect(zombieDamageMult(0, false, true, false)).toBeCloseTo(2.5, 10);
    expect(zombieDamageMult(1 << PerkId.Doubletap, true, true, false)).toBeCloseTo(1.8 * 2.5 * 2.5, 8);
    expect(zombieDamageMult(0, false, false, true)).toBeGreaterThan(100_000);
  });

  it('the design headshot maths hold: R1 Talon one-shots, R9 needs the Forge', () => {
    const talonHead = WEAPONS[WeaponId.Talon].damage[HitboxPart.Head]; // 100
    // R1: 100 * 2.5 = 250 vs 150 -> one shot.
    expect(talonHead * zombieDamageMult(0, false, true, false)).toBeGreaterThanOrEqual(healthForRound(1));
    // R9: 250 vs 950 -> not a one-shot.
    expect(talonHead * zombieDamageMult(0, false, true, false)).toBeLessThan(healthForRound(9));
    // R9 with Forge + Doubletap: 100 * 2.5 * 2.5 * 1.8 = 1125 -> one shot again.
    expect(talonHead * zombieDamageMult(1 << PerkId.Doubletap, true, true, false)).toBeGreaterThan(
      healthForRound(9),
    );
  });
});

// ---------------------------------------------------------------------------
// Last stand
// ---------------------------------------------------------------------------

describe('last stand', () => {
  it('the downed input mask strips jump/sprint/swap/melee/crouch but keeps fire and use', () => {
    const all =
      InputButton.Fire |
      InputButton.Ads |
      InputButton.Jump |
      InputButton.Crouch |
      InputButton.Sprint |
      InputButton.Reload |
      InputButton.SwapWeapon |
      InputButton.Melee |
      InputButton.Use;
    const filtered = filterDownedButtons(all);
    expect(filtered & InputButton.Jump).toBe(0);
    expect(filtered & InputButton.Crouch).toBe(0);
    expect(filtered & InputButton.Sprint).toBe(0);
    expect(filtered & InputButton.SwapWeapon).toBe(0);
    expect(filtered & InputButton.Melee).toBe(0);
    expect(filtered & InputButton.Fire).toBe(InputButton.Fire);
    expect(filtered & InputButton.Ads).toBe(InputButton.Ads);
    expect(filtered & InputButton.Use).toBe(InputButton.Use);
    expect(filtered & InputButton.Reload).toBe(InputButton.Reload);
  });

  it('timings are canon: 30s bleedout, 3.5s revive', () => {
    expect(BLEEDOUT_TIME).toBe(30);
    expect(REVIVE_TIME).toBe(3.5);
  });

  it('hasPerk reads the bitfield', () => {
    const perks = (1 << PerkId.Corpsman) | (1 << PerkId.Deadeye);
    expect(hasPerk(perks, PerkId.Corpsman)).toBe(true);
    expect(hasPerk(perks, PerkId.SteadyHand)).toBe(false);
  });
});
