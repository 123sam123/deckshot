/**
 * DECKSHOT — "Leviathan", the SURVIVAL map, as data.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * A derelict liner, ~136m x 34m, three deck levels, eight purchasable zones.
 * Built from the same Brush / SurfaceMaterial / BrushTag vocabulary as the
 * frozen Sundeck (`shared/mapdata.ts` is imported for TYPES ONLY — never
 * edited), so the client's material registry, ocean, sky and footstep audio
 * work with zero new art.
 *
 * DELIBERATELY ASYMMETRIC. `assertSymmetric()` applies to Sundeck only; a
 * progression map fails it by design.
 *
 * ---------------------------------------------------------------------------
 * COORDINATES: +X starboard, +Y up, +Z bow. Origin amidships at main-deck level.
 *
 * DECKS:  lower (engine room) floor at Y=-3.4 · main deck Y=0 · upper Y=3.5
 *
 * ZONES (aft to bow):
 *   z=-68  [0 Aft Deck: spawn]  -48  [2 Galley | 1 Promenade port/stbd strips]
 *   -22  [3 Engine Room below | 4 Atrium above]  8  [6 Cargo Hold, 5 Bridge
 *   above its aft half]  40  [7 Sun Deck, upper]  68
 * ---------------------------------------------------------------------------
 */

import { BrushTag, SurfaceMaterial, SpawnZone, type Brush, type SpawnPoint } from './mapdata.js';
import { WeaponId, type Vec3 } from './types.js';
import type { NavNode } from './navgraph.js';
import { PerkId } from './survival.js';
import {
  InteractableKind,
  MapId,
  type Interactable,
  type MapDef,
  type Zone,
  type ZombieSpawner,
} from './mapdef.js';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const b = (
  id: string,
  center: [number, number, number],
  half: [number, number, number],
  material: SurfaceMaterial,
  tag: BrushTag,
  opts: { yaw?: number; pitch?: number; penetrable?: boolean } = {},
): Brush => ({
  id,
  center: v(center[0], center[1], center[2]),
  half: v(half[0], half[1], half[2]),
  yaw: opts.yaw ?? 0,
  pitch: opts.pitch ?? 0,
  material,
  penetrable: opts.penetrable ?? false,
  tag,
});

const brushes: Brush[] = [];

// ---------------------------------------------------------------------------
// Hull and outer decks
// ---------------------------------------------------------------------------

// Side hulls: Y -4..5, so the Sun Deck (3.5) keeps a 1.5m bulwark.
brushes.push(
  b('lv_hull_p', [-17.35, 0.5, 0], [0.6, 4.5, 68.6], SurfaceMaterial.Metal, BrushTag.Hull),
  b('lv_hull_s', [17.35, 0.5, 0], [0.6, 4.5, 68.6], SurfaceMaterial.Metal, BrushTag.Hull),
  b('lv_hull_stern', [0, 0.5, -68.35], [17.4, 4.5, 0.6], SurfaceMaterial.Metal, BrushTag.Hull),
  b('lv_hull_bow', [0, 2.0, 68.35], [17.4, 6.0, 0.6], SurfaceMaterial.Metal, BrushTag.Hull),
);

// Main-deck floor slabs (top at Y=0), pierced by two engine-room ramp holes:
//   hole A (Galley -> Engine): x 2..6, z -24..-18
//   hole B (Engine -> Atrium): x -6..-2, z 0..6
brushes.push(
  b('lv_deck_aft', [0, -0.25, -58], [17, 0.25, 10], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_deck_galley', [0, -0.25, -37], [17, 0.25, 11], SurfaceMaterial.Teak, BrushTag.Deck),
  // band z -26..-18 around hole A
  b('lv_deck_ha_w', [-7.5, -0.25, -22], [9.5, 0.25, 4], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_deck_ha_e', [11.5, -0.25, -22], [5.5, 0.25, 4], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_deck_ha_n', [4, -0.25, -25], [2, 0.25, 1], SurfaceMaterial.Teak, BrushTag.Deck),
  // band z -18..0
  b('lv_deck_mid', [0, -0.25, -9], [17, 0.25, 9], SurfaceMaterial.Teak, BrushTag.Deck),
  // band z 0..8 around hole B
  b('lv_deck_hb_w', [-11.5, -0.25, 4], [5.5, 0.25, 4], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_deck_hb_e', [7.5, -0.25, 4], [9.5, 0.25, 4], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_deck_hb_n', [-4, -0.25, 7], [2, 0.25, 1], SurfaceMaterial.Teak, BrushTag.Deck),
  // cargo hold floor
  b('lv_deck_cargo', [0, -0.25, 24], [17, 0.25, 16], SurfaceMaterial.Metal, BrushTag.Deck),
);

// Sun Deck (upper bow deck, top at Y=3.5) with a ramp hole at x 10..14, z 40..44,
// sitting on a solid bow block whose aft face walls the Cargo Hold.
brushes.push(
  b('lv_sun_floor_w', [-3.5, 3.25, 54], [13.5, 0.25, 14], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_sun_floor_e', [15.5, 3.25, 54], [1.5, 0.25, 14], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_sun_floor_r', [12, 3.25, 56], [2, 0.25, 12], SurfaceMaterial.Teak, BrushTag.Deck),
  b('lv_bow_block', [0, 1.5, 56], [17, 1.5, 12], SurfaceMaterial.Metal, BrushTag.Hull),
  b('lv_bow_block_aft', [-3.5, 1.5, 42], [13.5, 1.5, 2], SurfaceMaterial.Metal, BrushTag.Hull),
);

// ---------------------------------------------------------------------------
// Engine room (lower deck): floor, walls; the ceiling is the main deck above.
// ---------------------------------------------------------------------------

brushes.push(
  b('lv_eng_floor', [0, -3.65, -7], [10.5, 0.25, 15.5], SurfaceMaterial.Metal, BrushTag.Deck),
  b('lv_eng_wall_p', [-10.25, -1.7, -7], [0.25, 1.7, 15.5], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_eng_wall_s', [10.25, -1.7, -7], [0.25, 1.7, 15.5], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_eng_wall_a', [0, -1.7, -22.25], [10.5, 1.7, 0.25], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_eng_wall_f', [0, -1.7, 8.25], [10.5, 1.7, 0.25], SurfaceMaterial.Metal, BrushTag.Wall),
  // machinery blocks — cramped, the worst room to fight in
  b('lv_eng_boiler_1', [-5, -2.4, -14], [1.6, 1.2, 2.4], SurfaceMaterial.Metal, BrushTag.Cover),
  b('lv_eng_boiler_2', [5.5, -2.4, -4], [1.6, 1.2, 2.4], SurfaceMaterial.Metal, BrushTag.Cover),
  b('lv_eng_boiler_3', [-4.5, -2.4, 2], [1.4, 1.2, 1.8], SurfaceMaterial.Metal, BrushTag.Cover),
  b('lv_eng_generator', [0, -2.5, -19.5], [2.2, 1.1, 1.4], SurfaceMaterial.Metal, BrushTag.Crate),
);

// Ramp A: Galley (z=-24, y=0) down to Engine (z=-18, y=-3.4). Rises toward -Z.
{
  const pitch = Math.atan2(3.4, 6);
  const len = Math.hypot(3.4, 6) / 2;
  brushes.push(
    b('lv_ramp_engine_a', [4, -1.7, -21], [1.9, 0.15, len], SurfaceMaterial.Metal, BrushTag.Ramp, {
      pitch,
    }),
  );
}
// Ramp B: Engine (z=0 at y=-3.4... rises to Atrium z=6, wait) — Atrium (z=0, y=0)
// down toward bow to Engine (z=6, y=-3.4). Falls toward +Z.
{
  const pitch = Math.atan2(3.4, 6);
  const len = Math.hypot(3.4, 6) / 2;
  brushes.push(
    b('lv_ramp_engine_b', [-4, -1.7, 3], [1.9, 0.15, len], SurfaceMaterial.Metal, BrushTag.Ramp, {
      pitch,
    }),
  );
}

// ---------------------------------------------------------------------------
// Galley interior (zone 2): counters and tight lines
// ---------------------------------------------------------------------------

brushes.push(
  b('lv_gal_counter_1', [-4, 0.55, -42], [4, 0.55, 0.8], SurfaceMaterial.Composite, BrushTag.Cover),
  b('lv_gal_counter_2', [4, 0.55, -38], [4, 0.55, 0.8], SurfaceMaterial.Composite, BrushTag.Cover),
  b('lv_gal_counter_3', [-4, 0.55, -32], [4, 0.55, 0.8], SurfaceMaterial.Composite, BrushTag.Cover),
  b('lv_gal_shelf', [8.5, 1.5, -44], [1.0, 1.5, 2.5], SurfaceMaterial.Composite, BrushTag.Crate),
  // galley roof: an upper walk-over cover between promenades (visual mass + cover from Bridge)
  b('lv_gal_roof', [0, 3.4, -35], [10, 0.15, 13], SurfaceMaterial.Composite, BrushTag.Roof),
);

// ---------------------------------------------------------------------------
// Atrium (zone 4): three-deck open centre; perk machines line the walls
// ---------------------------------------------------------------------------

const PERK_MACHINE_POSITIONS: Array<[PerkId, number, number, number]> = [
  [PerkId.Deadeye, -8.5, 0, -16],
  [PerkId.Quickhands, -8.5, 0, -2],
  [PerkId.Doubletap, 8.5, 0, -16],
  [PerkId.SteadyHand, 8.5, 0, -2],
  [PerkId.Corpsman, -6, 0, -20.5],
];
for (const [perk, x, y, z] of PERK_MACHINE_POSITIONS) {
  brushes.push(
    b(`lv_perk_${perk}`, [x, y + 0.9, z], [0.55, 0.9, 0.45], SurfaceMaterial.Composite, BrushTag.Crate),
  );
}

// Ramp Atrium (z=0, y=0) up to Bridge (z=8, y=3.5), against the starboard wall.
{
  const pitch = -Math.atan2(3.5, 8);
  const len = Math.hypot(3.5, 8) / 2;
  brushes.push(
    b('lv_ramp_bridge', [8, 1.75, 4], [1.5, 0.15, len], SurfaceMaterial.Metal, BrushTag.Ramp, {
      pitch,
    }),
  );
}

// ---------------------------------------------------------------------------
// Bridge (zone 5): elevated deck over the cargo hold's aft half, long sightlines
// ---------------------------------------------------------------------------

brushes.push(
  b('lv_bridge_floor', [0, 3.35, 18], [9, 0.15, 10], SurfaceMaterial.Metal, BrushTag.Catwalk),
  b('lv_bridge_rail_p', [-8.9, 4.1, 18], [0.1, 0.6, 10], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  }),
  b('lv_bridge_rail_s', [8.9, 4.1, 18], [0.1, 0.6, 10], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  }),
  b('lv_bridge_console', [0, 4.0, 12], [3.2, 0.5, 0.8], SurfaceMaterial.Composite, BrushTag.Cover),
  // glass screen facing the bow — penetrable, the overwatch line
  b('lv_bridge_glass', [0, 4.6, 27.8], [7, 1.0, 0.1], SurfaceMaterial.Glass, BrushTag.Window, {
    penetrable: true,
  }),
  // catwalk to the Sun Deck
  b('lv_catwalk', [0, 3.35, 34], [2, 0.15, 6], SurfaceMaterial.Metal, BrushTag.Catwalk),
  b('lv_catwalk_rail_p', [-1.9, 4.0, 34], [0.1, 0.5, 6], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  }),
  b('lv_catwalk_rail_s', [1.9, 4.0, 34], [0.1, 0.5, 6], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  }),
);

// ---------------------------------------------------------------------------
// Cargo hold (zone 6): container maze under the bridge deck
// ---------------------------------------------------------------------------

{
  // Containers 4x2.2x2.2, laid out in staggered rows. Deterministic layout.
  const rows: Array<[number, number, number, boolean]> = [
    // [x, z, yawQuarter, stacked]
    [-10, 12, 0, true],
    [-4, 14, 0, false],
    [4, 12, 1, true],
    [11, 15, 0, false],
    [-12, 22, 1, false],
    [-5, 24, 0, true],
    [3, 22, 0, false],
    [10, 24, 1, true],
    [-9, 32, 0, false],
    [-2, 34, 1, true],
    [6, 32, 0, true],
    [13, 33, 0, false],
  ];
  let i = 0;
  for (const [x, z, yawQ, stacked] of rows) {
    const yaw = yawQ === 1 ? Math.PI / 2 : 0;
    brushes.push(
      b(`lv_cont_${i}`, [x, 1.1, z], [2.0, 1.1, 1.1], SurfaceMaterial.Metal, BrushTag.Crate, { yaw }),
    );
    if (stacked) {
      brushes.push(
        b(`lv_cont_${i}_top`, [x + 0.3, 3.3, z], [2.0, 1.1, 1.1], SurfaceMaterial.Metal, BrushTag.Crate, {
          yaw,
        }),
      );
    }
    i++;
  }
  // The Forge — Pack-a-Punch equivalent, deep in the maze
  brushes.push(
    b('lv_forge', [0, 0.9, 30], [1.4, 0.9, 0.9], SurfaceMaterial.Metal, BrushTag.Crate),
  );
}

// Ramp Cargo (z=38, y=0) up to Sun Deck (z=44, y=3.5).
{
  const pitch = -Math.atan2(3.5, 6);
  const len = Math.hypot(3.5, 6) / 2;
  brushes.push(
    b('lv_ramp_sun', [12, 1.75, 41], [1.9, 0.15, len], SurfaceMaterial.Metal, BrushTag.Ramp, {
      pitch,
    }),
  );
}

// ---------------------------------------------------------------------------
// Sun deck furniture (zone 7): the run-a-train zone — open, with islands
// ---------------------------------------------------------------------------

{
  const loungers: Array<[number, number]> = [
    [-10, 48],
    [-6, 48],
    [-2, 48],
    [-10, 62],
    [-6, 62],
    [-2, 62],
  ];
  let i = 0;
  for (const [x, z] of loungers) {
    brushes.push(
      b(`lv_lounger_${i++}`, [x, 3.85, z], [0.6, 0.35, 1.4], SurfaceMaterial.Fabric, BrushTag.Cover, {
        penetrable: true,
      }),
    );
  }
  brushes.push(
    b('lv_sun_bar', [8, 4.05, 55], [1.2, 0.55, 3], SurfaceMaterial.Teak, BrushTag.Cover),
    b('lv_sun_funnel', [-9, 5.5, 55], [1.8, 2.0, 1.8], SurfaceMaterial.Metal, BrushTag.Hull, {
      yaw: Math.PI / 7,
    }),
  );
}

// ---------------------------------------------------------------------------
// Aft deck furniture (zone 0): spawn, a little cover, the first ammo crates
// ---------------------------------------------------------------------------

brushes.push(
  b('lv_aft_crate_1', [-8, 0.7, -62], [0.9, 0.7, 0.9], SurfaceMaterial.Composite, BrushTag.Crate),
  b('lv_aft_crate_2', [-6.6, 1.9, -62.4], [0.6, 0.5, 0.6], SurfaceMaterial.Composite, BrushTag.Crate),
  b('lv_aft_crate_3', [9, 0.7, -60], [0.9, 0.7, 0.9], SurfaceMaterial.Composite, BrushTag.Crate),
  b('lv_aft_mast', [0, 2.5, -64], [0.4, 2.5, 0.4], SurfaceMaterial.Metal, BrushTag.Hull),
  b('lv_aft_bench_p', [-13, 0.35, -55], [0.6, 0.35, 1.6], SurfaceMaterial.Fabric, BrushTag.Cover, {
    penetrable: true,
  }),
  b('lv_aft_bench_s', [13, 0.35, -55], [0.6, 0.35, 1.6], SurfaceMaterial.Fabric, BrushTag.Cover, {
    penetrable: true,
  }),
);

// ---------------------------------------------------------------------------
// Zone boundary walls (permanent) and DOORS (removed when the zone opens)
// ---------------------------------------------------------------------------

const wallOpts = { penetrable: true } as const;
const W = SurfaceMaterial.Composite;

// Z0 | Z1: wall at z=-48, door gaps on both promenade strips (x ±13.5, width 4)
brushes.push(
  b('lv_w0_c', [0, 1.6, -48], [11.5, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
  b('lv_w0_p', [-16.25, 1.6, -48], [0.75, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
  b('lv_w0_s', [16.25, 1.6, -48], [0.75, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
);
const DOORS_Z1 = [
  b('lv_door_z1_p', [-13.5, 1.6, -48], [2, 1.6, 0.25], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_door_z1_s', [13.5, 1.6, -48], [2, 1.6, 0.25], SurfaceMaterial.Metal, BrushTag.Wall),
];

// Z1 | Z2: galley side walls at x=±10 (z -48..-22), door gaps at z=-35 (width 4)
for (const side of [-1, 1]) {
  const sx = side * 10;
  const tag = side < 0 ? 'p' : 's';
  brushes.push(
    b(`lv_w2_${tag}_a`, [sx, 1.6, -42.5], [0.3, 1.6, 5.5], W, BrushTag.Wall, wallOpts),
    b(`lv_w2_${tag}_f`, [sx, 1.6, -27.5], [0.3, 1.6, 5.5], W, BrushTag.Wall, wallOpts),
  );
}
const DOORS_Z2 = [
  b('lv_door_z2_p', [-10, 1.6, -35], [0.25, 1.6, 2], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_door_z2_s', [10, 1.6, -35], [0.25, 1.6, 2], SurfaceMaterial.Metal, BrushTag.Wall),
];

// Z2 | Z4: wall at z=-22 (x -10..10), centre gap x -2..2
brushes.push(
  b('lv_w4_aw', [-6, 1.6, -22], [4, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
  b('lv_w4_ae', [6, 1.6, -22], [4, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
);
// Z1 | Z4: atrium side walls at x=±10 (z -22..8) with door gaps at z=-7 (width 4)
for (const side of [-1, 1]) {
  const sx = side * 10;
  const tag = side < 0 ? 'p' : 's';
  brushes.push(
    b(`lv_w4_${tag}_a`, [sx, 1.6, -15.5], [0.3, 1.6, 6.5], W, BrushTag.Wall, wallOpts),
    b(`lv_w4_${tag}_f`, [sx, 1.6, 1.5], [0.3, 1.6, 6.5], W, BrushTag.Wall, wallOpts),
  );
}
const DOORS_Z4 = [
  b('lv_door_z4_a', [0, 1.6, -22], [2, 1.6, 0.25], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_door_z4_p', [-10, 1.6, -7], [0.25, 1.6, 2], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_door_z4_s', [10, 1.6, -7], [0.25, 1.6, 2], SurfaceMaterial.Metal, BrushTag.Wall),
  // debris at the top landing of engine ramp B (blocks Engine->Atrium until open)
  b('lv_door_z4_b', [-4, -1.0, 6.5], [2, 2.6, 0.4], SurfaceMaterial.Metal, BrushTag.Crate),
];

// Z3 (Engine): debris on ramp A (the only other way in)
const DOORS_Z3 = [
  b('lv_door_z3_a', [4, -0.6, -20], [2, 1.6, 0.4], SurfaceMaterial.Metal, BrushTag.Crate),
];

// Z5 (Bridge): debris on the atrium ramp + the catwalk gate at its bridge end
const DOORS_Z5 = [
  b('lv_door_z5_r', [8, 2.6, 6], [1.6, 1.5, 0.4], SurfaceMaterial.Metal, BrushTag.Crate),
  b('lv_door_z5_c', [0, 4.5, 29], [2, 1.2, 0.4], SurfaceMaterial.Metal, BrushTag.Crate),
];

// Z6 (Cargo): wall at z=8 with three gaps — centre (from Atrium) + both promenade ends
brushes.push(
  b('lv_w6_wc', [-6.75, 1.6, 8], [4.75, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
  b('lv_w6_ec', [6.75, 1.6, 8], [4.75, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
  b('lv_w6_wp', [-16.25, 1.6, 8], [0.75, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
  b('lv_w6_ep', [16.25, 1.6, 8], [0.75, 1.6, 0.3], W, BrushTag.Wall, wallOpts),
);
const DOORS_Z6 = [
  b('lv_door_z6_a', [0, 1.6, 8], [2, 1.6, 0.3], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_door_z6_p', [-13.5, 1.6, 8], [2, 1.6, 0.3], SurfaceMaterial.Metal, BrushTag.Wall),
  b('lv_door_z6_s', [13.5, 1.6, 8], [2, 1.6, 0.3], SurfaceMaterial.Metal, BrushTag.Wall),
];

// Z7 (Sun Deck): debris on the cargo ramp + the catwalk gate at its sun-deck end
const DOORS_Z7 = [
  b('lv_door_z7_r', [12, 1.4, 40], [1.9, 1.8, 0.4], SurfaceMaterial.Metal, BrushTag.Crate),
  b('lv_door_z7_c', [0, 4.5, 39], [2, 1.2, 0.4], SurfaceMaterial.Metal, BrushTag.Crate),
];

for (const doors of [DOORS_Z1, DOORS_Z2, DOORS_Z3, DOORS_Z4, DOORS_Z5, DOORS_Z6, DOORS_Z7]) {
  brushes.push(...doors);
}

export const LEVIATHAN_BRUSHES: readonly Brush[] = brushes;

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const box = (min: [number, number, number], max: [number, number, number]) => ({
  min: v(min[0], min[1], min[2]),
  max: v(max[0], max[1], max[2]),
});

const ZONES: readonly Zone[] = [
  {
    id: 0,
    name: 'Aft Deck',
    cost: 0,
    requiresPower: false,
    adjacent: [],
    boxes: [box([-17, -1, -68], [17, 8, -48])],
  },
  {
    id: 1,
    name: 'Promenade',
    cost: 750,
    requiresPower: false,
    adjacent: [0],
    boxes: [box([-17, -1, -48], [-10, 8, 8]), box([10, -1, -48], [17, 8, 8])],
  },
  {
    id: 2,
    name: 'Galley',
    cost: 1000,
    requiresPower: false,
    adjacent: [1],
    boxes: [box([-10, -1, -48], [10, 8, -22])],
  },
  {
    id: 3,
    name: 'Engine Room',
    cost: 1250,
    requiresPower: false,
    adjacent: [2, 4],
    boxes: [box([-10.5, -4.5, -26], [10.5, -0.4, 8.5])],
  },
  {
    id: 4,
    name: 'Atrium',
    cost: 1000,
    requiresPower: true,
    adjacent: [1, 2, 3],
    boxes: [box([-10, -0.4, -22], [10, 8, 8])],
  },
  {
    id: 5,
    name: 'Bridge',
    cost: 1500,
    requiresPower: true,
    adjacent: [4, 7],
    boxes: [box([-9, 2.5, 8], [9, 8, 28]), box([-2.5, 2.5, 28], [2.5, 8, 34])],
  },
  {
    id: 6,
    name: 'Cargo Hold',
    cost: 1750,
    requiresPower: false,
    adjacent: [1, 4],
    boxes: [box([-17, -1, 8], [17, 2.5, 40])],
  },
  {
    id: 7,
    name: 'Sun Deck',
    cost: 2000,
    requiresPower: false,
    adjacent: [5, 6],
    boxes: [box([-17, 2, 40], [17, 9, 68]), box([-2.5, 2.5, 34], [2.5, 8, 40]), box([9, -1, 36], [15, 4, 44])],
  },
];

export const LEVIATHAN_TOTAL_UNLOCK_COST = ZONES.reduce((s, z) => s + z.cost, 0);

// ---------------------------------------------------------------------------
// Nav graph — nodes carry the zone that gates entering them
// ---------------------------------------------------------------------------

interface N {
  x: number;
  y: number;
  z: number;
  zone: number;
  edges: number[];
}

// Node ids are dense indices into this array; edges list both directions.
const NAV: N[] = [
  // Zone 0 — Aft Deck
  { x: 0, y: 0, z: -66, zone: 0, edges: [1] }, // 0 stern point
  { x: 0, y: 0, z: -58, zone: 0, edges: [0, 2, 3] }, // 1 aft centre
  { x: -12, y: 0, z: -52, zone: 0, edges: [1, 4] }, // 2 aft port
  { x: 12, y: 0, z: -52, zone: 0, edges: [1, 9] }, // 3 aft stbd
  // Zone 1 — Promenade (port 4..8, stbd 9..13)
  { x: -13.5, y: 0, z: -44, zone: 1, edges: [2, 5] }, // 4
  { x: -13.5, y: 0, z: -35, zone: 1, edges: [4, 6, 15] }, // 5 (galley door p)
  { x: -13.5, y: 0, z: -16, zone: 1, edges: [5, 7] }, // 6
  { x: -13.5, y: 0, z: -7, zone: 1, edges: [6, 8, 24] }, // 7 (atrium door p)
  { x: -13.5, y: 0, z: 5, zone: 1, edges: [7, 30] }, // 8 (cargo door p)
  { x: 13.5, y: 0, z: -44, zone: 1, edges: [3, 10] }, // 9
  { x: 13.5, y: 0, z: -35, zone: 1, edges: [9, 11, 16] }, // 10 (galley door s)
  { x: 13.5, y: 0, z: -16, zone: 1, edges: [10, 12] }, // 11
  { x: 13.5, y: 0, z: -7, zone: 1, edges: [11, 13, 25] }, // 12 (atrium door s)
  { x: 13.5, y: 0, z: 5, zone: 1, edges: [12, 31] }, // 13 (cargo door s)
  // Zone 2 — Galley 14..18
  { x: 0, y: 0, z: -44, zone: 2, edges: [15, 16, 17] }, // 14
  { x: -6, y: 0, z: -35, zone: 2, edges: [5, 14, 17] }, // 15
  { x: 6, y: 0, z: -35, zone: 2, edges: [10, 14, 17, 18] }, // 16
  { x: 0, y: 0, z: -28, zone: 2, edges: [14, 15, 16, 23] }, // 17 (near atrium door)
  { x: 4, y: 0, z: -26, zone: 2, edges: [16, 19] }, // 18 (ramp A top)
  // Zone 3 — Engine Room 19..22
  { x: 4, y: -3.4, z: -16, zone: 3, edges: [18, 20] }, // 19 (ramp A bottom)
  { x: 0, y: -3.4, z: -8, zone: 3, edges: [19, 21, 22] }, // 20 (generator bay)
  { x: 6, y: -3.4, z: 0, zone: 3, edges: [20, 22] }, // 21
  { x: -4, y: -3.4, z: -1, zone: 3, edges: [20, 21, 27] }, // 22 (ramp B bottom)
  // Zone 4 — Atrium 23..28
  { x: 0, y: 0, z: -18, zone: 4, edges: [17, 24, 25, 26] }, // 23 (galley door)
  { x: -7, y: 0, z: -10, zone: 4, edges: [7, 23, 26] }, // 24 (door p)
  { x: 7, y: 0, z: -10, zone: 4, edges: [12, 23, 26] }, // 25 (door s)
  { x: 0, y: 0, z: -4, zone: 4, edges: [23, 24, 25, 27, 28, 29] }, // 26 centre
  { x: -4, y: 0, z: -1, zone: 4, edges: [22, 26] }, // 27 (ramp B top landing)
  { x: 8, y: 0, z: 1, zone: 4, edges: [26, 33] }, // 28 (bridge ramp base)
  // 29 unused id kept dense: atrium fore door node
  { x: 0, y: 0, z: 5, zone: 4, edges: [26, 32] }, // 29 (cargo door inner)
  // Zone 6 — Cargo Hold 30..36  (before bridge so promenade links stay local)
  { x: -13.5, y: 0, z: 12, zone: 6, edges: [8, 32, 34] }, // 30 (door p inside)
  { x: 13.5, y: 0, z: 12, zone: 6, edges: [13, 32, 35] }, // 31 (door s inside)
  { x: 0, y: 0, z: 12, zone: 6, edges: [29, 30, 31, 34, 35] }, // 32 (centre aft)
  { x: 8, y: 3.5, z: 10, zone: 5, edges: [28, 37] }, // 33 (bridge ramp top) — zone 5 gate
  { x: -8, y: 0, z: 24, zone: 6, edges: [30, 32, 36] }, // 34
  { x: 8, y: 0, z: 24, zone: 6, edges: [31, 32, 36] }, // 35
  { x: 12, y: 0, z: 37, zone: 6, edges: [34, 35, 40] }, // 36 (sun ramp base)
  // Zone 5 — Bridge 37..39
  { x: 0, y: 3.5, z: 14, zone: 5, edges: [33, 38] }, // 37
  { x: 0, y: 3.5, z: 24, zone: 5, edges: [37, 39] }, // 38
  { x: 0, y: 3.5, z: 30, zone: 5, edges: [38, 41] }, // 39 (catwalk bridge end)
  // Zone 7 — Sun Deck 40..44
  { x: 12, y: 3.5, z: 45, zone: 7, edges: [36, 42] }, // 40 (sun ramp top)
  { x: 0, y: 3.5, z: 36, zone: 7, edges: [39, 42] }, // 41 (catwalk sun end)
  { x: 4, y: 3.5, z: 50, zone: 7, edges: [40, 41, 43, 44] }, // 42
  { x: -10, y: 3.5, z: 56, zone: 7, edges: [42, 44] }, // 43
  { x: 4, y: 3.5, z: 62, zone: 7, edges: [42, 43] }, // 44 bow
];

export const LEVIATHAN_NAV: readonly NavNode[] = NAV.map((n, i) => ({
  id: i,
  pos: v(n.x, n.y, n.z),
  zone: n.zone,
  edges: n.edges,
}));

// ---------------------------------------------------------------------------
// Interactables, spawners, player spawns
// ---------------------------------------------------------------------------

const INTERACTABLES: readonly Interactable[] = [
  // Wall buys
  { kind: InteractableKind.WallBuy, zone: 1, pos: v(-16.2, 1.2, -30), weapon: WeaponId.Osprey },
  { kind: InteractableKind.WallBuy, zone: 2, pos: v(9.4, 1.2, -28), weapon: WeaponId.Shrike },
  { kind: InteractableKind.WallBuy, zone: 6, pos: v(16.2, 1.2, 20), weapon: WeaponId.Harrier },
  { kind: InteractableKind.WallBuy, zone: 5, pos: v(0, 4.6, 26.5), weapon: WeaponId.Talon },
  { kind: InteractableKind.WallBuy, zone: 7, pos: v(0, 4.7, 67), weapon: WeaponId.Condor },
  // Perk machines (Atrium)
  ...PERK_MACHINE_POSITIONS.map(([perk, x, y, z]) => ({
    kind: InteractableKind.Perk,
    zone: 4,
    pos: v(x, y + 1.0, z),
    perk,
  })),
  // The Generator (Engine Room) and The Forge (Cargo Hold)
  { kind: InteractableKind.Generator, zone: 3, pos: v(0, -2.4, -19.5) },
  { kind: InteractableKind.Forge, zone: 6, pos: v(0, 1.0, 30) },
  // Mystery crate spots: A in the Galley, B in the Atrium
  { kind: InteractableKind.CrateSpot, zone: 2, pos: v(-6, 0.6, -26) },
  { kind: InteractableKind.CrateSpot, zone: 4, pos: v(6, 0.6, -20) },
];

const SPAWNERS: readonly ZombieSpawner[] = [
  { zone: 0, pos: v(-12, 0, -66) },
  { zone: 0, pos: v(12, 0, -66) },
  { zone: 1, pos: v(-15.5, 0, -28) },
  { zone: 1, pos: v(15.5, 0, -28) },
  { zone: 1, pos: v(-15.5, 0, -2) },
  { zone: 1, pos: v(15.5, 0, -2) },
  { zone: 2, pos: v(0, 0, -46) },
  { zone: 2, pos: v(-8, 0, -24) },
  { zone: 3, pos: v(8, -3.4, 6) },
  { zone: 3, pos: v(-8, -3.4, -20) },
  { zone: 4, pos: v(9, 0, -18) },
  { zone: 4, pos: v(-9, 0, -18) },
  { zone: 5, pos: v(0, 3.5, 26) },
  { zone: 5, pos: v(-7, 3.5, 10) },
  { zone: 6, pos: v(-15, 0, 38) },
  { zone: 6, pos: v(15, 0, 38) },
  { zone: 6, pos: v(0, 0, 10) },
  { zone: 7, pos: v(-14, 3.5, 66) },
  { zone: 7, pos: v(14, 3.5, 66) },
  { zone: 7, pos: v(0, 3.5, 50) },
];

// Squad spawns on the Aft Deck, facing the bow (+Z means yaw PI under the
// "yaw 0 looks down -Z" convention).
const sp = (id: number, x: number, y: number, z: number): SpawnPoint => ({
  id,
  position: v(x, y, z),
  yaw: Math.PI,
  zone: SpawnZone.Mid,
});

const LEVIATHAN_SPAWNS: readonly SpawnPoint[] = [
  sp(0, 0, 0, -56),
  sp(1, -3, 0, -58),
  sp(2, 3, 0, -58),
  sp(3, -6, 0, -60),
  sp(4, 6, 0, -60),
];

// ---------------------------------------------------------------------------
// The MapDef
// ---------------------------------------------------------------------------

export const LEVIATHAN_WATER_LEVEL = -6.0;

export const LEVIATHAN_BOUNDS = {
  min: v(-20, -8, -72),
  max: v(20, 30, 72),
};

export const LEVIATHAN: MapDef = {
  id: MapId.Leviathan,
  name: 'Leviathan',
  brushes: LEVIATHAN_BRUSHES,
  bounds: LEVIATHAN_BOUNDS,
  waterLevel: LEVIATHAN_WATER_LEVEL,
  spawns: LEVIATHAN_SPAWNS,
  zones: ZONES,
  navNodes: LEVIATHAN_NAV,
  interactables: INTERACTABLES,
  zombieSpawners: SPAWNERS,
  doorBrushIdsByZone: [
    [], // 0 Aft Deck — open from the start
    DOORS_Z1.map((d) => d.id),
    DOORS_Z2.map((d) => d.id),
    DOORS_Z3.map((d) => d.id),
    DOORS_Z4.map((d) => d.id),
    DOORS_Z5.map((d) => d.id),
    DOORS_Z6.map((d) => d.id),
    DOORS_Z7.map((d) => d.id),
  ],
};
