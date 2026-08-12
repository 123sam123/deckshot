/**
 * HANGAR A482 — adapted from the Red Eclipse map "Hangar inspection A482".
 *
 *   Original: "Hangar inspection A482" by SniperGoth
 *   Project:  Red Eclipse (redeclipse/maps)
 *   Licence:  CC BY-SA 4.0
 *   Blurb:    "A cargo ship slowly reaches it's destination."
 *
 * An ADAPTATION, not a conversion. The original's own bot-waypoint graph shows
 * two long parallel bays split down the middle, joined by cross-openings, with
 * a gantry overhead. That is what is rebuilt here, at Deckshot's metrics.
 *
 * It is a WEATHER DECK, not a sealed hold. The first draft boxed the whole map
 * in 4.6m hull walls and left a 10m hole at each end for a "bay door": you
 * couldn't see out, the map read as a grey crate, and the hole was 2m from a
 * spawn and dropped you in the sea. Now the sides are 1.1m bulwarks — you look
 * over them standing and hide behind them crouched, exactly like Sundeck — and
 * both ends are closed. The centre bulkhead is the tallest thing on the map,
 * which is the point of the map.
 *
 * ---------------------------------------------------------------------------
 * LAYOUT — two bays, one spine
 *
 *        stern (-Z)                mid                    bow (+Z)
 *   x=+13 ┌───────────── bulwark 1.1m ──────────────┐
 *         │      ▣cargo      ▣          ▣cargo      │  STARBOARD BAY
 *   x=0   │███ door ███████ door ███████ door ███████│ <- centre bulkhead 3.2m,
 *         │      ▣cargo      ▣          ▣cargo      │    walkway along its top
 *   x=-13 └───────────── bulwark 1.1m ──────────────┘  PORT BAY
 *
 *   Each bay is a 44m lane — the cross-map shot, twice over, and the bulkhead
 *   guarantees the two lanes can never see each other. The spine at y=3.5 sees
 *   BOTH at once and is reached only by the two end ramps, so taking it is a
 *   commitment. One cargo stack per bay tops out at 2.6m: a 0.9m hop onto the
 *   spine through a deliberate gap in its rail, for anyone who wants it without
 *   walking the ramp.
 * ---------------------------------------------------------------------------
 */

import { BrushTag, SpawnZone, SurfaceMaterial, type Brush } from './mapdata.js';
import { b, mirrorX, mirrorZ, quad, solvedRamp, sp } from './brushkit.js';
import { MapId, PropSet, type MapDef } from './mapdef.js';

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Top surface of the bulkhead walkway. */
const SPINE_Y = 3.5;
const WATER_Y = -3.0;

const brushes: Brush[] = [];

// --- Deck, bulwarks and hull ------------------------------------------------
brushes.push(b('hold_deck', [0, -0.25, 0], [13, 0.25, 26.6], SurfaceMaterial.Metal, BrushTag.Deck));

{
  // 1.1m bulwarks, head-glitch height, all the way round. You cannot walk over
  // one, so there is nowhere on this map to fall off — which is what makes it
  // safe to put spawns near the ends.
  const side = b('bulwark_p', [-13.25, 0.55, 0], [0.25, 0.55, 26.85], SurfaceMaterial.Metal, BrushTag.Railing);
  brushes.push(side, mirrorX(side, '_s'));

  const end = b('bulwark_a', [0, 0.55, 26.85], [13.5, 0.55, 0.25], SurfaceMaterial.Metal, BrushTag.Railing);
  brushes.push(end, mirrorZ(end));

  // Hull below the deck. Purely what you see from the sea; nothing stands here.
  const hull = b('hull_p', [-13.6, -1.6, 0], [0.6, 1.6, 27.4], SurfaceMaterial.Metal, BrushTag.Hull);
  brushes.push(hull, mirrorX(hull, '_s'));

  const transom = b('hull_a', [0, -1.6, 27.0], [14.2, 1.6, 0.6], SurfaceMaterial.Metal, BrushTag.Hull);
  brushes.push(transom, mirrorZ(transom));
}

// --- Centre bulkhead: splits the deck into two bays, three doorways through --
// Doorways at z = 0 and z = ±9, each 3m wide. The wall runs z ±17 so the end
// ramps have clear air above them.
{
  const segMid = b('bulk_mid_a', [0, 1.6, 4.5], [0.6, 1.6, 3.0], SurfaceMaterial.Composite, BrushTag.Wall, {
    penetrable: true,
  });
  const segOuter = b('bulk_out_a', [0, 1.6, 13.75], [0.6, 1.6, 3.25], SurfaceMaterial.Composite, BrushTag.Wall, {
    penetrable: true,
  });
  for (const brush of [segMid, segOuter]) brushes.push(brush, mirrorZ(brush));
}

// --- The spine: a walkway along the top of the bulkhead ---------------------
{
  brushes.push(b('spine', [0, SPINE_Y - 0.15, 0], [1.2, 0.15, 17], SurfaceMaterial.Metal, BrushTag.Catwalk));

  // Rails, split to leave a mount gap at z = ±8 for the cargo hop.
  const railMid = b('spine_rail_p', [-1.25, SPINE_Y + 0.45, 0], [0.05, 0.45, 7], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  });
  brushes.push(railMid, mirrorX(railMid, '_s'));

  const railEnd = b('spine_rail_a_p', [-1.25, SPINE_Y + 0.45, 13], [0.05, 0.45, 4], SurfaceMaterial.Metal, BrushTag.Railing, {
    penetrable: true,
  });
  quad(brushes, railEnd);
}

// --- End ramps up to the spine ---------------------------------------------
{
  const ramp = solvedRamp('spine_ramp_a', 0, {
    topY: SPINE_Y,
    bottomY: 0,
    topZ: 17,
    run: 7.12,
    halfX: 1.2,
  });
  brushes.push(ramp, mirrorZ(ramp));
}

// --- Cargo. Stacked outboard so each bay keeps a clean lane at |x| ~ 7 ------
{
  // Tall stack: top at 2.4m, full body cover.
  const tall = b('cargo_tall_a_p', [-10.5, 1.2, 12], [2.2, 1.2, 2.0], SurfaceMaterial.Composite, BrushTag.Crate);
  // Long low run against the bulwark: top at 1.2m, head-glitch height.
  const low = b('cargo_low_a_p', [-11, 0.6, 3], [1.6, 0.6, 3.5], SurfaceMaterial.Composite, BrushTag.Crate);
  // The mount: top at 2.6m, hard against the spine's rail gap. 0.9m hop up.
  const mount = b('cargo_mount_a_p', [-2.2, 1.3, 8], [0.9, 1.3, 0.9], SurfaceMaterial.Composite, BrushTag.Crate);
  quad(brushes, tall);
  quad(brushes, low);
  quad(brushes, mount);
}

export const HANGAR: MapDef = {
  id: MapId.Hangar,
  name: 'Hangar A482',
  tagline: "A cargo ship's weather deck. Two lanes, one spine, no way off.",
  credit: {
    original: 'Hangar inspection A482',
    authors: 'SniperGoth',
    project: 'Red Eclipse',
    license: 'CC BY-SA 4.0',
    url: 'https://github.com/redeclipse/maps',
  },
  competitive: true,
  environment: {
    ocean: true,
    ground: null,
    props: PropSet.Hold,
    poolWater: null,
    hullHalf: [14.2, 27.4],
  },
  sightline: { from: { x: 7, y: 1.6, z: 22 }, to: { x: 7, y: 1.6, z: -22 } },
  brushes,
  bounds: { min: { x: -18, y: -8, z: -34 }, max: { x: 18, y: 30, z: 34 } },
  waterLevel: WATER_Y,
  spawns: [
    sp(0, 0.0, 0.0, 25.4, SpawnZone.Bow),
    sp(1, -6.5, 0.0, 25.4, SpawnZone.Bow),
    sp(2, 6.5, 0.0, 25.4, SpawnZone.Bow),
    sp(3, -11.0, 0.0, 20.0, SpawnZone.Bow),
    sp(4, 11.0, 0.0, 20.0, SpawnZone.Bow),
    sp(5, 0.0, 0.0, -25.4, SpawnZone.Stern),
    sp(6, -6.5, 0.0, -25.4, SpawnZone.Stern),
    sp(7, 6.5, 0.0, -25.4, SpawnZone.Stern),
    sp(8, -11.0, 0.0, -20.0, SpawnZone.Stern),
    sp(9, 11.0, 0.0, -20.0, SpawnZone.Stern),
    // Neutral: mid-bay, either side of the centre door.
    sp(10, -7.0, 0.0, 8.0, SpawnZone.Mid),
    sp(11, 7.0, 0.0, 8.0, SpawnZone.Mid),
    sp(12, -7.0, 0.0, -8.0, SpawnZone.Mid),
    sp(13, 7.0, 0.0, -8.0, SpawnZone.Mid),
    sp(14, 0.0, SPINE_Y, 5.0, SpawnZone.Mid),
    sp(15, 0.0, SPINE_Y, -5.0, SpawnZone.Mid),
  ],
  zones: [],
  navNodes: [],
  interactables: [],
  zombieSpawners: [],
  doorBrushIdsByZone: [],
};
