/**
 * Renderer — the ONLY module in DECKSHOT allowed to construct a WebGLRenderer,
 * an EffectComposer, or a camera.
 *
 * Everyone else adds objects to `renderer.scene` / `renderer.viewmodelScene`
 * and drives `renderer.camera`'s pose. The viewmodel scene is rendered on top
 * of the world with a cleared depth buffer at FOV_VIEWMODEL, so the gun never
 * clips into geometry regardless of the (constantly changing) world FOV.
 */

import * as THREE from 'three';
import { FOV_VIEWMODEL, FOV_WORLD } from '../../../shared/tuning.js';
import type { Vec3 } from '../../../shared/types.js';
import { PerfOverlay } from './debug.js';
import { Lighting, SUN_COLOR, SUN_INTENSITY } from './lighting.js';
import { configureMaterials, Materials } from './materials.js';
import { PostFX } from './postfx.js';
import { resolveQuality, type QualitySettings } from './quality.js';
import { SkyDome } from './sky.js';

const RAD2DEG = 180 / Math.PI;

const CAMERA_NEAR = 0.08;
const CAMERA_FAR = 800;
const VIEWMODEL_NEAR = 0.015;
const VIEWMODEL_FAR = 10;

/** Warm horizon haze; starts past the boat so the 45m crossmap stays crisp. */
const FOG_COLOR = 0xe9bd8f;
const FOG_NEAR = 120;
const FOG_FAR = 750;

const ENVIRONMENT_INTENSITY = 0.75;

export class Renderer {
  readonly scene: THREE.Scene;
  readonly viewmodelScene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly viewmodelCamera: THREE.PerspectiveCamera;
  readonly quality: QualitySettings;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: THREE.WebGLRenderer;
  private readonly sky: SkyDome;
  private readonly lighting: Lighting;
  private readonly postfx: PostFX;
  private readonly perf: PerfOverlay | null;
  private readonly resizeObserver: ResizeObserver;
  /** Fixed-FOV twin of the world camera; keeps CSM frusta stable while scoping. */
  private readonly shadowCamera: THREE.PerspectiveCamera;
  private readonly viewmodelSun: THREE.DirectionalLight;
  private readonly viewmodelFill: THREE.HemisphereLight;
  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA in the composer
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping; // ACES lives in the postfx chain
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.info.autoReset = false; // reset once per frame, not once per pass

    this.quality = resolveQuality(this.gl.getContext());
    configureMaterials(this.quality.tier, this.gl.capabilities.getMaxAnisotropy());

    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio, 2);
    this.gl.setPixelRatio(pixelRatio);

    this.width = Math.max(1, canvas.clientWidth || window.innerWidth);
    this.height = Math.max(1, canvas.clientHeight || window.innerHeight);

    // --- scenes + cameras --------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);
    this.viewmodelScene = new THREE.Scene();

    const aspect = this.width / this.height;
    this.camera = new THREE.PerspectiveCamera(FOV_WORLD * RAD2DEG, aspect, CAMERA_NEAR, CAMERA_FAR);
    this.viewmodelCamera = new THREE.PerspectiveCamera(FOV_VIEWMODEL * RAD2DEG, aspect, VIEWMODEL_NEAR, VIEWMODEL_FAR);
    this.shadowCamera = new THREE.PerspectiveCamera(FOV_WORLD * RAD2DEG, aspect, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 1.62, 0);

    // --- sky + IBL (captured once; this is what makes the PBR look paid-for)
    this.sky = new SkyDome();
    const env = this.sky.captureEnvironment(this.gl);
    this.scene.add(this.sky.mesh);
    this.scene.environment = env;
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    this.viewmodelScene.environment = env;
    this.viewmodelScene.environmentIntensity = ENVIRONMENT_INTENSITY;

    // --- lighting ----------------------------------------------------------
    this.lighting = new Lighting(this.scene, this.shadowCamera, this.sky.sunDirection, this.quality);

    // The viewmodel scene has no CSM; give it a matching (shadowless) sun so
    // the gun sits in the same light as the world.
    this.viewmodelSun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.viewmodelSun.position.copy(this.sky.sunDirection.clone().multiplyScalar(10));
    this.viewmodelScene.add(this.viewmodelSun);
    this.viewmodelScene.add(this.viewmodelSun.target);
    this.viewmodelFill = new THREE.HemisphereLight(0x94aed1, 0x54402a, 0.35);
    this.viewmodelScene.add(this.viewmodelFill);

    // --- postfx ------------------------------------------------------------
    this.postfx = new PostFX(this.gl, this.scene, this.camera, this.viewmodelScene, this.viewmodelCamera, this.quality);
    this.postfx.setSize(this.width, this.height);

    this.perf = PerfOverlay.create(this.gl, this.quality.tier);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
  }

  /**
   * Called continuously while scoping. Only touches the projection matrix and
   * a few uniforms — never rebuilds the pipeline.
   */
  setWorldFov(radians: number): void {
    this.camera.fov = radians * RAD2DEG;
    this.camera.updateProjectionMatrix();
    this.postfx.onWorldProjectionChanged();
    // shadowCamera intentionally stays at FOV_WORLD: cascades fitted for the
    // widest frustum remain valid for every narrower (scoped) one.
  }

  /** Muzzle flashes etc. Pooled and recycled; free to call every shot. */
  addDynamicLight(pos: Vec3, color: number, intensity: number, lifetime: number): void {
    this.lighting.addDynamicLight(pos, color, intensity, lifetime);
  }

  /**
   * ZOMBIES atmosphere: retune the scene fog (three uniform writes, no
   * pipeline change). Pass nothing to restore the competitive default —
   * always call that restore on leaving the mode, the Renderer is shared.
   */
  setFogProfile(near = FOG_NEAR, far = FOG_FAR, color = FOG_COLOR): void {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog) return;
    fog.near = near;
    fog.far = far;
    fog.color.setHex(color);
  }

  /** 0..1 — HUD drives this on damage; scales chromatic aberration + vignette. */
  setDamageIntensity(v: number): void {
    this.postfx.setDamageIntensity(v);
  }

  render(dtSeconds: number): void {
    if (this.disposed) return;
    if (this.perf !== null) this.perf.beginFrame();
    this.gl.info.reset();

    this.camera.updateMatrixWorld();

    // The viewmodel camera stays at IDENTITY. The viewmodel scene is authored
    // in camera space — the weapon rig sits at the origin looking down -Z, and
    // the scope overlay is a clip-space quad — so the camera must not move with
    // the player. Mirroring the world camera's pose here (as the shadow camera
    // legitimately does) leaves the camera at eye height, two metres above a
    // perfectly correct rig, rendering it off the bottom of the screen.
    this.viewmodelCamera.position.set(0, 0, 0);
    this.viewmodelCamera.quaternion.identity();
    this.viewmodelCamera.updateMatrixWorld();
    this.shadowCamera.position.copy(this.camera.position);
    this.shadowCamera.quaternion.copy(this.camera.quaternion);
    this.shadowCamera.updateMatrixWorld();

    this.sky.update(dtSeconds);
    this.lighting.update(dtSeconds);
    this.postfx.render(dtSeconds);

    if (this.perf !== null) this.perf.endFrame();
  }

  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();
    this.shadowCamera.aspect = aspect;
    this.shadowCamera.updateProjectionMatrix();

    this.postfx.setSize(w, h); // resizes the renderer + every pass
    this.postfx.onWorldProjectionChanged();
    this.lighting.resize();
  }

  /** Full teardown — dev hot-reload must not leak GPU memory. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    if (this.perf !== null) this.perf.dispose();
    this.postfx.dispose();
    this.lighting.dispose();
    this.scene.remove(this.sky.mesh);
    this.sky.dispose();
    this.viewmodelScene.remove(this.viewmodelSun, this.viewmodelSun.target, this.viewmodelFill);
    this.viewmodelSun.dispose();
    this.viewmodelFill.dispose();
    this.scene.environment = null;
    this.viewmodelScene.environment = null;
    Materials.dispose();
    this.gl.dispose();
  }
}
