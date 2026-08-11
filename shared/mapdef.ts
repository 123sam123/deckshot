/**
 * DECKSHOT — MapDef vocabulary.
 *
 * Owner: zombies (rewritten with the mode).
 *
 * Split out of `shared/maps.ts` so map data files (shipbreak.ts) and the
 * registry can both import these without an ESM cycle: the registry imports
 * the maps, the maps import only this.
 */

import type { Brush, SpawnPoint } from './mapdata.js';
import type { WeaponId, Vec3 } from './types.js';
import type { NavNode } from './navgraph.js';
import type { PerkId } from './zombies.js';

export enum MapId {
  Sundeck = 0,
  Shipbreak = 1,
}

/** Axis-aligned box, used for zone membership tests. */
export interface ZoneBox {
  min: Vec3;
  max: Vec3;
}

export interface Zone {
  /** Dense index; bit position in the zone mask. */
  id: number;
  name: string;
  /** Points to open. 0 = open from the start. */
  cost: number;
  /** Cannot be bought until the power is on. */
  requiresPower: boolean;
  /** Zones a buyer may open this one from (purchase adjacency). */
  adjacent: readonly number[];
  /** Volume(s) this zone occupies, for zoneForPosition. */
  boxes: readonly ZoneBox[];
}

export enum InteractableKind {
  WallBuy = 0,
  Perk = 1,
  /** The power switch. */
  Generator = 2,
  /** Pack-a-punch. */
  Forge = 3,
  /** A mystery box location. */
  CrateSpot = 4,
}

export interface Interactable {
  kind: InteractableKind;
  zone: number;
  pos: Vec3;
  /** WallBuy only. */
  weapon?: WeaponId;
  /** Perk only. */
  perk?: PerkId;
  /** CrateSpot only: dense spot index (box location on the wire). */
  spot?: number;
}

export interface ZombieSpawner {
  zone: number;
  pos: Vec3;
  /** Window this spawner feeds, or -1 for an open-air spawner. */
  window?: number;
}

/**
 * A boarded window: zombies outside tear planks and climb through; players
 * inside rebuild them for points. The blocker brush stops players (and
 * bullets pass — author it penetrable); zombie locomotion ignores it, so the
 * horde walks through the opening once the planks are down.
 */
export interface WindowDef {
  /** Dense index; order defines the wire layout of plank counts. */
  id: number;
  /** Zone whose room the window opens into. */
  zone: number;
  /** Centre of the opening (plank meshes anchor here). */
  pos: Vec3;
  /** Yaw of the window plane, radians (planks face this way). */
  yaw: number;
  /** Brush id of the invisible player-blocker in the opening. */
  blockerBrushId: string;
  /** Nav node just outside the window (spawner side). */
  outsideNode: number;
  /** Nav node just inside the room. */
  insideNode: number;
}

export interface MapDef {
  id: MapId;
  name: string;
  /** Full brush set, doors and window blockers included. */
  brushes: readonly Brush[];
  bounds: { min: Vec3; max: Vec3 };
  waterLevel: number;
  spawns: readonly SpawnPoint[];
  /** Empty for competitive maps. */
  zones: readonly Zone[];
  navNodes: readonly NavNode[];
  interactables: readonly Interactable[];
  zombieSpawners: readonly ZombieSpawner[];
  windows: readonly WindowDef[];
  /**
   * Brush ids removed from collision + visuals when a zone opens, indexed by
   * zone id. Doors/debris live in `brushes` so a closed map is closed.
   */
  doorBrushIdsByZone: readonly (readonly string[])[];
}
