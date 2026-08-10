/**
 * DECKSHOT — static collision world.
 *
 * Owned by: physics-movement.
 *
 * Pure TypeScript. No engine, no DOM, no Node APIs, no allocation in the hot
 * path, no module-level mutable state that can leak between calls (the scratch
 * variables below are written-then-read inside a single synchronous call and
 * are fully determined by the arguments).
 *
 * The world is built ONCE from `BRUSHES` at module load and cached. Brushes are
 * oriented boxes: `center`, `half`, `yaw` (about +Y) and `pitch` (about the
 * local X axis, applied after yaw). Ramps are handled as true OBBs — never
 * approximated by their AABB — so players walk up them on the real slope.
 *
 * Broadphase: a uniform 2D grid over XZ in CSR layout (the map is 26m x 70m and
 * only ~5m tall, so a Y axis buys nothing). Queries dedupe with a stamp array.
 */

import type { Vec3 } from './types.js';
import { BRUSHES, WATER_LEVEL, WORLD_BOUNDS } from './mapdata.js';
import type { Brush } from './mapdata.js';

export type { Brush };

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export interface RayHit {
  point: Vec3;
  normal: Vec3;
  brush: Brush;
  /** Distance along `dir` from `origin`. `dir` must be unit length. */
  t: number;
}

export interface SweepResult {
  hit: boolean;
  /** Fraction of `from`->`to` that was safely traversed, 0..1. */
  fraction: number;
  /** Safe position at `fraction`, already backed off by the collision skin. */
  position: Vec3;
  /** World-space surface normal at the impact. Zero vector when `!hit`. */
  normal: Vec3;
  /** World-space contact point. Equals `position` when `!hit`. */
  point: Vec3;
  brush: Brush | null;
}

/**
 * One brush, pre-transformed. `m**` are the columns of the local->world
 * rotation matrix: column 0 is the world direction of the brush's local X.
 */
export interface ColliderBox {
  brush: Brush;
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
  m20: number;
  m21: number;
  m22: number;
  /** True when yaw and pitch are both zero (fast path, still uses the OBB code). */
  axisAligned: boolean;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface CollisionWorld {
  readonly boxes: readonly ColliderBox[];
  readonly brushes: readonly Brush[];

  /**
   * Playable volume and sea level for THIS map. Sundeck's singleton carries the
   * mapdata constants; other maps (SURVIVAL's Leviathan) supply their own, so
   * `isOutOfBounds` no longer has to read module-level Sundeck constants.
   */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly waterLevel: number;

  // --- broadphase grid (CSR) ---
  readonly cell: number;
  readonly gminX: number;
  readonly gminZ: number;
  readonly nx: number;
  readonly nz: number;
  readonly cellStart: Int32Array;
  readonly cellItems: Int32Array;

  // --- scratch (never read across calls) ---
  mark: Int32Array;
  stamp: number;
  candSweep: Int32Array;
  candOverlap: Int32Array;
  candRay: Int32Array;
}

// ---------------------------------------------------------------------------
// Tunables local to collision
// ---------------------------------------------------------------------------

/** Broadphase cell size, meters. */
const CELL = 2.0;

/** Contact skin. Bodies rest this far off a surface so re-sweeps stay clean. */
export const COLLISION_SKIN = 1e-3;

/**
 * Penetration this shallow is a resting contact, not a collision.
 *
 * A body left exactly touching a surface (gap 0) can land a few ULPs on the
 * wrong side of it after the world<->local transform. Without this tolerance
 * such a contact reports as a blocking hit at fraction 0, which stalls the
 * slide loop and freezes the player against the floor they are standing on.
 * 1e-6 m is four orders of magnitude below the skin and eight below anything
 * a player can perceive.
 */
const CONTACT_TOL = 1e-6;

/**
 * Longest distance a swept capsule advances between overlap probes.
 * The thinnest brush in the map is 0.1m thick, so with a 0.35m capsule the
 * "detection band" of any wall is >= 0.8m wide — 0.16m sampling cannot skip it.
 */
const SWEEP_SUBSTEP = 0.16;
const SWEEP_MAX_STEPS = 96;
const SWEEP_BISECTIONS = 12;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function makeBox(brush: Brush): ColliderBox {
  const cy_ = Math.cos(brush.yaw);
  const sy_ = Math.sin(brush.yaw);
  const cp_ = Math.cos(brush.pitch);
  const sp_ = Math.sin(brush.pitch);

  // world = Ry(yaw) * Rx(pitch) * local
  const m00 = cy_;
  const m01 = sp_ * sy_;
  const m02 = cp_ * sy_;
  const m10 = 0;
  const m11 = cp_;
  const m12 = -sp_;
  const m20 = -sy_;
  const m21 = sp_ * cy_;
  const m22 = cp_ * cy_;

  const hx = brush.half.x;
  const hy = brush.half.y;
  const hz = brush.half.z;

  const ex = Math.abs(m00) * hx + Math.abs(m01) * hy + Math.abs(m02) * hz;
  const ey = Math.abs(m10) * hx + Math.abs(m11) * hy + Math.abs(m12) * hz;
  const ez = Math.abs(m20) * hx + Math.abs(m21) * hy + Math.abs(m22) * hz;

  return {
    brush,
    cx: brush.center.x,
    cy: brush.center.y,
    cz: brush.center.z,
    hx,
    hy,
    hz,
    m00,
    m01,
    m02,
    m10,
    m11,
    m12,
    m20,
    m21,
    m22,
    axisAligned: brush.yaw === 0 && brush.pitch === 0,
    minX: brush.center.x - ex,
    minY: brush.center.y - ey,
    minZ: brush.center.z - ez,
    maxX: brush.center.x + ex,
    maxY: brush.center.y + ey,
    maxZ: brush.center.z + ez,
  };
}

function buildWorld(
  brushes: readonly Brush[],
  bounds: { min: Vec3; max: Vec3 } = WORLD_BOUNDS,
  waterLevel: number = WATER_LEVEL,
): CollisionWorld {
  const boxes: ColliderBox[] = [];
  for (let i = 0; i < brushes.length; i++) boxes.push(makeBox(brushes[i]));

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.minX < minX) minX = b.minX;
    if (b.minZ < minZ) minZ = b.minZ;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  if (boxes.length === 0) {
    minX = 0;
    minZ = 0;
    maxX = 0;
    maxZ = 0;
  }

  const gminX = Math.floor(minX / CELL) * CELL;
  const gminZ = Math.floor(minZ / CELL) * CELL;
  const nx = Math.max(1, Math.floor((maxX - gminX) / CELL) + 1);
  const nz = Math.max(1, Math.floor((maxZ - gminZ) / CELL) + 1);
  const cellCount = nx * nz;

  // Counting pass.
  const counts = new Int32Array(cellCount + 1);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const x0 = clampInt(Math.floor((b.minX - gminX) / CELL), 0, nx - 1);
    const x1 = clampInt(Math.floor((b.maxX - gminX) / CELL), 0, nx - 1);
    const z0 = clampInt(Math.floor((b.minZ - gminZ) / CELL), 0, nz - 1);
    const z1 = clampInt(Math.floor((b.maxZ - gminZ) / CELL), 0, nz - 1);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) counts[z * nx + x + 1]++;
    }
  }
  for (let i = 0; i < cellCount; i++) counts[i + 1] += counts[i];

  const cellStart = counts;
  const cellItems = new Int32Array(cellStart[cellCount]);
  const cursor = new Int32Array(cellCount);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const x0 = clampInt(Math.floor((b.minX - gminX) / CELL), 0, nx - 1);
    const x1 = clampInt(Math.floor((b.maxX - gminX) / CELL), 0, nx - 1);
    const z0 = clampInt(Math.floor((b.minZ - gminZ) / CELL), 0, nz - 1);
    const z1 = clampInt(Math.floor((b.maxZ - gminZ) / CELL), 0, nz - 1);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const c = z * nx + x;
        cellItems[cellStart[c] + cursor[c]] = i;
        cursor[c]++;
      }
    }
  }

  return {
    boxes,
    brushes,
    bounds,
    waterLevel,
    cell: CELL,
    gminX,
    gminZ,
    nx,
    nz,
    cellStart,
    cellItems,
    mark: new Int32Array(boxes.length),
    stamp: 0,
    candSweep: new Int32Array(boxes.length),
    candOverlap: new Int32Array(boxes.length),
    candRay: new Int32Array(boxes.length),
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The cached Sundeck world. Built at module load; the competitive map never changes. */
const STATIC_WORLD: CollisionWorld = buildWorld(BRUSHES);

/**
 * Contracted factory. With no arguments it returns the cached Sundeck
 * singleton, exactly as before — every existing call site is untouched. Given
 * a brush set (SURVIVAL's Leviathan) it builds a fresh world carrying its own
 * bounds and water level. Callers of the multi-map form should cache the
 * result themselves; building is O(brushes).
 */
export function createCollisionWorld(
  brushes?: readonly Brush[],
  bounds?: { min: Vec3; max: Vec3 },
  waterLevel?: number,
): CollisionWorld {
  if (!brushes) return STATIC_WORLD;
  return buildWorld(brushes, bounds ?? WORLD_BOUNDS, waterLevel ?? WATER_LEVEL);
}

// ---------------------------------------------------------------------------
// Broadphase queries
// ---------------------------------------------------------------------------

/** Gathers colliders whose AABB overlaps the query box into `out`. Returns count. */
function gatherBox(
  w: CollisionWorld,
  out: Int32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number {
  const stamp = ++w.stamp;
  const mark = w.mark;
  const boxes = w.boxes;
  const x0 = clampInt(Math.floor((minX - w.gminX) / w.cell), 0, w.nx - 1);
  const x1 = clampInt(Math.floor((maxX - w.gminX) / w.cell), 0, w.nx - 1);
  const z0 = clampInt(Math.floor((minZ - w.gminZ) / w.cell), 0, w.nz - 1);
  const z1 = clampInt(Math.floor((maxZ - w.gminZ) / w.cell), 0, w.nz - 1);
  let n = 0;
  for (let z = z0; z <= z1; z++) {
    const row = z * w.nx;
    for (let x = x0; x <= x1; x++) {
      const c = row + x;
      const s = w.cellStart[c];
      const e = w.cellStart[c + 1];
      for (let k = s; k < e; k++) {
        const i = w.cellItems[k];
        if (mark[i] === stamp) continue;
        mark[i] = stamp;
        const b = boxes[i];
        if (b.maxX < minX || b.minX > maxX) continue;
        if (b.maxY < minY || b.minY > maxY) continue;
        if (b.maxZ < minZ || b.minZ > maxZ) continue;
        out[n++] = i;
      }
    }
  }
  return n;
}

/** Gathers colliders along a ray using a 2D DDA over the grid. Returns count. */
function gatherRay(
  w: CollisionWorld,
  out: Int32Array,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number
): number {
  const gmaxX = w.gminX + w.nx * w.cell;
  const gmaxZ = w.gminZ + w.nz * w.cell;

  let t0 = 0;
  let t1 = maxDist;

  if (dx > -1e-12 && dx < 1e-12) {
    if (ox < w.gminX || ox > gmaxX) return 0;
  } else {
    let ta = (w.gminX - ox) / dx;
    let tb = (gmaxX - ox) / dx;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  if (dz > -1e-12 && dz < 1e-12) {
    if (oz < w.gminZ || oz > gmaxZ) return 0;
  } else {
    let ta = (w.gminZ - oz) / dz;
    let tb = (gmaxZ - oz) / dz;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  if (t0 > t1) return 0;

  const stamp = ++w.stamp;
  const mark = w.mark;

  const sx = ox + dx * t0;
  const sz = oz + dz * t0;
  let ix = clampInt(Math.floor((sx - w.gminX) / w.cell), 0, w.nx - 1);
  let iz = clampInt(Math.floor((sz - w.gminZ) / w.cell), 0, w.nz - 1);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  let tMaxX = Infinity;
  let tDeltaX = Infinity;
  if (stepX !== 0) {
    const boundary = w.gminX + (ix + (stepX > 0 ? 1 : 0)) * w.cell;
    tMaxX = (boundary - ox) / dx;
    tDeltaX = w.cell / Math.abs(dx);
  }
  let tMaxZ = Infinity;
  let tDeltaZ = Infinity;
  if (stepZ !== 0) {
    const boundary = w.gminZ + (iz + (stepZ > 0 ? 1 : 0)) * w.cell;
    tMaxZ = (boundary - oz) / dz;
    tDeltaZ = w.cell / Math.abs(dz);
  }

  let n = 0;
  for (let guard = 0; guard < 4096; guard++) {
    const c = iz * w.nx + ix;
    const s = w.cellStart[c];
    const e = w.cellStart[c + 1];
    for (let k = s; k < e; k++) {
      const i = w.cellItems[k];
      if (mark[i] === stamp) continue;
      mark[i] = stamp;
      out[n++] = i;
    }
    if (tMaxX < tMaxZ) {
      if (tMaxX > t1) break;
      ix += stepX;
      if (ix < 0 || ix >= w.nx) break;
      tMaxX += tDeltaX;
    } else {
      if (tMaxZ > t1) break;
      iz += stepZ;
      if (iz < 0 || iz >= w.nz) break;
      tMaxZ += tDeltaZ;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Narrowphase: ray vs OBB
// ---------------------------------------------------------------------------

// Scratch outputs. Written then read within one synchronous call.
let _rt = 0;
let _rnx = 0;
let _rny = 0;
let _rnz = 0;

/**
 * Slab test in the box's local frame. Returns true on hit and writes `_rt` and
 * the world-space normal into `_rnx/_rny/_rnz`. Rays whose origin is inside the
 * box are reported as a miss (a shooter clipped into geometry must not
 * self-block).
 */
function rayVsBox(
  b: ColliderBox,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number
): boolean {
  const px = ox - b.cx;
  const py = oy - b.cy;
  const pz = oz - b.cz;

  const lox = b.m00 * px + b.m10 * py + b.m20 * pz;
  const loy = b.m01 * px + b.m11 * py + b.m21 * pz;
  const loz = b.m02 * px + b.m12 * py + b.m22 * pz;

  const ldx = b.m00 * dx + b.m10 * dy + b.m20 * dz;
  const ldy = b.m01 * dx + b.m11 * dy + b.m21 * dz;
  const ldz = b.m02 * dx + b.m12 * dy + b.m22 * dz;

  let tmin = 0;
  let tmax = maxDist;
  let axis = -1;
  let sign = 0;

  // X
  if (ldx > -1e-9 && ldx < 1e-9) {
    if (lox < -b.hx || lox > b.hx) return false;
  } else {
    const inv = 1 / ldx;
    let tn = (-b.hx - lox) * inv;
    let tf = (b.hx - lox) * inv;
    let s = -1;
    if (tn > tf) {
      const tmp = tn;
      tn = tf;
      tf = tmp;
      s = 1;
    }
    if (tn > tmin) {
      tmin = tn;
      axis = 0;
      sign = s;
    }
    if (tf < tmax) tmax = tf;
    if (tmin > tmax) return false;
  }
  // Y
  if (ldy > -1e-9 && ldy < 1e-9) {
    if (loy < -b.hy || loy > b.hy) return false;
  } else {
    const inv = 1 / ldy;
    let tn = (-b.hy - loy) * inv;
    let tf = (b.hy - loy) * inv;
    let s = -1;
    if (tn > tf) {
      const tmp = tn;
      tn = tf;
      tf = tmp;
      s = 1;
    }
    if (tn > tmin) {
      tmin = tn;
      axis = 1;
      sign = s;
    }
    if (tf < tmax) tmax = tf;
    if (tmin > tmax) return false;
  }
  // Z
  if (ldz > -1e-9 && ldz < 1e-9) {
    if (loz < -b.hz || loz > b.hz) return false;
  } else {
    const inv = 1 / ldz;
    let tn = (-b.hz - loz) * inv;
    let tf = (b.hz - loz) * inv;
    let s = -1;
    if (tn > tf) {
      const tmp = tn;
      tn = tf;
      tf = tmp;
      s = 1;
    }
    if (tn > tmin) {
      tmin = tn;
      axis = 2;
      sign = s;
    }
    if (tf < tmax) tmax = tf;
    if (tmin > tmax) return false;
  }

  if (axis < 0) return false; // origin inside the box

  _rt = tmin;
  const lnx = axis === 0 ? sign : 0;
  const lny = axis === 1 ? sign : 0;
  const lnz = axis === 2 ? sign : 0;
  _rnx = b.m00 * lnx + b.m01 * lny + b.m02 * lnz;
  _rny = b.m10 * lnx + b.m11 * lny + b.m12 * lnz;
  _rnz = b.m20 * lnx + b.m21 * lny + b.m22 * lnz;
  return true;
}

/**
 * Closest hit along a ray.
 *
 * `dir` MUST be normalized by the caller — `t` and `maxDist` are in meters and
 * are only meaningful for a unit direction. Returns null when nothing is hit,
 * and also when `origin` is inside a brush.
 */
export function raycastWorld(origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
  return raycastWorldIn(STATIC_WORLD, origin, dir, maxDist);
}

/** World-taking variant of `raycastWorld` for multi-map callers. */
export function raycastWorldIn(
  w: CollisionWorld,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): RayHit | null {
  const n = gatherRay(w, w.candRay, origin.x, origin.z, dir.x, dir.z, maxDist);
  let bestT = maxDist;
  let bestI = -1;
  let bnx = 0;
  let bny = 0;
  let bnz = 0;
  for (let k = 0; k < n; k++) {
    const i = w.candRay[k];
    if (!rayVsBox(w.boxes[i], origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist)) continue;
    if (_rt < bestT) {
      bestT = _rt;
      bestI = i;
      bnx = _rnx;
      bny = _rny;
      bnz = _rnz;
    }
  }
  if (bestI < 0) return null;
  return {
    point: { x: origin.x + dir.x * bestT, y: origin.y + dir.y * bestT, z: origin.z + dir.z * bestT },
    normal: { x: bnx, y: bny, z: bnz },
    brush: w.boxes[bestI].brush,
    t: bestT,
  };
}

/**
 * Every hit along a ray, sorted near-to-far, capped at `max`.
 * Used by bullet penetration. `dir` MUST be normalized.
 */
export function raycastWorldAll(origin: Vec3, dir: Vec3, maxDist: number, max: number): RayHit[] {
  return raycastWorldAllIn(STATIC_WORLD, origin, dir, maxDist, max);
}

/** World-taking variant of `raycastWorldAll` for multi-map callers. */
export function raycastWorldAllIn(
  w: CollisionWorld,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  max: number,
): RayHit[] {
  const out: RayHit[] = [];
  if (max <= 0) return out;
  const n = gatherRay(w, w.candRay, origin.x, origin.z, dir.x, dir.z, maxDist);
  for (let k = 0; k < n; k++) {
    const i = w.candRay[k];
    if (!rayVsBox(w.boxes[i], origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist)) continue;
    const hit: RayHit = {
      point: { x: origin.x + dir.x * _rt, y: origin.y + dir.y * _rt, z: origin.z + dir.z * _rt },
      normal: { x: _rnx, y: _rny, z: _rnz },
      brush: w.boxes[i].brush,
      t: _rt,
    };
    // Insertion sort by t, then by brush id so equal-distance hits are stable.
    let j = out.length;
    while (j > 0 && (out[j - 1].t > hit.t || (out[j - 1].t === hit.t && out[j - 1].brush.id > hit.brush.id))) j--;
    out.splice(j, 0, hit);
  }
  if (out.length > max) out.length = max;
  return out;
}

// ---------------------------------------------------------------------------
// Narrowphase: capsule vs OBB
// ---------------------------------------------------------------------------

// Scratch outputs of `capsuleVsBox`.
let _gap = 0;
let _cnx = 0;
let _cny = 0;
let _cnz = 0;
let _cpx = 0;
let _cpy = 0;
let _cpz = 0;

function clampf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Signed gap between an upright capsule (feet at px,py,pz) and one box.
 * Negative means penetrating by that depth.
 *
 * Writes `_gap`, the world-space separating normal (`_cn*`, pointing from the
 * box toward the capsule axis) and the world-space contact point (`_cp*`).
 *
 * Closest points are found by alternating projection between the segment and
 * the box in the box's local frame — exact for boxes in one to two rounds,
 * four are run for margin, and the iteration count is fixed so the float
 * operation order never varies.
 */
function capsuleVsBox(
  b: ColliderBox,
  px: number,
  py: number,
  pz: number,
  radius: number,
  height: number
): number {
  // Capsule segment endpoints in world space (always vertical).
  let ay = py + radius;
  let by = py + height - radius;
  if (by < ay) {
    const mid = py + height * 0.5;
    ay = mid;
    by = mid;
  }

  const dx = px - b.cx;
  const dz = pz - b.cz;
  const da = ay - b.cy;

  const lax = b.m00 * dx + b.m10 * da + b.m20 * dz;
  const lay = b.m01 * dx + b.m11 * da + b.m21 * dz;
  const laz = b.m02 * dx + b.m12 * da + b.m22 * dz;

  const dh = by - ay;
  const ex = b.m10 * dh;
  const ey = b.m11 * dh;
  const ez = b.m12 * dh;
  const ee = ex * ex + ey * ey + ez * ez;

  let t = 0;
  if (ee > 1e-12) t = clampf((-lax * ex - lay * ey - laz * ez) / ee, 0, 1);

  let qx = 0;
  let qy = 0;
  let qz = 0;
  let bx = 0;
  let by2 = 0;
  let bz = 0;
  for (let k = 0; k < 4; k++) {
    qx = lax + ex * t;
    qy = lay + ey * t;
    qz = laz + ez * t;
    bx = clampf(qx, -b.hx, b.hx);
    by2 = clampf(qy, -b.hy, b.hy);
    bz = clampf(qz, -b.hz, b.hz);
    if (ee > 1e-12) {
      t = clampf(((bx - lax) * ex + (by2 - lay) * ey + (bz - laz) * ez) / ee, 0, 1);
    }
  }
  qx = lax + ex * t;
  qy = lay + ey * t;
  qz = laz + ez * t;
  bx = clampf(qx, -b.hx, b.hx);
  by2 = clampf(qy, -b.hy, b.hy);
  bz = clampf(qz, -b.hz, b.hz);

  const vx = qx - bx;
  const vy = qy - by2;
  const vz = qz - bz;
  const d2 = vx * vx + vy * vy + vz * vz;

  let lnx: number;
  let lny: number;
  let lnz: number;

  if (d2 > 1e-14) {
    const d = Math.sqrt(d2);
    _gap = d - radius;
    lnx = vx / d;
    lny = vy / d;
    lnz = vz / d;
  } else {
    // Axis point is inside the box — push out along the shallowest local axis.
    const ox = b.hx - Math.abs(qx);
    const oy = b.hy - Math.abs(qy);
    const oz = b.hz - Math.abs(qz);
    if (ox <= oy && ox <= oz) {
      const s = qx >= 0 ? 1 : -1;
      lnx = s;
      lny = 0;
      lnz = 0;
      bx = s * b.hx;
      by2 = qy;
      bz = qz;
      _gap = -(radius + ox);
    } else if (oy <= oz) {
      const s = qy >= 0 ? 1 : -1;
      lnx = 0;
      lny = s;
      lnz = 0;
      bx = qx;
      by2 = s * b.hy;
      bz = qz;
      _gap = -(radius + oy);
    } else {
      const s = qz >= 0 ? 1 : -1;
      lnx = 0;
      lny = 0;
      lnz = s;
      bx = qx;
      by2 = qy;
      bz = s * b.hz;
      _gap = -(radius + oz);
    }
  }

  _cnx = b.m00 * lnx + b.m01 * lny + b.m02 * lnz;
  _cny = b.m10 * lnx + b.m11 * lny + b.m12 * lnz;
  _cnz = b.m20 * lnx + b.m21 * lny + b.m22 * lnz;
  _cpx = b.cx + b.m00 * bx + b.m01 * by2 + b.m02 * bz;
  _cpy = b.cy + b.m10 * bx + b.m11 * by2 + b.m12 * bz;
  _cpz = b.cz + b.m20 * bx + b.m21 * by2 + b.m22 * bz;
  return _gap;
}

/** True when an upright capsule with feet at `pos` intersects any brush. */
export function capsuleOverlap(world: CollisionWorld, pos: Vec3, radius: number, height: number): boolean {
  const n = gatherBox(
    world,
    world.candOverlap,
    pos.x - radius,
    pos.y,
    pos.z - radius,
    pos.x + radius,
    pos.y + height,
    pos.z + radius
  );
  for (let k = 0; k < n; k++) {
    const gap = capsuleVsBox(world.boxes[world.candOverlap[k]], pos.x, pos.y, pos.z, radius, height);
    if (gap < -CONTACT_TOL) return true;
  }
  return false;
}

/**
 * Deepest penetration of an upright capsule at `pos`, resolved against every
 * overlapping brush in sequence. Writes the corrected position into `out`.
 * Returns true when anything moved.
 *
 * Exposed for the movement solver; it is the depenetration half of the
 * sweep/depenetrate pair.
 */
export function capsuleDepenetrate(
  world: CollisionWorld,
  pos: Vec3,
  radius: number,
  height: number,
  iterations: number,
  out: Vec3
): boolean {
  let x = pos.x;
  let y = pos.y;
  let z = pos.z;
  let moved = false;
  for (let iter = 0; iter < iterations; iter++) {
    const n = gatherBox(
      world,
      world.candOverlap,
      x - radius,
      y,
      z - radius,
      x + radius,
      y + height,
      z + radius
    );
    let any = false;
    for (let k = 0; k < n; k++) {
      const gap = capsuleVsBox(world.boxes[world.candOverlap[k]], x, y, z, radius, height);
      if (gap >= -CONTACT_TOL) continue;
      const push = -gap + COLLISION_SKIN;
      x += _cnx * push;
      y += _cny * push;
      z += _cnz * push;
      any = true;
      moved = true;
    }
    if (!any) break;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return moved;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

// Probe scratch.
let _probeIndex = -1;

/**
 * Deepest-overlapping candidate at a point along the sweep, or -1.
 * Candidates must already be in `world.candSweep[0..count)`.
 *
 * On a hit the contact scratch (`_cn*`, `_cp*`) is re-evaluated for the winning
 * box before returning. Without that it would still hold the LAST box tested,
 * which silently hands the caller a normal belonging to a different surface —
 * a bug that makes floors behave like walls.
 */
function probe(
  world: CollisionWorld,
  count: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number
): number {
  let best = -1;
  let bestGap = -CONTACT_TOL;
  for (let k = 0; k < count; k++) {
    const i = world.candSweep[k];
    const gap = capsuleVsBox(world.boxes[i], x, y, z, radius, height);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  if (best >= 0) capsuleVsBox(world.boxes[best], x, y, z, radius, height);
  _probeIndex = best;
  return best;
}

/**
 * Sweeps an upright capsule (feet at `from`, moving to `to`) through the world.
 *
 * The path is sampled at <= SWEEP_SUBSTEP intervals — far finer than the
 * detection band of the thinnest brush in the map — and the first overlapping
 * sample is refined by a fixed number of bisections. Nothing is ever teleported
 * past geometry, so a 40 m/s dash cannot tunnel.
 */
export function capsuleSweep(
  world: CollisionWorld,
  from: Vec3,
  to: Vec3,
  radius: number,
  height: number
): SweepResult {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (len < 1e-9) {
    return {
      hit: false,
      fraction: 1,
      position: { x: from.x, y: from.y, z: from.z },
      normal: { x: 0, y: 0, z: 0 },
      point: { x: from.x, y: from.y, z: from.z },
      brush: null,
    };
  }

  const minX = (dx < 0 ? to.x : from.x) - radius;
  const maxX = (dx < 0 ? from.x : to.x) + radius;
  const minZ = (dz < 0 ? to.z : from.z) - radius;
  const maxZ = (dz < 0 ? from.z : to.z) + radius;
  const minY = dy < 0 ? to.y : from.y;
  const maxY = (dy < 0 ? from.y : to.y) + height;

  const count = gatherBox(world, world.candSweep, minX, minY, minZ, maxX, maxY, maxZ);
  if (count === 0) {
    return {
      hit: false,
      fraction: 1,
      position: { x: to.x, y: to.y, z: to.z },
      normal: { x: 0, y: 0, z: 0 },
      point: { x: to.x, y: to.y, z: to.z },
      brush: null,
    };
  }

  let steps = Math.floor(len / SWEEP_SUBSTEP) + 1;
  if (steps > SWEEP_MAX_STEPS) steps = SWEEP_MAX_STEPS;

  let lo = 0;
  let hi = -1;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (probe(world, count, from.x + dx * t, from.y + dy * t, from.z + dz * t, radius, height) >= 0) {
      hi = t;
      break;
    }
    lo = t;
  }

  if (hi < 0) {
    return {
      hit: false,
      fraction: 1,
      position: { x: to.x, y: to.y, z: to.z },
      normal: { x: 0, y: 0, z: 0 },
      point: { x: to.x, y: to.y, z: to.z },
      brush: null,
    };
  }

  // Refine.
  for (let i = 0; i < SWEEP_BISECTIONS; i++) {
    const mid = (lo + hi) * 0.5;
    if (probe(world, count, from.x + dx * mid, from.y + dy * mid, from.z + dz * mid, radius, height) >= 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  // Evaluate the contact on the penetrating side so the normal is meaningful.
  probe(world, count, from.x + dx * hi, from.y + dy * hi, from.z + dz * hi, radius, height);
  const idx = _probeIndex;
  if (idx < 0) {
    // Should not happen: `hi` overlapped by construction. Fail safe.
    return {
      hit: false,
      fraction: 1,
      position: { x: to.x, y: to.y, z: to.z },
      normal: { x: 0, y: 0, z: 0 },
      point: { x: to.x, y: to.y, z: to.z },
      brush: null,
    };
  }
  const nx = _cnx;
  const ny = _cny;
  const nz = _cnz;
  const cpx = _cpx;
  const cpy = _cpy;
  const cpz = _cpz;

  // Back off along the path by the skin so the resting pose is not touching.
  let frac = lo - COLLISION_SKIN / len;
  if (frac < 0) frac = 0;

  return {
    hit: true,
    fraction: frac,
    position: { x: from.x + dx * frac, y: from.y + dy * frac, z: from.z + dz * frac },
    normal: { x: nx, y: ny, z: nz },
    point: { x: cpx, y: cpy, z: cpz },
    brush: world.boxes[idx].brush,
  };
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * True when a position is outside the playable volume (in the sea, or past the
 * world box). This only REPORTS — killing the player is the server's decision.
 *
 * With no `world` it tests against the Sundeck singleton's volume, exactly as
 * before; pass a world to test against that map's own bounds.
 */
export function isOutOfBounds(pos: Vec3, world: CollisionWorld = STATIC_WORLD): boolean {
  const bounds = world.bounds;
  if (pos.y < world.waterLevel) return true;
  if (pos.x < bounds.min.x || pos.x > bounds.max.x) return true;
  if (pos.y < bounds.min.y || pos.y > bounds.max.y) return true;
  if (pos.z < bounds.min.z || pos.z > bounds.max.z) return true;
  return false;
}
