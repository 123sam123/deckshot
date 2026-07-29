/**
 * DECKSHOT — trickshot modifier detection.
 *
 * Owner: trickshot-scoring.
 *
 * This module is PURE. No time reads, no randomness, no mutation of its
 * inputs, no engine imports. Everything it needs arrives in a
 * `TrickshotContext` assembled by the server (see `server/src/sim/scoring.ts`).
 * That is deliberate: a trickshot is worth hundreds of points, so it must be
 * decided by the authoritative simulation from rewound state, never claimed by
 * a client. The client may call this too — purely to predict the banner — but
 * the server's verdict is the one that reaches the scoreboard.
 */

import { TrickshotFlag } from './protocol.js';
import {
  CROSSMAP_DISTANCE,
  FEED_KILLS,
  FEED_WINDOW,
  QUICKSCOPE_WINDOW,
  SPIN_360,
  SPIN_540,
  SPIN_720,
  SPIN_LOOKBACK,
  TRICKSHOT_SCORE,
} from './tuning.js';
import { AdsState, HitboxPart, Stance } from './types.js';
import type { PlayerId, PlayerState } from './types.js';

/** Float slop for time/angle comparisons at tick granularity. */
const EPS = 1e-9;

/**
 * A jump is "recent" for this many seconds. Lives here rather than in the
 * frozen tuning file, which has no jumpshot constant; see the report.
 */
export const JUMPSHOT_WINDOW = 0.4;

/** One entry in the shooter's rolling yaw history. */
export interface YawSample {
  t: number;
  yaw: number;
  onGround: boolean;
}

/** One player killed by the shot under evaluation. */
export interface TrickshotVictim {
  id: PlayerId;
  part: HitboxPart;
  distance: number;
}

export interface TrickshotContext {
  /** Shooter state at the moment the shot was fired (server-rewound, authoritative). */
  shooter: PlayerState;
  /**
   * Rolling history of the shooter's yaw, newest last, ascending in `t`,
   * covering at least SPIN_LOOKBACK seconds. Samples outside the window are
   * ignored, so passing a longer buffer is harmless.
   */
  yawHistory: YawSample[];
  /**
   * Seconds since the shooter's ADS progress crossed `accuracyLockAt`;
   * Infinity if never.
   *
   * IMPORTANT — this is a RISING-EDGE stopwatch. It is reset to Infinity the
   * moment the player leaves ADS and only restarts when a fresh raise crosses
   * the lock. That is the entire mechanical difference between "flicked the
   * scope in and fired" (value ~0.05) and "held the scope for ten seconds
   * waiting in a corner" (value ~10). Quickscope keys off nothing else; if the
   * producer of this number ever makes it a running "time spent above the
   * lock", camping becomes indistinguishable from flicking and the mode loses
   * its identity.
   */
  timeSinceAccuracyLock: number;
  adsState: AdsState;
  adsProgress: number;
  victims: TrickshotVictim[];
  /**
   * Server times (seconds) of this shooter's recent kills, for feed detection.
   * May or may not contain the kill being evaluated; both conventions work.
   */
  recentKillTimes: number[];
  now: number;
  wasAirborne: boolean;
  stanceAtFire: Stance;
  jumpedRecently: boolean;
  /** Optional: true while the prone transition is still in progress at fire. */
  proneTransition?: boolean;
}

export interface TrickshotResult {
  flags: number;
  score: number;
}

/** Result of walking the yaw history. */
export interface SpinResult {
  /** Signed unwrapped yaw delta over the window, radians. */
  total: number;
  /** |total|. */
  magnitude: number;
  /** True if the shooter left the ground at any point in the window. */
  airborne: boolean;
  /** Number of samples that fell inside the window. */
  samples: number;
}

// ---------------------------------------------------------------------------
// Angle math
// ---------------------------------------------------------------------------

/**
 * Wrap an angle into [-PI, PI). This is the whole ballgame for spin detection:
 * (Exactly +PI maps to -PI; a per-tick delta of exactly PI is directionally
 * ambiguous either way, so the choice of half-open end is arbitrary.)
 * Yaw is stored wrapped, so a player rotating through the -PI/+PI seam
 * produces a raw delta of nearly 2*PI in the wrong direction. Unwrapping each
 * per-tick delta before summing is what makes a 360 read as 2*PI instead of
 * cancelling to ~0.
 */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const TWO_PI = 2 * Math.PI;
  let x = (a + Math.PI) % TWO_PI;
  if (x < 0) x += TWO_PI;
  return x - Math.PI;
}

/**
 * Sum unwrapped yaw deltas over the `lookback` seconds ending at `now`.
 * `history` must be ascending in `t` (newest last). Samples outside the window,
 * in the future, or non-finite are skipped.
 */
export function accumulateSpin(
  history: readonly YawSample[] | undefined,
  now: number,
  lookback: number = SPIN_LOOKBACK,
): SpinResult {
  const start = now - lookback;
  let total = 0;
  let samples = 0;
  let airborne = false;
  let prevYaw = 0;
  let havePrev = false;

  if (history) {
    for (let i = 0; i < history.length; i++) {
      const s = history[i];
      if (!s || !Number.isFinite(s.t) || !Number.isFinite(s.yaw)) continue;
      if (s.t < start - EPS || s.t > now + EPS) continue;
      samples++;
      if (!s.onGround) airborne = true;
      if (havePrev) total += wrapAngle(s.yaw - prevYaw);
      prevYaw = s.yaw;
      havePrev = true;
    }
  }

  return { total, magnitude: Math.abs(total), airborne, samples };
}

/**
 * How many kills the shooter has inside FEED_WINDOW, counting this one.
 * Tolerates `recentKillTimes` either including or excluding the current kill:
 * if no entry sits exactly at `now`, this kill is added.
 */
export function countFeedKills(recentKillTimes: readonly number[] | undefined, now: number): number {
  const start = now - FEED_WINDOW;
  let count = 0;
  let includesThis = false;

  if (recentKillTimes) {
    for (let i = 0; i < recentKillTimes.length; i++) {
      const t = recentKillTimes[i];
      if (!Number.isFinite(t)) continue;
      if (t < start - EPS || t > now + EPS) continue;
      count++;
      if (Math.abs(t - now) <= EPS) includesThis = true;
    }
  }

  if (!includesThis) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Decide which modifiers a kill earned and what it is worth.
 * Pure: same context in, same result out.
 */
export function evaluateTrickshot(ctx: TrickshotContext): TrickshotResult {
  let flags = 0;
  let score: number = TRICKSHOT_SCORE.base;

  const now = Number.isFinite(ctx.now) ? ctx.now : 0;
  const victims: TrickshotVictim[] = [];
  if (ctx.victims) {
    for (let i = 0; i < ctx.victims.length; i++) {
      const v = ctx.victims[i];
      if (v) victims.push(v);
    }
  }

  // --- scope discipline -----------------------------------------------------
  // Exactly one of no-scope / quickscope can apply: a no-scope is by
  // definition fired from the hip, and a quickscope requires being in the
  // scope. They are branches of the same check, never both.
  const adsState = ctx.adsState;
  if (adsState === AdsState.Hip) {
    flags |= TrickshotFlag.Noscope;
    score += TRICKSHOT_SCORE.noscope;
  } else if (adsState === AdsState.Raising || adsState === AdsState.Scoped) {
    const sinceLock = ctx.timeSinceAccuracyLock;
    // Infinity (never locked) and NaN both fail this, as they must.
    if (Number.isFinite(sinceLock) && sinceLock >= -EPS && sinceLock <= QUICKSCOPE_WINDOW + EPS) {
      flags |= TrickshotFlag.Quickscope;
      score += TRICKSHOT_SCORE.quickscope;
    }
  }
  // AdsState.Lowering: coming out of the scope. Neither a no-scope (the scope
  // is still partly up) nor a quickscope. No flag.

  // --- spin -----------------------------------------------------------------
  const spin = accumulateSpin(ctx.yawHistory, now, SPIN_LOOKBACK);
  // A spin only counts if the shooter left the ground during the window.
  // Standing on the spot and whipping the mouse around is not a trickshot.
  const spunInAir = spin.airborne || ctx.wasAirborne === true;
  if (spunInAir) {
    // Highest tier only — never stack 360 with 540.
    if (spin.magnitude >= SPIN_720 - EPS) {
      flags |= TrickshotFlag.Spin720;
      score += TRICKSHOT_SCORE.spin720;
    } else if (spin.magnitude >= SPIN_540 - EPS) {
      flags |= TrickshotFlag.Spin540;
      score += TRICKSHOT_SCORE.spin540;
    } else if (spin.magnitude >= SPIN_360 - EPS) {
      flags |= TrickshotFlag.Spin360;
      score += TRICKSHOT_SCORE.spin360;
    }
  }

  // --- collateral -----------------------------------------------------------
  if (victims.length >= 2) {
    flags |= TrickshotFlag.Collateral;
    score += TRICKSHOT_SCORE.collateralPerExtraKill * (victims.length - 1);
  }

  // --- distance -------------------------------------------------------------
  let crossmap = false;
  let headshot = false;
  for (let i = 0; i < victims.length; i++) {
    const v = victims[i];
    if (Number.isFinite(v.distance) && v.distance >= CROSSMAP_DISTANCE - EPS) crossmap = true;
    if (v.part === HitboxPart.Head) headshot = true;
  }
  if (crossmap) {
    flags |= TrickshotFlag.Crossmap;
    score += TRICKSHOT_SCORE.crossmap;
  }
  if (headshot) {
    flags |= TrickshotFlag.Headshot;
    score += TRICKSHOT_SCORE.headshot;
  }

  // --- body english ---------------------------------------------------------
  const airborne = ctx.wasAirborne === true || (!!ctx.shooter && ctx.shooter.onGround === false);
  if (airborne) {
    flags |= TrickshotFlag.Airborne;
    score += TRICKSHOT_SCORE.airborne;
  }
  if (ctx.jumpedRecently === true) {
    flags |= TrickshotFlag.Jumpshot;
    score += TRICKSHOT_SCORE.jumpshot;
  }
  const proneAtFire =
    ctx.stanceAtFire === Stance.Prone ||
    ctx.proneTransition === true ||
    (!!ctx.shooter && ctx.shooter.stance === Stance.Prone);
  if (proneAtFire) {
    flags |= TrickshotFlag.Dropshot;
    score += TRICKSHOT_SCORE.dropshot;
  }

  // --- feed -----------------------------------------------------------------
  if (countFeedKills(ctx.recentKillTimes, now) >= FEED_KILLS) {
    flags |= TrickshotFlag.Feed;
    score += TRICKSHOT_SCORE.feed;
  }

  return { flags, score };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Canonical banner order. Reads the way a clip title reads:
 * "CROSS-MAP 360 NO-SCOPE HEADSHOT COLLATERAL".
 */
const BANNER_ORDER: Array<[number, string]> = [
  [TrickshotFlag.Crossmap, 'CROSS-MAP'],
  [TrickshotFlag.Spin720, '720'],
  [TrickshotFlag.Spin540, '540'],
  [TrickshotFlag.Spin360, '360'],
  [TrickshotFlag.Airborne, 'AIRBORNE'],
  [TrickshotFlag.Jumpshot, 'JUMP-SHOT'],
  [TrickshotFlag.Dropshot, 'DROP-SHOT'],
  [TrickshotFlag.Noscope, 'NO-SCOPE'],
  [TrickshotFlag.Quickscope, 'QUICKSCOPE'],
  [TrickshotFlag.Headshot, 'HEADSHOT'],
  [TrickshotFlag.Collateral, 'COLLATERAL'],
  [TrickshotFlag.Feed, 'FEED'],
];

/**
 * Human banner for a flag bitfield, e.g. "360 NO-SCOPE COLLATERAL".
 * Returns '' for a plain kill so the HUD can simply skip the banner.
 *
 * AIRBORNE is suppressed when a jumpshot or a spin is already named — both
 * imply air time, and the banner should stay short enough to read in the half
 * second it is on screen.
 */
export function describeTrickshot(flags: number): string {
  if (!flags) return '';
  const spinning =
    (flags & (TrickshotFlag.Spin360 | TrickshotFlag.Spin540 | TrickshotFlag.Spin720)) !== 0;
  const redundantAir = spinning || (flags & TrickshotFlag.Jumpshot) !== 0;

  const parts: string[] = [];
  for (let i = 0; i < BANNER_ORDER.length; i++) {
    const [bit, label] = BANNER_ORDER[i];
    if ((flags & bit) === 0) continue;
    if (bit === TrickshotFlag.Airborne && redundantAir) continue;
    parts.push(label);
  }
  return parts.join(' ');
}

/** Score a flag bitfield on its own, without re-deriving it from a context. */
export function scoreForFlags(flags: number, collateralCount = 0): number {
  let score: number = TRICKSHOT_SCORE.base;
  if (flags & TrickshotFlag.Quickscope) score += TRICKSHOT_SCORE.quickscope;
  if (flags & TrickshotFlag.Noscope) score += TRICKSHOT_SCORE.noscope;
  if (flags & TrickshotFlag.Spin360) score += TRICKSHOT_SCORE.spin360;
  if (flags & TrickshotFlag.Spin540) score += TRICKSHOT_SCORE.spin540;
  if (flags & TrickshotFlag.Spin720) score += TRICKSHOT_SCORE.spin720;
  if (flags & TrickshotFlag.Crossmap) score += TRICKSHOT_SCORE.crossmap;
  if (flags & TrickshotFlag.Airborne) score += TRICKSHOT_SCORE.airborne;
  if (flags & TrickshotFlag.Dropshot) score += TRICKSHOT_SCORE.dropshot;
  if (flags & TrickshotFlag.Jumpshot) score += TRICKSHOT_SCORE.jumpshot;
  if (flags & TrickshotFlag.Feed) score += TRICKSHOT_SCORE.feed;
  if (flags & TrickshotFlag.Headshot) score += TRICKSHOT_SCORE.headshot;
  if (flags & TrickshotFlag.Collateral && collateralCount >= 2) {
    score += TRICKSHOT_SCORE.collateralPerExtraKill * (collateralCount - 1);
  }
  return score;
}
