/**
 * The ocean. Gerstner-displaced radial grid that follows the camera, with:
 *  - 4 summed Gerstner waves (varied direction / wavelength / steepness),
 *    displaced in the vertex shader with analytic normals,
 *  - two layered scrolling detail normal maps (procedural, canvas-generated),
 *  - planar reflection of the yacht rendered at quarter resolution into a
 *    render target via the mesh's onBeforeRender hook (we never own the
 *    renderer — it is handed to us per-frame, Reflector-style),
 *  - analytic hull-proximity shading (deep teal -> turquoise near the hull)
 *    plus a foam waterline band and crest foam from wave steepness,
 *  - a tight specular sun glint matching the golden-hour sun.
 *
 * The grid is radial: dense rings near the camera, geometrically sparser to
 * the horizon, so distant water costs almost nothing. update() recentres the
 * mesh on the camera; displacement is computed from *world* XZ so the surface
 * is continuous while the mesh moves.
 */

import * as THREE from 'three';
import { WATER_LEVEL } from '../../../shared/mapdata.js';
import type { Vec3 } from '../../../shared/types.js';
import { foamNoiseTexture, waterNormalTexture } from './textures.js';

// Golden-hour defaults; the renderer agent can override via setSun().
const DEFAULT_SUN_DIR = new THREE.Vector3(-0.62, 0.22, -0.42).normalize();
const DEFAULT_SUN_COLOR = new THREE.Color(1.0, 0.55, 0.26);

// dir.x, dir.z, wavelength (m), amplitude (m)
const WAVES: [number, number, number, number][] = [
  [1.0, 0.3, 27.0, 0.38],
  [0.72, -0.55, 15.0, 0.22],
  [-0.18, 0.92, 8.5, 0.11],
  [0.55, 0.83, 4.6, 0.05],
];
const STEEPNESS = [0.72, 0.78, 0.84, 0.9];

const VERTEX = /* glsl */ `
uniform float uTime;
uniform vec4 uWaves[4];
uniform float uSteep[4];
uniform mat4 uMirrorMatrix;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
varying vec4 vMirror;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 xz = wp.xz;
  float dist = distance(xz, cameraPosition.xz);
  // Fade displacement out at range: distant water is a cheap flat sheet.
  float att = 1.0 - smoothstep(140.0, 520.0, dist);

  vec3 disp = vec3(0.0);
  float nx = 0.0;
  float ny = 0.0;
  float nz = 0.0;
  float crest = 0.0;

  for (int i = 0; i < 4; i++) {
    vec2 D = normalize(uWaves[i].xy);
    float L = uWaves[i].z;
    float A = uWaves[i].w;
    float k = 6.2831853 / L;
    float w = sqrt(9.81 * k);            // deep-water dispersion
    float Q = uSteep[i] / (k * A * 4.0); // steepness, normalised over 4 waves
    float th = k * dot(D, xz) - w * uTime + float(i) * 1.71;
    float S = sin(th);
    float C = cos(th);
    disp += vec3(Q * A * D.x * C, A * S, Q * A * D.y * C);
    float WA = k * A;
    nx -= D.x * WA * C;
    nz -= D.y * WA * C;
    ny -= Q * WA * S;
    crest += Q * WA * S;
  }

  wp.xyz += disp * att;
  vWorld = wp.xyz;
  vNormal = normalize(mix(vec3(0.0, 1.0, 0.0), vec3(nx, 1.0 + ny, nz), att));
  vCrest = max(crest, 0.0) * att;
  vMirror = uMirrorMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec2 uHullHalf;
uniform float uWaterY;
uniform sampler2D uNormalTex;
uniform sampler2D uFoamTex;
uniform sampler2D uMirrorTex;
uniform float uMirrorStrength;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
varying vec4 vMirror;

// Signed distance from p to the (rounded-box) hull footprint at the waterline.
float sdHull(vec2 p) {
  vec2 d = abs(p) - uHullHalf;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 1.2;
}

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = distance(vWorld.xz, cameraPosition.xz);
  float detail = 1.0 - smoothstep(45.0, 240.0, dist);

  // Layered scrolling detail normals over the analytic Gerstner normal.
  vec2 n1 = texture2D(uNormalTex, vWorld.xz * 0.045 + uTime * vec2(0.021, 0.017)).xy * 2.0 - 1.0;
  vec2 n2 = texture2D(uNormalTex, vWorld.xz * 0.16 + uTime * vec2(-0.029, 0.024)).xy * 2.0 - 1.0;
  vec2 pert = (n1 * 0.55 + n2 * 0.32) * detail;
  vec3 N = normalize(vNormal + vec3(pert.x, 0.0, pert.y));

  // Water body colour: deep teal, lifting to turquoise near the hull where
  // the sand-free "shallow" scattering of the hull wash reads lighter.
  float d = sdHull(vWorld.xz);
  float shallow = exp(-max(d, 0.0) * 0.55);
  vec3 water = mix(uDeepColor, uShallowColor, shallow * 0.55);
  // Light through lifted crests.
  water += uShallowColor * 0.20 * clamp(vWorld.y - uWaterY, 0.0, 1.0);

  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);

  // Planar reflection (quarter-res RT), perturbed by the surface normal;
  // procedural sky gradient as fallback when the mirror is unavailable.
  vec3 R = reflect(-V, N);
  vec3 skyRefl = mix(uHorizonColor, uSkyColor, pow(clamp(R.y, 0.0, 1.0), 0.6));
  vec2 mUv = vMirror.xy / max(vMirror.w, 1e-4) + N.xz * 0.055;
  vec3 mirrorCol = texture2D(uMirrorTex, clamp(mUv, 0.002, 0.998)).rgb;
  vec3 refl = mix(skyRefl, mirrorCol, uMirrorStrength);

  vec3 col = mix(water, refl, clamp(fresnel * 0.92 + 0.05, 0.0, 1.0));

  // Golden-hour sun glint: tight primary lobe plus a broad soft lobe.
  vec3 H = normalize(uSunDir + V);
  float ndh = max(dot(N, H), 0.0);
  float glint = pow(ndh, 360.0) * 3.4 + pow(ndh, 48.0) * 0.13;
  col += uSunColor * glint * (0.3 + 0.7 * fresnel);

  // Foam: hull waterline band + wave-crest foam, broken up by noise.
  float foamN1 = texture2D(uFoamTex, vWorld.xz * 0.09 + uTime * vec2(0.013, -0.011)).r;
  float foamN2 = texture2D(uFoamTex, vWorld.xz * 0.23 - uTime * vec2(0.017, 0.019)).r;
  float band = 1.0 - smoothstep(0.0, 1.1, d);
  float hullFoam = band * smoothstep(0.58, 0.85, foamN1 * 0.5 + foamN2 * 0.45 + band * 0.32);
  // Crisp contact line right at the hull.
  hullFoam += (1.0 - smoothstep(0.0, 0.14, abs(d))) * 0.55;
  float crestFoam = smoothstep(0.86, 1.12, vCrest + foamN2 * 0.18) * (1.0 - smoothstep(120.0, 320.0, dist));
  float foam = clamp(hullFoam + crestFoam, 0.0, 1.0);
  col = mix(col, vec3(0.93, 0.97, 1.0), foam * 0.7);

  // Fade to the horizon so the disc edge never reads.
  col = mix(col, uHorizonColor, smoothstep(380.0, 950.0, dist));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Radial grid: rings every ~1.6m out to 42m, then geometric to the horizon. */
function buildOceanGeometry(): THREE.BufferGeometry {
  const SEGMENTS = 128;
  const radii: number[] = [];
  for (let r = 1.6; r < 42; r += 1.6) radii.push(r);
  let r = 42;
  while (r < 1600) {
    radii.push(r);
    r *= 1.13;
  }
  radii.push(1600);

  const rings = radii.length;
  const positions = new Float32Array((rings * SEGMENTS + 1) * 3);
  // Vertex 0 = centre; ring i vertex j = 1 + i*SEGMENTS + j.
  let p = 3;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = (j / SEGMENTS) * Math.PI * 2;
      positions[p++] = Math.cos(a) * radii[i];
      positions[p++] = 0;
      positions[p++] = Math.sin(a) * radii[i];
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < SEGMENTS; j++) {
    indices.push(0, 1 + ((j + 1) % SEGMENTS), 1 + j);
  }
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * SEGMENTS;
    const b0 = 1 + (i + 1) * SEGMENTS;
    for (let j = 0; j < SEGMENTS; j++) {
      const j1 = (j + 1) % SEGMENTS;
      indices.push(a0 + j, b0 + j1, b0 + j);
      indices.push(a0 + j, a0 + j1, b0 + j1);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  return geom;
}

export interface OceanHandle {
  mesh: THREE.Mesh;
  update(dt: number, cameraPos: Vec3): void;
  setSun(dir: Vec3, color: number): void;
  dispose(): void;
}

export function buildOcean(parent: THREE.Object3D, waterLevel: number = WATER_LEVEL): OceanHandle {
  const normalTex = waterNormalTexture();
  const foamTex = foamNoiseTexture();

  const mirrorRT = new THREE.WebGLRenderTarget(320, 180, { depthBuffer: true });
  mirrorRT.texture.minFilter = THREE.LinearFilter;
  mirrorRT.texture.magFilter = THREE.LinearFilter;

  const uniforms = {
    uTime: { value: 0 },
    uWaves: { value: WAVES.map((w) => new THREE.Vector4(w[0], w[1], w[2], w[3])) },
    uSteep: { value: STEEPNESS.slice() },
    uMirrorMatrix: { value: new THREE.Matrix4() },
    uSunDir: { value: DEFAULT_SUN_DIR.clone() },
    uSunColor: { value: DEFAULT_SUN_COLOR.clone() },
    uDeepColor: { value: new THREE.Color(0.012, 0.11, 0.14) },
    uShallowColor: { value: new THREE.Color(0.05, 0.42, 0.4) },
    uSkyColor: { value: new THREE.Color(0.16, 0.28, 0.5) },
    uHorizonColor: { value: new THREE.Color(0.85, 0.5, 0.28) },
    uHullHalf: { value: new THREE.Vector2(10.4, 28.6) },
    uWaterY: { value: waterLevel },
    uNormalTex: { value: normalTex },
    uFoamTex: { value: foamTex },
    uMirrorTex: { value: mirrorRT.texture },
    uMirrorStrength: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
  });

  const mesh = new THREE.Mesh(buildOceanGeometry(), material);
  mesh.name = 'ocean';
  mesh.frustumCulled = false;
  mesh.position.set(0, waterLevel, 0);
  mesh.matrixAutoUpdate = true;

  // --- Planar reflection, rendered in onBeforeRender (Reflector technique) --
  const mirrorCamera = new THREE.PerspectiveCamera();
  const plane = new THREE.Plane();
  const planeNormal = new THREE.Vector3(0, 1, 0);
  const mirrorPos = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const rot = new THREE.Matrix4();
  const lookAt = new THREE.Vector3();
  const view = new THREE.Vector3();
  const target = new THREE.Vector3();
  const clip = new THREE.Vector4();
  const q = new THREE.Vector4();
  const size = new THREE.Vector2();
  let rendering = false;

  mesh.onBeforeRender = (renderer, scene, camera) => {
    if (rendering || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;

    mirrorPos.set(0, waterLevel, 0);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y <= waterLevel + 0.05) return; // underwater: keep last frame

    rendering = true;

    // Quarter-resolution target, tracking the drawing buffer size.
    renderer.getDrawingBufferSize(size);
    const w = Math.max(160, Math.floor(size.x / 4));
    const h = Math.max(90, Math.floor(size.y / 4));
    if (mirrorRT.width !== w || mirrorRT.height !== h) mirrorRT.setSize(w, h);

    // Mirror the camera about the water plane.
    view.subVectors(mirrorPos, camPos);
    view.reflect(planeNormal).negate();
    view.add(mirrorPos);

    rot.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    target.subVectors(mirrorPos, lookAt);
    target.reflect(planeNormal).negate();
    target.add(mirrorPos);

    mirrorCamera.position.copy(view);
    mirrorCamera.up.set(0, 1, 0).applyMatrix4(rot).reflect(planeNormal);
    mirrorCamera.lookAt(target);
    mirrorCamera.far = (camera as THREE.PerspectiveCamera).far;
    mirrorCamera.updateMatrixWorld();
    mirrorCamera.projectionMatrix.copy((camera as THREE.PerspectiveCamera).projectionMatrix);

    // Projective texture matrix.
    const tm = uniforms.uMirrorMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(mirrorCamera.projectionMatrix);
    tm.multiply(mirrorCamera.matrixWorldInverse);

    // Oblique near-plane clipping so below-water geometry never reflects.
    plane.setFromNormalAndCoplanarPoint(planeNormal, mirrorPos);
    plane.applyMatrix4(mirrorCamera.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const proj = mirrorCamera.projectionMatrix;
    q.x = (Math.sign(clip.x) + proj.elements[8]) / proj.elements[0];
    q.y = (Math.sign(clip.y) + proj.elements[9]) / proj.elements[5];
    q.z = -1;
    q.w = (1 + proj.elements[10]) / proj.elements[14];
    clip.multiplyScalar(2 / clip.dot(q));
    proj.elements[2] = clip.x;
    proj.elements[6] = clip.y;
    proj.elements[10] = clip.z + 1.0 - 0.003;
    proj.elements[14] = clip.w;

    // Render the scene (minus the ocean) into the mirror target, linear.
    mesh.visible = false;
    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevTone = renderer.toneMapping;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(mirrorRT);
    renderer.state.buffers.depth.setMask(true);
    if (!renderer.autoClear) renderer.clear();
    renderer.render(scene, mirrorCamera);
    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.toneMapping = prevTone;
    mesh.visible = true;
    uniforms.uMirrorStrength.value = 1;
    rendering = false;
  };

  parent.add(mesh);

  return {
    mesh,
    update(dt, cameraPos) {
      uniforms.uTime.value += dt;
      // Follow the camera so the player can never reach the edge of the sea.
      mesh.position.set(cameraPos.x, waterLevel, cameraPos.z);
    },
    setSun(dir, color) {
      uniforms.uSunDir.value.set(dir.x, dir.y, dir.z).normalize();
      uniforms.uSunColor.value.set(color);
    },
    dispose() {
      mesh.onBeforeRender = () => {};
      mesh.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
      normalTex.dispose();
      foamTex.dispose();
      mirrorRT.dispose();
    },
  };
}
