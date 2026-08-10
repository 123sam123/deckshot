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

import { BRUSHES, SPAWN_POINTS, WATER_LEVEL, WORLD_BOUNDS, type Brush } from './mapdata.js';
import { GameMode, type Vec3 } from './types.js';
import { MapId, type Interactable, type MapDef } from './mapdef.js';
import { LEVIATHAN } from './leviathan.js';

export {
  MapId,
  InteractableKind,
  type Interactable,
  type MapDef,
  type Zone,
  type ZoneBox,
  type ZombieSpawner,
} from './mapdef.js';

/** Sundeck, wrapped. The frozen mapdata is the source of truth. */
export const SUNDECK: MapDef = {
  id: MapId.Sundeck,
  name: 'Sundeck',
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

export function mapForMode(mode: GameMode): MapDef {
  return mode === GameMode.Survival ? LEVIATHAN : SUNDECK;
}

export function mapById(id: MapId): MapDef {
  return id === MapId.Leviathan ? LEVIATHAN : SUNDECK;
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
