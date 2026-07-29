/**
 * Ambient, collision-free props: rope coils, cleats, deck light strips,
 * fenders, awnings, life rings, radar masts, a bow fairing, circling gulls.
 *
 * These live here (NOT in mapdata — that file is frozen and collision-only).
 * Everything static is merged or instanced; per-frame work is limited to the
 * gulls (a handful of instance matrices) and the two radar bars.
 *
 * Placement rules: nothing enters the mid corridor (|x| < 2 below the roofs),
 * nothing sits in a lane at torso height unless it is rail-thin, and anything
 * that could read as cover is kept visually slim so players never trust a
 * prop to stop a bullet.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { UPPER_DECK_Y } from '../../../shared/mapdata.js';
import {
  brushedMetalTexture,
  fabricTexture,
  gelcoatTexture,
  lifeRingTexture,
  mulberry32,
  ropeTexture,
} from './textures.js';

export interface PropsHandle {
  group: THREE.Group;
  update(dt: number): void;
  dispose(): void;
}

interface Gull {
  radius: number;
  height: number;
  speed: number;
  phase: number;
  centerZ: number;
}

function gullGeometry(): THREE.BufferGeometry {
  // A stylised gull: slim body diamond + two swept wings. ~10 triangles.
  const v: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => v.push(...a, ...b, ...c);
  // Body (two long triangles top/bottom).
  tri([0, 0, 0.28], [0.05, 0.03, -0.02], [-0.05, 0.03, -0.02]);
  tri([0, 0, 0.28], [-0.05, -0.02, -0.02], [0.05, -0.02, -0.02]);
  tri([0.05, 0.03, -0.02], [0, 0.01, -0.22], [-0.05, 0.03, -0.02]);
  tri([-0.05, -0.02, -0.02], [0, 0.01, -0.22], [0.05, -0.02, -0.02]);
  // Wings: swept back, tips raised.
  tri([0.04, 0.02, 0.06], [0.55, 0.1, -0.1], [0.04, 0.02, -0.08]);
  tri([-0.04, 0.02, 0.06], [-0.04, 0.02, -0.08], [-0.55, 0.1, -0.1]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  geom.computeVertexNormals();
  return geom;
}

export function buildProps(parent: THREE.Object3D): PropsHandle {
  const group = new THREE.Group();
  group.name = 'props';
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const rand = mulberry32(4242);

  const keepG = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeometries.push(g);
    return g;
  };
  const keepM = <T extends THREE.Material>(m: T, ...t: THREE.Texture[]): T => {
    ownedMaterials.push(m);
    ownedTextures.push(...t);
    return m;
  };

  const metalTex = brushedMetalTexture();
  const metalMat = keepM(new THREE.MeshStandardMaterial({ map: metalTex, roughness: 0.4, metalness: 0.8 }), metalTex);
  const gelTex = gelcoatTexture();
  const hullMat = keepM(new THREE.MeshStandardMaterial({ map: gelTex, roughness: 0.35, metalness: 0.08 }), gelTex);
  const fabricTex = fabricTexture();
  const fabricMat = keepM(
    new THREE.MeshStandardMaterial({ map: fabricTex, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
    fabricTex
  );

  const addMerged = (name: string, geoms: THREE.BufferGeometry[], mat: THREE.Material, shadows = true): THREE.Mesh => {
    const nonIndexed = geoms.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      if (n !== g) g.dispose();
      return n;
    });
    const merged = keepG(mergeGeometries(nonIndexed, false));
    for (const g of nonIndexed) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    group.add(mesh);
    return mesh;
  };

  const instanced = (
    name: string,
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    placements: { pos: [number, number, number]; yaw?: number; rotX?: number; rotZ?: number }[]
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(keepG(geom), mat, placements.length);
    mesh.name = name;
    const m = new THREE.Matrix4();
    const e = new THREE.Euler();
    const qt = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const pv = new THREE.Vector3();
    placements.forEach((pl, i) => {
      e.set(pl.rotX ?? 0, pl.yaw ?? 0, pl.rotZ ?? 0, 'YXZ');
      qt.setFromEuler(e);
      pv.set(pl.pos[0], pl.pos[1], pl.pos[2]);
      m.compose(pv, qt, s);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // --- Rope coils: three stacked tori, on the fore/aft decks and walkway ends
  {
    const ropeTex = ropeTexture();
    const ropeMat = keepM(new THREE.MeshStandardMaterial({ map: ropeTex, roughness: 0.85 }), ropeTex);
    const coil = mergeGeometries(
      [0, 1, 2].map((i) => {
        const t = new THREE.TorusGeometry(0.34 - i * 0.025, 0.05, 8, 24).toNonIndexed();
        t.rotateX(Math.PI / 2);
        t.translate(0, 0.05 + i * 0.09, 0);
        return t;
      }),
      false
    );
    instanced('prop_ropes', coil, ropeMat, [
      { pos: [3.4, 0, 23.6], yaw: rand() * 6 },
      { pos: [-3.4, 0, 23.6], yaw: rand() * 6 },
      { pos: [3.4, 0, -23.6], yaw: rand() * 6 },
      { pos: [-3.4, 0, -23.6], yaw: rand() * 6 },
      { pos: [8.5, 0, 24.9], yaw: rand() * 6 },
      { pos: [-8.5, 0, 24.9], yaw: rand() * 6 },
      { pos: [8.5, 0, -24.9], yaw: rand() * 6 },
      { pos: [-8.5, 0, -24.9], yaw: rand() * 6 },
    ]);
  }

  // --- Mooring cleats along the bulwark tops -------------------------------
  {
    const base = new THREE.BoxGeometry(0.14, 0.06, 0.3).toNonIndexed();
    const horn = new THREE.CylinderGeometry(0.035, 0.035, 0.4, 8).toNonIndexed();
    horn.rotateX(Math.PI / 2);
    horn.translate(0, 0.12, 0);
    const riser = new THREE.CylinderGeometry(0.03, 0.04, 0.1, 8).toNonIndexed();
    riser.translate(0, 0.07, 0);
    const cleat = mergeGeometries([base, horn, riser], false);
    const places: { pos: [number, number, number] }[] = [];
    for (const z of [-20, -10, 0, 10, 20]) {
      places.push({ pos: [9.25, 1.23, z] }, { pos: [-9.25, 1.23, z] });
    }
    instanced('prop_cleats', cleat, metalMat, places);
  }

  // --- Deck lighting strips (emissive, golden-hour warm) -------------------
  {
    const strips: THREE.BufferGeometry[] = [];
    const strip = (w: number, l: number, x: number, y: number, z: number) => {
      const g = new THREE.BoxGeometry(w, 0.035, l);
      g.translate(x, y, z);
      strips.push(g);
    };
    // Along the base of each bulwark.
    strip(0.05, 51, 8.92, 0.05, 0);
    strip(0.05, 51, -8.92, 0.05, 0);
    // Pool coping ring.
    strip(0.05, 14.6, 4.38, 0.03, 0);
    strip(0.05, 14.6, -4.38, 0.03, 0);
    strips.push(new THREE.BoxGeometry(8.9, 0.035, 0.05).translate(0, 0.03, 7.38));
    strips.push(new THREE.BoxGeometry(8.9, 0.035, 0.05).translate(0, 0.03, -7.38));
    // Catwalk undersides, washing the pool.
    strip(0.08, 21.6, 5.5, 3.12, 0);
    strip(0.08, 21.6, -5.5, 3.12, 0);
    // Spawn platform steps.
    strips.push(new THREE.BoxGeometry(10.8, 0.035, 0.05).translate(0, 0.53, 26.12));
    strips.push(new THREE.BoxGeometry(10.8, 0.035, 0.05).translate(0, 0.53, -26.12));
    const mat = keepM(
      new THREE.MeshStandardMaterial({ color: 0x201408, emissive: 0xffb168, emissiveIntensity: 2.2, roughness: 0.6 })
    );
    addMerged('prop_lightstrips', strips, mat, false);
  }

  // --- Fenders hung outboard ----------------------------------------------
  {
    const fender = new THREE.CapsuleGeometry(0.26, 0.55, 4, 10);
    const places: { pos: [number, number, number] }[] = [];
    for (const z of [-18, -9, 0, 9, 18]) {
      places.push({ pos: [10.32, -0.55, z] }, { pos: [-10.32, -0.55, z] });
    }
    const fenderMat = keepM(new THREE.MeshStandardMaterial({ color: 0xe8e6de, roughness: 0.7 }));
    instanced('prop_fenders', fender, fenderMat, places);
  }

  // --- Life rings on cabin walls and spawn rails ---------------------------
  {
    const ringTex = lifeRingTexture();
    const ringMat = keepM(new THREE.MeshStandardMaterial({ map: ringTex, roughness: 0.6 }), ringTex);
    const ring = new THREE.TorusGeometry(0.4, 0.1, 10, 28);
    instanced('prop_liferings', ring, ringMat, [
      { pos: [5.1, 1.7, 16], yaw: Math.PI / 2 },
      { pos: [-5.1, 1.7, 16], yaw: Math.PI / 2 },
      { pos: [5.1, 1.7, -16], yaw: Math.PI / 2 },
      { pos: [-5.1, 1.7, -16], yaw: Math.PI / 2 },
      { pos: [0, 1.55, 31.05] },
      { pos: [0, 1.55, -31.05] },
    ]);
  }

  // --- Awnings over the spawn platforms (canopy + slim poles) --------------
  {
    const canopies: THREE.BufferGeometry[] = [];
    const poles: THREE.BufferGeometry[] = [];
    for (const sz of [1, -1]) {
      const canopy = new THREE.PlaneGeometry(10.6, 3.4, 10, 4);
      const posAttr = canopy.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < posAttr.count; i++) {
        const u = (posAttr.getX(i) / 10.6 + 0.5) * Math.PI;
        posAttr.setZ(i, posAttr.getZ(i) - Math.sin(u) * 0.35); // sag
      }
      canopy.computeVertexNormals();
      canopy.rotateX(-Math.PI / 2);
      // Raised from 3.25: players spawn directly beneath these, and at head
      // clearance the canopy filled the top half of a 90-degree FOV on spawn.
      canopy.translate(0, 3.95, 29 * sz);
      canopies.push(canopy);
      for (const px of [5.1, -5.1]) {
        for (const pz of [27.5, 30.5]) {
          const pole = new THREE.CylinderGeometry(0.04, 0.04, 3.0, 8);
          pole.translate(px, 2.5, pz * sz);
          poles.push(pole);
        }
      }
    }
    addMerged('prop_awnings', canopies, fabricMat);
    addMerged('prop_awning_poles', poles, metalMat);
  }

  // --- Radar masts on the cabin roofs (rear edge, rail-thin) ---------------
  const radarBars: THREE.Mesh[] = [];
  {
    const staticParts: THREE.BufferGeometry[] = [];
    for (const sz of [1, -1]) {
      const zc = 20.3 * sz;
      const pole = new THREE.CylinderGeometry(0.06, 0.09, 2.1, 10);
      pole.translate(0, UPPER_DECK_Y + 0.15 + 1.05, zc);
      staticParts.push(pole);
      const dome = new THREE.SphereGeometry(0.16, 12, 8);
      dome.translate(0, UPPER_DECK_Y + 0.15 + 1.75, zc);
      staticParts.push(dome);
      const antenna = new THREE.CylinderGeometry(0.015, 0.008, 1.0, 6);
      antenna.translate(0.22, UPPER_DECK_Y + 0.15 + 2.3, zc);
      staticParts.push(antenna);

      const bar = new THREE.Mesh(keepG(new THREE.BoxGeometry(1.35, 0.09, 0.17)), metalMat);
      bar.position.set(0, UPPER_DECK_Y + 0.15 + 2.22, zc);
      bar.castShadow = true;
      group.add(bar);
      radarBars.push(bar);
    }
    addMerged('prop_masts', staticParts, metalMat);
  }

  // --- Bow fairing + stern transom (visual hull closure, out of play space)
  {
    const parts: THREE.BufferGeometry[] = [];
    const shape = new THREE.Shape();
    shape.moveTo(-10.2, 0);
    shape.quadraticCurveTo(-9.2, 3.4, 0, 5.2);
    shape.quadraticCurveTo(9.2, 3.4, 10.2, 0);
    shape.lineTo(-10.2, 0);
    const wedge = new THREE.ExtrudeGeometry(shape, { depth: 3.35, bevelEnabled: false });
    // Shape XY -> world XZ, extrusion -> down from just under deck level.
    wedge.rotateX(Math.PI / 2);
    wedge.translate(0, 0.05, 28.0);
    parts.push(wedge);
    // Transom plates closing bow/stern between the hull side brushes.
    parts.push(new THREE.BoxGeometry(20.4, 3.2, 0.3).translate(0, -1.6, 28.05));
    parts.push(new THREE.BoxGeometry(20.4, 3.2, 0.3).translate(0, -1.6, -28.05));
    addMerged('prop_hull_closure', parts, hullMat);
  }

  // --- Gulls ---------------------------------------------------------------
  const gullMat = keepM(new THREE.MeshStandardMaterial({ color: 0xf2f3f0, roughness: 0.9, side: THREE.DoubleSide }));
  const gulls: Gull[] = [];
  const GULL_COUNT = 7;
  for (let i = 0; i < GULL_COUNT; i++) {
    gulls.push({
      radius: 14 + rand() * 18,
      height: 8 + rand() * 7,
      speed: (0.25 + rand() * 0.3) * (rand() > 0.5 ? 1 : -1),
      phase: rand() * Math.PI * 2,
      centerZ: (rand() - 0.5) * 30,
    });
  }
  const gullMesh = new THREE.InstancedMesh(keepG(gullGeometry()), gullMat, GULL_COUNT);
  gullMesh.name = 'prop_gulls';
  gullMesh.frustumCulled = false;
  group.add(gullMesh);

  const gm = new THREE.Matrix4();
  const ge = new THREE.Euler();
  const gq = new THREE.Quaternion();
  const gs = new THREE.Vector3(1.6, 1.6, 1.6);
  const gp = new THREE.Vector3();
  let time = rand() * 100;

  const updateGulls = (dt: number): void => {
    time += dt;
    for (let i = 0; i < GULL_COUNT; i++) {
      const g = gulls[i];
      const a = g.phase + time * g.speed;
      const bob = Math.sin(time * 1.7 + g.phase * 3) * 0.5;
      gp.set(Math.cos(a) * g.radius, g.height + bob, g.centerZ + Math.sin(a) * g.radius * 0.8);
      // Heading = tangent of the circle; bank into the turn; wing-beat roll.
      const heading = a + (Math.PI / 2) * Math.sign(g.speed);
      const flap = Math.sin(time * 6 + g.phase * 5) * 0.28;
      ge.set(0.06, -heading, Math.sign(g.speed) * 0.25 + flap, 'YXZ');
      gq.setFromEuler(ge);
      gm.compose(gp, gq, gs);
      gullMesh.setMatrixAt(i, gm);
    }
    gullMesh.instanceMatrix.needsUpdate = true;
  };
  updateGulls(0);

  parent.add(group);

  return {
    group,
    update(dt) {
      updateGulls(dt);
      for (const bar of radarBars) bar.rotation.y += dt * 1.4;
    },
    dispose() {
      for (const g of ownedGeometries) g.dispose();
      for (const m of ownedMaterials) m.dispose();
      for (const t of ownedTextures) t.dispose();
      group.removeFromParent();
    },
  };
}
