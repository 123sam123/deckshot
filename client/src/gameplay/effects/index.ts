/**
 * DECKSHOT effects — the public facade.
 *
 *   Effects.init(renderer)
 *   Effects.spawnMuzzleFlash(pos, dir, opts)
 *   Effects.spawnTracer(from, to, opts)
 *   Effects.spawnImpact(point, normal, material)
 *   Effects.spawnBlood(pos, dir, kill)
 *   Effects.spawnCasing(pos, vel, floorY)
 *   Effects.triggerHitmarker(kind) / Effects.onHitmarker(cb)
 *   Effects.update(dt)
 *
 * All visuals are pooled and preallocated at init. MAX_PARTICLES and
 * MAX_DECALS from tuning are hard caps enforced by ring buffers that
 * recycle the oldest entry. Everything is a no-op before init, and the
 * renderer contract is consumed defensively (addDynamicLight optional)
 * because the engine is built concurrently.
 *
 * Owner: viewmodel-vfx-audio.
 */

import * as THREE from 'three';
import { SurfaceMaterial } from '../../../../shared/mapdata.js';
import { MAX_PARTICLES } from '../../../../shared/tuning.js';
import type { Vec3 } from '../../../../shared/types.js';
import { Audio } from '../../audio/index.js';
import { CasingPool } from './casings.js';
import { DecalPool } from './decals.js';
import { ParticlePool } from './particles.js';
import { TracerPool } from './tracers.js';

/**
 * Structural slice of the renderer contract (client/src/engine, built
 * concurrently). `addDynamicLight` is treated as optional so Effects
 * degrades gracefully if the symbol is missing.
 */
export interface EffectsRenderer {
  scene: THREE.Scene;
  camera: THREE.Camera;
  addDynamicLight?(pos: Vec3, color: number, intensity: number, lifetime: number): void;
}

export type HitmarkerKind = 'hit' | 'headshot' | 'kill';
export type HitmarkerListener = (kind: HitmarkerKind) => void;

export interface MuzzleFlashOpts {
  suppressed?: boolean;
  /** Smaller flash for the pistol. */
  scale?: number;
}

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** Random unit-ish vector in a cone around `n` (spread 0..1). */
function coneVel(n: Vec3, speed: number, spread: number): Vec3 {
  return {
    x: n.x * speed + (Math.random() - 0.5) * 2 * speed * spread,
    y: n.y * speed + (Math.random() - 0.5) * 2 * speed * spread,
    z: n.z * speed + (Math.random() - 0.5) * 2 * speed * spread,
  };
}

class EffectsSystem {
  private renderer: EffectsRenderer | null = null;
  private additive: ParticlePool | null = null;
  private alpha: ParticlePool | null = null;
  private tracers: TracerPool | null = null;
  private decals: DecalPool | null = null;
  private casings: CasingPool | null = null;
  private hitListeners: HitmarkerListener[] = [];

  init(renderer: EffectsRenderer): void {
    if (this.renderer) return; // already initialized
    this.renderer = renderer;
    const scene = renderer.scene;
    // MAX_PARTICLES is the combined hard cap across both blend pools.
    const additiveShare = Math.floor(MAX_PARTICLES * 0.4); // 800
    const alphaShare = MAX_PARTICLES - additiveShare; // 1200
    this.additive = new ParticlePool(scene, additiveShare, true);
    this.alpha = new ParticlePool(scene, alphaShare, false);
    this.tracers = new TracerPool(scene);
    this.decals = new DecalPool(scene);
    this.casings = new CasingPool(scene);
  }

  private light(pos: Vec3, color: number, intensity: number, lifetime: number): void {
    const r = this.renderer;
    if (r && typeof r.addDynamicLight === 'function') {
      try {
        r.addDynamicLight(pos, color, intensity, lifetime);
      } catch {
        /* renderer still under construction — visuals degrade, nothing breaks */
      }
    }
  }

  spawnMuzzleFlash(pos: Vec3, dir: Vec3, opts?: MuzzleFlashOpts): void {
    if (!this.additive || !this.alpha) return;
    const k = (opts?.scale ?? 1) * (opts?.suppressed ? 0.35 : 1);
    // Core flash — one hot frame.
    this.additive.spawn({
      pos, vel: { x: 0, y: 0, z: 0 },
      life: 0.05, size: 0.34 * k, sizeEnd: 0.1 * k,
      color: 0xfff2c4, colorEnd: 0xff8830, alpha: 1, alphaEnd: 0,
    });
    // Star glow, slightly larger, slightly longer.
    this.additive.spawn({
      pos, vel: coneVel(dir, 1.2, 0.1),
      life: 0.09, size: 0.2 * k, sizeEnd: 0.03,
      color: 0xffc060, colorEnd: 0xa03000, alpha: 0.9, alphaEnd: 0,
    });
    // Smoke wisp drifting up-forward.
    this.alpha.spawn({
      pos: { x: pos.x + dir.x * 0.1, y: pos.y + dir.y * 0.1, z: pos.z + dir.z * 0.1 },
      vel: { x: dir.x * 0.7, y: 0.5 + dir.y * 0.7, z: dir.z * 0.7 },
      life: rand(0.7, 1.1), size: 0.06, sizeEnd: 0.42,
      color: 0x9aa0a8, colorEnd: 0x70757c, alpha: 0.35, alphaEnd: 0,
      drag: 2.2, spin: rand(-2, 2),
    });
    if (!opts?.suppressed) this.light(pos, 0xffc070, 3.2 * k, 0.06);
  }

  spawnTracer(from: Vec3, to: Vec3, opts?: { color?: number; width?: number }): void {
    this.tracers?.spawn(from, to, opts?.color, opts?.width);
  }

  spawnImpact(point: Vec3, normal: Vec3, material: SurfaceMaterial): void {
    if (!this.additive || !this.alpha || !this.decals) return;
    Audio.playImpact(material, point);
    switch (material) {
      case SurfaceMaterial.Teak: {
        // Splinters + dust + dark hole in the deck planking.
        for (let i = 0; i < 9; i++) {
          this.alpha.spawn({
            pos: point, vel: coneVel(normal, rand(2, 5), 0.5),
            life: rand(0.4, 0.9), size: rand(0.012, 0.028), sizeEnd: 0.004,
            color: 0x6b4a2b, colorEnd: 0x4a3018, alpha: 1, alphaEnd: 0.6,
            gravity: 9.5, drag: 1.2, spin: rand(-15, 15),
          });
        }
        this.alpha.spawn({
          pos: point, vel: coneVel(normal, 0.7, 0.3),
          life: 0.55, size: 0.05, sizeEnd: 0.3,
          color: 0xb99a6b, alpha: 0.4, alphaEnd: 0, drag: 3,
        });
        this.decals.hole(point, normal, rand(0.07, 0.1), 0x2a1c0e);
        break;
      }
      case SurfaceMaterial.Metal: {
        // Sparks + bright ricochet flash + small dark scorch.
        for (let i = 0; i < 13; i++) {
          this.additive.spawn({
            pos: point, vel: coneVel(normal, rand(3.5, 9), 0.55),
            life: rand(0.25, 0.6), size: rand(0.012, 0.024), sizeEnd: 0.002,
            color: 0xffe6a0, colorEnd: 0xff3c00, alpha: 1, alphaEnd: 0,
            gravity: 7, drag: 0.8,
          });
        }
        this.additive.spawn({
          pos: point, vel: { x: 0, y: 0, z: 0 },
          life: 0.06, size: 0.2, sizeEnd: 0.04,
          color: 0xffffff, colorEnd: 0xffa040, alpha: 1, alphaEnd: 0,
        });
        this.decals.hole(point, normal, rand(0.05, 0.07), 0x1c1c20);
        this.light(point, 0xffb050, 1.6, 0.05);
        break;
      }
      case SurfaceMaterial.Glass: {
        // Shards + glitter + a cracked-glass star.
        for (let i = 0; i < 11; i++) {
          this.alpha.spawn({
            pos: point, vel: coneVel(normal, rand(1.5, 4.5), 0.7),
            life: rand(0.4, 0.8), size: rand(0.014, 0.03), sizeEnd: 0.005,
            color: 0xcfe4f5, colorEnd: 0x9db8cc, alpha: 0.9, alphaEnd: 0.2,
            gravity: 9.5, drag: 0.6, spin: rand(-20, 20),
          });
        }
        for (let i = 0; i < 5; i++) {
          this.additive.spawn({
            pos: point, vel: coneVel(normal, rand(1, 3), 0.8),
            life: rand(0.2, 0.45), size: 0.02, sizeEnd: 0.003,
            color: 0xffffff, alpha: 0.9, alphaEnd: 0, gravity: 9.5,
          });
        }
        this.decals.crack(point, normal, rand(0.4, 0.6));
        break;
      }
      case SurfaceMaterial.Composite: {
        // Dust puff + paint chips off the white superstructure.
        this.alpha.spawn({
          pos: point, vel: coneVel(normal, 0.9, 0.3),
          life: 0.6, size: 0.06, sizeEnd: 0.34,
          color: 0xd8d8d2, alpha: 0.45, alphaEnd: 0, drag: 3,
        });
        for (let i = 0; i < 6; i++) {
          this.alpha.spawn({
            pos: point, vel: coneVel(normal, rand(1.5, 3.5), 0.6),
            life: rand(0.3, 0.6), size: 0.012, sizeEnd: 0.004,
            color: 0xe8e8e2, colorEnd: 0xb8b8b2, alpha: 1, alphaEnd: 0.3,
            gravity: 9.5, drag: 1.5,
          });
        }
        this.decals.hole(point, normal, rand(0.06, 0.09), 0x33342f);
        break;
      }
      case SurfaceMaterial.Fabric: {
        // Soft fibre puff, muffled — barely marks the lounger.
        for (let i = 0; i < 6; i++) {
          this.alpha.spawn({
            pos: point, vel: coneVel(normal, rand(0.5, 1.4), 0.7),
            life: rand(0.5, 0.9), size: rand(0.025, 0.05), sizeEnd: 0.1,
            color: 0xd8cfc0, alpha: 0.5, alphaEnd: 0, drag: 3.5, gravity: 1.2,
          });
        }
        this.decals.hole(point, normal, 0.045, 0x3a332a);
        break;
      }
      case SurfaceMaterial.Water: {
        this.spawnWaterSplash(point);
        break;
      }
    }
  }

  /** Splash for shots into the sea (also usable for anything hitting water). */
  spawnWaterSplash(point: Vec3, big = false): void {
    if (!this.additive || !this.alpha) return;
    const n = big ? 22 : 14;
    for (let i = 0; i < n; i++) {
      // Narrow upward column of droplets.
      this.alpha.spawn({
        pos: point,
        vel: {
          x: (Math.random() - 0.5) * (big ? 2.2 : 1.2),
          y: rand(2.5, big ? 7 : 5),
          z: (Math.random() - 0.5) * (big ? 2.2 : 1.2),
        },
        life: rand(0.4, 0.8), size: rand(0.02, 0.05), sizeEnd: 0.01,
        color: 0xe8f4ff, colorEnd: 0xbcd8e8, alpha: 0.85, alphaEnd: 0,
        gravity: 12, drag: 0.5,
      });
    }
    // Foam crown.
    this.alpha.spawn({
      pos: point, vel: { x: 0, y: 0.6, z: 0 },
      life: 0.7, size: big ? 0.3 : 0.16, sizeEnd: big ? 1.0 : 0.55,
      color: 0xffffff, alpha: 0.55, alphaEnd: 0, drag: 3,
    });
  }

  /** Blood puff on a confirmed player hit (position is the hit point). */
  spawnBlood(pos: Vec3, dir: Vec3, kill = false): void {
    if (!this.alpha) return;
    const n = kill ? 16 : 10;
    for (let i = 0; i < n; i++) {
      this.alpha.spawn({
        pos,
        vel: coneVel(dir, rand(1, 3.2), 0.8),
        life: rand(0.3, 0.6), size: rand(0.02, 0.045), sizeEnd: 0.01,
        color: 0x8e1010, colorEnd: 0x520606, alpha: 0.95, alphaEnd: 0,
        gravity: 8, drag: 1.5,
      });
    }
    this.alpha.spawn({
      pos, vel: coneVel(dir, 0.5, 0.4),
      life: 0.4, size: 0.08, sizeEnd: 0.3,
      color: 0x6e0a0a, alpha: 0.5, alphaEnd: 0, drag: 3,
    });
  }

  spawnCasing(pos: Vec3, vel: Vec3, floorY?: number): void {
    this.casings?.spawn(pos, vel, floorY);
  }

  /**
   * Hit feedback for the local player's shots. Plays the tick (white X),
   * a deeper gold-X sound on kill, a distinct higher pitch on headshot,
   * and notifies HUD subscribers so they can draw the marker.
   */
  triggerHitmarker(kind: HitmarkerKind): void {
    if (kind === 'kill') Audio.play('kill');
    else if (kind === 'headshot') Audio.play('headshot');
    else Audio.play('hitmarker');
    for (const l of this.hitListeners) {
      try {
        l(kind);
      } catch {
        /* a broken HUD listener must not break effects */
      }
    }
  }

  onHitmarker(cb: HitmarkerListener): () => void {
    this.hitListeners.push(cb);
    return () => {
      const i = this.hitListeners.indexOf(cb);
      if (i >= 0) this.hitListeners.splice(i, 1);
    };
  }

  update(dt: number): void {
    if (!this.renderer) return;
    this.additive?.update(dt);
    this.alpha?.update(dt);
    this.tracers?.update(dt, this.renderer.camera);
    this.casings?.update(dt);
  }
}

const system = new EffectsSystem();

/** The contracted effects facade. All methods are safe no-ops before init. */
export const Effects = {
  init: (renderer: EffectsRenderer): void => system.init(renderer),
  spawnMuzzleFlash: (pos: Vec3, dir: Vec3, opts?: MuzzleFlashOpts): void =>
    system.spawnMuzzleFlash(pos, dir, opts),
  spawnTracer: (from: Vec3, to: Vec3, opts?: { color?: number; width?: number }): void =>
    system.spawnTracer(from, to, opts),
  spawnImpact: (point: Vec3, normal: Vec3, material: SurfaceMaterial): void =>
    system.spawnImpact(point, normal, material),
  spawnWaterSplash: (point: Vec3, big?: boolean): void => system.spawnWaterSplash(point, big),
  spawnBlood: (pos: Vec3, dir: Vec3, kill?: boolean): void => system.spawnBlood(pos, dir, kill),
  spawnCasing: (pos: Vec3, vel: Vec3, floorY?: number): void => system.spawnCasing(pos, vel, floorY),
  triggerHitmarker: (kind: HitmarkerKind): void => system.triggerHitmarker(kind),
  /** HUD subscribes here to draw the white/gold X. Returns unsubscribe. */
  onHitmarker: (cb: HitmarkerListener): (() => void) => system.onHitmarker(cb),
  update: (dt: number): void => system.update(dt),
};
