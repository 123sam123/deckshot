/**
 * DECKSHOT — the fixed-step simulation clock.
 *
 * Owner: netcode-core.
 *
 * A variable timestep would make `applyMovement` non-deterministic between the
 * client's prediction and the server's authority, and determinism is the whole
 * contract. So the loop is a fixed 60 Hz accumulator, drift-corrected against
 * the wall clock: the tick schedule is derived from an absolute start time,
 * never from "last time plus 16.6", so a slow timer callback does not
 * permanently shift the simulation behind real time.
 *
 * The other half is the stall clamp. If the process is descheduled for a
 * second — a GC pause, a noisy neighbour on a shared host, a laptop lid — the
 * naive accumulator tries to run 60 catch-up ticks, which takes longer than a
 * frame, which makes the next catch-up bigger. That spiral is how a game
 * server dies. `maxCatchUpTicks` bounds the burst and resyncs the clock,
 * trading a small time skip for a server that is still answering.
 */

import { TICK_MS } from '../../../shared/tuning.js';

export interface FixedLoopOptions {
  /** Ticks per second. Defaults to TICK_RATE. */
  hz?: number;
  /** Max ticks run in one callback before the clock resyncs. */
  maxCatchUpTicks?: number;
  /** Injectable clock, in ms. Defaults to a monotonic process clock. */
  now?: () => number;
  /** Called when the loop had to skip time to avoid a death spiral. */
  onStall?: (skippedMs: number, tick: number) => void;
}

/** Monotonic milliseconds. Immune to NTP steps and daylight saving. */
export function monotonicNow(): number {
  const hr = process.hrtime.bigint();
  return Number(hr) / 1e6;
}

export class FixedLoop {
  readonly stepMs: number;
  private readonly step: (tick: number, nowMs: number) => void;
  private readonly clock: () => number;
  private readonly maxCatchUp: number;
  private readonly onStall: ((skippedMs: number, tick: number) => void) | undefined;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** Absolute time the next tick is due. */
  private nextDue = 0;
  private tickIndex = 0;

  // --- diagnostics --------------------------------------------------------
  private stalls = 0;
  private maxBurst = 0;
  private lastStepMs = 0;

  constructor(step: (tick: number, nowMs: number) => void, opts: FixedLoopOptions = {}) {
    const hz = opts.hz && opts.hz > 0 ? opts.hz : 1000 / TICK_MS;
    this.stepMs = 1000 / hz;
    this.step = step;
    this.clock = opts.now ?? monotonicNow;
    this.maxCatchUp = opts.maxCatchUpTicks ?? 8;
    this.onStall = opts.onStall;
  }

  get tick(): number {
    return this.tickIndex;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Server clock in ms for the tick currently being simulated. */
  get simTimeMs(): number {
    return this.nextDue - this.stepMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextDue = this.clock() + this.stepMs;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Runs every tick due at `nowMs`. Exposed so tests (and any future
   * externally driven loop) can advance the simulation deterministically
   * without a real timer. Returns how many ticks were run.
   */
  advanceTo(nowMs: number): number {
    if (this.nextDue === 0) this.nextDue = nowMs + this.stepMs;
    let ran = 0;
    while (nowMs >= this.nextDue - 1e-9) {
      if (ran >= this.maxCatchUp) {
        // Stall clamp: give up on the backlog rather than spiral.
        const skipped = nowMs - this.nextDue + this.stepMs;
        this.nextDue = nowMs + this.stepMs;
        this.stalls++;
        this.onStall?.(skipped, this.tickIndex);
        break;
      }
      const simTime = this.nextDue;
      this.nextDue += this.stepMs;
      this.tickIndex = (this.tickIndex + 1) >>> 0;
      const t0 = this.clock();
      this.step(this.tickIndex, simTime);
      this.lastStepMs = this.clock() - t0;
      ran++;
    }
    if (ran > this.maxBurst) this.maxBurst = ran;
    return ran;
  }

  private schedule(): void {
    if (!this.running) return;
    // Clamp to the step size. If a caller ever drives advanceTo() with a
    // different clock than `this.clock` (Date.now() vs process.hrtime, say),
    // nextDue lands ~1e12 in the future; setTimeout silently truncates
    // anything over 2^31-1 to 1ms and the loop busy-spins at 1000Hz. Clamping
    // degrades that to "ticks at the normal rate", which is recoverable.
    const delay = Math.min(this.stepMs, Math.max(0, this.nextDue - this.clock()));
    this.timer = setTimeout(this.onTimer, delay);
  }

  private readonly onTimer = (): void => {
    if (!this.running) return;
    this.advanceTo(this.clock());
    this.schedule();
  };

  stats(): { tick: number; stalls: number; maxBurst: number; lastStepMs: number } {
    return {
      tick: this.tickIndex,
      stalls: this.stalls,
      maxBurst: this.maxBurst,
      lastStepMs: this.lastStepMs,
    };
  }
}
