/**
 * Lighting — one golden-hour sun with 3-cascade shadow maps (three.js CSM),
 * a soft sky/sea fill, and a preallocated pool of dynamic point lights for
 * muzzle flashes.
 *
 * CSM caveat handled here: the addon's cascade lights each carry full sun
 * intensity, and the shader patch that restricts each light to its cascade
 * must be installed per material. Other agents add meshes with their own
 * materials, so `update()` lazily sweeps the scene and patches any lit
 * material it hasn't seen. The sweep also applies the shadow policy: small
 * meshes cast, everything lit receives, and anything huge (ocean, sky) or
 * tagged `userData.noShadow` is left alone.
 */

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { SHADOW_CASCADES } from '../../../shared/tuning.js';
import type { Vec3 } from '../../../shared/types.js';
import type { QualitySettings } from './quality.js';

export const SUN_COLOR = 0xffcf9a;
export const SUN_INTENSITY = 3.0;

/**
 * Cascades tuned for the 62m Sundeck: nearly all fights are inside 40m, so the
 * far cascade stops at 64m instead of drizzling texels over open water.
 * Splits: 0–9m / 9–26m / 26–64m.
 */
const CSM_MAX_FAR = 64;
const CSM_SPLITS = [9 / CSM_MAX_FAR, 26 / CSM_MAX_FAR, 1];

/** Meshes with a bounding radius above this never auto-cast shadows. */
const CAST_RADIUS_LIMIT = 25;

interface PooledLight {
  light: THREE.PointLight;
  ttl: number;
  life: number;
  peak: number;
}

type LitMaterial = THREE.Material & { isMeshStandardMaterial?: boolean };

function isLitMaterial(m: THREE.Material): boolean {
  const anyM = m as unknown as Record<string, boolean | undefined>;
  return (
    anyM.isMeshStandardMaterial === true ||
    anyM.isMeshPhongMaterial === true ||
    anyM.isMeshLambertMaterial === true ||
    anyM.isMeshToonMaterial === true
  );
}

export class Lighting {
  readonly csm: CSM;
  readonly sunDirection: THREE.Vector3;

  private readonly scene: THREE.Scene;
  private readonly hemi: THREE.HemisphereLight;
  private readonly pool: PooledLight[] = [];
  private readonly patchedMaterials = new WeakSet<THREE.Material>();
  private readonly processedObjects = new WeakSet<THREE.Object3D>();

  constructor(
    scene: THREE.Scene,
    shadowCamera: THREE.PerspectiveCamera,
    sunDirection: THREE.Vector3,
    settings: QualitySettings
  ) {
    this.scene = scene;
    this.sunDirection = sunDirection.clone().normalize();

    this.csm = new CSM({
      camera: shadowCamera,
      parent: scene,
      cascades: SHADOW_CASCADES,
      maxFar: CSM_MAX_FAR,
      mode: 'custom',
      customSplitsCallback: (_cascades: number, _near: number, _far: number, breaks: number[]) => {
        breaks.push(...CSM_SPLITS);
      },
      shadowMapSize: settings.shadowMapSize,
      lightDirection: this.sunDirection.clone().negate(),
      lightIntensity: SUN_INTENSITY,
      lightNear: 1,
      lightFar: 220,
      lightMargin: 100,
      shadowBias: -0.0001,
    });
    this.csm.fade = true;
    this.csm.updateFrustums();
    for (const light of this.csm.lights) {
      light.color.set(SUN_COLOR);
      light.shadow.normalBias = 0.025;
    }

    // Cool sky above, warm teak/sea bounce below. The env map carries most of
    // the ambient; this fills materials that ignore the environment.
    this.hemi = new THREE.HemisphereLight(0x94aed1, 0x54402a, 0.3);
    scene.add(this.hemi);

    // Dynamic light pool — preallocated, recycled, never grown at play time.
    // Kept permanently in the scene at intensity 0 so the shader program
    // (which bakes the light count) never changes.
    for (let i = 0; i < settings.dynamicLightCount; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 16, 2);
      light.name = `dynlight_${i}`;
      light.castShadow = false;
      scene.add(light);
      this.pool.push({ light, ttl: 0, life: 1, peak: 0 });
    }
  }

  /** Muzzle flashes and the like. Recycles the pool; never allocates. */
  addDynamicLight(pos: Vec3, color: number, intensity: number, lifetime: number): void {
    let slot = this.pool[0];
    if (slot === undefined) return;
    for (const p of this.pool) {
      if (p.ttl <= 0) {
        slot = p;
        break;
      }
      if (p.ttl < slot.ttl) slot = p;
    }
    slot.light.position.set(pos.x, pos.y, pos.z);
    slot.light.color.set(color);
    slot.peak = intensity;
    slot.life = Math.max(lifetime, 1e-3);
    slot.ttl = slot.life;
    slot.light.intensity = intensity;
  }

  /** Per-frame: decay dynamic lights, patch new materials, refit cascades. */
  update(dt: number): void {
    for (const p of this.pool) {
      if (p.ttl > 0) {
        p.ttl -= dt;
        const k = Math.max(p.ttl, 0) / p.life;
        p.light.intensity = p.peak * k * k;
      }
    }
    this.sweepScene();
    this.csm.update();
  }

  /** Call when the shadow reference camera's projection changes (resize). */
  resize(): void {
    this.csm.updateFrustums();
  }

  private sweepScene(): void {
    this.scene.traverse((obj) => {
      if (this.processedObjects.has(obj)) return;
      this.processedObjects.add(obj);
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh !== true) return;

      const materials: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let lit = false;
      for (const m of materials) {
        if (isLitMaterial(m)) {
          lit = true;
          this.patchMaterial(m as LitMaterial);
        }
      }

      if (obj.userData.noShadow === true) return;
      if (lit) {
        mesh.receiveShadow = true;
        const geo = mesh.geometry;
        if (geo.boundingSphere === null) geo.computeBoundingSphere();
        const radius = geo.boundingSphere !== null ? geo.boundingSphere.radius : Infinity;
        if (radius < CAST_RADIUS_LIMIT) mesh.castShadow = true;
      }
    });
  }

  private patchMaterial(m: LitMaterial): void {
    if (this.patchedMaterials.has(m)) return;
    this.patchedMaterials.add(m);
    if (m.userData.csmIgnore === true) return;

    // Preserve a pre-existing custom onBeforeCompile by chaining it in front
    // of the CSM injection.
    const proto = Object.getPrototypeOf(m) as { onBeforeCompile?: unknown };
    const hasCustom =
      Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') && m.onBeforeCompile !== proto.onBeforeCompile;
    const prev = hasCustom ? m.onBeforeCompile.bind(m) : null;
    this.csm.setupMaterial(m);
    if (prev !== null) {
      const csmHook = m.onBeforeCompile.bind(m);
      m.onBeforeCompile = (shader, renderer) => {
        prev(shader, renderer);
        csmHook(shader, renderer);
      };
    }
    m.needsUpdate = true;
  }

  dispose(): void {
    this.csm.dispose();
    this.csm.remove();
    this.scene.remove(this.hemi);
    this.hemi.dispose();
    for (const p of this.pool) {
      this.scene.remove(p.light);
      p.light.dispose();
    }
    this.pool.length = 0;
  }
}
