/**
 * DECKSHOT — the deterministic character controller.
 *
 * Owned by: physics-movement.
 *
 * This function is called by BOTH the client (prediction + replay of the
 * unacknowledged input buffer) and the server (authority). If the two ever
 * disagree by more than RECONCILE_EPSILON the player rubber-bands, so:
 *
 *   - `applyMovement` is a pure function of (state, input, dt, world).
 *   - It never reads `Date.now()` or `Math.random()`, and it never reads any
 *     module-level value that a previous call could have left behind. The
 *     scratch vectors and result structs in this file and in `collision.ts`
 *     exist purely so the hot path does not allocate: every one of them is
 *     written before it is read inside a single synchronous call, so no
 *     information can cross a call boundary.
 *   - It never mutates `state` or `input`. A fresh state object is returned,
 *     with fresh `position` / `velocity` vectors, because the caller keeps
 *     history buffers pointing at the old ones.
 *   - Every floating-point operation happens in a fixed order. There is no
 *     iteration over a hash map, no summation whose order depends on the
 *     environment, and every loop has a fixed trip count.
 *   - Only `Math.sqrt`, `Math.abs`, `Math.min`, `Math.max`, `Math.floor`,
 *     `Math.sin` and `Math.cos` are used. `Math.hypot` (implementation-defined
 *     precision) and `**` are deliberately avoided. `sin`/`cos` appear only for
 *     the view-angle basis, which both sides derive from the same wire-
 *     quantized yaw, so they agree bit-for-bit on any single V8 build.
 *
 * Every constant comes from `shared/tuning.ts`. None is redefined here.
 */

import {
  AdsState,
  InputButton,
  Stance,
  type ClientInput,
  type PlayerState,
  type Vec3,
} from './types.js';
import {
  ACCEL_AIR,
  ACCEL_GROUND,
  AIR_CONTROL,
  FRICTION,
  GRAVITY,
  JUMP_IMPULSE,
  MAX_SLOPE,
  PITCH_LIMIT,
  PLAYER_HEIGHT_CROUCH,
  PLAYER_HEIGHT_STAND,
  PLAYER_RADIUS,
  PRONE_TRANSITION,
  SLIDE_COOLDOWN,
  SLIDE_DURATION,
  SLIDE_FRICTION,
  SLIDE_MIN_SPEED,
  SLIDE_SPEED_MULT,
  SPEED_ADS,
  SPEED_CROUCH,
  SPEED_PRONE,
  SPEED_SPRINT,
  SPEED_WALK,
  SPRINT_RAMP,
  STEP_HEIGHT,
  STOP_SPEED,
  heightForStance,
} from './tuning.js';
import {
  COLLISION_SKIN,
  capsuleDepenetrate,
  capsuleOverlap,
  capsuleSweep,
  createCollisionWorld,
  isOutOfBounds,
  type CollisionWorld,
} from './collision.js';

export { createCollisionWorld, isOutOfBounds };
export type { CollisionWorld };

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * `PlayerState` plus the three simulation fields the frozen type does not carry.
 * All are optional, so a plain `PlayerState` is assignable both ways and every
 * other subsystem can keep using `PlayerState` unchanged. See "Contract
 * friction" in the handover notes.
 */
export interface MovementState extends PlayerState {
  /**
   * The previous tick's `ClientInput.buttons`. Rising edges (jump, crouch) are
   * derived from it. `ClientInput` carries no previous-button field, and jump
   * MUST NOT retrigger while held, so it has to live on the state and travel
   * with the history buffer.
   */
  prevButtons?: number;
  /** Seconds left in the prone (drop-shot) transition. */
  proneTime?: number;
  /**
   * Effective ADS movement speed, overriding `SPEED_ADS`.
   * Populated by weapons-hitreg from the resolved loadout — the
   * `LightweightStock` attachment sets `adsMoveSpeed: 3.6`. Movement never
   * reads `state.loadout`; that is weapons' domain.
   */
  adsMoveSpeedOverride?: number;
}

export interface MoveResult {
  state: MovementState;
  /** True on the single tick the player transitions to `onGround`. */
  landed: boolean;
  /** Downward speed (m/s, positive) at the instant of landing; 0 otherwise. */
  impactSpeed: number;
}

// ---------------------------------------------------------------------------
// Local derived constants (all from tuning; nothing new is invented)
// ---------------------------------------------------------------------------

/** A contact whose normal.y is at least this is standable. cos(MAX_SLOPE). */
export const MIN_WALK_NORMAL_Y = Math.cos(MAX_SLOPE);

/** Downward probe used to re-acquire ground when already airborne. */
const AIR_GROUND_PROBE = 0.03;

/** Max iterations of the slide/clip loop per move. */
const SLIDE_ITERATIONS = 4;

/** Depenetration passes run before and after the move. */
const DEPEN_ITERATIONS = 4;

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Small deterministic math helpers
// ---------------------------------------------------------------------------

function clampf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wraps to (-PI, PI]. `%` on doubles is exactly specified by IEEE-754. */
export function wrapAngle(a: number): number {
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  else if (r <= -Math.PI) r += TWO_PI;
  return r;
}

/** Deliberately hand-rolled: Math.hypot's precision is implementation-defined. */
function length2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

// ---------------------------------------------------------------------------
// Quake-style ground/air acceleration
// ---------------------------------------------------------------------------

interface MutVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Horizontal friction, applied before acceleration.
 *
 * `STOP_SPEED` acts as a floor on the control speed so low speeds bleed off
 * linearly and reach exactly zero instead of asymptoting — the deadzone the
 * tuning comment asks for.
 *
 * `floorSpeed` is the speed the player's own input is asking to sustain.
 * Friction bleeds anything ABOVE it (so speed carried in from a strafe-jump
 * landing decays at FRICTION) but never fights the acceleration below it.
 * Without that floor the ground terminal speed is ACCEL_GROUND / FRICTION =
 * 6.67 m/s and SPEED_SPRINT (7.4) would be physically unreachable — see the
 * contract-friction note in the handover.
 */
function applyFriction(v: MutVec3, friction: number, dt: number, floorSpeed: number): void {
  const speed = length2(v.x, v.z);
  if (speed < 1e-9) {
    v.x = 0;
    v.z = 0;
    return;
  }
  if (speed <= floorSpeed) return;
  const control = speed < STOP_SPEED ? STOP_SPEED : speed;
  let newSpeed = speed - control * friction * dt;
  if (newSpeed < floorSpeed) newSpeed = floorSpeed;
  if (newSpeed < 0) newSpeed = 0;
  const scale = newSpeed / speed;
  v.x = v.x * scale;
  v.z = v.z * scale;
}

/**
 * Accelerates toward `wishDir` without ever exceeding `wishSpeed` *in that
 * direction*. The total horizontal speed is NOT capped — that projection is
 * precisely what makes strafe-jumping work, and strafe-jumping is a feature.
 */
function accelerate(
  v: MutVec3,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  dt: number
): void {
  if (wishSpeed <= 0) return;
  const current = v.x * wishX + v.z * wishZ;
  const add = wishSpeed - current;
  if (add <= 0) return;
  let a = accel * dt;
  if (a > add) a = add;
  v.x = v.x + wishX * a;
  v.z = v.z + wishZ * a;
}

// ---------------------------------------------------------------------------
// Collision response
// ---------------------------------------------------------------------------

interface MoveOut {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  blocked: boolean;
}

const SWEEP_FROM: Vec3 = { x: 0, y: 0, z: 0 };
const SWEEP_TO: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Sweep-and-slide. Never teleports: `capsuleSweep` finds a time of impact by
 * sub-stepping finer than the thinnest brush in the map, so a high-speed move
 * cannot tunnel.
 *
 * NOTE: the scratch vectors above are written before every read inside this
 * synchronous call. They exist so the hot path does not allocate; they cannot
 * carry information between calls and therefore cannot affect determinism.
 */
function slideMove(
  world: CollisionWorld,
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
  time: number,
  radius: number,
  height: number,
  grounded: boolean,
  out: MoveOut
): void {
  let x = px;
  let y = py;
  let z = pz;
  let ax = vx;
  let ay = vy;
  let az = vz;
  let timeLeft = time;
  let blocked = false;

  for (let i = 0; i < SLIDE_ITERATIONS; i++) {
    if (timeLeft <= 0) break;
    if (ax * ax + ay * ay + az * az < 1e-14) break;

    SWEEP_FROM.x = x;
    SWEEP_FROM.y = y;
    SWEEP_FROM.z = z;
    SWEEP_TO.x = x + ax * timeLeft;
    SWEEP_TO.y = y + ay * timeLeft;
    SWEEP_TO.z = z + az * timeLeft;

    const r = capsuleSweep(world, SWEEP_FROM, SWEEP_TO, radius, height);
    x = r.position.x;
    y = r.position.y;
    z = r.position.z;
    if (!r.hit) {
      timeLeft = 0;
      break;
    }
    blocked = true;
    timeLeft = timeLeft * (1 - r.fraction);

    let nx = r.normal.x;
    let ny = r.normal.y;
    let nz = r.normal.z;

    // A surface steeper than MAX_SLOPE is a wall, not a floor: flatten its
    // normal so a grounded player slides along it instead of riding up it.
    if (grounded && ny > 0 && ny < MIN_WALK_NORMAL_Y) {
      const hl = length2(nx, nz);
      if (hl > 1e-6) {
        nx = nx / hl;
        nz = nz / hl;
        ny = 0;
      }
    }

    const d = ax * nx + ay * ny + az * nz;
    if (d < 0) {
      ax = ax - nx * d;
      ay = ay - ny * d;
      az = az - nz * d;
    }
  }

  out.x = x;
  out.y = y;
  out.z = z;
  out.vx = ax;
  out.vy = ay;
  out.vz = az;
  out.blocked = blocked;
}

const OUT_A: MoveOut = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, blocked: false };
const OUT_B: MoveOut = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, blocked: false };
const DEPEN_OUT: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Slide move with an auto step-up of at most `STEP_HEIGHT`, Quake-3 style:
 * run the plain move, then run the same move raised by the step height and
 * dropped back down, and keep whichever travelled further horizontally.
 * Only ever attempted from the ground.
 */
function stepSlideMove(
  world: CollisionWorld,
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
  time: number,
  radius: number,
  height: number,
  grounded: boolean,
  out: MoveOut
): void {
  slideMove(world, px, py, pz, vx, vy, vz, time, radius, height, grounded, OUT_A);
  if (!grounded || !OUT_A.blocked) {
    copyOut(OUT_A, out);
    return;
  }

  // 1. Rise.
  SWEEP_FROM.x = px;
  SWEEP_FROM.y = py;
  SWEEP_FROM.z = pz;
  SWEEP_TO.x = px;
  SWEEP_TO.y = py + STEP_HEIGHT;
  SWEEP_TO.z = pz;
  const up = capsuleSweep(world, SWEEP_FROM, SWEEP_TO, radius, height);
  const upY = up.position.y;
  const risen = upY - py;
  if (risen <= COLLISION_SKIN) {
    copyOut(OUT_A, out);
    return;
  }

  // 2. Move across at the raised height.
  slideMove(world, px, upY, pz, vx, vy, vz, time, radius, height, grounded, OUT_B);

  // 3. Fall back down onto whatever is below.
  SWEEP_FROM.x = OUT_B.x;
  SWEEP_FROM.y = OUT_B.y;
  SWEEP_FROM.z = OUT_B.z;
  SWEEP_TO.x = OUT_B.x;
  SWEEP_TO.y = OUT_B.y - (risen + STEP_HEIGHT);
  SWEEP_TO.z = OUT_B.z;
  const down = capsuleSweep(world, SWEEP_FROM, SWEEP_TO, radius, height);
  if (!down.hit || down.normal.y < MIN_WALK_NORMAL_Y) {
    copyOut(OUT_A, out);
    return;
  }
  OUT_B.y = down.position.y;
  if (OUT_B.vy < 0) OUT_B.vy = 0;

  const dxA = OUT_A.x - px;
  const dzA = OUT_A.z - pz;
  const dxB = OUT_B.x - px;
  const dzB = OUT_B.z - pz;
  if (dxB * dxB + dzB * dzB > dxA * dxA + dzA * dzA) copyOut(OUT_B, out);
  else copyOut(OUT_A, out);
}

function copyOut(src: MoveOut, dst: MoveOut): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.vx = src.vx;
  dst.vy = src.vy;
  dst.vz = src.vz;
  dst.blocked = src.blocked;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

const OUT_MOVE: MoveOut = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, blocked: false };

/**
 * Advances one player by exactly one tick.
 *
 * `dt` is normally `TICK_DT`. `world` comes from `createCollisionWorld()`.
 * The returned state is a new object; the argument is never touched.
 */
export function applyMovement(
  state: MovementState,
  input: ClientInput,
  dt: number,
  world: CollisionWorld
): MoveResult {
  const s: MovementState = {
    ...state,
    position: { x: state.position.x, y: state.position.y, z: state.position.z },
    velocity: { x: state.velocity.x, y: state.velocity.y, z: state.velocity.z },
  };

  const pos = s.position as MutVec3;
  const vel = s.velocity as MutVec3;

  // --- 1. View angles ------------------------------------------------------
  s.yaw = wrapAngle(input.yaw);
  s.pitch = clampf(input.pitch, -PITCH_LIMIT, PITCH_LIMIT);

  // --- 2. Buttons and edges ------------------------------------------------
  const buttons = input.buttons | 0;
  const prevButtons = state.prevButtons === undefined ? 0 : state.prevButtons | 0;
  s.prevButtons = buttons;

  const alive = s.alive;
  const jumpDown = alive && (buttons & InputButton.Jump) !== 0;
  const jumpPressed = jumpDown && (prevButtons & InputButton.Jump) === 0;
  const crouchDown = alive && (buttons & InputButton.Crouch) !== 0;
  const crouchPressed = crouchDown && (prevButtons & InputButton.Crouch) === 0;
  const sprintDown = alive && (buttons & InputButton.Sprint) !== 0;

  // --- 3. Wish direction ---------------------------------------------------
  const moveX = alive ? clampf(input.moveX, -1, 1) : 0;
  const moveZ = alive ? clampf(input.moveZ, -1, 1) : 0;

  // yaw = 0 looks down -Z (shared/types.ts). forward = (-sin, 0, -cos).
  const sy = Math.sin(s.yaw);
  const cy = Math.cos(s.yaw);
  const fwdX = -sy;
  const fwdZ = -cy;
  const rgtX = cy;
  const rgtZ = -sy;

  let wishX = fwdX * moveZ + rgtX * moveX;
  let wishZ = fwdZ * moveZ + rgtZ * moveX;
  let wishLen = length2(wishX, wishZ);
  if (wishLen > 1e-6) {
    wishX = wishX / wishLen;
    wishZ = wishZ / wishLen;
  } else {
    wishX = 0;
    wishZ = 0;
    wishLen = 0;
  }
  const wishScale = wishLen > 1 ? 1 : wishLen;

  // --- 4. Sprint ramp ------------------------------------------------------
  const wantsSprint = sprintDown && moveZ > 0 && wishLen > 0.1 && s.stance !== Stance.Prone;
  if (wantsSprint) s.sprintTime = s.sprintTime + dt;
  else s.sprintTime = 0;
  const sprinting = wantsSprint && s.sprintTime >= SPRINT_RAMP;

  // --- 5. Timers -----------------------------------------------------------
  if (s.slideCooldown > 0) {
    s.slideCooldown = s.slideCooldown - dt;
    if (s.slideCooldown < 0) s.slideCooldown = 0;
  }
  const proneTimePrev = s.proneTime === undefined ? 0 : s.proneTime;
  let proneTime = proneTimePrev > 0 ? proneTimePrev - dt : 0;
  if (proneTime < 0) proneTime = 0;

  // --- 6. Stance -----------------------------------------------------------
  const horizSpeed = length2(vel.x, vel.z);

  if (
    crouchPressed &&
    s.onGround &&
    s.stance === Stance.Stand &&
    sprinting &&
    horizSpeed >= SLIDE_MIN_SPEED &&
    s.slideCooldown <= 0
  ) {
    s.stance = Stance.Slide;
    s.slideTime = SLIDE_DURATION;
    const target = SLIDE_SPEED_MULT * SPEED_SPRINT;
    if (horizSpeed > 1e-6) {
      const k = target / horizSpeed;
      vel.x = vel.x * k;
      vel.z = vel.z * k;
    }
  } else if (s.stance === Stance.Slide) {
    s.slideTime = s.slideTime - dt;
    if (s.slideTime <= 0 || !s.onGround) {
      s.stance = Stance.Crouch;
      s.slideTime = 0;
      s.slideCooldown = SLIDE_COOLDOWN;
    }
  } else if (crouchDown && s.onGround && s.stance === Stance.Stand) {
    s.stance = Stance.Crouch;
  }

  // Standing back up is blocked when there is no room for the taller capsule.
  if (!crouchDown && s.stance !== Stance.Slide) {
    if (s.stance === Stance.Prone && proneTime <= 0) {
      if (!capsuleOverlap(world, pos, PLAYER_RADIUS, PLAYER_HEIGHT_CROUCH)) s.stance = Stance.Crouch;
    }
    if (s.stance === Stance.Crouch) {
      if (!capsuleOverlap(world, pos, PLAYER_RADIUS, PLAYER_HEIGHT_STAND)) s.stance = Stance.Stand;
    }
  }

  // --- 7. Target speed -----------------------------------------------------
  const adsActive = s.adsState === AdsState.Raising || s.adsState === AdsState.Scoped;
  let targetSpeed: number;
  if (s.stance === Stance.Prone) targetSpeed = SPEED_PRONE;
  else if (s.stance === Stance.Crouch) targetSpeed = SPEED_CROUCH;
  else if (adsActive) {
    targetSpeed = state.adsMoveSpeedOverride === undefined ? SPEED_ADS : state.adsMoveSpeedOverride;
  } else if (sprinting) targetSpeed = SPEED_SPRINT;
  else targetSpeed = SPEED_WALK;
  targetSpeed = targetSpeed * wishScale;
  // ZOMBIES: ADRENALINE perk. Both sides set speedMult from the same perk
  // state, so prediction and server stay bit-identical (undefined = 1).
  if (state.speedMult !== undefined) targetSpeed = targetSpeed * state.speedMult;

  // --- 8. Friction and acceleration ---------------------------------------
  if (s.onGround) {
    if (s.stance === Stance.Slide) {
      applyFriction(vel, SLIDE_FRICTION, dt, 0);
    } else {
      applyFriction(vel, FRICTION, dt, targetSpeed);
      accelerate(vel, wishX, wishZ, targetSpeed, ACCEL_GROUND, dt);
    }
  } else {
    accelerate(vel, wishX, wishZ, targetSpeed, ACCEL_AIR * AIR_CONTROL, dt);
  }

  // --- 9. Jump (rising edge only — holding the key never re-jumps) ---------
  let jumped = false;
  if (jumpPressed && s.onGround && s.stance !== Stance.Prone) {
    vel.y = JUMP_IMPULSE;
    s.onGround = false;
    jumped = true;
    if (s.stance === Stance.Slide) {
      s.stance = Stance.Crouch;
      s.slideTime = 0;
      s.slideCooldown = SLIDE_COOLDOWN;
    }
  }

  // --- 10. Gravity, first half --------------------------------------------
  // Leapfrog: half before the integration, half after. This makes the sampled
  // positions land exactly on the analytic parabola, so the apex of a jump is
  // the documented value on every machine.
  const airborne = !s.onGround;
  if (airborne) vel.y = vel.y - GRAVITY * dt * 0.5;
  else vel.y = 0;

  const fallSpeed = -vel.y;

  // --- 11. Integrate and collide ------------------------------------------
  const height = heightForStance(s.stance);
  const groundedStart = s.onGround && !jumped;

  capsuleDepenetrate(world, pos, PLAYER_RADIUS, height, DEPEN_ITERATIONS, DEPEN_OUT);
  pos.x = DEPEN_OUT.x;
  pos.y = DEPEN_OUT.y;
  pos.z = DEPEN_OUT.z;

  stepSlideMove(
    world,
    pos.x,
    pos.y,
    pos.z,
    vel.x,
    vel.y,
    vel.z,
    dt,
    PLAYER_RADIUS,
    height,
    groundedStart,
    OUT_MOVE
  );
  pos.x = OUT_MOVE.x;
  pos.y = OUT_MOVE.y;
  pos.z = OUT_MOVE.z;
  vel.x = OUT_MOVE.vx;
  vel.y = OUT_MOVE.vy;
  vel.z = OUT_MOVE.vz;

  capsuleDepenetrate(world, pos, PLAYER_RADIUS, height, DEPEN_ITERATIONS, DEPEN_OUT);
  pos.x = DEPEN_OUT.x;
  pos.y = DEPEN_OUT.y;
  pos.z = DEPEN_OUT.z;

  // --- 12. Gravity, second half -------------------------------------------
  if (airborne) vel.y = vel.y - GRAVITY * dt * 0.5;

  // --- 13. Ground detection / snap ----------------------------------------
  let onGroundNew = false;
  if (!jumped && (groundedStart || vel.y <= 0)) {
    const probe = groundedStart ? STEP_HEIGHT : AIR_GROUND_PROBE;
    SWEEP_FROM.x = pos.x;
    SWEEP_FROM.y = pos.y;
    SWEEP_FROM.z = pos.z;
    SWEEP_TO.x = pos.x;
    SWEEP_TO.y = pos.y - probe;
    SWEEP_TO.z = pos.z;
    const g = capsuleSweep(world, SWEEP_FROM, SWEEP_TO, PLAYER_RADIUS, height);
    if (g.hit && g.normal.y >= MIN_WALK_NORMAL_Y) {
      pos.y = g.position.y;
      onGroundNew = true;
    }
  }

  const landed = onGroundNew && !state.onGround;
  s.onGround = onGroundNew;
  if (onGroundNew && vel.y < 0) vel.y = 0;

  // --- 14. Drop-shot: crouch held through a landing goes prone ------------
  if (landed && crouchDown && s.stance !== Stance.Slide && s.stance !== Stance.Prone) {
    s.stance = Stance.Prone;
    proneTime = PRONE_TRANSITION;
  }
  s.proneTime = proneTime;

  return {
    state: s,
    landed,
    impactSpeed: landed && fallSpeed > 0 ? fallSpeed : 0,
  };
}

// ---------------------------------------------------------------------------
// Convenience helpers (pure; safe for any subsystem to call)
// ---------------------------------------------------------------------------

/** Unit forward vector for a yaw, matching the convention in shared/types.ts. */
export function forwardFromYaw(yaw: number, out: Vec3): Vec3 {
  out.x = -Math.sin(yaw);
  out.y = 0;
  out.z = -Math.cos(yaw);
  return out;
}

/** Unit view direction from yaw+pitch. Positive pitch looks up. */
export function viewDirection(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Horizontal speed of a state, in m/s. */
export function horizontalSpeed(state: PlayerState): number {
  return length2(state.velocity.x, state.velocity.z);
}
