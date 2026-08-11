/**
 * Builds the visible yacht from shared/mapdata BRUSHES — never by hand.
 *
 * Physics builds its colliders from the same array, so visual and physical
 * geometry cannot drift. BrushTag drives *presentation only*: railings become
 * tube rails, windows become glass with frames, crates get bevels and
 * stencils, the pool gets tile. The underlying collision volume is always
 * honoured (open tube railings are only used where the brush is penetrable,
 * so bullets already pass through the gaps).
 *
 * Everything is merged into a handful of draw calls, grouped by material.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BRUSHES, BrushTag, SurfaceMaterial } from '../../../shared/mapdata.js';
import type { Brush } from '../../../shared/mapdata.js';
import {
  brushedMetalTexture,
  crateTexture,
  fabricTexture,
  gelcoatTexture,
  poolTileTexture,
  teakTexture,
} from './textures.js';

/** Structural interface for the renderer-graphics material registry. */
export interface MaterialsRegistry {
  get(m: SurfaceMaterial): THREE.Material;
}

/**
 * World transform of a brush. Yaw about +Y is applied first, then pitch about
 * the local X axis — Euler order 'YXZ' gives exactly Ry(yaw) * Rx(pitch).
 * Exported so tools (and anyone visualising colliders) share one definition.
 */
export function brushMatrix(brush: Brush): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(brush.pitch, brush.yaw, 0, 'YXZ'));
  m.setPosition(brush.center.x, brush.center.y, brush.center.z);
  return m;
}

type GroupKey = 'teak' | 'metal' | 'composite' | 'fabric' | 'glass' | 'crate' | 'pool';

const SURFACE_GROUP: Record<SurfaceMaterial, GroupKey> = {
  [SurfaceMaterial.Teak]: 'teak',
  [SurfaceMaterial.Metal]: 'metal',
  [SurfaceMaterial.Glass]: 'glass',
  [SurfaceMaterial.Composite]: 'composite',
  [SurfaceMaterial.Fabric]: 'fabric',
  [SurfaceMaterial.Water]: 'composite', // unused by brushes; safe default
};

const UV_SCALE: Record<GroupKey, number> = {
  teak: 2.2,
  metal: 2.6,
  composite: 2.4,
  fabric: 1.3,
  glass: 4.0,
  crate: 1.85,
  pool: 1.0,
};

/** Re-projects UVs with world-scale box mapping so textures tile uniformly. */
function boxMapUVs(geom: THREE.BufferGeometry, scale: number): void {
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const nor = geom.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = x / scale;
      v = z / scale;
    } else if (nx >= nz) {
      u = z / scale;
      v = y / scale;
    } else {
      u = x / scale;
      v = y / scale;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

class GeometryBucket {
  private buckets = new Map<GroupKey, THREE.BufferGeometry[]>();

  /** Transform `geom` by `matrix` (world), box-map UVs, and file it. */
  add(key: GroupKey, geom: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    let g = geom.index ? geom.toNonIndexed() : geom;
    if (g !== geom) geom.dispose();
    g.applyMatrix4(matrix);
    boxMapUVs(g, UV_SCALE[key]);
    let list = this.buckets.get(key);
    if (!list) {
      list = [];
      this.buckets.set(key, list);
    }
    list.push(g);
  }

  merge(): Map<GroupKey, THREE.BufferGeometry> {
    const out = new Map<GroupKey, THREE.BufferGeometry>();
    for (const [key, list] of this.buckets) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (merged) out.set(key, merged);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Per-tag detail geometry (all in brush-local space)
// ---------------------------------------------------------------------------

/** Open tube railing: top rail, mid rail, posts. Used for penetrable rails. */
function openRailingGeoms(brush: Brush): THREE.BufferGeometry[] {
  const alongZ = brush.half.z >= brush.half.x;
  const len = 2 * (alongZ ? brush.half.z : brush.half.x);
  const h = brush.half.y;
  const geoms: THREE.BufferGeometry[] = [];
  const orient = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    if (alongZ) g.rotateX(Math.PI / 2);
    else g.rotateZ(Math.PI / 2);
    return g;
  };
  const top = orient(new THREE.CylinderGeometry(0.045, 0.045, len, 10, 1));
  top.translate(0, h - 0.045, 0);
  geoms.push(top);
  const mid = orient(new THREE.CylinderGeometry(0.026, 0.026, len, 8, 1));
  mid.translate(0, 0, 0);
  geoms.push(mid);
  const nPosts = Math.max(2, Math.round(len / 1.7) + 1);
  for (let i = 0; i < nPosts; i++) {
    const t = -((alongZ ? brush.half.z : brush.half.x) - 0.06) + (i * (len - 0.12)) / (nPosts - 1);
    const post = new THREE.CylinderGeometry(0.028, 0.028, h * 2, 8, 1);
    post.translate(alongZ ? 0 : t, 0, alongZ ? t : 0);
    geoms.push(post);
  }
  return geoms;
}

/** Solid railing/bulwark: the collision box plus a rounded cap tube on top. */
function solidRailingGeoms(brush: Brush): THREE.BufferGeometry[] {
  const alongZ = brush.half.z >= brush.half.x;
  const len = 2 * (alongZ ? brush.half.z : brush.half.x);
  const box = new THREE.BoxGeometry(brush.half.x * 2, brush.half.y * 2, brush.half.z * 2);
  const r = Math.min(0.09, Math.min(brush.half.x, brush.half.z) * 1.4 + 0.03);
  const cap = new THREE.CylinderGeometry(r, r, len, 10, 1);
  if (alongZ) cap.rotateX(Math.PI / 2);
  else cap.rotateZ(Math.PI / 2);
  cap.translate(0, brush.half.y, 0);
  return [box, cap];
}

/** Window: metal frame + mullions. The glass pane itself goes to 'glass'. */
function windowFrameGeoms(brush: Brush): THREE.BufferGeometry[] {
  // Windows in mapdata are thin along X; handle thin-Z too for safety.
  const thinX = brush.half.x <= brush.half.z;
  const hy = brush.half.y;
  const hl = thinX ? brush.half.z : brush.half.x; // half-length along the pane
  const t = 0.09; // frame depth (across the pane)
  const geoms: THREE.BufferGeometry[] = [];
  const bar = (w: number, h: number, l: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(thinX ? w : l, h, thinX ? l : w);
    g.translate(thinX ? x : z, y, thinX ? z : x);
    geoms.push(g);
  };
  // Top / bottom rails.
  bar(t * 2, 0.06, hl * 2 + 0.16, 0, hy + 0.02, 0);
  bar(t * 2, 0.06, hl * 2 + 0.16, 0, -hy - 0.02, 0);
  // End posts.
  bar(t * 2, hy * 2 + 0.1, 0.08, 0, 0, hl + 0.04);
  bar(t * 2, hy * 2 + 0.1, 0.08, 0, 0, -hl - 0.04);
  // Mullions.
  const n = Math.max(1, Math.round(hl / 0.7) - 1);
  for (let i = 1; i <= n; i++) {
    const z = -hl + (2 * hl * i) / (n + 1);
    bar(t * 1.6, hy * 2, 0.05, 0, 0, z);
  }
  return geoms;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuiltBrushes {
  group: THREE.Group;
  dispose(): void;
}

export function buildBrushes(
  materials?: MaterialsRegistry,
  brushList: readonly Brush[] = BRUSHES,
): BuiltBrushes {
  const bucket = new GeometryBucket();

  for (const brush of brushList) {
    // ZOMBIES window blockers collide with players but are never drawn — the
    // opening the horde climbs through must LOOK open.
    if (brush.playersOnly === true) continue;
    const m = brushMatrix(brush);
    const box = () => new THREE.BoxGeometry(brush.half.x * 2, brush.half.y * 2, brush.half.z * 2);

    switch (brush.tag) {
      case BrushTag.Railing: {
        const geoms = brush.penetrable ? openRailingGeoms(brush) : solidRailingGeoms(brush);
        for (const g of geoms) bucket.add('metal', g, m);
        break;
      }
      case BrushTag.Window: {
        bucket.add('glass', box(), m);
        for (const g of windowFrameGeoms(brush)) bucket.add('metal', g, m);
        break;
      }
      case BrushTag.Crate: {
        const r = Math.min(0.06, Math.min(brush.half.x, brush.half.y, brush.half.z) * 0.35);
        bucket.add('crate', new RoundedBoxGeometry(brush.half.x * 2, brush.half.y * 2, brush.half.z * 2, 2, r), m);
        break;
      }
      case BrushTag.Pool: {
        bucket.add('pool', box(), m);
        break;
      }
      case BrushTag.Cover: {
        if (brush.material === SurfaceMaterial.Fabric) {
          // Loungers: soften the box. Stays inside the collision volume.
          const r = Math.min(0.09, brush.half.y * 0.25);
          bucket.add('fabric', new RoundedBoxGeometry(brush.half.x * 2, brush.half.y * 2, brush.half.z * 2, 2, r), m);
        } else {
          bucket.add(SURFACE_GROUP[brush.material], box(), m);
        }
        break;
      }
      default: {
        bucket.add(SURFACE_GROUP[brush.material], box(), m);
        break;
      }
    }
  }

  // --- Materials: prefer the renderer's registry, fall back to our own -----
  const ownedMaterials: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const own = <T extends THREE.Material>(mat: T, ...textures: THREE.Texture[]): T => {
    ownedMaterials.push(mat);
    ownedTextures.push(...textures);
    return mat;
  };

  const fallback = (key: GroupKey): THREE.Material => {
    switch (key) {
      case 'teak': {
        const t = teakTexture();
        t.repeat.set(1, 1);
        return own(new THREE.MeshStandardMaterial({ map: t, roughness: 0.62, metalness: 0.02 }), t);
      }
      case 'metal': {
        const t = brushedMetalTexture();
        return own(new THREE.MeshStandardMaterial({ map: t, roughness: 0.38, metalness: 0.82 }), t);
      }
      case 'composite': {
        const t = gelcoatTexture();
        return own(new THREE.MeshStandardMaterial({ map: t, roughness: 0.42, metalness: 0.05 }), t);
      }
      case 'fabric': {
        const t = fabricTexture();
        return own(new THREE.MeshStandardMaterial({ map: t, roughness: 0.92, metalness: 0 }), t);
      }
      case 'glass':
        return own(
          new THREE.MeshPhysicalMaterial({
            color: 0xbfe4ee,
            roughness: 0.06,
            metalness: 0,
            transparent: true,
            opacity: 0.26,
            envMapIntensity: 1.4,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
        );
      case 'crate': {
        const t = crateTexture();
        return own(new THREE.MeshStandardMaterial({ map: t, roughness: 0.66, metalness: 0.04 }), t);
      }
      case 'pool': {
        const t = poolTileTexture();
        return own(new THREE.MeshStandardMaterial({ map: t, roughness: 0.16, metalness: 0.02 }), t);
      }
    }
  };

  const REGISTRY_SURFACE: Partial<Record<GroupKey, SurfaceMaterial>> = {
    teak: SurfaceMaterial.Teak,
    metal: SurfaceMaterial.Metal,
    composite: SurfaceMaterial.Composite,
    fabric: SurfaceMaterial.Fabric,
    glass: SurfaceMaterial.Glass,
    // 'crate' and 'pool' intentionally always use our stencil/tile materials.
  };

  const resolve = (key: GroupKey): THREE.Material => {
    const surface = REGISTRY_SURFACE[key];
    if (surface !== undefined && materials) {
      const fromRegistry = materials.get(surface) as THREE.Material | undefined;
      if (fromRegistry) return fromRegistry;
    }
    return fallback(key);
  };

  const group = new THREE.Group();
  group.name = 'brushes';
  const ownedGeometries: THREE.BufferGeometry[] = [];

  for (const [key, geom] of bucket.merge()) {
    const mesh = new THREE.Mesh(geom, resolve(key));
    mesh.name = `brushes_${key}`;
    mesh.castShadow = key !== 'glass';
    mesh.receiveShadow = true;
    if (key === 'glass') mesh.renderOrder = 10;
    ownedGeometries.push(geom);
    group.add(mesh);
  }

  return {
    group,
    dispose() {
      for (const g of ownedGeometries) g.dispose();
      for (const mat of ownedMaterials) mat.dispose();
      for (const t of ownedTextures) t.dispose();
      group.removeFromParent();
    },
  };
}
