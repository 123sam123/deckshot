/**
 * World assembly for ONE map: its brushes, its ocean or its valley floor, its
 * pool water, its dressing. The map-and-ocean agent's public entry point.
 *
 * A world belongs to exactly one map (and, on Leviathan, one zone mask). Brush
 * geometry is merged at build time, so changing map means dispose() and a fresh
 * buildWorld — never mutating this one.
 *
 * Contract:
 *   const world = buildWorld(renderer.scene, materialsRegistry, { map });
 *   world.update(dt, cameraPos);  // every frame
 *   world.dispose();              // on teardown
 *
 * `materials` is the renderer-graphics PBR registry keyed by SurfaceMaterial.
 * It is optional: if absent (or if a lookup returns undefined) we fall back
 * to our own procedural MeshStandardMaterials, so the world always renders.
 */

import * as THREE from 'three';
import type { Vec3 } from '../../../shared/types.js';
import type { Brush } from '../../../shared/mapdata.js';
import { buildBrushes } from './brushes.js';
import type { MaterialsRegistry } from './brushes.js';
import { buildOcean } from './ocean.js';
import type { OceanHandle } from './ocean.js';
import { buildProps } from './props.js';
import { buildDressing } from './dressing.js';
import { PropSet, SUNDECK, type MapDef } from '../../../shared/maps.js';
import { waterNormalTexture } from './textures.js';

export type { MaterialsRegistry } from './brushes.js';

export interface WorldHandle {
  update(dt: number, cameraPos: Vec3): void;
  dispose(): void;
  /** Extra, non-contractual: lets the renderer sync its sun into the ocean. */
  setSun(dir: Vec3, color: number): void;
  /** The map this world was built from. */
  map: MapDef;
  /** The ocean, exposed for tooling. Null on land maps. */
  ocean: OceanHandle | null;
}

export interface BuildWorldOptions {
  /** The map to build. Defaults to Sundeck. */
  map?: MapDef;
  /**
   * Geometry override. SURVIVAL passes the zone-filtered brush set here, which
   * is why this is separate from `map` rather than read off it.
   */
  brushes?: readonly Brush[];
}

export function buildWorld(
  scene: THREE.Scene,
  materials?: MaterialsRegistry,
  opts: BuildWorldOptions = {},
): WorldHandle {
  const map = opts.map ?? SUNDECK;
  const env = map.environment;
  const root = new THREE.Group();
  root.name = `world_${map.id}`;
  scene.add(root);

  const brushes = buildBrushes(materials, opts.brushes ?? map.brushes);
  root.add(brushes.group);

  // The yacht has its own hand-built kit; the adapted maps share the generic
  // vocabulary in dressing.ts; Leviathan dresses itself out of its brushes.
  const props =
    env.props === PropSet.Yacht ? buildProps(root) : env.props === PropSet.None ? null : buildDressing(root, map);

  const ocean = env.ocean ? buildOcean(root, map.waterLevel) : null;

  // Land maps: a valley floor far below, so the drop reads as height rather
  // than as a hole in the world. Never walkable — the kill height is metres
  // above it, so you die long before you would land.
  let ground: THREE.Mesh | null = null;
  if (env.ground) {
    const groundMat = new THREE.MeshStandardMaterial({ color: env.ground.color, roughness: 0.98, metalness: 0 });
    ground = new THREE.Mesh(new THREE.PlaneGeometry(env.ground.size, env.ground.size), groundMat);
    ground.name = 'valley_floor';
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, env.ground.y, 0);
    root.add(ground);
  }

  // Pool water: a cheap translucent plane with a scrolling detail normal map.
  // Sundeck-only — Leviathan has no pool where this plane sits.
  let poolWater: THREE.Mesh | null = null;
  let poolMat: THREE.MeshStandardMaterial | null = null;
  let poolNormal: THREE.Texture | null = null;
  if (env.poolWater) {
    poolNormal = waterNormalTexture(128, 811, 1.6);
    poolNormal.repeat.set(3, 5);
    poolMat = new THREE.MeshStandardMaterial({
      color: 0x1f96a4,
      roughness: 0.22,
      metalness: 0,
      transparent: true,
      opacity: 0.5,
      normalMap: poolNormal,
      normalScale: new THREE.Vector2(0.4, 0.4),
      depthWrite: false,
    });
    poolWater = new THREE.Mesh(new THREE.PlaneGeometry(env.poolWater.width, env.poolWater.depth), poolMat);
    poolWater.name = 'pool_water';
    poolWater.rotation.x = -Math.PI / 2;
    poolWater.position.set(env.poolWater.x, env.poolWater.y, env.poolWater.z);
    poolWater.renderOrder = 9;
    root.add(poolWater);
  }

  return {
    map,
    ocean,
    update(dt, cameraPos) {
      ocean?.update(dt, cameraPos);
      props?.update(dt);
      if (poolNormal) {
        poolNormal.offset.x += dt * 0.015;
        poolNormal.offset.y += dt * 0.011;
      }
    },
    setSun(dir, color) {
      ocean?.setSun(dir, color);
    },
    dispose() {
      ocean?.dispose();
      props?.dispose();
      brushes.dispose();
      poolWater?.geometry.dispose();
      poolMat?.dispose();
      poolNormal?.dispose();
      if (ground) {
        ground.geometry.dispose();
        (ground.material as THREE.Material).dispose();
      }
      root.removeFromParent();
    },
  };
}
