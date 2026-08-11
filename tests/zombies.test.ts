/**
 * ZOMBIES — the pure rules: round curves, the flat canon economy, the
 * purchase validator, perk effects, the damage stack, the input mask, and the
 * ZombiesState wire round-trip. Values quoted here are pinned from ZOMBIES.md;
 * changing one there without changing it here should fail loudly.
 */

import { describe, expect, it } from 'vitest';
import {
  ADRENALINE_SPEED_MULT,
  BLEEDOUT_TIME,
  BOX_COST,
  FORGE_COST,
  MAX_HEALTH_BULWARK,
  MAX_PERKS,
  PERK_COSTS,
  PERK_COST_SECOND_WIND_SOLO,
  PLANKS_MAX,
  POINTS_HIT,
  POINTS_KILL,
  POINTS_KILL_HEAD,
  POINTS_KILL_KNIFE,
  POINTS_START,
  PerkId,
  PurchaseKind,
  WALL_COSTS,
  ZOMBIES_ALIVE_MAX,
  applyZombiesWeaponMods,
  filterDownedButtons,
  gaitForRoll,
  hasPerk,
  healthForRound,
  isFogRound,
  isZombieId,
  killPoints,
  maxHealthForPerks,
  perkCount,
  spawnInterval,
  speedMultForPerks,
  validatePurchase,
  zombieDamageMult,
  zombiesForRound,
  ZombieGait,
  type PurchaseContext,
} from '../shared/zombies.js';
import { HitboxPart, InputButton, WeaponId } from '../shared/types.js';
import { WEAPONS } from '../shared/tuning.js';
import { resolveWeapon } from '../shared/weapons.js';
import { codec } from '../shared/codec.js';
import { ServerMessage, type ZombiesStateMsg } from '../shared/protocol.js';

describe('round curves', () => {
  it('health follows the canon curve: +100 to round 9, then x1.1', () => {
    expect(healthForRound(1)).toBe(150);
    expect(healthForRound(9)).toBe(950);
    expect(healthForRound(10)).toBe(1045);
    expect(healthForRound(200)).toBe(100_000); // capped
  });

  it('counts are pinned: solo r1=6, r10=22, r20=53', () => {
    expect(zombiesForRound(1, 1)).toBe(6);
    expect(zombiesForRound(10, 1)).toBe(22);
    expect(zombiesForRound(20, 1)).toBe(53);
  });

  it('more players, more zombies — monotonically', () => {
    for (let r = 1; r <= 30; r += 3) {
      expect(zombiesForRound(r, 2)).toBeGreaterThan(zombiesForRound(r, 1));
      expect(zombiesForRound(r, 3)).toBeGreaterThan(zombiesForRound(r, 2));
      expect(zombiesForRound(r, 4)).toBeGreaterThan(zombiesForRound(r, 3));
    }
  });

  it('spawn cadence tightens with rounds and floors at 0.35s', () => {
    expect(spawnInterval(1)).toBeCloseTo(2.14);
    expect(spawnInterval(40)).toBe(0.35);
  });

  it('Blood Fog rounds are every 5th from 5', () => {
    expect([1, 2, 3, 4, 6, 7, 9, 11].some(isFogRound)).toBe(false);
    expect([5, 10, 15, 20, 25].every(isFogRound)).toBe(true);
  });

  it('fog rounds sprint; early rounds walk; late rounds mix in runners', () => {
    expect(gaitForRoll(5, 0.99)).toBe(ZombieGait.Sprinter);
    expect(gaitForRoll(1, 0.99)).toBe(ZombieGait.Walker);
    expect(gaitForRoll(31, 0.0)).toBe(ZombieGait.Runner);
  });

  it('the alive cap is canon 24', () => {
    expect(ZOMBIES_ALIVE_MAX).toBe(24);
  });
});

describe('economy — canon flat payouts', () => {
  it('start 500, hit 10, kill 60, headshot 100, knife 130', () => {
    expect(POINTS_START).toBe(500);
    expect(POINTS_HIT).toBe(10);
    expect(killPoints(HitboxPart.Chest, false)).toBe(POINTS_KILL);
    expect(killPoints(HitboxPart.Head, false)).toBe(POINTS_KILL_HEAD);
    expect(killPoints(HitboxPart.Head, true)).toBe(POINTS_KILL_KNIFE);
    expect([POINTS_KILL, POINTS_KILL_HEAD, POINTS_KILL_KNIFE]).toEqual([60, 100, 130]);
  });

  it('wall costs are pinned per ZOMBIES.md', () => {
    expect(WALL_COSTS[WeaponId.Osprey]).toBe(500);
    expect(WALL_COSTS[WeaponId.Shrike]).toBe(900);
    expect(WALL_COSTS[WeaponId.Harrier]).toBe(1200);
    expect(WALL_COSTS[WeaponId.Talon]).toBe(1400);
    expect(WALL_COSTS[WeaponId.Condor]).toBe(1750);
    expect(BOX_COST).toBe(950);
    expect(FORGE_COST).toBe(5000);
  });
});

describe('purchase validator', () => {
  const base: PurchaseContext = {
    kind: PurchaseKind.Weapon,
    itemId: WeaponId.Osprey,
    points: 10_000,
    perks: 0,
    powerOn: true,
    zoneMask: 1,
    zoneReachable: true,
    ownsWeapon: false,
    heldForged: false,
    solo: false,
    boxBusy: false,
    zoneCost: 750,
  };

  it('a wall buy charges the wall price; a re-buy charges half', () => {
    expect(validatePurchase(base)).toEqual({ ok: true, cost: 500 });
    expect(validatePurchase({ ...base, ownsWeapon: true })).toEqual({ ok: true, cost: 250 });
  });

  it('poverty is the only thing that stops a reachable door', () => {
    const door: PurchaseContext = { ...base, kind: PurchaseKind.Zone, itemId: 1 };
    expect(validatePurchase(door).ok).toBe(true);
    expect(validatePurchase({ ...door, points: 700 })).toMatchObject({ ok: false, reason: 'poor' });
    expect(validatePurchase({ ...door, zoneMask: 0b11 })).toMatchObject({ ok: false, reason: 'owned' });
    expect(validatePurchase({ ...door, zoneReachable: false })).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('perks need power, respect the 4-perk cap, and SECOND WIND is cheap solo', () => {
    const perk: PurchaseContext = { ...base, kind: PurchaseKind.Perk, itemId: PerkId.Bulwark };
    expect(validatePurchase(perk)).toEqual({ ok: true, cost: PERK_COSTS[PerkId.Bulwark] });
    expect(validatePurchase({ ...perk, powerOn: false })).toMatchObject({ ok: false, reason: 'power' });
    expect(validatePurchase({ ...perk, perks: 1 << PerkId.Bulwark })).toMatchObject({
      ok: false,
      reason: 'owned',
    });
    const fourPerks =
      (1 << PerkId.Handloader) | (1 << PerkId.SecondWind) | (1 << PerkId.Adrenaline) | (1 << PerkId.HairTrigger);
    expect(validatePurchase({ ...perk, perks: fourPerks })).toMatchObject({
      ok: false,
      reason: 'perk-limit',
    });
    expect(
      validatePurchase({ ...perk, itemId: PerkId.SecondWind, solo: true }),
    ).toEqual({ ok: true, cost: PERK_COST_SECOND_WIND_SOLO });
  });

  it('the box refuses a second spin while an offer stands', () => {
    const box: PurchaseContext = { ...base, kind: PurchaseKind.Box };
    expect(validatePurchase(box).ok).toBe(true);
    expect(validatePurchase({ ...box, boxBusy: true })).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('the Forge refuses an already-forged held gun', () => {
    const forge: PurchaseContext = { ...base, kind: PurchaseKind.Forge };
    expect(validatePurchase(forge)).toEqual({ ok: true, cost: FORGE_COST });
    expect(validatePurchase({ ...forge, heldForged: true })).toMatchObject({ ok: false, reason: 'owned' });
  });

  it('the ammo box charges half wall price, the fallback for the pistol, 4500 forged, and never sells knife ammo', () => {
    const ammo: PurchaseContext = { ...base, kind: PurchaseKind.Ammo, itemId: WeaponId.Condor };
    expect(validatePurchase(ammo)).toEqual({ ok: true, cost: 875 });
    expect(validatePurchase({ ...ammo, itemId: WeaponId.Kestrel })).toEqual({ ok: true, cost: 300 });
    expect(validatePurchase({ ...ammo, heldForged: true })).toEqual({ ok: true, cost: 4500 });
    expect(validatePurchase({ ...ammo, itemId: WeaponId.Knife })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(validatePurchase({ ...ammo, points: 100 })).toMatchObject({ ok: false, reason: 'poor' });
  });
});

describe('perks and the damage stack', () => {
  it('BULWARK raises max health to 250 and nothing else does', () => {
    expect(maxHealthForPerks(0)).toBe(100);
    expect(maxHealthForPerks(1 << PerkId.Bulwark)).toBe(MAX_HEALTH_BULWARK);
    expect(maxHealthForPerks(1 << PerkId.HairTrigger)).toBe(100);
  });

  it('ADRENALINE is the only speed perk', () => {
    expect(speedMultForPerks(1 << PerkId.Adrenaline)).toBe(ADRENALINE_SPEED_MULT);
    expect(speedMultForPerks(1 << PerkId.Bulwark)).toBe(1);
  });

  it('HANDLOADER halves reloads; the Forge doubles the magazine; accuracyLockAt never moves', () => {
    const base = resolveWeapon(WeaponId.Talon, []);
    const modded = applyZombiesWeaponMods(base, 1 << PerkId.Handloader, true);
    expect(modded.reloadTime).toBeCloseTo(base.reloadTime * 0.5);
    expect(modded.reloadTimeEmpty).toBeCloseTo(base.reloadTimeEmpty * 0.5);
    expect(modded.magSize).toBe(Math.round(base.magSize * 2));
    expect(modded.reserveAmmo).toBe(Math.round(base.reserveAmmo * 2));
    expect(modded.accuracyLockAt).toBe(base.accuracyLockAt);
    expect(modded.accuracyLockAt).toBe(0.82); // the game's one sacred number
  });

  it('design intent: an r1 Talon headshot one-shots; r9 needs Forge + HAIR TRIGGER', () => {
    const talonHead = WEAPONS[WeaponId.Talon].damage[HitboxPart.Head];
    const r1 = talonHead * zombieDamageMult(0, false, true, false);
    const r9Forged = talonHead * zombieDamageMult(0, true, true, false);
    const r9Full = talonHead * zombieDamageMult(1 << PerkId.HairTrigger, true, true, false);
    expect(r1).toBeGreaterThanOrEqual(healthForRound(1));
    expect(r9Forged).toBeLessThan(healthForRound(9));
    expect(r9Full).toBeGreaterThanOrEqual(healthForRound(9));
  });

  it('Insta-Kill flattens everything', () => {
    expect(zombieDamageMult(0, false, false, true)).toBe(1e6);
  });

  it('perkCount counts bits', () => {
    expect(perkCount(0)).toBe(0);
    expect(perkCount(0b10110)).toBe(3);
    expect(MAX_PERKS).toBe(4);
  });
});

describe('last stand', () => {
  it('the downed mask keeps Fire/ADS/Reload/Use and strips movement tricks', () => {
    const all = 0xffff;
    const masked = filterDownedButtons(all);
    expect(masked & InputButton.Fire).toBeTruthy();
    expect(masked & InputButton.Ads).toBeTruthy();
    expect(masked & InputButton.Reload).toBeTruthy();
    expect(masked & InputButton.Use).toBeTruthy();
    expect(masked & InputButton.Jump).toBe(0);
    expect(masked & InputButton.Sprint).toBe(0);
    expect(masked & InputButton.Crouch).toBe(0);
    expect(masked & InputButton.SwapWeapon).toBe(0);
    expect(masked & InputButton.Melee).toBe(0);
  });

  it('bleedout is 40 seconds', () => {
    expect(BLEEDOUT_TIME).toBe(40);
  });
});

describe('entity partition', () => {
  it('the horde starts at id 200', () => {
    expect(isZombieId(199)).toBe(false);
    expect(isZombieId(200)).toBe(true);
  });
});

describe('ZombiesState wire round-trip', () => {
  it('every field survives the codec, planks nibble-packed included', () => {
    const msg: ZombiesStateMsg = {
      round: 17,
      phase: 1,
      timeRemaining: 0,
      zombiesRemaining: 42,
      powerOn: true,
      zoneMask: 0b1011011,
      boxSpot: 1,
      effects: [
        [1, 12.5],
        [2, 3.25],
      ],
      drops: [
        { id: 7, kind: 4, pos: { x: 12.25, y: 1.5, z: -30.75 }, secondsLeft: 21.5 },
        { id: 8, kind: 0, pos: { x: -4, y: 0, z: 9 }, secondsLeft: 3 },
      ],
      planks: [6, 0, 3, 5, 1, 6, 2, 4, 0, 6, 5],
      points: 123_456,
      perks: 0b10110,
      bleedout: 0,
      selfRevives: 2,
      forged: 0b0001000,
      held: WeaponId.Shrike,
      stowed: WeaponId.Kestrel,
      ammoMag: 8,
      ammoReserve: 44,
      stowedMag: 12,
      stowedReserve: 36,
      boxOffer: 255,
      repairBudget: 70,
      reviveProgress: 0.6,
      beingRevived: false,
    };
    const decoded = codec.decodeServer(
      codec.encodeServer({ type: ServerMessage.ZombiesState, data: msg }),
    );
    expect(decoded.type).toBe(ServerMessage.ZombiesState);
    const d = decoded.data as ZombiesStateMsg;
    expect(d.round).toBe(17);
    expect(d.zoneMask).toBe(0b1011011);
    expect(d.boxSpot).toBe(1);
    expect(d.effects).toEqual(msg.effects.map(([k, s]) => [k, expect.closeTo(s, 2)]));
    expect(d.drops.map((x) => x.id)).toEqual([7, 8]);
    expect(d.drops[0].pos.x).toBeCloseTo(12.25, 1);
    expect(d.drops[0].pos.z).toBeCloseTo(-30.75, 1);
    expect(d.planks).toEqual(msg.planks);
    expect(d.points).toBe(123_456);
    expect(d.perks).toBe(0b10110);
    expect(d.selfRevives).toBe(2);
    expect(d.forged).toBe(0b0001000);
    expect(d.held).toBe(WeaponId.Shrike);
    expect(d.stowed).toBe(WeaponId.Kestrel);
    expect(d.ammoReserve).toBe(44);
    expect(d.boxOffer).toBe(255);
    expect(d.repairBudget).toBe(70);
    expect(d.reviveProgress).toBeCloseTo(0.6, 1);
    expect(d.beingRevived).toBe(false);
    expect(d.planks.length).toBe(11); // odd count survives nibble packing
  });

  it('plank counts clamp to the nibble', () => {
    expect(PLANKS_MAX).toBeLessThanOrEqual(15);
  });
});
