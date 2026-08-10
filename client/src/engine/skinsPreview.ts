/**
 * Standalone skin preview harness (dev-only page: client/skins.html).
 *
 * Renders the five skins from `gameplay/skins.ts` on the real renderer — sky
 * IBL, CSM, postfx — the same light they will be seen in at 40m in a match.
 * Drives the design sign-off shots for the skins ticket:
 *
 *   ?capture=1  — renders a portrait per skin, a 12m group and a 40m group,
 *                 then POSTs each PNG to a local receiver on :9971 (used to
 *                 embed real renders in the ticket's design artifacts).
 *   (no param)  — interactive: slow orbit around the lineup.
 */

import * as THREE from 'three';

import { HITBOX_TEMPLATE } from '../../../shared/hitbox.js';
import { SurfaceMaterial } from '../../../shared/mapdata.js';
import { FOV_SCOPED_3_5X, FOV_WORLD, PLAYER_RADIUS } from '../../../shared/tuning.js';
import {
  AttachmentId,
  CamoId,
  DEFAULT_LOADOUT,
  HitboxPart,
  SKIN_COUNT,
  SkinId,
  Stance,
  TeamId,
  WeaponId,
  type Vec3,
} from '../../../shared/types.js';
import { AvatarPool, type AvatarState } from '../gameplay/avatars.js';
import { buildWeaponMesh } from '../gameplay/viewmodel.js';
import { HEAD_INSET, LIMB_INSET, SKIN_INFO, buildSkinAppearance } from '../gameplay/skins.js';
import { Materials } from './materials.js';
import { Renderer } from './renderer.js';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (canvas === null) throw new Error('skins preview: no #game canvas');
const status = document.getElementById('status');

const renderer = new Renderer(canvas);
const { scene, camera } = renderer;

// --- set: teak deck + a composite bulwark behind the lineup ----------------
{
  const geo = new THREE.PlaneGeometry(120, 120);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 30, uv.getY(i) * 30);
  const ground = new THREE.Mesh(geo, Materials.get(SurfaceMaterial.Teak));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const bulwark = new THREE.Mesh(new THREE.BoxGeometry(30, 1.2, 0.3), Materials.get(SurfaceMaterial.Composite));
  bulwark.position.set(0, 0.6, 2.2);
  scene.add(bulwark);
}

// --- avatars ----------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);

function buildCapsule(a: Vec3, b: Vec3, radius: number, mat: THREE.Material, inset: number): THREE.Mesh {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const seg = new THREE.Vector3().subVectors(vb, va);
  const len = seg.length();
  const geo = new THREE.CapsuleGeometry(radius, len, 4, 14);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(va).addScaledVector(seg, 0.5);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, seg.normalize());
  // Radial inset only — silhouette stays a hair inside the hitbox so the
  // surface-hugging gear shells actually render (see skins.ts).
  mesh.scale.set(inset, 1, inset);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildAvatar(skin: SkinId): THREE.Group {
  const group = new THREE.Group();
  const app = buildSkinAppearance(skin);
  for (const cap of HITBOX_TEMPLATE) {
    const mat = app.materials.get(cap.part);
    if (!mat) continue;
    const inset = cap.part === HitboxPart.Head ? HEAD_INSET : LIMB_INSET;
    group.add(buildCapsule(cap.a, cap.b, cap.radius, mat, inset));
  }
  for (const g of app.gear) group.add(g);

  // Shouldered rifle, same anchor as the in-game avatars.
  const anchor = new THREE.Group();
  anchor.position.set(PLAYER_RADIUS * 0.75, 1.36, -0.12);
  anchor.add(buildWeaponMesh(WeaponId.Talon, CamoId.Gunmetal, [AttachmentId.None, AttachmentId.None, AttachmentId.None]));
  group.add(anchor);
  return group;
}

const SPACING = 1.5;
const avatars: THREE.Group[] = [];
for (let i = 0; i < SKIN_COUNT; i++) {
  const a = buildAvatar(i as SkinId);
  a.position.set((i - (SKIN_COUNT - 1) / 2) * SPACING, 0, 0);
  scene.add(a);
  avatars.push(a);
}

// --- shot list ---------------------------------------------------------------
interface Shot {
  name: string;
  w: number;
  h: number;
  pos: THREE.Vector3;
  look: THREE.Vector3;
  /** When set, only this avatar index is visible. */
  only?: number;
  /** World FOV override (radians) — used for the scoped 40m readability shot. */
  fov?: number;
}

const shots: Shot[] = [];
for (let i = 0; i < SKIN_COUNT; i++) {
  const x = (i - (SKIN_COUNT - 1) / 2) * SPACING;
  shots.push({
    name: `portrait-${i}-${SKIN_INFO[i].name.toLowerCase()}`,
    w: 640,
    h: 800,
    pos: new THREE.Vector3(x - 0.85, 1.5, -2.05),
    look: new THREE.Vector3(x, 1.02, 0),
    only: i,
  });
}
shots.push({ name: 'lineup-9m', w: 1280, h: 560, pos: new THREE.Vector3(0, 1.6, -9), look: new THREE.Vector3(0, 1.0, 0) });
shots.push({ name: 'lineup-40m', w: 1280, h: 560, pos: new THREE.Vector3(0, 1.8, -40), look: new THREE.Vector3(0, 1.0, 0) });
// The real gameplay read at 40m: through the 3.5x scope.
shots.push({
  name: 'lineup-40m-scoped',
  w: 1280,
  h: 720,
  pos: new THREE.Vector3(0, 1.8, -40),
  look: new THREE.Vector3(0, 1.0, 0),
  fov: FOV_SCOPED_3_5X,
});

function setCanvasSize(w: number, h: number): void {
  canvas!.style.width = `${w}px`;
  canvas!.style.height = `${h}px`;
  renderer.resize();
}

function renderFrames(n: number): void {
  for (let i = 0; i < n; i++) renderer.render(1 / 60);
}

async function capture(): Promise<void> {
  renderFrames(30); // let IBL/CSM/SMAA settle
  for (const shot of shots) {
    for (let i = 0; i < avatars.length; i++) {
      avatars[i].visible = shot.only === undefined || shot.only === i;
    }
    setCanvasSize(shot.w, shot.h);
    renderer.setWorldFov(shot.fov ?? FOV_WORLD);
    camera.position.copy(shot.pos);
    camera.lookAt(shot.look);
    renderFrames(8);
    const dataUrl = canvas!.toDataURL('image/png');
    if (status) status.textContent = `captured ${shot.name}`;
    await fetch('http://127.0.0.1:9971/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: shot.name, dataUrl }),
    });
  }
  if (status) status.textContent = 'capture complete';
}

/**
 * ?plates=1 — teammate-nameplate demo through the PRODUCTION AvatarPool path:
 * a teammate (plate + rim), an enemy (nothing) and an FFA player (nothing),
 * viewed as an Alpha-team local player.
 */
async function capturePlates(): Promise<void> {
  for (const a of avatars) a.visible = false;
  const pool = new AvatarPool(scene);
  const state = (x: number, team: TeamId, name: string, skin: SkinId): AvatarState => ({
    position: { x, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    alive: true,
    team,
    name,
    loadout: { ...DEFAULT_LOADOUT, skin },
  });
  const players = new Map([
    [1, state(-2, TeamId.Alpha, 'DIVER_DAN', SkinId.Fathom)],
    [2, state(0, TeamId.Bravo, 'REDSHIRT', SkinId.Breacher)],
    [3, state(2, TeamId.FFA, 'LONER', SkinId.Commodore)],
  ]);
  const ctx = { localTeam: TeamId.Alpha, cameraPos: { x: 0, y: 1.7, z: -7 } };

  setCanvasSize(1280, 620);
  renderer.setWorldFov(FOV_WORLD);
  camera.position.set(0, 1.7, -7);
  camera.lookAt(0, 1.2, 0);
  for (let i = 0; i < 20; i++) {
    pool.sync(players, ctx);
    renderer.render(1 / 60);
  }
  const dataUrl = canvas!.toDataURL('image/png');
  await fetch('http://127.0.0.1:9971/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nameplates', dataUrl }),
  });
  if (status) status.textContent = 'plates captured';
}

const params = new URLSearchParams(location.search);
if (params.has('plates')) {
  void capturePlates();
} else if (params.has('capture')) {
  void capture();
} else {
  let t = 0;
  const spin = (): void => {
    t += 1 / 60;
    const r = 6.5;
    camera.position.set(Math.sin(t * 0.25) * r, 1.7, -Math.cos(t * 0.25) * r);
    camera.lookAt(0, 1.0, 0);
    renderer.render(1 / 60);
    requestAnimationFrame(spin);
  };
  spin();
}
