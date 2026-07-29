/**
 * DECKSHOT — wire quantization.
 *
 * Owner: netcode-core.
 *
 * Every number that crosses the socket passes through here, and NOTHING else
 * in the project is allowed to invent its own fixed-point scheme. There is one
 * reason for that, and it is the single most expensive bug in netcode:
 *
 *   The server simulates in f64, sends a quantized value, and then keeps
 *   simulating from the f64. The client reconciles against the quantized value
 *   it received. The two now disagree by up to half a quantization step,
 *   forever, on every axis, every snapshot — and the client's reconciliation
 *   loop spends the rest of the match arguing with the server about two
 *   millimetres.
 *
 * The fix is not a bigger epsilon. The fix is that the server STORES what it
 * SENT: `snapPositionInPlace` / `snapVelocityInPlace` are applied to the
 * authoritative state at snapshot time, so the value the server continues
 * simulating from is bit-identical to the value the client reconciles to.
 * See `server/src/net/room.ts`.
 *
 * The symmetric half of the same bug lives on the client: the input angles the
 * client predicts with must be the quantized angles it actually sent, not the
 * raw mouse-derived floats. See `snapInputInPlace`.
 *
 * Every quantize/dequantize pair here is a projection: `q(d(q(x))) === q(x)`
 * for all x, and `d(q(d(v))) === d(v)` for all representable v. That is tested.
 */

import { ANGLE_QUANTIZATION, POS_QUANTIZATION, WORLD_HALF_EXTENT } from './tuning.js';
import type { ClientInput, Vec3 } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed-point steps per meter. 256 with the frozen POS_QUANTIZATION. */
export const POS_STEPS_PER_METER = 1 / POS_QUANTIZATION;

/** Velocity resolution, m/s per step. i16 gives +/- 512 m/s of headroom. */
export const VEL_QUANTIZATION = 1 / 64;
export const VEL_STEPS_PER_MPS = 1 / VEL_QUANTIZATION;

/** Angle steps in a full turn. 65536 with the frozen ANGLE_QUANTIZATION. */
export const ANGLE_STEPS = Math.round((2 * Math.PI) / ANGLE_QUANTIZATION);

/** Move axes are i8; the protocol documents -127..127 mapping to -1..1. */
export const MOVE_AXIS_SCALE = 127;

const U16_MAX = 0xffff;
const I16_MIN = -0x8000;
const I16_MAX = 0x7fff;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Round-half-up, matching `Math.round`, but with NaN mapped to 0 so a poisoned
 * simulation value can never produce a garbage byte pattern. `Math.round` is
 * exactly specified by ECMA-262, so this is identical on Node and in browsers.
 */
function iround(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v);
}

// ---------------------------------------------------------------------------
// Position — u16 fixed point over [-WORLD_HALF_EXTENT, +WORLD_HALF_EXTENT)
// ---------------------------------------------------------------------------

/**
 * 256 m of range at 1/256 m resolution is exactly 65536 steps, so the encoding
 * uses the full u16 with no waste and no rounding slack. Both the offset and
 * the scale are powers of two, which makes the round trip binary-exact rather
 * than merely close.
 */
export function quantizePos(v: number): number {
  return clampInt(iround((v + WORLD_HALF_EXTENT) * POS_STEPS_PER_METER), 0, U16_MAX);
}

export function dequantizePos(q: number): number {
  return q * POS_QUANTIZATION - WORLD_HALF_EXTENT;
}

/** The value `v` becomes after a wire round trip. */
export function snapPos(v: number): number {
  return dequantizePos(quantizePos(v));
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

/**
 * Yaw — u16, one full turn. The modulo is taken in *step space*, not in
 * radians: wrapping the float first and then dividing loses a step at the
 * seam, and that lost step is a permanent 1-LSB disagreement between the two
 * sides on a value the player is holding still.
 */
export function quantizeAngle(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  let q = Math.round(rad / ANGLE_QUANTIZATION) % ANGLE_STEPS;
  if (q < 0) q += ANGLE_STEPS;
  return q;
}

/** Returns radians in (-PI, PI], matching `wrapAngle` in shared/movement.ts. */
export function dequantizeAngle(q: number): number {
  const i = ((q % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;
  const signed = i > ANGLE_STEPS / 2 ? i - ANGLE_STEPS : i;
  return signed * ANGLE_QUANTIZATION;
}

export function snapAngle(rad: number): number {
  return dequantizeAngle(quantizeAngle(rad));
}

/**
 * Pitch — i16, same step size. Pitch is clamped to +/- PITCH_LIMIT (89 deg) by
 * the movement code and never wraps, so a signed value with no modulo is both
 * correct and one branch cheaper.
 */
export function quantizePitch(rad: number): number {
  return clampInt(iround(rad / ANGLE_QUANTIZATION), I16_MIN, I16_MAX);
}

export function dequantizePitch(q: number): number {
  return q * ANGLE_QUANTIZATION;
}

export function snapPitch(rad: number): number {
  return dequantizePitch(quantizePitch(rad));
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

export function quantizeVel(v: number): number {
  return clampInt(iround(v * VEL_STEPS_PER_MPS), I16_MIN, I16_MAX);
}

export function dequantizeVel(q: number): number {
  return q * VEL_QUANTIZATION;
}

export function snapVel(v: number): number {
  return dequantizeVel(quantizeVel(v));
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** 0..1 as u8. Used for adsProgress. */
export function quantizeUnit(v: number): number {
  return clampInt(iround(v * 255), 0, 255);
}

export function dequantizeUnit(q: number): number {
  return q / 255;
}

export function snapUnit(v: number): number {
  return dequantizeUnit(quantizeUnit(v));
}

/** Input axis, -1..1 as i8 over -127..127 (the protocol's documented range). */
export function quantizeAxis(v: number): number {
  return clampInt(iround(v * MOVE_AXIS_SCALE), -MOVE_AXIS_SCALE, MOVE_AXIS_SCALE);
}

export function dequantizeAxis(q: number): number {
  return clampInt(q, -MOVE_AXIS_SCALE, MOVE_AXIS_SCALE) / MOVE_AXIS_SCALE;
}

export function snapAxis(v: number): number {
  return dequantizeAxis(quantizeAxis(v));
}

// ---------------------------------------------------------------------------
// Whole-value snapping — what the authoritative side stores
// ---------------------------------------------------------------------------

/** Mutates `v` into the value the wire would deliver. */
export function snapPositionInPlace(v: Vec3): void {
  v.x = snapPos(v.x);
  v.y = snapPos(v.y);
  v.z = snapPos(v.z);
}

export function snapVelocityInPlace(v: Vec3): void {
  v.x = snapVel(v.x);
  v.y = snapVel(v.y);
  v.z = snapVel(v.z);
}

/**
 * Mutates an input into exactly what the wire will carry.
 *
 * The client MUST call this before feeding the input to its prediction, and
 * before storing it in the replay buffer. If it predicts with the raw float
 * yaw but transmits a 16-bit yaw, the server's movement runs with a very
 * slightly different facing, the two integrate different velocity vectors, and
 * the position error grows without bound until it trips RECONCILE_EPSILON —
 * which looks exactly like packet loss and is not.
 */
export function snapInputInPlace(input: ClientInput): ClientInput {
  input.moveX = snapAxis(input.moveX);
  input.moveZ = snapAxis(input.moveZ);
  input.yaw = snapAngle(input.yaw);
  input.pitch = snapPitch(input.pitch);
  input.seq = input.seq & 0xffff;
  input.tick = input.tick >>> 0;
  input.buttons = input.buttons & 0xffff;
  return input;
}
