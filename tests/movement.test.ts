/**
 * DECKSHOT — movement tests. Owned by physics-movement.
 *
 * The determinism block is the one that matters most: client prediction and
 * the server simulation call the same `applyMovement`, and any divergence
 * above RECONCILE_EPSILON (1cm) rubber-bands the player. These assertions use
 * `===` on raw floats deliberately — "close enough" is not a passing grade for
 * a lockstep function.
 */

import { describe, expect, it } from 'vitest';

import { applyMovement, wrapAngle, type MovementState } from '../shared/movement.js';
import { createCollisionWorld } from '../shared/collision.js';
import { stepPlayerMovement } from '../server/src/sim/movement.js';
import { UPPER_DECK_Y, WATER_LEVEL } from '../shared/mapdata.js';
import {
  AdsState,
  DEFAULT_LOADOUT,
  InputButton,
  Stance,
  TeamId,
  WeaponId,
  type ClientInput,
} from '../shared/types.js';
import {
  GRAVITY,
  JUMP_IMPULSE,
  PITCH_LIMIT,
  SLIDE_MIN_SPEED,
  SPEED_CROUCH,
  SPEED_SPRINT,
  SPEED_WALK,
  TICK_DT,
} from '../shared/tuning.js';

const world = createCollisionWorld();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    name: 'tester',
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

function input(over: Partial<ClientInput> = {}): ClientInput {
  return { seq: 0, tick: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...over };
}

function run(state: MovementState, inp: ClientInput, ticks: number): MovementState {
  let s = state;
  for (let i = 0; i < ticks; i++) s = applyMovement(s, inp, TICK_DT, world).state;
  return s;
}

/** Drops a player onto whatever is beneath and lets them come to rest. */
function settle(state: MovementState, ticks = 60): MovementState {
  return run(state, input(), ticks);
}

const hSpeed = (s: MovementState): number =>
  Math.sqrt(s.velocity.x * s.velocity.x + s.velocity.z * s.velocity.z);

// yaw = 0 looks down -Z (shared/types.ts), so forward = (-sin yaw, 0, -cos yaw).
const YAW_TOWARD_NEG_Z = 0;
const YAW_TOWARD_POS_Z = Math.PI;
const YAW_TOWARD_NEG_X = Math.PI / 2;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** mulberry32 — small, seeded, and identical everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 600 ticks that exercise every branch: a sprint down the walkway, jumps,
 * strafes, a slide, a ramp climb and a long seeded-random tail.
 */
function buildSequence(): ClientInput[] {
  const r = rng(0xdec5401);
  const out: ClientInput[] = [];
  let yaw = YAW_TOWARD_POS_Z;

  for (let i = 0; i < 600; i++) {
    let moveX = 0;
    let moveZ = 0;
    let buttons = 0;

    if (i < 120) {
      // Sprint up the port walkway and onto the ramp.
      moveZ = 1;
      buttons = InputButton.Sprint;
    } else if (i < 200) {
      // Hop while running — includes a held-jump stretch.
      moveZ = 1;
      buttons = InputButton.Sprint;
      if (i % 20 < 6) buttons |= InputButton.Jump;
    } else if (i < 260) {
      // Turn round and slide back down.
      yaw = YAW_TOWARD_NEG_Z;
      moveZ = 1;
      buttons = InputButton.Sprint;
      if (i >= 230) buttons |= InputButton.Crouch;
    } else if (i < 320) {
      // Strafe-jump: hold forward-left while turning.
      yaw = wrapAngle(yaw + 0.03);
      moveX = -1;
      moveZ = 1;
      buttons = InputButton.Sprint | InputButton.Jump;
    } else {
      // Seeded chaos.
      moveX = Math.round(r() * 2 - 1);
      moveZ = Math.round(r() * 2 - 1);
      yaw = wrapAngle(yaw + (r() - 0.5) * 0.4);
      if (r() < 0.25) buttons |= InputButton.Jump;
      if (r() < 0.2) buttons |= InputButton.Crouch;
      if (r() < 0.5) buttons |= InputButton.Sprint;
    }

    out.push({
      seq: i & 0xffff,
      tick: i,
      moveX,
      moveZ,
      yaw,
      pitch: Math.sin(i * 0.037) * 0.8,
      buttons,
    });
  }
  return out;
}

function replay(inputs: ClientInput[]): MovementState {
  let s = settle(makeState(-7, 1.0, 2.0), 30);
  for (let i = 0; i < inputs.length; i++) s = applyMovement(s, inputs[i], TICK_DT, world).state;
  return s;
}

function fingerprint(s: MovementState): number[] {
  return [
    s.position.x,
    s.position.y,
    s.position.z,
    s.velocity.x,
    s.velocity.y,
    s.velocity.z,
    s.yaw,
    s.pitch,
    s.stance,
    s.onGround ? 1 : 0,
    s.slideTime,
    s.slideCooldown,
    s.sprintTime,
  ];
}

describe('determinism', () => {
  const inputs = buildSequence();

  it('produces bit-identical results for the same 600-input sequence', () => {
    const a = fingerprint(replay(inputs));
    const b = fingerprint(replay(inputs));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]); // === on the float
  });

  it('produces bit-identical results from a deep-cloned input array', () => {
    const a = fingerprint(replay(inputs));
    const cloned = inputs.map((i) => ({ ...i }));
    const c = fingerprint(replay(cloned));
    for (let i = 0; i < a.length; i++) expect(c[i]).toBe(a[i]);
  });

  it('never mutates the inputs it is handed', () => {
    const before = JSON.stringify(inputs);
    replay(inputs);
    expect(JSON.stringify(inputs)).toBe(before);
  });

  it('actually moves the player somewhere non-trivial', () => {
    // Guards against the determinism test passing because nothing happened.
    const end = replay(inputs);
    const start = settle(makeState(-7, 1.0, 2.0), 30);
    const d = Math.abs(end.position.x - start.position.x) + Math.abs(end.position.z - start.position.z);
    expect(d).toBeGreaterThan(3);
    expect(Number.isFinite(end.position.x)).toBe(true);
    expect(Number.isFinite(end.position.y)).toBe(true);
    expect(Number.isFinite(end.position.z)).toBe(true);
  });
});

describe('purity', () => {
  it('does not mutate the state object it is passed', () => {
    const s = settle(makeState(-7, 1.0, 0));
    s.velocity.x = 3.5;
    s.velocity.z = -1.25;
    const snapshot = JSON.stringify(s);
    const inp = input({ moveZ: 1, yaw: 0.5, buttons: InputButton.Jump | InputButton.Sprint });
    const r = applyMovement(s, inp, TICK_DT, world);
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(r.state).not.toBe(s);
    expect(r.state.position).not.toBe(s.position);
    expect(r.state.velocity).not.toBe(s.velocity);
  });

  it('leaves history states untouched when replayed forward', () => {
    // The reconciliation path keeps old states alive; aliasing them would be
    // an unfindable desync.
    const history: MovementState[] = [settle(makeState(-8.6, 0.02, 22))];
    const inp = input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z });
    for (let i = 0; i < 10; i++) {
      history.push(applyMovement(history[history.length - 1], inp, TICK_DT, world).state);
    }
    for (let i = 1; i < history.length; i++) {
      expect(history[i].position).not.toBe(history[i - 1].position);
      expect(history[i].position.z).not.toBe(history[i - 1].position.z);
    }
  });
});

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

describe('view angles', () => {
  it('clamps pitch to PITCH_LIMIT', () => {
    const s = settle(makeState(-7, 1.0, 0));
    expect(applyMovement(s, input({ pitch: 3 }), TICK_DT, world).state.pitch).toBe(PITCH_LIMIT);
    expect(applyMovement(s, input({ pitch: -3 }), TICK_DT, world).state.pitch).toBe(-PITCH_LIMIT);
  });

  it('wraps yaw to (-PI, PI]', () => {
    const s = settle(makeState(-7, 1.0, 0));
    const a = applyMovement(s, input({ yaw: Math.PI * 3 }), TICK_DT, world).state.yaw;
    expect(a).toBeGreaterThan(-Math.PI);
    expect(a).toBeLessThanOrEqual(Math.PI);
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(Math.PI * 2 + 0.5)).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// Ground movement
// ---------------------------------------------------------------------------

describe('ground movement', () => {
  it('reaches exactly SPEED_WALK and exactly SPEED_SPRINT', () => {
    let s = settle(makeState(-8.6, 0.02, 22));
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z }), 40);
    expect(hSpeed(s)).toBeCloseTo(SPEED_WALK, 9);
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Sprint }), 40);
    expect(hSpeed(s)).toBeCloseTo(SPEED_SPRINT, 9);
  });

  it('needs SPRINT_RAMP of held sprint before sprint speed engages', () => {
    let s = settle(makeState(-8.6, 0.02, 22));
    const sprint = input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Sprint });
    s = run(s, sprint, 3);
    expect(s.sprintTime).toBeGreaterThan(0);
    expect(hSpeed(s)).toBeLessThanOrEqual(SPEED_WALK + 1e-9);
    // Releasing sprint resets the ramp.
    s = applyMovement(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z }), TICK_DT, world).state;
    expect(s.sprintTime).toBe(0);
  });

  it('comes to a complete stop, not an asymptote', () => {
    let s = settle(makeState(-8.6, 0.02, 22));
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z }), 40);
    s = run(s, input(), 60);
    expect(s.velocity.x).toBe(0);
    expect(s.velocity.z).toBe(0);
  });

  it('stops at the port bulwark and does not pass through it', () => {
    let s = settle(makeState(-7, 0.02, 0));
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_X }), 240);
    // Bulwark inner face x = -9.0, capsule radius 0.35.
    expect(s.position.x).toBeGreaterThan(-8.7);
    expect(s.position.x).toBeLessThan(-8.6);
    expect(s.onGround).toBe(true);
  });

  it('cannot be shoved through a wall at 40 m/s', () => {
    let s = settle(makeState(-7, 0.02, 0));
    s.velocity.x = -40;
    for (let i = 0; i < 60; i++) {
      s = applyMovement(s, input(), TICK_DT, world).state;
      expect(s.position.x).toBeGreaterThan(-8.7);
    }
    expect(s.position.x).toBeGreaterThan(-8.7);
  });
});

// ---------------------------------------------------------------------------
// Slopes and steps
// ---------------------------------------------------------------------------

describe('slopes and steps', () => {
  it('walks a ramp from the walkway up to the cabin-roof height', () => {
    let s = settle(makeState(-7, 0.5, 6.0), 30);
    expect(s.onGround).toBe(true);
    expect(s.position.y).toBeLessThan(1.0);

    let maxY = s.position.y;
    let leftGround = false;
    const up = input({ moveZ: 1, yaw: YAW_TOWARD_POS_Z });
    // The ramp's top edge is at z ~ 10.93; stop before the player runs off it.
    for (let i = 0; i < 70 && s.position.z < 10.5; i++) {
      s = applyMovement(s, up, TICK_DT, world).state;
      if (!s.onGround) leftGround = true;
      if (s.position.y > maxY) maxY = s.position.y;
    }
    expect(maxY).toBeGreaterThanOrEqual(UPPER_DECK_Y - 0.2);
    // The climb is a walk, not a fall-and-scramble.
    expect(leftGround).toBe(false);

    // Carry on off the end and the player does reach the upper deck height.
    for (let i = 0; i < 6; i++) {
      s = applyMovement(s, up, TICK_DT, world).state;
      if (s.position.y > maxY) maxY = s.position.y;
    }
    expect(maxY).toBeGreaterThanOrEqual(UPPER_DECK_Y);
  });

  it('auto-steps onto the foot of the ramp without leaving the ground', () => {
    // The ramp's low lip sits 0.133m above the deck — inside STEP_HEIGHT.
    let s = settle(makeState(-5.9, 0.3, 3.5), 40);
    expect(s.onGround).toBe(true);
    expect(s.position.y).toBeLessThan(0.05);

    const up = input({ moveZ: 1, yaw: YAW_TOWARD_POS_Z });
    for (let i = 0; i < 40; i++) {
      s = applyMovement(s, up, TICK_DT, world).state;
      expect(s.onGround).toBe(true); // never launches off the lip
    }
    expect(s.position.y).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Jumping
// ---------------------------------------------------------------------------

describe('jumping', () => {
  it('reaches the documented ~1.05m apex, within 2cm', () => {
    let s = settle(makeState(-8.6, 1.0, 22));
    const groundY = s.position.y;
    expect(s.onGround).toBe(true);

    const jump = input({ buttons: InputButton.Jump });
    let maxY = groundY;
    for (let i = 0; i < 120; i++) {
      s = applyMovement(s, jump, TICK_DT, world).state;
      if (s.position.y > maxY) maxY = s.position.y;
    }
    const apex = maxY - groundY;
    // Analytic apex for the tuning constants.
    expect((JUMP_IMPULSE * JUMP_IMPULSE) / (2 * GRAVITY)).toBeCloseTo(1.0336, 3);
    expect(Math.abs(apex - 1.05)).toBeLessThan(0.02);
  });

  it('does not re-jump while the key is held', () => {
    let s = settle(makeState(-8.6, 1.0, 22));
    const jump = input({ buttons: InputButton.Jump });
    let takeoffs = 0;
    let wasGround = s.onGround;
    for (let i = 0; i < 300; i++) {
      s = applyMovement(s, jump, TICK_DT, world).state;
      if (wasGround && !s.onGround) takeoffs++;
      wasGround = s.onGround;
    }
    expect(takeoffs).toBe(1);
    expect(s.onGround).toBe(true);
  });

  it('jumps again once the key is released and pressed', () => {
    let s = settle(makeState(-8.6, 1.0, 22));
    const jump = input({ buttons: InputButton.Jump });
    let takeoffs = 0;
    let wasGround = s.onGround;
    for (let i = 0; i < 300; i++) {
      // Release every other tick so each landing gets a fresh press.
      s = applyMovement(s, i % 2 === 0 ? jump : input(), TICK_DT, world).state;
      if (wasGround && !s.onGround) takeoffs++;
      wasGround = s.onGround;
    }
    expect(takeoffs).toBeGreaterThan(2);
  });

  it('reports landed and impactSpeed exactly once per landing', () => {
    let s = makeState(-8.6, 4.0, 22);
    let landings = 0;
    let impact = 0;
    for (let i = 0; i < 120; i++) {
      const r = applyMovement(s, input(), TICK_DT, world);
      s = r.state;
      if (r.landed) {
        landings++;
        impact = r.impactSpeed;
      } else {
        expect(r.impactSpeed).toBe(0);
      }
    }
    expect(landings).toBe(1);
    // Fell ~4m: v = sqrt(2*g*h).
    expect(impact).toBeGreaterThan(6);
    expect(impact).toBeLessThan(13);
  });

  it('keeps horizontal speed through a jump and lets a strafe add to it', () => {
    let s = settle(makeState(-8.6, 0.02, 26));
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Sprint }), 40);
    const before = hSpeed(s);
    expect(before).toBeCloseTo(SPEED_SPRINT, 6);

    s = applyMovement(
      s,
      input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Sprint | InputButton.Jump }),
      TICK_DT,
      world
    ).state;
    let yaw = YAW_TOWARD_NEG_Z;
    let best = before;
    for (let i = 0; i < 40 && !s.onGround; i++) {
      yaw = wrapAngle(yaw + 0.02);
      s = applyMovement(
        s,
        input({ moveX: -1, moveZ: 1, yaw, buttons: InputButton.Sprint | InputButton.Jump }),
        TICK_DT,
        world
      ).state;
      if (hSpeed(s) > best) best = hSpeed(s);
    }
    // No air speed cap: strafe-jumping must be able to exceed sprint speed.
    expect(best).toBeGreaterThan(SPEED_SPRINT + 0.5);
  });
});

// ---------------------------------------------------------------------------
// Stances
// ---------------------------------------------------------------------------

describe('stances', () => {
  it('crouches and stands back up in the open', () => {
    let s = settle(makeState(-8.6, 0.02, 22));
    s = run(s, input({ buttons: InputButton.Crouch }), 5);
    expect(s.stance).toBe(Stance.Crouch);
    s = run(s, input(), 5);
    expect(s.stance).toBe(Stance.Stand);
  });

  it('cannot stand up while under the catwalk', () => {
    // On the port ramp where it passes beneath the catwalk: the crouched
    // capsule fits, the standing one does not.
    let s = makeState(-6.0, 1.9, 8.0);
    s.stance = Stance.Crouch;
    s = run(s, input(), 90);
    expect(s.onGround).toBe(true);
    expect(s.stance).toBe(Stance.Crouch); // crouch is NOT held; still stuck

    // Same ramp, clear of the catwalk: standing up works.
    let t = makeState(-7.4, 1.9, 8.0);
    t.stance = Stance.Crouch;
    t = run(t, input(), 90);
    expect(t.onGround).toBe(true);
    expect(t.stance).toBe(Stance.Stand);
  });

  it('moves at crouch speed while crouched', () => {
    let s = settle(makeState(-8.6, 0.02, 22));
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Crouch }), 40);
    expect(s.stance).toBe(Stance.Crouch);
    expect(hSpeed(s)).toBeCloseTo(SPEED_CROUCH, 9);
  });

  it('drop-shots: crouch held through a landing goes prone', () => {
    let s = makeState(-8.6, 2.5, 22);
    s = run(s, input({ buttons: InputButton.Crouch }), 60);
    expect(s.onGround).toBe(true);
    expect(s.stance).toBe(Stance.Prone);
    s = run(s, input(), 60);
    expect(s.stance).toBe(Stance.Stand);
  });

  it('does not jump while prone', () => {
    let s = makeState(-8.6, 2.5, 22);
    s = run(s, input({ buttons: InputButton.Crouch }), 60);
    expect(s.stance).toBe(Stance.Prone);
    const y = s.position.y;
    s = run(s, input({ buttons: InputButton.Crouch | InputButton.Jump }), 10);
    expect(s.position.y).toBeCloseTo(y, 6);
    expect(s.onGround).toBe(true);
  });
});

describe('sliding', () => {
  it('slides from a sprint, boosts, then drops to crouch and goes on cooldown', () => {
    let s = settle(makeState(-8.6, 0.02, 24));
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Sprint }), 40);
    expect(hSpeed(s)).toBeGreaterThan(SLIDE_MIN_SPEED);

    const slide = input({
      moveZ: 1,
      yaw: YAW_TOWARD_NEG_Z,
      buttons: InputButton.Sprint | InputButton.Crouch,
    });
    s = applyMovement(s, slide, TICK_DT, world).state;
    expect(s.stance).toBe(Stance.Slide);
    expect(hSpeed(s)).toBeGreaterThan(SPEED_SPRINT);
    expect(s.slideTime).toBeGreaterThan(0);

    s = run(s, slide, 40);
    expect(s.stance).toBe(Stance.Crouch);
    expect(s.slideCooldown).toBeGreaterThan(0);
  });

  it('will not slide below SLIDE_MIN_SPEED', () => {
    let s = settle(makeState(-8.6, 0.02, 24));
    s = run(s, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z }), 40); // walk, not sprint
    s = applyMovement(
      s,
      input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Crouch }),
      TICK_DT,
      world
    ).state;
    expect(s.stance).toBe(Stance.Crouch);
  });
});

// ---------------------------------------------------------------------------
// ADS hand-off to weapons
// ---------------------------------------------------------------------------

describe('ADS movement speed', () => {
  it('honours adsMoveSpeedOverride when scoped, and SPEED_ADS otherwise', () => {
    const base = settle(makeState(-8.6, 0.02, 22));

    let scoped: MovementState = { ...base, adsState: AdsState.Scoped };
    scoped = run(scoped, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Ads }), 60);
    expect(hSpeed(scoped)).toBeCloseTo(2.6, 9); // SPEED_ADS

    let stocked: MovementState = { ...base, adsState: AdsState.Scoped, adsMoveSpeedOverride: 3.6 };
    stocked = run(stocked, input({ moveZ: 1, yaw: YAW_TOWARD_NEG_Z, buttons: InputButton.Ads }), 60);
    expect(hSpeed(stocked)).toBeCloseTo(3.6, 9); // LightweightStock
  });
});

// ---------------------------------------------------------------------------
// Server wrapper
// ---------------------------------------------------------------------------

describe('stepPlayerMovement', () => {
  it('matches applyMovement exactly', () => {
    const s = settle(makeState(-8.6, 0.02, 22));
    const inp = input({ moveZ: 1, yaw: 0.3, buttons: InputButton.Sprint });
    const a = applyMovement(s, inp, TICK_DT, world);
    const b = stepPlayerMovement(s, inp, TICK_DT, world);
    expect(b.state.position.x).toBe(a.state.position.x);
    expect(b.state.position.y).toBe(a.state.position.y);
    expect(b.state.position.z).toBe(a.state.position.z);
    expect(b.suspicious).toBe(false);
  });

  it('reports out of bounds in the water without killing the player', () => {
    const s = makeState(0, WATER_LEVEL - 1, 0);
    const r = stepPlayerMovement(s, input(), TICK_DT, world);
    expect(r.outOfBounds).toBe(true);
    expect(r.state.alive).toBe(true);
  });

  it('rejects a poisoned state instead of propagating NaN', () => {
    const s = settle(makeState(-8.6, 0.02, 22));
    s.velocity.x = Number.NaN;
    const r = stepPlayerMovement(s, input(), TICK_DT, world);
    expect(r.suspicious).toBe(true);
    expect(Number.isFinite(r.state.position.x)).toBe(true);
    expect(r.state.velocity.x).toBe(0);
  });

  it('does not flag legitimate strafe-jump speed as suspicious', () => {
    let s = settle(makeState(-8.6, 0.02, 26));
    let yaw = YAW_TOWARD_NEG_Z;
    for (let i = 0; i < 200; i++) {
      yaw = wrapAngle(yaw + 0.02);
      const r = stepPlayerMovement(
        s,
        input({ moveX: -1, moveZ: 1, yaw, buttons: InputButton.Sprint | InputButton.Jump }),
        TICK_DT,
        world
      );
      expect(r.suspicious).toBe(false);
      s = r.state;
    }
  });
});
