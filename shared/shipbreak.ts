/**
 * DECKSHOT — "Shipbreak" map, as data.
 *
 * Owner: zombies. The ZOMBIES mode's map: a shipbreaker's yard at dusk. A
 * beached freighter (north strip) is being cut apart beside a working yard
 * (south); a drained dock pit sits under the ship's aft. Layout contract:
 * ZOMBIES.md §3. Deliberately asymmetric — `assertSymmetric()` is Sundeck's.
 *
 * Elevations: ship deck 5.2, cargo hold 0.6, engine room −2.6, yard 0,
 * drydock basin −3.5. Every level change is a pitched Z-running ramp
 * (yaw 0), the one slope form both the player controller and the zombie
 * capsule-sweep locomotion are proven against.
 *
 * Window openings are floor-to-header holes sealed by `playersOnly` blocker
 * brushes: players and bullets treat them as boarded windows; the horde
 * walks through once the planks are torn.
 */

import { SurfaceMaterial, BrushTag, SpawnZone, type Brush, type SpawnPoint } from './mapdata.js';
import { MapId, InteractableKind, type Interactable, type MapDef, type WindowDef, type Zone, type ZombieSpawner } from './mapdef.js';
import type { NavNode } from './navgraph.js';
import { PerkId } from './zombies.js';
import { WeaponId, type Vec3 } from './types.js';

// ---------------------------------------------------------------------------
// Brush helpers
// ---------------------------------------------------------------------------

const brushes: Brush[] = [];

function b(
  id: string,
  center: [number, number, number],
  half: [number, number, number],
  material: SurfaceMaterial,
  tag: BrushTag,
  opts: { yaw?: number; pitch?: number; penetrable?: boolean; playersOnly?: boolean } = {},
): void {
  brushes.push({
    id,
    center: { x: center[0], y: center[1], z: center[2] },
    half: { x: half[0], y: half[1], z: half[2] },
    yaw: opts.yaw ?? 0,
    pitch: opts.pitch ?? 0,
    material,
    penetrable: opts.penetrable ?? false,
    tag,
    ...(opts.playersOnly ? { playersOnly: true } : {}),
  });
}

/** Floor slab whose TOP surface sits at `topY`. */
function floor(id: string, x0: number, x1: number, z0: number, z1: number, topY: number, mat = SurfaceMaterial.Metal): void {
  b(id, [(x0 + x1) / 2, topY - 0.25, (z0 + z1) / 2], [(x1 - x0) / 2, 0.25, (z1 - z0) / 2], mat, BrushTag.Deck);
}

/** Wall along X (constant z), from floorY up by h. */
function wallX(id: string, x0: number, x1: number, z: number, floorY: number, h: number, mat = SurfaceMaterial.Composite): void {
  b(id, [(x0 + x1) / 2, floorY + h / 2, z], [(x1 - x0) / 2, h / 2, 0.15], mat, BrushTag.Wall);
}

/** Wall along Z (constant x), from floorY up by h. */
function wallZ(id: string, x: number, z0: number, z1: number, floorY: number, h: number, mat = SurfaceMaterial.Composite): void {
  b(id, [x, floorY + h / 2, (z0 + z1) / 2], [0.15, h / 2, (z1 - z0) / 2], mat, BrushTag.Wall);
}

/**
 * Z-running ramp: walkable slope from (zTop, topY) to (zBot, botY), yaw 0.
 * Positive pitch raises the +z end, so the sign falls out of the geometry.
 */
function ramp(id: string, x: number, w: number, zTop: number, topY: number, zBot: number, botY: number): void {
  const run = Math.abs(zBot - zTop);
  const rise = topY - botY;
  const pitch = (zTop > zBot ? 1 : -1) * Math.atan2(rise, run);
  b(
    id,
    [x, (topY + botY) / 2 - 0.12, (zTop + zBot) / 2],
    [w / 2, 0.15, Math.hypot(rise, run) / 2],
    SurfaceMaterial.Metal,
    BrushTag.Ramp,
    { pitch },
  );
}

/** Open (penetrable) railing strip. */
function railX(id: string, x0: number, x1: number, z: number, floorY: number): void {
  b(id, [(x0 + x1) / 2, floorY + 0.55, z], [(x1 - x0) / 2, 0.55, 0.08], SurfaceMaterial.Metal, BrushTag.Railing, { penetrable: true });
}
function railZ(id: string, x: number, z0: number, z1: number, floorY: number): void {
  b(id, [x, floorY + 0.55, (z0 + z1) / 2], [0.08, 0.55, (z1 - z0) / 2], SurfaceMaterial.Metal, BrushTag.Railing, { penetrable: true });
}

function crate(id: string, x: number, z: number, floorY: number, hx = 1.2, hy = 1.2, hz = 1.2, yaw = 0): void {
  b(id, [x, floorY + hy, z], [hx, hy, hz], SurfaceMaterial.Composite, BrushTag.Crate, { yaw });
}

/**
 * A boarded window: a floor-to-header hole in a wall, sealed by an invisible
 * player-only blocker, framed by wall segments this helper emits. `axis` is
 * the wall's run direction. Hole is 1.3 wide x 1.9 tall.
 */
interface WindowSpec {
  id: number;
  zone: number;
  pos: Vec3;
  yaw: number;
  blockerBrushId: string;
}
const windowSpecs: WindowSpec[] = [];

function windowInWallX(
  wid: number,
  zone: number,
  prefix: string,
  x0: number,
  x1: number,
  z: number,
  floorY: number,
  h: number,
  holeX: number,
  yaw: number,
  mat = SurfaceMaterial.Metal,
): void {
  const hw = 0.65; // half hole width
  const hh = 2.4; // hole height — capsule 1.7 + the 0.5 step-up probe must clear it
  if (holeX - hw > x0) wallX(`${prefix}_l`, x0, holeX - hw, z, floorY, h, mat);
  if (x1 > holeX + hw) wallX(`${prefix}_r`, holeX + hw, x1, z, floorY, h, mat);
  if (h > hh) wallX(`${prefix}_t`, holeX - hw, holeX + hw, z, floorY + hh, h - hh, mat);
  const blockerId = `${prefix}_blk`;
  b(blockerId, [holeX, floorY + hh / 2, z], [hw, hh / 2, 0.15], mat, BrushTag.Wall, {
    penetrable: true,
    playersOnly: true,
  });
  windowSpecs.push({ id: wid, zone, pos: { x: holeX, y: floorY + 0.95, z }, yaw, blockerBrushId: blockerId });
}

function windowInWallZ(
  wid: number,
  zone: number,
  prefix: string,
  x: number,
  z0: number,
  z1: number,
  floorY: number,
  h: number,
  holeZ: number,
  yaw: number,
  mat = SurfaceMaterial.Metal,
): void {
  const hw = 0.65;
  const hh = 2.4;
  if (holeZ - hw > z0) wallZ(`${prefix}_l`, x, z0, holeZ - hw, floorY, h, mat);
  if (z1 > holeZ + hw) wallZ(`${prefix}_r`, x, holeZ + hw, z1, floorY, h, mat);
  if (h > hh) wallZ(`${prefix}_t`, x, holeZ - hw, holeZ + hw, floorY + hh, h - hh, mat);
  const blockerId = `${prefix}_blk`;
  b(blockerId, [x, floorY + hh / 2, holeZ], [0.15, hh / 2, hw], mat, BrushTag.Wall, {
    penetrable: true,
    playersOnly: true,
  });
  windowSpecs.push({ id: wid, zone, pos: { x, y: floorY + 0.95, z: holeZ }, yaw, blockerBrushId: blockerId });
}

/** A sealed spawn pocket: floor + 1m bulwark on the three open sides. */
function pocket(prefix: string, x0: number, x1: number, z0: number, z1: number, floorY: number, openSide: 'x0' | 'x1' | 'z0' | 'z1'): void {
  floor(`${prefix}_f`, x0, x1, z0, z1, floorY);
  if (openSide !== 'x0') wallZ(`${prefix}_wx0`, x0, z0, z1, floorY, 1.0, SurfaceMaterial.Metal);
  if (openSide !== 'x1') wallZ(`${prefix}_wx1`, x1, z0, z1, floorY, 1.0, SurfaceMaterial.Metal);
  if (openSide !== 'z0') wallX(`${prefix}_wz0`, x0, x1, z0, floorY, 1.0, SurfaceMaterial.Metal);
  if (openSide !== 'z1') wallX(`${prefix}_wz1`, x0, x1, z1, floorY, 1.0, SurfaceMaterial.Metal);
}

// ---------------------------------------------------------------------------
// Z0 — QUARTERDECK (spawn; the freighter's aft superstructure, deck 5.2)
// ---------------------------------------------------------------------------

floor('qd_floor', -18, -4, 12, 34, 5.2, SurfaceMaterial.Teak);
b('qd_roof', [-11, 8.35, 23], [7.3, 0.15, 11.3], SurfaceMaterial.Composite, BrushTag.Roof);
// West wall (x=-18): D1 doorway z 13..15 -> the hold stairwell.
wallZ('qd_w_a', -18, 12, 13, 5.2, 3.0);
wallZ('qd_w_b', -18, 15, 34, 5.2, 3.0);
wallZ('qd_w_hdr', -18, 13, 15, 7.7, 0.5);
// South wall (z=12): D2 doorway x -12..-9.5 -> the gangway.
wallX('qd_s_a', -18, -12, 12, 5.2, 3.0);
wallX('qd_s_b', -9.5, -4, 12, 5.2, 3.0);
wallX('qd_s_hdr', -12, -9.5, 12, 7.7, 0.5); // header over the D2 doorway
b('d_gang', [-10.75, 6.45, 12], [1.25, 1.25, 0.18], SurfaceMaterial.Metal, BrushTag.Wall); // zone 2 door
// East wall (x=-4): windows W0, W1 opening onto hull platforms.
windowInWallZ(0, 0, 'qd_e1', -4, 12, 22, 5.2, 3.0, 17.6, Math.PI / 2, SurfaceMaterial.Composite);
windowInWallZ(1, 0, 'qd_e2', -4, 22, 34, 5.2, 3.0, 27.6, Math.PI / 2, SurfaceMaterial.Composite);
// North wall (z=34): window W2 onto the bow-side scaffold.
windowInWallX(2, 0, 'qd_n', -18, -4, 34, 5.2, 3.0, -10, 0, SurfaceMaterial.Composite);
// Window pockets (sealed outside platforms the horde spawns on).
pocket('qd_p0', -3.85, -1.2, 16.3, 18.9, 5.2, 'x0');
pocket('qd_p1', -3.85, -1.2, 26.3, 28.9, 5.2, 'x0');
pocket('qd_p2', -11.3, -8.7, 34.15, 36.8, 5.2, 'z0');
crate('qd_crate_a', -15.5, 31, 5.2, 1.0, 1.0, 1.0, 0.3);
crate('qd_crate_b', -6.5, 13.8, 5.2, 0.8, 0.6, 0.8);
// The spawn-room ammo box (the interactable sits on it).
crate('qd_ammobox', -17.1, 30, 5.2, 0.4, 0.35, 0.5);

// ---------------------------------------------------------------------------
// Z1 — CARGO HOLD (inside the hull, floor 0.6, container maze)
// ---------------------------------------------------------------------------

floor('ch_floor', -38, -18, 10, 34, 0.6);
// The deck caps the hold except the cut-open stairwell strip x -22..-18.
b('ch_deckcap', [-30, 5.05, 22], [8, 0.15, 12], SurfaceMaterial.Teak, BrushTag.Roof);
// Stairwell: landing at deck height inside the hold, ramp down northward.
floor('ch_landing', -21.5, -18, 12.5, 15.5, 5.2);
railZ('ch_land_rail', -21.5, 12.5, 15.5, 5.2);
ramp('ch_ramp', -19.75, 2.6, 15.5, 5.2, 23.5, 0.6);
b('d_hold', [-18, 6.45, 14], [0.18, 1.25, 1.0], SurfaceMaterial.Metal, BrushTag.Wall); // zone 1 door
// South hull (z=10), solid; Shrike hangs here.
wallX('ch_s', -38, -18, 10, 0.6, 4.6, SurfaceMaterial.Metal);
// East hull below the deck (x=-18).
wallZ('ch_e', -18, 10, 34, 0.6, 4.6, SurfaceMaterial.Metal);
// West wall (x=-38): D3 doorway z 21..23 -> engine room.
wallZ('ch_w_a', -38, 10, 21, 0.6, 4.6, SurfaceMaterial.Metal);
wallZ('ch_w_b', -38, 23, 34, 0.6, 4.6, SurfaceMaterial.Metal);
wallZ('ch_w_hdr', -38, 21, 23, 3.1, 2.1, SurfaceMaterial.Metal);
b('d_engine', [-38, 1.85, 22], [0.18, 1.25, 1.0], SurfaceMaterial.Metal, BrushTag.Wall); // zone 3 door
// North hull (z=34): windows W3, W4 onto the seaward scaffolds.
windowInWallX(3, 1, 'ch_n1', -38, -26.5, 34, 0.6, 4.6, -30, 0);
windowInWallX(4, 1, 'ch_n2', -26.5, -18, 34, 0.6, 4.6, -23, 0);
pocket('ch_p3', -31.3, -28.7, 34.15, 36.8, 0.6, 'z0');
pocket('ch_p4', -24.3, -21.7, 34.15, 36.8, 0.6, 'z0');
// Container maze.
crate('ch_c1', -26, 16, 0.6, 1.3, 1.3, 2.2, 0.15);
crate('ch_c2', -31.5, 19.5, 0.6, 1.3, 1.3, 1.3, -0.2);
crate('ch_c3', -25, 24.5, 0.6, 2.2, 1.3, 1.3, 0.1);
crate('ch_c4', -35, 14, 0.6, 1.1, 1.1, 1.1);
crate('ch_c5', -29.5, 27.5, 0.6, 0.9, 0.9, 0.9, 0.4);
crate('ch_boxstand', -33.5, 30.5, 0.6, 0.9, 0.5, 0.6);

// ---------------------------------------------------------------------------
// Z3 — ENGINE ROOM (bottom of the hull, floor -2.6; the power switch)
// ---------------------------------------------------------------------------

floor('er_floor', -50, -38, 10, 34, -2.6);
b('er_deckcap', [-44, 5.05, 22], [6, 0.15, 12], SurfaceMaterial.Teak, BrushTag.Roof);
// Entry landing at hold level, ramp down northward into the room.
floor('er_landing', -41.8, -38.3, 20, 24, 0.6);
railZ('er_land_rail', -41.8, 20, 24, 0.6);
ramp('er_ramp', -40, 2.4, 24, 0.6, 30, -2.6);
// East hull below the hold floor (x=-38).
wallZ('er_e_low', -38, 10, 34, -2.6, 3.2, SurfaceMaterial.Metal);
// North hull (z=34), solid.
wallX('er_n', -50, -38, 34, -2.6, 7.8, SurfaceMaterial.Metal);
// West hull (x=-50): window W5 low in the plating.
windowInWallZ(5, 3, 'er_w', -50, 10, 34, -2.6, 7.8, 15.6, -Math.PI / 2);
pocket('er_p5', -52.6, -50.15, 14.3, 16.9, -2.6, 'x1');
// South hull (z=10): D4 doorway x -44.5..-42.5 -> the workshop corridor.
wallX('er_s_a', -50, -44.5, 10, -2.6, 7.8, SurfaceMaterial.Metal);
wallX('er_s_b', -42.5, -38, 10, -2.6, 7.8, SurfaceMaterial.Metal);
wallX('er_s_hdr', -44.5, -42.5, 10, -0.1, 5.3, SurfaceMaterial.Metal);
b('d_shop_n', [-43.5, -1.35, 10], [1.0, 1.25, 0.18], SurfaceMaterial.Metal, BrushTag.Wall); // zone 5 door (north)
// Machinery.
b('er_engine', [-45.5, -1.2, 20], [1.6, 1.4, 2.6], SurfaceMaterial.Metal, BrushTag.Cover);
b('er_pump', [-42, -1.9, 15], [1.0, 0.7, 1.0], SurfaceMaterial.Metal, BrushTag.Cover);

// ---------------------------------------------------------------------------
// Z2 — GANGWAY (elevated walkway on the ship's south flank, 5.2 -> yard ramp)
// ---------------------------------------------------------------------------

floor('gw_walk', -18, 4, 7, 12, 5.2);
railX('gw_rail_s', -18, 0, 7, 5.2);
wallZ('gw_w', -18, 7, 12, 5.2, 3.0, SurfaceMaterial.Metal); // hull cap, west end
// North hull face along the walkway (z=12) for x -4..4, with window W6's
// alcove pocket cut in at x -3.2..-0.7 (it pokes into dead hull space).
windowInWallX(6, 2, 'gw_n', -4, 4, 12, 5.2, 3.0, -2, 0);
pocket('gw_p6', -3.2, -0.7, 12.3, 14.8, 5.2, 'z0');
// Hull plating under the walkway down to the yard.
wallX('gw_under', -18, 4, 7, -0.5, 5.7, SurfaceMaterial.Metal);
// East ramp descending south into the yard, railed on both sides.
ramp('gw_ramp', 2, 3.0, 7, 5.2, -2, 0);
railZ('gw_ramp_rail_e', 3.6, -2, 7, 2.6);
railZ('gw_ramp_rail_w', 0.4, -2, 7, 2.6);
b('d_yard', [2, 1.1, -2.6], [1.6, 1.15, 0.18], SurfaceMaterial.Metal, BrushTag.Wall); // zone 4 door
// Doorway frame at the ramp bottom.
wallX('gw_frame_l', -0.5, 0.4, -2.6, 0, 2.6, SurfaceMaterial.Metal);
wallX('gw_frame_r', 3.6, 4.5, -2.6, 0, 2.6, SurfaceMaterial.Metal);

// ---------------------------------------------------------------------------
// Z4 — BREAKER'S YARD (open ground, the training loop)
// ---------------------------------------------------------------------------

floor('by_floor', -12, 44, -42, 12, 0, SurfaceMaterial.Composite);
// Perimeter: south fence (window W7), east fence (window W8), north walls.
windowInWallX(7, 4, 'by_s1', -12, 44, -42, 0, 3.0, 14, Math.PI);
pocket('by_p7', 12.7, 15.3, -44.6, -42.15, 0, 'z1');
windowInWallZ(8, 4, 'by_e1', 44, -42, 12, 0, 3.0, -32, Math.PI / 2);
pocket('by_p8', 44.15, 46.7, -33.3, -30.7, 0, 'x0');
// West wall shared with the workshop, D6 vestibule doorway z -15.5..-13.
wallZ('by_w_a', -12, -42, -15.5, 0, 3.0, SurfaceMaterial.Metal);
wallZ('by_w_b', -12, -13, 12, 0, 3.0, SurfaceMaterial.Metal);
b('d_shop_e', [-12, 1.5, -14.25], [0.18, 1.5, 1.25], SurfaceMaterial.Metal, BrushTag.Wall); // zone 5 door (east)
// North edge: hull for x -12..2, basin rim rail x 2..34 (gap 8..14 for the
// dock stair), fence x 14..44 beyond the rim gap... rim rail split around gap.
wallX('by_n_hull', -12, 2, 12, 0, 4.0, SurfaceMaterial.Metal);
railX('by_rim_rail_a', 2, 8, 12, 0);
railX('by_rim_rail_b', 14, 34, 12, 0);
wallX('by_n_fence', 34, 44, 12, 0, 3.0, SurfaceMaterial.Metal);
b('d_dock', [11, 1.3, 12], [3.0, 1.3, 0.18], SurfaceMaterial.Metal, BrushTag.Wall); // zone 6 door
// Gantry crane.
b('by_leg_a', [6, 3, -30], [0.5, 3, 0.5], SurfaceMaterial.Metal, BrushTag.Cover);
b('by_leg_b', [6, 3, -10], [0.5, 3, 0.5], SurfaceMaterial.Metal, BrushTag.Cover);
b('by_leg_c', [28, 3, -30], [0.5, 3, 0.5], SurfaceMaterial.Metal, BrushTag.Cover);
b('by_leg_d', [28, 3, -10], [0.5, 3, 0.5], SurfaceMaterial.Metal, BrushTag.Cover);
b('by_beam', [17, 6.6, -20], [12.5, 0.6, 1.0], SurfaceMaterial.Metal, BrushTag.Catwalk);
// Cutting debris and containers — the loop centre x 6..26, z -30..-6 stays open.
crate('by_c1', -6, -28, 0, 2.2, 1.3, 1.3, 0.2);
crate('by_c2', 34, -22, 0, 1.3, 1.3, 2.2, -0.3);
crate('by_c3', 20, 4, 0, 2.2, 1.3, 1.3, 0.1);
crate('by_c4', 36, -6, 0, 1.2, 1.2, 1.2, 0.5);
crate('by_c5', 2, -38, 0, 1.3, 1.3, 1.3);
crate('by_c6', 30, -38, 0, 2.0, 1.2, 1.2, -0.15);
crate('by_boxstand', 36, 0, 0, 0.9, 0.5, 0.6);
// The yard ammo box against the south fence.
crate('by_ammobox', 20, -41.3, 0, 0.4, 0.35, 0.5);

// ---------------------------------------------------------------------------
// Z5 — WORKSHOP (+ the north corridor down to the engine room, + vestibule)
// ---------------------------------------------------------------------------

floor('ws_floor', -44, -16, -42, -2, 0, SurfaceMaterial.Composite);
b('ws_roof', [-30, 3.65, -22], [14.3, 0.15, 20.3], SurfaceMaterial.Composite, BrushTag.Roof);
// South wall (z=-42): Talon hangs here.
wallX('ws_s', -44, -16, -42, 0, 3.5);
// West wall (x=-44): window W9.
windowInWallZ(9, 5, 'ws_w', -44, -42, -2, 0, 3.5, -30, -Math.PI / 2, SurfaceMaterial.Composite);
pocket('ws_p9', -46.6, -44.15, -31.3, -28.7, 0, 'x1');
// East wall (x=-16): vestibule doorway z -15.5..-13.
wallZ('ws_e_a', -16, -42, -15.5, 0, 3.5);
wallZ('ws_e_b', -16, -13, -2, 0, 3.5);
// North wall (z=-2): corridor doorway x -44..-42.
wallX('ws_n_a', -16, -42, -2, 0, 3.5); // note: runs -42..-16 (helper normalises)
// Vestibule to the yard.
floor('ws_vest_f', -16, -12, -16.5, -12.5, 0, SurfaceMaterial.Composite);
wallX('ws_vest_s', -16, -12, -16.5, 0, 3.0, SurfaceMaterial.Metal);
wallX('ws_vest_n', -16, -12, -12.5, 0, 3.0, SurfaceMaterial.Metal);
b('ws_vest_roof', [-14, 3.15, -14.5], [2.0, 0.15, 2.0], SurfaceMaterial.Metal, BrushTag.Roof);
// North corridor: flat run, then a ramp down to the engine-room door.
floor('ws_corr_f', -46, -40, -2, 2, 0, SurfaceMaterial.Metal);
ramp('ws_corr_ramp', -43, 5.4, 2, 0, 8, -2.6);
floor('ws_corr_land', -46, -40, 8, 10, -2.6, SurfaceMaterial.Metal);
wallZ('ws_corr_w', -46, -2, 10, -2.6, 6.1, SurfaceMaterial.Metal);
wallZ('ws_corr_e', -40, -2, 10, -2.6, 6.1, SurfaceMaterial.Metal);
b('ws_corr_roof', [-43, 3.15, 4], [3.15, 0.15, 6.15], SurfaceMaterial.Metal, BrushTag.Roof);
// Workbenches.
crate('ws_b1', -38, -36, 0, 1.6, 0.9, 0.8, 0.05);
crate('ws_b2', -24, -20, 0, 0.8, 0.9, 1.6, -0.1);
crate('ws_b3', -32, -10, 0, 1.6, 0.9, 0.8);
crate('ws_b4', -20, -32, 0, 1.0, 1.0, 1.0, 0.3);

// ---------------------------------------------------------------------------
// Z6 — DRYDOCK BASIN (the drained pit under the aft; the Forge)
// ---------------------------------------------------------------------------

floor('db_floor', 2, 34, 12, 40, -3.5);
// Pit walls: west hull side, east wall, north sea bulwark, south rim (with
// the stair gap x 8..14 the d_dock door seals at the top).
wallZ('db_w', 2, 12, 40, -3.5, 5.0, SurfaceMaterial.Metal);
wallZ('db_e', 34, 12, 40, -3.5, 4.0, SurfaceMaterial.Metal);
wallX('db_n', 2, 34, 40, -3.5, 4.0, SurfaceMaterial.Metal);
wallX('db_rim_a', 2, 8, 12, -3.5, 3.5, SurfaceMaterial.Metal);
wallX('db_rim_b', 14, 34, 12, -3.5, 3.5, SurfaceMaterial.Metal);
ramp('db_ramp', 11, 5.4, 12, 0, 19, -3.5);
railZ('db_ramp_rail_e', 13.8, 12, 19, -1.75);
railZ('db_ramp_rail_w', 8.2, 12, 19, -1.75);
// Dock clutter.
crate('db_c1', 28, 34, -3.5, 1.4, 1.4, 1.4, 0.2);
crate('db_c2', 6, 26, -3.5, 1.2, 1.2, 2.0, -0.25);
b('db_keelblock_a', [20, -2.9, 24], [1.0, 0.6, 1.0], SurfaceMaterial.Metal, BrushTag.Cover);
b('db_keelblock_b', [14, -2.9, 30], [1.0, 0.6, 1.0], SurfaceMaterial.Metal, BrushTag.Cover);

// ---------------------------------------------------------------------------
// Spawns, zones, interactables
// ---------------------------------------------------------------------------

const spawns: SpawnPoint[] = [
  { id: 0, position: { x: -13, y: 5.2, z: 19 }, yaw: Math.PI, zone: SpawnZone.Mid },
  { id: 1, position: { x: -10, y: 5.2, z: 21 }, yaw: Math.PI, zone: SpawnZone.Mid },
  { id: 2, position: { x: -14, y: 5.2, z: 24 }, yaw: Math.PI, zone: SpawnZone.Mid },
  { id: 3, position: { x: -9, y: 5.2, z: 25 }, yaw: Math.PI, zone: SpawnZone.Mid },
  { id: 4, position: { x: -12, y: 5.2, z: 28 }, yaw: Math.PI, zone: SpawnZone.Mid },
];

const zones: Zone[] = [
  {
    id: 0, name: 'Quarterdeck', cost: 0, requiresPower: false, adjacent: [],
    boxes: [{ min: { x: -19, y: 4.4, z: 11 }, max: { x: -0.9, y: 8.4, z: 37.2 } }],
  },
  {
    id: 1, name: 'Cargo Hold', cost: 750, requiresPower: false, adjacent: [0],
    boxes: [{ min: { x: -39, y: -0.2, z: 9.4 }, max: { x: -17.4, y: 6.0, z: 37.2 } }],
  },
  {
    id: 2, name: 'Gangway', cost: 750, requiresPower: false, adjacent: [0],
    boxes: [
      { min: { x: -19, y: 4.4, z: 6.4 }, max: { x: 5, y: 8.4, z: 15.2 } },
      { min: { x: -0.6, y: -0.4, z: -3.6 }, max: { x: 5, y: 6.2, z: 7.5 } },
    ],
  },
  {
    id: 3, name: 'Engine Room', cost: 1000, requiresPower: false, adjacent: [1],
    boxes: [{ min: { x: -53, y: -3.2, z: 9.4 }, max: { x: -37.4, y: 1.4, z: 34.5 } }],
  },
  {
    id: 4, name: "Breaker's Yard", cost: 1000, requiresPower: false, adjacent: [2],
    boxes: [{ min: { x: -12.6, y: -0.6, z: -45 }, max: { x: 47, y: 1.6, z: 12.6 } }],
  },
  {
    id: 5, name: 'Workshop', cost: 1250, requiresPower: false, adjacent: [3, 4],
    boxes: [
      { min: { x: -47, y: -0.5, z: -42.6 }, max: { x: -15.4, y: 1.6, z: -1.4 } },
      { min: { x: -46.5, y: -3.2, z: -2.6 }, max: { x: -39.4, y: 1.4, z: 10.6 } },
      { min: { x: -16.6, y: -0.5, z: -17 }, max: { x: -11.4, y: 1.6, z: -12 } },
    ],
  },
  {
    id: 6, name: 'Drydock Basin', cost: 1750, requiresPower: true, adjacent: [4],
    boxes: [{ min: { x: 1.4, y: -4, z: 11.4 }, max: { x: 34.6, y: 0.6, z: 40.6 } }],
  },
];

const interactables: Interactable[] = [
  { kind: InteractableKind.WallBuy, zone: 0, pos: { x: -17.4, y: 6.4, z: 24 }, weapon: WeaponId.Osprey },
  { kind: InteractableKind.WallBuy, zone: 1, pos: { x: -24, y: 1.8, z: 10.6 }, weapon: WeaponId.Shrike },
  { kind: InteractableKind.WallBuy, zone: 2, pos: { x: -8, y: 6.4, z: 11.4 }, weapon: WeaponId.Harrier },
  { kind: InteractableKind.WallBuy, zone: 4, pos: { x: 43.4, y: 1.2, z: -16 }, weapon: WeaponId.Condor },
  { kind: InteractableKind.WallBuy, zone: 5, pos: { x: -30, y: 1.2, z: -41.4 }, weapon: WeaponId.Talon },
  { kind: InteractableKind.Perk, zone: 2, pos: { x: -16, y: 6.4, z: 8 }, perk: PerkId.Adrenaline },
  { kind: InteractableKind.Perk, zone: 3, pos: { x: -44, y: -1.4, z: 33.4 }, perk: PerkId.Bulwark },
  { kind: InteractableKind.Perk, zone: 4, pos: { x: -2, y: 1.2, z: -41.4 }, perk: PerkId.SecondWind },
  { kind: InteractableKind.Perk, zone: 5, pos: { x: -43.4, y: 1.2, z: -20 }, perk: PerkId.Handloader },
  { kind: InteractableKind.Perk, zone: 6, pos: { x: 2.6, y: -2.3, z: 15 }, perk: PerkId.HairTrigger },
  { kind: InteractableKind.Generator, zone: 3, pos: { x: -49.4, y: -1.4, z: 27 } },
  { kind: InteractableKind.Forge, zone: 6, pos: { x: 18, y: -2.3, z: 39.4 } },
  { kind: InteractableKind.CrateSpot, zone: 1, pos: { x: -33.5, y: 1.4, z: 30.5 }, spot: 0 },
  { kind: InteractableKind.CrateSpot, zone: 4, pos: { x: 36, y: 0.8, z: 0 }, spot: 1 },
  // Ammo boxes: one in the spawn room, one deep in the yard.
  { kind: InteractableKind.AmmoBox, zone: 0, pos: { x: -17.4, y: 6.2, z: 30 } },
  { kind: InteractableKind.AmmoBox, zone: 4, pos: { x: 20, y: 1.0, z: -41.4 } },
];

// ---------------------------------------------------------------------------
// Nav graph — authored by name, compiled to the dense-id NavNode[] the solver
// requires. Chains follow every walkable route; the edge that crosses a door
// ENTERS the bought zone (the gating rule).
// ---------------------------------------------------------------------------

const navNames: string[] = [];
const navDefs = new Map<string, { pos: Vec3; zone: number; edges: Set<string> }>();

function n(name: string, x: number, y: number, z: number, zone: number): void {
  navNames.push(name);
  navDefs.set(name, { pos: { x, y, z }, zone, edges: new Set() });
}
function link(a: string, ...rest: string[]): void {
  for (const bName of rest) {
    const na = navDefs.get(a);
    const nb = navDefs.get(bName);
    if (!na || !nb) throw new Error(`nav link ${a}-${bName}: unknown node`);
    na.edges.add(bName);
    nb.edges.add(a);
  }
}

// Z0 Quarterdeck
n('z0_hub', -11, 5.2, 22, 0);
n('z0_d1', -16.5, 5.2, 14, 0);
n('z0_d2', -10.75, 5.2, 13.5, 0);
n('z0_w0_in', -6, 5.2, 17.6, 0);
n('z0_w1_in', -6, 5.2, 27.6, 0);
n('z0_w2_in', -10, 5.2, 31.5, 0);
n('z0_w0_out', -2.5, 5.2, 17.6, 0);
n('z0_w1_out', -2.5, 5.2, 27.6, 0);
n('z0_w2_out', -10, 5.2, 35.4, 0);
n('z0_west', -15.5, 5.2, 28, 0);
link('z0_hub', 'z0_d1', 'z0_d2', 'z0_w0_in', 'z0_w1_in', 'z0_west');
link('z0_west', 'z0_w2_in');
link('z0_w1_in', 'z0_w2_in');
link('z0_w0_in', 'z0_w0_out');
link('z0_w1_in', 'z0_w1_out');
link('z0_w2_in', 'z0_w2_out');

// Z1 Cargo Hold (entered from z0_d1 through the d_hold doorway)
n('z1_land', -19.8, 5.2, 14, 1);
n('z1_ramp_mid', -19.8, 2.9, 19.5, 1);
n('z1_ramp_bot', -19.8, 0.6, 24.5, 1);
n('z1_mid', -24, 0.6, 21, 1);
n('z1_south', -24, 0.6, 12.5, 1);
n('z1_box', -33, 0.6, 29.5, 1);
n('z1_north', -27, 0.6, 30, 1);
n('z1_w3_in', -30, 0.6, 32.5, 1);
n('z1_w4_in', -23, 0.6, 32, 1);
n('z1_w3_out', -30, 0.6, 35.5, 1);
n('z1_w4_out', -23, 0.6, 35.5, 1);
n('z1_west', -34.5, 0.6, 22, 1);
link('z0_d1', 'z1_land');
link('z1_land', 'z1_ramp_mid');
link('z1_ramp_mid', 'z1_ramp_bot');
link('z1_ramp_bot', 'z1_mid');
link('z1_mid', 'z1_south', 'z1_west', 'z1_north');
link('z1_north', 'z1_box', 'z1_w3_in', 'z1_w4_in');
link('z1_w3_in', 'z1_w3_out');
link('z1_w4_in', 'z1_w4_out');

// Z3 Engine Room (entered from z1_west through d_engine)
n('z3_land', -40, 0.6, 22, 3);
n('z3_ramp_mid', -40, -1.0, 27, 3);
n('z3_ramp_bot', -40, -2.6, 31, 3);
n('z3_north', -44, -2.6, 32.5, 3);
n('z3_gen', -47.5, -2.6, 27, 3);
n('z3_w5_in', -48, -2.6, 15.6, 3);
n('z3_w5_out', -51.4, -2.6, 15.6, 3);
n('z3_south', -43.5, -2.6, 11.5, 3);
link('z1_west', 'z3_land');
link('z3_land', 'z3_ramp_mid');
link('z3_ramp_mid', 'z3_ramp_bot');
link('z3_ramp_bot', 'z3_north', 'z3_gen');
link('z3_north', 'z3_gen');
link('z3_gen', 'z3_w5_in');
link('z3_w5_in', 'z3_w5_out', 'z3_south');

// Z2 Gangway (entered from z0_d2 through d_gang)
n('z2_d2', -10.75, 5.2, 10, 2);
n('z2_west', -16, 5.2, 9, 2);
n('z2_mid', -5, 5.2, 9.5, 2);
n('z2_w6_in', -2, 5.2, 10.3, 2);
n('z2_w6_out', -2, 5.2, 13.5, 2);
n('z2_east', 2, 5.2, 9, 2);
n('z2_ramp_mid', 2, 2.6, 2.5, 2);
link('z0_d2', 'z2_d2');
link('z2_d2', 'z2_west', 'z2_mid');
link('z2_mid', 'z2_w6_in', 'z2_east');
link('z2_w6_in', 'z2_w6_out');
link('z2_east', 'z2_ramp_mid');

// Z4 Breaker's Yard (entered from z2_ramp_mid through d_yard)
n('z4_gate', 2, 0, -4, 4);
n('z4_nw', -6, 0, -6, 4);
n('z4_w', -8, 0, -14, 4);
n('z4_wmid', -7, 0, -24, 4);
n('z4_sw', -6, 0, -34, 4);
n('z4_sww', -3, 0, -40.5, 4);
n('z4_s3', 4, 0, -40, 4);
n('z4_w7_in', 14, 0, -40.3, 4);
n('z4_w7_out', 14, 0, -43.4, 4);
n('z4_s2', 24, 0, -38, 4);
n('z4_se', 36, 0, -32, 4);
n('z4_w8_in', 42.5, 0, -32, 4);
n('z4_w8_out', 45.4, 0, -32, 4);
n('z4_e', 38, 0, -20, 4);
n('z4_ene', 41, 0, -8, 4);
n('z4_box', 35, 0, 1, 4);
n('z4_n', 22, 0, 4, 4);
n('z4_nmid', 10, 0, 2, 4);
n('z4_rim', 11, 0, 8.5, 4);
n('z4_loop_n', 15, 0, -11, 4);
n('z4_loop_m', 16, 0, -19, 4);
n('z4_loop_s', 16, 0, -27, 4);
link('z2_ramp_mid', 'z4_gate');
link('z4_gate', 'z4_nw', 'z4_nmid');
link('z4_nw', 'z4_w');
link('z4_w', 'z4_wmid');
link('z4_wmid', 'z4_sw');
link('z4_sw', 'z4_sww');
link('z4_sww', 'z4_s3');
link('z4_s3', 'z4_w7_in');
link('z4_w7_in', 'z4_w7_out', 'z4_s2');
link('z4_s2', 'z4_se', 'z4_loop_s');
link('z4_se', 'z4_w8_in', 'z4_e');
link('z4_w8_in', 'z4_w8_out');
link('z4_e', 'z4_ene');
link('z4_ene', 'z4_box');
link('z4_box', 'z4_n');
link('z4_n', 'z4_nmid');
link('z4_nmid', 'z4_rim', 'z4_loop_n');
link('z4_loop_n', 'z4_loop_m');
link('z4_loop_m', 'z4_loop_s');

// Z5 Workshop + corridor + vestibule (entered via d_shop_n or d_shop_e)
n('z5_corr_n', -43, -2.6, 8.8, 5);
n('z5_corr_mid', -43, -1.3, 5, 5);
n('z5_corr_s', -43, 0, 0, 5);
n('z5_shop_n', -40, 0, -6, 5);
n('z5_nw', -36, 0, -13, 5);
n('z5_west', -41.5, 0, -20, 5);
n('z5_w9_in', -42.3, 0, -30, 5);
n('z5_w9_out', -45.5, 0, -30, 5);
n('z5_smid', -30, 0, -30, 5);
n('z5_s', -30, 0, -38, 5);
n('z5_mid', -30, 0, -22, 5);
n('z5_e', -20, 0, -16, 5);
n('z5_vest', -14, 0, -14.5, 5);
link('z3_south', 'z5_corr_n');
link('z5_corr_n', 'z5_corr_mid');
link('z5_corr_mid', 'z5_corr_s');
link('z5_corr_s', 'z5_shop_n');
link('z5_shop_n', 'z5_nw');
link('z5_nw', 'z5_west', 'z5_mid');
link('z5_west', 'z5_w9_in');
link('z5_w9_in', 'z5_w9_out', 'z5_smid');
link('z5_smid', 'z5_s', 'z5_mid');
link('z5_mid', 'z5_e');
link('z5_e', 'z5_vest');
link('z5_vest', 'z4_w');

// Z6 Drydock Basin (entered from z4_rim through d_dock)
n('z6_ramp_mid', 11, -1.75, 15.5, 6);
n('z6_ramp_bot', 11, -3.5, 20, 6);
n('z6_sw', 5, -3.5, 15, 6);
n('z6_mid', 18, -3.5, 27, 6);
n('z6_forge', 18, -3.5, 37.5, 6);
n('z6_spawn_w', 6, -3.5, 37.5, 6);
n('z6_spawn_e', 29.5, -3.5, 37, 6);
link('z4_rim', 'z6_ramp_mid');
link('z6_ramp_mid', 'z6_ramp_bot');
link('z6_ramp_bot', 'z6_sw', 'z6_mid');
link('z6_mid', 'z6_forge');
link('z6_forge', 'z6_spawn_w', 'z6_spawn_e');

// Compile to dense ids.
const navIndex = new Map<string, number>();
navNames.forEach((name, i) => navIndex.set(name, i));
const navNodes: NavNode[] = navNames.map((name, i) => {
  const def = navDefs.get(name)!;
  return {
    id: i,
    pos: def.pos,
    zone: def.zone,
    edges: [...def.edges].map((e) => navIndex.get(e)!).sort((a, b) => a - b),
  };
});
const nodeId = (name: string): number => navIndex.get(name)!;

// ---------------------------------------------------------------------------
// Windows and spawners
// ---------------------------------------------------------------------------

const WINDOW_NODES: Array<[inName: string, outName: string]> = [
  ['z0_w0_in', 'z0_w0_out'],
  ['z0_w1_in', 'z0_w1_out'],
  ['z0_w2_in', 'z0_w2_out'],
  ['z1_w3_in', 'z1_w3_out'],
  ['z1_w4_in', 'z1_w4_out'],
  ['z3_w5_in', 'z3_w5_out'],
  ['z2_w6_in', 'z2_w6_out'],
  ['z4_w7_in', 'z4_w7_out'],
  ['z4_w8_in', 'z4_w8_out'],
  ['z5_w9_in', 'z5_w9_out'],
];

const windows: WindowDef[] = windowSpecs
  .slice()
  .sort((a, b) => a.id - b.id)
  .map((w) => ({
    id: w.id,
    zone: w.zone,
    pos: w.pos,
    yaw: w.yaw,
    blockerBrushId: w.blockerBrushId,
    insideNode: nodeId(WINDOW_NODES[w.id][0]),
    outsideNode: nodeId(WINDOW_NODES[w.id][1]),
  }));

const zombieSpawners: ZombieSpawner[] = [
  // One spawner per window pocket.
  { zone: 0, pos: { x: -2.5, y: 5.2, z: 17.6 }, window: 0 },
  { zone: 0, pos: { x: -2.5, y: 5.2, z: 27.6 }, window: 1 },
  { zone: 0, pos: { x: -10, y: 5.2, z: 35.4 }, window: 2 },
  { zone: 1, pos: { x: -30, y: 0.6, z: 35.5 }, window: 3 },
  { zone: 1, pos: { x: -23, y: 0.6, z: 35.5 }, window: 4 },
  { zone: 3, pos: { x: -51.4, y: -2.6, z: 15.6 }, window: 5 },
  { zone: 2, pos: { x: -2, y: 5.2, z: 13.6 }, window: 6 },
  { zone: 4, pos: { x: 14, y: 0, z: -43.4 }, window: 7 },
  { zone: 4, pos: { x: 45.4, y: 0, z: -32 }, window: 8 },
  { zone: 5, pos: { x: -45.5, y: 0, z: -30 }, window: 9 },
  // Open-air pressure in the outdoor zones.
  { zone: 4, pos: { x: -9, y: 0, z: -38 } },
  { zone: 4, pos: { x: 40, y: 0, z: 8 } },
  { zone: 4, pos: { x: 16, y: 0, z: 4 } },
  { zone: 6, pos: { x: 6, y: -3.5, z: 38 } },
  { zone: 6, pos: { x: 30, y: -3.5, z: 38 } },
];

// ---------------------------------------------------------------------------
// The MapDef
// ---------------------------------------------------------------------------

export const SHIPBREAK_WATER_LEVEL = -6.0;
export const SHIPBREAK_BOUNDS = {
  min: { x: -54, y: -10, z: -46 },
  max: { x: 48, y: 26, z: 46 },
};

export const SHIPBREAK_BRUSHES: readonly Brush[] = brushes;
export const SHIPBREAK_NAV: readonly NavNode[] = navNodes;

export const SHIPBREAK: MapDef = {
  id: MapId.Shipbreak,
  name: 'Shipbreak',
  brushes: SHIPBREAK_BRUSHES,
  bounds: SHIPBREAK_BOUNDS,
  waterLevel: SHIPBREAK_WATER_LEVEL,
  spawns,
  zones,
  navNodes: SHIPBREAK_NAV,
  interactables,
  zombieSpawners,
  windows,
  doorBrushIdsByZone: [
    [],
    ['d_hold'],
    ['d_gang'],
    ['d_engine'],
    ['d_yard'],
    ['d_shop_n', 'd_shop_e'],
    ['d_dock'],
  ],
};
