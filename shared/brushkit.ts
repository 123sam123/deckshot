/**
 * DECKSHOT — shared brush-authoring helpers.
 *
 * `shared/mapdata.ts` is FROZEN and keeps its own private copies of these; this
 * module exists so every map added AFTER it can share one vocabulary instead of
 * redeclaring `b()` at the top of each file. Engine-free, pure functions.
 *
 * The mirror helpers are not a convenience — they are how a map is symmetric by
 * construction. A competitive map built with `mirrorZ`/`quad` cannot acquire a
 * spawn-side advantage through a typo, which is exactly the bug class that is
 * invisible to read and decisive to lose to.
 */

import { BrushTag, SurfaceMaterial, SpawnZone, type Brush, type SpawnPoint } from './mapdata.js';

export const b = (
  id: string,
  center: [number, number, number],
  half: [number, number, number],
  material: SurfaceMaterial,
  tag: BrushTag,
  opts: { yaw?: number; pitch?: number; penetrable?: boolean } = {}
): Brush => ({
  id,
  center: { x: center[0], y: center[1], z: center[2] },
  half: { x: half[0], y: half[1], z: half[2] },
  yaw: opts.yaw ?? 0,
  pitch: opts.pitch ?? 0,
  material,
  penetrable: opts.penetrable ?? false,
  tag,
});

/** Mirrors a brush end-to-end (negate Z). */
export function mirrorZ(src: Brush, idSuffix = '_m'): Brush {
  return {
    ...src,
    id: src.id + idSuffix,
    center: { ...src.center, z: -src.center.z },
    yaw: -src.yaw,
    pitch: -src.pitch,
  };
}

/** Mirrors a brush side-to-side (negate X). Pitch is a Z-slope, so it stays. */
export function mirrorX(src: Brush, idSuffix = '_x'): Brush {
  return {
    ...src,
    id: src.id + idSuffix,
    center: { ...src.center, x: -src.center.x },
    yaw: -src.yaw,
  };
}

/** Pushes `src` plus its X, Z and XZ mirrors. Four-fold symmetry in one call. */
export function quad(out: Brush[], src: Brush): void {
  const x = mirrorX(src, '_x');
  out.push(src, x, mirrorZ(src), mirrorZ(x));
}

/**
 * A spawn that faces the origin. Under the types.ts convention (yaw 0 looks
 * down -Z, so forward = (-sin yaw, 0, -cos yaw)), pointing at the centre from
 * (x, z) requires atan2(x, z) — NOT atan2(-x, -z), which faces you off the back
 * of the map and out to sea.
 */
export function sp(id: number, x: number, y: number, z: number, zone: SpawnZone): SpawnPoint {
  return { id, position: { x, y, z }, yaw: Math.atan2(x, z), zone };
}

/**
 * A ramp solved so it MEETS what it connects, rather than sized to its rise.
 *
 * A ramp whose half-length matches its rise leaves its leading edge standing
 * `halfY·cos(angle)` proud of the floor — 0.13m to 0.18m at these slopes. That
 * is well under STEP_HEIGHT and it is still a wall: the step-up does not
 * resolve against a sloped top face, so a player walking into it simply stops,
 * with nothing on screen to explain why. Three ramps shipped like that.
 *
 * So: solve for the centre and half-length such that the TOP corner lands
 * exactly on `topY` at `topZ`, and the BOTTOM corner is buried `bury` below
 * `bottomY`. Buried is the safe direction — the surface it leaves is the higher
 * one, and the transition happens where the slope crosses it.
 *
 * Returns a brush that rises toward -Z. Mirror it for the other end.
 */
export function solvedRamp(
  id: string,
  x: number,
  opts: {
    topY: number;
    bottomY: number;
    /** World Z the top corner lands on. */
    topZ: number;
    /** Horizontal run from bottom to top. */
    run: number;
    halfX: number;
    halfY?: number;
    bury?: number;
    material?: SurfaceMaterial;
  }
): Brush {
  const halfY = opts.halfY ?? 0.15;
  const bury = opts.bury ?? 0.06;
  const rise = opts.topY - (opts.bottomY - bury);
  const a = Math.atan2(rise, opts.run);
  const hz = rise / (2 * Math.sin(a));
  const cy = opts.topY - halfY * Math.cos(a) - hz * Math.sin(a);
  const cz = opts.topZ + hz * Math.cos(a);
  return b(id, [x, cy, cz], [opts.halfX, halfY, hz], opts.material ?? SurfaceMaterial.Metal, BrushTag.Ramp, {
    pitch: a,
  });
}
