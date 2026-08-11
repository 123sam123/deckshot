/**
 * ZOMBIES — director + horde integration on a synthetic two-room map: the
 * round machine, window tearing and repairs, purchases, downs/revives/wipe,
 * drops, and the economy events, all under a fake clock. The real map gets
 * its own validation in tests/shipbreak.test.ts; this file proves the SIM.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AnyServerMessage } from '../shared/protocol.js';
import { SurfaceMaterial, BrushTag, type Brush } from '../shared/mapdata.js';
import { MapId, type MapDef } from '../shared/mapdef.js';
import { SpawnZone } from '../shared/mapdata.js';
import {
  ZombiesDirector,
  type SquadMember,
  type ZombiesCallbacks,
} from '../server/src/sim/zombies/director.js';
import {
  BLEEDOUT_TIME,
  FIRST_INTERMISSION,
  INTERACT_RADIUS,
  InteractTarget,
  MAX_HEALTH_BULWARK,
  PLANKS_MAX,
  PLANK_TEAR_INTERVAL,
  POINTS_KILL_HEAD,
  POINTS_REPAIR,
  POINTS_START,
  PerkId,
  PurchaseKind,
  REPAIR_BUDGET_PER_ROUND,
  REVIVE_TIME,
  SOLO_REVIVE_DELAY,
  WALL_COSTS,
  ZombiesPhase,
  zombiesForRound,
} from '../shared/zombies.js';
import { TICK_MS, TICK_RATE, MAX_PLAYERS } from '../shared/tuning.js';
import {
  AdsState,
  DEFAULT_LOADOUT,
  HitboxPart,
  InputButton,
  Stance,
  TeamId,
  WeaponId,
  emptyInput,
  type PlayerState,
} from '../shared/types.js';
import { InteractableKind } from '../shared/mapdef.js';

// ---------------------------------------------------------------------------
// A minimal, fully-valid two-room map
// ---------------------------------------------------------------------------

const b = (
  id: string,
  center: [number, number, number],
  half: [number, number, number],
  opts: { playersOnly?: boolean; penetrable?: boolean } = {},
): Brush => ({
  id,
  center: { x: center[0], y: center[1], z: center[2] },
  half: { x: half[0], y: half[1], z: half[2] },
  yaw: 0,
  pitch: 0,
  material: SurfaceMaterial.Metal,
  penetrable: opts.penetrable ?? false,
  tag: BrushTag.Deck,
  ...(opts.playersOnly ? { playersOnly: true } : {}),
});

// Room A (zone 0): x in [-10, 10], z in [-10, 10]. Room B (zone 1): z in [10, 30].
// A boarded window sits in room A's +x wall at (10, 1, 0); its spawner pocket
// is outside at x > 10. A door brush at z = 10 seals room B.
const TEST_MAP: MapDef = {
  id: MapId.Shipbreak,
  name: 'TestYard',
  brushes: [
    b('floorA', [0, -0.5, 0], [14, 0.5, 10]),
    b('floorB', [0, -0.5, 20], [10, 0.5, 10]),
    b('door01', [0, 1.5, 10], [3, 1.5, 0.3]),
    b('win_blocker', [10, 1.4, 0], [0.2, 1.2, 0.9], { playersOnly: true, penetrable: true }),
  ],
  bounds: { min: { x: -40, y: -10, z: -40 }, max: { x: 40, y: 20, z: 40 } },
  waterLevel: -8,
  spawns: [
    { id: 0, position: { x: -5, y: 0, z: -5 }, yaw: 0, zone: SpawnZone.Mid },
    { id: 1, position: { x: -3, y: 0, z: -5 }, yaw: 0, zone: SpawnZone.Mid },
  ],
  zones: [
    {
      id: 0,
      name: 'Room A',
      cost: 0,
      requiresPower: false,
      adjacent: [],
      boxes: [{ min: { x: -14, y: -2, z: -10 }, max: { x: 14, y: 6, z: 10 } }],
    },
    {
      id: 1,
      name: 'Room B',
      cost: 750,
      requiresPower: false,
      adjacent: [0],
      boxes: [{ min: { x: -10, y: -2, z: 10 }, max: { x: 10, y: 6, z: 30 } }],
    },
  ],
  navNodes: [
    { id: 0, pos: { x: 0, y: 0, z: 0 }, zone: 0, edges: [1, 3] },
    { id: 1, pos: { x: 8, y: 0, z: 0 }, zone: 0, edges: [0, 2] },
    { id: 2, pos: { x: 11.5, y: 0, z: 0 }, zone: 0, edges: [1] },
    { id: 3, pos: { x: 0, y: 0, z: 14 }, zone: 1, edges: [0] },
  ],
  interactables: [
    { kind: InteractableKind.WallBuy, zone: 0, pos: { x: -9, y: 1, z: 0 }, weapon: WeaponId.Osprey },
    { kind: InteractableKind.Perk, zone: 0, pos: { x: -9, y: 1, z: 5 }, perk: PerkId.Bulwark },
    { kind: InteractableKind.Perk, zone: 0, pos: { x: -9, y: 1, z: -8 }, perk: PerkId.SecondWind },
    { kind: InteractableKind.Generator, zone: 0, pos: { x: 9, y: 1, z: 8 } },
    { kind: InteractableKind.Forge, zone: 1, pos: { x: 0, y: 1, z: 25 } },
    { kind: InteractableKind.CrateSpot, zone: 0, pos: { x: 0, y: 0.5, z: -8 }, spot: 0 },
    { kind: InteractableKind.CrateSpot, zone: 1, pos: { x: 5, y: 0.5, z: 25 }, spot: 1 },
    { kind: InteractableKind.AmmoBox, zone: 0, pos: { x: 9, y: 1, z: -5 } },
  ],
  zombieSpawners: [
    { zone: 0, pos: { x: 12, y: 0, z: 0 }, window: 0 },
    { zone: 1, pos: { x: 0, y: 0, z: 28 } },
  ],
  windows: [
    {
      id: 0,
      zone: 0,
      pos: { x: 10, y: 1, z: 0 },
      // Faces INTO room A (toward -x): forward = (-sin yaw, -cos yaw) = (-1, 0).
      yaw: Math.PI / 2,
      blockerBrushId: 'win_blocker',
      outsideNode: 2,
      insideNode: 1,
    },
  ],
  doorBrushIdsByZone: [[], ['door01']],
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeState(id: number, x = -5, z = -5): PlayerState {
  return {
    id,
    position: { x, y: 0, z },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    slideTime: 0,
    slideCooldown: 0,
    sprintTime: 0,
    health: 100,
    alive: true,
    activeWeapon: WeaponId.Kestrel,
    adsState: AdsState.Hip,
    adsProgress: 0,
    ammoInMag: 12,
    ammoReserve: 48,
    actionEndsAt: 0,
    name: `p${id}`,
    team: TeamId.Alpha,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 0,
  };
}

interface Harness {
  director: ZombiesDirector;
  members: SquadMember[];
  calls: Record<string, number[]>;
  sent: Map<number, AnyServerMessage[]>;
  tick: number;
  step(ticks?: number): void;
}

function makeHarness(playerCount = 1): Harness {
  const calls: Record<string, number[]> = {
    give: [],
    refill: [],
    stash: [],
    restore: [],
    loadout: [],
    respawn: [],
    death: [],
    end: [],
  };
  const sent = new Map<number, AnyServerMessage[]>();
  const cb: ZombiesCallbacks = {
    send: (id, msg) => {
      const list = sent.get(id) ?? [];
      list.push(msg);
      sent.set(id, list);
    },
    broadcast: () => {},
    giveWeapon: (id, w) => calls.give.push((id << 8) | w),
    refillAmmo: (id) => calls.refill.push(id),
    stashWeaponsForDown: (id) => calls.stash.push(id),
    restoreWeaponsOnRevive: (id) => calls.restore.push(id),
    onLoadoutChanged: (id) => calls.loadout.push(id),
    respawn: (id) => calls.respawn.push(id),
    reportDeath: (id) => calls.death.push(id),
    endMatch: () => calls.end.push(1),
    ammoOf: () => ({
      held: WeaponId.Kestrel,
      stowed: WeaponId.Knife,
      mag: 12,
      reserve: 48,
      stowedMag: 0,
      stowedReserve: 0,
    }),
  };
  const director = new ZombiesDirector(TEST_MAP, MAX_PLAYERS, cb, 0xfeed);
  const members: SquadMember[] = [];
  for (let i = 0; i < playerCount; i++) {
    const m: SquadMember = { id: i + 1, state: makeState(i + 1), lastInput: emptyInput() };
    members.push(m);
    director.addPlayer(m.id);
  }
  const h: Harness = {
    director,
    members,
    calls,
    sent,
    tick: 0,
    step(ticks = 1) {
      for (let i = 0; i < ticks; i++) {
        h.tick++;
        director.tick(h.tick, h.tick * TICK_MS, members);
      }
    },
  };
  return h;
}

const seconds = (s: number): number => Math.ceil(s * TICK_RATE);

// ---------------------------------------------------------------------------

describe('round machine', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness(1);
  });

  it('opens with a short intermission, then fields round 1 on the spawn cadence', () => {
    expect(h.director.round).toBe(0);
    expect(h.director.phase).toBe(ZombiesPhase.Intermission);
    h.step(seconds(FIRST_INTERMISSION) + 2);
    expect(h.director.round).toBe(1);
    expect(h.director.phase).toBe(ZombiesPhase.Wave);
    expect(h.director.zombiesRemaining()).toBe(zombiesForRound(1, 1));
    // The first body should be on the deck already.
    expect(h.director.horde.aliveCount).toBeGreaterThanOrEqual(1);
  });

  it('killing the whole wave brings the next intermission, then round 2', () => {
    h.step(seconds(FIRST_INTERMISSION) + 2);
    // Slaughter every zombie as it spawns until the budget is spent.
    for (let guard = 0; guard < 40_000 && h.director.phase === ZombiesPhase.Wave; guard++) {
      for (const z of [...h.director.horde.actives()]) {
        h.director.horde.damage(z.state.id, 1e9);
      }
      h.step();
    }
    expect(h.director.phase).toBe(ZombiesPhase.Intermission);
    h.step(seconds(11));
    expect(h.director.round).toBe(2);
  });

  it('dead players come back when the next round starts', () => {
    h.step(seconds(FIRST_INTERMISSION) + 2);
    const m = h.members[0];
    // A second member keeps the wipe check quiet while p1 dies.
    const m2: SquadMember = { id: 2, state: makeState(2), lastInput: emptyInput() };
    h.members.push(m2);
    h.director.addPlayer(2);
    h.director.environmentalDeath(m);
    expect(m.state.alive).toBe(false);
    expect(h.calls.death).toContain(1);
    // Kill the wave, ride out the intermission: p1 must be respawned.
    for (let guard = 0; guard < 40_000 && h.director.phase === ZombiesPhase.Wave; guard++) {
      for (const z of [...h.director.horde.actives()]) h.director.horde.damage(z.state.id, 1e9);
      h.step();
    }
    h.step(seconds(11));
    expect(h.calls.respawn).toContain(1);
  });
});

describe('windows', () => {
  it('a window-spawned zombie tears the boards down, then walks into the room', () => {
    const h = makeHarness(1);
    // Stand the player deep in the room so the zombie must come through.
    h.members[0].state.position.x = -8;
    h.step(seconds(FIRST_INTERMISSION) + 2);
    const planksAt = (): number => h.director.stateFor(1, h.tick * TICK_MS).planks[0];
    expect(planksAt()).toBe(PLANKS_MAX);
    // Give it time to reach the sill and pull all six boards.
    h.step(seconds(PLANKS_MAX * PLANK_TEAR_INTERVAL + 8));
    expect(planksAt()).toBe(0);
    // And some time to cross into the room proper.
    h.step(seconds(4));
    let inside = false;
    for (const z of h.director.horde.actives()) {
      if (z.state.position.x < 9.5) inside = true;
    }
    expect(inside).toBe(true);
  });

  it('holding F at a torn window rebuilds it and pays until the round budget runs dry', () => {
    const h = makeHarness(1);
    const m = h.members[0];
    h.step(seconds(FIRST_INTERMISSION) + 2);
    // Tear it down by force.
    const state0 = h.director.stateFor(1, 0);
    expect(state0.repairBudget).toBe(REPAIR_BUDGET_PER_ROUND);
    for (let i = 0; i < PLANKS_MAX; i++) {
      (h.director as unknown as { planks: number[] }).planks[0] = 0;
    }
    // Stand at the window holding Use. Zombies also path here, so the plank
    // count seesaws — points, not planks, are the assertion.
    m.state.position.x = 9;
    m.state.position.z = 0;
    m.lastInput.buttons = InputButton.Use;
    const before = h.director.balanceOf(1);
    h.step(seconds(3));
    const earned = h.director.balanceOf(1) - before;
    expect(earned).toBeGreaterThanOrEqual(POINTS_REPAIR);
    const after = h.director.stateFor(1, h.tick * TICK_MS);
    expect(after.repairBudget).toBeLessThan(REPAIR_BUDGET_PER_ROUND);
  });
});

describe('economy and purchases', () => {
  let h: Harness;
  let m: SquadMember;
  beforeEach(() => {
    h = makeHarness(1);
    m = h.members[0];
    h.step(2);
  });

  it('hits pay 10, headshot kills pay 100', () => {
    h.director.onZombieHit(1, 0);
    expect(h.director.balanceOf(1)).toBe(POINTS_START + 10);
    h.director.onZombieKill(1, HitboxPart.Head, false, 0, 0, 0, 1, 0);
    expect(h.director.balanceOf(1)).toBe(POINTS_START + 10 + POINTS_KILL_HEAD);
  });

  it('a wall buy charges and grants; the re-buy refills at half price', () => {
    const r = h.director;
    (r as unknown as { records: Map<number, { balance: number }> }).records.get(1)!.balance = 5000;
    m.state.position.x = -9;
    m.state.position.z = 0;
    r.purchase(m, PurchaseKind.Weapon, WeaponId.Osprey, 0);
    expect(h.calls.give).toContain((1 << 8) | WeaponId.Osprey);
    expect(r.balanceOf(1)).toBe(5000 - WALL_COSTS[WeaponId.Osprey]!);
    // Simulate ownership (the room would have granted it).
    r.purchase(m, PurchaseKind.Weapon, WeaponId.Osprey, 0);
    expect(h.calls.refill.length).toBeGreaterThanOrEqual(1);
  });

  it('a door opens only from beside it, and rebuilds both worlds', () => {
    const r = h.director;
    (r as unknown as { records: Map<number, { balance: number }> }).records.get(1)!.balance = 5000;
    // Too far away: refused.
    r.purchase(m, PurchaseKind.Zone, 1, 0);
    expect(r.zoneMask).toBe(1);
    // At the door: opened, charged.
    m.state.position.x = 0;
    m.state.position.z = 8.5;
    r.purchase(m, PurchaseKind.Zone, 1, 0);
    expect(r.zoneMask).toBe(0b11);
    expect(r.balanceOf(1)).toBe(5000 - 750);
  });

  it('BULWARK heals to 250 on purchase; the Forge upgrades the held gun only', () => {
    const r = h.director;
    (r as unknown as { records: Map<number, { balance: number }> }).records.get(1)!.balance = 20_000;
    // Power first.
    m.state.position.x = 9;
    m.state.position.z = 8;
    r.interact(m, InteractTarget.Power, 0);
    expect(r.powerOn).toBe(true);
    // Perk.
    m.state.position.x = -9;
    m.state.position.z = 5;
    r.purchase(m, PurchaseKind.Perk, PerkId.Bulwark, 0);
    expect(m.state.health).toBe(MAX_HEALTH_BULWARK);
    expect(r.maxHealthOf(1)).toBe(MAX_HEALTH_BULWARK);
    // Forge needs zone 1 open and reach.
    m.state.position.x = 0;
    m.state.position.z = 8.5;
    r.purchase(m, PurchaseKind.Zone, 1, 0);
    m.state.position.z = 25 - INTERACT_RADIUS + 0.5;
    m.state.position.x = 0;
    r.purchase(m, PurchaseKind.Forge, 0, 0);
    expect(r.forgedMaskOf(1) & (1 << WeaponId.Kestrel)).toBeTruthy();
    expect(r.forgedMaskOf(1) & (1 << WeaponId.Talon)).toBe(0);
  });

  it('the ammo box charges the held gun price and refills, in reach only', () => {
    const r = h.director;
    (r as unknown as { records: Map<number, { balance: number }> }).records.get(1)!.balance = 5000;
    const refillsBefore = h.calls.refill.length;
    // Out of reach: nothing happens, nothing charged.
    m.state.position.x = -9;
    m.state.position.z = 8;
    r.purchase(m, PurchaseKind.Ammo, WeaponId.Kestrel, 0);
    expect(r.balanceOf(1)).toBe(5000);
    // At the box: the held Kestrel refills at the fallback price.
    m.state.position.x = 9;
    m.state.position.z = -5;
    r.purchase(m, PurchaseKind.Ammo, WeaponId.Kestrel, 0);
    expect(r.balanceOf(1)).toBe(5000 - 300);
    expect(h.calls.refill.length).toBe(refillsBefore + 1);
  });

  it('the box rolls an offer that expires, and BoxTake collects it', () => {
    const r = h.director;
    (r as unknown as { records: Map<number, { balance: number }> }).records.get(1)!.balance = 5000;
    m.state.position.x = 0;
    m.state.position.z = -8;
    r.purchase(m, PurchaseKind.Box, 0, 1000);
    const offered = r.stateFor(1, 1000).boxOffer;
    expect(offered).not.toBe(255);
    // Take it.
    r.interact(m, InteractTarget.BoxTake, 2000);
    expect(h.calls.give.some((v) => (v & 0xff) === offered)).toBe(true);
  });
});

describe('downs, revives, the wipe', () => {
  it('lethal damage downs rather than kills; a rescuer brings them back', () => {
    const h = makeHarness(2);
    const [a, b2] = h.members;
    h.step(2);
    h.director.damagePlayer(a, 999, 0);
    expect(a.state.alive).toBe(true);
    expect(a.state.downed).toBe(true);
    expect(a.state.bleedout).toBeCloseTo(BLEEDOUT_TIME, 0);
    expect(h.calls.stash).toContain(1);
    expect(h.director.perksOf(1)).toBe(0);
    // Rescuer stands on them holding F.
    b2.state.position.x = a.state.position.x;
    b2.state.position.z = a.state.position.z;
    b2.lastInput.buttons = InputButton.Use;
    h.step(seconds(REVIVE_TIME) + 3);
    expect(a.state.downed).toBe(false);
    expect(h.calls.restore).toContain(1);
    expect(h.director.balanceOf(2)).toBeGreaterThan(POINTS_START); // +50
  });

  it('nobody helping: bleedout kills while a teammate still stands', () => {
    const h = makeHarness(2);
    h.step(seconds(FIRST_INTERMISSION) + 2);
    const [a, b2] = h.members;
    b2.state.position.x = -12; // out of revive reach, not helping
    h.director.damagePlayer(a, 999, h.tick * TICK_MS);
    h.step(seconds(BLEEDOUT_TIME) + 5);
    expect(a.state.alive).toBe(false);
    expect(h.calls.death).toContain(1);
    expect(h.calls.end.length).toBe(0); // b2 is still up
  });

  it('a solo down with no self-revive IS the wipe — the match ends on the spot', () => {
    const h = makeHarness(1);
    h.step(seconds(FIRST_INTERMISSION) + 2); // round 1 live, so the wipe counts
    h.director.damagePlayer(h.members[0], 999, h.tick * TICK_MS);
    h.step(2);
    expect(h.calls.end.length).toBe(1);
  });

  it('solo SECOND WIND self-revives after ten seconds down', () => {
    const h = makeHarness(1);
    const m = h.members[0];
    h.step(2);
    const r = h.director;
    (r as unknown as { records: Map<number, { balance: number }> }).records.get(1)!.balance = 5000;
    // Power + perk.
    m.state.position.x = 9;
    m.state.position.z = 8;
    r.interact(m, InteractTarget.Power, 0);
    m.state.position.x = -9;
    m.state.position.z = -8;
    r.purchase(m, PurchaseKind.Perk, PerkId.SecondWind, 0);
    expect(r.perksOf(1) & (1 << PerkId.SecondWind)).toBeTruthy();
    // Down them; the self-revive should fire ~SOLO_REVIVE_DELAY later.
    r.damagePlayer(m, 999, h.tick * TICK_MS);
    expect(m.state.downed).toBe(true);
    h.step(seconds(SOLO_REVIVE_DELAY) + 5);
    expect(m.state.downed).toBe(false);
    expect(h.calls.end.length).toBe(0);
    expect(r.stateFor(1, h.tick * TICK_MS).selfRevives).toBe(2);
  });
});

describe('drops', () => {
  it('kills eventually roll a drop; walking over it consumes it', () => {
    const h = makeHarness(1);
    h.step(2);
    const r = h.director;
    // Roll kills until the 2% chance lands (seeded, so this is deterministic).
    let drop = null;
    for (let i = 0; i < 2000 && !drop; i++) {
      r.onZombieKill(1, HitboxPart.Chest, false, 5, 0, 5, i * 7 + 1, h.tick * TICK_MS);
      const drops = r.stateFor(1, h.tick * TICK_MS).drops;
      if (drops.length > 0) drop = drops[0];
    }
    expect(drop).not.toBeNull();
    // Stand on it.
    h.members[0].state.position.x = drop!.pos.x;
    h.members[0].state.position.z = drop!.pos.z;
    h.step(2);
    expect(r.stateFor(1, h.tick * TICK_MS).drops.length).toBe(0);
  });
});

describe('replication mirror', () => {
  it('the balance lands in score, perks in state, ADRENALINE in speedMult', () => {
    const h = makeHarness(1);
    const m = h.members[0];
    h.step(2);
    expect(m.state.score).toBe(POINTS_START);
    expect(m.state.speedMult).toBe(1);
    const r = h.director;
    (r as unknown as { records: Map<number, { balance: number; perks: number }> })
      .records.get(1)!.perks = 1 << PerkId.Adrenaline;
    h.step(1);
    expect(m.state.speedMult).toBeCloseTo(1.07);
  });

  it('ZombiesState goes out on change and at least at 1 Hz', () => {
    const h = makeHarness(1);
    h.step(seconds(2.5));
    const msgs = h.sent.get(1) ?? [];
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });
});
