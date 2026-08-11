/**
 * SHIPBREAK — map-data validation: the nav graph is dense, bidirectional and
 * zone-consistent; unlock order actually connects the map zone by zone; every
 * door, window, interactable and spawner matches the ZOMBIES.md §3 contract.
 */

import { describe, expect, it } from 'vitest';
import { SHIPBREAK } from '../shared/shipbreak.js';
import { buildNavGraph, nearestNode, reachableNodes } from '../shared/navgraph.js';
import { InteractableKind } from '../shared/mapdef.js';
import { zoneForPosition } from '../shared/maps.js';
import { PerkId, PLANKS_MAX } from '../shared/zombies.js';
import { WeaponId } from '../shared/types.js';

const map = SHIPBREAK;
const graph = buildNavGraph(map.navNodes);
const brushById = new Map(map.brushes.map((b) => [b.id, b]));

const inBounds = (p: { x: number; y: number; z: number }): boolean =>
  p.x >= map.bounds.min.x &&
  p.x <= map.bounds.max.x &&
  p.y >= map.bounds.min.y &&
  p.y <= map.bounds.max.y &&
  p.z >= map.bounds.min.z &&
  p.z <= map.bounds.max.z;

const inZone = (zone: number, p: { x: number; y: number; z: number }, ySlack = 0): boolean =>
  map.zones[zone].boxes.some(
    (box) =>
      p.x >= box.min.x &&
      p.x <= box.max.x &&
      p.y >= box.min.y - ySlack &&
      p.y <= box.max.y + ySlack &&
      p.z >= box.min.z &&
      p.z <= box.max.z,
  );

describe('brushes', () => {
  it('ids are unique', () => {
    expect(brushById.size).toBe(map.brushes.length);
  });

  it('every brush sits inside the bounds', () => {
    for (const b of map.brushes) {
      expect(inBounds(b.center), b.id).toBe(true);
    }
  });
});

describe('nav graph', () => {
  it('ids are dense and edges are bidirectional and in range', () => {
    map.navNodes.forEach((n, i) => {
      expect(n.id).toBe(i);
      for (const e of n.edges) {
        expect(e).toBeGreaterThanOrEqual(0);
        expect(e).toBeLessThan(map.navNodes.length);
        expect(map.navNodes[e].edges).toContain(n.id);
      }
    });
  });

  it('has no orphan nodes', () => {
    for (const n of map.navNodes) {
      expect(n.edges.length, `node ${n.id}`).toBeGreaterThan(0);
    }
  });

  it('every node sits inside a box of its own zone', () => {
    for (const n of map.navNodes) {
      expect(inZone(n.zone, n.pos, 0.9), `node ${n.id} zone ${n.zone}`).toBe(true);
    }
  });

  it('with only the spawn zone open, exactly the zone-0 nodes are reachable', () => {
    const start = nearestNode(graph, map.spawns[0].position, 1);
    const reach = reachableNodes(graph, start, 1);
    const zone0 = map.navNodes.filter((n) => n.zone === 0).map((n) => n.id);
    expect([...reach].sort((a, b) => a - b)).toEqual(zone0);
  });

  it('unlocking in play order strictly grows the reachable set to the whole map', () => {
    const order = [0, 1, 2, 3, 4, 5, 6];
    const start = nearestNode(graph, map.spawns[0].position, 1);
    let mask = 0;
    let prev = 0;
    for (const z of order) {
      mask |= 1 << z;
      const reach = reachableNodes(graph, start, mask);
      expect(reach.size, `after opening zone ${z}`).toBeGreaterThan(prev);
      for (const id of reach) {
        expect((mask & (1 << map.navNodes[id].zone)) !== 0).toBe(true);
      }
      prev = reach.size;
    }
    expect(prev).toBe(map.navNodes.length);
  });
});

describe('zones and doors', () => {
  it('costs match ZOMBIES.md and only the basin needs power', () => {
    expect(map.zones.map((z) => z.cost)).toEqual([0, 750, 750, 1000, 1000, 1250, 1750]);
    expect(map.zones.reduce((s, z) => s + z.cost, 0)).toBe(6500);
    expect(map.zones.map((z) => z.requiresPower)).toEqual([
      false, false, false, false, false, false, true,
    ]);
    expect(map.zones.map((z) => [...z.adjacent])).toEqual([[], [0], [0], [1], [2], [3, 4], [4]]);
  });

  it('every gated zone has a door brush that exists; the workshop has two', () => {
    expect(map.doorBrushIdsByZone.length).toBe(7);
    expect(map.doorBrushIdsByZone[0].length).toBe(0);
    for (let z = 1; z < 7; z++) {
      expect(map.doorBrushIdsByZone[z].length, `zone ${z}`).toBeGreaterThan(0);
      for (const id of map.doorBrushIdsByZone[z]) {
        expect(brushById.has(id), id).toBe(true);
      }
    }
    expect(map.doorBrushIdsByZone[5].length).toBe(2);
  });
});

describe('windows', () => {
  it('ids are dense 0..9 with valid blockers, nodes and a spawner each', () => {
    expect(map.windows.length).toBe(10);
    map.windows.forEach((w, i) => {
      expect(w.id).toBe(i);
      const blocker = brushById.get(w.blockerBrushId);
      expect(blocker, w.blockerBrushId).toBeDefined();
      expect(blocker!.playersOnly).toBe(true);
      expect(blocker!.penetrable).toBe(true);
      const inN = map.navNodes[w.insideNode];
      const outN = map.navNodes[w.outsideNode];
      expect(inN.zone).toBe(w.zone);
      expect(outN.zone).toBe(w.zone);
      expect(inN.edges).toContain(outN.id);
      expect(map.zombieSpawners.some((s) => s.window === w.id)).toBe(true);
    });
  });

  it('the opening is a real hole: no solid wall brush overlaps the pass box', () => {
    for (const w of map.windows) {
      // A capsule-sized AABB centred on the window must clear everything but
      // the blocker. Window walls are yaw 0, so an AABB check is exact.
      const half = { x: 0.4, y: 0.75, z: 0.4 };
      for (const b of map.brushes) {
        if (b.playersOnly === true) continue;
        if (b.yaw !== 0 || b.pitch !== 0) continue;
        const overlap =
          Math.abs(b.center.x - w.pos.x) < b.half.x + half.x &&
          Math.abs(b.center.y - w.pos.y) < b.half.y + half.y &&
          Math.abs(b.center.z - w.pos.z) < b.half.z + half.z;
        expect(overlap, `window ${w.id} blocked by ${b.id}`).toBe(false);
      }
    }
  });

  it('planks fit the wire nibble', () => {
    expect(map.windows.length * 0 + PLANKS_MAX).toBeLessThanOrEqual(15);
  });
});

describe('interactables', () => {
  const of = (kind: InteractableKind) => map.interactables.filter((i) => i.kind === kind);

  it('the five wall buys are in their contracted zones', () => {
    const walls = of(InteractableKind.WallBuy);
    const byWeapon = new Map(walls.map((w) => [w.weapon, w.zone]));
    expect(byWeapon.get(WeaponId.Osprey)).toBe(0);
    expect(byWeapon.get(WeaponId.Shrike)).toBe(1);
    expect(byWeapon.get(WeaponId.Harrier)).toBe(2);
    expect(byWeapon.get(WeaponId.Condor)).toBe(4);
    expect(byWeapon.get(WeaponId.Talon)).toBe(5);
    expect(walls.length).toBe(5);
  });

  it('one perk machine per contracted zone', () => {
    const perks = of(InteractableKind.Perk);
    const byPerk = new Map(perks.map((p) => [p.perk, p.zone]));
    expect(byPerk.get(PerkId.Adrenaline)).toBe(2);
    expect(byPerk.get(PerkId.Bulwark)).toBe(3);
    expect(byPerk.get(PerkId.SecondWind)).toBe(4);
    expect(byPerk.get(PerkId.Handloader)).toBe(5);
    expect(byPerk.get(PerkId.HairTrigger)).toBe(6);
    expect(perks.length).toBe(5);
  });

  it('two ammo boxes: spawn room and yard', () => {
    const boxes = of(InteractableKind.AmmoBox);
    expect(boxes.map((b) => b.zone).sort()).toEqual([0, 4]);
  });

  it('power in the engine room, the Forge in the basin, box spots 0 and 1', () => {
    expect(of(InteractableKind.Generator)).toHaveLength(1);
    expect(of(InteractableKind.Generator)[0].zone).toBe(3);
    expect(of(InteractableKind.Forge)).toHaveLength(1);
    expect(of(InteractableKind.Forge)[0].zone).toBe(6);
    const spots = of(InteractableKind.CrateSpot);
    expect(spots.map((s) => s.spot).sort()).toEqual([0, 1]);
    expect(spots.find((s) => s.spot === 0)!.zone).toBe(1);
    expect(spots.find((s) => s.spot === 1)!.zone).toBe(4);
  });

  it('zoneForPosition agrees with the declared zones for the landmarks', () => {
    const forge = of(InteractableKind.Forge)[0];
    const gen = of(InteractableKind.Generator)[0];
    const box0 = of(InteractableKind.CrateSpot).find((s) => s.spot === 0)!;
    expect(zoneForPosition(map, forge.pos)).toBe(6);
    expect(zoneForPosition(map, gen.pos)).toBe(3);
    expect(zoneForPosition(map, box0.pos)).toBe(1);
  });
});

describe('spawners and spawns', () => {
  it('at least 15 spawners, all in bounds, window spawners in their window zone', () => {
    expect(map.zombieSpawners.length).toBeGreaterThanOrEqual(15);
    for (const s of map.zombieSpawners) {
      expect(inBounds(s.pos)).toBe(true);
      if (s.window !== undefined) {
        expect(map.windows[s.window]).toBeDefined();
        expect(s.zone).toBe(map.windows[s.window].zone);
      }
    }
  });

  it('five squad spawns, all on the quarterdeck', () => {
    expect(map.spawns.length).toBe(5);
    for (const sp of map.spawns) {
      expect(inZone(0, sp.position)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The test that keeps the map honest: on the REAL collision geometry, a
// zombie spawned at every window pocket must be able to walk through the
// opening and land a melee swing on a player standing inside the room.
// (Caught live: 1.9m holes popped the capsule onto the roof — the step-up
// probe needs ~2.2m of clearance.)
// ---------------------------------------------------------------------------

import { ZombieHorde, type WindowsView } from '../server/src/net/../sim/zombies/horde.js';
import { buildNavGraph as buildG } from '../shared/navgraph.js';
import { createCollisionWorld } from '../shared/collision.js';
import { hordeBrushesFor, allZonesMask } from '../shared/maps.js';
import { AdsState, Stance, TeamId, DEFAULT_LOADOUT } from '../shared/types.js';
import type { PlayerState } from '../shared/types.js';
import { TICK_DT } from '../shared/tuning.js';

function standing(pos: { x: number; y: number; z: number }): PlayerState {
  return {
    id: 1, position: { ...pos }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
    stance: Stance.Stand, onGround: true, slideTime: 0, slideCooldown: 0, sprintTime: 0,
    health: 100, alive: true, activeWeapon: 1, adsState: AdsState.Hip, adsProgress: 0,
    ammoInMag: 0, ammoReserve: 0, actionEndsAt: 0, name: 't', team: TeamId.Alpha,
    score: 0, kills: 0, deaths: 0, streak: 0, loadout: DEFAULT_LOADOUT, ping: 0,
  };
}

describe('window traversal on the real geometry', () => {
  const mask = allZonesMask(map);
  const world = createCollisionWorld(hordeBrushesFor(map, mask), map.bounds, map.waterLevel);
  const graph = buildG(map.navNodes);

  for (const w of map.windows) {
    it(`window ${w.id} (zone ${w.zone}): spawn, cross, reach the player`, () => {
      const spawner = map.zombieSpawners.find((s) => s.window === w.id)!;
      const soloMap = { ...map, zombieSpawners: [spawner] };
      const horde = new ZombieHorde(soloMap, graph, 12);
      const inside = map.navNodes[w.insideNode].pos;
      const target = standing({ x: inside.x, y: inside.y, z: inside.z });
      const targets = [{ state: target, downed: false }];
      // Boards already down: the zombie should walk straight through.
      const windows: WindowsView = { defs: map.windows, planksOf: () => 0, tear: () => {} };
      const id = horde.spawn(10, mask, 100, 3.0, targets);
      expect(id).toBeGreaterThan(0);

      let attacked = false;
      let maxY = -Infinity;
      for (let t = 11; t < 11 + 60 * 45 && !attacked; t++) {
        const attacks = horde.step(t, TICK_DT, world, mask, targets, windows);
        if (attacks.some((a) => a.targetId === 1)) attacked = true;
        for (const z of horde.actives()) maxY = Math.max(maxY, z.state.position.y);
      }
      expect(attacked, `zombie never reached the player through window ${w.id}`).toBe(true);
      // And it never got popped on top of the wall/roof while crossing.
      expect(maxY).toBeLessThan(w.pos.y + 2.5);
    });
  }
});
