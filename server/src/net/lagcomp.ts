/**
 * DECKSHOT — lag compensation.
 *
 * Owner: netcode-core.
 *
 * This file is the reason quickscoping feels fair on a 100 ms connection.
 *
 * The shooter's screen is not the server's present. It is the server's past by
 * (one-way latency) + (INTERP_DELAY_MS), because remote players are rendered
 * interpolated 100 ms behind the newest snapshot. So when a fire input arrives,
 * the server rewinds every OTHER player to
 *
 *     serverNow - (rtt / 2 + INTERP_DELAY_MS)
 *
 * clamped to LAGCOMP_MAX_REWIND_MS, and resolves the shot against those
 * positions. Anything less and every sniper duel is decided by whoever has the
 * shorter cable.
 *
 * Storage is a preallocated ring of LAGCOMP_HISTORY_MS at TICK_RATE. No
 * allocation happens per tick, per shot, or per player: the rewound states are
 * written into a pool of scratch objects the caller owns.
 */

import {
  INTERP_DELAY_MS,
  LAGCOMP_HISTORY_MS,
  LAGCOMP_MAX_REWIND_MS,
  MAX_PLAYERS,
  TICK_MS,
} from '../../../shared/tuning.js';
import { Stance, type PlayerId, type PlayerState } from '../../../shared/types.js';

/** Ticks retained. 500 ms at 60 Hz is 30; a couple of spares absorb jitter. */
export const HISTORY_TICKS = Math.ceil(LAGCOMP_HISTORY_MS / TICK_MS) + 2;

const FLOATS_PER_ENTRY = 5; // x, y, z, yaw, pitch

const FLAG_ALIVE = 1 << 0;
const FLAG_PRESENT = 1 << 1;

const TWO_PI = Math.PI * 2;

/** Shortest-way angular interpolation. Never takes the long way round a spin. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  let r = (a + d * t) % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  else if (r <= -Math.PI) r += TWO_PI;
  return r;
}

export interface RewindStats {
  /** Milliseconds actually rewound, after clamping. */
  rewindMs: number;
  /** True when the request was clamped by LAGCOMP_MAX_REWIND_MS. */
  clamped: boolean;
  /** True when the target time predates the retained history. */
  starved: boolean;
}

/**
 * Per-tick positional history for every player in one room.
 *
 * Players occupy a dense `slot` in [0, MAX_PLAYERS); the room assigns it on
 * join and releases it on leave. That keeps every lookup a multiply-add
 * instead of a hash.
 */
export class LagCompHistory {
  private readonly slots: number;
  private readonly times: Float64Array;
  private readonly ticks: Float64Array;
  private readonly data: Float32Array;
  private readonly flags: Uint8Array;
  private readonly stance: Uint8Array;

  /** Index of the most recently written ring entry, or -1 when empty. */
  private head = -1;
  /** Entries written, saturating at HISTORY_TICKS. */
  private filled = 0;

  constructor(maxPlayers: number = MAX_PLAYERS) {
    this.slots = maxPlayers;
    this.times = new Float64Array(HISTORY_TICKS);
    this.ticks = new Float64Array(HISTORY_TICKS);
    this.data = new Float32Array(HISTORY_TICKS * maxPlayers * FLOATS_PER_ENTRY);
    this.flags = new Uint8Array(HISTORY_TICKS * maxPlayers);
    this.stance = new Uint8Array(HISTORY_TICKS * maxPlayers);
  }

  /** Drops all history. Used on round restart, so a shot cannot rewind across it. */
  clear(): void {
    this.head = -1;
    this.filled = 0;
  }

  get sampleCount(): number {
    return this.filled;
  }

  /**
   * Records one tick. Call exactly once per tick, after movement has run and
   * before combat resolves, so the newest entry is the true present.
   */
  beginTick(tick: number, timeMs: number): void {
    this.head = this.head < 0 ? 0 : (this.head + 1) % HISTORY_TICKS;
    if (this.filled < HISTORY_TICKS) this.filled++;
    this.times[this.head] = timeMs;
    this.ticks[this.head] = tick;
    const base = this.head * this.slots;
    this.flags.fill(0, base, base + this.slots);
  }

  /** Records one player into the tick opened by `beginTick`. */
  record(slot: number, s: PlayerState): void {
    if (this.head < 0 || slot < 0 || slot >= this.slots) return;
    const i = this.head * this.slots + slot;
    const d = i * FLOATS_PER_ENTRY;
    this.data[d] = s.position.x;
    this.data[d + 1] = s.position.y;
    this.data[d + 2] = s.position.z;
    this.data[d + 3] = s.yaw;
    this.data[d + 4] = s.pitch;
    this.flags[i] = FLAG_PRESENT | (s.alive ? FLAG_ALIVE : 0);
    this.stance[i] = s.stance;
  }

  /**
   * How far back a shooter with round-trip time `rttMs` was looking, in ms.
   * Clamped to LAGCOMP_MAX_REWIND_MS so a client claiming a 5 second ping
   * cannot shoot people where they stood a match ago.
   */
  static rewindForRtt(rttMs: number): number {
    const raw = (Number.isFinite(rttMs) && rttMs > 0 ? rttMs : 0) / 2 + INTERP_DELAY_MS;
    return raw > LAGCOMP_MAX_REWIND_MS ? LAGCOMP_MAX_REWIND_MS : raw;
  }

  /**
   * Writes the state of `slot` at `targetTimeMs` into `out`.
   *
   * `out` is expected to already be a copy of the player's live state, so
   * health, loadout, team and weapon carry over untouched; only the fields
   * that decide whether a ray connects are rewound. Returns false when the
   * player has no usable history (just joined, or the target predates the
   * buffer), in which case `out` keeps its live values.
   */
  sample(slot: number, targetTimeMs: number, out: PlayerState): boolean {
    if (this.filled === 0 || slot < 0 || slot >= this.slots) return false;

    // Walk back from the newest entry to find the bracketing pair.
    let newerRing = -1;
    let olderRing = -1;
    for (let n = 0; n < this.filled; n++) {
      const ring = (this.head - n + HISTORY_TICKS * 2) % HISTORY_TICKS;
      if ((this.flags[ring * this.slots + slot] & FLAG_PRESENT) === 0) continue;
      if (this.times[ring] > targetTimeMs) {
        newerRing = ring;
        continue;
      }
      olderRing = ring;
      break;
    }

    if (olderRing < 0) {
      // Target is older than everything retained: clamp to the oldest sample
      // we still have rather than inventing a position.
      if (newerRing < 0) return false;
      this.readInto(newerRing, slot, out);
      return true;
    }
    if (newerRing < 0) {
      // Target is in the future (or exactly now): the newest sample is right.
      this.readInto(olderRing, slot, out);
      return true;
    }

    const t0 = this.times[olderRing];
    const t1 = this.times[newerRing];
    const span = t1 - t0;
    const t = span > 1e-6 ? (targetTimeMs - t0) / span : 0;
    const k = t < 0 ? 0 : t > 1 ? 1 : t;

    const i0 = (olderRing * this.slots + slot) * FLOATS_PER_ENTRY;
    const i1 = (newerRing * this.slots + slot) * FLOATS_PER_ENTRY;

    out.position.x = this.data[i0] + (this.data[i1] - this.data[i0]) * k;
    out.position.y = this.data[i0 + 1] + (this.data[i1 + 1] - this.data[i0 + 1]) * k;
    out.position.z = this.data[i0 + 2] + (this.data[i1 + 2] - this.data[i0 + 2]) * k;
    out.yaw = lerpAngle(this.data[i0 + 3], this.data[i1 + 3], k);
    out.pitch = this.data[i0 + 4] + (this.data[i1 + 4] - this.data[i0 + 4]) * k;
    // Stance and liveness are discrete: take the nearer sample. Blending a
    // hitbox halfway between standing and prone would hit nothing real.
    const near = k < 0.5 ? olderRing : newerRing;
    const ni = near * this.slots + slot;
    out.stance = this.stance[ni] as Stance;
    out.alive = (this.flags[ni] & FLAG_ALIVE) !== 0;
    return true;
  }

  private readInto(ring: number, slot: number, out: PlayerState): void {
    const i = ring * this.slots + slot;
    const d = i * FLOATS_PER_ENTRY;
    out.position.x = this.data[d];
    out.position.y = this.data[d + 1];
    out.position.z = this.data[d + 2];
    out.yaw = this.data[d + 3];
    out.pitch = this.data[d + 4];
    out.stance = this.stance[i] as Stance;
    out.alive = (this.flags[i] & FLAG_ALIVE) !== 0;
  }

  /** Server time (ms) of the oldest retained sample, or NaN when empty. */
  oldestTime(): number {
    if (this.filled === 0) return Number.NaN;
    const ring = (this.head - (this.filled - 1) + HISTORY_TICKS * 2) % HISTORY_TICKS;
    return this.times[ring];
  }

  /** Server time (ms) of the newest retained sample, or NaN when empty. */
  newestTime(): number {
    return this.filled === 0 ? Number.NaN : this.times[this.head];
  }
}

/**
 * A pool of scratch `PlayerState` objects for rewound targets.
 *
 * Combat is handed real-looking player states; allocating twelve of them on
 * every trigger pull of a twelve-player lobby is exactly the kind of garbage
 * that shows up as a hitch in the tick loop, so they are made once and reused.
 */
export class RewindPool {
  private readonly pool: PlayerState[] = [];

  /** Returns a scratch copy of `src`. Valid until the next `reset()`. */
  private used = 0;

  reset(): void {
    this.used = 0;
  }

  take(src: PlayerState): PlayerState {
    let target = this.pool[this.used];
    if (!target) {
      target = {
        ...src,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      };
      this.pool[this.used] = target;
    }
    copyPlayerInto(src, target);
    this.used++;
    return target;
  }
}

/** Field-by-field copy that keeps the destination's Vec3 identities. */
export function copyPlayerInto(src: PlayerState, dst: PlayerState): void {
  dst.id = src.id;
  dst.position.x = src.position.x;
  dst.position.y = src.position.y;
  dst.position.z = src.position.z;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.stance = src.stance;
  dst.onGround = src.onGround;
  dst.slideTime = src.slideTime;
  dst.slideCooldown = src.slideCooldown;
  dst.sprintTime = src.sprintTime;
  dst.health = src.health;
  dst.alive = src.alive;
  dst.activeWeapon = src.activeWeapon;
  dst.adsState = src.adsState;
  dst.adsProgress = src.adsProgress;
  dst.ammoInMag = src.ammoInMag;
  dst.ammoReserve = src.ammoReserve;
  dst.actionEndsAt = src.actionEndsAt;
  dst.name = src.name;
  dst.team = src.team;
  dst.score = src.score;
  dst.kills = src.kills;
  dst.deaths = src.deaths;
  dst.streak = src.streak;
  dst.loadout = src.loadout;
  dst.ping = src.ping;
}

export type { PlayerId };
