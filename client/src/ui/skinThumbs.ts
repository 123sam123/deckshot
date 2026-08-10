/**
 * DECKSHOT UI — runtime-rendered skin portraits for the loadout screen.
 *
 * The Skin row shows each operator as a real render of the same materials and
 * gear the avatar wears in-game — not a hand-drawn approximation that would
 * drift the moment a skin is tweaked. Rendered once per session on demand
 * with a small throwaway WebGL context (RoomEnvironment IBL so the PBR
 * metals read), then handed around as data-URL strings. No asset files.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { HITBOX_TEMPLATE } from '../../../shared/hitbox.js';
import { HitboxPart, SKIN_COUNT, type SkinId, type Vec3 } from '../../../shared/types.js';
import { HEAD_INSET, LIMB_INSET, buildSkinAppearance } from '../gameplay/skins.js';

const THUMB_W = 200;
const THUMB_H = 260;

let cache: string[] | null = null;

const UP = new THREE.Vector3(0, 1, 0);

function addCapsule(group: THREE.Group, a: Vec3, b: Vec3, radius: number, mat: THREE.Material, inset: number): void {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const seg = new THREE.Vector3().subVectors(vb, va);
  const len = seg.length();
  const geo = new THREE.CapsuleGeometry(radius, len, 4, 12);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(va).addScaledVector(seg, 0.5);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, seg.normalize());
  mesh.scale.set(inset, 1, inset);
  group.add(mesh);
}

/**
 * Renders (or returns the cached) portrait data URLs, indexed by SkinId.
 * Returns null when WebGL is unavailable — callers fall back to flat swatches.
 */
export function skinThumbnails(): string[] | null {
  if (cache) return cache;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  renderer.setSize(THUMB_W, THUMB_H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;

  const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(-2, 4, -3);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(32, THUMB_W / THUMB_H, 0.1, 20);
  camera.position.set(-0.75, 1.52, -2.15);
  camera.lookAt(0, 1.08, 0);

  const shots: string[] = [];
  for (let i = 0; i < SKIN_COUNT; i++) {
    const app = buildSkinAppearance(i as SkinId);
    const group = new THREE.Group();
    for (const cap of HITBOX_TEMPLATE) {
      const mat = app.materials.get(cap.part);
      if (!mat) continue;
      addCapsule(group, cap.a, cap.b, cap.radius, mat, cap.part === HitboxPart.Head ? HEAD_INSET : LIMB_INSET);
    }
    for (const g of app.gear) group.add(g);
    group.rotation.y = 0.35; // three-quarter view
    scene.add(group);

    renderer.render(scene, camera);
    shots.push(renderer.domElement.toDataURL('image/png'));

    scene.remove(group);
    for (const child of [...group.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
    }
    app.dispose();
  }

  pmrem.dispose();
  env.dispose();
  renderer.dispose();
  renderer.forceContextLoss();

  cache = shots;
  return cache;
}
