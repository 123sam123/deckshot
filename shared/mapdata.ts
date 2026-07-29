/**
 * DECKSHOT — "Sundeck" map, as data.
 *
 * FROZEN CONTRACT. This is the single authoritative description of the map.
 * The renderer builds visuals FROM this. The physics builds colliders FROM this.
 * Neither may invent its own geometry, or visual and physical space will drift.
 *
 * Purely decorative props with no collision (rope coils, deck lights, gulls)
 * are NOT here — they belong to client/src/world/props.ts, owned by map-and-ocean.
 *
 * ---------------------------------------------------------------------------
 * COORDINATE SYSTEM
 *   +X = starboard, +Y = up, +Z = toward the bow.
 *   Origin sits at the centre of the main deck, at deck level (Y = 0).
 *   The map is mirror-symmetric about Z = 0. Bow team spawns at +Z, stern at -Z.
 *
 * LAYOUT (three lanes, running the length of the boat)
 *
 *        stern (-Z)                    mid                    bow (+Z)
 *   X=+9 ┌──────────── STARBOARD WALKWAY ────────────────────┐
 *        │  [cabin]      crates   ~POOL~   crates    [cabin]  │
 *   X=0  │══ corridor ══  ░░░░░░░░░░░░░░░░  ══ corridor ══   │  <- mid spine
 *        │  [cabin]      crates   ~POOL~   crates    [cabin]  │
 *   X=-9 └──────────── PORT WALKWAY ─────────────────────────┘
 *
 *   Upper deck (Y = 3.15) = the two cabin roofs, joined by two side catwalks
 *   that run over the pool. Dropping off a catwalk into mid is the airborne
 *   shot the whole mode is built around.
 * ---------------------------------------------------------------------------
 */

import type { Vec3 } from './types.js';

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export enum SurfaceMaterial {
  Teak = 0, // deck planking — warm footsteps, wood impact
  Metal = 1, // hull, railings — bright ping
  Glass = 2, // cabin windows — shatters, highly penetrable
  Composite = 3, // cabin walls, white superstructure
  Fabric = 4, // loungers, awnings — muffled, very penetrable
  Water = 5, // the sea
}

/** Fraction of damage a round retains after passing through this material. */
export const MATERIAL_PENETRATION: Record<SurfaceMaterial, number> = {
  [SurfaceMaterial.Teak]: 0.75,
  [SurfaceMaterial.Metal]: 0.5,
  [SurfaceMaterial.Glass]: 0.95,
  [SurfaceMaterial.Composite]: 0.7,
  [SurfaceMaterial.Fabric]: 0.95,
  [SurfaceMaterial.Water]: 0.0,
};

// ---------------------------------------------------------------------------
// Brushes — the collision + visual primitives
// ---------------------------------------------------------------------------

export interface Brush {
  /** Stable id, used for decal attachment and debug. */
  id: string;
  /** Centre of the box in world space. */
  center: Vec3;
  /** Half-extents along local X/Y/Z, before rotation. */
  half: Vec3;
  /** Rotation about +Y, radians. Applied before pitch. */
  yaw: number;
  /** Rotation about the local X axis, radians. Used for ramps. */
  pitch: number;
  material: SurfaceMaterial;
  /** If false, bullets stop dead here regardless of FMJ. */
  penetrable: boolean;
  /** Rendering hint only; never affects collision. */
  tag: BrushTag;
}

export enum BrushTag {
  Deck = 'deck',
  Hull = 'hull',
  Wall = 'wall',
  Railing = 'railing',
  Roof = 'roof',
  Catwalk = 'catwalk',
  Ramp = 'ramp',
  Cover = 'cover',
  Crate = 'crate',
  Pool = 'pool',
  Window = 'window',
}

const b = (
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

/** Mirrors a brush bow-to-stern (negate Z) to guarantee symmetry. */
function mirrorZ(src: Brush, idSuffix = '_m'): Brush {
  return {
    ...src,
    id: src.id + idSuffix,
    center: { ...src.center, z: -src.center.z },
    yaw: -src.yaw,
    pitch: -src.pitch,
  };
}

/** Mirrors a brush port-to-starboard (negate X). */
function mirrorX(src: Brush, idSuffix = '_x'): Brush {
  return {
    ...src,
    id: src.id + idSuffix,
    center: { ...src.center, x: -src.center.x },
    yaw: -src.yaw,
  };
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export const BOAT_LENGTH = 62;
export const BOAT_BEAM = 18;
export const DECK_Y = 0;
export const UPPER_DECK_Y = 3.15;
export const CATWALK_Y = 3.3;
export const WATER_LEVEL = -3.0;

/** Anything outside this box, or below WATER_LEVEL, is out of bounds. */
export const WORLD_BOUNDS = {
  min: { x: -13, y: -6, z: -35 } as Vec3,
  max: { x: 13, y: 30, z: 35 } as Vec3,
};

// ---------------------------------------------------------------------------
// Brush list
// ---------------------------------------------------------------------------

const brushes: Brush[] = [];

// --- Main deck, built as a frame around the pool opening --------------------
brushes.push(
  b('deck_port', [-6.5, -0.25, 0], [2.5, 0.25, 26], SurfaceMaterial.Teak, BrushTag.Deck),
  b('deck_stbd', [6.5, -0.25, 0], [2.5, 0.25, 26], SurfaceMaterial.Teak, BrushTag.Deck),
  b('deck_fore', [0, -0.25, 16.5], [4, 0.25, 9.5], SurfaceMaterial.Teak, BrushTag.Deck),
  b('deck_aft', [0, -0.25, -16.5], [4, 0.25, 9.5], SurfaceMaterial.Teak, BrushTag.Deck)
);

// --- The pool: 1m deep, breaks the mid sightline for anyone who drops in ----
brushes.push(
  b('pool_floor', [0, -1.25, 0], [4, 0.25, 7], SurfaceMaterial.Composite, BrushTag.Pool),
  b('pool_wall_p', [-4.25, -0.5, 0], [0.25, 0.5, 7.25], SurfaceMaterial.Composite, BrushTag.Pool),
  b('pool_wall_s', [4.25, -0.5, 0], [0.25, 0.5, 7.25], SurfaceMaterial.Composite, BrushTag.Pool),
  b('pool_wall_f', [0, -0.5, 7.25], [4.5, 0.5, 0.25], SurfaceMaterial.Composite, BrushTag.Pool),
  b('pool_wall_a', [0, -0.5, -7.25], [4.5, 0.5, 0.25], SurfaceMaterial.Composite, BrushTag.Pool)
);

// --- Hull sides and bulwarks (head-glitch height on the walkways) ----------
{
  const bulwark = b('bulwark_p', [-9.25, 0.6, 0], [0.25, 0.6, 26], SurfaceMaterial.Metal, BrushTag.Railing);
  const hull = b('hull_p', [-9.6, -1.6, 0], [0.6, 1.6, 28], SurfaceMaterial.Metal, BrushTag.Hull);
  brushes.push(bulwark, mirrorX(bulwark, '_s'), hull, mirrorX(hull, '_s'));
}

// --- Cabins: two mirrored blocks, each split to leave a 4m mid corridor ----
// The corridor is what makes the bow-to-stern crossmap shot possible.
{
  const wallP = b('cabin_wall_p', [-3.5, 1.5, 16], [1.5, 1.5, 5], SurfaceMaterial.Composite, BrushTag.Wall, {
    penetrable: true,
  });
  const wallS = mirrorX(wallP, '_s');
  // Windows facing mid — penetrable, and the reason peeking the corridor is risky.
  const winP = b('cabin_win_p', [-2.05, 1.7, 16], [0.05, 0.9, 4.2], SurfaceMaterial.Glass, BrushTag.Window, {
    penetrable: true,
  });
  const winS = mirrorX(winP, '_s');
  const roof = b('cabin_roof', [0, UPPER_DECK_Y, 16], [5, 0.15, 5], SurfaceMaterial.Metal, BrushTag.Roof);
  // Roof lip: cover for anyone holding the upper deck.
  const lip = b('cabin_lip', [0, 3.75, 11.15], [5, 0.45, 0.15], SurfaceMaterial.Metal, BrushTag.Railing);

  for (const brush of [wallP, wallS, winP, winS, roof, lip]) {
    brushes.push(brush, mirrorZ(brush));
  }
}

// --- Ramps up to the cabin roofs, one per side per end ---------------------
// Rise 3.15m over 6m of run => ~27.7 degrees, comfortably walkable.
{
  const RAMP_PITCH = Math.atan2(3.15, 6);
  const RAMP_LEN = Math.hypot(3.15, 6) / 2;
  const ramp = b(
    'ramp_p_bow',
    [-7, 1.575, 8.0],
    [1.2, 0.15, RAMP_LEN],
    SurfaceMaterial.Metal,
    BrushTag.Ramp,
    { pitch: -RAMP_PITCH }
  );
  brushes.push(ramp, mirrorX(ramp, '_s'), mirrorZ(ramp), mirrorZ(mirrorX(ramp, '_s')));
}

// --- Catwalks over the pool, joining the two cabin roofs -------------------
// Dropping off these into mid is the signature airborne shot.
{
  const cat = b('catwalk_p', [-5.5, CATWALK_Y, 0], [0.75, 0.15, 11], SurfaceMaterial.Metal, BrushTag.Catwalk);
  const rail = b('catwalk_rail_p', [-6.2, 3.75, 0], [0.05, 0.45, 11], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  });
  brushes.push(cat, mirrorX(cat, '_s'), rail, mirrorX(rail, '_s'));
}

// --- Crate route: skilled players can jump walkway -> crate -> catwalk -----
// Stack tops at 1.8 and 2.4; catwalk at 3.3. Jump apex is 1.05m. Tight by design.
// Stacked outboard against the bulwark rather than mid-walkway: at x=-7.2 they
// poked through the foot of the ramp and blocked the port lane at z=0. Hard
// against the hull they clear the ramp, leave the walkway open, and turn the
// catwalk jump into a real 1.25m gap rather than a step.
{
  const lo = b('crate_lo_p', [-8.2, 0.9, 3.4], [0.7, 0.9, 0.9], SurfaceMaterial.Composite, BrushTag.Crate);
  const hi = b('crate_hi_p', [-8.2, 1.2, 1.6], [0.6, 1.2, 0.7], SurfaceMaterial.Composite, BrushTag.Crate);
  for (const brush of [lo, hi]) {
    brushes.push(brush, mirrorX(brush, '_s'), mirrorZ(brush), mirrorZ(mirrorX(brush, '_s')));
  }
}

// --- Mid cover: bar counters and loungers ---------------------------------
{
  const bar = b('bar_p', [-6.5, 0.55, 10.5], [1.2, 0.55, 3], SurfaceMaterial.Teak, BrushTag.Cover);
  const lounger = b('lounger_p', [-6.8, 0.35, -2.0], [0.6, 0.35, 1.4], SurfaceMaterial.Fabric, BrushTag.Cover, {
    penetrable: true,
  });
  for (const brush of [bar, lounger]) {
    brushes.push(brush, mirrorX(brush, '_s'), mirrorZ(brush), mirrorZ(mirrorX(brush, '_s')));
  }
}

// --- Bow and stern spawn platforms, raised behind the cabins ---------------
// Heights are constrained by STEP_HEIGHT (0.4): the deck is at y=0, so the step
// tops out at 0.375 and the platform at 0.75, giving two 0.375m rises. Raising
// the platform back to 1.0m makes players jump to reach their own spawn.
{
  const plat = b('spawn_plat_bow', [0, 0.5, 28.5], [5.5, 0.25, 2.5], SurfaceMaterial.Teak, BrushTag.Deck);
  const step = b('spawn_step_bow', [0, 0.1875, 25.6], [5.5, 0.1875, 0.5], SurfaceMaterial.Teak, BrushTag.Deck);
  const rail = b('spawn_rail_bow', [0, 1.1, 31.25], [5.5, 0.6, 0.25], SurfaceMaterial.Metal, BrushTag.Railing);
  for (const brush of [plat, step, rail]) {
    brushes.push(brush, mirrorZ(brush));
  }
}

export const BRUSHES: readonly Brush[] = brushes;

// ---------------------------------------------------------------------------
// Spawn points
// ---------------------------------------------------------------------------

export enum SpawnZone {
  Bow = 0,
  Stern = 1,
  /** Neutral spawns used in FFA and when both ends are contested. */
  Mid = 2,
}

export interface SpawnPoint {
  id: number;
  position: Vec3;
  /** Facing at spawn, radians. Always points toward the centre of the map. */
  yaw: number;
  zone: SpawnZone;
}

function sp(id: number, x: number, y: number, z: number, zone: SpawnZone): SpawnPoint {
  // Face the origin. Under the types.ts convention (yaw 0 looks down -Z, so
  // forward = (-sin yaw, 0, -cos yaw)), pointing at the centre from (x, z)
  // requires atan2(x, z) — NOT atan2(-x, -z), which faces you off the back of
  // the boat and out to sea.
  const yaw = Math.atan2(x, z);
  return { id, position: { x, y, z }, yaw, zone };
}

export const SPAWN_POINTS: readonly SpawnPoint[] = [
  // Bow cluster — y matches the spawn platform top (0.75)
  sp(0, -3.2, 0.75, 28.5, SpawnZone.Bow),
  sp(1, 0.0, 0.75, 29.2, SpawnZone.Bow),
  sp(2, 3.2, 0.75, 28.5, SpawnZone.Bow),
  sp(3, -7.0, 0.0, 24.0, SpawnZone.Bow),
  sp(4, 7.0, 0.0, 24.0, SpawnZone.Bow),
  // Stern cluster
  sp(5, -3.2, 0.75, -28.5, SpawnZone.Stern),
  sp(6, 0.0, 0.75, -29.2, SpawnZone.Stern),
  sp(7, 3.2, 0.75, -28.5, SpawnZone.Stern),
  sp(8, -7.0, 0.0, -24.0, SpawnZone.Stern),
  sp(9, 7.0, 0.0, -24.0, SpawnZone.Stern),
  // Neutral / mid — walkways and upper deck, for FFA churn
  sp(10, -7.5, 0.0, 12.0, SpawnZone.Mid),
  sp(11, 7.5, 0.0, 12.0, SpawnZone.Mid),
  sp(12, -7.5, 0.0, -12.0, SpawnZone.Mid),
  sp(13, 7.5, 0.0, -12.0, SpawnZone.Mid),
  sp(14, 0.0, UPPER_DECK_Y + 0.15, 16.0, SpawnZone.Mid),
  sp(15, 0.0, UPPER_DECK_Y + 0.15, -16.0, SpawnZone.Mid),
];

// ---------------------------------------------------------------------------
// Sightline metadata — consumed by spawn scoring and the bot navigation stub.
// ---------------------------------------------------------------------------

/** The long mid-spine shot: bow corridor to stern corridor, ~44m. */
export const CROSSMAP_SIGHTLINE = {
  from: { x: 0, y: 1.6, z: 22 } as Vec3,
  to: { x: 0, y: 1.6, z: -22 } as Vec3,
};

/** Named zones used by the killfeed and spawn logic. */
export const ZONE_LABELS = [
  { name: 'Bow', min: { x: -9, y: -2, z: 22 }, max: { x: 9, y: 8, z: 32 } },
  { name: 'Fore Cabin', min: { x: -5, y: -2, z: 11 }, max: { x: 5, y: 8, z: 21 } },
  { name: 'Pool', min: { x: -4.5, y: -2, z: -7.5 }, max: { x: 4.5, y: 4, z: 7.5 } },
  { name: 'Port Walkway', min: { x: -9.5, y: -2, z: -26 }, max: { x: -4, y: 3, z: 26 } },
  { name: 'Starboard Walkway', min: { x: 4, y: -2, z: -26 }, max: { x: 9.5, y: 3, z: 26 } },
  { name: 'Upper Deck', min: { x: -9, y: 3, z: -22 }, max: { x: 9, y: 8, z: 22 } },
  { name: 'Aft Cabin', min: { x: -5, y: -2, z: -21 }, max: { x: 5, y: 8, z: -11 } },
  { name: 'Stern', min: { x: -9, y: -2, z: -32 }, max: { x: 9, y: 8, z: -22 } },
] as const;

/**
 * Sanity check run by tests: the map must be exactly mirror-symmetric about
 * Z = 0, or one spawn has an advantage and the mode is broken.
 */
export function assertSymmetric(): void {
  const key = (x: Brush) =>
    `${x.center.x.toFixed(3)},${x.center.y.toFixed(3)},${Math.abs(x.center.z).toFixed(3)},` +
    `${x.half.x},${x.half.y},${x.half.z},${x.material}`;
  const counts = new Map<string, number>();
  for (const brush of BRUSHES) {
    if (Math.abs(brush.center.z) < 1e-6) continue; // on the mirror plane
    counts.set(key(brush), (counts.get(key(brush)) ?? 0) + 1);
  }
  for (const [k, n] of counts) {
    if (n % 2 !== 0) throw new Error(`Sundeck is not symmetric about Z=0: ${k} appears ${n} time(s)`);
  }
}
