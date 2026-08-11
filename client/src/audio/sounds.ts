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
  | 'match_horn'
  // Zombies — the undead
  | 'zombie_groan'
  | 'zombie_attack'
  | 'zombie_die'
  | 'zombie_spawn'
  // Zombies — round stingers
  | 'round_start'
  | 'round_end'
  | 'fog_round'
  // Zombies — powerups
  | 'powerup_spawn'
  | 'powerup_pickup'
  | 'powerup_expire'
  // Zombies — economy / barriers
  | 'buy'
  | 'buy_denied'
  | 'perk_jingle'
  | 'door_open'
  | 'plank_tear'
  | 'plank_repair'
  // Zombies — mystery box / forge
  | 'box_spin'
  | 'box_offer'
  | 'forge_upgrade'
  // Zombies — player state
  | 'revive_ok'
  | 'downed_sting';

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
// Zombies — the undead
// ---------------------------------------------------------------------------

const zombieGroan: Recipe = (s, io, t0, pitch) => {
  // Guttural moan. Plays positionally and near-constantly, so it stays
  // under-stated and leans on `pitch` (set per-zombie) for variety.
  const ctx = s.ctx;
  const p = pitch * rand(0.94, 1.06);
  const dur = rand(0.8, 1.4) / Math.sqrt(p); // playback-rate feel: lower = longer
  const f0 = rand(55, 90) * p;

  // Throat: detuned saw/triangle pair, sagging as the breath runs out,
  // behind a lowpass that slowly opens — the mouth — then shuts.
  const lp = biquad(ctx, 'lowpass', 150, 1.5);
  lp.frequency.setValueAtTime(140, t0);
  lp.frequency.exponentialRampToValueAtTime(560 * p, t0 + dur * 0.55);
  lp.frequency.exponentialRampToValueAtTime(180, t0 + dur);

  // ~6Hz amplitude wobble — the "uh-uh-uh" inside the moan.
  const wob = ctx.createGain();
  wob.gain.value = 0.78;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = rand(5.2, 6.8);
  const depth = ctx.createGain();
  depth.gain.value = 0.22;
  lfo.connect(depth).connect(wob.gain);

  const env = adsr(ctx, t0, 0.22, dur * 0.3, dur * 0.3, dur * 0.4);
  lp.connect(wob).connect(env);
  env.connect(io.out);
  env.connect(io.wet);

  for (const [type, ratio, det, lvl] of [
    ['sawtooth', 1, -8, 0.5],
    ['triangle', 1.012, 11, 0.7],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0 * ratio, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * ratio * 0.82, t0 + dur);
    osc.detune.value = det;
    const og = ctx.createGain();
    og.gain.value = lvl;
    osc.connect(og).connect(lp);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
  lfo.start(t0);
  lfo.stop(t0 + dur + 0.05);

  // A little growl grit under the tone.
  noiseHit(s, io.out, t0 + dur * 0.15, {
    pink: true, type: 'bandpass', freq: 300 * p, q: 1.2,
    peak: 0.05, attack: dur * 0.2, hold: dur * 0.25, release: dur * 0.35,
  });
};

const zombieAttack: Recipe = (s, io, t0, pitch) => {
  // Snarl — jumpGrunt's angrier cousin: hard formant bark, pitch dropping.
  const ctx = s.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(165 * pitch, t0);
  osc.frequency.exponentialRampToValueAtTime(95 * pitch, t0 + 0.2);
  const f1 = biquad(ctx, 'bandpass', 540, 2.5);
  const f2 = biquad(ctx, 'bandpass', 1350, 3);
  const g = adsr(ctx, t0, 0.32, 0.008, 0.06, 0.14);
  const mix = ctx.createGain();
  osc.connect(f1).connect(mix);
  osc.connect(f2).connect(mix);
  mix.connect(g).connect(io.out);
  osc.start(t0);
  osc.stop(t0 + 0.25);
  // Claw swipe: bandpassed noise sweeping down past the ear.
  noiseHit(s, io.out, t0 + 0.02, {
    type: 'bandpass', freq: 2600 * pitch, freqEnd: 500, q: 1.6,
    peak: 0.26, attack: 0.02, hold: 0.03, release: 0.16,
  });
};

const zombieDie: Recipe = (s, io, t0, pitch) => {
  // Choked gurgle collapse: the voice drops out, fluids take over.
  const ctx = s.ctx;
  tone(ctx, io.out, t0, {
    type: 'sawtooth', freq: 140 * pitch, freqEnd: 42, glide: 0.38,
    peak: 0.2, attack: 0.006, hold: 0.04, release: 0.36,
  });
  // Two wet bloops on the way down.
  tone(ctx, io.out, t0 + 0.1, { type: 'sine', freq: 340 * pitch, freqEnd: 150, glide: 0.09, peak: 0.12, attack: 0.004, hold: 0, release: 0.09 });
  tone(ctx, io.out, t0 + 0.24, { type: 'sine', freq: 260 * pitch, freqEnd: 110, glide: 0.08, peak: 0.1, attack: 0.004, hold: 0, release: 0.08 });
  // Splat + the body hitting the deck.
  noiseHit(s, io.out, t0 + 0.02, {
    pink: true, type: 'lowpass', freq: 1100 * pitch, freqEnd: 220, q: 0.7,
    peak: 0.3, attack: 0.004, hold: 0.02, release: 0.3,
  });
  tone(ctx, io.wet, t0 + 0.3, { type: 'sine', freq: 110 * pitch, freqEnd: 45, glide: 0.1, peak: 0.28, attack: 0.005, hold: 0.01, release: 0.16 });
};

const zombieSpawn: Recipe = (s, io, t0, pitch) => {
  // Wet emergence — kept subtle; the groan that follows does the announcing.
  noiseHit(s, io.out, t0, {
    type: 'bandpass', freq: 700 * pitch, freqEnd: 2000 * pitch, q: 0.9,
    peak: 0.18, attack: 0.03, hold: 0.05, release: 0.2,
  });
  // Boards straining as something pushes through.
  noiseHit(s, io.out, t0 + 0.04, {
    pink: true, type: 'bandpass', freq: 260 * pitch, q: 3.5,
    peak: 0.1, attack: 0.05, hold: 0.08, release: 0.14,
  });
  tone(s.ctx, io.out, t0 + 0.06, {
    type: 'triangle', freq: 150 * pitch, freqEnd: 95, glide: 0.2,
    peak: 0.08, attack: 0.04, hold: 0.05, release: 0.18,
  });
};

// ---------------------------------------------------------------------------
// Zombies — round stingers
// ---------------------------------------------------------------------------

const roundStart: Recipe = (s, io, t0, pitch) => {
  // The mode's signature: a low minor swell — dread, not fanfare.
  const ctx = s.ctx;
  // Sub thump at the head.
  tone(ctx, io.out, t0, {
    type: 'sine', freq: 100 * pitch, freqEnd: 36, glide: 0.28,
    peak: 0.55, attack: 0.004, hold: 0.02, release: 0.4,
  });
  // Brass-ish stack: root / minor third / fifth saws through a slow lowpass.
  const f = biquad(ctx, 'lowpass', 220, 1.6);
  f.frequency.setValueAtTime(200, t0);
  f.frequency.exponentialRampToValueAtTime(1250, t0 + 1.0);
  f.frequency.exponentialRampToValueAtTime(300, t0 + 1.6);
  const g = adsr(ctx, t0, 0.32, 0.55, 0.45, 0.6);
  f.connect(g);
  g.connect(io.out);
  g.connect(io.wet);
  const f0 = 82.4 * pitch; // E2 — the mode's home key
  for (const [ratio, det, lvl] of [
    [1, -6, 0.3], [1, 7, 0.3], [1.1892, -4, 0.22], [1.4983, 5, 0.2], [2, 10, 0.09],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f0 * ratio;
    osc.detune.value = det;
    const og = ctx.createGain();
    og.gain.value = lvl;
    osc.connect(og).connect(f);
    osc.start(t0);
    osc.stop(t0 + 1.7);
  }
};

const roundEnd: Recipe = (s, io, t0, pitch) => {
  // Brighter resolution — the survivors get a quiet lift, nothing more.
  const ctx = s.ctx;
  const f0 = 220 * pitch; // A3
  tone(ctx, io.out, t0, { type: 'triangle', freq: f0, peak: 0.12, attack: 0.02, hold: 0.1, release: 0.5 });
  tone(ctx, io.out, t0 + 0.16, { type: 'triangle', freq: f0 * 1.5, peak: 0.11, attack: 0.02, hold: 0.1, release: 0.5 });
  tone(ctx, io.out, t0 + 0.32, { type: 'triangle', freq: f0 * 2, peak: 0.1, attack: 0.02, hold: 0.12, release: 0.6 });
  // Airy sheen on top, mostly for the reverb tail.
  tone(ctx, io.wet, t0 + 0.32, { type: 'sine', freq: f0 * 4, peak: 0.05, attack: 0.05, hold: 0.1, release: 0.6 });
};

const fogRound: Recipe = (s, io, t0, pitch) => {
  // Blood Fog: a held minor second — two drones a semitone apart, beating.
  const ctx = s.ctx;
  const f = biquad(ctx, 'lowpass', 900, 1.2);
  f.frequency.setValueAtTime(500, t0);
  f.frequency.exponentialRampToValueAtTime(1600, t0 + 1.2);
  f.frequency.exponentialRampToValueAtTime(400, t0 + 2.0);
  const g = adsr(ctx, t0, 0.26, 0.8, 0.5, 0.7);
  f.connect(g);
  g.connect(io.out);
  g.connect(io.wet);
  const f0 = 110 * pitch; // A2 against Bb2 — the wrongness is the point
  for (const [type, ratio, lvl] of [
    ['sawtooth', 1, 0.3],
    ['sawtooth', 1.0595, 0.26],
    ['sine', 4, 0.06], // high shimmer pair, same semitone clash
    ['sine', 4.238, 0.06],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = f0 * ratio;
    const og = ctx.createGain();
    og.gain.value = lvl;
    osc.connect(og).connect(f);
    osc.start(t0);
    osc.stop(t0 + 2.1);
  }
  // Cold air underneath.
  noiseHit(s, io.wet, t0, {
    pink: true, type: 'lowpass', freq: 500, q: 0.5,
    peak: 0.08, attack: 0.6, hold: 0.6, release: 0.8,
  });
};

// ---------------------------------------------------------------------------
// Zombies — powerups
// ---------------------------------------------------------------------------

const powerupSpawn: Recipe = (s, io, t0, pitch) => {
  // Soft magical shimmer: a sine cluster drifting slightly sharp.
  const ctx = s.ctx;
  const bus = ctx.createGain();
  bus.connect(io.out);
  bus.connect(io.wet);
  for (const [ratio, lvl] of [[1, 0.06], [1.5, 0.05], [2.02, 0.04], [3.01, 0.03]] as const) {
    const f = 880 * pitch * ratio;
    tone(ctx, bus, t0, { type: 'sine', freq: f, freqEnd: f * 1.02, glide: 0.5, peak: lvl, attack: 0.12, hold: 0.15, release: 0.3 });
  }
  // Sparkle dust.
  noiseHit(s, bus, t0, { type: 'highpass', freq: 6000, q: 0.7, peak: 0.04, attack: 0.1, hold: 0.15, release: 0.3 });
};

const powerupPickup: Recipe = (s, io, t0, pitch) => {
  // Punchy uplift: three rising notes, each doubled an octave up.
  const ctx = s.ctx;
  const f0 = 523 * pitch; // C5
  const steps = [1, 1.3348, 2]; // root -> fourth -> octave
  for (let i = 0; i < 3; i++) {
    const t = t0 + i * 0.09;
    tone(ctx, io.out, t, { type: 'triangle', freq: f0 * steps[i], peak: 0.24, attack: 0.002, hold: 0.02, release: 0.12 });
    tone(ctx, io.out, t, { type: 'sine', freq: f0 * steps[i] * 2, peak: 0.08, attack: 0.002, hold: 0.01, release: 0.1 });
  }
  // The last note rings into the verb.
  tone(ctx, io.wet, t0 + 0.18, { type: 'sine', freq: f0 * 2, peak: 0.1, attack: 0.002, hold: 0.02, release: 0.25 });
};

const powerupExpire: Recipe = (s, io, t0, pitch) => {
  // The pickup arpeggio backwards, an octave darker, each note sagging flat.
  const ctx = s.ctx;
  const f0 = 262 * pitch;
  const steps = [2, 1.3348, 1];
  for (let i = 0; i < 3; i++) {
    const f = f0 * steps[i];
    tone(ctx, io.out, t0 + i * 0.11, {
      type: 'triangle', freq: f, freqEnd: f * 0.94, glide: 0.12,
      peak: 0.16, attack: 0.004, hold: 0.02, release: 0.14,
    });
  }
};

// ---------------------------------------------------------------------------
// Zombies — economy / barriers
// ---------------------------------------------------------------------------

const buy: Recipe = (s, io, t0, pitch) => {
  // Cash-register thunk…
  fmClick(s.ctx, io.out, t0, { freq: 640 * pitch, hardness: 3.2, peak: 0.4, release: 0.05 });
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 200 * pitch, freqEnd: 85, glide: 0.06, peak: 0.22, attack: 0.002, hold: 0, release: 0.08 });
  // …then the drawer latch.
  fmClick(s.ctx, io.out, t0 + 0.08, { freq: 2500 * pitch, hardness: 1.8, peak: 0.16, release: 0.03 });
  tone(s.ctx, io.out, t0 + 0.08, { type: 'sine', freq: 3150 * pitch, peak: 0.05, attack: 0.001, hold: 0, release: 0.07 });
};

const buyDenied: Recipe = (s, io, t0, pitch) => {
  // Dull "no": two square buzzes stepping down, kept dark by a lowpass.
  const ctx = s.ctx;
  const f = biquad(ctx, 'lowpass', 600, 0.7);
  f.connect(io.out);
  tone(ctx, f, t0, { type: 'square', freq: 220 * pitch, peak: 0.16, attack: 0.004, hold: 0.05, release: 0.04 });
  tone(ctx, f, t0 + 0.1, { type: 'square', freq: 165 * pitch, peak: 0.16, attack: 0.004, hold: 0.05, release: 0.05 });
};

const perkJingle: Recipe = (s, io, t0, pitch) => {
  // One generic 4-note jingle for every machine — slightly detuned, like
  // it's been playing off the same worn speaker for years.
  const ctx = s.ctx;
  const f0 = 330 * pitch; // E4
  const steps = [1, 1.1892, 1.3348, 2]; // minor arpeggio walk-up
  for (let i = 0; i < 4; i++) {
    const t = t0 + i * 0.18;
    const f = f0 * steps[i];
    const rel = i === 3 ? 0.35 : 0.16;
    tone(ctx, io.out, t, { type: 'triangle', freq: f, peak: 0.15, attack: 0.006, hold: 0.05, release: rel, detune: rand(-9, 9) });
    tone(ctx, io.out, t, { type: 'square', freq: f * 0.5, peak: 0.05, attack: 0.006, hold: 0.05, release: rel, detune: rand(-9, 9) });
  }
  // Last note into the verb.
  tone(ctx, io.wet, t0 + 0.54, { type: 'triangle', freq: f0 * 2, peak: 0.08, attack: 0.006, hold: 0.05, release: 0.4 });
};

const doorOpen: Recipe = (s, io, t0, pitch) => {
  // Heavy hinge groan: a slow saw through a resonant, wandering bandpass.
  const ctx = s.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(56 * pitch, t0);
  osc.frequency.exponentialRampToValueAtTime(74 * pitch, t0 + 0.5);
  const f = biquad(ctx, 'bandpass', 300, 6);
  f.frequency.setValueAtTime(260, t0);
  f.frequency.exponentialRampToValueAtTime(540, t0 + 0.35);
  f.frequency.exponentialRampToValueAtTime(310, t0 + 0.6);
  const g = adsr(ctx, t0, 0.3, 0.08, 0.32, 0.25);
  osc.connect(f).connect(g);
  g.connect(io.out);
  g.connect(io.wet);
  osc.start(t0);
  osc.stop(t0 + 0.7);
  // Debris scraping off the frame.
  noiseHit(s, io.out, t0 + 0.05, {
    pink: true, type: 'bandpass', freq: 1100 * pitch, freqEnd: 450, q: 1.4,
    peak: 0.14, attack: 0.06, hold: 0.2, release: 0.25,
  });
  // It settles with a clunk.
  fmClick(ctx, io.out, t0 + 0.55, { freq: 700 * pitch, hardness: 2.8, peak: 0.3, release: 0.06 });
};

const plankTear: Recipe = (s, io, t0, pitch) => {
  // Nails wrench out — strain rising…
  noiseHit(s, io.out, t0, {
    pink: true, type: 'bandpass', freq: 350 * pitch, freqEnd: 950 * pitch, q: 2.8,
    peak: 0.28, attack: 0.03, hold: 0.08, release: 0.06,
  });
  // …then the snap and splinter scatter.
  fmClick(s.ctx, io.out, t0 + 0.13, { freq: 1400 * pitch, hardness: 3.2, peak: 0.42, release: 0.045 });
  tone(s.ctx, io.out, t0 + 0.13, { type: 'triangle', freq: 240 * pitch, freqEnd: 110, glide: 0.07, peak: 0.2, attack: 0.002, hold: 0, release: 0.09 });
  noiseHit(s, io.out, t0 + 0.15, { type: 'highpass', freq: 3200, q: 0.7, peak: 0.08, attack: 0.004, hold: 0.02, release: 0.07 });
};

const plankRepair: Recipe = (s, io, t0, pitch) => {
  // Two quick hammer knocks…
  for (const dt of [0, 0.12]) {
    const p = pitch * rand(0.96, 1.04);
    noiseHit(s, io.out, t0 + dt, {
      pink: true, type: 'bandpass', freq: 280 * p, q: 1.1,
      peak: 0.4, attack: 0.002, hold: 0.006, release: 0.05,
    });
    tone(s.ctx, io.out, t0 + dt, { type: 'triangle', freq: 200 * p, freqEnd: 115, glide: 0.05, peak: 0.16, attack: 0.002, hold: 0, release: 0.05 });
  }
  // …and the board creaks into place.
  noiseHit(s, io.out, t0 + 0.2, {
    pink: true, type: 'bandpass', freq: 420 * pitch, freqEnd: 620 * pitch, q: 4,
    peak: 0.08, attack: 0.02, hold: 0.03, release: 0.08,
  });
};

// ---------------------------------------------------------------------------
// Zombies — mystery box / forge
// ---------------------------------------------------------------------------

const boxSpin: Recipe = (s, io, t0, pitch) => {
  // Rising minor-third ladder under a fast tremolo — the box deciding.
  const ctx = s.ctx;
  const trem = ctx.createGain();
  trem.gain.value = 0.75;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 8.5;
  const depth = ctx.createGain();
  depth.gain.value = 0.25;
  lfo.connect(depth).connect(trem.gain);
  trem.connect(io.out);
  const wetTap = ctx.createGain();
  wetTap.gain.value = 0.5;
  trem.connect(wetTap).connect(io.wet);
  for (let i = 0; i < 7; i++) {
    const f = 262 * pitch * Math.pow(2, (i * 3) / 12); // diminished climb
    tone(ctx, trem, t0 + i * 0.15, { type: 'triangle', freq: f, peak: 0.13, attack: 0.01, hold: 0.03, release: 0.2 });
  }
  lfo.start(t0);
  lfo.stop(t0 + 1.3);
  // Low anticipation drone underneath.
  tone(ctx, io.out, t0, { type: 'triangle', freq: 65.4 * pitch, peak: 0.1, attack: 0.3, hold: 0.5, release: 0.4 });
};

const boxOffer: Recipe = (s, io, t0, pitch) => {
  // The lid settles and a soft bell says "take it".
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 1320 * pitch, freqEnd: 1310 * pitch, glide: 0.3, peak: 0.12, attack: 0.003, hold: 0.01, release: 0.32 });
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 1980 * pitch, peak: 0.05, attack: 0.003, hold: 0, release: 0.24 });
  tone(s.ctx, io.wet, t0, { type: 'sine', freq: 2640 * pitch, peak: 0.04, attack: 0.01, hold: 0, release: 0.35 });
};

const forgeUpgrade: Recipe = (s, io, t0, pitch) => {
  const ctx = s.ctx;
  // Anvil: hard strike + inharmonic ring.
  fmClick(ctx, io.out, t0, { freq: 2500 * pitch, hardness: 4.5, peak: 0.5, release: 0.05 });
  tone(ctx, io.wet, t0 + 0.005, { type: 'sine', freq: 1180 * pitch, freqEnd: 1130 * pitch, glide: 0.5, peak: 0.12, attack: 0.001, hold: 0, release: 0.55 });
  tone(ctx, io.out, t0 + 0.005, { type: 'sine', freq: 1930 * pitch, freqEnd: 1860 * pitch, glide: 0.4, peak: 0.07, attack: 0.001, hold: 0, release: 0.4 });
  // Molten hiss off the quench.
  noiseHit(s, io.out, t0 + 0.04, {
    type: 'highpass', freq: 3400, q: 0.7,
    peak: 0.12, attack: 0.05, hold: 0.25, release: 0.45,
  });
  // Power-chord bloom: root + fifth saws opening up under the ring.
  const f = biquad(ctx, 'lowpass', 300, 1.5);
  f.frequency.setValueAtTime(280, t0 + 0.12);
  f.frequency.exponentialRampToValueAtTime(2000, t0 + 0.7);
  const g = adsr(ctx, t0 + 0.12, 0.22, 0.3, 0.2, 0.35);
  f.connect(g);
  g.connect(io.out);
  g.connect(io.wet);
  const f0 = 110 * pitch;
  for (const [ratio, det] of [[1, -6], [1.5, 5], [2, 8]] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f0 * ratio;
    osc.detune.value = det;
    const og = ctx.createGain();
    og.gain.value = ratio === 2 ? 0.12 : 0.24;
    osc.connect(og).connect(f);
    osc.start(t0 + 0.12);
    osc.stop(t0 + 1.1);
  }
};

// ---------------------------------------------------------------------------
// Zombies — player state
// ---------------------------------------------------------------------------

const reviveOk: Recipe = (s, io, t0, pitch) => {
  // Warm "you're back": two round notes up a fourth, sine an octave under.
  tone(s.ctx, io.out, t0, { type: 'triangle', freq: 392 * pitch, peak: 0.2, attack: 0.008, hold: 0.04, release: 0.16 });
  tone(s.ctx, io.out, t0, { type: 'sine', freq: 196 * pitch, peak: 0.1, attack: 0.008, hold: 0.04, release: 0.16 });
  tone(s.ctx, io.out, t0 + 0.14, { type: 'triangle', freq: 523 * pitch, peak: 0.22, attack: 0.008, hold: 0.05, release: 0.22 });
  tone(s.ctx, io.wet, t0 + 0.14, { type: 'sine', freq: 262 * pitch, peak: 0.1, attack: 0.008, hold: 0.04, release: 0.25 });
};

const downedSting: Recipe = (s, io, t0, pitch) => {
  // Hard dissonant hit — a semitone cluster slammed at once…
  const ctx = s.ctx;
  tone(ctx, io.out, t0, { type: 'sawtooth', freq: 220 * pitch, peak: 0.18, attack: 0.003, hold: 0.05, release: 0.35 });
  tone(ctx, io.out, t0, { type: 'sawtooth', freq: 233 * pitch, peak: 0.18, attack: 0.003, hold: 0.05, release: 0.35 });
  tone(ctx, io.wet, t0, { type: 'sawtooth', freq: 110 * pitch, peak: 0.16, attack: 0.003, hold: 0.05, release: 0.4 });
  noiseHit(s, io.out, t0, {
    type: 'lowpass', freq: 2400 * pitch, freqEnd: 300, q: 0.7,
    peak: 0.35, attack: 0.002, hold: 0.015, release: 0.2,
  });
  // …then the world narrows to a heartbeat.
  tone(ctx, io.out, t0 + 0.35, { type: 'sine', freq: 62 * pitch, freqEnd: 40, glide: 0.1, peak: 0.5, attack: 0.01, hold: 0.02, release: 0.12 });
  tone(ctx, io.out, t0 + 0.57, { type: 'sine', freq: 55 * pitch, freqEnd: 38, glide: 0.09, peak: 0.36, attack: 0.01, hold: 0.015, release: 0.1 });
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
  zombie_groan: zombieGroan,
  zombie_attack: zombieAttack,
  zombie_die: zombieDie,
  zombie_spawn: zombieSpawn,
  round_start: roundStart,
  round_end: roundEnd,
  fog_round: fogRound,
  powerup_spawn: powerupSpawn,
  powerup_pickup: powerupPickup,
  powerup_expire: powerupExpire,
  buy,
  buy_denied: buyDenied,
  perk_jingle: perkJingle,
  door_open: doorOpen,
  plank_tear: plankTear,
  plank_repair: plankRepair,
  box_spin: boxSpin,
  box_offer: boxOffer,
  forge_upgrade: forgeUpgrade,
  revive_ok: reviveOk,
  downed_sting: downedSting,
};

/** Reverb send level per sound family (0 = fully dry). */
export function reverbSendFor(id: SoundId): number {
  if (id.startsWith('sniper') || id.startsWith('pistol')) return 0.35;
  if (id.startsWith('impact')) return 0.18;
  if (id === 'match_horn' || id === 'kill') return 0.3;
  if (id.startsWith('footstep') || id.startsWith('ui')) return 0.04;
  if (id.startsWith('zombie')) return 0.22;
  if (id.startsWith('round') || id === 'fog_round') return 0.3;
  if (id.startsWith('box') || id.startsWith('forge')) return 0.25;
  if (id.startsWith('plank') || id.startsWith('buy') || id.startsWith('perk') || id.startsWith('door')) return 0.12;
  if (id.startsWith('powerup')) return 0.15;
  if (id === 'revive_ok' || id === 'downed_sting') return 0.2;
  return 0.1;
}
