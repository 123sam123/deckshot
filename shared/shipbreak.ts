/**
 * DECKSHOT — "Shipbreak" map, as data. PLACEHOLDER — being authored.
 *
 * Owner: zombies. A shipbreaker's yard at dusk; see ZOMBIES.md section 3 for
 * the layout contract this file must implement.
 */

import { SurfaceMaterial, BrushTag, type Brush, SpawnZone } from './mapdata.js';
import { MapId, type MapDef } from './mapdef.js';

const deck: Brush = {
  id: 'sb_deck',
  center: { x: 0, y: -0.5, z: 0 },
  half: { x: 20, y: 0.5, z: 20 },
  yaw: 0,
  pitch: 0,
  material: SurfaceMaterial.Metal,
  penetrable: false,
  tag: BrushTag.Deck,
};

export const SHIPBREAK_WATER_LEVEL = -6.0;
export const SHIPBREAK_BOUNDS = {
  min: { x: -64, y: -8, z: -64 },
  max: { x: 64, y: 30, z: 64 },
};

export const SHIPBREAK: MapDef = {
  id: MapId.Shipbreak,
  name: 'Shipbreak',
  brushes: [deck],
  bounds: SHIPBREAK_BOUNDS,
  waterLevel: SHIPBREAK_WATER_LEVEL,
  spawns: [
    { id: 0, position: { x: 0, y: 0, z: 0 }, yaw: 0, zone: SpawnZone.Mid },
    { id: 1, position: { x: 2, y: 0, z: 0 }, yaw: 0, zone: SpawnZone.Mid },
    { id: 2, position: { x: -2, y: 0, z: 0 }, yaw: 0, zone: SpawnZone.Mid },
    { id: 3, position: { x: 0, y: 0, z: 2 }, yaw: 0, zone: SpawnZone.Mid },
  ],
  zones: [
    {
      id: 0,
      name: 'Quarterdeck',
      cost: 0,
      requiresPower: false,
      adjacent: [],
      boxes: [{ min: { x: -20, y: -2, z: -20 }, max: { x: 20, y: 8, z: 20 } }],
    },
  ],
  navNodes: [{ id: 0, pos: { x: 0, y: 0, z: 5 }, zone: 0, edges: [] }],
  interactables: [],
  zombieSpawners: [{ zone: 0, pos: { x: 0, y: 0, z: 10 } }],
  windows: [],
  doorBrushIdsByZone: [[]],
};
