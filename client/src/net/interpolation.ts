/**
 * DECKSHOT — snapshot merging and entity interpolation.
 *
 * Owner: netcode-core.
 *
 * Two jobs, in order.
 *
 * **Merging.** Snapshots are deltas against a specific earlier tick, so the
 * client keeps the same ring of past world states the server keeps and applies
 * each delta onto the tick it names. Applying a delta onto "the latest state"
 * instead is the classic mistake: it works perfectly on a LAN and produces
 * players sliding through walls the moment an ack is a snapshot behind. A
 * snapshot whose baseline we never received is DISCARDED, not guessed at —
 * the server notices the missing ack within a second and sends full state.
 *
 * **Interpolation.** Remote players are rendered INTERP_DELAY_MS in the past,
 * between the two snapshots that bracket that moment. That is what makes other
 * players move smoothly at 20 Hz, and it is also why lag compensation on the
 * server has to add the same 100 ms back: you shot at where you SAW them.
 *
 * On loss, positions extrapolate along their last known velocity for at most
 * MAX_EXTRAPOLATION_MS and then freeze. Extrapolating further produces players
 * who run confidently through geometry and then snap back — worse to look at,
 * and much worse to aim at, than a player who stands still for a moment.
 */

import type { SnapshotMsg } from '../../../shared/protocol.js';
import { SnapshotField } from '../../../shared/protocol.js';
import type { SnapshotPlayerExt } from '../../../shared/codec.js';
import {
  AdsState,
  DEFAULT_LOADOUT,
  Stance,
  TeamId,
  WeaponId,
  vec3,
  type Loadout,
  type PlayerId,
  type Vec3,
} from '../../../shared/types.js';
import {
  INTERP_DELAY_MS,
  MAX_EXTRAPOLATION_MS,
  MAX_HEALTH,
  TICK_MS,
} from '../../../shared/tuning.js';

/** Snapshots retained. 32 at 20 Hz is 1.6 s — comfortably past any RTT. */
export const SNAPSHOT_HISTORY = 32;

const TWO_PI = Math.PI * 2;

/** A fully resolved remote player: every field present, no deltas. */
export interface RemotePlayerState {
  id: PlayerId;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  onGround: boolean;
  alive: boolean;
  health: number;
  activeWeapon: WeaponId;
  adsState: AdsState;
  adsProgress: number;
  firedThisTick: boolean;
  /** SURVIVAL: last stand (Flags bit 3). */
  downed: boolean;
  score: number;
  kills: number;
  deaths: number;
  streak: number;
  team: TeamId;
  name: string;
  loadout: Loadout;
  ping: number;
}

export interface StoredSnapshot {
  tick: number;
  /** Server clock in ms, derived from the tick. */
  serverTimeMs: number;
  /** Local clock in ms when it arrived. */
  localTimeMs: number;
  ackedSeq: number;
  players: Map<PlayerId, RemotePlayerState>;
}

export interface AppliedSnapshot {
  snapshot: StoredSnapshot;
  /** Players who fired on this snapshot. Events, so never interpolated. */
  fired: PlayerId[];
  removed: PlayerId[];
  /** True when this snapshot arrived out of order behind a newer one. */
  outOfOrder: boolean;
}

export function blankRemote(id: PlayerId): RemotePlayerState {
  return {
    id,
    position: vec3(),
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    alive: true,
    health: MAX_HEALTH,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    firedThisTick: false,
    downed: false,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    team: TeamId.FFA,
    name: '',
    loadout: DEFAULT_LOADOUT,
    ping: 0,
  };
}

export class SnapshotBuffer {
  private readonly byTick16 = new Map<number, StoredSnapshot>();
  /** Newest-last, ordered by tick. */
  private readonly ordered: StoredSnapshot[] = [];

  /**
   * localClock - serverClock, in ms. Tracked as a running minimum with slow
   * upward drift: the minimum is the sample with the least queueing delay,
   * which is the best estimate of the true offset, and the drift lets it
   * recover if that one sample was a fluke or the route changed.
   */
  private clockOffsetMs = Number.NaN;

  duplicates = 0;
  missingBaselines = 0;
  outOfOrder = 0;

  get latestTick(): number {
    return this.ordered.length === 0 ? -1 : this.ordered[this.ordered.length - 1].tick;
  }

  get size(): number {
    return this.ordered.length;
  }

  latest(): StoredSnapshot | null {
    return this.ordered.length === 0 ? null : this.ordered[this.ordered.length - 1];
  }

  clear(): void {
    this.byTick16.clear();
    this.ordered.length = 0;
    this.clockOffsetMs = Number.NaN;
  }

  /**
   * Merges one decoded snapshot. Returns null when it was a duplicate or its
   * baseline is not held.
   */
  apply(msg: SnapshotMsg, localTimeMs: number): AppliedSnapshot | null {
    const tick16 = msg.tick & 0xffff;
    const existing = this.byTick16.get(tick16);
    if (existing && existing.tick === msg.tick) {
      this.duplicates++;
      return null;
    }

    let base: StoredSnapshot | null = null;
    if (msg.baselineTick !== 0) {
      base = this.byTick16.get(msg.baselineTick & 0xffff) ?? null;
      if (!base) {
        // We never got the snapshot this delta is against; it cannot be
        // reconstructed. Dropping it also stops us acking it, which is what
        // makes the server fall back to full state.
        this.missingBaselines++;
        return null;
      }
    }

    const serverTimeMs = msg.tick * TICK_MS;
    const players = new Map<PlayerId, RemotePlayerState>();
    const fired: PlayerId[] = [];

    for (const raw of msg.players as SnapshotPlayerExt[]) {
      const prev = base?.players.get(raw.id);
      const merged = prev ? clone(prev) : blankRemote(raw.id);
      applyDelta(merged, raw);
      if (merged.firedThisTick) fired.push(merged.id);
      players.set(merged.id, merged);
    }

    const removed: PlayerId[] = [];
    if (base) {
      for (const id of base.players.keys()) {
        if (!players.has(id)) removed.push(id);
      }
    }
    for (const id of msg.removed ?? []) {
      if (!players.has(id) && !removed.includes(id)) removed.push(id);
    }

    const stored: StoredSnapshot = {
      tick: msg.tick,
      serverTimeMs,
      localTimeMs,
      ackedSeq: msg.ackedSeq,
      players,
    };

    const outOfOrderArrival = this.ordered.length > 0 && msg.tick < this.latestTick;
    if (outOfOrderArrival) this.outOfOrder++;

    this.insert(stored);
    this.updateClock(localTimeMs, serverTimeMs);

    return { snapshot: stored, fired, removed, outOfOrder: outOfOrderArrival };
  }

  /** Estimated server clock (ms) corresponding to a local timestamp. */
  serverTimeAt(localTimeMs: number): number {
    if (!Number.isFinite(this.clockOffsetMs)) {
      const latest = this.latest();
      return latest ? latest.serverTimeMs : 0;
    }
    return localTimeMs - this.clockOffsetMs;
  }

  /** The server time remote players should be drawn at. */
  renderTimeAt(localTimeMs: number): number {
    return this.serverTimeAt(localTimeMs) - INTERP_DELAY_MS;
  }

  /**
   * Samples every remote player at `renderServerTimeMs` into `out`.
   *
   * `out` is reused across frames; entries for players who have left are
   * deleted. Returns the number of players written.
   */
  sample(
    renderServerTimeMs: number,
    out: Map<PlayerId, RemotePlayerState>,
    excludeId: PlayerId = -1
  ): number {
    if (this.ordered.length === 0) {
      out.clear();
      return 0;
    }

    const { older, newer, t } = this.bracket(renderServerTimeMs);
    const source = newer ?? older;
    if (!source) {
      out.clear();
      return 0;
    }

    const seen = new Set<PlayerId>();
    let count = 0;

    for (const [id, target] of source.players) {
      if (id === excludeId) continue;
      let dst = out.get(id);
      if (!dst) {
        dst = blankRemote(id);
        out.set(id, dst);
      }
      seen.add(id);
      count++;

      const from = older ? older.players.get(id) : undefined;

      if (older && newer && from) {
        interpolate(dst, from, target, t);
      } else if (older && !newer) {
        // Past the newest snapshot: extrapolate, then freeze.
        const ahead = renderServerTimeMs - older.serverTimeMs;
        extrapolate(dst, target, Math.max(0, Math.min(ahead, MAX_EXTRAPOLATION_MS)) / 1000);
      } else {
        copyRemote(target, dst);
      }
      // Firing is an event, not a state to blend between.
      dst.firedThisTick = false;
    }

    for (const id of Array.from(out.keys())) {
      if (!seen.has(id)) out.delete(id);
    }
    return count;
  }

  // --- internals ---------------------------------------------------------

  private insert(stored: StoredSnapshot): void {
    const prev = this.byTick16.get(stored.tick & 0xffff);
    if (prev) {
      const at = this.ordered.indexOf(prev);
      if (at >= 0) this.ordered.splice(at, 1);
    }
    this.byTick16.set(stored.tick & 0xffff, stored);

    // Almost always an append; the splice path only runs on reordering.
    if (this.ordered.length === 0 || stored.tick > this.ordered[this.ordered.length - 1].tick) {
      this.ordered.push(stored);
    } else {
      let i = this.ordered.length;
      while (i > 0 && this.ordered[i - 1].tick > stored.tick) i--;
      this.ordered.splice(i, 0, stored);
    }

    while (this.ordered.length > SNAPSHOT_HISTORY) {
      const dropped = this.ordered.shift()!;
      if (this.byTick16.get(dropped.tick & 0xffff) === dropped) {
        this.byTick16.delete(dropped.tick & 0xffff);
      }
    }
  }

  private updateClock(localTimeMs: number, serverTimeMs: number): void {
    const sample = localTimeMs - serverTimeMs;
    if (!Number.isFinite(this.clockOffsetMs)) {
      this.clockOffsetMs = sample;
      return;
    }
    if (sample < this.clockOffsetMs) this.clockOffsetMs = sample;
    else this.clockOffsetMs += (sample - this.clockOffsetMs) * 0.01;
  }

  /** The two snapshots bracketing a server time, and the blend factor. */
  private bracket(timeMs: number): {
    older: StoredSnapshot | null;
    newer: StoredSnapshot | null;
    t: number;
  } {
    const n = this.ordered.length;
    if (n === 0) return { older: null, newer: null, t: 0 };
    if (timeMs <= this.ordered[0].serverTimeMs) {
      return { older: null, newer: this.ordered[0], t: 0 };
    }
    const last = this.ordered[n - 1];
    if (timeMs >= last.serverTimeMs) return { older: last, newer: null, t: 0 };

    for (let i = n - 1; i > 0; i--) {
      const older = this.ordered[i - 1];
      const newer = this.ordered[i];
      if (timeMs >= older.serverTimeMs && timeMs <= newer.serverTimeMs) {
        const span = newer.serverTimeMs - older.serverTimeMs;
        return { older, newer, t: span > 1e-6 ? (timeMs - older.serverTimeMs) / span : 0 };
      }
    }
    return { older: this.ordered[0], newer: this.ordered[1] ?? null, t: 0 };
  }
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function applyDelta(dst: RemotePlayerState, src: SnapshotPlayerExt): void {
  const mask = src.mask === undefined ? 0xffff : src.mask;
  dst.id = src.id;
  if (mask & SnapshotField.Position) {
    dst.position.x = src.position.x;
    dst.position.y = src.position.y;
    dst.position.z = src.position.z;
  }
  if (mask & SnapshotField.Velocity) {
    dst.velocity.x = src.velocity.x;
    dst.velocity.y = src.velocity.y;
    dst.velocity.z = src.velocity.z;
  }
  if (mask & SnapshotField.Yaw) dst.yaw = src.yaw;
  if (mask & SnapshotField.Pitch) dst.pitch = src.pitch;
  if (mask & SnapshotField.Stance) dst.stance = src.stance;
  if (mask & SnapshotField.Flags) {
    dst.onGround = src.onGround;
    dst.alive = src.alive;
    dst.firedThisTick = src.firedThisTick;
    dst.downed = src.downed === true;
  } else {
    dst.firedThisTick = false;
  }
  if (mask & SnapshotField.Health) dst.health = src.health;
  if (mask & SnapshotField.Weapon) dst.activeWeapon = src.activeWeapon;
  if (mask & SnapshotField.Ads) {
    dst.adsState = src.adsState;
    dst.adsProgress = src.adsProgress;
  }
  if (mask & SnapshotField.Score) {
    dst.score = src.score ?? dst.score;
    dst.kills = src.kills ?? dst.kills;
    dst.deaths = src.deaths ?? dst.deaths;
    dst.streak = src.streak ?? dst.streak;
  }
  if (mask & SnapshotField.Identity) {
    dst.team = src.team ?? dst.team;
    dst.name = src.name ?? dst.name;
    dst.loadout = src.loadout ?? dst.loadout;
  }
  if (mask & SnapshotField.Ping) dst.ping = src.ping ?? dst.ping;
}

function clone(src: RemotePlayerState): RemotePlayerState {
  const out = blankRemote(src.id);
  copyRemote(src, out);
  return out;
}

export function copyRemote(src: RemotePlayerState, dst: RemotePlayerState): void {
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
  dst.alive = src.alive;
  dst.health = src.health;
  dst.activeWeapon = src.activeWeapon;
  dst.adsState = src.adsState;
  dst.adsProgress = src.adsProgress;
  dst.firedThisTick = src.firedThisTick;
  dst.downed = src.downed;
  dst.score = src.score;
  dst.kills = src.kills;
  dst.deaths = src.deaths;
  dst.streak = src.streak;
  dst.team = src.team;
  dst.name = src.name;
  dst.loadout = src.loadout;
  dst.ping = src.ping;
}

function interpolate(
  dst: RemotePlayerState,
  a: RemotePlayerState,
  b: RemotePlayerState,
  t: number
): void {
  copyRemote(b, dst);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  dst.position.x = a.position.x + (b.position.x - a.position.x) * k;
  dst.position.y = a.position.y + (b.position.y - a.position.y) * k;
  dst.position.z = a.position.z + (b.position.z - a.position.z) * k;
  dst.velocity.x = a.velocity.x + (b.velocity.x - a.velocity.x) * k;
  dst.velocity.y = a.velocity.y + (b.velocity.y - a.velocity.y) * k;
  dst.velocity.z = a.velocity.z + (b.velocity.z - a.velocity.z) * k;
  dst.yaw = lerpAngle(a.yaw, b.yaw, k);
  dst.pitch = a.pitch + (b.pitch - a.pitch) * k;
  dst.adsProgress = a.adsProgress + (b.adsProgress - a.adsProgress) * k;
  // Stance is discrete; blending it would put the hitbox nowhere real.
  dst.stance = k < 0.5 ? a.stance : b.stance;
}

function extrapolate(dst: RemotePlayerState, from: RemotePlayerState, dtSeconds: number): void {
  copyRemote(from, dst);
  dst.position.x += from.velocity.x * dtSeconds;
  dst.position.y += from.velocity.y * dtSeconds;
  dst.position.z += from.velocity.z * dtSeconds;
}

/** Interpolates the short way round, so a 359 -> 1 degree turn is 2 degrees. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  let r = (a + d * t) % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  else if (r <= -Math.PI) r += TWO_PI;
  return r;
}
