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

/**
 * APPEND-ONLY. A map's value here is the u8 that goes on the wire, so
 * reordering desynchronises an old client from a new server.
 */
export enum MapId {
  Sundeck = 0,
  Leviathan = 1,
  DeathTrap = 2,
  Hangar = 3,
  Rooftop = 4,
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

/** Which decorative, collision-free prop set the client dresses a map with. */
export enum PropSet {
  /** The yacht: rope coils, deck lights, mast, gulls. Sundeck only. */
  Yacht = 'yacht',
  /** Offshore steel: gantry lamps, warning stripes, aerial masts. */
  Rig = 'rig',
  /** Ship's deck: bulkhead lamps, cargo strapping, deck stencils. */
  Hold = 'hold',
  /** Mountain temple: lanterns, banners, stilts, pines. */
  Temple = 'temple',
  /** Nothing. Leviathan dresses itself out of its own brushes. */
  None = 'none',
}

/** What the client builds AROUND a map's brushes. */
export interface MapEnvironment {
  /** Renders the Gerstner-wave ocean at the map's `waterLevel`. */
  ocean: boolean;
  /**
   * Land maps: a distant ground plane instead of the sea. `y` sits far enough
   * below the arena that it reads as a drop, never as a floor.
   */
  ground: { y: number; color: number; size: number } | null;
  props: PropSet;
  /** Sundeck's pool surface. Purely visual; the volume is already brushes. */
  poolWater: { x: number; z: number; y: number; width: number; depth: number } | null;
  /** XZ half-extents the ocean shader foams against. */
  hullHalf: readonly [number, number];
}

/**
 * Where an adapted map came from. Deckshot's own maps carry `null`.
 *
 * Adaptations, not conversions: the original's layout and flow rebuilt at
 * Deckshot's movement metrics. No original geometry, texture or asset is
 * copied. See MAPS.md.
 */
export interface MapCredit {
  original: string;
  authors: string;
  project: string;
  license: string;
  url: string;
}

export interface MapDef {
  id: MapId;
  name: string;
  /** One line of flavour for the lobby's map picker. */
  tagline: string;
  /** Non-null when the layout is adapted from someone else's work. */
  credit: MapCredit | null;
  environment: MapEnvironment;
  /** The signature long shot. Asserted clear by tests/maps.test.ts. */
  sightline: { from: Vec3; to: Vec3 } | null;
  /** True when the map may be picked for FFA / TDM. */
  competitive: boolean;
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
