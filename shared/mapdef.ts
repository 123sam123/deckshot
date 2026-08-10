/**
 * DECKSHOT — MapDef vocabulary.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * Split out of `shared/maps.ts` so map data files (leviathan.ts) and the
 * registry can both import these without an ESM cycle: the registry imports
 * the maps, the maps import only this.
 */

import type { Brush, SpawnPoint } from './mapdata.js';
import type { WeaponId, Vec3 } from './types.js';
import type { NavNode } from './navgraph.js';
import type { PerkId } from './survival.js';

export enum MapId {
  Sundeck = 0,
  Leviathan = 1,
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
  /** Cannot be bought until the Generator is on. */
  requiresPower: boolean;
  /** Zones a buyer may open this one from (purchase adjacency). */
  adjacent: readonly number[];
  /** Volume(s) this zone occupies, for zoneForPosition. */
  boxes: readonly ZoneBox[];
}

export enum InteractableKind {
  WallBuy = 0,
  Perk = 1,
  Generator = 2,
  Forge = 3,
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
}

export interface ZombieSpawner {
  zone: number;
  pos: Vec3;
}

export interface MapDef {
  id: MapId;
  name: string;
  /** Full brush set, doors included. */
  brushes: readonly Brush[];
  bounds: { min: Vec3; max: Vec3 };
  waterLevel: number;
  spawns: readonly SpawnPoint[];
  /** Empty for competitive maps. */
  zones: readonly Zone[];
  navNodes: readonly NavNode[];
  interactables: readonly Interactable[];
  zombieSpawners: readonly ZombieSpawner[];
  /**
   * Brush ids removed from collision + visuals when a zone opens, indexed by
   * zone id. Doors/debris live in `brushes` so a closed map is closed.
   */
  doorBrushIdsByZone: readonly (readonly string[])[];
}
