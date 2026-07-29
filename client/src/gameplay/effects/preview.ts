/**
 * DECKSHOT — standalone preview harness for viewmodel + effects + audio.
 *
 * The orchestrator writes client/src/main.ts at integration; until then this
 * is the only way to SEE this subsystem. It deliberately creates its own
 * WebGLRenderer/cameras (normally forbidden — the engine agent owns that in
 * the real game) purely so the springs, bolt cycle, scope, impacts and
 * synthesized sounds can be exercised in isolation.
 *
 * Run: npx vite  ->  http://localhost:5173/preview.html
 *
 * Controls:
 *   click        lock pointer / fire
 *   right mouse  hold to ADS
 *   WASD         move (feeds bob/sway)
 *   Shift        sprint pose
 *   Space        hop (landing dip on return)
 *   R            reload (partial), T reload (empty)
 *   1 / 2        Talon / Kestrel
 *   C            cycle camo
 *   V            cycle attachment loadouts
 *   Z            toggle 3.5x/8x (Variable Zoom loadout)
 *
 * Owner: viewmodel-vfx-audio. NOT part of the shipped game loop.
 */

import * as THREE from 'three';
import { SurfaceMaterial } from '../../../../shared/mapdata.js';
import { FOV_SCOPED_3_5X, FOV_SCOPED_8X, FOV_VIEWMODEL, FOV_WORLD, WEAPONS } from '../../../../shared/tuning.js';
import { AdsState, AttachmentId, CamoId, Stance, WeaponId } from '../../../../shared/types.js';
import { Audio } from '../../audio/index.js';
import { Viewmodel, ViewmodelInput } from '../viewmodel.js';
import { Effects } from './index.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.autoClear = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const worldScene = new THREE.Scene();
worldScene.background = new THREE.Color(0x0e2438);
worldScene.fog = new THREE.Fog(0x0e2438, 60, 160);
const camera = new THREE.PerspectiveCamera((FOV_WORLD * 180) / Math.PI, 1, 0.05, 500);
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera((FOV_VIEWMODEL * 180) / Math.PI, 1, 0.01, 10);

// --- Test world: deck plane + material target boxes ------------------------
{
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.0);
  sun.position.set(30, 50, 10);
  worldScene.add(sun, new THREE.HemisphereLight(0xa8c8e8, 0x223322, 0.7));
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(24, 0.5, 60),
    new THREE.MeshStandardMaterial({ color: 0x8a6f4d, roughness: 0.8 })
  );
  deck.position.y = -0.25;
  deck.userData.material = SurfaceMaterial.Teak;
  worldScene.add(deck);
  // Sea.
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.MeshStandardMaterial({ color: 0x0d3a52, roughness: 0.25, metalness: 0.1 })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -3;
  sea.userData.material = SurfaceMaterial.Water;
  worldScene.add(sea);

  const mats: [SurfaceMaterial, number][] = [
    [SurfaceMaterial.Teak, 0x8a6f4d],
    [SurfaceMaterial.Metal, 0x7d8894],
    [SurfaceMaterial.Glass, 0x9fc8e0],
    [SurfaceMaterial.Composite, 0xd8d8d0],
    [SurfaceMaterial.Fabric, 0xb08850],
  ];
  mats.forEach(([m, color], i) => {
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 2.2, 0.4),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7, transparent: m === SurfaceMaterial.Glass, opacity: m === SurfaceMaterial.Glass ? 0.5 : 1 })
    );
    b.position.set((i - 2) * 3.2, 1.1, -14);
    b.userData.material = m;
    worldScene.add(b);
  });
  // "Enemy" target: hit -> hitmarker, small head box -> headshot+kill.
  const enemy = new THREE.Group();
  const bodyM = new THREE.MeshStandardMaterial({ color: 0x8e2222, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.05, 4, 10), bodyM);
  body.position.y = 0.9;
  body.userData.enemyPart = 'body';
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), bodyM.clone());
  (head.material as THREE.MeshStandardMaterial).color.setHex(0xd4af37);
  head.position.y = 1.75;
  head.userData.enemyPart = 'head';
  enemy.add(body, head);
  enemy.position.set(6, 0, -20);
  worldScene.add(enemy);
}

// --- Renderer-contract shim (what client/src/engine will provide) ----------
const dynLights: { light: THREE.PointLight; ttl: number }[] = [];
const rendererLike = {
  scene: worldScene,
  camera,
  addDynamicLight(pos: { x: number; y: number; z: number }, color: number, intensity: number, lifetime: number): void {
    const l = new THREE.PointLight(color, intensity, 12);
    l.position.set(pos.x, pos.y, pos.z);
    worldScene.add(l);
    dynLights.push({ light: l, ttl: lifetime });
  },
};

Effects.init(rendererLike);
const viewmodel = new Viewmodel(vmScene);

// --- Loadout cycling --------------------------------------------------------
const CAMOS = [CamoId.Gunmetal, CamoId.Arctic, CamoId.Carbon, CamoId.Tiger, CamoId.Chrome, CamoId.Gold];
const LOADOUTS: AttachmentId[][] = [
  [AttachmentId.FastDraw],
  [AttachmentId.Suppressor, AttachmentId.Laser],
  [AttachmentId.VariableZoom, AttachmentId.ExtendedMag],
  [AttachmentId.IronSightSwap, AttachmentId.Laser],
];
let weaponId = WeaponId.Talon;
let camoIdx = 0;
let loadoutIdx = 0;
const applyLoadout = (): void => {
  viewmodel.setWeapon(weaponId, CAMOS[camoIdx], LOADOUTS[loadoutIdx]);
  hud();
};

// --- Input ------------------------------------------------------------------
const keys = new Set<string>();
let yaw = 0, pitch = 0;
let lookDX = 0, lookDY = 0;
let adsHeld = false;
let zoomLevel: 0 | 1 = 0;
let lastFire = -Infinity;
let hopT = -1;
const pos = new THREE.Vector3(0, 1.62, 0);
const vel = new THREE.Vector3();

canvas.addEventListener('click', () => {
  void Audio.init().then(() => Audio.startAmbient());
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  lookDX += e.movementX * 0.0022;
  lookDY += e.movementY * 0.0022;
});
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (e.button === 0) fire();
  if (e.button === 2) adsHeld = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 2) adsHeld = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR') viewmodel.onReload(false);
  if (e.code === 'KeyT') viewmodel.onReload(true);
  if (e.code === 'Digit1') { weaponId = WeaponId.Talon; applyLoadout(); }
  if (e.code === 'Digit2') { weaponId = WeaponId.Kestrel; applyLoadout(); }
  if (e.code === 'KeyC') { camoIdx = (camoIdx + 1) % CAMOS.length; applyLoadout(); }
  if (e.code === 'KeyV') { loadoutIdx = (loadoutIdx + 1) % LOADOUTS.length; applyLoadout(); }
  if (e.code === 'KeyZ') zoomLevel = zoomLevel === 0 ? 1 : 0;
  if (e.code === 'KeyQ') adsHeld = !adsHeld; // toggle ADS (automation-friendly)
  if (e.code === 'KeyF') fire();
  if (e.code === 'Space' && hopT < 0) hopT = 0;
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

// --- ADS simulation (in the real game weapons-hitreg owns this state) ------
let adsProgress = 0;
let adsState: AdsState = AdsState.Hip;

// --- Firing -----------------------------------------------------------------
const raycaster = new THREE.Raycaster();
function fire(): void {
  const spec = WEAPONS[weaponId];
  const now = performance.now() / 1000;
  if (now - lastFire < spec.cycleTime) return;
  lastFire = now;
  viewmodel.onFire();

  // Hitscan into the preview world.
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObjects(worldScene.children, true).filter((h) => (h.object as THREE.Mesh).isMesh);
  const from = camera.position.clone().addScaledVector(raycaster.ray.direction, 0.8).add(new THREE.Vector3(0.12, -0.08, 0));
  const to = hits[0]?.point ?? camera.position.clone().addScaledVector(raycaster.ray.direction, 200);
  Effects.spawnTracer(from, to);
  Effects.spawnMuzzleFlash(from, raycaster.ray.direction, {
    suppressed: LOADOUTS[loadoutIdx].includes(AttachmentId.Suppressor),
    scale: weaponId === WeaponId.Kestrel ? 0.6 : 1,
  });
  const h = hits[0];
  if (h) {
    const enemyPart = h.object.userData.enemyPart as string | undefined;
    if (enemyPart) {
      Effects.spawnBlood(h.point, raycaster.ray.direction, enemyPart === 'head');
      Effects.triggerHitmarker(enemyPart === 'head' ? 'headshot' : 'hit');
      if (enemyPart === 'head') setTimeout(() => Effects.triggerHitmarker('kill'), 120);
    } else {
      const mat = (h.object.userData.material ?? SurfaceMaterial.Composite) as SurfaceMaterial;
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      Effects.spawnImpact(h.point, n, mat);
    }
  }
  // Whizz demo: a shot passing by the listener.
  if (Math.random() < 0.25) {
    Audio.playWhizz(
      { x: pos.x - 20, y: pos.y, z: pos.z - 2 },
      { x: pos.x + 20, y: pos.y, z: pos.z - 1 }
    );
  }
}

// --- Hitmarker HUD ----------------------------------------------------------
const marker = document.createElement('div');
marker.style.cssText =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font:700 34px monospace;pointer-events:none;opacity:0;transition:opacity .25s';
marker.textContent = '✕';
document.body.appendChild(marker);
Effects.onHitmarker((kind) => {
  marker.style.color = kind === 'kill' ? '#d4af37' : '#fff';
  marker.style.opacity = '1';
  setTimeout(() => (marker.style.opacity = '0'), 180);
});

// --- Info HUD ---------------------------------------------------------------
const info = document.createElement('div');
info.style.cssText =
  'position:fixed;left:12px;bottom:12px;color:#cde;font:12px monospace;pointer-events:none;white-space:pre';
document.body.appendChild(info);
function hud(): void {
  info.textContent =
    `${WEAPONS[weaponId].name}  camo:${CamoId[CAMOS[camoIdx]]}  attach:[${LOADOUTS[loadoutIdx].map((a) => AttachmentId[a]).join(', ')}]\n` +
    'LMB fire | RMB ads | WASD move | Shift sprint | Space hop | R/T reload | 1/2 weapon | C camo | V attachments | Z zoom';
}
hud();

// --- Frame loop -------------------------------------------------------------
let prev = performance.now();
function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;

  // Look.
  yaw -= lookDX;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - lookDY));
  const frameLookDX = lookDX, frameLookDY = lookDY;
  lookDX = 0;
  lookDY = 0;

  // Move.
  const sprint = keys.has('ShiftLeft');
  const speed = adsProgress > 0.3 ? 2.6 : sprint ? 7.4 : 5.0;
  const mx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const mz = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  vel.set((mx * cos + mz * sin) * speed, 0, (mz * cos - mx * sin) * speed);
  pos.addScaledVector(vel, dt);

  // Hop for the landing dip.
  let y = 1.62;
  let onGround = true;
  if (hopT >= 0) {
    hopT += dt;
    const h = 4.5 * hopT - 0.5 * 18 * hopT * hopT;
    if (h <= 0) {
      viewmodel.onLand(4.5);
      hopT = -1;
    } else {
      y += h;
      onGround = false;
    }
  }
  pos.y = y;

  // ADS state machine (stand-in for weapons-hitreg's).
  const spec = WEAPONS[weaponId];
  const adsRate = dt / spec.adsTime;
  if (adsHeld) {
    adsProgress = Math.min(1, adsProgress + adsRate);
    adsState = adsProgress >= 1 ? AdsState.Scoped : AdsState.Raising;
  } else {
    adsProgress = Math.max(0, adsProgress - adsRate * 1.4);
    adsState = adsProgress <= 0 ? AdsState.Hip : AdsState.Lowering;
  }

  // World FOV zoom while scoped (camera feel is the camera rig's job in the
  // real game; approximated here so the scope reads correctly).
  const scopedFov = zoomLevel === 1 ? FOV_SCOPED_8X : FOV_SCOPED_3_5X;
  const fov = FOV_WORLD + (scopedFov - FOV_WORLD) * adsProgress;
  camera.fov = (fov * 180) / Math.PI;

  const input: ViewmodelInput = {
    lookDeltaYaw: -frameLookDX,
    lookDeltaPitch: -frameLookDY,
    velocity: { x: vel.x, y: 0, z: vel.z },
    onGround,
    stance: keys.has('ControlLeft') ? Stance.Crouch : Stance.Stand,
    sprinting: sprint && mz < 0,
    adsProgress,
    adsState,
    zoomLevel,
    cameraPos: { x: pos.x, y: pos.y, z: pos.z },
    viewYaw: yaw,
    viewPitch: pitch,
  };
  const out = viewmodel.update(dt, input);

  // Camera: player look + viewmodel's recoil contribution.
  camera.position.copy(pos);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(yaw + out.cameraYawOffset);
  camera.rotateX(pitch + out.cameraPitchOffset);
  camera.translateZ(out.cameraPunch);

  Audio.setListener(
    { x: pos.x, y: pos.y, z: pos.z },
    { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) },
    { x: 0, y: 1, z: 0 }
  );

  Effects.update(dt);
  for (let i = dynLights.length - 1; i >= 0; i--) {
    dynLights[i].ttl -= dt;
    if (dynLights[i].ttl <= 0) {
      worldScene.remove(dynLights[i].light);
      dynLights.splice(i, 1);
    }
  }

  // Resize.
  const w = canvas.clientWidth || innerWidth, h2 = canvas.clientHeight || innerHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h2 * renderer.getPixelRatio())) {
    renderer.setSize(w, h2, false);
    camera.aspect = w / h2;
    vmCamera.aspect = w / h2;
    vmCamera.updateProjectionMatrix();
  }
  camera.updateProjectionMatrix();

  // Two-pass render, exactly like the real engine contract describes.
  renderer.clear();
  renderer.render(worldScene, camera);
  renderer.clearDepth();
  renderer.render(vmScene, vmCamera);
}
requestAnimationFrame(frame);
