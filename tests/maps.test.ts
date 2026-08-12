/**
 * Every map in the registry has to satisfy the same contract, or it is not
 * shippable. These are the checks that catch the mistakes hand-authored brush
 * geometry actually makes: a spawn buried in a wall, a spawn over a hole, a
 * sightline that turned out to be a wall, geometry outside the bounds box.
 *
 * Sundeck passed all of these before the registry existed. The three adapted
 * maps are held to exactly the same bar.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPETITIVE_MAPS,
  DEFAULT_MAP_ID,
  MAPS,
  isCompetitiveMapId,
  mapById,
  worldForMap,
} from '../shared/maps.js';
import { MapId } from '../shared/mapdef.js';
import { SpawnZone } from '../shared/mapdata.js';
import { capsuleOverlap, isOutOfBounds, raycastWorldIn } from '../shared/collision.js';
import { applyMovement, type MovementState } from '../shared/movement.js';
import {
  PLAYER_HEIGHT_STAND,
  PLAYER_RADIUS,
  STEP_HEIGHT,
  TICK_DT,
} from '../shared/tuning.js';
import {
  AdsState,
  DEFAULT_LOADOUT,
  Stance,
  TeamId,
  WeaponId,
  emptyInput,
  type ClientInput,
} from '../shared/types.js';

const DOWN = { x: 0, y: -1, z: 0 };

function makeState(x: number, y: number, z: number): MovementState {
  return {
    id: 1,
    position: { x, y, z },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: false,
    slideTime: 0,
    slideCooldown: 0,
    sprintTime: 0,
    health: 100,
    alive: true,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    ammoInMag: 5,
    ammoReserve: 25,
    actionEndsAt: 0,
    name: 'spawn-probe',
    team: TeamId.FFA,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 0,
    prevButtons: 0,
    proneTime: 0,
  };
}

describe('map registry', () => {
  it('every registered map is reachable by id, and unknown ids fall back', () => {
    for (const m of MAPS) expect(mapById(m.id)).toBe(m);
    expect(mapById(255 as MapId).id).toBe(DEFAULT_MAP_ID);
    expect(mapById(-1 as MapId).id).toBe(DEFAULT_MAP_ID);
  });

  it('MapId values are unique — the enum is the wire format', () => {
    expect(new Set(MAPS.map((m) => m.id)).size).toBe(MAPS.length);
  });

  it('the default map is registered and competitive', () => {
    expect(isCompetitiveMapId(DEFAULT_MAP_ID)).toBe(true);
  });

  it('Leviathan is never offered for a competitive match', () => {
    // It is deliberately asymmetric and every route through it is gated behind
    // a purchase, so FFA on it would be unplayable.
    expect(isCompetitiveMapId(MapId.Leviathan)).toBe(false);
    expect(COMPETITIVE_MAPS.some((m) => m.id === MapId.Leviathan)).toBe(false);
  });

  it('adapted maps carry a full credit; originals carry none', () => {
    for (const m of MAPS) {
      if (!m.credit) continue;
      expect(m.credit.original.length).toBeGreaterThan(0);
      expect(m.credit.authors.length).toBeGreaterThan(0);
      expect(m.credit.project.length).toBeGreaterThan(0);
      expect(m.credit.license).toMatch(/^CC BY(-SA)? \d/);
      expect(m.credit.url).toMatch(/^https:\/\//);
    }
  });
});

describe.each(COMPETITIVE_MAPS.map((m) => [m.name, m] as const))('%s', (_name, map) => {
  const world = worldForMap(map);

  it('is mirror-symmetric about Z=0', () => {
    // Built with mirrorZ/quad, so this holds by construction — the test is here
    // to catch a brush added by hand on one side only.
    const key = (x: (typeof map.brushes)[number]) =>
      `${x.center.x.toFixed(3)},${x.center.y.toFixed(3)},${Math.abs(x.center.z).toFixed(3)},` +
      `${x.half.x},${x.half.y},${x.half.z},${x.material}`;
    const counts = new Map<string, number>();
    for (const brush of map.brushes) {
      if (Math.abs(brush.center.z) < 1e-6) continue;
      counts.set(key(brush), (counts.get(key(brush)) ?? 0) + 1);
    }
    for (const [k, n] of counts) {
      expect(n % 2, `${map.name} is not symmetric about Z=0: ${k} appears ${n} time(s)`).toBe(0);
    }
  });

  it('keeps every brush inside its own bounds box', () => {
    for (const brush of map.brushes) {
      // Same world AABB the broadphase derives, so this measures the geometry
      // physics actually sees rather than a loose sphere around it.
      const cy = Math.cos(brush.yaw);
      const sy = Math.sin(brush.yaw);
      const cp = Math.cos(brush.pitch);
      const spp = Math.sin(brush.pitch);
      const { x: hx, y: hy, z: hz } = brush.half;
      const ex = Math.abs(cy) * hx + Math.abs(spp * sy) * hy + Math.abs(cp * sy) * hz;
      const ez = Math.abs(sy) * hx + Math.abs(spp * cy) * hy + Math.abs(cp * cy) * hz;
      const ey = Math.abs(cp) * hy + Math.abs(spp) * hz;
      expect(brush.center.x - ex, `${brush.id} pokes out of -X`).toBeGreaterThanOrEqual(map.bounds.min.x - 1e-6);
      expect(brush.center.x + ex, `${brush.id} pokes out of +X`).toBeLessThanOrEqual(map.bounds.max.x + 1e-6);
      expect(brush.center.z - ez, `${brush.id} pokes out of -Z`).toBeGreaterThanOrEqual(map.bounds.min.z - 1e-6);
      expect(brush.center.z + ez, `${brush.id} pokes out of +Z`).toBeLessThanOrEqual(map.bounds.max.z + 1e-6);
      expect(brush.center.y + ey, `${brush.id} pokes out of +Y`).toBeLessThanOrEqual(map.bounds.max.y + 1e-6);
    }
  });

  it('has unique brush ids', () => {
    const seen = new Set<string>();
    for (const brush of map.brushes) {
      expect(seen.has(brush.id)).toBe(false);
      seen.add(brush.id);
    }
  });

  it('puts the kill height below the arena and inside the bounds box', () => {
    expect(map.waterLevel).toBeGreaterThan(map.bounds.min.y);
    if (map.environment.ground) expect(map.environment.ground.y).toBeLessThan(map.waterLevel);
  });

  it('spawns both ends and the middle, with matching counts per team', () => {
    const a = map.spawns.filter((s) => s.zone === SpawnZone.Bow);
    const b = map.spawns.filter((s) => s.zone === SpawnZone.Stern);
    const mid = map.spawns.filter((s) => s.zone === SpawnZone.Mid);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(mid.length).toBeGreaterThanOrEqual(2);
    for (const s of a) expect(s.position.z).toBeGreaterThan(0);
    for (const s of b) expect(s.position.z).toBeLessThan(0);
    // Ids are dense and unique — the room indexes spawns by cursor modulo n.
    expect(new Set(map.spawns.map((s) => s.id)).size).toBe(map.spawns.length);
  });

  it.each(map.spawns.map((s) => [s.id, s] as const))('spawn %i is stood on solid ground', (_id, spawn) => {
    const p = spawn.position;

    expect(isOutOfBounds(p, world)).toBe(false);
    // Not buried: a standing capsule at the spawn must be clear of geometry.
    expect(capsuleOverlap(world, p, PLAYER_RADIUS, PLAYER_HEIGHT_STAND)).toBe(false);

    // Floor within one step below. Start the probe just above the spawn so a
    // surface exactly at the spawn's feet is not missed from inside.
    const hit = raycastWorldIn(world, { x: p.x, y: p.y + 0.5, z: p.z }, DOWN, 0.5 + STEP_HEIGHT);
    expect(hit, `spawn ${spawn.id} at (${p.x}, ${p.y}, ${p.z}) has no floor under it`).not.toBeNull();
  });

  it('settles every spawn to rest without falling out of the world', () => {
    for (const spawn of map.spawns) {
      let state = makeState(spawn.position.x, spawn.position.y, spawn.position.z);
      const input = emptyInput();
      // Two seconds of standing still is plenty to fall out of a broken floor.
      for (let i = 0; i < 120; i++) state = applyMovement(state, input, TICK_DT, world).state;
      const p = state.position;
      const where = `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
      expect(isOutOfBounds(p, world), `spawn ${spawn.id} slid out of the world, ending at ${where}`).toBe(false);
      expect(state.onGround, `spawn ${spawn.id} never landed, ending at ${where}`).toBe(true);
      // Depenetration must not have shoved them across the map to get free.
      expect(Math.hypot(p.x - spawn.position.x, p.z - spawn.position.z)).toBeLessThan(1);
    }
  });

  it('has a clear signature sightline', () => {
    expect(map.sightline, `${map.name} has no signature sightline`).not.toBeNull();
    const { from, to } = map.sightline!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    expect(dist).toBeGreaterThan(25);
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const hit = raycastWorldIn(world, from, dir, dist);
    expect(
      hit,
      `${map.id}: the sightline is blocked by ${hit?.brush.id} at ${hit?.t.toFixed(2)}m of ${dist.toFixed(2)}m`
    ).toBeNull();
  });

});

/**
 * Every route a player has to be able to walk, walked.
 *
 * A ramp that reaches the right height in the data can still be unusable: its
 * foot can land inside a railing, its head can land next to the surface it was
 * meant to reach instead of on it, or the thing it climbs over can leave less
 * headroom than a standing player underneath. All three of those shipped in the
 * first draft of these maps and all three were found here, not by eye.
 *
 * `yaw = 0` walks toward -Z; `yaw = PI` walks toward +Z.
 */
function walkFrom(
  mapId: MapId,
  from: readonly [number, number, number],
  yaw: number,
  ticks: number
): MovementState {
  const world = worldForMap(mapById(mapId));
  let s = makeState(from[0], from[1], from[2]);
  const inp: ClientInput = { seq: 0, tick: 0, moveX: 0, moveZ: 1, yaw, pitch: 0, buttons: 0 };
  // Settle first, so the probe starts standing rather than falling.
  for (let i = 0; i < 40; i++) s = applyMovement(s, { ...inp, moveZ: 0 }, TICK_DT, world).state;
  for (let i = 0; i < ticks; i++) s = applyMovement(s, inp, TICK_DT, world).state;
  return s;
}

interface Route {
  what: string;
  map: MapId;
  from: readonly [number, number, number];
  yaw: number;
  ticks: number;
  /** Height the walk must end at, within 0.25m. */
  endY: number;
}

const ROUTES: Route[] = [
  // --- Death Trap ---------------------------------------------------------
  { what: 'spawn deck up a ramp to the bridge landing', map: MapId.DeathTrap, from: [-3.5, 0, 23], yaw: 0, ticks: 95, endY: 3.3 },
  { what: 'landing out along the bridge', map: MapId.DeathTrap, from: [0, 3.3, 14], yaw: 0, ticks: 260, endY: 3.3 },
  { what: 'main floor down the ramp into the pit', map: MapId.DeathTrap, from: [0, 0, 12], yaw: 0, ticks: 200, endY: -2 },
  { what: 'pit back up the ramp to the main floor', map: MapId.DeathTrap, from: [0, -2, -6], yaw: 0, ticks: 200, endY: 0 },
  // --- Hangar A482 --------------------------------------------------------
  { what: 'bow door up the end ramp onto the spine', map: MapId.Hangar, from: [0, 0, 24], yaw: 0, ticks: 200, endY: 3.5 },
  { what: 'the length of the starboard bay', map: MapId.Hangar, from: [7, 0, 22], yaw: 0, ticks: 400, endY: 0 },
  // --- Unknown Rooftop ----------------------------------------------------
  { what: 'deck up the ramp onto the shrine roof', map: MapId.Rooftop, from: [-8.8, 0, 12.5], yaw: 0, ticks: 220, endY: 3.4 },
  { what: 'tower deck up the ramp to the upper platform', map: MapId.Rooftop, from: [3, 0, 18], yaw: Math.PI, ticks: 200, endY: 3.4 },
  { what: 'tower to tower through both shrine doorways', map: MapId.Rooftop, from: [0, 0, 16], yaw: 0, ticks: 400, endY: 0 },
];

describe('traversal', () => {
  it.each(ROUTES.map((r) => [`${mapById(r.map).name}: ${r.what}`, r] as const))('%s', (_label, route) => {
    const s = walkFrom(route.map, route.from, route.yaw, route.ticks);
    const p = s.position;
    const where = `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
    expect(s.onGround, `ended airborne at ${where}`).toBe(true);
    expect(isOutOfBounds(p, worldForMap(mapById(route.map))), `ended out of bounds at ${where}`).toBe(false);
    expect(p.y, `expected to end at y=${route.endY}, ended at ${where}`).toBeCloseTo(route.endY, 1);
  });
});
