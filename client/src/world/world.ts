/**
 * World assembly: yacht brushes (from shared/mapdata), ocean, pool water,
 * ambient props. This is the map-and-ocean agent's public entry point.
 *
 * Contract:
 *   const world = buildWorld(renderer.scene, materialsRegistry);
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
import { waterNormalTexture } from './textures.js';

export type { MaterialsRegistry } from './brushes.js';

export interface WorldHandle {
  update(dt: number, cameraPos: Vec3): void;
  dispose(): void;
  /** Extra, non-contractual: lets the renderer sync its sun into the ocean. */
  setSun(dir: Vec3, color: number): void;
  /** The ocean, exposed for tooling. */
  ocean: OceanHandle;
}

export interface BuildWorldOptions {
  /** Geometry to build; defaults to the Sundeck BRUSHES. */
  brushes?: readonly Brush[];
  /** Sea level for the ocean shader; defaults to Sundeck's WATER_LEVEL. */
  waterLevel?: number;
  /** Sundeck-specific dressing (pool water, deck props). Default true. */
  sundeckDressing?: boolean;
}

export function buildWorld(
  scene: THREE.Scene,
  materials?: MaterialsRegistry,
  opts: BuildWorldOptions = {},
): WorldHandle {
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);

  const dressing = opts.sundeckDressing !== false && opts.brushes === undefined;

  const brushes = buildBrushes(materials, opts.brushes);
  root.add(brushes.group);

  const props = dressing ? buildProps(root) : null;
  const ocean = buildOcean(root, opts.waterLevel);

  // Pool water: a cheap translucent plane with a scrolling detail normal map.
  // Sundeck-only — Leviathan has no pool where this plane sits.
  let poolWater: THREE.Mesh | null = null;
  let poolMat: THREE.MeshStandardMaterial | null = null;
  let poolNormal: THREE.Texture | null = null;
  if (dressing) {
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
    poolWater = new THREE.Mesh(new THREE.PlaneGeometry(8.2, 13.9), poolMat);
    poolWater.name = 'pool_water';
    poolWater.rotation.x = -Math.PI / 2;
    poolWater.position.set(0, -0.35, 0);
    poolWater.renderOrder = 9;
    root.add(poolWater);
  }

  return {
    ocean,
    update(dt, cameraPos) {
      ocean.update(dt, cameraPos);
      props?.update(dt);
      if (poolNormal) {
        poolNormal.offset.x += dt * 0.015;
        poolNormal.offset.y += dt * 0.011;
      }
    },
    setSun(dir, color) {
      ocean.setSun(dir, color);
    },
    dispose() {
      ocean.dispose();
      props?.dispose();
      brushes.dispose();
      poolWater?.geometry.dispose();
      poolMat?.dispose();
      poolNormal?.dispose();
      root.removeFromParent();
    },
  };
}
