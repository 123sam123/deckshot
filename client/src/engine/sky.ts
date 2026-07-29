/**
 * Sky — Preetham analytic daylight on a big inverted sphere, tuned for a hazy
 * golden hour, with a slow procedural cirrus layer on top.
 *
 * The fragment output is linear HDR (no tone mapping, no OETF): the postfx
 * chain owns ACES + sRGB. `captureEnvironment` renders the sky into a PMREM
 * cubemap ONCE at load; that texture drives all IBL in the scene.
 *
 * GLSL atmosphere adapted from the three.js `Sky` example (Preetham model,
 * Wallner / Upitis / zz85), with the built-in tonemapping stripped and a
 * cloud layer added.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

/** Golden hour: sun low off the starboard quarter, raking across the deck. */
export const SUN_ELEVATION = 6 * DEG;
export const SUN_AZIMUTH = 112 * DEG;

/** Unit vector pointing from the origin toward the sun. */
export function computeSunDirection(): THREE.Vector3 {
  return new THREE.Vector3(
    Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION),
    Math.sin(SUN_ELEVATION),
    Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION)
  ).normalize();
}

const SKY_RADIUS = 600;

const VERT = /* glsl */ `
uniform vec3 sunPosition;
uniform float rayleigh;
uniform float turbidity;
uniform float mieCoefficient;

varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

const vec3 up = vec3(0.0, 1.0, 0.0);
const float e = 2.71828182845904523536;
const float pi = 3.14159265358979323846;

const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);

// earth shadow hack
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
}

vec3 totalMie(float T) {
  float c = (0.2 * T) * 10E-18;
  return 0.434 * c * MieConst;
}

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // pin to the far plane

  vSunDirection = normalize(sunPosition);
  vSunE = sunIntensity(dot(vSunDirection, up));
  vSunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);

  float rayleighCoefficient = rayleigh - (1.0 * (1.0 - vSunfade));
  vBetaR = totalRayleigh * rayleighCoefficient;
  vBetaM = totalMie(turbidity) * mieCoefficient;
}
`;

const FRAG = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

uniform float mieDirectionalG;
uniform float uSunDiskScale;
uniform float uSkyScale;
uniform float uTime;
uniform float uCloudAmount;

const vec3 up = vec3(0.0, 1.0, 0.0);
const float pi = 3.14159265358979323846;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
// cos(66 arc-seconds), the visual angular radius of the sun
const float sunAngularDiameterCos = 0.999956676946448443;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase(float cosTheta) {
  return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
}

float hgPhase(float cosTheta, float g) {
  float g2 = pow(g, 2.0);
  float inv = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inv);
}

// --- value-noise fbm for the cloud layer -----------------------------------
float hash12(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.31, 9.17);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 direction = normalize(vWorldPosition - cameraPosition);

  // optical length; cutoff angle at 90deg avoids the singularity
  float zenithAngle = acos(max(0.0, dot(up, direction)));
  float inv = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sR = rayleighZenithLength * inv;
  float sM = mieZenithLength * inv;

  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

  float cosTheta = dot(direction, vSunDirection);

  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaRTheta = vBetaR * rPhase;
  float mPhase = hgPhase(cosTheta, mieDirectionalG);
  vec3 betaMTheta = vBetaM * mPhase;

  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(
    vec3(1.0),
    pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(0.5)),
    clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0)
  );

  vec3 L0 = vec3(0.1) * Fex;

  // solar disc (HDR — the bloom pass turns this into the glow)
  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);
  L0 += (vSunE * 19000.0 * Fex) * sundisk * uSunDiskScale;

  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  vec3 sky = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade))));

  // --- drifting cirrus ------------------------------------------------------
  float horizon = smoothstep(0.015, 0.14, direction.y);
  vec2 cuv = direction.xz / (abs(direction.y) + 0.18);
  cuv = cuv * vec2(0.35, 0.85) + vec2(uTime * 0.0045, uTime * 0.0011);
  float n = fbm(cuv * 1.7);
  float cov = smoothstep(0.52, 0.8, n) * horizon * uCloudAmount;

  float sunGlow = pow(clamp(cosTheta * 0.5 + 0.5, 0.0, 1.0), 3.0);
  // Warm-lit cream near the sun, cool violet-grey away from it.
  vec3 cloudCol = mix(vec3(0.34, 0.32, 0.38), vec3(1.55, 0.98, 0.58), sunGlow);
  cloudCol *= 0.16 + 0.5 * n;

  vec3 col = mix(sky, cloudCol, cov * 0.8) * uSkyScale;

  gl_FragColor = vec4(col, 1.0);
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly sunDirection: THREE.Vector3;

  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.SphereGeometry;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private time = 0;

  constructor() {
    this.sunDirection = computeSunDirection();
    this.geometry = new THREE.SphereGeometry(SKY_RADIUS, 48, 24);
    this.material = new THREE.ShaderMaterial({
      name: 'deckshot/sky',
      uniforms: {
        turbidity: { value: 8.0 },
        rayleigh: { value: 3.4 },
        mieCoefficient: { value: 0.006 },
        mieDirectionalG: { value: 0.8 },
        sunPosition: { value: this.sunDirection.clone().multiplyScalar(1000) },
        uSunDiskScale: { value: 1.0 },
        uSkyScale: { value: 0.45 },
        uTime: { value: 0 },
        uCloudAmount: { value: 0.85 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.userData.noShadow = true;
  }

  /** Advances the cloud drift. Call once per frame. */
  update(dt: number): void {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
  }

  /**
   * Renders the sky to a prefiltered cubemap for IBL. Call ONCE at load,
   * before adding the mesh to the main scene. The sun disk is damped during
   * capture so the analytic sun stays the only hard specular source and the
   * PMREM mips don't firefly.
   */
  captureEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    if (this.envRT !== null) return this.envRT.texture;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const captureScene = new THREE.Scene();
    captureScene.add(this.mesh);
    this.material.uniforms.uSunDiskScale.value = 0.02;
    this.envRT = pmrem.fromScene(captureScene, 0.003, 1, SKY_RADIUS * 1.5);
    this.material.uniforms.uSunDiskScale.value = 1.0;
    captureScene.remove(this.mesh);
    pmrem.dispose();
    return this.envRT.texture;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    if (this.envRT !== null) {
      this.envRT.dispose();
      this.envRT = null;
    }
  }
}
