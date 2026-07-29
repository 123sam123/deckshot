/**
 * DECKSHOT — trickshot detection and match scoring.
 *
 * These tests are the contract for the thing the mode is named after. Every
 * number here is hand-derived from shared/tuning.ts; if a tuning value moves,
 * these should fail loudly rather than silently re-baseline.
 */

import { describe, expect, it } from 'vitest';

import { TrickshotFlag } from '../shared/protocol.js';
import {
  CROSSMAP_DISTANCE,
  FEED_WINDOW,
  QUICKSCOPE_WINDOW,
  SPIN_360,
  SPIN_540,
  SPIN_720,
  SPIN_LOOKBACK,
  TICK_RATE,
  TRICKSHOT_SCORE,
} from '../shared/tuning.js';
import {
  accumulateSpin,
  countFeedKills,
  describeTrickshot,
  evaluateTrickshot,
  wrapAngle,
  type TrickshotContext,
  type YawSample,
} from '../shared/trickshot.js';
import {
  AdsState,
  DEFAULT_LOADOUT,
  GameMode,
  HitboxPart,
  Stance,
  TeamId,
  WeaponId,
  vec3,
} from '../shared/types.js';
import type { PlayerState } from '../shared/types.js';
import { ScoreKeeper, YAW_HISTORY_SIZE } from '../server/src/sim/scoring.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function playerState(over: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 1,
    position: vec3(0, 0, 0),
    velocity: vec3(0, 0, 0),
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
    name: 'P1',
    team: TeamId.FFA,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 30,
    ...over,
  };
}

/**
 * A yaw history sweeping `totalRadians` (signed) over `duration` seconds,
 * ending exactly at `now`. Yaw values are wrapped into (-PI, PI] exactly as
 * the simulation stores them, so any history that crosses the seam exercises
 * the unwrapping path.
 */
function spinSamples(opts: {
  now: number;
  duration?: number;
  totalRadians: number;
  startYaw?: number;
  count?: number;
  onGround?: boolean;
}): YawSample[] {
  const duration = opts.duration ?? 1.0;
  const count = opts.count ?? Math.round(duration * TICK_RATE);
  const startYaw = opts.startYaw ?? 0;
  const onGround = opts.onGround ?? false;
  const out: YawSample[] = [];
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    out.push({
      t: opts.now - duration + f * duration,
      yaw: wrapAngle(startYaw + f * opts.totalRadians),
      onGround,
    });
  }
  return out;
}

/** Flat, still, grounded history — the "no spin" baseline. */
function stillSamples(now: number, onGround = true): YawSample[] {
  return spinSamples({ now, totalRadians: 0, onGround });
}

function ctx(over: Partial<TrickshotContext> = {}): TrickshotContext {
  const now = over.now ?? 100;
  return {
    shooter: playerState(),
    yawHistory: stillSamples(now),
    timeSinceAccuracyLock: Number.POSITIVE_INFINITY,
    adsState: AdsState.Scoped,
    adsProgress: 1,
    victims: [{ id: 2, part: HitboxPart.Chest, distance: 10 }],
    recentKillTimes: [],
    now,
    wasAirborne: false,
    stanceAtFire: Stance.Stand,
    jumpedRecently: false,
    ...over,
  };
}

const has = (flags: number, f: TrickshotFlag) => (flags & f) !== 0;

// ---------------------------------------------------------------------------
// Yaw unwrapping — the classic bug
// ---------------------------------------------------------------------------

describe('yaw unwrapping', () => {
  it('wraps into [-PI, PI)', () => {
    expect(wrapAngle(0)).toBeCloseTo(0, 12);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 12);
    expect(wrapAngle(-0.5)).toBeCloseTo(-0.5, 12);
    expect(wrapAngle(Math.PI + 0.5)).toBeCloseTo(-Math.PI + 0.5, 12);
    expect(wrapAngle(-Math.PI - 0.5)).toBeCloseTo(Math.PI - 0.5, 12);
    // The half-open end: exactly +PI lands on -PI. A per-tick delta of
    // exactly PI is ambiguous in direction anyway.
    expect(wrapAngle(Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapAngle(-7 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    // Magnitude never exceeds PI, whatever you feed it.
    for (const a of [12.3, -12.3, 1000, -1000, 2 * Math.PI, -2 * Math.PI]) {
      expect(Math.abs(wrapAngle(a))).toBeLessThanOrEqual(Math.PI + 1e-12);
    }
  });

  it('accumulates a full 2*PI across the -PI/+PI seam turning left', () => {
    const now = 50;
    // Starts at 3.0 rad, i.e. 0.14 rad short of the seam: the very first
    // deltas cross it.
    const history = spinSamples({ now, totalRadians: SPIN_360, startYaw: 3.0 });

    // Control: the seam really is crossed — some raw delta exceeds PI.
    const rawDeltas = history.slice(1).map((s, i) => s.yaw - history[i].yaw);
    expect(rawDeltas.some((d) => Math.abs(d) > Math.PI)).toBe(true);
    // Control: naively summing raw deltas telescopes to ~0, the classic bug.
    const naive = rawDeltas.reduce((a, b) => a + b, 0);
    expect(Math.abs(naive)).toBeLessThan(0.001);

    const spin = accumulateSpin(history, now, SPIN_LOOKBACK);
    expect(spin.total).toBeCloseTo(SPIN_360, 8);
    expect(spin.magnitude).toBeCloseTo(SPIN_360, 8);
  });

  it('accumulates a full -2*PI across the seam turning right', () => {
    const now = 50;
    const history = spinSamples({ now, totalRadians: -SPIN_360, startYaw: -3.0 });

    const rawDeltas = history.slice(1).map((s, i) => s.yaw - history[i].yaw);
    expect(rawDeltas.some((d) => Math.abs(d) > Math.PI)).toBe(true);

    const spin = accumulateSpin(history, now, SPIN_LOOKBACK);
    expect(spin.total).toBeCloseTo(-SPIN_360, 8);
    expect(spin.magnitude).toBeCloseTo(SPIN_360, 8);
  });

  it('ignores samples older than the lookback window', () => {
    const now = 50;
    // A full spin that finished 5 seconds before the shot.
    const stale = spinSamples({ now: now - 5, totalRadians: SPIN_720 });
    const spin = accumulateSpin(stale, now, SPIN_LOOKBACK);
    expect(spin.samples).toBe(0);
    expect(spin.magnitude).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spins
// ---------------------------------------------------------------------------

describe('spin detection', () => {
  it('awards 360 for a 2*PI airborne spin', () => {
    const now = 10;
    const { flags, score } = evaluateTrickshot(
      ctx({ now, yawHistory: spinSamples({ now, totalRadians: 400 * DEG, onGround: false }) }),
    );
    expect(has(flags, TrickshotFlag.Spin360)).toBe(true);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.spin360);
  });

  it('gives no spin flag for 400 degrees spun on the ground', () => {
    const now = 10;
    const history = spinSamples({ now, totalRadians: 400 * DEG, onGround: true });
    expect(accumulateSpin(history, now).magnitude).toBeGreaterThan(SPIN_360);

    const { flags, score } = evaluateTrickshot(ctx({ now, yawHistory: history }));
    expect(has(flags, TrickshotFlag.Spin360)).toBe(false);
    expect(has(flags, TrickshotFlag.Spin540)).toBe(false);
    expect(has(flags, TrickshotFlag.Spin720)).toBe(false);
    expect(has(flags, TrickshotFlag.Airborne)).toBe(false);
    expect(score).toBe(TRICKSHOT_SCORE.base);
  });

  it('awards 540 and NOT 360 for a 550 degree spin', () => {
    const now = 10;
    const history = spinSamples({ now, totalRadians: 550 * DEG, onGround: false });
    const magnitude = accumulateSpin(history, now).magnitude;
    expect(magnitude).toBeGreaterThan(SPIN_540);
    expect(magnitude).toBeLessThan(SPIN_720);

    const { flags } = evaluateTrickshot(ctx({ now, yawHistory: history }));
    expect(has(flags, TrickshotFlag.Spin540)).toBe(true);
    expect(has(flags, TrickshotFlag.Spin360)).toBe(false);
    expect(has(flags, TrickshotFlag.Spin720)).toBe(false);
  });

  it('awards only 720 for a 760 degree spin', () => {
    const now = 10;
    const { flags, score } = evaluateTrickshot(
      ctx({ now, yawHistory: spinSamples({ now, totalRadians: -760 * DEG, onGround: false }) }),
    );
    expect(has(flags, TrickshotFlag.Spin720)).toBe(true);
    expect(has(flags, TrickshotFlag.Spin540)).toBe(false);
    expect(has(flags, TrickshotFlag.Spin360)).toBe(false);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.spin720);
  });

  it('counts a spin that began in the air and ended on the ground', () => {
    const now = 10;
    const air = spinSamples({
      now: now - 0.5,
      duration: 0.5,
      totalRadians: SPIN_360,
      onGround: false,
    });
    const land = spinSamples({
      now,
      duration: 0.5,
      totalRadians: 0.2,
      startYaw: air[air.length - 1].yaw,
      onGround: true,
    });
    const { flags } = evaluateTrickshot(
      ctx({ now, yawHistory: [...air, ...land], wasAirborne: false }),
    );
    expect(has(flags, TrickshotFlag.Spin360)).toBe(true);
    // Landed before firing, so no airborne bonus on top.
    expect(has(flags, TrickshotFlag.Airborne)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scope discipline
// ---------------------------------------------------------------------------

describe('quickscope and no-scope', () => {
  it('flags a shot fired 0.1s after accuracy lock', () => {
    const { flags, score } = evaluateTrickshot(
      ctx({ adsState: AdsState.Scoped, timeSinceAccuracyLock: 0.1 }),
    );
    expect(has(flags, TrickshotFlag.Quickscope)).toBe(true);
    expect(has(flags, TrickshotFlag.Noscope)).toBe(false);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.quickscope);
  });

  it('does not flag the same shot fired 3s after lock — that is camping', () => {
    const { flags, score } = evaluateTrickshot(
      ctx({ adsState: AdsState.Scoped, timeSinceAccuracyLock: 3 }),
    );
    expect(has(flags, TrickshotFlag.Quickscope)).toBe(false);
    expect(score).toBe(TRICKSHOT_SCORE.base);
  });

  it('respects the window boundary exactly', () => {
    const inside = evaluateTrickshot(
      ctx({ timeSinceAccuracyLock: QUICKSCOPE_WINDOW }),
    ).flags;
    const outside = evaluateTrickshot(
      ctx({ timeSinceAccuracyLock: QUICKSCOPE_WINDOW + 0.01 }),
    ).flags;
    expect(has(inside, TrickshotFlag.Quickscope)).toBe(true);
    expect(has(outside, TrickshotFlag.Quickscope)).toBe(false);
  });

  it('never quickscopes when the lock was never crossed', () => {
    const { flags } = evaluateTrickshot(
      ctx({ adsState: AdsState.Raising, timeSinceAccuracyLock: Number.POSITIVE_INFINITY }),
    );
    expect(has(flags, TrickshotFlag.Quickscope)).toBe(false);
  });

  it('flags a hip shot as a no-scope and never also a quickscope', () => {
    const { flags, score } = evaluateTrickshot(
      // Even with a freshly crossed lock in the context, hip wins.
      ctx({ adsState: AdsState.Hip, adsProgress: 0, timeSinceAccuracyLock: 0.02 }),
    );
    expect(has(flags, TrickshotFlag.Noscope)).toBe(true);
    expect(has(flags, TrickshotFlag.Quickscope)).toBe(false);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.noscope);
  });

  it('gives nothing for a shot fired while lowering the scope', () => {
    const { flags } = evaluateTrickshot(
      ctx({ adsState: AdsState.Lowering, timeSinceAccuracyLock: 0.05 }),
    );
    expect(has(flags, TrickshotFlag.Noscope)).toBe(false);
    expect(has(flags, TrickshotFlag.Quickscope)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Collateral, distance, body english
// ---------------------------------------------------------------------------

describe('collateral', () => {
  it('flags two victims from one bullet and pays one extra kill', () => {
    const { flags, score } = evaluateTrickshot(
      ctx({
        victims: [
          { id: 2, part: HitboxPart.Chest, distance: 12 },
          { id: 3, part: HitboxPart.Chest, distance: 13 },
        ],
      }),
    );
    expect(has(flags, TrickshotFlag.Collateral)).toBe(true);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.collateralPerExtraKill);
  });

  it('pays per extra kill on a triple', () => {
    const { score } = evaluateTrickshot(
      ctx({
        victims: [
          { id: 2, part: HitboxPart.Chest, distance: 12 },
          { id: 3, part: HitboxPart.Chest, distance: 13 },
          { id: 4, part: HitboxPart.Chest, distance: 14 },
        ],
      }),
    );
    expect(score).toBe(TRICKSHOT_SCORE.base + 2 * TRICKSHOT_SCORE.collateralPerExtraKill);
  });

  it('does not flag a single victim', () => {
    const { flags } = evaluateTrickshot(ctx());
    expect(has(flags, TrickshotFlag.Collateral)).toBe(false);
  });
});

describe('distance and hitbox', () => {
  it('flags cross-map at exactly CROSSMAP_DISTANCE but not below', () => {
    const at = evaluateTrickshot(
      ctx({ victims: [{ id: 2, part: HitboxPart.Chest, distance: CROSSMAP_DISTANCE }] }),
    ).flags;
    const below = evaluateTrickshot(
      ctx({ victims: [{ id: 2, part: HitboxPart.Chest, distance: CROSSMAP_DISTANCE - 0.1 }] }),
    ).flags;
    expect(has(at, TrickshotFlag.Crossmap)).toBe(true);
    expect(has(below, TrickshotFlag.Crossmap)).toBe(false);
  });

  it('flags cross-map if ANY victim of a collateral is far enough', () => {
    const { flags } = evaluateTrickshot(
      ctx({
        victims: [
          { id: 2, part: HitboxPart.Chest, distance: 5 },
          { id: 3, part: HitboxPart.Chest, distance: 60 },
        ],
      }),
    );
    expect(has(flags, TrickshotFlag.Crossmap)).toBe(true);
  });

  it('flags a headshot', () => {
    const { flags, score } = evaluateTrickshot(
      ctx({ victims: [{ id: 2, part: HitboxPart.Head, distance: 8 }] }),
    );
    expect(has(flags, TrickshotFlag.Headshot)).toBe(true);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.headshot);
  });
});

describe('body english', () => {
  it('flags airborne when the shooter was off the ground', () => {
    const { flags, score } = evaluateTrickshot(ctx({ wasAirborne: true }));
    expect(has(flags, TrickshotFlag.Airborne)).toBe(true);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.airborne);
  });

  it('flags a jumpshot from jumpedRecently', () => {
    const { flags } = evaluateTrickshot(ctx({ jumpedRecently: true }));
    expect(has(flags, TrickshotFlag.Jumpshot)).toBe(true);
  });

  it('flags a dropshot from prone at fire', () => {
    const { flags, score } = evaluateTrickshot(ctx({ stanceAtFire: Stance.Prone }));
    expect(has(flags, TrickshotFlag.Dropshot)).toBe(true);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.dropshot);
  });

  it('flags a dropshot mid prone transition', () => {
    const { flags } = evaluateTrickshot(
      ctx({ stanceAtFire: Stance.Stand, proneTransition: true }),
    );
    expect(has(flags, TrickshotFlag.Dropshot)).toBe(true);
  });

  it('does not flag a dropshot from a slide', () => {
    const { flags } = evaluateTrickshot(ctx({ stanceAtFire: Stance.Slide }));
    expect(has(flags, TrickshotFlag.Dropshot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

describe('feed', () => {
  it('sets Feed for three kills spanning 11 seconds', () => {
    const now = 11;
    const { flags, score } = evaluateTrickshot(ctx({ now, recentKillTimes: [0, 5.5] }));
    expect(countFeedKills([0, 5.5], now)).toBe(3);
    expect(has(flags, TrickshotFlag.Feed)).toBe(true);
    expect(score).toBe(TRICKSHOT_SCORE.base + TRICKSHOT_SCORE.feed);
  });

  it('does not set Feed for three kills spanning 13 seconds', () => {
    const now = 13;
    const { flags } = evaluateTrickshot(ctx({ now, recentKillTimes: [0, 6.5] }));
    expect(countFeedKills([0, 6.5], now)).toBe(2);
    expect(has(flags, TrickshotFlag.Feed)).toBe(false);
  });

  it('counts the current kill exactly once however the caller reports it', () => {
    const now = 20;
    const excludingSelf = [now - 2, now - 4];
    const includingSelf = [now - 4, now - 2, now];
    expect(countFeedKills(excludingSelf, now)).toBe(3);
    expect(countFeedKills(includingSelf, now)).toBe(3);
  });

  it('drops kills that fell out of the window', () => {
    const now = 100;
    expect(countFeedKills([now - FEED_WINDOW - 0.01, now - 1], now)).toBe(2);
    expect(countFeedKills([now - FEED_WINDOW + 0.01, now - 1], now)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The money shot
// ---------------------------------------------------------------------------

describe('combined scoring', () => {
  it('scores a cross-map 360 no-scope headshot collateral of 2 by hand', () => {
    const now = 42;
    // Jumped, spun 360 in the air, landed, fired from the hip through two
    // heads at range. Airborne/jumpshot deliberately absent: the shooter is
    // back on the ground at the moment of the shot.
    const { flags, score } = evaluateTrickshot(
      ctx({
        now,
        adsState: AdsState.Hip,
        adsProgress: 0,
        timeSinceAccuracyLock: Number.POSITIVE_INFINITY,
        yawHistory: spinSamples({ now, totalRadians: SPIN_360 + 0.2, onGround: false }),
        wasAirborne: false,
        jumpedRecently: false,
        stanceAtFire: Stance.Stand,
        recentKillTimes: [],
        victims: [
          { id: 2, part: HitboxPart.Head, distance: 61.4 },
          { id: 3, part: HitboxPart.Head, distance: 62.0 },
        ],
      }),
    );

    expect(has(flags, TrickshotFlag.Crossmap)).toBe(true);
    expect(has(flags, TrickshotFlag.Spin360)).toBe(true);
    expect(has(flags, TrickshotFlag.Noscope)).toBe(true);
    expect(has(flags, TrickshotFlag.Headshot)).toBe(true);
    expect(has(flags, TrickshotFlag.Collateral)).toBe(true);
    expect(has(flags, TrickshotFlag.Airborne)).toBe(false);
    expect(has(flags, TrickshotFlag.Quickscope)).toBe(false);
    expect(has(flags, TrickshotFlag.Feed)).toBe(false);

    // 100 base + 200 cross-map + 300 spin360 + 150 no-scope + 50 headshot
    // + 250 collateral (1 extra kill) = 1050.
    const byHand =
      TRICKSHOT_SCORE.base +
      TRICKSHOT_SCORE.crossmap +
      TRICKSHOT_SCORE.spin360 +
      TRICKSHOT_SCORE.noscope +
      TRICKSHOT_SCORE.headshot +
      TRICKSHOT_SCORE.collateralPerExtraKill * 1;
    expect(byHand).toBe(1050);
    expect(score).toBe(1050);
  });

  it('scores a plain kill as base only', () => {
    const { flags, score } = evaluateTrickshot(ctx());
    expect(flags).toBe(0);
    expect(score).toBe(TRICKSHOT_SCORE.base);
  });

  it('is pure — the same context evaluated twice gives the same answer', () => {
    const c = ctx({ now: 7, wasAirborne: true, jumpedRecently: true });
    const a = evaluateTrickshot(c);
    const b = evaluateTrickshot(c);
    expect(b).toEqual(a);
    expect(c.victims.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

describe('describeTrickshot', () => {
  it('renders the canonical stacked banner', () => {
    const flags = TrickshotFlag.Spin360 | TrickshotFlag.Noscope | TrickshotFlag.Collateral;
    expect(describeTrickshot(flags)).toBe('360 NO-SCOPE COLLATERAL');
  });

  it('leads with cross-map and keeps the spin tier next', () => {
    const flags =
      TrickshotFlag.Crossmap |
      TrickshotFlag.Spin540 |
      TrickshotFlag.Noscope |
      TrickshotFlag.Headshot |
      TrickshotFlag.Collateral |
      TrickshotFlag.Feed;
    expect(describeTrickshot(flags)).toBe('CROSS-MAP 540 NO-SCOPE HEADSHOT COLLATERAL FEED');
  });

  it('names quickscopes and drop-shots', () => {
    expect(describeTrickshot(TrickshotFlag.Quickscope)).toBe('QUICKSCOPE');
    expect(describeTrickshot(TrickshotFlag.Dropshot | TrickshotFlag.Quickscope)).toBe(
      'DROP-SHOT QUICKSCOPE',
    );
  });

  it('suppresses AIRBORNE when a spin or jumpshot already implies it', () => {
    expect(describeTrickshot(TrickshotFlag.Airborne | TrickshotFlag.Noscope)).toBe(
      'AIRBORNE NO-SCOPE',
    );
    expect(
      describeTrickshot(TrickshotFlag.Airborne | TrickshotFlag.Spin360 | TrickshotFlag.Noscope),
    ).toBe('360 NO-SCOPE');
    expect(describeTrickshot(TrickshotFlag.Airborne | TrickshotFlag.Jumpshot)).toBe('JUMP-SHOT');
  });

  it('returns an empty string for a plain kill', () => {
    expect(describeTrickshot(0)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ScoreKeeper
// ---------------------------------------------------------------------------

describe('ScoreKeeper', () => {
  function ffa(): ScoreKeeper {
    const sk = new ScoreKeeper(GameMode.SnipersOnlyFFA, 30, 600);
    sk.startMatch(0);
    sk.addPlayer(1, TeamId.FFA);
    sk.addPlayer(2, TeamId.FFA);
    sk.addPlayer(3, TeamId.FFA);
    return sk;
  }

  it('records a scoring kill and returns a populated KillMsg', () => {
    const sk = ffa();
    const msg = sk.onKill(1, 2, {
      shooter: playerState({ id: 1, position: vec3(3, 1, -4), adsState: AdsState.Hip }),
      adsState: AdsState.Hip,
      victims: [{ id: 2, part: HitboxPart.Head, distance: 50 }],
      now: 5,
    });

    expect(msg.killerId).toBe(1);
    expect(msg.victimId).toBe(2);
    expect(msg.weapon).toBe(WeaponId.Talon);
    expect(msg.part).toBe(HitboxPart.Head);
    expect(msg.distance).toBe(50);
    expect(msg.collateralCount).toBe(1);
    expect(msg.suppressed).toBe(false);
    expect(msg.killerPosition).toEqual({ x: 3, y: 1, z: -4 });
    expect(has(msg.trickshot, TrickshotFlag.Noscope)).toBe(true);
    expect(has(msg.trickshot, TrickshotFlag.Crossmap)).toBe(true);
    expect(has(msg.trickshot, TrickshotFlag.Headshot)).toBe(true);
    expect(msg.score).toBe(
      TRICKSHOT_SCORE.base +
        TRICKSHOT_SCORE.noscope +
        TRICKSHOT_SCORE.crossmap +
        TRICKSHOT_SCORE.headshot,
    );

    expect(sk.statsFor(1)).toEqual({ score: msg.score, kills: 1, deaths: 0, streak: 1 });
    expect(sk.statsFor(2)).toEqual({ score: 0, kills: 0, deaths: 1, streak: 0 });
  });

  it('treats a suicide as a death with no score, no flags and a broken streak', () => {
    const sk = ffa();
    sk.onKill(1, 2, { victims: [{ id: 2, part: HitboxPart.Chest, distance: 4 }], now: 1 });
    sk.onKill(1, 3, { victims: [{ id: 3, part: HitboxPart.Chest, distance: 4 }], now: 2 });
    expect(sk.statsFor(1)!.streak).toBe(2);
    const scoreBefore = sk.statsFor(1)!.score;

    const msg = sk.onKill(1, 1, { now: 3 });
    expect(msg.trickshot).toBe(0);
    expect(msg.score).toBe(0);
    expect(msg.collateralCount).toBe(0);

    const stats = sk.statsFor(1)!;
    expect(stats.deaths).toBe(1);
    expect(stats.streak).toBe(0);
    expect(stats.kills).toBe(2);
    expect(stats.score).toBe(scoreBefore);
  });

  it('treats an out-of-bounds death (killerId 0) the same way', () => {
    const sk = ffa();
    const msg = sk.onKill(0, 2, { now: 4 });
    expect(msg.trickshot).toBe(0);
    expect(msg.score).toBe(0);
    expect(sk.statsFor(2)).toEqual({ score: 0, kills: 0, deaths: 1, streak: 0 });
  });

  it('never awards trickshot flags to a suicide, however stylish', () => {
    const sk = ffa();
    const now = 9;
    const msg = sk.onKill(2, 2, {
      shooter: playerState({ id: 2, onGround: false }),
      adsState: AdsState.Hip,
      yawHistory: spinSamples({ now, totalRadians: SPIN_720, onGround: false }),
      wasAirborne: true,
      jumpedRecently: true,
      victims: [{ id: 2, part: HitboxPart.Head, distance: 90 }],
      now,
    });
    expect(msg.trickshot).toBe(0);
    expect(msg.score).toBe(0);
  });

  it('credits every victim of a collateral', () => {
    const sk = ffa();
    const msg = sk.onKill(1, 2, {
      victims: [
        { id: 2, part: HitboxPart.Chest, distance: 20 },
        { id: 3, part: HitboxPart.Chest, distance: 21 },
      ],
      now: 6,
    });
    expect(msg.collateralCount).toBe(2);
    expect(has(msg.trickshot, TrickshotFlag.Collateral)).toBe(true);
    expect(sk.statsFor(1)!.kills).toBe(2);
    expect(sk.statsFor(1)!.streak).toBe(2);
    expect(sk.statsFor(2)!.deaths).toBe(1);
    expect(sk.statsFor(3)!.deaths).toBe(1);
  });

  it('accumulates feed across separate kills using its own clock', () => {
    const sk = ffa();
    const v = (id: number) => [{ id, part: HitboxPart.Chest, distance: 5 }];
    const a = sk.onKill(1, 2, { victims: v(2), now: 0 });
    const b = sk.onKill(1, 3, { victims: v(3), now: 5.5 });
    const c = sk.onKill(1, 2, { victims: v(2), now: 11 });
    expect(has(a.trickshot, TrickshotFlag.Feed)).toBe(false);
    expect(has(b.trickshot, TrickshotFlag.Feed)).toBe(false);
    expect(has(c.trickshot, TrickshotFlag.Feed)).toBe(true);
  });

  it('bounds the yaw ring buffer and keeps the newest samples', () => {
    const sk = ffa();
    for (let i = 0; i < 5000; i++) sk.recordYaw(1, i / TICK_RATE, wrapAngle(i * 0.1), true);
    const history = sk.yawHistory(1);
    expect(history.length).toBe(YAW_HISTORY_SIZE);
    expect(YAW_HISTORY_SIZE).toBeGreaterThanOrEqual(SPIN_LOOKBACK * TICK_RATE);
    expect(YAW_HISTORY_SIZE).toBeLessThan(2 * SPIN_LOOKBACK * TICK_RATE);
    // Ascending, ending at the last sample written.
    expect(history[history.length - 1].t).toBeCloseTo(4999 / TICK_RATE, 9);
    for (let i = 1; i < history.length; i++) {
      expect(history[i].t).toBeGreaterThan(history[i - 1].t);
    }
  });

  it('detects a spin from recorded yaw alone', () => {
    const sk = ffa();
    const steps = 90;
    for (let i = 0; i < steps; i++) {
      const t = i / TICK_RATE;
      sk.recordYaw(1, t, wrapAngle(2.9 + (i / (steps - 1)) * (400 * DEG)), false);
    }
    const now = (steps - 1) / TICK_RATE;
    const msg = sk.onKill(1, 2, {
      victims: [{ id: 2, part: HitboxPart.Chest, distance: 10 }],
      now,
    });
    expect(has(msg.trickshot, TrickshotFlag.Spin360)).toBe(true);
    // No ground->air transition was ever observed, so no jumpshot is inferred.
    expect(has(msg.trickshot, TrickshotFlag.Jumpshot)).toBe(false);
  });

  it('infers a jumpshot from the ground contact recorded in the ring buffer', () => {
    const sk = ffa();
    // 1.0s on the ground, then a takeoff 0.2s before the shot.
    for (let i = 0; i < 60; i++) sk.recordYaw(1, i / TICK_RATE, 0.4, true);
    for (let i = 60; i < 72; i++) sk.recordYaw(1, i / TICK_RATE, 0.4, false);
    const now = 71 / TICK_RATE;
    const msg = sk.onKill(1, 2, {
      victims: [{ id: 2, part: HitboxPart.Chest, distance: 10 }],
      now,
    });
    expect(has(msg.trickshot, TrickshotFlag.Jumpshot)).toBe(true);
    expect(has(msg.trickshot, TrickshotFlag.Spin360)).toBe(false);
  });

  it('does not infer a jumpshot from a takeoff a second ago', () => {
    const sk = ffa();
    for (let i = 0; i < 30; i++) sk.recordYaw(1, i / TICK_RATE, 0.4, true);
    for (let i = 30; i < 90; i++) sk.recordYaw(1, i / TICK_RATE, 0.4, false);
    const now = 89 / TICK_RATE;
    const msg = sk.onKill(1, 2, {
      victims: [{ id: 2, part: HitboxPart.Chest, distance: 10 }],
      now,
    });
    expect(has(msg.trickshot, TrickshotFlag.Jumpshot)).toBe(false);
  });

  it('ends an FFA match on the kill limit and reports the best trickshot', () => {
    const sk = new ScoreKeeper(GameMode.SnipersOnlyFFA, 3, 600);
    sk.startMatch(0);
    sk.addPlayer(1, TeamId.FFA);
    sk.addPlayer(2, TeamId.FFA);
    sk.setName(1, 'ACE');
    sk.setName(2, 'BOB');

    expect(sk.tick(1).ended).toBe(false);

    sk.onKill(1, 2, { victims: [{ id: 2, part: HitboxPart.Chest, distance: 3 }], now: 1 });
    const big = sk.onKill(1, 2, {
      adsState: AdsState.Hip,
      victims: [{ id: 2, part: HitboxPart.Head, distance: 70 }],
      now: 2,
    });
    expect(sk.tick(3).ended).toBe(false);

    sk.onKill(1, 2, { victims: [{ id: 2, part: HitboxPart.Chest, distance: 3 }], now: 4 });
    const res = sk.tick(5);
    expect(res.ended).toBe(true);
    expect(res.result).toBeDefined();

    const over = res.result!;
    expect(over.winnerId).toBe(1);
    expect(over.winnerTeam).toBe(TeamId.FFA);
    expect(over.scoreboard[0].id).toBe(1);
    expect(over.scoreboard[0].name).toBe('ACE');
    expect(over.scoreboard[0].kills).toBe(3);
    expect(over.scoreboard[1].id).toBe(2);
    expect(over.scoreboard[1].deaths).toBe(3);
    expect(over.bestTrickshot).not.toBeNull();
    expect(over.bestTrickshot!.score).toBe(big.score);
    expect(over.scoreboard[0].bestTrickshotScore).toBe(big.score);
    expect(over.scoreboard[0].bestTrickshotFlags).toBe(big.trickshot);

    // Idempotent once ended.
    const again = sk.tick(6);
    expect(again.ended).toBe(true);
    expect(again.result).toEqual(over);
  });

  it('ends on the time limit', () => {
    const sk = new ScoreKeeper(GameMode.SnipersOnlyFFA, 30, 60);
    sk.startMatch(100);
    sk.addPlayer(1, TeamId.FFA);
    expect(sk.tick(159).ended).toBe(false);
    expect(sk.timeRemaining()).toBeCloseTo(1, 9);
    const res = sk.tick(160);
    expect(res.ended).toBe(true);
    expect(res.result!.scoreboard).toHaveLength(1);
  });

  it('tracks team scores and picks a TDM winner', () => {
    const sk = new ScoreKeeper(GameMode.TeamDeathmatch, 2, 600);
    sk.startMatch(0);
    sk.addPlayer(1, TeamId.Alpha);
    sk.addPlayer(2, TeamId.Bravo);
    sk.addPlayer(3, TeamId.Bravo);

    sk.onKill(2, 1, { victims: [{ id: 1, part: HitboxPart.Chest, distance: 6 }], now: 1 });
    expect(sk.teamScores()).toEqual([0, 1]);
    expect(sk.tick(2).ended).toBe(false);

    sk.onKill(3, 1, { victims: [{ id: 1, part: HitboxPart.Chest, distance: 6 }], now: 3 });
    expect(sk.teamScores()).toEqual([0, 2]);

    const res = sk.tick(4);
    expect(res.ended).toBe(true);
    expect(res.result!.winnerTeam).toBe(TeamId.Bravo);
    expect([2, 3]).toContain(res.result!.winnerId);
  });

  it('gives a TDM teamkill a death but no score', () => {
    const sk = new ScoreKeeper(GameMode.TeamDeathmatch, 50, 600);
    sk.startMatch(0);
    sk.addPlayer(1, TeamId.Alpha);
    sk.addPlayer(2, TeamId.Alpha);

    const msg = sk.onKill(1, 2, {
      adsState: AdsState.Hip,
      victims: [{ id: 2, part: HitboxPart.Head, distance: 80 }],
      now: 1,
    });
    expect(msg.trickshot).toBe(0);
    expect(msg.score).toBe(0);
    expect(sk.statsFor(1)).toEqual({ score: 0, kills: 0, deaths: 0, streak: 0 });
    expect(sk.statsFor(2)!.deaths).toBe(1);
    expect(sk.teamScores()).toEqual([0, 0]);
  });

  it('sorts the scoreboard by score, then kills, then deaths, then id', () => {
    const sk = ffa();
    sk.onKill(2, 1, { victims: [{ id: 1, part: HitboxPart.Chest, distance: 3 }], now: 1 });
    sk.onKill(3, 1, {
      adsState: AdsState.Hip,
      victims: [{ id: 1, part: HitboxPart.Head, distance: 90 }],
      now: 2,
    });
    const board = sk.scoreboard();
    expect(board.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(board[0].score).toBeGreaterThan(board[1].score);
  });

  it('keeps a departed player on the final scoreboard', () => {
    const sk = ffa();
    sk.setName(2, 'GHOST');
    sk.onKill(2, 1, { victims: [{ id: 1, part: HitboxPart.Chest, distance: 3 }], now: 1 });
    sk.removePlayer(2);
    expect(sk.has(2)).toBe(false);
    const board = sk.scoreboard();
    expect(board.find((e) => e.id === 2)!.name).toBe('GHOST');
    expect(board.find((e) => e.id === 2)!.kills).toBe(1);
  });

  it('ignores kills and yaw for unknown players without throwing', () => {
    const sk = ffa();
    sk.recordYaw(99, 0, 0, true);
    expect(sk.yawHistory(99)).toEqual([]);
    const msg = sk.onKill(99, 2, { now: 1 });
    expect(msg.score).toBe(0);
    expect(sk.statsFor(2)!.deaths).toBe(1);
  });

  it('falls back to the mode default when given a nonsense score limit', () => {
    const ffaKeeper = new ScoreKeeper(GameMode.SnipersOnlyFFA, 0, 0);
    expect(ffaKeeper.scoreLimit).toBe(30);
    expect(ffaKeeper.timeLimit).toBe(600);
    const tdm = new ScoreKeeper(GameMode.TeamDeathmatch, -1, Number.NaN);
    expect(tdm.scoreLimit).toBe(50);
    expect(tdm.timeLimit).toBe(600);
  });
});
