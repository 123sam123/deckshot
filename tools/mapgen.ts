/**
 * tools/mapgen.ts — standalone map preview harness (owned by map-and-ocean).
 *
 * Boots a renderer + golden-hour lighting, builds the world from
 * shared/mapdata, and gives you:
 *   - free-fly camera: click to grab mouse, WASD + Q/E (down/up), Shift = fast
 *   - B: toggle collision-brush wireframe overlay (red = solid, cyan =
 *     penetrable, yellow diamonds = spawn points) to verify visuals and
 *     physics brushes line up
 *   - X: toggle overlay depth test (see brushes through walls)
 *
 * Run with a temporary HTML entry via `npx vite`, e.g. a file that does
 *   <script type="module" src="/@fs/<abs-path>/tools/mapgen.ts"></script>
 * This file is dev tooling only; it is never imported by the game.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BRUSHES, SPAWN_POINTS, WATER_LEVEL } from '../shared/mapdata.js';
import { brushMatrix, buildWorld } from '../client/src/world/index.js';

// --- Renderer --------------------------------------------------------------

const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;display:block;';
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(14, 6, 34);
camera.rotation.order = 'YXZ';
camera.lookAt(0, 1, 0);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Golden-hour sky + lights (the real game gets these from the renderer
// agent; the harness fakes a matching setup so the ocean glint reads) -------

const SUN_DIR = new THREE.Vector3(-0.62, 0.22, -0.42).normalize();

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: { uSunDir: { value: SUN_DIR } },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uSunDir;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = clamp(d.y, -1.0, 1.0);
      vec3 zenith = vec3(0.16, 0.28, 0.50);
      vec3 horizon = vec3(0.98, 0.55, 0.30);
      vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
      if (h < 0.0) col = mix(horizon, vec3(0.10, 0.16, 0.22), clamp(-h * 4.0, 0.0, 1.0));
      float s = max(dot(d, uSunDir), 0.0);
      col += vec3(1.0, 0.62, 0.30) * (pow(s, 1200.0) * 18.0 + pow(s, 24.0) * 0.35);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), skyMat));

// Environment map from the sky, so metals and glass have something to reflect.
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();
}

const sun = new THREE.DirectionalLight(0xffc27a, 3.2);
sun.position.copy(SUN_DIR).multiplyScalar(220);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -42;
sun.shadow.camera.right = 42;
sun.shadow.camera.top = 42;
sun.shadow.camera.bottom = -42;
sun.shadow.camera.near = 40;
sun.shadow.camera.far = 420;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0x9db8d9, 0x2a3540, 0.55));
scene.add(new THREE.AmbientLight(0xffd9b0, 0.12));

// --- The world -------------------------------------------------------------

const world = buildWorld(scene); // no materials registry: exercises fallbacks

// --- Collision wireframe overlay -------------------------------------------

function buildOverlay(): THREE.Group {
  const overlay = new THREE.Group();
  overlay.name = 'collision_overlay';

  const edgeGeoms: THREE.BufferGeometry[] = [];
  for (const brush of BRUSHES) {
    const box = new THREE.BoxGeometry(brush.half.x * 2, brush.half.y * 2, brush.half.z * 2);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    edges.applyMatrix4(brushMatrix(brush));
    const count = (edges.attributes.position as THREE.BufferAttribute).count;
    const colors = new Float32Array(count * 3);
    const c = brush.penetrable ? [0.2, 0.95, 1.0] : [1.0, 0.25, 0.2];
    for (let i = 0; i < count; i++) colors.set(c, i * 3);
    edges.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    edgeGeoms.push(edges);
  }
  const merged = mergeGeometries(edgeGeoms, false);
  for (const g of edgeGeoms) g.dispose();
  const lines = new THREE.LineSegments(
    merged,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 })
  );
  lines.renderOrder = 998;
  overlay.add(lines);

  // Spawn points: yellow diamonds with a facing tick.
  const spawnGeoms: THREE.BufferGeometry[] = [];
  for (const spawn of SPAWN_POINTS) {
    const d = new THREE.OctahedronGeometry(0.25).toNonIndexed();
    d.translate(spawn.position.x, spawn.position.y + 0.4, spawn.position.z);
    spawnGeoms.push(d);
    const tick = new THREE.BoxGeometry(0.05, 0.05, 0.6).toNonIndexed();
    tick.translate(0, 0, -0.45);
    tick.rotateY(spawn.yaw);
    tick.translate(spawn.position.x, spawn.position.y + 0.4, spawn.position.z);
    spawnGeoms.push(tick);
  }
  const spawnMesh = new THREE.Mesh(
    mergeGeometries(spawnGeoms, false),
    new THREE.MeshBasicMaterial({ color: 0xffd028, wireframe: true })
  );
  for (const g of spawnGeoms) g.dispose();
  spawnMesh.renderOrder = 999;
  overlay.add(spawnMesh);

  overlay.visible = false;
  return overlay;
}

const overlay = buildOverlay();
scene.add(overlay);

// --- Free-fly controls ------------------------------------------------------

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyB') overlay.visible = !overlay.visible;
  if (e.code === 'KeyX') {
    overlay.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | undefined;
      if (mat) {
        mat.depthTest = !mat.depthTest;
        mat.needsUpdate = true;
      }
    });
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('click', () => canvas.requestPointerLock());
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  camera.rotation.y -= e.movementX * 0.0022;
  camera.rotation.x = Math.max(-1.55, Math.min(1.55, camera.rotation.x - e.movementY * 0.0022));
});

// --- HUD -------------------------------------------------------------------

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:10px;left:10px;color:#e6edf3;font:12px/1.5 ui-monospace,monospace;' +
  'background:rgba(5,8,13,0.55);padding:8px 12px;border-radius:6px;pointer-events:none;white-space:pre;';
document.body.appendChild(hud);

// --- Main loop --------------------------------------------------------------

const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
let last = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 34 : 9) * dt;
  camera.getWorldDirection(fwd);
  right.crossVectors(fwd, camera.up).normalize();
  if (keys.has('KeyW')) camera.position.addScaledVector(fwd, speed);
  if (keys.has('KeyS')) camera.position.addScaledVector(fwd, -speed);
  if (keys.has('KeyD')) camera.position.addScaledVector(right, speed);
  if (keys.has('KeyA')) camera.position.addScaledVector(right, -speed);
  if (keys.has('KeyE') || keys.has('Space')) camera.position.y += speed;
  if (keys.has('KeyQ') || keys.has('ControlLeft')) camera.position.y -= speed;

  world.update(dt, camera.position);
  renderer.render(scene, camera);

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }
  const p = camera.position;
  hud.textContent =
    `DECKSHOT mapgen — click to fly (WASD, Q/E, Shift)\n` +
    `B: brush overlay (${overlay.visible ? 'ON' : 'off'})   X: overlay depth test\n` +
    `fps ${fps}   draw calls ${renderer.info.render.calls}   tris ${renderer.info.render.triangles}\n` +
    `pos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}   water y=${WATER_LEVEL}`;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

console.log(`[mapgen] world built: ${BRUSHES.length} brushes, ${SPAWN_POINTS.length} spawns`);
