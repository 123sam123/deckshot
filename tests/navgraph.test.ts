/**
 * DECKSHOT — nav graph solver + Leviathan map-data integrity.
 *
 * Owner: survival. The gating rule (an edge is traversable iff the zone it
 * enters is open) is what makes "zombies only path where players have paid to
 * open" true; these tests pin it per unlock state on the real map data.
 */

import { describe, expect, it } from 'vitest';

import {
  buildNavGraph,
  findPath,
  nearestNode,
  reachableNodes,
  zoneOpen,
} from '../shared/navgraph.js';
import type { NavNode } from '../shared/navgraph.js';
import { LEVIATHAN, LEVIATHAN_TOTAL_UNLOCK_COST } from '../shared/leviathan.js';
import { allZonesMask, collisionBrushesFor, zoneForPosition } from '../shared/maps.js';
import { InteractableKind } from '../shared/mapdef.js';
import { WORLD_HALF_EXTENT } from '../shared/tuning.js';
import { assertSymmetric } from '../shared/mapdata.js';

// A tiny hand-made graph: two zones, a gate between them.
//   0 --- 1 ===gate=== 2 --- 3     (0,1 in zone 0; 2,3 in zone 1)
const TINY: NavNode[] = [
  { id: 0, pos: { x: 0, y: 0, z: 0 }, zone: 0, edges: [1] },
  { id: 1, pos: { x: 1, y: 0, z: 0 }, zone: 0, edges: [0, 2] },
  { id: 2, pos: { x: 2, y: 0, z: 0 }, zone: 1, edges: [1, 3] },
  { id: 3, pos: { x: 3, y: 0, z: 0 }, zone: 1, edges: [2] },
];

describe('nav graph solver', () => {
  it('paths within an open zone', () => {
    const g = buildNavGraph(TINY);
    expect(findPath(g, 0, 1, 0b01)).toEqual([0, 1]);
  });

  it('refuses to enter a closed zone, then allows it the moment it opens', () => {
    const g = buildNavGraph(TINY);
    expect(findPath(g, 0, 3, 0b01)).toBeNull();
    expect(findPath(g, 0, 3, 0b11)).toEqual([0, 1, 2, 3]);
  });

  it('nearestNode ignores closed zones and breaks ties deterministically', () => {
    const g = buildNavGraph(TINY);
    expect(nearestNode(g, { x: 3, y: 0, z: 0 }, 0b01)).toBe(1);
    expect(nearestNode(g, { x: 3, y: 0, z: 0 }, 0b11)).toBe(3);
    expect(nearestNode(g, { x: -5, y: 0, z: 0 }, 0)).toBe(-1);
  });

  it('reachableNodes matches the mask exactly', () => {
    const g = buildNavGraph(TINY);
    expect([...reachableNodes(g, 0, 0b01)].sort()).toEqual([0, 1]);
    expect(reachableNodes(g, 0, 0b11).size).toBe(4);
  });

  it('rejects graphs with non-dense ids or dangling edges', () => {
    expect(() =>
      buildNavGraph([{ id: 1, pos: { x: 0, y: 0, z: 0 }, zone: 0, edges: [] }]),
    ).toThrow();
    expect(() =>
      buildNavGraph([{ id: 0, pos: { x: 0, y: 0, z: 0 }, zone: 0, edges: [9] }]),
    ).toThrow();
  });
});

describe('Leviathan nav data', () => {
  const graph = buildNavGraph(LEVIATHAN.navNodes);
  const fullMask = allZonesMask(LEVIATHAN);
  const spawnNode = nearestNode(graph, LEVIATHAN.spawns[0].position, 1);

  it('every edge is bidirectional', () => {
    for (const n of LEVIATHAN.navNodes) {
      for (const e of n.edges) {
        expect(LEVIATHAN.navNodes[e].edges).toContain(n.id);
      }
    }
  });

  it('every node sits inside the zone it claims', () => {
    for (const n of LEVIATHAN.navNodes) {
      expect(zoneForPosition(LEVIATHAN, n.pos)).toBe(n.zone);
    }
  });

  it('has no orphans: everything is reachable with all zones open', () => {
    const reach = reachableNodes(graph, spawnNode, fullMask);
    expect(reach.size).toBe(LEVIATHAN.navNodes.length);
  });

  it('with only the Aft Deck open, nothing outside zone 0 is reachable', () => {
    const reach = reachableNodes(graph, spawnNode, 1);
    for (const id of reach) {
      expect(LEVIATHAN.navNodes[id].zone).toBe(0);
    }
    expect(reach.size).toBeGreaterThan(0);
  });

  it('each unlock along the canonical route opens exactly that zone of the graph', () => {
    // Aft Deck -> Promenade -> Galley -> Engine -> Atrium -> Bridge/Cargo -> Sun Deck
    const order = [1, 2, 3, 4, 5, 6, 7];
    let mask = 1;
    for (const zone of order) {
      const before = reachableNodes(graph, spawnNode, mask);
      mask |= 1 << zone;
      const after = reachableNodes(graph, spawnNode, mask);
      const gained = [...after].filter((id) => !before.has(id));
      // Everything newly reachable belongs to the zone just opened.
      for (const id of gained) {
        expect(LEVIATHAN.navNodes[id].zone).toBe(zone);
      }
      // And the whole zone came online (its nodes are all connected).
      const zoneNodes = LEVIATHAN.navNodes.filter((n) => n.zone === zone);
      expect(gained.length).toBe(zoneNodes.length);
    }
  });

  it('zombies can path from an aft spawner to the sun deck once everything is open', () => {
    const from = nearestNode(graph, LEVIATHAN.zombieSpawners[0].pos, fullMask);
    const to = nearestNode(graph, { x: 4, y: 3.5, z: 62 }, fullMask);
    const path = findPath(graph, from, to, fullMask);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(5);
  });
});

describe('Leviathan map data', () => {
  it('Sundeck still passes its symmetry contract; Leviathan is exempt by design', () => {
    // The competitive map's fairness invariant must survive this feature.
    expect(() => assertSymmetric()).not.toThrow();
  });

  it('is deliberately asymmetric — the symmetry contract stays Sundeck-only', () => {
    // A progression map has no mirror; assert at least one brush breaks Z-mirror symmetry.
    const counts = new Map<string, number>();
    const key = (b: (typeof LEVIATHAN.brushes)[number]): string =>
      `${b.center.x},${b.center.y},${Math.abs(b.center.z)},${b.half.x},${b.half.y},${b.half.z}`;
    for (const b of LEVIATHAN.brushes) {
      if (Math.abs(b.center.z) < 1e-6) continue;
      counts.set(key(b), (counts.get(key(b)) ?? 0) + 1);
    }
    let odd = 0;
    for (const [, n] of counts) if (n % 2 !== 0) odd++;
    expect(odd).toBeGreaterThan(0);
  });

  it('fits inside the wire quantization range', () => {
    for (const b of LEVIATHAN.brushes) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(Math.abs(b.center[axis]) + Math.abs(b.half[axis])).toBeLessThan(WORLD_HALF_EXTENT);
      }
    }
  });

  it('every zone has at least one spawner, one nav node and one door (except spawn)', () => {
    for (const zone of LEVIATHAN.zones) {
      expect(LEVIATHAN.zombieSpawners.some((s) => s.zone === zone.id)).toBe(true);
      expect(LEVIATHAN.navNodes.some((n) => n.zone === zone.id)).toBe(true);
      if (zone.id === 0) {
        expect(LEVIATHAN.doorBrushIdsByZone[0].length).toBe(0);
      } else {
        expect(LEVIATHAN.doorBrushIdsByZone[zone.id].length).toBeGreaterThan(0);
      }
    }
  });

  it('door brush ids all exist, and opening zones removes exactly those brushes', () => {
    const ids = new Set(LEVIATHAN.brushes.map((b) => b.id));
    expect(ids.size).toBe(LEVIATHAN.brushes.length); // ids unique
    let doorCount = 0;
    for (const doors of LEVIATHAN.doorBrushIdsByZone) {
      for (const id of doors) {
        expect(ids.has(id)).toBe(true);
        doorCount++;
      }
    }
    const closed = collisionBrushesFor(LEVIATHAN, 1);
    const open = collisionBrushesFor(LEVIATHAN, allZonesMask(LEVIATHAN));
    expect(closed.length).toBe(LEVIATHAN.brushes.length);
    expect(open.length).toBe(LEVIATHAN.brushes.length - doorCount);
  });

  it('interactables sit in valid zones and cover the whole feature set', () => {
    const kinds = new Set(LEVIATHAN.interactables.map((i) => i.kind));
    expect(kinds).toContain(InteractableKind.WallBuy);
    expect(kinds).toContain(InteractableKind.Perk);
    expect(kinds).toContain(InteractableKind.Generator);
    expect(kinds).toContain(InteractableKind.Forge);
    expect(kinds).toContain(InteractableKind.CrateSpot);
    for (const i of LEVIATHAN.interactables) {
      expect(LEVIATHAN.zones.some((z) => z.id === i.zone)).toBe(true);
    }
    // Five perk machines, five wall buys, two crate spots.
    expect(LEVIATHAN.interactables.filter((i) => i.kind === InteractableKind.Perk).length).toBe(5);
    expect(LEVIATHAN.interactables.filter((i) => i.kind === InteractableKind.WallBuy).length).toBe(5);
    expect(LEVIATHAN.interactables.filter((i) => i.kind === InteractableKind.CrateSpot).length).toBe(2);
  });

  it('the full unlock costs what the zones say', () => {
    const sum = LEVIATHAN.zones.reduce((s, z) => s + z.cost, 0);
    expect(LEVIATHAN_TOTAL_UNLOCK_COST).toBe(sum);
    expect(sum).toBeGreaterThan(9000);
  });

  it('gating rule spot check: Bridge is closed off until bought even with power on', () => {
    const graph2 = buildNavGraph(LEVIATHAN.navNodes);
    // Everything open except the Bridge (zone 5).
    const mask = allZonesMask(LEVIATHAN) & ~(1 << 5);
    expect(zoneOpen(mask, 5)).toBe(false);
    const spawn = nearestNode(graph2, LEVIATHAN.spawns[0].position, mask);
    const reach = reachableNodes(graph2, spawn, mask);
    for (const id of reach) {
      expect(LEVIATHAN.navNodes[id].zone).not.toBe(5);
    }
  });
});
