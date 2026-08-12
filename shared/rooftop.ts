/**
 * UNKNOWN ROOFTOP — adapted from the Red Eclipse map of the same name.
 *
 *   Original: "Unknown Rooftop" by SniperGoth
 *   Project:  Red Eclipse (redeclipse/maps)
 *   Licence:  CC BY-SA 4.0
 *   Blurb:    "Somewhere, hidden in the mountains.."
 *
 * An ADAPTATION, not a conversion. The original is a timber temple standing on
 * stilt-towers above a cliff: a railed main deck, a tile-roofed shrine in the
 * middle, and a tower off each end reached by an exposed crossing. Its own
 * bot-waypoint graph shows that crossing as the whole map — one long axis with
 * a tower anchoring each end. That is what is rebuilt here.
 *
 * Deckshot's first map with no sea under it. There is a valley floor 26m down
 * and nothing in between, so the railings are the only thing between you and
 * the drop, and every one of them is penetrable.
 *
 * ---------------------------------------------------------------------------
 * LAYOUT — one long axis, two towers
 *
 *   z=+27 ┌─── A TOWER ───┐        upper platform y=3.4, two ramps up at x=±3
 *   z=+17 └──┐  plank  ┌──┘
 *   z=+13 ┌──┴─────────┴──┐
 *         │  ▂veranda▂     │  MAIN DECK y=0
 *   z=+5  │   ╔═══════╗    │  SHRINE: 3.1m walls, doorway on all four sides,
 *   z=-5  │   ╚═══════╝    │  walkable roof at y=3.4 (ramps at |x|=8.8)
 *         │  ▂veranda▂     │
 *   z=-13 └──┬─────────┬──┘
 *   z=-17 ┌──┘  plank  └──┐
 *   z=-27 └─── B TOWER ───┘
 *
 *   The shrine's four doorways line up on both axes, so tower to tower is a
 *   48m shot threaded through two of them — the longest sightline in Deckshot,
 *   and the only one that passes through a building. The roof answers it: from
 *   up there you see both planks at once, and riding the eave down into the
 *   deck is the airborne shot.
 * ---------------------------------------------------------------------------
 */

import { BrushTag, SpawnZone, SurfaceMaterial, type Brush } from './mapdata.js';
import { b, mirrorX, mirrorZ, quad, solvedRamp, sp } from './brushkit.js';
import { MapId, PropSet, type MapDef } from './mapdef.js';

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Top surface of the shrine roof and of the tower platforms. */
const ROOF_Y = 3.4;
/**
 * Where the valley floor is drawn. Deep enough that the drop reads as height
 * from the deck rail, shallow enough that you can SEE it is a valley — at -45
 * the floor was so far away it flattened into a plain and the map stopped
 * looking like it stood on stilts at all.
 */
const VALLEY_Y = -26;
/** Below this you are gone. Well above the valley floor: you never land. */
const KILL_Y = -6;

const brushes: Brush[] = [];

// --- Main deck --------------------------------------------------------------
brushes.push(b('deck', [0, -0.25, 0], [10, 0.25, 13], SurfaceMaterial.Teak, BrushTag.Deck));

// Verandas: one 0.4m step up, so they are cover you can also stand behind.
{
  const veranda = b('veranda_p', [-8, 0.2, 0], [2, 0.2, 6], SurfaceMaterial.Teak, BrushTag.Deck);
  brushes.push(veranda, mirrorX(veranda, '_s'));
}

// Deck railings. Every rail on this map is penetrable — nothing here stops a
// bullet, and the drop behind them is 26m.
{
  const side = b('deck_rail_p', [-10.15, 0.55, 0], [0.15, 0.55, 13.3], SurfaceMaterial.Teak, BrushTag.Railing, {
    penetrable: true,
  });
  brushes.push(side, mirrorX(side, '_s'));

  // Split either side of the plank mouth at x=0.
  const end = b('deck_rail_a_p', [-5.9, 0.55, 13.15], [4.4, 0.55, 0.15], SurfaceMaterial.Teak, BrushTag.Railing, {
    penetrable: true,
  });
  quad(brushes, end);
}

// --- The shrine: 3.1m walls with a doorway on each of the four sides --------
{
  // Walls are 3.10m, not 3.00m: the roof's underside is at 3.10, and at 3.00 a
  // 10cm slit ran the entire way round the shrine — you could see, and shoot,
  // through the join from anywhere on the deck.
  // Side walls, split to leave a 3m doorway at z=0.
  const sideWall = b('shrine_side_p_a', [-4.5, 1.55, 3.25], [0.35, 1.55, 1.75], SurfaceMaterial.Composite, BrushTag.Wall, {
    penetrable: true,
  });
  quad(brushes, sideWall);

  // End walls, split to leave a 2.5m doorway at x=0. These two gaps are what
  // make the tower-to-tower shot exist.
  const endWall = b('shrine_end_a_p', [-3.05, 1.55, 5], [1.8, 1.55, 0.35], SurfaceMaterial.Composite, BrushTag.Wall, {
    penetrable: true,
  });
  quad(brushes, endWall);

  // Paper screens in the transom above each doorway. They sit at y 2.2..3.0 —
  // clear of both the doorway you walk through and the sightline you shoot
  // through, so they are a thing to shatter, never a thing in the way.
  const win = b('shrine_win_a', [0, 2.6, 5], [1.25, 0.4, 0.05], SurfaceMaterial.Glass, BrushTag.Window, {
    penetrable: true,
  });
  brushes.push(win, mirrorZ(win));
}

// --- Tile roof: walkable, and the best seat on the map ---------------------
{
  // Half-width 8.8, not 7.5: the roof has to reach the ramps at |x| 7.6..10 or
  // the top of each ramp is a dead end you walk straight off. Deep eaves are
  // right for the building anyway.
  brushes.push(b('roof', [0, ROOF_Y - 0.15, 0], [8.8, 0.15, 6], SurfaceMaterial.Composite, BrushTag.Roof));

  // Pitched eaves front and back: 0.8m fall over 2m => 21.8 degrees. Walkable,
  // so you can ride the eave down and drop into the deck.
  const a = Math.atan2(0.8, 2);
  const eave = b('eave_a', [0, 3.0, 7.0], [7.5, 0.12, Math.hypot(0.8, 2) / 2], SurfaceMaterial.Composite, BrushTag.Roof, {
    pitch: a,
  });
  brushes.push(eave, mirrorZ(eave));
}

// --- Roof ramps, outboard of the eaves so they never clip them -------------
{
  const ramp = solvedRamp('roof_ramp_a_p', -8.8, {
    topY: ROOF_Y,
    bottomY: 0,
    topZ: 6,
    run: 7,
    halfX: 1.2,
    material: SurfaceMaterial.Teak,
  });
  quad(brushes, ramp);
}

// --- Planks out to the towers: 4m of nothing but your own nerve ------------
{
  const plank = b('plank_a', [0, -0.15, 15], [1.6, 0.15, 2.0], SurfaceMaterial.Teak, BrushTag.Catwalk);
  brushes.push(plank, mirrorZ(plank));

  const rail = b('plank_rail_a_p', [-1.65, 0.45, 15], [0.05, 0.45, 2.0], SurfaceMaterial.Teak, BrushTag.Railing, {
    penetrable: true,
  });
  quad(brushes, rail);
}

// --- Towers -----------------------------------------------------------------
{
  const deck = b('tower_a', [0, -0.25, 22], [5, 0.25, 5], SurfaceMaterial.Teak, BrushTag.Deck);
  brushes.push(deck, mirrorZ(deck));

  const side = b('tower_rail_a_p', [-5.15, 0.55, 22], [0.15, 0.55, 5.3], SurfaceMaterial.Teak, BrushTag.Railing, {
    penetrable: true,
  });
  quad(brushes, side);

  const back = b('tower_back_a', [0, 0.55, 27.15], [5.3, 0.55, 0.15], SurfaceMaterial.Teak, BrushTag.Railing, {
    penetrable: true,
  });
  brushes.push(back, mirrorZ(back));

  const front = b('tower_front_a_p', [-3.3, 0.55, 16.85], [1.7, 0.55, 0.15], SurfaceMaterial.Teak, BrushTag.Railing, {
    penetrable: true,
  });
  quad(brushes, front);

  // Upper platform, level with the shrine roof.
  const plat = b('tower_top_a', [0, ROOF_Y - 0.15, 24.1], [3.5, 0.15, 2.4], SurfaceMaterial.Teak, BrushTag.Catwalk);
  brushes.push(plat, mirrorZ(plat));

  // Its outer rail. Without this you walk off the far edge, clear the tower's
  // 1.1m deck rail on the way down because you are already 3.4m up, and die.
  const platRail = b('tower_top_rail_a', [0, ROOF_Y + 0.45, 26.55], [3.5, 0.45, 0.05], SurfaceMaterial.Teak, BrushTag.Railing, {
    penetrable: true,
  });
  brushes.push(platRail, mirrorZ(platRail));

  // Two ramps up per tower, held off x=0 so the tower-to-tower shot stays open.
  const ramp = solvedRamp('tower_ramp_b_p', -3, {
    topY: ROOF_Y,
    bottomY: 0,
    topZ: -21.7,
    run: 4.2,
    halfX: 1.4,
    material: SurfaceMaterial.Teak,
  });
  quad(brushes, ramp);
}

export const ROOFTOP: MapDef = {
  id: MapId.Rooftop,
  name: 'Unknown Rooftop',
  tagline: 'A temple on stilts over a wooded valley. Two towers, one plank each.',
  credit: {
    original: 'Unknown Rooftop',
    authors: 'SniperGoth',
    project: 'Red Eclipse',
    license: 'CC BY-SA 4.0',
    url: 'https://github.com/redeclipse/maps',
  },
  competitive: true,
  environment: {
    ocean: false,
    ground: { y: VALLEY_Y, color: 0x37432f, size: 900 },
    props: PropSet.Temple,
    poolWater: null,
    hullHalf: [11, 28],
  },
  sightline: { from: { x: 0, y: 1.6, z: 24 }, to: { x: 0, y: 1.6, z: -24 } },
  brushes,
  bounds: { min: { x: -16, y: -12, z: -32 }, max: { x: 16, y: 30, z: 32 } },
  waterLevel: KILL_Y,
  spawns: [
    // Tower deck only. The two ramps up occupy x ±1.6..4.4 over z 17.5..21.7,
    // so nothing sits between those.
    sp(0, 0.0, 0.0, 25.5, SpawnZone.Bow),
    sp(1, -3.8, 0.0, 22.6, SpawnZone.Bow),
    sp(2, 3.8, 0.0, 22.6, SpawnZone.Bow),
    sp(3, -3.8, 0.0, 26.4, SpawnZone.Bow),
    sp(4, 3.8, 0.0, 26.4, SpawnZone.Bow),
    sp(5, 0.0, 0.0, -25.5, SpawnZone.Stern),
    sp(6, -3.8, 0.0, -22.6, SpawnZone.Stern),
    sp(7, 3.8, 0.0, -22.6, SpawnZone.Stern),
    sp(8, -3.8, 0.0, -26.4, SpawnZone.Stern),
    sp(9, 3.8, 0.0, -26.4, SpawnZone.Stern),
    // Neutral: on the verandas, clear of the roof ramps at z 6..13.
    sp(10, -8.0, 0.4, 3.5, SpawnZone.Mid),
    sp(11, 8.0, 0.4, 3.5, SpawnZone.Mid),
    sp(12, -8.0, 0.4, -3.5, SpawnZone.Mid),
    sp(13, 8.0, 0.4, -3.5, SpawnZone.Mid),
    sp(14, -4.0, ROOF_Y, 2.0, SpawnZone.Mid),
    sp(15, 4.0, ROOF_Y, -2.0, SpawnZone.Mid),
  ],
  zones: [],
  navNodes: [],
  interactables: [],
  zombieSpawners: [],
  doorBrushIdsByZone: [],
};
