/**
 * Hitbox tests — owner: weapons-hitreg.
 *
 * Hit registration is the fastest way to lose a player's trust. Every claim
 * this file makes is one a player would notice being wrong within a minute of
 * playing.
 */

import { describe, expect, it } from 'vitest';

import {
  HITBOX_TEMPLATE,
  hitboxCenter,
  hitboxesFor,
  hitboxesForStance,
  rayVsCapsule,
  rayVsPlayer,
  stanceScale,
} from '../shared/hitbox.js';
import {
  EYE_HEIGHT_CROUCH,
  PLAYER_HEIGHT_CROUCH,
  PLAYER_HEIGHT_STAND,
  PLAYER_RADIUS,
} from '../shared/tuning.js';
import {
  AdsState,
  DEFAULT_LOADOUT,
  HITBOX_PART_COUNT,
  HitboxPart,
  Stance,
  TeamId,
  WeaponId,
  vec3,
} from '../shared/types.js';
import type { PlayerState, Vec3 } from '../shared/types.js';

function makePlayer(pos: Vec3, opts: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 1,
    position: pos,
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
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
    name: 'T',
    team: TeamId.FFA,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 0,
    ...opts,
  };
}

/** Unit direction pointing along +Z. */
const FORWARD: Vec3 = { x: 0, y: 0, z: 1 };

describe('hitbox layout', () => {
  it('has exactly one capsule per HitboxPart', () => {
    expect(HITBOX_TEMPLATE.length).toBe(HITBOX_PART_COUNT);
    const parts = new Set(HITBOX_TEMPLATE.map((c) => c.part));
    expect(parts.size).toBe(HITBOX_PART_COUNT);
    for (let p = 0; p < HITBOX_PART_COUNT; p++) expect(parts.has(p as HitboxPart)).toBe(true);
  });

  it('fills the standing capsule without poking out of it', () => {
    let maxHalfWidth = 0;
    let top = 0;
    let bottom = Infinity;
    for (const c of HITBOX_TEMPLATE) {
      maxHalfWidth = Math.max(maxHalfWidth, Math.abs(c.a.x) + c.radius, Math.abs(c.b.x) + c.radius);
      top = Math.max(top, c.a.y + c.radius, c.b.y + c.radius);
      bottom = Math.min(bottom, c.a.y - c.radius, c.b.y - c.radius);
    }
    // A hitbox wider than the collider is the "shot me through the wall" bug.
    expect(maxHalfWidth).toBeLessThanOrEqual(PLAYER_RADIUS + 1e-9);
    expect(top).toBeLessThanOrEqual(PLAYER_HEIGHT_STAND + 1e-9);
    expect(bottom).toBeGreaterThan(-0.05);
  });

  it('keeps the head a genuinely small target', () => {
    const head = HITBOX_TEMPLATE.find((c) => c.part === HitboxPart.Head)!;
    expect(head.radius).toBeLessThan(0.12);
    const chest = HITBOX_TEMPLATE.find((c) => c.part === HitboxPart.Chest)!;
    expect(head.radius).toBeLessThan(chest.radius * 0.6);
  });
});

describe('rayVsCapsule', () => {
  it('hits a capsule broadside at the expected distance', () => {
    // Vertical capsule at z = 5, radius 0.2. A ray along +Z enters at 4.8.
    const t = rayVsCapsule(0, 1, 0, 0, 0, 1, 0, 0.5, 5, 0, 1.5, 5, 0.2, 100);
    expect(t).toBeCloseTo(4.8, 9);
  });

  it('misses when the ray passes outside the radius', () => {
    const t = rayVsCapsule(0.5, 1, 0, 0, 0, 1, 0, 0.5, 5, 0, 1.5, 5, 0.2, 100);
    expect(t).toBe(-1);
  });

  it('hits the end cap above the segment', () => {
    // Segment tops out at y = 1.5; a ray at y = 1.6 still clips the cap sphere.
    const t = rayVsCapsule(0, 1.6, 0, 0, 0, 1, 0, 0.5, 5, 0, 1.5, 5, 0.2, 100);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(5);
    // Half-chord of the cap sphere at 0.1 above centre: sqrt(0.2^2 - 0.1^2).
    expect(t).toBeCloseTo(5 - Math.sqrt(0.04 - 0.01), 9);
  });

  it('reports 0 when the ray starts inside — point blank is a hit', () => {
    const t = rayVsCapsule(0, 1, 5, 0, 0, 1, 0, 0.5, 5, 0, 1.5, 5, 0.2, 100);
    expect(t).toBe(0);
  });

  it('handles a ray parallel to the capsule axis', () => {
    // Straight down the axis from above: the top cap is at y = 1.7.
    const t = rayVsCapsule(0, 3, 5, 0, -1, 0, 0, 0.5, 5, 0, 1.5, 5, 0.2, 100);
    expect(t).toBeCloseTo(1.3, 9);
  });

  it('respects maxDist', () => {
    expect(rayVsCapsule(0, 1, 0, 0, 0, 1, 0, 0.5, 5, 0, 1.5, 5, 0.2, 3)).toBe(-1);
  });
});

describe('rayVsPlayer', () => {
  it('a headshot ray reports Head, not Chest', () => {
    const target = makePlayer(vec3(0, 0, 5));
    // Eye level on a standing player: 1.60m. The chest capsule tops out at
    // 1.47, so nothing but the head is up here.
    const hit = rayVsPlayer({ x: 0, y: 1.6, z: 0 }, FORWARD, target);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe(HitboxPart.Head);
    expect(hit!.t).toBeGreaterThan(4.8);
    expect(hit!.t).toBeLessThan(5);
  });

  it('a chest-height ray reports Chest', () => {
    const target = makePlayer(vec3(0, 0, 5));
    const hit = rayVsPlayer({ x: 0, y: 1.25, z: 0 }, FORWARD, target);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe(HitboxPart.Chest);
  });

  it('a leg-height ray reports a leg', () => {
    const target = makePlayer(vec3(0, 0, 5));
    const hit = rayVsPlayer({ x: 0.115, y: 0.4, z: 0 }, FORWARD, target);
    expect(hit).not.toBeNull();
    expect([HitboxPart.LegL, HitboxPart.LegR]).toContain(hit!.part);
  });

  it('a ray past the shoulder misses entirely', () => {
    const target = makePlayer(vec3(0, 0, 5));
    // Widest point at this height is the arm at 0.265 + 0.085 = 0.35.
    expect(rayVsPlayer({ x: 0.5, y: 1.2, z: 0 }, FORWARD, target)).toBeNull();
    expect(rayVsPlayer({ x: -0.5, y: 1.2, z: 0 }, FORWARD, target)).toBeNull();
  });

  it('a ray over the head misses entirely', () => {
    const target = makePlayer(vec3(0, 0, 5));
    expect(rayVsPlayer({ x: 0, y: 1.9, z: 0 }, FORWARD, target)).toBeNull();
  });

  it('a ray pointing away from the target misses', () => {
    const target = makePlayer(vec3(0, 0, 5));
    expect(rayVsPlayer({ x: 0, y: 1.25, z: 0 }, { x: 0, y: 0, z: -1 }, target)).toBeNull();
  });

  it('returns the NEAREST part when several are in line', () => {
    const target = makePlayer(vec3(0, 0, 5));
    // Through the arm first, then the chest: the arm is nearer in Z? No — the
    // arm is offset in X, so aim down the arm's own line and expect the arm.
    const hit = rayVsPlayer({ x: 0.265, y: 1.2, z: 0 }, FORWARD, target);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe(HitboxPart.ArmR);
  });

  it('a crouched player is shorter: the head sits at crouch height', () => {
    const stand = makePlayer(vec3(0, 0, 5));
    const crouch = makePlayer(vec3(0, 0, 5), { stance: Stance.Crouch });

    // The standing headshot line now passes over an empty space.
    expect(rayVsPlayer({ x: 0, y: 1.6, z: 0 }, FORWARD, stand)!.part).toBe(HitboxPart.Head);
    expect(rayVsPlayer({ x: 0, y: 1.6, z: 0 }, FORWARD, crouch)).toBeNull();

    // And the crouched head is where the crouched eye is.
    const hit = rayVsPlayer({ x: 0, y: EYE_HEIGHT_CROUCH + 0.03, z: 0 }, FORWARD, crouch);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe(HitboxPart.Head);

    const head = hitboxesForStance(Stance.Crouch).find((c) => c.part === HitboxPart.Head)!;
    const centre = (head.a.y + head.b.y) * 0.5;
    expect(centre).toBeGreaterThan(EYE_HEIGHT_CROUCH - 0.1);
    expect(centre).toBeLessThan(PLAYER_HEIGHT_CROUCH);
  });

  it('a prone player is a much shorter target', () => {
    const prone = makePlayer(vec3(0, 0, 5), { stance: Stance.Prone });
    expect(stanceScale(Stance.Prone)).toBeLessThan(0.4);
    expect(rayVsPlayer({ x: 0, y: 1.25, z: 0 }, FORWARD, prone)).toBeNull();
    expect(rayVsPlayer({ x: 0, y: 0.45, z: 0 }, FORWARD, prone)).not.toBeNull();
  });

  it('slide uses the crouch height', () => {
    expect(stanceScale(Stance.Slide)).toBe(stanceScale(Stance.Crouch));
  });
});

describe('world-space hitboxes', () => {
  it('translates to the player position', () => {
    const target = makePlayer(vec3(3, 2, -4));
    const boxes = hitboxesFor(target);
    const head = boxes.find((c) => c.part === HitboxPart.Head)!;
    expect(head.a.x).toBeCloseTo(3, 9);
    expect(head.a.z).toBeCloseTo(-4, 9);
    expect(head.a.y).toBeCloseTo(2 + 1.575, 9);
  });

  it('rotates the arms with yaw', () => {
    // Yaw of PI/2 turns the player 90 degrees; the right arm swings onto -Z.
    const target = makePlayer(vec3(0, 0, 0), { yaw: Math.PI / 2 });
    const boxes = hitboxesFor(target);
    const arm = boxes.find((c) => c.part === HitboxPart.ArmR)!;
    expect(arm.a.x).toBeCloseTo(0, 9);
    expect(arm.a.z).toBeCloseTo(-0.265, 9);
  });

  it('a yawed player is still hit through the body axis', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, 2.3, -1.1]) {
      const target = makePlayer(vec3(0, 0, 5), { yaw });
      const hit = rayVsPlayer({ x: 0, y: 1.25, z: 0 }, FORWARD, target);
      expect(hit, `yaw ${yaw}`).not.toBeNull();
      // Side-on, an arm genuinely sits in front of the chest and takes the round
      // first. That is the correct answer, not a bug.
      expect([HitboxPart.Chest, HitboxPart.ArmL, HitboxPart.ArmR]).toContain(hit!.part);
    }
    const facing = makePlayer(vec3(0, 0, 5));
    expect(rayVsPlayer({ x: 0, y: 1.25, z: 0 }, FORWARD, facing)!.part).toBe(HitboxPart.Chest);
  });

  it('hitboxCenter lands inside the corresponding capsule', () => {
    const target = makePlayer(vec3(1, 0, 2));
    const out = vec3();
    hitboxCenter(target, HitboxPart.Head, out);
    expect(out.x).toBeCloseTo(1, 9);
    expect(out.z).toBeCloseTo(2, 9);
    expect(out.y).toBeCloseTo((1.575 + 1.64) / 2, 9);
  });
});
