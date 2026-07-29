/**
 * DECKSHOT audio — the public facade.
 *
 * Contracted interface (INTEGRATION.md):
 *   Audio.init(): Promise<void>
 *   Audio.play(id, { position?, pitch?, volume? })
 *   Audio.setListener(pos, forward, up)
 *   Audio.setMasterVolume(v)
 *
 * Plus owner extras used by viewmodel/effects/HUD:
 *   playFootstep, playWhizz (real doppler flyby), setLowHealth,
 *   startAmbient/stopAmbient, isReady.
 *
 * Everything is synthesized (see synth.ts / sounds.ts) — no audio assets.
 * Initialises lazily around the browser autoplay policy and NEVER throws:
 * every entry point is guarded; before init or on failure, calls are no-ops.
 *
 * Owner: viewmodel-vfx-audio.
 */

import type { Vec3 } from '../../../shared/types.js';
import { SurfaceMaterial } from '../../../shared/mapdata.js';
import { AmbientBed } from './ambient.js';
import { RECIPES, RecipeIo, SoundId, reverbSendFor } from './sounds.js';
import { SynthCtx, clamp01, createSynthCtx, makeImpulseResponse } from './synth.js';

export type { SoundId } from './sounds.js';

export interface PlayOpts {
  /** World position; omit for non-spatial (UI, own-weapon) sounds. */
  position?: Vec3;
  /** Playback pitch multiplier, 1 = as authored. */
  pitch?: number;
  /** Linear volume multiplier, 1 = as authored. */
  volume?: number;
}

export type FootstepGait = 'walk' | 'sprint' | 'crouch';

const SPEED_OF_SOUND = 343;

const FOOTSTEP_IDS: Record<SurfaceMaterial, SoundId> = {
  [SurfaceMaterial.Teak]: 'footstep_teak',
  [SurfaceMaterial.Metal]: 'footstep_metal',
  [SurfaceMaterial.Glass]: 'footstep_glass',
  [SurfaceMaterial.Composite]: 'footstep_composite',
  [SurfaceMaterial.Fabric]: 'footstep_fabric',
  [SurfaceMaterial.Water]: 'footstep_water',
};

const IMPACT_IDS: Record<SurfaceMaterial, SoundId> = {
  [SurfaceMaterial.Teak]: 'impact_teak',
  [SurfaceMaterial.Metal]: 'impact_metal',
  [SurfaceMaterial.Glass]: 'impact_glass',
  [SurfaceMaterial.Composite]: 'impact_composite',
  [SurfaceMaterial.Fabric]: 'impact_fabric',
  [SurfaceMaterial.Water]: 'impact_water',
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private synth: SynthCtx | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private reverb: ConvolverNode | null = null;
  private ambient = new AmbientBed();
  private masterVolume = 0.8;
  private activePlays = 0;
  private listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private gestureArmed = false;
  private initPromise: Promise<void> | null = null;

  // Heartbeat state
  private lowHealth = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private nextBeatAt = 0;

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().catch(() => {
      // Audio must never take the game down. Stay silent instead.
      this.ctx = null;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.synth = createSynthCtx(ctx);

    // Graph: plays -> master -> compressor -> destination
    //        plays -> reverb send -> convolver -> master
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    master.connect(comp).connect(ctx.destination);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulseResponse(ctx, 1.4, 3.2);
    const reverbGain = ctx.createGain();
    reverbGain.gain.value = 0.5;
    reverb.connect(reverbGain).connect(master);
    this.master = master;
    this.compressor = comp;
    this.reverb = reverb;

    if (ctx.state !== 'running') {
      this.armGestureResume();
      try {
        await ctx.resume();
      } catch {
        /* resumes on first gesture instead */
      }
    }
  }

  /** Autoplay policy: resume the context on the first real user gesture. */
  private armGestureResume(): void {
    if (this.gestureArmed || typeof window === 'undefined') return;
    this.gestureArmed = true;
    const resume = (): void => {
      this.ctx?.resume().catch(() => undefined);
      if (this.ctx && this.ctx.state === 'running') {
        window.removeEventListener('pointerdown', resume);
        window.removeEventListener('keydown', resume);
      }
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !!this.synth;
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.03);
    }
  }

  setListener(pos: Vec3, forward: Vec3, up: Vec3): void {
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const l = ctx.listener;
      const t = ctx.currentTime;
      if (l.positionX) {
        // Smooth to avoid zipper noise on fast camera motion.
        const k = 0.015;
        l.positionX.setTargetAtTime(pos.x, t, k);
        l.positionY.setTargetAtTime(pos.y, t, k);
        l.positionZ.setTargetAtTime(pos.z, t, k);
        l.forwardX.setTargetAtTime(forward.x, t, k);
        l.forwardY.setTargetAtTime(forward.y, t, k);
        l.forwardZ.setTargetAtTime(forward.z, t, k);
        l.upX.setTargetAtTime(up.x, t, k);
        l.upY.setTargetAtTime(up.y, t, k);
        l.upZ.setTargetAtTime(up.z, t, k);
      } else {
        // Safari fallback.
        l.setPosition(pos.x, pos.y, pos.z);
        l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    } catch {
      /* never throw from audio */
    }
  }

  /** Per-play bus: [recipe] -> gain -> (panner?) -> master, + reverb send. */
  private makeBus(id: SoundId, opts?: PlayOpts): RecipeIo | null {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.reverb || !this.synth) return null;
    if (ctx.state !== 'running') {
      this.armGestureResume();
      return null;
    }
    if (this.activePlays > 64) return null; // hard safety cap

    const dry = ctx.createGain();
    dry.gain.value = opts?.volume ?? 1;
    let tail: AudioNode = dry;
    if (opts?.position) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 2;
      p.maxDistance = 200;
      p.rolloffFactor = 1;
      const t = ctx.currentTime;
      if (p.positionX) {
        p.positionX.value = opts.position.x;
        p.positionY.value = opts.position.y;
        p.positionZ.value = opts.position.z;
      } else {
        p.setPosition(opts.position.x, opts.position.y, opts.position.z);
      }
      void t;
      dry.connect(p);
      tail = p;
    }
    tail.connect(this.master);

    const wet = ctx.createGain();
    wet.gain.value = reverbSendFor(id) * (opts?.volume ?? 1);
    wet.connect(this.reverb);

    this.activePlays++;
    // Free the bus after the longest recipe could have finished.
    setTimeout(() => {
      this.activePlays--;
      try {
        dry.disconnect();
        tail.disconnect();
        wet.disconnect();
      } catch {
        /* fine */
      }
    }, 5000);
    return { out: dry, wet };
  }

  play(id: SoundId, opts?: PlayOpts): void {
    try {
      const recipe = RECIPES[id];
      if (!recipe || !this.synth || !this.ctx) return;
      const io = this.makeBus(id, opts);
      if (!io) return;
      recipe(this.synth, io, this.ctx.currentTime + 0.005, opts?.pitch ?? 1);
    } catch {
      /* never throw from audio */
    }
  }

  playFootstep(material: SurfaceMaterial, gait: FootstepGait, position?: Vec3): void {
    const vol = gait === 'sprint' ? 0.95 : gait === 'crouch' ? 0.28 : 0.6;
    const pitch = gait === 'sprint' ? 0.94 : gait === 'crouch' ? 1.06 : 1;
    this.play(FOOTSTEP_IDS[material] ?? 'footstep_composite', { position, pitch, volume: vol });
  }

  playImpact(material: SurfaceMaterial, position?: Vec3): void {
    this.play(IMPACT_IDS[material] ?? 'impact_composite', { position });
  }

  /**
   * Bullet flyby with a REAL doppler shift.
   *
   * `from` -> `to` is the shot segment (world space). If the segment passes
   * within `maxDist` (3m) of the listener, a whizz is synthesized whose
   * playback rate follows the physical doppler curve c/(c+v_radial(t)) and
   * whose panner position travels along the actual path — you hear it arrive
   * on one side and leave on the other.
   */
  playWhizz(from: Vec3, to: Vec3, maxDist = 3): void {
    try {
      const ctx = this.ctx;
      if (!ctx || !this.synth || !this.master || ctx.state !== 'running') return;
      const L = this.listenerPos;
      const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
      const segLen = Math.hypot(dx, dy, dz);
      if (segLen < 1e-3) return;
      const ux = dx / segLen, uy = dy / segLen, uz = dz / segLen;
      // Closest approach of the segment to the listener.
      let tSeg = (L.x - from.x) * ux + (L.y - from.y) * uy + (L.z - from.z) * uz;
      tSeg = Math.max(0, Math.min(segLen, tSeg));
      const cx = from.x + ux * tSeg, cy = from.y + uy * tSeg, cz = from.z + uz * tSeg;
      const d = Math.hypot(cx - L.x, cy - L.y, cz - L.z);
      if (d > maxDist || d < 0.05) return;

      // Perceptual flyby: physical speed for the doppler math, stretched
      // window so the ear catches it.
      const v = 320; // m/s
      const half = 14; // meters of path either side of closest approach
      const dur = (half * 2) / v * 3.2; // time-stretched for audibility
      const t0 = ctx.currentTime + 0.01;

      const src = ctx.createBufferSource();
      src.buffer = this.synth.white;
      // Sample the true doppler curve into a value curve.
      const N = 48;
      const curve = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const s = (i / (N - 1)) * 2 - 1; // -1..1 across the flyby
        const x = s * half; // signed distance from closest approach
        const vr = (v * x) / Math.hypot(x, d); // radial velocity (+ = receding)
        curve[i] = SPEED_OF_SOUND / (SPEED_OF_SOUND + vr);
      }
      src.playbackRate.setValueCurveAtTime(curve, t0, dur);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 3000;
      bp.Q.value = 1.4;

      // Loudness envelope ~ 1/distance along the flyby.
      const g = ctx.createGain();
      const gcurve = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const s = (i / (N - 1)) * 2 - 1;
        const dist = Math.hypot(s * half, d);
        gcurve[i] = Math.min(0.5, 1.1 / (1 + dist * dist * 0.12)) * (1 - Math.abs(s) * 0.15);
      }
      g.gain.setValueCurveAtTime(gcurve, t0, dur);

      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 1;
      p.rolloffFactor = 0.6;
      if (p.positionX) {
        p.positionX.setValueAtTime(cx - ux * half, t0);
        p.positionY.setValueAtTime(cy - uy * half, t0);
        p.positionZ.setValueAtTime(cz - uz * half, t0);
        p.positionX.linearRampToValueAtTime(cx + ux * half, t0 + dur);
        p.positionY.linearRampToValueAtTime(cy + uy * half, t0 + dur);
        p.positionZ.linearRampToValueAtTime(cz + uz * half, t0 + dur);
      } else {
        p.setPosition(cx, cy, cz);
      }

      src.connect(bp).connect(g).connect(p).connect(this.master);
      src.start(t0, Math.random() * 1.2, dur + 0.1);
      src.stop(t0 + dur + 0.1);
      setTimeout(() => {
        try {
          p.disconnect();
        } catch {
          /* fine */
        }
      }, (dur + 0.5) * 1000);
    } catch {
      /* never throw from audio */
    }
  }

  /** 0 = healthy (silent), 1 = near death (fast, loud heartbeat). */
  setLowHealth(intensity: number): void {
    this.lowHealth = clamp01(intensity);
    if (this.lowHealth > 0.01 && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.pumpHeartbeat(), 120);
      this.nextBeatAt = 0;
    } else if (this.lowHealth <= 0.01 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private pumpHeartbeat(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now + 0.25 < this.nextBeatAt) return;
    const bpm = 55 + this.lowHealth * 65;
    const t = Math.max(this.nextBeatAt, now + 0.05);
    this.play('heartbeat', { volume: 0.25 + this.lowHealth * 0.75, pitch: 1 });
    this.nextBeatAt = t + 60 / bpm;
  }

  startAmbient(): void {
    if (this.synth && this.master && this.ready) {
      try {
        this.ambient.start(this.synth, this.master);
      } catch {
        /* never throw */
      }
    }
  }

  stopAmbient(): void {
    this.ambient.stop();
  }
}

const engine = new AudioEngine();

/** The contracted audio facade. See INTEGRATION.md. */
export const Audio = {
  init: (): Promise<void> => engine.init(),
  play: (id: SoundId, opts?: PlayOpts): void => engine.play(id, opts),
  setListener: (pos: Vec3, forward: Vec3, up: Vec3): void => engine.setListener(pos, forward, up),
  setMasterVolume: (v: number): void => engine.setMasterVolume(v),

  // --- extras beyond the contract (used by viewmodel / effects / HUD) ---
  /** True once the AudioContext is created and running. */
  isReady: (): boolean => engine.ready,
  playFootstep: (m: SurfaceMaterial, gait: FootstepGait, position?: Vec3): void =>
    engine.playFootstep(m, gait, position),
  playImpact: (m: SurfaceMaterial, position?: Vec3): void => engine.playImpact(m, position),
  /** Doppler flyby if the shot segment passes within 3m of the listener. */
  playWhizz: (from: Vec3, to: Vec3, maxDist?: number): void => engine.playWhizz(from, to, maxDist),
  /** 0 = silent, 1 = near-death heartbeat. */
  setLowHealth: (intensity: number): void => engine.setLowHealth(intensity),
  startAmbient: (): void => engine.startAmbient(),
  stopAmbient: (): void => engine.stopAmbient(),
};
