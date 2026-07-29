/**
 * client/src/world — public surface (owned by map-and-ocean).
 *
 *   buildWorld(scene, materials?) -> WorldHandle { update, dispose }
 *
 * `materials` is the renderer-graphics registry; it is tolerated missing.
 */

export { buildWorld } from './world.js';
export type { WorldHandle, MaterialsRegistry } from './world.js';
export { brushMatrix } from './brushes.js';
export { buildOcean } from './ocean.js';
export type { OceanHandle } from './ocean.js';
