/**
 * Post-processing — one EffectComposer for the whole frame.
 *
 * Pass order:
 *   1. RenderPass(world)                      — geometry, CSM shadows
 *   2. NormalPass(world)                      — normals for SSAO (skipped on low)
 *   3. ClearPass(depth only)                  — wipe depth, keep color
 *   4. RenderPass(viewmodel)                  — gun on top, can never clip walls
 *   5. EffectPass: SSAO                       — (skipped on low)
 *   6. EffectPass: Bloom (threshold .9) + ACES tone mapping
 *   7. EffectPass: SMAA
 *   8. EffectPass: Chromatic aberration + vignette
 *
 * SMAA and chromatic aberration are both convolution effects, which the
 * library refuses to merge into one shader — hence the separate passes.
 * Damage feedback: `setDamageIntensity(v)` drives CA offset + vignette.
 */

import * as THREE from 'three';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  ClearPass,
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import type { QualitySettings } from './quality.js';

const CA_BASE_OFFSET = 0.0005;
const CA_DAMAGE_OFFSET = 0.005;
const VIGNETTE_BASE = 0.38;
const VIGNETTE_DAMAGE = 0.28;

export class PostFX {
  readonly composer: EffectComposer;

  private readonly ssao: SSAOEffect | null = null;
  private readonly normalPass: NormalPass | null = null;
  private readonly ca: ChromaticAberrationEffect;
  private readonly vignette: VignetteEffect;
  private readonly camera: THREE.PerspectiveCamera;
  private damage = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    viewmodelScene: THREE.Scene,
    viewmodelCamera: THREE.PerspectiveCamera,
    settings: QualitySettings
  ) {
    this.camera = camera;
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      stencilBuffer: false,
    });

    // 1. World.
    const worldPass = new RenderPass(scene, camera);
    this.composer.addPass(worldPass);

    // 2. Normals for SSAO.
    if (settings.ssao) {
      this.normalPass = new NormalPass(scene, camera);
      this.composer.addPass(this.normalPass);
    }

    // 3 + 4. Depth wipe, then the viewmodel in its own scene at its own FOV.
    const depthClear = new ClearPass(false, true, false);
    this.composer.addPass(depthClear);

    const viewmodelPass = new RenderPass(viewmodelScene, viewmodelCamera);
    viewmodelPass.clearPass.enabled = false;
    viewmodelPass.ignoreBackground = true;
    viewmodelPass.skipShadowMapUpdate = true;
    this.composer.addPass(viewmodelPass);

    // 5. SSAO.
    if (settings.ssao && this.normalPass !== null) {
      this.ssao = new SSAOEffect(camera, this.normalPass.texture, {
        samples: settings.ssaoSamples,
        rings: settings.ssaoRings,
        resolutionScale: settings.ssaoResolutionScale,
        depthAwareUpsampling: true,
        worldDistanceThreshold: 40,
        worldDistanceFalloff: 10,
        worldProximityThreshold: 0.35,
        worldProximityFalloff: 0.1,
        radius: 0.08,
        intensity: 1.6,
        luminanceInfluence: 0.6,
        bias: 0.025,
        fade: 0.012,
      });
      this.composer.addPass(new EffectPass(camera, this.ssao));
    }

    // 6. Bloom + ACES.
    const tonemap = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    if (settings.bloom) {
      const bloom = new BloomEffect({
        luminanceThreshold: 0.9,
        luminanceSmoothing: 0.15,
        mipmapBlur: true,
        intensity: 0.75,
        radius: 0.7,
      });
      this.composer.addPass(new EffectPass(camera, bloom, tonemap));
    } else {
      this.composer.addPass(new EffectPass(camera, tonemap));
    }

    // 7. SMAA.
    const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
    this.composer.addPass(new EffectPass(camera, smaa));

    // 8. Vignette + chromatic aberration (HUD drives CA on damage).
    this.ca = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(CA_BASE_OFFSET, CA_BASE_OFFSET),
      radialModulation: true,
      modulationOffset: 0.28,
    });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: VIGNETTE_BASE });
    this.composer.addPass(new EffectPass(camera, this.ca, this.vignette));

    this.fixDepthTextureAliasing();
  }

  /**
   * postprocessing 6.39 creates its input/output/stable depth textures with
   * `DepthTexture.clone()`. In three r170 a clone shares the original's
   * `Source`, and WebGLTextures dedupes GL textures per Source — so all three
   * depth attachments alias ONE GL image, producing "read and write depth
   * attachments cannot be the same image" blit errors and framebuffer feedback
   * loops. Giving each depth texture its own Source restores three distinct
   * GL textures. Cheap, one-time, and a no-op once the library targets a
   * three release that clones Sources.
   */
  private fixDepthTextureAliasing(): void {
    const c = this.composer as unknown as {
      inputBuffer: THREE.WebGLRenderTarget;
      outputBuffer: THREE.WebGLRenderTarget;
      depthRenderTarget: THREE.WebGLRenderTarget | null;
    };
    for (const rt of [c.inputBuffer, c.outputBuffer, c.depthRenderTarget]) {
      const dt = rt !== null ? rt.depthTexture : null;
      if (dt !== null && dt !== undefined) {
        dt.source = new THREE.Source(dt.source.data);
        dt.needsUpdate = true;
      }
    }
  }

  /**
   * 0 = healthy, 1 = getting shredded. Scales chromatic aberration and the
   * vignette. Cheap: two uniform writes.
   */
  setDamageIntensity(v: number): void {
    const d = Math.min(Math.max(v, 0), 1);
    this.damage = d;
    const off = CA_BASE_OFFSET + d * CA_DAMAGE_OFFSET;
    this.ca.offset.set(off, off);
    this.vignette.darkness = VIGNETTE_BASE + d * VIGNETTE_DAMAGE;
  }

  get damageIntensity(): number {
    return this.damage;
  }

  /**
   * Keeps SSAO's cached projection uniforms in sync with a changed world FOV.
   * Deliberately avoids `needsUpdate` — same program, no recompile, no hitch.
   */
  onWorldProjectionChanged(): void {
    if (this.ssao === null) return;
    const u = this.ssao.ssaoMaterial.uniforms as Record<string, THREE.IUniform>;
    const nearFar = u.cameraNearFar;
    const proj = u.projectionMatrix;
    const invProj = u.inverseProjectionMatrix;
    if (nearFar !== undefined) (nearFar.value as THREE.Vector2).set(this.camera.near, this.camera.far);
    if (proj !== undefined) (proj.value as THREE.Matrix4).copy(this.camera.projectionMatrix);
    if (invProj !== undefined) (invProj.value as THREE.Matrix4).copy(this.camera.projectionMatrix).invert();
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height, false);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
