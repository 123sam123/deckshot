/**
 * DECKSHOT — client-side network simulator.
 *
 * Owner: netcode-core.
 *
 * `?netsim=150,2` gives every packet a 150 ms round trip and a 2% chance of
 * being dropped. `?netsim=150,2,30` adds 30 ms of jitter.
 *
 * This exists because netcode that is only ever tested on localhost is netcode
 * that has not been tested. Prediction, reconciliation, interpolation and the
 * extrapolation freeze are all invisible at 0 ms and all obvious at 150 ms, and
 * the difference between "feels instant" and "feels like mud" is decided
 * entirely in that regime. It is a real feature, not a debug toy: it applies
 * symmetrically to sends and receives, it is deterministic given a seed, and it
 * runs in the shipped build so anyone can reproduce a report.
 *
 * The delay is applied as a queue that the client pumps from its own frame
 * loop, so the simulated network advances with the game rather than with a
 * pile of independent `setTimeout`s.
 */

export interface NetSimConfig {
  /** Simulated round-trip time in ms; half is applied in each direction. */
  rttMs: number;
  /** Packet loss, percent, applied independently per direction. */
  lossPct: number;
  /** Uniform jitter in ms added to each one-way delay. */
  jitterMs: number;
  /** Seed for the loss/jitter RNG, so a session is reproducible. */
  seed: number;
}

export const NETSIM_OFF: NetSimConfig = { rttMs: 0, lossPct: 0, jitterMs: 0, seed: 1 };

/**
 * Parses `netsim` out of a query string. Accepts `rtt`, `rtt,loss`,
 * `rtt,loss,jitter` and `rtt,loss,jitter,seed`. Returns null when absent or
 * unparseable — a typo must not silently ship a laggy client.
 */
export function parseNetSim(search: string | undefined | null): NetSimConfig | null {
  if (!search) return null;
  const query = search.startsWith('?') ? search.slice(1) : search;
  let raw: string | null = null;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (decodeURIComponent(part.slice(0, eq)) !== 'netsim') continue;
    raw = decodeURIComponent(part.slice(eq + 1));
  }
  if (raw === null) return null;

  const fields = raw.split(',').map((s) => Number(s.trim()));
  if (fields.length === 0 || !Number.isFinite(fields[0])) return null;

  const cfg: NetSimConfig = {
    rttMs: clamp(fields[0], 0, 5000),
    lossPct: fields.length > 1 && Number.isFinite(fields[1]) ? clamp(fields[1], 0, 100) : 0,
    jitterMs: fields.length > 2 && Number.isFinite(fields[2]) ? clamp(fields[2], 0, 1000) : 0,
    seed: fields.length > 3 && Number.isFinite(fields[3]) ? fields[3] >>> 0 || 1 : 0x9e3779b9,
  };
  return cfg;
}

/** Reads the flag from the browser URL. Returns null outside a browser. */
export function netSimFromLocation(): NetSimConfig | null {
  const loc = (globalThis as { location?: { search?: string } }).location;
  return parseNetSim(loc?.search ?? null);
}

interface Queued {
  dueAt: number;
  deliver: () => void;
  seq: number;
}

/**
 * A one-directional delay line. Two of these make a symmetric link.
 *
 * Ordering is preserved even with jitter: a packet is never delivered before
 * one that was queued earlier. Real networks do reorder, but a simulator that
 * reorders by default makes every other bug look like a reordering bug.
 */
export class DelayLine {
  private readonly queue: Queued[] = [];
  private seed: number;
  private counter = 0;
  private lastDue = 0;

  dropped = 0;
  delivered = 0;

  constructor(
    private readonly cfg: NetSimConfig,
    seed = cfg.seed
  ) {
    this.seed = seed >>> 0 || 1;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Queues a packet, or drops it. Returns false when it was dropped. */
  push(nowMs: number, deliver: () => void): boolean {
    if (this.cfg.lossPct > 0 && this.random() * 100 < this.cfg.lossPct) {
      this.dropped++;
      return false;
    }
    const jitter = this.cfg.jitterMs > 0 ? this.random() * this.cfg.jitterMs : 0;
    let dueAt = nowMs + this.cfg.rttMs / 2 + jitter;
    if (dueAt < this.lastDue) dueAt = this.lastDue;
    this.lastDue = dueAt;
    this.queue.push({ dueAt, deliver, seq: this.counter++ });
    return true;
  }

  /** Delivers everything due at `nowMs`. */
  pump(nowMs: number): void {
    while (this.queue.length > 0 && this.queue[0].dueAt <= nowMs) {
      const item = this.queue.shift()!;
      this.delivered++;
      item.deliver();
    }
  }

  /** Flushes everything immediately. Used on disconnect. */
  flush(): void {
    this.queue.length = 0;
    this.lastDue = 0;
  }

  /** xorshift32. Seeded so a netsim session reproduces exactly. */
  private random(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 0x100000000;
  }
}

/** A symmetric simulated link: one delay line up, one down. */
export class NetSim {
  readonly up: DelayLine;
  readonly down: DelayLine;
  readonly config: NetSimConfig;

  constructor(cfg: NetSimConfig) {
    this.config = cfg;
    // Different seeds per direction, or up and down drop the same packets.
    this.up = new DelayLine(cfg, cfg.seed);
    this.down = new DelayLine(cfg, (cfg.seed ^ 0x5bf03635) >>> 0 || 7);
  }

  get enabled(): boolean {
    return this.config.rttMs > 0 || this.config.lossPct > 0 || this.config.jitterMs > 0;
  }

  pump(nowMs: number): void {
    this.up.pump(nowMs);
    this.down.pump(nowMs);
  }

  flush(): void {
    this.up.flush();
    this.down.flush();
  }

  stats(): { sentDropped: number; recvDropped: number; inFlight: number } {
    return {
      sentDropped: this.up.dropped,
      recvDropped: this.down.dropped,
      inFlight: this.up.pending + this.down.pending,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
