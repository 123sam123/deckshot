/**
 * DECKSHOT — client-side prediction and reconciliation.
 *
 * Owner: netcode-core.
 *
 * The local player moves the instant you press a key, on a machine that has no
 * authority over anything. That only works because the client runs exactly the
 * same `applyMovement` the server does, keeps every input it has sent, and can
 * rewind and replay them the moment the server disagrees.
 *
 * Details that matter:
 *
 *  - **`seqDiff` everywhere.** Input sequence numbers are 16-bit. At 60 Hz they
 *    wrap every 18 minutes and 12 seconds. A `<` comparison here produces a
 *    client that freezes once per match, reproducibly, and looks like anything
 *    but an integer overflow.
 *  - **The ring is indexed by `seq & (SIZE-1)`.** INPUT_BUFFER_SIZE is 128,
 *    which divides 65536, so the index survives the wrap without a special case.
 *  - **Angles are never rebased.** Yaw and pitch are client-authoritative by
 *    construction: every input carries absolute angles, so the server's copy is
 *    just our own value delayed by a round trip. Adopting it would drag the
 *    crosshair backwards every 50 ms. Only `Correction` overrides the view.
 *  - **The weapon runtime is not replayed.** Weapon state advances with time,
 *    not with position; re-running it during a replay would double-advance the
 *    ADS timer and desync the exact number the whole quickscope mechanic
 *    depends on.
 *  - **Corrections are smoothed visually, never applied to the simulation.**
 *    The simulated position snaps; the rendered position walks there over
 *    RECONCILE_SMOOTH_MS. The camera must never teleport.
 */

import {
  applyMovement,
  createCollisionWorld,
  type CollisionWorld,
  type MovementState,
} from '../../../shared/movement.js';
import { snapInputInPlace } from '../../../shared/quantize.js';
import {
  AdsState,
  DEFAULT_LOADOUT,
  Stance,
  TeamId,
  WeaponId,
  emptyInput,
  seqDiff,
  vec3,
  type ClientInput,
  type PlayerId,
  type Vec3,
} from '../../../shared/types.js';
import {
  INPUT_BUFFER_SIZE,
  MAX_HEALTH,
  RECONCILE_EPSILON,
  RECONCILE_SMOOTH_MS,
  TICK_DT,
} from '../../../shared/tuning.js';
import type { SnapshotPlayerExt } from '../../../shared/codec.js';

const RING_MASK = INPUT_BUFFER_SIZE - 1;

/** Beyond this the correction is a teleport (respawn, killcam); do not smear it. */
const MAX_SMOOTH_DISTANCE = 2.0;

interface Frame {
  seq: number;
  used: boolean;
  input: ClientInput;
  px: number;
  py: number;
  pz: number;
}

export interface ReconcileResult {
  /** A server state was applied. */
  applied: boolean;
  /** The error exceeded RECONCILE_EPSILON — a real correction, not rounding. */
  hard: boolean;
  /** Positional disagreement in meters, before correcting. */
  error: number;
  /** Unacknowledged inputs re-simulated. */
  replayed: number;
}

export interface PredictorOptions {
  world?: CollisionWorld;
  /** Weapon prediction, injected by the gameplay layer when it exists. */
  advanceWeapon?: (input: ClientInput, dt: number) => void;
}

export class Predictor {
  /** The predicted local player. Authoritative for rendering, not for truth. */
  state: MovementState;

  private world: CollisionWorld;
  private readonly ring: Frame[] = [];
  private readonly advanceWeapon: ((input: ClientInput, dt: number) => void) | undefined;

  /** Newest input seq pushed, or -1 before the first. */
  private newestSeq = -1;
  /** Newest ack applied, or -1. */
  private ackedSeq = -1;

  /** Rendered position minus simulated position; decays to zero. */
  private readonly smooth: Vec3 = vec3();
  private smoothActive = false;

  // --- diagnostics -------------------------------------------------------
  corrections = 0;
  hardCorrections = 0;
  lastError = 0;
  lastReplayed = 0;

  constructor(id: PlayerId, opts: PredictorOptions = {}) {
    this.world = opts.world ?? createCollisionWorld();
    this.advanceWeapon = opts.advanceWeapon;
    this.state = blankState(id);
    for (let i = 0; i < INPUT_BUFFER_SIZE; i++) {
      this.ring.push({ seq: -1, used: false, input: emptyInput(), px: 0, py: 0, pz: 0 });
    }
  }

  /**
   * SURVIVAL: swap the static geometry prediction runs against (Leviathan, and
   * again whenever a zone purchase removes a door). The server made the same
   * swap on the same information, so replays stay consistent.
   */
  setWorld(world: CollisionWorld): void {
    this.world = world;
  }

  /** Unacknowledged inputs currently held. */
  get pendingInputs(): number {
    if (this.newestSeq < 0 || this.ackedSeq < 0) return this.newestSeq < 0 ? 0 : this.newestSeq + 1;
    const d = seqDiff(this.newestSeq, this.ackedSeq);
    return d > 0 ? d : 0;
  }

  /**
   * Predicts one tick.
   *
   * The input is snapped to the wire's quantization grid FIRST. It has to be:
   * the server will simulate from the quantized values it receives, so
   * predicting from the raw floats guarantees a slow, permanent divergence
   * that looks exactly like packet loss.
   */
  predict(input: ClientInput): MovementState {
    snapInputInPlace(input);
    this.step(input);

    const frame = this.ring[input.seq & RING_MASK];
    frame.seq = input.seq;
    frame.used = true;
    copyInput(input, frame.input);
    frame.px = this.state.position.x;
    frame.py = this.state.position.y;
    frame.pz = this.state.position.z;

    this.newestSeq = input.seq;
    return this.state;
  }

  /**
   * Applies an authoritative state for `ackedSeq` and replays everything newer.
   *
   * The server state is adopted on EVERY snapshot, not only when the error
   * trips the epsilon. Ignoring a sub-epsilon disagreement leaves the client
   * integrating from its own slightly wrong position, and those millimetres
   * compound into a real correction a few seconds later. Adopting always keeps
   * the error pinned at exactly one quantization step, which is invisible.
   * The epsilon still decides whether it is worth SMOOTHING and counting.
   */
  reconcile(server: SnapshotPlayerExt, ackedSeq: number): ReconcileResult {
    const result: ReconcileResult = { applied: false, hard: false, error: 0, replayed: 0 };
    if (this.newestSeq < 0) {
      // No prediction history yet: the server state is simply the truth.
      this.adopt(server);
      result.applied = true;
      return result;
    }

    // Ignore an ack older than one we have already processed, and one that is
    // impossibly far ahead (a stale or forged snapshot).
    if (this.ackedSeq >= 0 && seqDiff(ackedSeq, this.ackedSeq) < 0) return result;
    const age = seqDiff(this.newestSeq, ackedSeq);
    if (age < 0 || age >= INPUT_BUFFER_SIZE) {
      // We no longer hold the input this state corresponds to. Snap and start
      // the prediction history again from here.
      this.adopt(server);
      this.resetHistory();
      result.applied = true;
      result.hard = true;
      this.hardCorrections++;
      return result;
    }

    const frame = this.ring[ackedSeq & RING_MASK];
    const haveFrame = frame.used && frame.seq === ackedSeq;

    const dx = server.position.x - (haveFrame ? frame.px : this.state.position.x);
    const dy = server.position.y - (haveFrame ? frame.py : this.state.position.y);
    const dz = server.position.z - (haveFrame ? frame.pz : this.state.position.z);
    const error = Math.sqrt(dx * dx + dy * dy + dz * dz);
    result.error = error;
    this.lastError = error;

    // Where the player is drawn right now, so the visual correction can be
    // measured against it after the replay.
    const beforeX = this.state.position.x;
    const beforeY = this.state.position.y;
    const beforeZ = this.state.position.z;

    this.adopt(server);

    // Replay every input the server has not seen yet, in order.
    let replayed = 0;
    for (let s = 1; s <= age; s++) {
      const seq = (ackedSeq + s) & 0xffff;
      const f = this.ring[seq & RING_MASK];
      if (!f.used || f.seq !== seq) continue;
      this.step(f.input, true);
      f.px = this.state.position.x;
      f.py = this.state.position.y;
      f.pz = this.state.position.z;
      replayed++;
    }

    this.ackedSeq = ackedSeq;
    result.applied = true;
    result.replayed = replayed;
    this.lastReplayed = replayed;

    if (error > RECONCILE_EPSILON) {
      result.hard = true;
      this.hardCorrections++;
    }
    this.corrections++;

    this.addSmoothing(
      beforeX - this.state.position.x,
      beforeY - this.state.position.y,
      beforeZ - this.state.position.z
    );
    return result;
  }

  /**
   * A `Correction` message: the server rejected something outright. Unlike a
   * snapshot this DOES override the view angles, because the reason the state
   * was rejected may be exactly where the player was looking.
   */
  forceState(server: SnapshotPlayerExt, overrideAngles = true): void {
    const beforeX = this.state.position.x;
    const beforeY = this.state.position.y;
    const beforeZ = this.state.position.z;
    this.adopt(server);
    if (overrideAngles) {
      this.state.yaw = server.yaw;
      this.state.pitch = server.pitch;
    }
    this.resetHistory();
    this.hardCorrections++;
    this.addSmoothing(
      beforeX - this.state.position.x,
      beforeY - this.state.position.y,
      beforeZ - this.state.position.z
    );
  }

  /**
   * Decays the visual correction. Call once per rendered frame with the frame
   * time in seconds — this is presentation, so it runs on the render clock,
   * not the tick clock.
   */
  updateSmoothing(dtSeconds: number): void {
    if (!this.smoothActive) return;
    // Exponential decay tuned so the correction is ~95% gone after
    // RECONCILE_SMOOTH_MS. Exponential rather than linear because a linear
    // ramp has a visible corner at the end of every correction.
    const tau = RECONCILE_SMOOTH_MS / 3000;
    const k = Math.exp(-Math.max(0, dtSeconds) / tau);
    this.smooth.x *= k;
    this.smooth.y *= k;
    this.smooth.z *= k;
    if (
      Math.abs(this.smooth.x) < 1e-4 &&
      Math.abs(this.smooth.y) < 1e-4 &&
      Math.abs(this.smooth.z) < 1e-4
    ) {
      this.smooth.x = 0;
      this.smooth.y = 0;
      this.smooth.z = 0;
      this.smoothActive = false;
    }
  }

  /** Simulated position plus the decaying correction. What the camera uses. */
  renderPosition(out: Vec3 = vec3()): Vec3 {
    out.x = this.state.position.x + this.smooth.x;
    out.y = this.state.position.y + this.smooth.y;
    out.z = this.state.position.z + this.smooth.z;
    return out;
  }

  /** Current visual correction offset, in meters. Zero when settled. */
  smoothingOffset(): Readonly<Vec3> {
    return this.smooth;
  }

  /** Hard reset: respawn, new match, reconnect. */
  reset(state?: Partial<MovementState>): void {
    this.resetHistory();
    this.smooth.x = 0;
    this.smooth.y = 0;
    this.smooth.z = 0;
    this.smoothActive = false;
    if (state) Object.assign(this.state, state);
  }

  // --- internals ---------------------------------------------------------

  private resetHistory(): void {
    for (let i = 0; i < this.ring.length; i++) {
      this.ring[i].used = false;
      this.ring[i].seq = -1;
    }
    this.newestSeq = -1;
    this.ackedSeq = -1;
  }

  private step(input: ClientInput, isReplay = false): void {
    // Weapons before movement, matching the server's tick order exactly: ADS
    // state gates movement speed, so running them the other way round changes
    // the distance travelled on the transition tick.
    if (!isReplay) this.advanceWeapon?.(input, TICK_DT);
    const result = applyMovement(this.state, input, TICK_DT, this.world);
    this.state = result.state;
  }

  /** Copies the replicated fields of an authoritative state. Angles excluded. */
  private adopt(server: SnapshotPlayerExt): void {
    const s = this.state;
    const mask = server.mask;
    const has = (bit: number): boolean => mask === undefined || (mask & bit) !== 0;

    if (has(1 << 0)) {
      s.position.x = server.position.x;
      s.position.y = server.position.y;
      s.position.z = server.position.z;
    }
    if (has(1 << 1)) {
      s.velocity.x = server.velocity.x;
      s.velocity.y = server.velocity.y;
      s.velocity.z = server.velocity.z;
    }
    if (has(1 << 4)) s.stance = server.stance;
    if (has(1 << 5)) {
      s.onGround = server.onGround;
      s.alive = server.alive;
    }
    if (has(1 << 6)) s.health = server.health;
    if (has(1 << 7)) s.activeWeapon = server.activeWeapon;
    if (has(1 << 8)) {
      s.adsState = server.adsState;
      s.adsProgress = server.adsProgress;
    }
    if (server.score !== undefined) s.score = server.score;
    if (server.kills !== undefined) s.kills = server.kills;
    if (server.deaths !== undefined) s.deaths = server.deaths;
    if (server.streak !== undefined) s.streak = server.streak;
    if (server.ping !== undefined) s.ping = server.ping;
    if (server.name !== undefined) s.name = server.name;
    if (server.team !== undefined) s.team = server.team;
    if (server.loadout !== undefined) s.loadout = server.loadout;
  }

  private addSmoothing(dx: number, dy: number, dz: number): void {
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) return;
    if (d > MAX_SMOOTH_DISTANCE) {
      // A teleport. Smearing it across 100 ms would look like the player being
      // dragged across the map; snapping is the honest presentation.
      this.smooth.x = 0;
      this.smooth.y = 0;
      this.smooth.z = 0;
      this.smoothActive = false;
      return;
    }
    this.smooth.x += dx;
    this.smooth.y += dy;
    this.smooth.z += dz;
    this.smoothActive = true;
  }
}

export function copyInput(src: ClientInput, dst: ClientInput): void {
  dst.seq = src.seq;
  dst.tick = src.tick;
  dst.moveX = src.moveX;
  dst.moveZ = src.moveZ;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.buttons = src.buttons;
}

export function blankState(id: PlayerId): MovementState {
  return {
    id,
    position: vec3(),
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    slideTime: 0,
    slideCooldown: 0,
    sprintTime: 0,
    prevButtons: 0,
    proneTime: 0,
    health: MAX_HEALTH,
    alive: true,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    ammoInMag: 0,
    ammoReserve: 0,
    actionEndsAt: 0,
    name: '',
    team: TeamId.FFA,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 0,
  };
}
