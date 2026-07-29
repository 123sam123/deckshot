/**
 * DECKSHOT audio — every sound in the game, as a synthesis recipe.
 *
 * A recipe schedules WebAudio nodes onto `out` (the per-play bus that the
 * facade routes through spatialization + reverb) starting at time `t0`.
 * `pitch` is a playback-rate-style multiplier (1 = as authored).
 *
 * Owner: viewmodel-vfx-audio.
 */

import {
  SynthCtx,
  adsr,
  biquad,
  fmClick,
  noiseBurst,
  noiseHit,
  rand,
  slapBack,
  tone,
} from './synth.js';

/**
 * Every playable one-shot sound. (Defined here because the frozen shared
 * contract references `SoundId` but does not declare it.)
 */
export type SoundId =
  // Weapons
  | 'sniper_fire'
  | 'sniper_fire_suppressed'
  | 'pistol_fire'
  | 'pistol_fire_suppressed'
  | 'dryfire'
  | 'bolt_open'
  | 'bolt_back'
  | 'bolt_close'
  | 'mag_out'
  | 'mag_in'
  | 'chamber'
  | 'weapon_swap'
  | 'scope_up'
  | 'scope_down'
  | 'melee_swing'
  | 'casing'
  // Movement
  | 'footstep_teak'
  | 'footstep_metal'
  | 'footstep_glass'
  | 'footstep_composite'
  | 'footstep_fabric'
  | 'footstep_water'
  | 'jump_grunt'
  | 'land_thud'
  | 'slide'
  // Feedback
  | 'hitmarker'
  | 'headshot'
  | 'kill'
  | 'whizz'
  | 'heartbeat'
  // Impacts
  | 'impact_teak'
  | 'impact_metal'
  | 'impact_glass'
  | 'impact_composite'
  | 'impact_fabric'
  | 'impact_water'
  // UI / match
  | 'ui_click'
  | 'ui_hover'
  | 'match_horn';

export interface RecipeIo {
  /** Dry per-play bus (already spatialized downstream). */
  out: AudioNode;
  /** Reverb send for this play. Recipes push their "big" components here. */
  wet: AudioNode;
}

type Recipe = (s: SynthCtx, io: RecipeIo, t0: number, pitch: number) => void;

// ---------------------------------------------------------------------------
// Gunshots
// ---------------------------------------------------------------------------

function sniperFire(s: SynthCtx, io: RecipeIo, t0: number, pitch: number): void {
  const ctx = s.ctx;
  // Mix bus so the slap-back can tap the whole shot.
  const bus = ctx.createGain();
  bus.connect(io.out);
  bus.connect(io.wet);

  // 1. Crack — supersonic transient. 6ms of bright noise, brick-wall fast.
  noiseHit(s, bus, t0, {
    type: 'highpass', freq: 2600 * pitch, q: 0.7,
    peak: 1.0, attack: 0.001, hold: 0.004, release: 0.03,
  });
  // 2. Muzzle blast body — bandpassed roar sweeping down.
  noiseHit(s, bus, t0 + 0.004, {
    type: 'lowpass', freq: 5200 * pitch, freqEnd: 320, q: 0.6,
    peak: 0.9, attack: 0.002, hold: 0.02, release: 0.28,
  });
  // 3. Boom — the chest-thump fundamental.
  tone(ctx, bus, t0 + 0.005, {
    type: 'sine', freq: 150 * pitch, freqEnd: 42, glide: 0.32,
    peak: 0.95, attack: 0.004, hold: 0.02, release: 0.34,
  });
  // 4. Long tail — dark noise wash.
  noiseHit(s, bus, t0 + 0.03, {
    pink: true, type: 'lowpass', freq: 1400, freqEnd: 220, q: 0.4,
    peak: 0.32, attack: 0.02, hold: 0.1, release: 1.1,
  });
  // 5. Slap-back off the water, ~190ms later, darker and quieter.
  slapBack(ctx, bus, io.out, 0.19, 0.28, 800);
  slapBack(ctx, bus, io.out, 0.34, 0.12, 500);
}

function sniperSuppressed(s: SynthCtx, io: RecipeIo, t0: number, pitch: number): void {
  const ctx = s.ctx;
  // Muffled thump: no crack, short dark body, mechanical action audible.
  noiseHit(s, io.out, t0, {
    type: 'lowpass', freq: 1500 * pitch, freqEnd: 260, q: 0.7,
    peak: 0.55, attack: 0.002, hold: 0.012, release: 0.16,
  });
  tone(ctx, io.out, t0 + 0.003, {
    type: 'sine', freq: 120 * pitch, freqEnd: 48, glide: 0.18,
    peak: 0.5, attack: 0.003, hold: 0.01, release: 0.2,
  });
  fmClick(ctx, io.out, t0 + 0.012, { freq: 1900, hardness: 1.6, peak: 0.14, release: 0.03 });
  noiseHit(s, io.wet, t0 + 0.02, {
    pink: true, type: 'lowpass', freq: 700, freqEnd: 180, q: 0.4,
    peak: 0.1, attack: 0.01, hold: 0.03, release: 0.4,
  });
}

function pistolFire(s: SynthCtx, io: RecipeIo, t0: number, pitch: number): void {
  const ctx = s.ctx;
  const bus = ctx.createGain();
  bus.connect(io.out);
  bus.connect(io.wet);
  noiseHit(s, bus, t0, {
    type: 'highpass', freq: 2100 * pitch, q: 0.7,
    peak: 0.8, attack: 0.001, hold: 0.003, release: 0.025,
  });
  noiseHit(s, bus, t0 + 0.002, {
    type: 'lowpass', freq: 4200 * pitch, freqEnd: 380, q: 0.6,
    peak: 0.7, attack: 0.002, hold: 0.01, release: 0.14,
  });
  tone(ctx, bus, t0 + 0.004, {
    type: 'triangle', freq: 190 * pitch, freqEnd: 70, glide: 0.14,
    peak: 0.55, attack: 0.003, hold: 0.008, release: 0.16,
  });
  // Slide cycling — snappy double click right after the shot.
  fmClick(ctx, io.out, t0 + 0.045, { freq: 2300, hardness: 2.0, peak: 0.12, release: 0.025 });
  fmClick(ctx, io.out, t0 + 0.085, { freq: 1700, hardness: 2.4, peak: 0.1, release: 0.03 });
}

function pistolSuppressed(s: SynthCtx, io: RecipeIo, t0: number, pitch: number): void {
  const ctx = s.ctx;
  noiseHit(s, io.out, t0, {
    type: 'lowpass', freq: 1300 * pitch, freqEnd: 300, q: 0.7,
    peak: 0.45, attack: 0.001, hold: 0.008, release: 0.09,
  });
  tone(ctx, io.out, t0 + 0.003, {
    type: 'sine', freq: 150 * pitch, freqEnd: 60, glide: 0.1,
    peak: 0.35, attack: 0.002, hold: 0.006, release: 0.12,
  });
  fmClick(ctx, io.out, t0 + 0.04, { freq: 2100, hardness: 1.8, peak: 0.1, release: 0.025 });
}

// ---------------------------------------------------------------------------
// Weapon handling
// ---------------------------------------------------------------------------

const boltOpen: Recipe = (s, io, t0, pitch) => {
  fmClick(s.ctx, io.out, t0, { freq: 1500 * pitch, hardness: 3.0, peak: 0.4, release: 0.04 });
  fmClick(s.ctx, io.out, t0 + 0.03, { freq: 2200 * pitch, hardness: 1.6, peak: 0.18, release: 0.03 });
};

const boltBack: Recipe = (s, io, t0, pitch) => {
  // Sliding steel: short filtered noise scrape + stop click.
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 2600 * pitch, q: 2.5,
    peak: 0.16, attack: 0.005, hold: 0.05, release: 0.05,
  });
  fmClick(s.ctx, io.out, t0 + 0.07, { freq: 1100 * pitch, hardness: 2.6, peak: 0.3, release: 0.045 });
};

const boltClose: Recipe = (s, io, t0, pitch) => {
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 2200 * pitch, q: 2.5,
    peak: 0.14, attack: 0.004, hold: 0.04, release: 0.04,
  });
  fmClick(s.ctx, io.out, t0 + 0.055, { freq: 900 * pitch, hardness: 3.4, peak: 0.5, release: 0.06 });
  // Lug lock-down thunk.
  tone(s.ctx, io.out, t0 + 0.06, {
    type: 'sine', freq: 210, freqEnd: 90, glide: 0.06,
    peak: 0.22, attack: 0.002, hold: 0, release: 0.08,
  });
};

const magOut: Recipe = (s, io, t0, pitch) => {
  fmClick(s.ctx, io.out, t0, { freq: 800 * pitch, hardness: 2.2, peak: 0.3, release: 0.05 });
  noiseHit(s, io.out, t0 + 0.02, {
    pink: true, type: 'lowpass', freq: 900, q: 0.7,
    peak: 0.12, attack: 0.01, hold: 0.03, release: 0.08,
  });
};

const magIn: Recipe = (s, io, t0, pitch) => {
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 1600 * pitch, q: 2,
    peak: 0.1, attack: 0.004, hold: 0.02, release: 0.04,
  });
  fmClick(s.ctx, io.out, t0 + 0.05, { freq: 1050 * pitch, hardness: 3.2, peak: 0.45, release: 0.055 });
  tone(s.ctx, io.out, t0 + 0.052, {
    type: 'sine', freq: 190, freqEnd: 85, glide: 0.05,
    peak: 0.18, attack: 0.002, hold: 0, release: 0.07,
  });
};

const chamber: Recipe = (s, io, t0, pitch) => {
  boltBack(s, io, t0, pitch);
  boltClose(s, io, t0 + 0.13, pitch);
};

const weaponSwap: Recipe = (s, io, t0, pitch) => {
  noiseHit(s, io.out, t0, {
    pink: true, type: 'lowpass', freq: 1100, q: 0.6,
    peak: 0.14, attack: 0.01, hold: 0.04, release: 0.1,
  });
  fmClick(s.ctx, io.out, t0 + 0.08, { freq: 1300 * pitch, hardness: 2.2, peak: 0.22, release: 0.04 });
};

const scopeUp: Recipe = (s, io, t0, pitch) => {
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 1900 * pitch, q: 3,
    peak: 0.07, attack: 0.01, hold: 0.03, release: 0.06,
  });
  fmClick(s.ctx, io.out, t0 + 0.05, { freq: 2600 * pitch, hardness: 1.2, peak: 0.08, release: 0.02 });
};

const scopeDown: Recipe = (s, io, t0, pitch) => {
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 1400 * pitch, q: 3,
    peak: 0.06, attack: 0.008, hold: 0.02, release: 0.05,
  });
};

const dryfire: Recipe = (s, io, t0, pitch) => {
  fmClick(s.ctx, io.out, t0, { freq: 2000 * pitch, hardness: 2.8, peak: 0.3, release: 0.03 });
};

const meleeSwing: Recipe = (s, io, t0, pitch) => {
  // Air whoosh: bandpass noise with a rising-then-falling center frequency.
  const ctx = s.ctx;
  const src = noiseBurst(s, true);
  const f = biquad(ctx, 'bandpass', 500 * pitch, 1.6);
  f.frequency.setValueAtTime(400 * pitch, t0);
  f.frequency.exponentialRampToValueAtTime(1600 * pitch, t0 + 0.12);
  f.frequency.exponentialRampToValueAtTime(500 * pitch, t0 + 0.24);
  const g = adsr(ctx, t0, 0.28, 0.06, 0.05, 0.12);
  src.connect(f).connect(g).connect(io.out);
  src.start(t0, Math.random(), 0.3);
  src.stop(t0 + 0.3);
};

const casing: Recipe = (s, io, t0, pitch) => {
  // Brass tinkle: two tiny detuned metallic pings.
  const f = 4200 * pitch * rand(0.92, 1.08);
  tone(s.ctx, io.out, t0, { type: 'sine', freq: f, freqEnd: f * 0.96, glide: 0.08, peak: 0.06, attack: 0.001, hold: 0, release: 0.09 });
  tone(s.ctx, io.out, t0 + rand(0.04, 0.08), { type: 'sine', freq: f * 1.34, freqEnd: f * 1.3, glide: 0.06, peak: 0.04, attack: 0.001, hold: 0, release: 0.07 });
};

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

const footTeak: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.9, 1.1);
  noiseHit(s, io.out, t0, {
    pink: true, type: 'bandpass', freq: 240 * p, q: 1.1,
    peak: 0.5, attack: 0.003, hold: 0.008, release: 0.07,
  });
  // Woody knock partial.
  tone(s.ctx, io.out, t0, { type: 'triangle', freq: 190 * p, freqEnd: 110 * p, glide: 0.05, peak: 0.16, attack: 0.002, hold: 0, release: 0.06 });
};

const footMetal: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.93, 1.07);
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 900 * p, q: 1.4,
    peak: 0.4, attack: 0.002, hold: 0.006, release: 0.05,
  });
  // Damped catwalk ring.
  tone(s.ctx, io.out, t0 + 0.004, { type: 'sine', freq: 620 * p, freqEnd: 560 * p, glide: 0.16, peak: 0.1, attack: 0.002, hold: 0, release: 0.18 });
  tone(s.ctx, io.out, t0 + 0.004, { type: 'sine', freq: 1490 * p, freqEnd: 1400 * p, glide: 0.1, peak: 0.045, attack: 0.001, hold: 0, release: 0.12 });
};

const footGlass: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.95, 1.05);
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 1500 * p, q: 2,
    peak: 0.28, attack: 0.002, hold: 0.004, release: 0.045,
  });
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 2400 * p, peak: 0.05, attack: 0.001, hold: 0, release: 0.08 });
};

const footComposite: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.9, 1.1);
  noiseHit(s, io.out, t0, {
    pink: true, type: 'lowpass', freq: 500 * p, q: 0.8,
    peak: 0.45, attack: 0.003, hold: 0.008, release: 0.06,
  });
};

const footFabric: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.9, 1.1);
  noiseHit(s, io.out, t0, {
    pink: true, type: 'lowpass', freq: 700 * p, q: 0.5,
    peak: 0.22, attack: 0.008, hold: 0.01, release: 0.08,
  });
};

const footWater: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.9, 1.1);
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 800 * p, freqEnd: 2400 * p, q: 0.9,
    peak: 0.4, attack: 0.006, hold: 0.02, release: 0.16,
  });
};

const jumpGrunt: Recipe = (s, io, t0, pitch) => {
  // A short vocal-ish "hup": formant-filtered saw with pitch bend.
  const ctx = s.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(130 * pitch, t0);
  osc.frequency.exponentialRampToValueAtTime(95 * pitch, t0 + 0.16);
  const f1 = biquad(ctx, 'bandpass', 620, 3.5);
  const f2 = biquad(ctx, 'bandpass', 1100, 4);
  const g = adsr(ctx, t0, 0.16, 0.02, 0.04, 0.1);
  const mix = ctx.createGain();
  osc.connect(f1).connect(mix);
  osc.connect(f2).connect(mix);
  mix.connect(g).connect(io.out);
  osc.start(t0);
  osc.stop(t0 + 0.25);
};

const landThud: Recipe = (s, io, t0, pitch) => {
  tone(s.ctx, io.out, t0, {
    type: 'sine', freq: 160 * pitch, freqEnd: 55, glide: 0.1,
    peak: 0.5, attack: 0.004, hold: 0.01, release: 0.14,
  });
  noiseHit(s, io.out, t0, {
    pink: true, type: 'lowpass', freq: 600, q: 0.7,
    peak: 0.3, attack: 0.003, hold: 0.01, release: 0.08,
  });
};

const slide: Recipe = (s, io, t0, pitch) => {
  noiseHit(s, io.out, t0, {
    pink: true, type: 'bandpass', freq: 480 * pitch, freqEnd: 260, q: 0.9,
    peak: 0.28, attack: 0.03, hold: 0.2, release: 0.25,
  });
};

// ---------------------------------------------------------------------------
// Feedback chimes
// ---------------------------------------------------------------------------

const hitmarker: Recipe = (s, io, t0, pitch) => {
  // Crisp tick — two tight partials, instantly gone.
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 1800 * pitch, peak: 0.22, attack: 0.001, hold: 0.004, release: 0.045 });
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 2700 * pitch, peak: 0.12, attack: 0.001, hold: 0.002, release: 0.03 });
};

const headshot: Recipe = (s, io, t0, pitch) => {
  // Same family as hitmarker, distinctly higher and ringier.
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 2600 * pitch, peak: 0.22, attack: 0.001, hold: 0.004, release: 0.06 });
  tone(s.ctx, io.out, t0 + 0.03, { type: 'sine', freq: 3400 * pitch, peak: 0.14, attack: 0.001, hold: 0.002, release: 0.08 });
};

const kill: Recipe = (s, io, t0, pitch) => {
  // Deeper two-note confirmation with weight. Gold-X sound.
  tone(s.ctx, io.out, t0, { type: 'triangle', freq: 660 * pitch, peak: 0.3, attack: 0.002, hold: 0.02, release: 0.1 });
  tone(s.ctx, io.out, t0 + 0.07, { type: 'triangle', freq: 440 * pitch, peak: 0.34, attack: 0.002, hold: 0.03, release: 0.22 });
  tone(s.ctx, io.wet, t0 + 0.07, { type: 'sine', freq: 220 * pitch, peak: 0.2, attack: 0.004, hold: 0.02, release: 0.3 });
};

const heartbeat: Recipe = (s, io, t0, pitch) => {
  // One lub-dub pair; the facade loops it while health is low.
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 62 * pitch, freqEnd: 40, glide: 0.1, peak: 0.5, attack: 0.01, hold: 0.02, release: 0.12 });
  tone(s.ctx, io.out, t0 + 0.22, { type: 'sine', freq: 55 * pitch, freqEnd: 38, glide: 0.09, peak: 0.36, attack: 0.01, hold: 0.015, release: 0.1 });
};

const whizz: Recipe = (s, io, t0, pitch) => {
  // Generic (non-doppler) whizz — the facade's playWhizz() builds the real
  // doppler flyby; this is the fallback for plain play('whizz').
  const ctx = s.ctx;
  const src = noiseBurst(s);
  src.playbackRate.setValueAtTime(1.5 * pitch, t0);
  src.playbackRate.exponentialRampToValueAtTime(0.7 * pitch, t0 + 0.22);
  const f = biquad(ctx, 'bandpass', 3400, 1.8);
  f.frequency.setValueAtTime(4200 * pitch, t0);
  f.frequency.exponentialRampToValueAtTime(1500 * pitch, t0 + 0.22);
  const g = adsr(ctx, t0, 0.3, 0.05, 0.02, 0.15);
  src.connect(f).connect(g).connect(io.out);
  src.start(t0, Math.random(), 0.3);
  src.stop(t0 + 0.3);
};

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

const impactTeak: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.9, 1.1);
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 800 * p, freqEnd: 250, q: 0.9,
    peak: 0.5, attack: 0.001, hold: 0.008, release: 0.09,
  });
  tone(s.ctx, io.out, t0, { type: 'triangle', freq: 260 * p, freqEnd: 120, glide: 0.07, peak: 0.2, attack: 0.002, hold: 0, release: 0.08 });
  // Splinter scatter.
  noiseHit(s, io.out, t0 + 0.015, { type: 'highpass', freq: 3000, q: 0.7, peak: 0.08, attack: 0.005, hold: 0.02, release: 0.06 });
};

const impactMetal: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.92, 1.08);
  fmClick(s.ctx, io.out, t0, { freq: 2400 * p, hardness: 4, peak: 0.5, release: 0.04 });
  // Ricochet whine — fast descending ping.
  tone(s.ctx, io.out, t0 + 0.01, {
    type: 'sine', freq: 3200 * p, freqEnd: 700 * p, glide: 0.28,
    peak: 0.16, attack: 0.004, hold: 0, release: 0.3,
  });
  tone(s.ctx, io.wet, t0, { type: 'sine', freq: 1180 * p, freqEnd: 1120 * p, glide: 0.2, peak: 0.1, attack: 0.001, hold: 0, release: 0.25 });
};

const impactGlass: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.95, 1.05);
  noiseHit(s, io.out, t0, { type: 'highpass', freq: 3500 * p, q: 0.7, peak: 0.45, attack: 0.001, hold: 0.006, release: 0.12 });
  // Shard partials.
  for (let i = 0; i < 4; i++) {
    const f = rand(2400, 6800) * p;
    tone(s.ctx, io.out, t0 + rand(0.01, 0.12), { type: 'sine', freq: f, freqEnd: f * 0.97, glide: 0.08, peak: 0.05, attack: 0.001, hold: 0, release: rand(0.05, 0.12) });
  }
};

const impactComposite: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.9, 1.1);
  noiseHit(s, io.out, t0, {
    pink: true, type: 'lowpass', freq: 900 * p, freqEnd: 300, q: 0.8,
    peak: 0.42, attack: 0.001, hold: 0.008, release: 0.08,
  });
};

const impactFabric: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.9, 1.1);
  noiseHit(s, io.out, t0, {
    pink: true, type: 'lowpass', freq: 550 * p, q: 0.5,
    peak: 0.3, attack: 0.003, hold: 0.012, release: 0.09,
  });
};

const impactWater: Recipe = (s, io, t0, pitch) => {
  const p = pitch * rand(0.92, 1.08);
  // Bloop: rising resonance…
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 260 * p, freqEnd: 720 * p, glide: 0.09, peak: 0.3, attack: 0.004, hold: 0, release: 0.1 });
  // …plus splash spray.
  noiseHit(s, io.out, t0 + 0.01, {
    type: 'bandpass', freq: 1300 * p, freqEnd: 3400 * p, q: 0.8,
    peak: 0.35, attack: 0.01, hold: 0.04, release: 0.25,
  });
};

// ---------------------------------------------------------------------------
// UI / match
// ---------------------------------------------------------------------------

const uiClick: Recipe = (s, io, t0, pitch) => {
  fmClick(s.ctx, io.out, t0, { freq: 2100 * pitch, hardness: 1.2, peak: 0.14, release: 0.025 });
};

const uiHover: Recipe = (s, io, t0, pitch) => {
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 1400 * pitch, peak: 0.05, attack: 0.004, hold: 0, release: 0.04 });
};

const matchHorn: Recipe = (s, io, t0, pitch) => {
  // Ship's horn: detuned saw stack through a resonant lowpass, long swell.
  const ctx = s.ctx;
  const g = adsr(ctx, t0, 0.4, 0.25, 1.0, 0.7);
  const f = biquad(ctx, 'lowpass', 620, 2.5);
  f.connect(g);
  g.connect(io.out);
  g.connect(io.wet);
  for (const det of [-9, 0, 7, 1204]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 112 * pitch;
    osc.detune.value = det;
    const og = ctx.createGain();
    og.gain.value = det > 100 ? 0.12 : 0.3;
    osc.connect(og).connect(f);
    osc.start(t0);
    osc.stop(t0 + 2.2);
  }
};

// ---------------------------------------------------------------------------

export const RECIPES: Record<SoundId, Recipe> = {
  sniper_fire: sniperFire,
  sniper_fire_suppressed: sniperSuppressed,
  pistol_fire: pistolFire,
  pistol_fire_suppressed: pistolSuppressed,
  dryfire,
  bolt_open: boltOpen,
  bolt_back: boltBack,
  bolt_close: boltClose,
  mag_out: magOut,
  mag_in: magIn,
  chamber,
  weapon_swap: weaponSwap,
  scope_up: scopeUp,
  scope_down: scopeDown,
  melee_swing: meleeSwing,
  casing,
  footstep_teak: footTeak,
  footstep_metal: footMetal,
  footstep_glass: footGlass,
  footstep_composite: footComposite,
  footstep_fabric: footFabric,
  footstep_water: footWater,
  jump_grunt: jumpGrunt,
  land_thud: landThud,
  slide,
  hitmarker,
  headshot,
  kill,
  whizz,
  heartbeat,
  impact_teak: impactTeak,
  impact_metal: impactMetal,
  impact_glass: impactGlass,
  impact_composite: impactComposite,
  impact_fabric: impactFabric,
  impact_water: impactWater,
  ui_click: uiClick,
  ui_hover: uiHover,
  match_horn: matchHorn,
};

/** Reverb send level per sound family (0 = fully dry). */
export function reverbSendFor(id: SoundId): number {
  if (id.startsWith('sniper') || id.startsWith('pistol')) return 0.35;
  if (id.startsWith('impact')) return 0.18;
  if (id === 'match_horn' || id === 'kill') return 0.3;
  if (id.startsWith('footstep') || id.startsWith('ui')) return 0.04;
  return 0.1;
}
