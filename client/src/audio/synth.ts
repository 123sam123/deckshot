/**
 * DECKSHOT audio — low-level synthesis toolkit.
 *
 * Everything the game plays is synthesized here with WebAudio primitives.
 * No audio files are downloaded or shipped. The recipes in sounds.ts build
 * on these helpers: noise buffers, envelopes, filtered bursts, FM clicks
 * and a procedurally generated impulse response for the reverb send.
 *
 * Owner: viewmodel-vfx-audio. Presentation-only — free to use Math.random.
 */

/** Shared synthesis context: the AudioContext plus preallocated noise. */
export interface SynthCtx {
  ctx: AudioContext;
  /** 2s of white noise, looped by sources that need sustained noise. */
  white: AudioBuffer;
  /** 2s of pink(ish) noise — darker, for wind/ocean/soft thuds. */
  pink: AudioBuffer;
}

export function createSynthCtx(ctx: AudioContext): SynthCtx {
  return { ctx, white: makeNoise(ctx, 2, false), pink: makeNoise(ctx, 2, true) };
}

function makeNoise(ctx: AudioContext, seconds: number, pink: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (!pink) {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else {
    // Paul Kellet's economy pink noise approximation.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
  }
  return buf;
}

/**
 * Procedural impulse response: exponentially decaying stereo noise with a
 * short pre-delay and a high-frequency rolloff that steepens over time.
 * Reads as "open deck at sea" rather than "cathedral".
 */
export function makeImpulseResponse(ctx: AudioContext, seconds = 1.4, decay = 3.2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Progressive lowpass: early reflections bright, tail dark.
      const alpha = 0.12 + 0.5 * t;
      lp += alpha * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-decay * t) * (i < 200 ? i / 200 : 1);
    }
  }
  return buf;
}

/** A one-shot noise source (not looped) with optional playback rate. */
export function noiseBurst(s: SynthCtx, pink = false, rate = 1): AudioBufferSourceNode {
  const src = s.ctx.createBufferSource();
  src.buffer = pink ? s.pink : s.white;
  src.playbackRate.value = rate;
  // Random start offset so repeated shots don't phase-align.
  return src;
}

/** A looped noise source for beds. */
export function noiseLoop(s: SynthCtx, pink = false, rate = 1): AudioBufferSourceNode {
  const src = noiseBurst(s, pink, rate);
  src.loop = true;
  return src;
}

/**
 * Gain node with a linear attack and exponential release.
 * Schedules from `t0`; returns the node. Total audible length ~ attack + hold + release.
 */
export function adsr(
  ctx: AudioContext,
  t0: number,
  peak: number,
  attack: number,
  hold: number,
  release: number
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + Math.max(attack, 0.001));
  g.gain.setValueAtTime(peak, t0 + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + Math.max(release, 0.005));
  return g;
}

export function biquad(
  ctx: AudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 1,
  gainDb = 0
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

/**
 * Filtered noise burst: noise -> filter -> ADSR -> out. The workhorse for
 * gunshots, impacts, footsteps and splashes.
 */
export function noiseHit(
  s: SynthCtx,
  out: AudioNode,
  t0: number,
  o: {
    pink?: boolean;
    rate?: number;
    type?: BiquadFilterType;
    freq: number;
    freqEnd?: number;
    q?: number;
    peak: number;
    attack?: number;
    hold?: number;
    release: number;
  }
): void {
  const ctx = s.ctx;
  const src = noiseBurst(s, o.pink, o.rate ?? 1);
  const f = biquad(ctx, o.type ?? 'bandpass', o.freq, o.q ?? 1);
  if (o.freqEnd !== undefined) {
    f.frequency.setValueAtTime(o.freq, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(o.freqEnd, 20), t0 + (o.attack ?? 0.002) + (o.hold ?? 0) + o.release);
  }
  const g = adsr(ctx, t0, o.peak, o.attack ?? 0.002, o.hold ?? 0, o.release);
  src.connect(f).connect(g).connect(out);
  const dur = (o.attack ?? 0.002) + (o.hold ?? 0) + o.release + 0.05;
  src.start(t0, Math.random() * 1.2, dur + 0.1);
  src.stop(t0 + dur);
}

/**
 * A pitched body: oscillator with a pitch envelope and ADSR.
 * Used for booms (sine drop), chimes, grunts, horn partials.
 */
export function tone(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  o: {
    type?: OscillatorType;
    freq: number;
    freqEnd?: number;
    glide?: number;
    peak: number;
    attack?: number;
    hold?: number;
    release: number;
    detune?: number;
  }
): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.detune) osc.detune.value = o.detune;
  if (o.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(o.freqEnd, 12),
      t0 + (o.glide ?? (o.attack ?? 0.002) + (o.hold ?? 0) + o.release)
    );
  }
  const g = adsr(ctx, t0, o.peak, o.attack ?? 0.002, o.hold ?? 0, o.release);
  osc.connect(g).connect(out);
  const dur = (o.attack ?? 0.002) + (o.hold ?? 0) + o.release + 0.05;
  osc.start(t0);
  osc.stop(t0 + dur);
  return osc;
}

/**
 * FM click: a short carrier burst whose frequency is modulated by a fast
 * decaying modulator. Reads as metal-on-metal — bolt lugs, mag catches,
 * trigger resets. `hardness` scales the modulation index.
 */
export function fmClick(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  o: { freq: number; hardness?: number; peak: number; release?: number }
): void {
  const release = o.release ?? 0.045;
  const car = ctx.createOscillator();
  car.type = 'sine';
  car.frequency.value = o.freq;
  const mod = ctx.createOscillator();
  mod.type = 'square';
  mod.frequency.value = o.freq * 2.7;
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(o.freq * (o.hardness ?? 2.5), t0);
  modGain.gain.exponentialRampToValueAtTime(1, t0 + release);
  mod.connect(modGain).connect(car.frequency);
  const g = adsr(ctx, t0, o.peak, 0.001, 0, release);
  car.connect(g).connect(out);
  car.start(t0);
  mod.start(t0);
  car.stop(t0 + release + 0.05);
  mod.stop(t0 + release + 0.05);
}

/** Delayed, darkened copy of a source bus — the sniper's slap-back off the water. */
export function slapBack(
  ctx: AudioContext,
  from: AudioNode,
  out: AudioNode,
  delaySec: number,
  level: number,
  lowpassHz = 900
): void {
  const d = ctx.createDelay(Math.max(1, delaySec + 0.1));
  d.delayTime.value = delaySec;
  const f = biquad(ctx, 'lowpass', lowpassHz, 0.5);
  const g = ctx.createGain();
  g.gain.value = level;
  from.connect(d).connect(f).connect(g).connect(out);
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
