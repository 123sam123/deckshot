/**
 * DECKSHOT — map registry.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * `shared/mapdata.ts` is FROZEN and Sundeck-specific; this module wraps it in a
 * `MapDef` and registers other maps beside it, so multi-map consumers (the
 * SURVIVAL server sim, the client world builder) select geometry by mode
 * without touching the frozen file. Engine-free, pure data + pure helpers.
 */

import { BRUSHES, CROSSMAP_SIGHTLINE, SPAWN_POINTS, WATER_LEVEL, WORLD_BOUNDS, type Brush } from './mapdata.js';
import { GameMode, type Vec3 } from './types.js';
import { MapId, PropSet, type Interactable, type MapDef } from './mapdef.js';
import { LEVIATHAN } from './leviathan.js';
import { DEATHTRAP } from './deathtrap.js';
import { HANGAR } from './hangar.js';
import { ROOFTOP } from './rooftop.js';
import { createCollisionWorld, type CollisionWorld } from './collision.js';

export {
  MapId,
  InteractableKind,
  PropSet,
  type Interactable,
  type MapCredit,
  type MapDef,
  type MapEnvironment,
  type Zone,
  type ZoneBox,
  type ZombieSpawner,
} from './mapdef.js';

/** Sundeck, wrapped. The frozen mapdata is the source of truth. */
export const SUNDECK: MapDef = {
  id: MapId.Sundeck,
  name: 'Sundeck',
  tagline: 'A yacht at sea. Pool down the middle, catwalks overhead.',
  credit: null,
  competitive: true,
  environment: {
    ocean: true,
    ground: null,
    props: PropSet.Yacht,
    poolWater: { x: 0, z: 0, y: -0.35, width: 8.2, depth: 13.9 },
    hullHalf: [10.4, 28.6],
  },
  sightline: CROSSMAP_SIGHTLINE,
  brushes: BRUSHES,
  bounds: WORLD_BOUNDS,
  waterLevel: WATER_LEVEL,
  spawns: SPAWN_POINTS,
  zones: [],
  navNodes: [],
  interactables: [],
  zombieSpawners: [],
  doorBrushIdsByZone: [],
};

/**
 * Registry order — what the lobby's map picker shows, left to right.
 * MapId values are the wire format and are append-only; this array is only
 * presentation order, so it may be rearranged freely.
 */
export const MAPS: readonly MapDef[] = [SUNDECK, DEATHTRAP, HANGAR, ROOFTOP, LEVIATHAN];

/** The maps a host may pick for FFA / TDM. */
export const COMPETITIVE_MAPS: readonly MapDef[] = MAPS.filter((m) => m.competitive);

export const DEFAULT_MAP_ID = MapId.Sundeck;

/**
 * SURVIVAL is pinned to Leviathan: it is the only map with zones, a nav graph
 * and zombie spawners, and a competitive map would give the director nothing to
 * work with. The competitive modes take whatever the host picked.
 */
export function mapForMode(mode: GameMode, mapId: MapId = DEFAULT_MAP_ID): MapDef {
  if (mode === GameMode.Survival) return LEVIATHAN;
  const picked = mapById(mapId);
  return picked.competitive ? picked : SUNDECK;
}

/** Unknown ids fall back to the default — a bad wire byte must not kill a match. */
export function mapById(id: MapId): MapDef {
  for (const m of MAPS) if (m.id === id) return m;
  return SUNDECK;
}

/** True when `id` names a map a host may pick for a competitive match. */
export function isCompetitiveMapId(id: number): boolean {
  return COMPETITIVE_MAPS.some((m) => m.id === id);
}

/**
 * One immutable collision world per map, built on first use.
 *
 * Safe to share between rooms: a world is never mutated, and its scratch arrays
 * are written and read inside a single synchronous call. SURVIVAL does NOT use
 * this — its geometry changes as doors open, so `SurvivalDirector` builds and
 * rebuilds its own from `collisionBrushesFor`.
 */
const WORLDS = new Map<MapId, CollisionWorld>();

export function worldForMap(map: MapDef): CollisionWorld {
  // Sundeck's world is the module-level static one; do not duplicate it.
  if (map.id === MapId.Sundeck) return createCollisionWorld();
  let w = WORLDS.get(map.id);
  if (!w) {
    w = createCollisionWorld(map.brushes, map.bounds, map.waterLevel);
    WORLDS.set(map.id, w);
  }
  return w;
}

/**
 * The brushes that collide under a given zone mask: everything except the
 * doors of OPEN zones. Competitive maps have no doors and return `brushes`.
 */
export function collisionBrushesFor(map: MapDef, zoneMask: number): readonly Brush[] {
  if (map.doorBrushIdsByZone.length === 0) return map.brushes;
  const removed = new Set<string>();
  for (let z = 0; z < map.doorBrushIdsByZone.length; z++) {
    if ((zoneMask & (1 << z)) === 0) continue;
    for (const id of map.doorBrushIdsByZone[z]) removed.add(id);
  }
  if (removed.size === 0) return map.brushes;
  return map.brushes.filter((b) => !removed.has(b.id));
}

/** Zone containing a position, or -1. First matching zone in id order wins. */
export function zoneForPosition(map: MapDef, pos: Vec3): number {
  for (const zone of map.zones) {
    for (const box of zone.boxes) {
      if (
        pos.x >= box.min.x &&
        pos.x <= box.max.x &&
        pos.y >= box.min.y &&
        pos.y <= box.max.y &&
        pos.z >= box.min.z &&
        pos.z <= box.max.z
      ) {
        return zone.id;
      }
    }
  }
  return -1;
}

/** Mask with every zone of a map open. */
export function allZonesMask(map: MapDef): number {
  let mask = 0;
  for (const z of map.zones) mask |= 1 << z.id;
  return mask;
}

/** Distance from `pos` to the nearest interactable of the given predicate, with the winner. */
export function nearestInteractable(
  map: MapDef,
  pos: Vec3,
  predicate?: (i: Interactable) => boolean,
): { interactable: Interactable; distance: number } | null {
  let best: Interactable | null = null;
  let bestD = Infinity;
  for (const i of map.interactables) {
    if (predicate && !predicate(i)) continue;
    const dx = i.pos.x - pos.x;
    const dy = i.pos.y - pos.y;
    const dz = i.pos.z - pos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best ? { interactable: best, distance: bestD } : null;
}
