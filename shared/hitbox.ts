/**
 * DECKSHOT — player hitboxes and ray-vs-capsule intersection.
 *
 * Owner: weapons-hitreg.
 *
 * Seven capsules per player. This file decides whether the shot the player took
 * counted, and nothing makes people quit a shooter faster than hit registration
 * that lies. It is therefore deliberately boring: closed-form ray/capsule maths,
 * a nearest-hit rule with one documented tie-break, and no cleverness.
 *
 * Engine-free.
 */

import {
  PLAYER_HEIGHT_STAND,
  PLAYER_RADIUS,
  heightForStance,
} from './tuning.js';
import { HitboxPart, Stance } from './types.js';
import type { HitboxCapsule, PlayerState, Vec3 } from './types.js';

/** Slop for "same distance" comparisons, meters. */
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The standing skeleton, in player-local space: +Y up, origin at the FEET,
 * +X to the player's right, -Z forward (matching the yaw convention in
 * `shared/types.ts`).
 *
 * Authored against `PLAYER_HEIGHT_STAND` (1.75m) and `PLAYER_RADIUS` (0.35m):
 * the widest point is an arm at 0.265 + 0.085 = 0.35 from the axis, so the
 * hitboxes fill the collision capsule exactly and never poke out of it. A
 * hitbox wider than the collider is the classic "shot me through the wall" bug.
 *
 * THE HEAD IS SMALL ON PURPOSE. 0.105m radius over a 0.065m segment is a 21cm
 * ball sitting between y=1.47 and y=1.745 — roughly a real head. Sniper
 * headshots are already lethal on a body hit; the head capsule exists for the
 * trickshot flag, not for damage, so making it generous would only hand out free
 * HEADSHOT banners.
 *
 * THE CHEST STOPS EXACTLY WHERE THE HEAD STARTS (both at y = 1.47). That is not
 * cosmetic. Under the stance squash below, any overlap between the two grows as
 * the player gets shorter, and a chest capsule that bulges into the head is what
 * makes crouched headshots silently stop registering. Butting them together
 * standing leaves a real head-only band at every stance.
 */
export const HITBOX_TEMPLATE: readonly HitboxCapsule[] = Object.freeze([
  {
    part: HitboxPart.Head,
    a: { x: 0, y: 1.575, z: 0 },
    b: { x: 0, y: 1.64, z: 0 },
    radius: 0.105,
  },
  {
    part: HitboxPart.Chest,
    a: { x: 0, y: 1.06, z: 0 },
    b: { x: 0, y: 1.275, z: 0 },
    radius: 0.195,
  },
  {
    part: HitboxPart.Stomach,
    a: { x: 0, y: 0.9, z: 0 },
    b: { x: 0, y: 1.02, z: 0 },
    radius: 0.185,
  },
  {
    part: HitboxPart.ArmL,
    a: { x: -0.265, y: 0.95, z: 0 },
    b: { x: -0.265, y: 1.33, z: 0 },
    radius: 0.085,
  },
  {
    part: HitboxPart.ArmR,
    a: { x: 0.265, y: 0.95, z: 0 },
    b: { x: 0.265, y: 1.33, z: 0 },
    radius: 0.085,
  },
  {
    part: HitboxPart.LegL,
    a: { x: -0.115, y: 0.12, z: 0 },
    b: { x: -0.115, y: 0.8, z: 0 },
    radius: 0.115,
  },
  {
    part: HitboxPart.LegR,
    a: { x: 0.115, y: 0.12, z: 0 },
    b: { x: 0.115, y: 0.8, z: 0 },
    radius: 0.115,
  },
] as HitboxCapsule[]);

/**
 * Vertical scale for a stance: the standing skeleton is squashed toward the
 * feet by `heightForStance(stance) / PLAYER_HEIGHT_STAND`.
 *
 * ONLY Y IS SCALED. A crouching player is shorter, not thinner — scaling the
 * radii would shrink a prone head to a 3.6cm ball that no human could hit, and
 * would pull the arms inside the collision capsule so shots that visually
 * connect would pass through. The consequence is that a prone player's head sits
 * a few centimetres above `PLAYER_HEIGHT_PRONE`, which is correct: a prone body
 * lifts its head to aim.
 *
 * Prone keeps the upright arrangement rather than lying the capsules down,
 * because the movement module's collision capsule stays upright too. A
 * horizontal hitbox set would extend past the collider and let a prone player be
 * shot through cover their body is genuinely behind.
 */
export function stanceScale(stance: Stance): number {
  return heightForStance(stance) / PLAYER_HEIGHT_STAND;
}

/** Half-width of the widest hitbox, meters. Equals PLAYER_RADIUS by design. */
export const HITBOX_MAX_RADIUS = PLAYER_RADIUS;

/**
 * The capsule set for a stance, still in PLAYER-LOCAL space.
 * Allocates; intended for debug rendering and tests, not the hot path.
 */
export function hitboxesForStance(stance: Stance): HitboxCapsule[] {
  const s = stanceScale(stance);
  const out: HitboxCapsule[] = [];
  for (let i = 0; i < HITBOX_TEMPLATE.length; i++) {
    const c = HITBOX_TEMPLATE[i];
    out.push({
      part: c.part,
      a: { x: c.a.x, y: c.a.y * s, z: c.a.z },
      b: { x: c.b.x, y: c.b.y * s, z: c.b.z },
      radius: c.radius,
    });
  }
  return out;
}

/**
 * The capsule set for a player, in WORLD space: stance-scaled, rotated by yaw,
 * translated to the feet position.
 *
 * Allocates seven capsules — for debug overlays and lag-compensation
 * visualisation. `rayVsPlayer` does the same transform inline without
 * allocating and is what the shot path calls.
 */
export function hitboxesFor(state: PlayerState): HitboxCapsule[] {
  const s = stanceScale(state.stance);
  const yaw = state.yaw;
  // yaw 0 looks down -Z, so forward = (-sin, 0, -cos) and right = (cos, 0, -sin).
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const px = state.position.x;
  const py = state.position.y;
  const pz = state.position.z;

  const out: HitboxCapsule[] = [];
  for (let i = 0; i < HITBOX_TEMPLATE.length; i++) {
    const c = HITBOX_TEMPLATE[i];
    out.push({
      part: c.part,
      a: {
        x: px + c.a.x * rx + c.a.z * fx,
        y: py + c.a.y * s,
        z: pz + c.a.x * rz + c.a.z * fz,
      },
      b: {
        x: px + c.b.x * rx + c.b.z * fx,
        y: py + c.b.y * s,
        z: pz + c.b.x * rz + c.b.z * fz,
      },
      radius: c.radius,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ray vs capsule
// ---------------------------------------------------------------------------

/**
 * Nearest intersection of a ray with a capsule (segment A-B, radius r).
 * Returns the distance along `dir` (which MUST be unit length), or -1 on a miss.
 *
 * Solves the infinite-cylinder quadratic in the segment's frame and falls back
 * to the two end spheres when the cylinder solution lands outside the segment.
 * A ray that STARTS inside the capsule returns 0 — a point-blank shot from
 * inside someone's chest is a hit, not a miss. (This is the opposite of
 * `raycastWorld`'s convention for brushes, which reports a miss from inside so a
 * shooter clipped into geometry cannot self-block. Different rule, different
 * reason: for players, inside means touching.)
 */
export function rayVsCapsule(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  maxDist: number,
): number {
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const oax = ox - ax;
  const oay = oy - ay;
  const oaz = oz - az;

  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const r2 = radius * radius;

  // Already inside? Distance from the origin to the segment.
  {
    const t = baba > 1e-12 ? clamp01(baoa / baba) : 0;
    const cx = oax - bax * t;
    const cy = oay - bay * t;
    const cz = oaz - baz * t;
    if (cx * cx + cy * cy + cz * cz <= r2) return 0;
  }

  let best = -1;

  if (baba > 1e-12) {
    const qa = baba - bard * bard;
    const qb = baba * rdoa - baoa * bard;
    const qc = baba * oaoa - baoa * baoa - r2 * baba;
    if (qa > 1e-12 || qa < -1e-12) {
      const h = qb * qb - qa * qc;
      if (h >= 0) {
        const t = (-qb - Math.sqrt(h)) / qa;
        const y = baoa + t * bard;
        if (t >= 0 && y > 0 && y < baba) best = t;
      }
    }
  }

  // End spheres. Always tested: the cylinder solution excludes the caps, and a
  // ray parallel to the axis has no cylinder solution at all.
  if (best < 0) {
    const ta = raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r2);
    const tb = raySphere(ox, oy, oz, dx, dy, dz, bx, by, bz, r2);
    if (ta >= 0 && (best < 0 || ta < best)) best = ta;
    if (tb >= 0 && (best < 0 || tb < best)) best = tb;
  }

  if (best < 0 || best > maxDist) return -1;
  return best;
}

function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r2: number,
): number {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r2;
  if (c > 0 && b > 0) return -1; // pointing away from a sphere we are outside of
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface PlayerRayHit {
  part: HitboxPart;
  /** Distance along `dir` from `origin`, meters. */
  t: number;
}

/**
 * Nearest hitbox a ray strikes on one player, or null.
 *
 * `dir` MUST be unit length. `state` is whatever the caller hands over — on the
 * server that is the LAG-COMPENSATED (rewound) state, which is why this function
 * takes a state instead of looking one up.
 *
 * TIE-BREAK: when two capsules are struck at the same distance (within 1e-6m,
 * which happens constantly in the neck/shoulder region where capsules overlap),
 * HEAD WINS. The alternative — whichever capsule happened to be earlier in the
 * array — makes headshots feel random, and a sniper game is largely about
 * whether the headshot counted.
 */
export function rayVsPlayer(
  origin: Vec3,
  dir: Vec3,
  state: PlayerState,
  maxDist = Number.POSITIVE_INFINITY,
): PlayerRayHit | null {
  const s = stanceScale(state.stance);
  const yaw = state.yaw;
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const px = state.position.x;
  const py = state.position.y;
  const pz = state.position.z;

  // Cheap reject: sphere around the whole player.
  const height = heightForStance(state.stance);
  const midY = py + height * 0.5;
  const bound = height * 0.5 + HITBOX_MAX_RADIUS + 0.15;
  const mx = px - origin.x;
  const my = midY - origin.y;
  const mz = pz - origin.z;
  const along = mx * dir.x + my * dir.y + mz * dir.z;
  if (along < -bound) return null;
  if (along - bound > maxDist) return null;
  {
    const perpX = mx - dir.x * along;
    const perpY = my - dir.y * along;
    const perpZ = mz - dir.z * along;
    if (perpX * perpX + perpY * perpY + perpZ * perpZ > bound * bound) return null;
  }

  let bestT = -1;
  let bestPart: HitboxPart = HitboxPart.Chest;

  for (let i = 0; i < HITBOX_TEMPLATE.length; i++) {
    const c = HITBOX_TEMPLATE[i];
    const ax = px + c.a.x * rx + c.a.z * fx;
    const ay = py + c.a.y * s;
    const az = pz + c.a.x * rz + c.a.z * fz;
    const bx = px + c.b.x * rx + c.b.z * fx;
    const by = py + c.b.y * s;
    const bz = pz + c.b.x * rz + c.b.z * fz;

    const t = rayVsCapsule(
      origin.x,
      origin.y,
      origin.z,
      dir.x,
      dir.y,
      dir.z,
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      c.radius,
      maxDist,
    );
    if (t < 0) continue;

    if (bestT < 0 || t < bestT - EPS) {
      bestT = t;
      bestPart = c.part;
    } else if (t <= bestT + EPS && c.part === HitboxPart.Head) {
      // Same distance, and one of them is the head. The head takes it.
      bestT = t;
      bestPart = HitboxPart.Head;
    }
  }

  if (bestT < 0) return null;
  return { part: bestPart, t: bestT };
}

/**
 * World-space centre of a hitbox part, for killcams, hitmarker placement and
 * debug. Returns the midpoint of the capsule segment.
 */
export function hitboxCenter(state: PlayerState, part: HitboxPart, out: Vec3): Vec3 {
  const s = stanceScale(state.stance);
  const yaw = state.yaw;
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  let c: HitboxCapsule = HITBOX_TEMPLATE[1];
  for (let i = 0; i < HITBOX_TEMPLATE.length; i++) {
    if (HITBOX_TEMPLATE[i].part === part) c = HITBOX_TEMPLATE[i];
  }
  const lx = (c.a.x + c.b.x) * 0.5;
  const ly = (c.a.y + c.b.y) * 0.5;
  const lz = (c.a.z + c.b.z) * 0.5;
  out.x = state.position.x + lx * rx + lz * fx;
  out.y = state.position.y + ly * s;
  out.z = state.position.z + lx * rz + lz * fz;
  return out;
}
