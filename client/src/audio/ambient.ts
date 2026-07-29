/**
 * DECKSHOT audio — ambient bed for the superyacht.
 *
 * Ocean swell, wind, distant gulls, hull creaks. All synthesized loops and
 * scheduled one-shots; starts with the match and runs forever, quietly.
 *
 * Owner: viewmodel-vfx-audio.
 */

import { SynthCtx, adsr, biquad, noiseLoop, rand, tone } from './synth.js';

export class AmbientBed {
  private nodes: AudioNode[] = [];
  private sources: (AudioBufferSourceNode | OscillatorNode)[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private gain: GainNode | null = null;

  start(s: SynthCtx, out: AudioNode): void {
    if (this.running) return;
    this.running = true;
    const ctx = s.ctx;
    const master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(out);
    // Fade the bed in over a few seconds so it never pops.
    master.gain.setTargetAtTime(1.0, ctx.currentTime, 2.0);
    this.gain = master;
    this.nodes.push(master);

    // --- Ocean swell: pink noise through a lowpass whose cutoff breathes. ---
    {
      const src = noiseLoop(s, true, 0.6);
      const lp = biquad(ctx, 'lowpass', 320, 0.4);
      const g = ctx.createGain();
      g.gain.value = 0.16;
      // Two out-of-phase LFOs so the swell never sounds metronomic.
      const lfo1 = ctx.createOscillator();
      lfo1.frequency.value = 0.07;
      const lfo1g = ctx.createGain();
      lfo1g.gain.value = 140;
      lfo1.connect(lfo1g).connect(lp.frequency);
      const lfo2 = ctx.createOscillator();
      lfo2.frequency.value = 0.11;
      const lfo2g = ctx.createGain();
      lfo2g.gain.value = 0.05;
      lfo2.connect(lfo2g).connect(g.gain);
      src.connect(lp).connect(g).connect(master);
      src.start();
      lfo1.start();
      lfo2.start();
      this.sources.push(src, lfo1, lfo2);
      this.nodes.push(lp, g, lfo1g, lfo2g);
    }

    // --- Wind: white noise band, higher and thinner, slowly wandering. ---
    {
      const src = noiseLoop(s, false, 0.85);
      const bp = biquad(ctx, 'bandpass', 700, 0.6);
      const g = ctx.createGain();
      g.gain.value = 0.035;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05;
      const lfog = ctx.createGain();
      lfog.gain.value = 260;
      lfo.connect(lfog).connect(bp.frequency);
      const glfo = ctx.createOscillator();
      glfo.frequency.value = 0.13;
      const glfog = ctx.createGain();
      glfog.gain.value = 0.015;
      glfo.connect(glfog).connect(g.gain);
      src.connect(bp).connect(g).connect(master);
      src.start();
      lfo.start();
      glfo.start();
      this.sources.push(src, lfo, glfo);
      this.nodes.push(bp, g, lfog, glfog);
    }

    // --- Occasional gull cries and hull creaks. ---
    const scheduleGull = (): void => {
      if (!this.running) return;
      this.timers.push(
        setTimeout(() => {
          if (this.running && this.gain) this.gull(s, this.gain);
          scheduleGull();
        }, rand(6000, 16000))
      );
    };
    const scheduleCreak = (): void => {
      if (!this.running) return;
      this.timers.push(
        setTimeout(() => {
          if (this.running && this.gain) this.creak(s, this.gain);
          scheduleCreak();
        }, rand(11000, 26000))
      );
    };
    scheduleGull();
    scheduleCreak();
  }

  private gull(s: SynthCtx, out: AudioNode): void {
    const ctx = s.ctx;
    const t0 = ctx.currentTime + 0.05;
    const syllables = 1 + Math.floor(Math.random() * 3);
    const base = rand(950, 1350);
    for (let i = 0; i < syllables; i++) {
      const t = t0 + i * rand(0.28, 0.4);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * 0.85, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.35, t + 0.07);
      osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.24);
      const f = biquad(ctx, 'bandpass', base * 1.6, 3.5);
      // Distant: quiet, a little reverb-y by nature of the band-limit.
      const g = adsr(ctx, t, rand(0.012, 0.03), 0.03, 0.08, 0.14);
      osc.connect(f).connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.3);
    }
  }

  private creak(s: SynthCtx, out: AudioNode): void {
    const ctx = s.ctx;
    const t0 = ctx.currentTime + 0.05;
    // Slow groaning bend, low and woody.
    const f = rand(70, 130);
    tone(ctx, out, t0, {
      type: 'sawtooth',
      freq: f,
      freqEnd: f * rand(1.15, 1.4),
      glide: rand(0.5, 1.1),
      peak: rand(0.02, 0.045),
      attack: 0.3,
      hold: 0.2,
      release: 0.6,
    });
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.length = 0;
    for (const n of this.nodes) n.disconnect();
    this.nodes.length = 0;
    this.gain = null;
  }
}
