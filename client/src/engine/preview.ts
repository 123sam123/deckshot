/**
 * Standalone engine preview harness.
 *
 * `client/src/main.ts` does not exist until the orchestrator writes it at
 * integration, so this is the only way to see the renderer alone: a ground
 * plane and a spread of primitives using every Materials entry, an orbiting
 * camera, a fake viewmodel block, periodic muzzle-flash dynamic lights, and a
 * slow FOV sweep to prove `setWorldFov` never hitches.
 *
 * To run: temporarily add a client/preview.html pointing at this file and
 * open it under `npx vite`. Supports `?quality=` and `?debug=perf`.
 */

import * as THREE from 'three';
import { SurfaceMaterial } from '../../../shared/mapdata.js';
import { FOV_SCOPED_3_5X, FOV_WORLD } from '../../../shared/tuning.js';
import { Materials } from './materials.js';
import { Renderer } from './renderer.js';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (canvas === null) throw new Error('preview: no #game canvas in the page');

const renderer = new Renderer(canvas);
const { scene, viewmodelScene, camera } = renderer;

// --- ground: teak deck ------------------------------------------------------
{
  const geo = new THREE.PlaneGeometry(36, 36);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 9, uv.getY(i) * 9);
  const ground = new THREE.Mesh(geo, Materials.get(SurfaceMaterial.Teak));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

// --- a spread of props, one per material ------------------------------------
function box(
  surface: SurfaceMaterial,
  size: [number, number, number],
  pos: [number, number, number],
  rotY = 0
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), Materials.get(surface));
  mesh.position.set(...pos);
  mesh.rotation.y = rotY;
  scene.add(mesh);
  return mesh;
}

box(SurfaceMaterial.Composite, [2.4, 2.2, 2.4], [-4, 1.1, -2], 0.3); // cabin block
box(SurfaceMaterial.Metal, [1.6, 1.6, 1.6], [3.5, 0.8, -3], -0.4); // steel crate
box(SurfaceMaterial.Fabric, [1.2, 0.7, 2.6], [1.5, 0.35, 3.5], 0.2); // lounger
box(SurfaceMaterial.Teak, [2.2, 1.0, 1.0], [-2.5, 0.5, 3.8], -0.15); // bar counter
box(SurfaceMaterial.Glass, [0.08, 1.6, 3.2], [0.5, 1.3, -4.5], 0.1); // window pane
box(SurfaceMaterial.Composite, [0.9, 3.2, 0.9], [5.5, 1.6, 2.5]); // pillar (gun-clip test)

const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 32), Materials.get(SurfaceMaterial.Metal));
sphere.position.set(0, 1.4, 0);
scene.add(sphere);

const waterDisc = new THREE.Mesh(new THREE.CircleGeometry(220, 48), Materials.get(SurfaceMaterial.Water));
waterDisc.rotation.x = -Math.PI / 2;
waterDisc.position.y = -3;
waterDisc.userData.noShadow = true;
scene.add(waterDisc);

// --- fake viewmodel: a block that must never clip through the pillar --------
const gun = new THREE.Mesh(
  new THREE.BoxGeometry(0.06, 0.08, 0.7),
  new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.45, metalness: 0.8 })
);
viewmodelScene.add(gun);
const gunOffset = new THREE.Vector3(0.22, -0.18, -0.45);

// --- animate ----------------------------------------------------------------
let last = performance.now();
let t = 0;
let flashTimer = 0;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  t += dt;

  // Orbit at player eye height-ish, starting roughly facing the sun.
  const r = 8.5;
  const a = t * 0.22 - 1.19;
  camera.position.set(Math.sin(a) * r, 2.0 + Math.sin(t * 0.5) * 0.25, Math.cos(a) * r);
  camera.lookAt(0, 1.2, 0);

  // Slow scope-in/out sweep — must stay hitch-free.
  const scope = (Math.sin(t * 0.8) + 1) / 2;
  renderer.setWorldFov(FOV_WORLD + (FOV_SCOPED_3_5X - FOV_WORLD) * scope * 0.6);

  // Damage pulse now and then.
  renderer.setDamageIntensity(Math.max(0, Math.sin(t * 0.35) - 0.75) * 4);

  // Muzzle flash test: pooled dynamic lights near the sphere.
  flashTimer -= dt;
  if (flashTimer <= 0) {
    flashTimer = 1.4;
    renderer.addDynamicLight(
      { x: Math.sin(t) * 2, y: 1.6, z: Math.cos(t) * 2 },
      0xffb457,
      26,
      0.12
    );
  }

  // Glue the fake gun to the camera.
  gun.quaternion.copy(camera.quaternion);
  gun.position.copy(camera.position).add(gunOffset.clone().applyQuaternion(camera.quaternion));

  renderer.render(dt);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Hot-reload hygiene.
if (import.meta.hot) {
  import.meta.hot.dispose(() => renderer.dispose());
}
