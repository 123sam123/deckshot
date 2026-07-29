/**
 * Weapon tests — owner: weapons-hitreg.
 *
 * Three things are load-bearing here and everything else is scaffolding:
 *   - attachments resolve to exact, checkable numbers;
 *   - spread is EXACTLY zero at the accuracy lock and positive below it;
 *   - `timeSinceAccuracyLock` is a rising-edge stopwatch, so a flick and a camp
 *     are distinguishable. If that last one regresses, quickscope detection dies
 *     silently and the game stops being the game.
 */

import { describe, expect, it } from 'vitest';

import { ScopeZoom } from '../client/src/gameplay/controller.js';
import { PredictedWeapons, WeaponEventType } from '../client/src/gameplay/weapons.js';
import { CombatSystem, MAX_SHOT_RANGE, shotOrigin } from '../server/src/sim/combat.js';
import { BRUSHES, MATERIAL_PENETRATION, SurfaceMaterial } from '../shared/mapdata.js';
import { hashSeed, makeRng, makeShotRng, nextFloat, nextUnitCircle } from '../shared/rng.js';
import { CorrectionReason } from '../shared/protocol.js';
import type { SnapshotPlayer } from '../shared/protocol.js';
import {
  FOV_IRONSIGHT,
  FOV_SCOPED_3_5X,
  FOV_SCOPED_8X,
  FOV_WORLD,
  MAX_HEALTH,
  QUICKSCOPE_WINDOW,
  SPEED_ADS,
  TICK_DT,
  WEAPONS,
} from '../shared/tuning.js';
import { evaluateTrickshot } from '../shared/trickshot.js';
import { TrickshotFlag } from '../shared/protocol.js';
import {
  WeaponAction,
  advanceWeapon,
  applyLoadoutToState,
  applySpread,
  canFire,
  createWeaponRuntime,
  easeAds,
  hipfireCone,
  resolveWeapon,
  spreadForShot,
  type ResolvedWeapon,
  type WeaponRuntime,
} from '../shared/weapons.js';
import {
  AdsState,
  AttachmentId,
  DEFAULT_LOADOUT,
  HitboxPart,
  InputButton,
  Stance,
  TeamId,
  WeaponId,
  emptyInput,
  vec3,
} from '../shared/types.js';
import type { ClientInput, PlayerState, Vec3 } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlayer(id: number, pos: Vec3, opts: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    position: pos,
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    slideTime: 0,
    slideCooldown: 0,
    sprintTime: 0,
    health: MAX_HEALTH,
    alive: true,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    ammoInMag: 5,
    ammoReserve: 25,
    actionEndsAt: 0,
    name: `P${id}`,
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

function input(seq: number, buttons = 0, extra: Partial<ClientInput> = {}): ClientInput {
  return { ...emptyInput(), seq, tick: seq, buttons, ...extra };
}

/** Run `n` ticks with a constant button mask. */
function run(ws: WeaponRuntime, rw: ResolvedWeapon, n: number, buttons: number, seq0 = 0): WeaponRuntime {
  let s = ws;
  for (let i = 0; i < n; i++) s = advanceWeapon(s, input(seq0 + i, buttons), TICK_DT, rw);
  return s;
}

/** Serialisation that survives Infinity, for determinism comparisons. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
}

const TALON = resolveWeapon(WeaponId.Talon, []);

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

describe('shared/rng', () => {
  it('is deterministic for a seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 64; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('produces different streams for different seeds', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    let same = 0;
    for (let i = 0; i < 32; i++) if (a.nextUint32() === b.nextUint32()) same++;
    expect(same).toBeLessThan(3);
  });

  it('hashSeed is stable and order-sensitive', () => {
    expect(hashSeed(7, 11)).toBe(hashSeed(7, 11));
    expect(hashSeed(7, 11)).not.toBe(hashSeed(11, 7));
    // Adjacent sequence numbers must not produce adjacent seeds.
    expect(Math.abs(hashSeed(3, 100) - hashSeed(3, 101))).toBeGreaterThan(1000);
  });

  it('nextFloat stays in [0, 1)', () => {
    const r = makeRng(hashSeed(4, 9));
    for (let i = 0; i < 5000; i++) {
      const v = nextFloat(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextUnitCircle stays inside the unit disc and is roughly area-uniform', () => {
    const r = makeRng(99);
    let inner = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const p = nextUnitCircle(r);
      const d2 = p.x * p.x + p.y * p.y;
      expect(d2).toBeLessThanOrEqual(1 + 1e-9);
      if (d2 <= 0.25) inner++; // half radius => a quarter of the area
    }
    expect(inner / N).toBeGreaterThan(0.22);
    expect(inner / N).toBeLessThan(0.28);
  });

  it('the same shot seeds the same spread on both sides', () => {
    const dir = { x: 0, y: 0, z: 1 };
    const client = vec3();
    const server = vec3();
    applySpread(dir, 0.1, makeShotRng(7, 4127), client);
    applySpread(dir, 0.1, makeShotRng(7, 4127), server);
    expect(client).toEqual(server);
    // A different shooter, or a different input, is a different bullet.
    const other = vec3();
    applySpread(dir, 0.1, makeShotRng(8, 4127), other);
    expect(other).not.toEqual(client);
  });

  it('applySpread keeps the direction unit length and inside the cone', () => {
    const dir = { x: 0, y: 0, z: 1 };
    const out = vec3();
    const rng = makeRng(3);
    for (let i = 0; i < 500; i++) {
      applySpread(dir, 0.05, rng, out);
      const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
      expect(len).toBeCloseTo(1, 12);
      const angle = Math.acos(Math.min(1, out.z));
      expect(angle).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// Attachment resolution
// ---------------------------------------------------------------------------

describe('resolveWeapon', () => {
  it('leaves the base weapon untouched with no attachments', () => {
    const base = WEAPONS[WeaponId.Talon];
    expect(TALON.adsTime).toBe(base.adsTime);
    expect(TALON.magSize).toBe(base.magSize);
    expect(TALON.accuracyLockAt).toBe(base.accuracyLockAt);
    expect(TALON.adsMoveSpeed).toBe(SPEED_ADS);
    expect(TALON.suppressed).toBe(false);
  });

  it('Fast Draw takes ADS from 0.34 to 0.2108', () => {
    const rw = resolveWeapon(WeaponId.Talon, [AttachmentId.FastDraw]);
    expect(rw.adsTime).toBeCloseTo(0.2108, 12);
    expect(rw.adsTime).toBe(0.34 * 0.62);
  });

  it('Extended Mag takes the magazine from 5 to 8 and the reload from 2.8 to 3.1', () => {
    const rw = resolveWeapon(WeaponId.Talon, [AttachmentId.ExtendedMag]);
    expect(rw.magSize).toBe(8);
    expect(rw.reloadTime).toBeCloseTo(3.1, 12);
    expect(rw.reloadTimeEmpty).toBeCloseTo(3.7, 12);
  });

  it('Fast Draw + Suppressor compose multiplicatively THEN additively', () => {
    const rw = resolveWeapon(WeaponId.Talon, [AttachmentId.FastDraw, AttachmentId.Suppressor]);
    // 0.34 * 0.62 + 0.05, not (0.34 + 0.05) * 0.62.
    expect(rw.adsTime).toBeCloseTo(0.2608, 12);
    expect(rw.adsTime).not.toBeCloseTo(0.2418, 6);
    expect(rw.damage[HitboxPart.Chest]).toBeCloseTo(90, 12);
    expect(rw.suppressed).toBe(true);
    // Order of the attachment list must not matter.
    const flipped = resolveWeapon(WeaponId.Talon, [AttachmentId.Suppressor, AttachmentId.FastDraw]);
    expect(flipped.adsTime).toBe(rw.adsTime);
  });

  it('every attachment measurably changes the resolved stats', () => {
    const baseline = stable({ ...TALON, attachments: [] });
    for (let id = 1; id < 11; id++) {
      const rw = resolveWeapon(WeaponId.Talon, [id as AttachmentId]);
      expect(stable({ ...rw, attachments: [] }), `attachment ${id}`).not.toBe(baseline);
    }
  });

  it('resolves each attachment to its documented effect', () => {
    const vz = resolveWeapon(WeaponId.Talon, [AttachmentId.VariableZoom]);
    expect(vz.adsTime).toBeCloseTo(0.4, 12);
    expect(vz.variableZoom).toBe(true);

    const stab = resolveWeapon(WeaponId.Talon, [AttachmentId.StabilizerCPU]);
    expect(stab.swayAmplitude).toBeCloseTo(WEAPONS[WeaponId.Talon].swayAmplitude * 0.25, 12);
    expect(stab.swaySettleTime).toBeCloseTo(0.35, 12);

    const fmj = resolveWeapon(WeaponId.Talon, [AttachmentId.FMJ]);
    expect(fmj.penetrationDamage).toBe(0.9);
    expect(fmj.penetrationCount).toBe(2);

    const laser = resolveWeapon(WeaponId.Talon, [AttachmentId.Laser]);
    expect(laser.hipSpreadStand).toBeCloseTo(WEAPONS[WeaponId.Talon].hipSpreadStand * 0.55, 12);
    expect(laser.laserVisible).toBe(true);

    const stock = resolveWeapon(WeaponId.Talon, [AttachmentId.LightweightStock]);
    expect(stock.adsMoveSpeed).toBe(3.6);

    const iron = resolveWeapon(WeaponId.Talon, [AttachmentId.IronSightSwap]);
    expect(iron.adsTime).toBeCloseTo(0.1904, 12);
    expect(iron.ironSights).toBe(true);

    const comp = resolveWeapon(WeaponId.Talon, [AttachmentId.BallisticCompensator]);
    expect(comp.cycleTime).toBeCloseTo(0.828, 12);
    expect(comp.recoilVertical).toBeCloseTo(WEAPONS[WeaponId.Talon].recoilVertical * 0.6, 12);
  });

  it('never lets an attachment touch the accuracy lock', () => {
    for (let id = 1; id < 11; id++) {
      const rw = resolveWeapon(WeaponId.Talon, [id as AttachmentId]);
      expect(rw.accuracyLockAt).toBe(WEAPONS[WeaponId.Talon].accuracyLockAt);
    }
  });

  it('ignores None, duplicates and overflow', () => {
    const a = resolveWeapon(WeaponId.Talon, [
      AttachmentId.FastDraw,
      AttachmentId.None,
      AttachmentId.FastDraw,
    ]);
    expect(a.adsTime).toBeCloseTo(0.2108, 12);
    expect(a.attachments.length).toBe(1);
  });

  it('is memoized and frozen — callers may not mutate a shared spec', () => {
    const a = resolveWeapon(WeaponId.Talon, [AttachmentId.FastDraw]);
    const b = resolveWeapon(WeaponId.Talon, [AttachmentId.FastDraw]);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('applyLoadoutToState publishes the ADS move speed movement reads', () => {
    const state = makePlayer(1, vec3());
    applyLoadoutToState(state, resolveWeapon(WeaponId.Talon, [AttachmentId.LightweightStock]));
    expect(state.adsMoveSpeedOverride).toBe(3.6);
    applyLoadoutToState(state, TALON);
    expect(state.adsMoveSpeedOverride).toBe(SPEED_ADS);
  });
});

// ---------------------------------------------------------------------------
// ADS curve
// ---------------------------------------------------------------------------

describe('the ADS curve', () => {
  it('eases, and is NOT the raw progress', () => {
    expect(easeAds(0)).toBe(0);
    expect(easeAds(1)).toBe(1);
    expect(easeAds(0.5)).toBeCloseTo(0.5, 12);
    // The lock is measured on raw progress; the eased value leads it.
    expect(easeAds(0.82)).toBeCloseTo(0.914464, 6);
    expect(easeAds(0.82)).toBeGreaterThan(0.82);
  });

  it('advances raw progress linearly over adsTime and exposes both values', () => {
    const ws = run(createWeaponRuntime(TALON), TALON, 10, InputButton.Ads);
    expect(ws.adsProgress).toBeCloseTo((10 * TICK_DT) / TALON.adsTime, 9);
    expect(ws.adsEased).toBeCloseTo(easeAds(ws.adsProgress), 12);
    expect(ws.adsEased).not.toBe(ws.adsProgress);
  });

  it('reaches Scoped and comes back down to Hip', () => {
    let ws = run(createWeaponRuntime(TALON), TALON, 30, InputButton.Ads);
    expect(ws.adsState).toBe(AdsState.Scoped);
    expect(ws.adsProgress).toBe(1);
    ws = run(ws, TALON, 1, 0, 100);
    expect(ws.adsState).toBe(AdsState.Lowering);
    ws = run(ws, TALON, 30, 0, 200);
    expect(ws.adsState).toBe(AdsState.Hip);
    expect(ws.adsProgress).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE stopwatch
// ---------------------------------------------------------------------------

describe('timeSinceAccuracyLock — the quickscope discriminator', () => {
  it('is Infinity before the lock is ever crossed', () => {
    const fresh = createWeaponRuntime(TALON);
    expect(fresh.timeSinceAccuracyLock).toBe(Infinity);
    const raising = run(fresh, TALON, 5, InputButton.Ads);
    expect(raising.adsProgress).toBeLessThan(TALON.accuracyLockAt);
    expect(raising.timeSinceAccuracyLock).toBe(Infinity);
  });

  it('resets to 0 on the RISING EDGE and counts up from there', () => {
    let ws = createWeaponRuntime(TALON);
    let crossedAt = -1;
    for (let i = 0; i < 40; i++) {
      const before = ws.adsProgress;
      ws = advanceWeapon(ws, input(i, InputButton.Ads), TICK_DT, TALON);
      if (before < TALON.accuracyLockAt && ws.adsProgress >= TALON.accuracyLockAt) {
        crossedAt = i;
        // The instant of the crossing reads exactly zero.
        expect(ws.timeSinceAccuracyLock).toBe(0);
        break;
      }
      expect(ws.timeSinceAccuracyLock).toBe(Infinity);
    }
    expect(crossedAt).toBeGreaterThan(0);

    // ...and then counts up in real time, including past full scope.
    ws = run(ws, TALON, 6, InputButton.Ads, 100);
    expect(ws.timeSinceAccuracyLock).toBeCloseTo(6 * TICK_DT, 9);
    expect(ws.adsState).toBe(AdsState.Scoped);
  });

  it('goes back to Infinity the moment ADS is released', () => {
    let ws = run(createWeaponRuntime(TALON), TALON, 30, InputButton.Ads);
    expect(Number.isFinite(ws.timeSinceAccuracyLock)).toBe(true);
    ws = advanceWeapon(ws, input(99, 0), TICK_DT, TALON);
    expect(ws.timeSinceAccuracyLock).toBe(Infinity);
  });

  it('DISTINGUISHES A FLICK FROM A CAMP — the whole mode depends on it', () => {
    // The flicker: raise the scope and fire the instant it locks.
    let flick = createWeaponRuntime(TALON);
    for (let i = 0; i < 40; i++) {
      flick = advanceWeapon(flick, input(i, InputButton.Ads), TICK_DT, TALON);
      if (flick.adsProgress >= TALON.accuracyLockAt) break;
    }
    expect(flick.timeSinceAccuracyLock).toBeLessThanOrEqual(QUICKSCOPE_WINDOW);

    // The camper: same scope, ten seconds of holding it in a corner.
    const camp = run(flick, TALON, 600, InputButton.Ads, 1000);
    expect(camp.timeSinceAccuracyLock).toBeCloseTo(10, 6);
    expect(camp.timeSinceAccuracyLock).toBeGreaterThan(QUICKSCOPE_WINDOW);

    // And the trickshot module agrees, which is the only thing that matters.
    const shooter = makePlayer(1, vec3());
    const victims = [{ id: 2, part: HitboxPart.Chest, distance: 10 }];
    const flickResult = evaluateTrickshot({
      shooter,
      yawHistory: [],
      timeSinceAccuracyLock: flick.timeSinceAccuracyLock,
      adsState: flick.adsState,
      adsProgress: flick.adsProgress,
      victims,
      recentKillTimes: [],
      now: 0,
      wasAirborne: false,
      stanceAtFire: Stance.Stand,
      jumpedRecently: false,
    });
    const campResult = evaluateTrickshot({
      shooter,
      yawHistory: [],
      timeSinceAccuracyLock: camp.timeSinceAccuracyLock,
      adsState: camp.adsState,
      adsProgress: camp.adsProgress,
      victims,
      recentKillTimes: [],
      now: 0,
      wasAirborne: false,
      stanceAtFire: Stance.Stand,
      jumpedRecently: false,
    });
    expect(flickResult.flags & TrickshotFlag.Quickscope).toBeTruthy();
    expect(campResult.flags & TrickshotFlag.Quickscope).toBeFalsy();
    expect(flickResult.score).toBeGreaterThan(campResult.score);
  });

  it('re-arms after a genuine drop out of the scope', () => {
    let ws = run(createWeaponRuntime(TALON), TALON, 600, InputButton.Ads);
    expect(ws.timeSinceAccuracyLock).toBeGreaterThan(5);
    // Fully lower, then flick back in.
    ws = run(ws, TALON, 30, 0, 1000);
    expect(ws.adsState).toBe(AdsState.Hip);
    expect(ws.timeSinceAccuracyLock).toBe(Infinity);
    for (let i = 0; i < 40; i++) {
      ws = advanceWeapon(ws, input(2000 + i, InputButton.Ads), TICK_DT, TALON);
      if (ws.adsProgress >= TALON.accuracyLockAt) break;
    }
    expect(ws.timeSinceAccuracyLock).toBe(0);
  });

  it('a camper cannot launder ten seconds into a quickscope with a one-tick tap', () => {
    let ws = run(createWeaponRuntime(TALON), TALON, 600, InputButton.Ads);
    const held = ws.timeSinceAccuracyLock;
    expect(held).toBeGreaterThan(9);
    // One tick out of ADS: adsProgress barely moves, so the sights never
    // actually came down.
    ws = advanceWeapon(ws, input(900, 0), TICK_DT, TALON);
    expect(ws.adsProgress).toBeGreaterThan(TALON.accuracyLockAt);
    expect(ws.timeSinceAccuracyLock).toBe(Infinity);
    ws = advanceWeapon(ws, input(901, InputButton.Ads), TICK_DT, TALON);
    expect(ws.timeSinceAccuracyLock).toBeGreaterThan(QUICKSCOPE_WINDOW);
    expect(ws.timeSinceAccuracyLock).toBeCloseTo(held + 2 * TICK_DT, 6);
  });
});

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

describe('spreadForShot', () => {
  const stander = makePlayer(1, vec3());

  it('is EXACTLY zero at and above the accuracy lock', () => {
    let ws = createWeaponRuntime(TALON);
    for (let i = 0; i < 40; i++) {
      ws = advanceWeapon(ws, input(i, InputButton.Ads), TICK_DT, TALON);
      if (ws.adsProgress >= TALON.accuracyLockAt) break;
    }
    expect(spreadForShot(ws, TALON, stander)).toBe(0);
    const scoped = run(ws, TALON, 30, InputButton.Ads, 100);
    expect(scoped.adsProgress).toBe(1);
    expect(spreadForShot(scoped, TALON, stander)).toBe(0);
  });

  it('is strictly positive everywhere below the lock', () => {
    let ws = createWeaponRuntime(TALON);
    expect(spreadForShot(ws, TALON, stander)).toBe(TALON.hipSpreadStand);
    for (let i = 0; i < 40; i++) {
      ws = advanceWeapon(ws, input(i, InputButton.Ads), TICK_DT, TALON);
      if (ws.adsProgress >= TALON.accuracyLockAt) break;
      expect(spreadForShot(ws, TALON, stander)).toBeGreaterThan(0);
    }
  });

  it('tightens monotonically on the way in', () => {
    let ws = createWeaponRuntime(TALON);
    let last = Infinity;
    for (let i = 0; i < 20; i++) {
      ws = advanceWeapon(ws, input(i, InputButton.Ads), TICK_DT, TALON);
      const s = spreadForShot(ws, TALON, stander);
      expect(s).toBeLessThanOrEqual(last + 1e-12);
      last = s;
    }
  });

  it('a shot 70% of the way in is tighter than a hipfire but far from free', () => {
    const ws = { ...createWeaponRuntime(TALON), adsProgress: 0.7, adsState: AdsState.Raising };
    const s = spreadForShot(ws, TALON, stander);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(TALON.hipSpreadStand * 0.25);
    // ~0.95 degrees: about a metre of error at 60m. Nobody is landing that.
    expect(s).toBeGreaterThan(0.01);
  });

  it('reopens symmetrically on the way out of the scope', () => {
    let ws = run(createWeaponRuntime(TALON), TALON, 40, InputButton.Ads);
    // One tick after releasing, the scope is still physically up: still pinpoint.
    ws = advanceWeapon(ws, input(100, 0), TICK_DT, TALON);
    expect(ws.adsState).toBe(AdsState.Lowering);
    expect(spreadForShot(ws, TALON, stander)).toBe(0);
    // Down past the lock, and the cone is back.
    ws = run(ws, TALON, 10, 0, 200);
    expect(ws.adsProgress).toBeLessThan(TALON.accuracyLockAt);
    expect(spreadForShot(ws, TALON, stander)).toBeGreaterThan(0);
  });

  it('picks the cone from stance and speed', () => {
    const crouched = makePlayer(1, vec3(), { stance: Stance.Crouch });
    const moving = makePlayer(1, vec3(), { velocity: vec3(4, 0, 0) });
    const airborne = makePlayer(1, vec3(), { onGround: false });
    expect(hipfireCone(TALON, stander)).toBe(TALON.hipSpreadStand);
    expect(hipfireCone(TALON, crouched)).toBe(TALON.hipSpreadCrouch);
    expect(hipfireCone(TALON, moving)).toBe(TALON.hipSpreadMoving);
    expect(hipfireCone(TALON, airborne)).toBe(TALON.hipSpreadMoving);
  });

  it('the Laser tightens every hipfire cone', () => {
    const laser = resolveWeapon(WeaponId.Talon, [AttachmentId.Laser]);
    const fresh = createWeaponRuntime(laser);
    expect(spreadForShot(fresh, laser, stander)).toBeLessThan(
      spreadForShot(fresh, TALON, stander),
    );
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('advanceWeapon', () => {
  it('never mutates its arguments', () => {
    const ws = run(createWeaponRuntime(TALON), TALON, 10, InputButton.Ads);
    const wsCopy = stable(ws);
    const inp = input(50, InputButton.Fire | InputButton.Ads);
    const inpCopy = stable(inp);
    advanceWeapon(ws, inp, TICK_DT, TALON);
    expect(stable(ws)).toBe(wsCopy);
    expect(stable(inp)).toBe(inpCopy);
  });

  it('is deterministic over a fixed 300-input replay', () => {
    const inputs: ClientInput[] = [];
    const rng = makeRng(0xdec5407);
    for (let i = 0; i < 300; i++) {
      let buttons = 0;
      if (nextFloat(rng) < 0.55) buttons |= InputButton.Ads;
      if (nextFloat(rng) < 0.2) buttons |= InputButton.Fire;
      if (nextFloat(rng) < 0.05) buttons |= InputButton.Reload;
      if (nextFloat(rng) < 0.03) buttons |= InputButton.SwapWeapon;
      if (nextFloat(rng) < 0.02) buttons |= InputButton.Melee;
      if (nextFloat(rng) < 0.1) buttons |= InputButton.ZoomToggle;
      inputs.push(input(i, buttons));
    }

    const replay = (): WeaponRuntime => {
      let s = createWeaponRuntime(TALON);
      for (const inp of inputs) s = advanceWeapon(s, inp, TICK_DT, TALON);
      return s;
    };

    const a = replay();
    const b = replay();
    expect(stable(a)).toBe(stable(b));
    // And a genuinely exercised run, not a no-op.
    expect(a.time).toBeCloseTo(300 * TICK_DT, 9);
  });

  it('fires on the trigger EDGE, not on a hold', () => {
    let ws = createWeaponRuntime(TALON);
    ws = advanceWeapon(ws, input(0, InputButton.Fire), TICK_DT, TALON);
    expect(ws.firedThisTick).toBe(true);
    expect(ws.ammoInMag).toBe(4);
    ws = advanceWeapon(ws, input(1, InputButton.Fire), TICK_DT, TALON);
    expect(ws.firedThisTick).toBe(false);
    expect(ws.ammoInMag).toBe(4);
  });

  it('honours the bolt cycle', () => {
    let ws = advanceWeapon(createWeaponRuntime(TALON), input(0, InputButton.Fire), TICK_DT, TALON);
    expect(ws.action).toBe(WeaponAction.Cycling);
    expect(canFire(ws, TALON)).toBe(false);

    // Release, then pull again well before the cycle is done.
    ws = advanceWeapon(ws, input(1, 0), TICK_DT, TALON);
    ws = advanceWeapon(ws, input(2, InputButton.Fire), TICK_DT, TALON);
    expect(ws.firedThisTick).toBe(false);
    expect(ws.ammoInMag).toBe(4);

    // Wait out the cycle and it fires again.
    ws = run(ws, TALON, 60, 0, 10);
    expect(canFire(ws, TALON)).toBe(true);
    ws = advanceWeapon(ws, input(200, InputButton.Fire), TICK_DT, TALON);
    expect(ws.firedThisTick).toBe(true);
    expect(ws.ammoInMag).toBe(3);
  });

  it('reloads partially and empty at different speeds, and refills the magazine', () => {
    let ws = createWeaponRuntime(TALON);
    // Spend one round, then partial-reload.
    ws = advanceWeapon(ws, input(0, InputButton.Fire), TICK_DT, TALON);
    ws = run(ws, TALON, 60, 0, 10);
    ws = advanceWeapon(ws, input(100, InputButton.Reload), TICK_DT, TALON);
    expect(ws.action).toBe(WeaponAction.Reloading);
    expect(ws.reloadEmpty).toBe(false);
    expect(ws.actionEndsAt - ws.time).toBeCloseTo(TALON.reloadTime, 6);
    ws = run(ws, TALON, 200, 0, 200);
    expect(ws.ammoInMag).toBe(TALON.magSize);
    expect(ws.ammoReserve).toBe(TALON.reserveAmmo - 1);

    // Empty the magazine and check the slower variant.
    let seq = 1000;
    while (ws.ammoInMag > 0) {
      ws = advanceWeapon(ws, input(seq++, InputButton.Fire), TICK_DT, TALON);
      ws = run(ws, TALON, 60, 0, seq);
      seq += 60;
    }
    ws = advanceWeapon(ws, input(seq++, InputButton.Reload), TICK_DT, TALON);
    expect(ws.reloadEmpty).toBe(true);
    expect(ws.actionEndsAt - ws.time).toBeCloseTo(TALON.reloadTimeEmpty, 6);
  });

  it('cannot fire mid-reload, and CAN aim mid-bolt-cycle', () => {
    let ws = advanceWeapon(createWeaponRuntime(TALON), input(0, InputButton.Fire), TICK_DT, TALON);
    // Cycling: the scope still comes up. This is what makes rechambering and
    // re-scoping a single fluid motion.
    ws = run(ws, TALON, 20, InputButton.Ads, 1);
    expect(ws.adsProgress).toBeGreaterThan(0);

    let r = createWeaponRuntime(TALON);
    r = advanceWeapon(r, input(0, InputButton.Fire), TICK_DT, TALON);
    r = run(r, TALON, 60, 0, 10);
    r = advanceWeapon(r, input(100, InputButton.Reload), TICK_DT, TALON);
    r = advanceWeapon(r, input(101, InputButton.Fire | InputButton.Ads), TICK_DT, TALON);
    expect(r.firedThisTick).toBe(false);
    expect(r.adsProgress).toBe(0); // sights stay down through a reload
  });

  it('swaps weapons after swapTime, preserving the stowed magazine', () => {
    let ws = createWeaponRuntime(TALON);
    ws = advanceWeapon(ws, input(0, InputButton.Fire), TICK_DT, TALON);
    expect(ws.ammoInMag).toBe(4);
    ws = run(ws, TALON, 60, 0, 1);
    ws = advanceWeapon(ws, input(100, InputButton.SwapWeapon), TICK_DT, TALON);
    expect(ws.action).toBe(WeaponAction.Swapping);
    ws = run(ws, TALON, 60, 0, 101);
    expect(ws.weapon).toBe(WeaponId.Kestrel);
    expect(ws.ammoInMag).toBe(WEAPONS[WeaponId.Kestrel].magSize);
    expect(ws.stowedWeapon).toBe(WeaponId.Talon);
    expect(ws.stowedMag).toBe(4);
  });

  it('melees for MELEE_TIME without changing the weapon', () => {
    let ws = advanceWeapon(createWeaponRuntime(TALON), input(0, InputButton.Melee), TICK_DT, TALON);
    expect(ws.meleeThisTick).toBe(true);
    expect(ws.action).toBe(WeaponAction.Melee);
    expect(ws.weapon).toBe(WeaponId.Talon);
    ws = advanceWeapon(ws, input(1, InputButton.Fire), TICK_DT, TALON);
    expect(ws.firedThisTick).toBe(false);
    ws = run(ws, TALON, 60, 0, 2);
    expect(ws.action).toBe(WeaponAction.Idle);
  });

  it('dry-fires on an empty magazine', () => {
    let ws = { ...createWeaponRuntime(TALON), ammoInMag: 0 };
    ws = advanceWeapon(ws, input(0, InputButton.Fire), TICK_DT, TALON);
    expect(ws.firedThisTick).toBe(false);
    expect(ws.dryFiredThisTick).toBe(true);
  });

  it('sway is deterministic pseudo-noise that settles while held', () => {
    const a = run(createWeaponRuntime(TALON), TALON, 20, InputButton.Ads);
    const b = run(createWeaponRuntime(TALON), TALON, 20, InputButton.Ads);
    expect(a.swayYaw).toBe(b.swayYaw);
    expect(Math.abs(a.swayYaw)).toBeGreaterThan(0);
    expect(Math.abs(a.swayYaw)).toBeLessThanOrEqual(TALON.swayAmplitude);

    // Settled sway must be smaller than fresh sway, on average.
    let early = 0;
    let late = 0;
    let ws = createWeaponRuntime(TALON);
    for (let i = 0; i < 20; i++) {
      ws = advanceWeapon(ws, input(i, InputButton.Ads), TICK_DT, TALON);
      early += Math.abs(ws.swayYaw);
    }
    ws = run(ws, TALON, 120, InputButton.Ads, 100);
    for (let i = 0; i < 20; i++) {
      ws = advanceWeapon(ws, input(300 + i, InputButton.Ads), TICK_DT, TALON);
      late += Math.abs(ws.swayYaw);
    }
    expect(late).toBeLessThan(early);
  });

  it('the Stabilizer CPU visibly calms the sway', () => {
    const stab = resolveWeapon(WeaponId.Talon, [AttachmentId.StabilizerCPU]);
    const plain = run(createWeaponRuntime(TALON), TALON, 40, InputButton.Ads);
    const calm = run(createWeaponRuntime(stab), stab, 40, InputButton.Ads);
    expect(Math.abs(calm.swayYaw)).toBeLessThan(Math.abs(plain.swayYaw));
  });
});

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/** A runtime that has just legitimately fired a scoped shot. */
function firedScoped(rw: ResolvedWeapon = TALON): WeaponRuntime {
  let ws = run(createWeaponRuntime(rw), rw, 40, InputButton.Ads);
  ws = advanceWeapon(ws, input(500, InputButton.Ads | InputButton.Fire), TICK_DT, rw);
  expect(ws.firedThisTick).toBe(true);
  return ws;
}

/** Yaw that makes `viewDirection` point along +Z / +X / -X. */
const YAW_PLUS_Z = Math.PI;
const YAW_PLUS_X = -Math.PI / 2;
const YAW_MINUS_X = Math.PI / 2;

/** Feet height that puts a standing player's chest at world height `y`. */
const chestFeet = (y: number): number => y - (1.06 + 1.275) / 2;
/** Feet height that puts a standing player's eye at world height `y`. */
const eyeFeet = (y: number): number => y - 1.62;

describe('combat — firing', () => {
  it('a scoped shot kills a lined-up target and reports the trickshot context', () => {
    const combat = new CombatSystem();
    const shooter = makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z });
    const victim = makePlayer(2, vec3(0, chestFeet(11.62), 6));
    const ws = firedScoped();

    const res = combat.fireWeapon({
      shooter,
      runtime: ws,
      resolved: TALON,
      input: input(500),
      targets: [victim],
      now: 1,
    });

    expect(res.fired).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.spread).toBe(0);
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].part).toBe(HitboxPart.Chest);
    expect(res.hits[0].damage).toBe(100);
    expect(res.hits[0].killed).toBe(true);
    expect(victim.alive).toBe(false);
    expect(victim.health).toBe(0);

    expect(res.hitMessages.length).toBe(1);
    expect(res.hitMessages[0].attackerId).toBe(1);
    expect(res.hitMessages[0].victimId).toBe(2);

    expect(res.context.timeSinceAccuracyLock).toBe(ws.timeSinceAccuracyLock);
    expect(res.context.adsState).toBe(AdsState.Scoped);
    expect(res.context.adsProgress).toBe(1);
    expect(res.context.wasAirborne).toBe(false);
    expect(res.context.stanceAtFire).toBe(Stance.Stand);
    expect(res.context.victims?.[0].distance).toBeCloseTo(6 - 0.195, 3);
    expect(res.context.victims?.[0].part).toBe(HitboxPart.Chest);
  });

  it('ONE BULLET, TWO VICTIMS — a collateral is a single call', () => {
    const combat = new CombatSystem();
    const shooter = makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z });
    const near = makePlayer(2, vec3(0, chestFeet(11.62), 5));
    const far = makePlayer(3, vec3(0, chestFeet(11.62), 10));

    const res = combat.fireWeapon({
      shooter,
      runtime: firedScoped(),
      resolved: TALON,
      input: input(500),
      targets: [near, far],
      now: 1,
    });

    expect(res.hits.length).toBe(2);
    expect(res.victims.length).toBe(2);
    expect(res.victims[0].id).toBe(2);
    expect(res.victims[1].id).toBe(3);
    expect(near.alive).toBe(false);
    expect(far.alive).toBe(false);
    // Both listed in ONE context, so ScoreKeeper.onKill is called once.
    expect(res.context.victims?.length).toBe(2);
  });

  it('a headshot is reported as a headshot', () => {
    const combat = new CombatSystem();
    const shooter = makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z });
    const victim = makePlayer(2, vec3(0, 11.62 - 1.6075, 6));
    const res = combat.fireWeapon({
      shooter,
      runtime: firedScoped(),
      resolved: TALON,
      input: input(500),
      targets: [victim],
      now: 1,
    });
    expect(res.hits[0].part).toBe(HitboxPart.Head);
  });

  it('never hits the shooter or a corpse', () => {
    const combat = new CombatSystem();
    const shooter = makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z });
    const dead = makePlayer(2, vec3(0, chestFeet(11.62), 5), { alive: false, health: 0 });
    const res = combat.fireWeapon({
      shooter,
      runtime: firedScoped(),
      resolved: TALON,
      input: input(500),
      targets: [dead, shooter],
      now: 1,
    });
    expect(res.hits.length).toBe(0);
  });

  it('a hipfire shot leaves the muzzle with a real cone', () => {
    const combat = new CombatSystem();
    const shooter = makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z });
    const ws = advanceWeapon(createWeaponRuntime(TALON), input(3, InputButton.Fire), TICK_DT, TALON);
    const res = combat.fireWeapon({
      shooter,
      runtime: ws,
      resolved: TALON,
      input: input(3),
      targets: [],
      now: 1,
    });
    expect(res.spread).toBe(TALON.hipSpreadStand);
    const dot = res.direction.z; // aim was exactly +Z
    expect(dot).toBeLessThan(1);
    expect(Math.acos(Math.min(1, dot))).toBeLessThanOrEqual(TALON.hipSpreadStand + 1e-9);
  });
});

describe('combat — penetration', () => {
  // The port catwalk rail: Metal, penetrable, 0.1m thick at x = -6.2, spanning
  // y 3.30..4.20 and z -11..11. A ray along +X at y = 3.75, z = 0 goes through
  // it and nothing else.
  const rail = BRUSHES.find((b) => b.id === 'catwalk_rail_p')!;
  const bulwark = BRUSHES.find((b) => b.id === 'bulwark_p')!;

  it('the fixtures are the brushes this test thinks they are', () => {
    expect(rail.penetrable).toBe(true);
    expect(rail.material).toBe(SurfaceMaterial.Metal);
    expect(bulwark.penetrable).toBe(false);
  });

  it('a penetrable surface costs the documented fraction of the damage', () => {
    const combat = new CombatSystem();
    const shooter = makePlayer(1, vec3(-8, eyeFeet(3.75), 0), { yaw: YAW_PLUS_X });
    // Turned side-on so the arms are not strung out along the bullet's path.
    const victim = makePlayer(2, vec3(-5, chestFeet(3.75), 0), { yaw: Math.PI / 2 });

    const res = combat.fireWeapon({
      shooter,
      runtime: firedScoped(),
      resolved: TALON,
      input: input(500),
      targets: [victim],
      now: 1,
    });

    // MATERIAL_PENETRATION[Metal] * Talon.penetrationDamage = 0.5 * 0.65.
    const expected = 100 * MATERIAL_PENETRATION[SurfaceMaterial.Metal] * TALON.penetrationDamage;
    expect(expected).toBe(32.5);
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].damage).toBeCloseTo(expected, 9);
    expect(res.hits[0].penetrated).toBe(true);
    expect(res.hits[0].killed).toBe(false);
    expect(victim.health).toBeCloseTo(100 - expected, 9);
    expect(res.impacts[0].brushId).toBe('catwalk_rail_p');
    expect(res.impacts[0].penetrated).toBe(true);
    // The round carries on through the victim and dies on the starboard rail,
    // having spent its single penetration.
    expect(res.impacts.length).toBe(2);
    expect(res.impacts[1].penetrated).toBe(false);
  });

  it('FMJ keeps far more of the damage through the same surface', () => {
    const combat = new CombatSystem();
    const fmj = resolveWeapon(WeaponId.Talon, [AttachmentId.FMJ]);
    const shooter = makePlayer(1, vec3(-8, eyeFeet(3.75), 0), { yaw: YAW_PLUS_X });
    const victim = makePlayer(2, vec3(-5, chestFeet(3.75), 0), { yaw: Math.PI / 2 });

    const res = combat.fireWeapon({
      shooter,
      runtime: firedScoped(fmj),
      resolved: fmj,
      input: input(500),
      targets: [victim],
      now: 1,
    });
    expect(res.hits[0].damage).toBeCloseTo(100 * 0.5 * 0.9, 9);
  });

  it('a NON-penetrable surface stops the round dead', () => {
    const combat = new CombatSystem();
    const shooter = makePlayer(1, vec3(-8, eyeFeet(0.6), 0), { yaw: YAW_MINUS_X });
    const victim = makePlayer(2, vec3(-11, chestFeet(0.6), 0));

    const res = combat.fireWeapon({
      shooter,
      runtime: firedScoped(),
      resolved: TALON,
      input: input(500),
      targets: [victim],
      now: 1,
    });

    expect(res.hits.length).toBe(0);
    expect(victim.health).toBe(100);
    expect(res.impacts.length).toBe(1);
    expect(res.impacts[0].brushId).toBe('bulwark_p');
    expect(res.impacts[0].penetrated).toBe(false);
  });

  it('penetrationCount is a hard limit — two rails stop a non-FMJ round', () => {
    const combat = new CombatSystem();
    // Straight across the boat at rail height: the port rail, then the
    // starboard one. The Talon can only get through one.
    const shooter = makePlayer(1, vec3(-8, eyeFeet(3.75), 0), { yaw: YAW_PLUS_X });
    const behind = makePlayer(2, vec3(8, chestFeet(3.75), 0));

    const res = combat.fireWeapon({
      shooter,
      runtime: firedScoped(),
      resolved: TALON,
      input: input(500),
      targets: [behind],
      now: 1,
    });
    expect(res.hits.length).toBe(0);
    expect(res.impacts.length).toBe(2);
    expect(res.impacts[1].penetrated).toBe(false);
  });
});

describe('combat — validation (the anti-cheat floor)', () => {
  const base = () => ({
    shooter: makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z }),
    resolved: TALON,
    input: input(500),
    targets: [] as PlayerState[],
    now: 1,
  });

  it('rejects a second shot inside the bolt cycle', () => {
    const combat = new CombatSystem();
    const req = { ...base(), runtime: firedScoped() };
    expect(combat.fireWeapon({ ...req, now: 1 }).fired).toBe(true);
    const second = combat.fireWeapon({ ...req, now: 1.1 });
    expect(second.fired).toBe(false);
    expect(second.reason).toBe(CorrectionReason.IllegalFire);
    // ...and it is allowed again once the cycle has genuinely elapsed.
    expect(combat.fireWeapon({ ...req, now: 1 + TALON.cycleTime }).fired).toBe(true);
  });

  it('rejects a shot from a dead player', () => {
    const combat = new CombatSystem();
    const req = base();
    req.shooter.alive = false;
    const res = combat.fireWeapon({ ...req, runtime: firedScoped() });
    expect(res.fired).toBe(false);
    expect(res.reason).toBe(CorrectionReason.IllegalFire);
  });

  it('rejects a shot with an empty magazine', () => {
    const combat = new CombatSystem();
    const ws = { ...createWeaponRuntime(TALON), ammoInMag: 0 };
    const res = combat.fireWeapon({ ...base(), runtime: ws });
    expect(res.fired).toBe(false);
    expect(res.reason).toBe(CorrectionReason.IllegalFire);
  });

  it('rejects a shot fired mid-reload', () => {
    const combat = new CombatSystem();
    let ws = advanceWeapon(createWeaponRuntime(TALON), input(0, InputButton.Fire), TICK_DT, TALON);
    ws = run(ws, TALON, 60, 0, 1);
    ws = advanceWeapon(ws, input(100, InputButton.Reload), TICK_DT, TALON);
    expect(ws.action).toBe(WeaponAction.Reloading);
    const res = combat.fireWeapon({ ...base(), runtime: ws });
    expect(res.fired).toBe(false);
    expect(res.reason).toBe(CorrectionReason.IllegalFire);
  });

  it('rejects a client that lies about being scoped', () => {
    const combat = new CombatSystem();
    // The server's runtime is fully scoped; the client claims it was hipfiring
    // (or the reverse — either way the two disagree and the shot is void).
    const res = combat.fireWeapon({
      ...base(),
      runtime: firedScoped(),
      claimedAdsState: AdsState.Hip,
    });
    expect(res.fired).toBe(false);
    expect(res.reason).toBe(CorrectionReason.IllegalFire);

    const combat2 = new CombatSystem();
    const honest = combat2.fireWeapon({
      ...base(),
      runtime: firedScoped(),
      claimedAdsState: AdsState.Scoped,
      claimedAdsProgress: 1,
    });
    expect(honest.fired).toBe(true);

    const combat3 = new CombatSystem();
    const liar = combat3.fireWeapon({
      ...base(),
      runtime: firedScoped(),
      claimedAdsState: AdsState.Scoped,
      claimedAdsProgress: 0.1,
    });
    expect(liar.fired).toBe(false);
  });

  it('counts rejections for escalation', () => {
    const combat = new CombatSystem();
    const req = base();
    req.shooter.alive = false;
    combat.fireWeapon({ ...req, runtime: firedScoped() });
    combat.fireWeapon({ ...req, runtime: firedScoped() });
    expect(combat.rejectionCount(1)).toBe(2);
  });
});

describe('combat — melee, damage and regeneration', () => {
  it('melee kills from any angle inside MELEE_RANGE', () => {
    const combat = new CombatSystem();
    const attacker = makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z });
    const victim = makePlayer(2, vec3(0, chestFeet(11.62), 1.5), { yaw: YAW_PLUS_Z });
    const res = combat.meleeAttack({
      attacker,
      runtime: createWeaponRuntime(TALON),
      targets: [victim],
      now: 1,
    });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].killed).toBe(true);
    expect(victim.alive).toBe(false);
    // A knife is never a quickscope, whatever the sights were doing.
    expect(res.context.adsState).toBe(AdsState.Hip);
    expect(res.context.timeSinceAccuracyLock).toBe(Infinity);
  });

  it('melee misses beyond MELEE_RANGE', () => {
    const combat = new CombatSystem();
    const attacker = makePlayer(1, vec3(0, 10, 0), { yaw: YAW_PLUS_Z });
    const victim = makePlayer(2, vec3(0, chestFeet(11.62), 4));
    const res = combat.meleeAttack({
      attacker,
      runtime: createWeaponRuntime(TALON),
      targets: [victim],
      now: 1,
    });
    expect(res.hits.length).toBe(0);
    expect(victim.alive).toBe(true);
  });

  it('regenerates only after HEALTH_REGEN_DELAY', () => {
    const combat = new CombatSystem();
    const p = makePlayer(1, vec3(0, 0, 0));
    combat.applyDamage(p, 40, 2, 10);
    expect(p.health).toBe(60);
    expect(combat.lastAttacker(1)).toBe(2);

    combat.regenerate(p, 1, 12); // still inside the delay
    expect(p.health).toBe(60);

    combat.regenerate(p, 0.5, 15); // past it
    expect(p.health).toBeCloseTo(80, 9);

    combat.tickHealth([p], 10, 30);
    expect(p.health).toBe(MAX_HEALTH);
  });

  it('does not regenerate the dead', () => {
    const combat = new CombatSystem();
    const p = makePlayer(1, vec3(0, 0, 0));
    expect(combat.applyDamage(p, 200, 2, 0)).toBe(true);
    expect(p.alive).toBe(false);
    expect(p.health).toBe(0);
    combat.regenerate(p, 100, 1000);
    expect(p.health).toBe(0);
    // A corpse cannot be killed twice.
    expect(combat.applyDamage(p, 50, 3, 1)).toBe(false);
  });

  it('shotOrigin is the eye, and drops when crouched', () => {
    const stand = makePlayer(1, vec3(0, 5, 0));
    const crouch = makePlayer(1, vec3(0, 5, 0), { stance: Stance.Crouch });
    const a = vec3();
    const b = vec3();
    shotOrigin(stand, a);
    shotOrigin(crouch, b);
    expect(a.y).toBeCloseTo(5 + 1.62, 9);
    expect(b.y).toBeCloseTo(5 + 1.02, 9);
    expect(MAX_SHOT_RANGE).toBeGreaterThan(62);
  });
});

// ---------------------------------------------------------------------------
// Client prediction
// ---------------------------------------------------------------------------

describe('client prediction', () => {
  class ZoomSpy {
    calls: ScopeZoom[] = [];
    setScopeZoom(z: ScopeZoom): void {
      this.calls.push(z);
    }
  }

  const snapshotFor = (over: Partial<SnapshotPlayer> = {}): SnapshotPlayer => ({
    id: 1,
    position: vec3(),
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    alive: true,
    health: 100,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    firedThisTick: false,
    ...over,
  });

  it('lerps the world FOV by the EASED progress, not the raw one', () => {
    const pw = new PredictedWeapons(DEFAULT_LOADOUT, null);
    expect(pw.worldFov()).toBeCloseTo(FOV_WORLD, 12);
    for (let i = 0; i < 10; i++) pw.update(input(i, InputButton.Ads), TICK_DT);
    const eased = pw.adsEased;
    expect(pw.worldFov()).toBeCloseTo(FOV_WORLD + (FOV_SCOPED_3_5X - FOV_WORLD) * eased, 12);
    expect(eased).not.toBe(pw.runtime.adsProgress);
    for (let i = 0; i < 40; i++) pw.update(input(100 + i, InputButton.Ads), TICK_DT);
    expect(pw.worldFov()).toBeCloseTo(FOV_SCOPED_3_5X, 12);
  });

  it('Iron Sight Swap barely zooms; Variable Zoom goes to 8x on demand', () => {
    const iron = new PredictedWeapons(
      { ...DEFAULT_LOADOUT, attachments: [AttachmentId.IronSightSwap, AttachmentId.None, AttachmentId.None] },
      null,
    );
    for (let i = 0; i < 40; i++) iron.update(input(i, InputButton.Ads), TICK_DT);
    expect(iron.worldFov()).toBeCloseTo(FOV_IRONSIGHT, 12);
    expect(iron.zoom).toBe(ScopeZoom.None); // no scope, no sensitivity change

    const vz = new PredictedWeapons(
      { ...DEFAULT_LOADOUT, attachments: [AttachmentId.VariableZoom, AttachmentId.None, AttachmentId.None] },
      null,
    );
    for (let i = 0; i < 40; i++) vz.update(input(i, InputButton.Ads), TICK_DT);
    expect(vz.worldFov()).toBeCloseTo(FOV_SCOPED_3_5X, 12);
    vz.update(input(100, InputButton.Ads | InputButton.ZoomToggle), TICK_DT);
    expect(vz.worldFov()).toBeCloseTo(FOV_SCOPED_8X, 12);
    expect(vz.zoom).toBe(ScopeZoom.X8);
  });

  it('tells the controller about the scope so ADS_SENS_MULT applies', () => {
    const spy = new ZoomSpy();
    const pw = new PredictedWeapons(DEFAULT_LOADOUT, spy);
    for (let i = 0; i < 40; i++) pw.update(input(i, InputButton.Ads), TICK_DT);
    expect(spy.calls).toContain(ScopeZoom.X3_5);
    spy.calls.length = 0;
    for (let i = 0; i < 40; i++) pw.update(input(100 + i, 0), TICK_DT);
    expect(spy.calls).toContain(ScopeZoom.None);
  });

  it('plays the fire effect immediately, without waiting for the server', () => {
    const pw = new PredictedWeapons(DEFAULT_LOADOUT, null);
    pw.update(input(0, InputButton.Fire), TICK_DT);
    const events = pw.consumeEvents();
    expect(events.some((e) => e.type === WeaponEventType.Fire)).toBe(true);
    expect(pw.ammoInMag).toBe(TALON.magSize - 1);
    expect(pw.consumeEvents().length).toBe(0);
  });

  it('rolls back to the corrected state and replays silently', () => {
    const pw = new PredictedWeapons(DEFAULT_LOADOUT, null);
    const inputs: ClientInput[] = [];
    for (let i = 0; i < 10; i++) {
      const inp = input(i, i === 5 ? InputButton.Fire | InputButton.Ads : InputButton.Ads);
      inputs.push(inp);
      pw.update(inp, TICK_DT);
    }
    expect(pw.consumeEvents().length).toBeGreaterThan(0);
    const beforeFive = pw.runtimeBefore(5);
    expect(beforeFive).not.toBeNull();

    pw.reconcile(
      { seq: 5, reason: CorrectionReason.IllegalFire, state: snapshotFor({ adsState: AdsState.Raising, adsProgress: beforeFive!.adsProgress }) },
      inputs.slice(5),
      TICK_DT,
    );

    // Rewound to before input 5, then inputs 6..9 replayed: nine ticks, not ten.
    expect(pw.runtime.time).toBeCloseTo(9 * TICK_DT, 9);
    // The rejected shot is gone.
    expect(pw.ammoInMag).toBe(TALON.magSize);
    // And the replay was silent.
    expect(pw.consumeEvents().length).toBe(0);
  });

  it('a correction that says we are hipfiring clears the accuracy lock', () => {
    const pw = new PredictedWeapons(DEFAULT_LOADOUT, null);
    for (let i = 0; i < 40; i++) pw.update(input(i, InputButton.Ads), TICK_DT);
    expect(Number.isFinite(pw.runtime.timeSinceAccuracyLock)).toBe(true);
    pw.applyServerState(snapshotFor({ adsState: AdsState.Hip, adsProgress: 0 }));
    expect(pw.runtime.timeSinceAccuracyLock).toBe(Infinity);
  });
});
