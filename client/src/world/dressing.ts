/**
 * Dressing for the adapted maps — collision-free, like `props.ts`.
 *
 * `props.ts` is the yacht's own kit: rope coils, fenders, gulls, a radar mast.
 * None of that belongs on an offshore rig, a cargo hold or a mountain temple,
 * and cloning it three times would be worse than sharing one small vocabulary.
 * So this file holds a handful of generic pieces — strip lamps, aerial masts,
 * hazard chevrons, paper lanterns, banners — and each `PropSet` picks from them.
 *
 * Placement follows the same rules as props.ts: nothing in a lane at torso
 * height, nothing thick enough to read as cover, nothing on the sightline.
 * Everything is merged or instanced into a handful of draw calls.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PropSet, type MapDef } from '../../../shared/maps.js';
import { brushedMetalTexture, fabricTexture, mulberry32 } from './textures.js';

export interface PropsHandle {
  group: THREE.Group;
  update(dt: number): void;
  dispose(): void;
}

/** Emissive material for anything that should read as a light source. */
function lampMaterial(color: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x111417,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.5,
    metalness: 0,
  });
}

export function buildDressing(parent: THREE.Object3D, map: MapDef): PropsHandle {
  const set = map.environment.props;
  const group = new THREE.Group();
  group.name = `dressing_${set}`;
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const rand = mulberry32(9137);

  const addMerged = (name: string, parts: THREE.BufferGeometry[], mat: THREE.Material): void => {
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!merged) return;
    geoms.push(merged);
    mats.push(mat);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  const [hx, hz] = map.environment.hullHalf;

  if (set === PropSet.Rig || set === PropSet.Hold) {
    const steelTex = brushedMetalTexture(256);
    steelTex.wrapS = steelTex.wrapT = THREE.RepeatWrapping;
    texs.push(steelTex);
    const steel = new THREE.MeshStandardMaterial({ map: steelTex, color: 0x8d949b, roughness: 0.62, metalness: 0.85 });

    // Aerial masts at the four corners of the footprint. Slim enough that no
    // one mistakes one for cover.
    const masts: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (hx - 1.2);
        const z = sz * (hz - 1.6);
        masts.push(new THREE.CylinderGeometry(0.09, 0.13, 6.5, 6).translate(x, 3.25, z));
        masts.push(new THREE.BoxGeometry(1.1, 0.08, 0.08).translate(x, 5.6, z));
        masts.push(new THREE.BoxGeometry(0.8, 0.08, 0.08).translate(x, 6.1, z));
      }
    }
    addMerged('dressing_masts', masts, steel);

    // Strip lamps down both long edges, clear of every walking surface.
    const lamps: THREE.BufferGeometry[] = [];
    for (let z = -hz + 4; z <= hz - 4; z += 6) {
      for (const sx of [-1, 1]) {
        lamps.push(new THREE.BoxGeometry(0.5, 0.09, 1.5).translate(sx * (hx - 0.8), 4.9, z));
      }
    }
    addMerged('dressing_lamps', lamps, lampMaterial(set === PropSet.Rig ? 0xffb347 : 0xd8f4ff, 2.4));

    // Hazard chevrons painted flat on the deck, either end.
    const paint: THREE.BufferGeometry[] = [];
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        paint.push(
          new THREE.BoxGeometry(1.6, 0.02, 0.42)
            .translate(-3.2 + i * 1.6, 0.015, sz * (hz - 3.4))
        );
      }
    }
    addMerged('dressing_chevrons', paint, new THREE.MeshStandardMaterial({ color: 0xd8b33a, roughness: 0.85 }));
  }

  if (set === PropSet.Temple) {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x7d2b26, roughness: 0.78, metalness: 0 });

    // Lantern posts along the verandas and out on the planks.
    const posts: THREE.BufferGeometry[] = [];
    const globes: THREE.BufferGeometry[] = [];
    const spots: Array<[number, number]> = [
      [-9.4, 8.4], [9.4, 8.4], [-9.4, -8.4], [9.4, -8.4],
      [-2.4, 15], [2.4, 15], [-2.4, -15], [2.4, -15],
      [-4.4, 24], [4.4, 24], [-4.4, -24], [4.4, -24],
    ];
    for (const [x, z] of spots) {
      posts.push(new THREE.CylinderGeometry(0.06, 0.07, 2.2, 6).translate(x, 1.1, z));
      globes.push(new THREE.SphereGeometry(0.22, 8, 6).translate(x, 2.35, z));
    }
    addMerged('dressing_posts', posts, woodMat);
    addMerged('dressing_lanterns', globes, lampMaterial(0xffa14a, 3.2));

    // Banners hung under the shrine eaves. Fabric, and thin enough to read as
    // cloth rather than cover.
    const bannerTex = fabricTexture(128);
    texs.push(bannerTex);
    const banners: THREE.BufferGeometry[] = [];
    for (const sz of [-1, 1]) {
      for (const x of [-4.2, 0, 4.2]) {
        banners.push(new THREE.BoxGeometry(0.7, 1.4, 0.03).translate(x, 2.35, sz * 7.6));
      }
    }
    addMerged(
      'dressing_banners',
      banners,
      new THREE.MeshStandardMaterial({ map: bannerTex, color: 0xd8433a, roughness: 0.92, side: THREE.DoubleSide })
    );

    const ground = map.environment.ground;

    // The stilts the whole map stands on. Without them the decks float and the
    // drop under them does not read at all — you cannot tell you are 26m up.
    // They stop 0.6m short of the floor so they never z-fight with it.
    if (ground) {
      const legs: THREE.BufferGeometry[] = [];
      const drop = -ground.y - 0.6;
      const foot: Array<[number, number]> = [
        [-8.6, 11.4], [8.6, 11.4], [-8.6, -11.4], [8.6, -11.4],
        [-8.6, 4], [8.6, 4], [-8.6, -4], [8.6, -4],
        [-3.6, 20], [3.6, 20], [-3.6, -20], [3.6, -20],
        [-3.6, 25.6], [3.6, 25.6], [-3.6, -25.6], [3.6, -25.6],
      ];
      for (const [x, z] of foot) {
        legs.push(new THREE.CylinderGeometry(0.4, 0.55, drop, 6).translate(x, -0.4 - drop / 2, z));
      }
      // Cross-bracing, so they read as a timber frame rather than pipes.
      for (let i = 0; i < foot.length; i += 2) {
        const [ax, az] = foot[i];
        const [bx] = foot[i + 1];
        for (const y of [-5, -12, -19]) {
          legs.push(new THREE.BoxGeometry(bx - ax, 0.3, 0.3).translate((ax + bx) / 2, y, az));
        }
      }
      addMerged('dressing_stilts', legs, woodMat);
    }

    // A ring of pines on the valley floor. Pure parallax — they exist so the
    // drop reads as a mountainside, not a void.
    if (ground) {
      const trunks: THREE.BufferGeometry[] = [];
      const canopy: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 34; i++) {
        const a = (i / 34) * Math.PI * 2 + rand() * 0.25;
        const r = 34 + rand() * 52;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y = ground.y;
        const h = 9 + rand() * 8;
        trunks.push(new THREE.CylinderGeometry(0.25, 0.4, h, 5).translate(x, y + h / 2, z));
        canopy.push(new THREE.ConeGeometry(2.1 + rand(), h * 1.1, 6).translate(x, y + h * 1.2, z));
      }
      addMerged('dressing_trunks', trunks, new THREE.MeshStandardMaterial({ color: 0x3c2b1e, roughness: 0.95 }));
      addMerged('dressing_pines', canopy, new THREE.MeshStandardMaterial({ color: 0x24422a, roughness: 0.95 }));
    }
  }

  parent.add(group);

  return {
    group,
    update() {
      // Everything here is static. Kept for interface parity with props.ts.
    },
    dispose() {
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
      for (const t of texs) t.dispose();
      group.removeFromParent();
    },
  };
}
