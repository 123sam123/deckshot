/**
 * DECKSHOT — seeded deterministic PRNG.
 *
 * Owner: weapons-hitreg.
 *
 * Why this exists at all: the client predicts a shot the instant the trigger is
 * pulled, and the server resolves the same shot ~50ms later. If the two disagree
 * about where the spread cone put the bullet, the client draws a tracer that did
 * not happen. So spread must be a pure function of (shooter, input sequence) —
 * never of wall-clock time, never of `Math.random()`.
 *
 * The generator is xorshift128 (Marsaglia). Every operation is a 32-bit integer
 * op (`^`, `<<`, `>>>`, `|0`, `Math.imul`), all of which are exactly specified
 * by ECMA-262, so V8 in a browser and V8 in Node produce bit-identical streams.
 * No floating point enters the state.
 *
 * Engine-free: no DOM, no Node, no `three`.
 */

/** 2D point, used for spread cone sampling. Local to this module by design. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Generator state. Four 32-bit words, never all zero (xorshift's fixed point).
 *
 * Exposed as plain fields so a caller can snapshot/restore a stream (client
 * reconciliation replays shots) with a struct copy and no allocation ceremony.
 */
export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface Rng extends RngState {
  /** Next raw 32-bit value, 0 .. 2^32-1. */
  nextUint32(): number;
  /** Next value in [0, 1). 2^-32 resolution. */
  nextFloat(): number;
  /** Uniform point inside the unit disc. Writes and returns `out` when given. */
  nextUnitCircle(out?: Vec2): Vec2;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Stable 32-bit hash of two integers. THE seeding entry point:
 * `makeRng(hashSeed(shooterId, inputSeq))` is what makes client and server
 * agree about a shot.
 *
 * FNV-1a rounds followed by an xorshift-multiply finalizer. `Math.imul` is used
 * for every multiply because plain `*` on two 32-bit ints silently exceeds 2^53
 * and loses the low bits — which would make the hash host-dependent in exactly
 * the way this whole file exists to prevent.
 *
 * Returns an unsigned 32-bit integer.
 */
export function hashSeed(a: number, b: number): number {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ (a | 0), 0x01000193);
  h = Math.imul(h ^ (b | 0), 0x01000193);
  // Finalizer (splitmix-style avalanche) so adjacent seqs are not adjacent seeds.
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash of three integers, for streams that need one more dimension. */
export function hashSeed3(a: number, b: number, c: number): number {
  return hashSeed(hashSeed(a, b) | 0, c);
}

/** splitmix32, used only to expand a single seed into four state words. */
function splitmix32(x: number): number {
  x = (x + 0x9e3779b9) | 0;
  let z = x;
  z ^= z >>> 16;
  z = Math.imul(z, 0x21f0aaad);
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97);
  z ^= z >>> 15;
  return z | 0;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

class Xorshift128 implements Rng {
  s0: number;
  s1: number;
  s2: number;
  s3: number;

  constructor(seed: number) {
    // Expand through splitmix32 so a seed of 0 or 1 still produces a
    // well-mixed state rather than a near-degenerate one.
    let x = seed | 0;
    x = splitmix32(x);
    this.s0 = x;
    x = splitmix32(x);
    this.s1 = x;
    x = splitmix32(x);
    this.s2 = x;
    x = splitmix32(x);
    this.s3 = x;
    // The all-zero state is xorshift's absorbing fixed point.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s3 = 0x9e3779b9 | 0;
  }

  nextUint32(): number {
    return nextUint32(this);
  }

  nextFloat(): number {
    return nextFloat(this);
  }

  nextUnitCircle(out?: Vec2): Vec2 {
    return nextUnitCircle(this, out);
  }
}

/**
 * Create a generator from a 32-bit seed.
 *
 * Seed it from the simulation, never from the clock:
 *   `makeRng(hashSeed(shooterId, input.seq))`
 */
export function makeRng(seed: number): Rng {
  return new Xorshift128(seed);
}

/** The canonical shot stream. One shot, one seed, both sides agree. */
export function makeShotRng(shooterId: number, inputSeq: number): Rng {
  return new Xorshift128(hashSeed(shooterId, inputSeq));
}

/** Byte-for-byte copy of a generator's state. Cheap; allocates one object. */
export function cloneRng(r: RngState): Rng {
  const c = new Xorshift128(0);
  c.s0 = r.s0 | 0;
  c.s1 = r.s1 | 0;
  c.s2 = r.s2 | 0;
  c.s3 = r.s3 | 0;
  return c;
}

/** Advance the stream, returning an unsigned 32-bit value. */
export function nextUint32(r: RngState): number {
  const t = r.s0 ^ (r.s0 << 11);
  r.s0 = r.s1;
  r.s1 = r.s2;
  r.s2 = r.s3;
  r.s3 = (r.s3 ^ (r.s3 >>> 19)) ^ (t ^ (t >>> 8));
  return r.s3 >>> 0;
}

/** Advance the stream, returning a float in [0, 1). */
export function nextFloat(r: RngState): number {
  // 2^-32. Exact in binary floating point, so this division is lossless.
  return nextUint32(r) * 2.3283064365386963e-10;
}

/** Advance the stream, returning a float in [lo, hi). */
export function nextRange(r: RngState, lo: number, hi: number): number {
  return lo + (hi - lo) * nextFloat(r);
}

/** Advance the stream, returning -1 or +1. */
export function nextSign(r: RngState): number {
  return (nextUint32(r) & 1) === 0 ? -1 : 1;
}

/**
 * Uniform sample from the unit disc — the shape of a spread cone's cross
 * section.
 *
 * `sqrt(u)` on the radius is what makes it uniform by AREA; sampling the radius
 * linearly would pile shots into the middle of the cone and make hipfire feel
 * far more accurate than its cone angle claims.
 *
 * Consumes exactly two values from the stream, always, so the stream stays
 * aligned regardless of the sample drawn.
 */
export function nextUnitCircle(r: RngState, out?: Vec2): Vec2 {
  const radius = Math.sqrt(nextFloat(r));
  const theta = nextFloat(r) * Math.PI * 2;
  const x = radius * Math.cos(theta);
  const y = radius * Math.sin(theta);
  if (out) {
    out.x = x;
    out.y = y;
    return out;
  }
  return { x, y };
}
