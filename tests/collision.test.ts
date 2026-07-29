/**
 * DECKSHOT — collision world tests. Owned by physics-movement.
 *
 * These gate the build: every gameplay system downstream (bullets, movement,
 * spawn placement) is only as correct as the collider set built from BRUSHES.
 */

import { describe, expect, it } from 'vitest';

import {
  capsuleOverlap,
  capsuleSweep,
  createCollisionWorld,
  isOutOfBounds,
  raycastWorld,
  raycastWorldAll,
} from '../shared/collision.js';
import { BRUSHES, UPPER_DECK_Y, WATER_LEVEL, WORLD_BOUNDS } from '../shared/mapdata.js';
import {
  PLAYER_HEIGHT_CROUCH,
  PLAYER_HEIGHT_STAND,
  PLAYER_RADIUS,
} from '../shared/tuning.js';

const world = createCollisionWorld();

const DOWN = { x: 0, y: -1, z: 0 };

describe('collision world construction', () => {
  it('builds one collider per brush and caches the world', () => {
    expect(world.boxes.length).toBe(BRUSHES.length);
    expect(createCollisionWorld()).toBe(world);
  });

  it('covers every collider in the broadphase grid', () => {
    // CSR item count must be at least one cell per collider.
    expect(world.cellItems.length).toBeGreaterThanOrEqual(world.boxes.length);
    expect(world.cellStart.length).toBe(world.nx * world.nz + 1);
  });
});

describe('raycastWorld', () => {
  it('hits deck_port at deck height when fired straight down', () => {
    const hit = raycastWorld({ x: -6.5, y: 5, z: 0 }, DOWN, 20);
    expect(hit).not.toBeNull();
    expect(hit!.brush.id).toBe('deck_port');
    // deck_port: centre y = -0.25, half y = 0.25 => top face at y = 0.
    expect(hit!.t).toBeCloseTo(5, 9);
    expect(hit!.point.y).toBeCloseTo(0, 9);
    expect(hit!.normal.x).toBeCloseTo(0, 12);
    expect(hit!.normal.y).toBeCloseTo(1, 12);
    expect(hit!.normal.z).toBeCloseTo(0, 12);
  });

  it('returns null when nothing is in range', () => {
    // Straight up from the middle of the mid corridor: only sky.
    expect(raycastWorld({ x: 0, y: 6, z: 0 }, { x: 0, y: 1, z: 0 }, 50)).toBeNull();
    // Short ray that stops before the deck.
    expect(raycastWorld({ x: -6.5, y: 5, z: 0 }, DOWN, 1)).toBeNull();
  });

  it('leaves the crossmap corridor sightline unobstructed', () => {
    // The bow-to-stern shot the whole mode is built around must be clear.
    const hit = raycastWorld({ x: 0, y: 1.6, z: 22 }, { x: 0, y: 0, z: -1 }, 44);
    expect(hit).toBeNull();
  });

  it('treats a ramp as a true OBB, not its AABB', () => {
    // The bow port ramp rises 3.15m over 6m of run from z = 4.93.
    // Its AABB top is at y ~ 3.28; the real surface at z = 6 is far lower.
    const hit = raycastWorld({ x: -7, y: 5, z: 6 }, DOWN, 20);
    expect(hit).not.toBeNull();
    expect(hit!.brush.tag).toBe('ramp');

    const slope = 3.15 / 6;
    const expectedY = 0.132812 + (6 - 4.930266) * slope;
    expect(hit!.point.y).toBeCloseTo(expectedY, 3);
    expect(hit!.point.y).toBeLessThan(1.0); // an AABB would answer ~3.28

    // Normal is the ramp's local +Y rotated by its pitch.
    const pitch = Math.atan2(3.15, 6);
    expect(hit!.normal.y).toBeCloseTo(Math.cos(pitch), 6);
    expect(hit!.normal.z).toBeCloseTo(-Math.sin(pitch), 6);
  });
});

describe('raycastWorldAll', () => {
  it('returns hits sorted near to far and respects the cap', () => {
    // Across the fore cabin: window, wall, wall, window.
    const origin = { x: -9, y: 1.7, z: 16 };
    const dir = { x: 1, y: 0, z: 0 };
    const all = raycastWorldAll(origin, dir, 20, 16);
    expect(all.length).toBeGreaterThan(1);
    for (let i = 1; i < all.length; i++) {
      expect(all[i].t).toBeGreaterThanOrEqual(all[i - 1].t);
    }
    const first = raycastWorld(origin, dir, 20);
    expect(first).not.toBeNull();
    expect(all[0].brush.id).toBe(first!.brush.id);
    expect(all[0].t).toBeCloseTo(first!.t, 12);

    const capped = raycastWorldAll(origin, dir, 20, 1);
    expect(capped.length).toBe(1);
    expect(raycastWorldAll(origin, dir, 20, 0).length).toBe(0);
  });
});

describe('capsuleOverlap', () => {
  it('reports no overlap for a player standing on the open deck', () => {
    expect(capsuleOverlap(world, { x: -6.5, y: 0.001, z: 0 }, PLAYER_RADIUS, PLAYER_HEIGHT_STAND)).toBe(
      false
    );
  });

  it('blocks a standing capsule under the catwalk but allows a crouched one', () => {
    // Catwalk deck spans y 3.15..3.45 over the port side of the pool.
    const under = { x: -5.5, y: 1.65, z: 0 };
    expect(capsuleOverlap(world, under, PLAYER_RADIUS, PLAYER_HEIGHT_STAND)).toBe(true);
    expect(capsuleOverlap(world, under, PLAYER_RADIUS, PLAYER_HEIGHT_CROUCH)).toBe(false);
  });

  it('detects a capsule buried in the port bulwark', () => {
    expect(capsuleOverlap(world, { x: -9.25, y: 0.001, z: 0 }, PLAYER_RADIUS, PLAYER_HEIGHT_STAND)).toBe(
      true
    );
  });
});

describe('capsuleSweep', () => {
  it('stops a 4m dash at the port bulwark instead of tunnelling through it', () => {
    const from = { x: -7, y: 0.001, z: 0 };
    const to = { x: -11, y: 0.001, z: 0 };
    const r = capsuleSweep(world, from, to, PLAYER_RADIUS, PLAYER_HEIGHT_STAND);
    expect(r.hit).toBe(true);
    // Bulwark inner face at x = -9.0; capsule radius 0.35.
    expect(r.position.x).toBeGreaterThan(-8.66);
    expect(r.position.x).toBeLessThan(-8.64);
    expect(r.normal.x).toBeCloseTo(1, 6);
    expect(r.fraction).toBeGreaterThan(0);
    expect(r.fraction).toBeLessThan(1);
  });

  it('passes cleanly through open air', () => {
    const r = capsuleSweep(
      world,
      { x: -6.5, y: 6, z: -10 },
      { x: -6.5, y: 6, z: 10 },
      PLAYER_RADIUS,
      PLAYER_HEIGHT_STAND
    );
    expect(r.hit).toBe(false);
    expect(r.fraction).toBe(1);
    expect(r.position.z).toBe(10);
  });

  it('lands on the ramp surface, not on its bounding box', () => {
    const r = capsuleSweep(
      world,
      { x: -7, y: 3.0, z: 6 },
      { x: -7, y: -1.0, z: 6 },
      PLAYER_RADIUS,
      PLAYER_HEIGHT_STAND
    );
    expect(r.hit).toBe(true);
    expect(r.brush!.tag).toBe('ramp');
    // Sphere of radius r resting on a slope sits r*(1/cos - 1) above the
    // surface point directly beneath it.
    const pitch = Math.atan2(3.15, 6);
    const surfaceY = 0.132812 + (6 - 4.930266) * (3.15 / 6);
    const expected = surfaceY + PLAYER_RADIUS * (1 / Math.cos(pitch) - 1);
    expect(r.position.y).toBeCloseTo(expected, 2);
    expect(r.normal.y).toBeCloseTo(Math.cos(pitch), 4);
  });

  it('is symmetric about Z = 0, like the map', () => {
    const a = capsuleSweep(
      world,
      { x: -7, y: 3.0, z: 6 },
      { x: -7, y: -1.0, z: 6 },
      PLAYER_RADIUS,
      PLAYER_HEIGHT_STAND
    );
    const b = capsuleSweep(
      world,
      { x: -7, y: 3.0, z: -6 },
      { x: -7, y: -1.0, z: -6 },
      PLAYER_RADIUS,
      PLAYER_HEIGHT_STAND
    );
    expect(a.hit).toBe(true);
    expect(b.hit).toBe(true);
    expect(b.position.y).toBeCloseTo(a.position.y, 9);
  });

  it('is bit-identical when the same query is repeated', () => {
    const from = { x: -7, y: 2.0, z: 6 };
    const to = { x: -8.5, y: -1.0, z: 7.5 };
    const a = capsuleSweep(world, from, to, PLAYER_RADIUS, PLAYER_HEIGHT_STAND);
    const b = capsuleSweep(world, from, to, PLAYER_RADIUS, PLAYER_HEIGHT_STAND);
    expect(b.fraction).toBe(a.fraction);
    expect(b.position.x).toBe(a.position.x);
    expect(b.position.y).toBe(a.position.y);
    expect(b.position.z).toBe(a.position.z);
    expect(b.normal.y).toBe(a.normal.y);
  });
});

describe('isOutOfBounds', () => {
  it('is false anywhere on the boat', () => {
    expect(isOutOfBounds({ x: 0, y: 0, z: 0 })).toBe(false);
    expect(isOutOfBounds({ x: -8.6, y: 0, z: 25 })).toBe(false);
    expect(isOutOfBounds({ x: 0, y: UPPER_DECK_Y, z: 16 })).toBe(false);
  });

  it('is true in the sea and outside the world box', () => {
    expect(isOutOfBounds({ x: 0, y: WATER_LEVEL - 0.01, z: 0 })).toBe(true);
    expect(isOutOfBounds({ x: WORLD_BOUNDS.min.x - 0.01, y: 0, z: 0 })).toBe(true);
    expect(isOutOfBounds({ x: WORLD_BOUNDS.max.x + 0.01, y: 0, z: 0 })).toBe(true);
    expect(isOutOfBounds({ x: 0, y: 0, z: WORLD_BOUNDS.min.z - 0.01 })).toBe(true);
    expect(isOutOfBounds({ x: 0, y: 0, z: WORLD_BOUNDS.max.z + 0.01 })).toBe(true);
    expect(isOutOfBounds({ x: 0, y: WORLD_BOUNDS.max.y + 0.01, z: 0 })).toBe(true);
  });
});
