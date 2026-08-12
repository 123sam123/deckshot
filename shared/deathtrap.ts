/**
 * DEATH TRAP — adapted from the Red Eclipse map of the same name.
 *
 *   Original: "Death Trap" by Derek Stegall, Architect, Favorito and SniperGoth
 *   Project:  Red Eclipse (redeclipse/maps)
 *   Licence:  CC BY-SA 4.0
 *
 * An ADAPTATION, not a conversion. Nothing is copied. The original's flow was
 * read off its own bot-waypoint graph — a four-fold symmetric arena around a
 * sunken centre, with one long spine crossing the whole map overhead — and that
 * shape was rebuilt at Deckshot's movement metrics (0.4m step, 1.05m jump apex,
 * no jump pads, no rocket jumps, 50 degree max slope).
 *
 * The original is an enclosed neon interior stacked three levels deep. This is
 * TWO levels, open to the sky. The third was a 5m-wide balcony ring, and it
 * roofed the ENTIRE ground floor: every lane became an unlit 3.3m tunnel and
 * you spawned inside one. Everything that ring was for — height, a flank, a
 * place to drop from — the bridge does on its own, without the lid.
 *
 * ---------------------------------------------------------------------------
 * LAYOUT — four-fold symmetric, two levels, open to the sky
 *
 *   z=+26 ┌──────────── A SPAWN DECK ─────────────┐
 *         │      ╱ramp        ramp╲               │   ramps at x=±3.5 climb to
 *   z=+15 │  ▣  ┌───── landing y=3.3 ─────┐   ▣   │   the landing, which feeds
 *   z=+13 │     │      THE BRIDGE         │       │   the bridge
 *   z=+11 │ ┌───┴─────────────────────────┴─────┐ │
 *   z=0   │ │▓        THE PIT  y=-2            ▓│ │  <- no floor at deck level
 *   z=-11 │ └───┬─────────────────────────┬─────┘ │
 *         │  ▣  └────── landing y=3.3 ────┘   ▣   │
 *   z=-26 └──────────── B SPAWN DECK ─────────────┘
 *
 *   The centre of the map is a HOLE. Standing on either spawn deck you see 48m
 *   clean across it to the other spawn — that is the cross-map shot, and it
 *   runs under both landings at x=0, which is exactly why the ramps are held
 *   off the centreline. Crossing at floor level means the pit ramps at x=0 or
 *   the side lanes at x=±12. Dropping off the bridge is the airborne shot.
 * ---------------------------------------------------------------------------
 */

import { BrushTag, SpawnZone, SurfaceMaterial, type Brush } from './mapdata.js';
import { b, mirrorX, mirrorZ, quad, solvedRamp, sp } from './brushkit.js';
import { MapId, PropSet, type MapDef } from './mapdef.js';

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

const PIT_Y = -2.0;
/** Top surface of the bridge and its two landings. */
const BRIDGE_Y = 3.3;
/** Sea surface, and the height below which you are gone. */
const WATER_Y = -6.0;

const brushes: Brush[] = [];

// --- Main floor: a frame around the pit. The middle is deliberately absent. --
{
  const end = b('floor_end_a', [0, -0.25, 18.4], [15, 0.25, 7.4], SurfaceMaterial.Metal, BrushTag.Deck);
  brushes.push(end, mirrorZ(end));

  const side = b('floor_side_p', [-12, -0.25, 0], [3, 0.25, 11], SurfaceMaterial.Metal, BrushTag.Deck);
  brushes.push(side, mirrorX(side, '_s'));
}

// --- The pit: 2m below the floor, and the reason the map is called this -----
{
  brushes.push(b('pit_floor', [0, PIT_Y - 0.25, 0], [9, 0.25, 11], SurfaceMaterial.Composite, BrushTag.Deck));

  const wallX = b('pit_wall_p', [-9.15, -1.0, 0], [0.15, 1.0, 11.3], SurfaceMaterial.Composite, BrushTag.Wall);
  brushes.push(wallX, mirrorX(wallX, '_s'));

  // End walls, split either side of the ramp mouth at x=0.
  const wallZ = b('pit_wall_a_p', [-5.45, -1.0, 11.15], [3.85, 1.0, 0.15], SurfaceMaterial.Composite, BrushTag.Wall);
  quad(brushes, wallZ);

  // Cover inside the pit. Tops sit at y=-0.3 — below floor level, so they break
  // sightlines down there without offering a step back up.
  const block = b('pit_block_p', [-5, -1.15, 5], [1.2, 0.85, 1.2], SurfaceMaterial.Composite, BrushTag.Cover);
  quad(brushes, block);
}

// --- Ramps in and out of the pit, at x=0 on both ends -----------------------
{
  const ramp = solvedRamp('pit_ramp_b', 0, {
    topY: 0,
    bottomY: PIT_Y,
    topZ: -11,
    run: 4.4,
    halfX: 1.6,
    halfY: 0.16,
  });
  brushes.push(ramp, mirrorZ(ramp));
}

// --- Perimeter parapet: head-glitch height around the whole platform --------
// 1.1m, so you see the sea over it standing and are hidden behind it crouched.
{
  const side = b('parapet_p', [-15.3, 0.55, 0], [0.3, 0.55, 25.8], SurfaceMaterial.Metal, BrushTag.Railing);
  brushes.push(side, mirrorX(side, '_s'));

  const end = b('parapet_a', [0, 0.55, 26.1], [15.3, 0.55, 0.3], SurfaceMaterial.Metal, BrushTag.Railing);
  brushes.push(end, mirrorZ(end));
}

// --- Pillars: waist-and-shoulder cover on the long approaches ---------------
{
  const inner = b('pillar_in_p', [-12, 1.1, 6], [0.9, 1.1, 0.9], SurfaceMaterial.Composite, BrushTag.Wall);
  const outer = b('pillar_out_p', [-6, 1.1, 21.5], [0.9, 1.1, 0.9], SurfaceMaterial.Composite, BrushTag.Wall);
  quad(brushes, inner);
  quad(brushes, outer);
}

// --- The bridge: one lane straight over the pit at y=3.3 --------------------
// 27m long, 3.2m wide, no cover. Holding it owns the middle; being seen on it
// loses the duel. Dropping off into the pit is a 5.3m fall — Deckshot has no
// fall damage, so that is a route, not a mistake.
{
  brushes.push(b('bridge', [0, BRIDGE_Y - 0.15, 0], [1.6, 0.15, 13.4], SurfaceMaterial.Metal, BrushTag.Catwalk));

  const rail = b('bridge_rail_p', [-1.65, BRIDGE_Y + 0.45, 0], [0.05, 0.45, 13.4], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  });
  brushes.push(rail, mirrorX(rail, '_s'));

  // A landing at each end, wide enough that the ramps can arrive off-centre.
  // Its underside is 3.0m up, so the cross-map shot passes clean beneath it.
  const landing = b('bridge_landing_a', [0, BRIDGE_Y - 0.15, 14.4], [5, 0.15, 1.0], SurfaceMaterial.Metal, BrushTag.Catwalk);
  brushes.push(landing, mirrorZ(landing));

  const landingRail = b('landing_rail_a_p', [-4.95, BRIDGE_Y + 0.45, 14.4], [0.05, 0.45, 1.0], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  });
  quad(brushes, landingRail);

  // Only the MIDDLE of the landing's back edge is railed. The two ramps arrive
  // at x=±3.5, and a rail across the full width sat exactly on their top step —
  // you walked all the way up and stopped 0.35m short, for no visible reason.
  const landingBack = b('landing_back_a', [0, BRIDGE_Y + 0.45, 15.35], [2.1, 0.45, 0.05], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  });
  brushes.push(landingBack, mirrorZ(landingBack));
}

// --- Four ramps, spawn deck up to a landing --------------------------------
// Held off x=0 so they never cross the map's own long sightline.
{
  const ramp = solvedRamp('ramp_bridge_a_p', -3.5, {
    topY: BRIDGE_Y,
    bottomY: 0,
    topZ: 15.4,
    run: 6.72,
    halfX: 1.4,
  });
  quad(brushes, ramp);
}

// --- Crates: the only cover on the long approach lanes ----------------------
{
  const tall = b('crate_a_p', [-7, 0.9, 15.5], [1.0, 0.9, 1.0], SurfaceMaterial.Composite, BrushTag.Crate);
  const low = b('crate_side_p', [-12, 0.6, 9], [0.8, 0.6, 1.6], SurfaceMaterial.Composite, BrushTag.Crate);
  quad(brushes, tall);
  quad(brushes, low);
}

export const DEATHTRAP: MapDef = {
  id: MapId.DeathTrap,
  name: 'Death Trap',
  tagline: 'A steel rig with a hole in the middle. Cross it, or hold the bridge.',
  credit: {
    original: 'Death Trap',
    authors: 'Derek Stegall, Architect, Favorito and SniperGoth',
    project: 'Red Eclipse',
    license: 'CC BY-SA 4.0',
    url: 'https://github.com/redeclipse/maps',
  },
  competitive: true,
  environment: {
    ocean: true,
    ground: null,
    props: PropSet.Rig,
    poolWater: null,
    hullHalf: [16.0, 26.5],
  },
  sightline: { from: { x: 0, y: 1.6, z: 24 }, to: { x: 0, y: 1.6, z: -24 } },
  brushes,
  bounds: { min: { x: -20, y: -10, z: -32 }, max: { x: 20, y: 34, z: 32 } },
  waterLevel: WATER_Y,
  spawns: [
    sp(0, 0.0, 0.0, 24.0, SpawnZone.Bow),
    sp(1, -6.5, 0.0, 24.0, SpawnZone.Bow),
    sp(2, 6.5, 0.0, 24.0, SpawnZone.Bow),
    sp(3, -13.5, 0.0, 18.0, SpawnZone.Bow),
    sp(4, 13.5, 0.0, 18.0, SpawnZone.Bow),
    sp(5, 0.0, 0.0, -24.0, SpawnZone.Stern),
    sp(6, -6.5, 0.0, -24.0, SpawnZone.Stern),
    sp(7, 6.5, 0.0, -24.0, SpawnZone.Stern),
    sp(8, -13.5, 0.0, -18.0, SpawnZone.Stern),
    sp(9, 13.5, 0.0, -18.0, SpawnZone.Stern),
    // Neutral: the side lanes and the bridge itself, for FFA churn.
    sp(10, -12.0, 0.0, 12.5, SpawnZone.Mid),
    sp(11, 12.0, 0.0, 12.5, SpawnZone.Mid),
    sp(12, -12.0, 0.0, -12.5, SpawnZone.Mid),
    sp(13, 12.0, 0.0, -12.5, SpawnZone.Mid),
    sp(14, 0.0, BRIDGE_Y, 6.0, SpawnZone.Mid),
    sp(15, 0.0, BRIDGE_Y, -6.0, SpawnZone.Mid),
  ],
  zones: [],
  navNodes: [],
  interactables: [],
  zombieSpawners: [],
  doorBrushIdsByZone: [],
};
