/**
 * DECKSHOT — authoritative combat.
 *
 * Owner: weapons-hitreg.
 *
 * Everything a bullet does happens here, on the server, from state the server
 * chose. Three rules:
 *
 *  1. THE CLIENT NEVER CLAIMS A HIT. A client sends inputs. It says "I pulled
 *     the trigger on input 4127"; it does not say "I hit player 3 in the head".
 *     Every function in this file takes inputs and states and produces hits.
 *
 *  2. LAG COMPENSATION HAPPENS ELSEWHERE. `fireWeapon` resolves against the
 *     player states it is HANDED. The netcode agent rewinds them to the
 *     shooter's view of the world and passes them in. This module never reaches
 *     for history — that keeps rewinding testable in one place and stops two
 *     subsystems disagreeing about which tick a shot belongs to.
 *
 *  3. ONE BULLET, ONE RESULT. A round that kills three people produces ONE
 *     FireResult listing three victims, because `ScoreKeeper.onKill` must be
 *     called once per bullet. Calling it per victim double-counts kills and
 *     pays the collateral bonus twice.
 */

import {
  MATERIAL_PENETRATION,
  type Brush,
  type SurfaceMaterial,
} from '../../../shared/mapdata.js';
import {
  createCollisionWorld,
  raycastWorldAll,
  raycastWorldAllIn,
  type CollisionWorld,
} from '../../../shared/collision.js';
import { viewDirection } from '../../../shared/movement.js';
import { rayVsPlayer } from '../../../shared/hitbox.js';
import { makeShotRng } from '../../../shared/rng.js';
import { CorrectionReason, type HitMsg } from '../../../shared/protocol.js';
import type { TrickshotContext, TrickshotVictim } from '../../../shared/trickshot.js';
import {
  HEALTH_REGEN_DELAY,
  HEALTH_REGEN_RATE,
  MAX_HEALTH,
  MELEE_DAMAGE,
  MELEE_RANGE,
  TICK_DT,
  eyeHeightForStance,
} from '../../../shared/tuning.js';
import {
  WeaponAction,
  applySpread,
  canFire,
  isAiming,
  spreadForShot,
  type ResolvedWeapon,
  type WeaponRuntime,
} from '../../../shared/weapons.js';
import { AdsState, HitboxPart, Stance, WeaponId, vec3 } from '../../../shared/types.js';
import type { ClientInput, PlayerId, PlayerState, Vec3 } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Constants owned by this module
// ---------------------------------------------------------------------------

/** Furthest a hitscan round is traced, meters. The map is 62m end to end. */
export const MAX_SHOT_RANGE = 300;

/**
 * Fire-rate slack, seconds. A client's tick clock drifts against the server's
 * and inputs arrive in bursts, so a shot may legitimately land a tick or two
 * early. Two ticks is far too little to double a weapon's rate of fire and far
 * more than honest jitter needs.
 */
export const FIRE_RATE_TOLERANCE = TICK_DT * 2;

/** Slop on ADS progress when validating a client's claimed aim state. */
const ADS_CLAIM_TOLERANCE = 0.2;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One player struck by one bullet. */
export interface ShotHit {
  victimId: PlayerId;
  part: HitboxPart;
  /** Damage actually applied, after penetration falloff. */
  damage: number;
  /** Meters from the shooter's eye. */
  distance: number;
  killed: boolean;
  /** True when the round passed through at least one surface before landing. */
  penetrated: boolean;
  point: Vec3;
  normal: Vec3;
  /** Victim health after the hit. */
  healthAfter: number;
}

/** One surface the round touched, for decals, impact particles and audio. */
export interface SurfaceImpact {
  point: Vec3;
  normal: Vec3;
  brushId: string;
  material: SurfaceMaterial;
  /** True when the round continued through this surface. */
  penetrated: boolean;
}

export interface FireResult {
  /** False when nothing happened — either rejected, or the trigger was not pulled. */
  fired: boolean;
  /** Non-null only when the shot was rejected by validation. */
  reason: CorrectionReason | null;
  origin: Vec3;
  /** Post-spread unit direction actually traced. */
  direction: Vec3;
  /** Cone half-angle used, radians. 0 means the shot was accuracy-locked. */
  spread: number;
  hits: ShotHit[];
  /** Ready-to-broadcast HitMsg per victim. */
  hitMessages: HitMsg[];
  /** Players KILLED by this bullet, in the order the round reached them. */
  victims: TrickshotVictim[];
  impacts: SurfaceImpact[];
  /**
   * Everything `ScoreKeeper.onKill` wants that only this module knows.
   * Pass it straight through: `keeper.onKill(shooterId, victims[0].id, ctx)`.
   */
  context: Partial<TrickshotContext>;
}

function emptyResult(reason: CorrectionReason | null, origin: Vec3, dir: Vec3): FireResult {
  return {
    fired: false,
    reason,
    origin,
    direction: dir,
    spread: 0,
    hits: [],
    hitMessages: [],
    victims: [],
    impacts: [],
    context: {},
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface FireRequest {
  /** Authoritative shooter state at the tick of the shot. */
  shooter: PlayerState;
  /** The shooter's server-side weapon runtime, already advanced for this tick. */
  runtime: WeaponRuntime;
  resolved: ResolvedWeapon;
  /** The input that carried the trigger pull. Seeds the spread RNG. */
  input: ClientInput;
  /**
   * LAG-COMPENSATED states of every other player, rewound by the netcode layer
   * to the shooter's view of the world. The shooter's own entry is ignored.
   */
  targets: readonly PlayerState[];
  /** Server time, SECONDS. Used for regen bookkeeping and the trickshot context. */
  now: number;
  /**
   * Optional: the ADS state the client believed it was in. When supplied and it
   * disagrees with the server's runtime, the shot is rejected — a client that
   * lies about being scoped is trying to convert a hipfire into a pinpoint shot.
   */
  claimedAdsState?: AdsState;
  claimedAdsProgress?: number;
  /**
   * Static geometry the round traces against. Absent = the Sundeck singleton,
   * exactly as before; SURVIVAL rooms pass their own map's world.
   */
  world?: CollisionWorld;
}

export interface MeleeRequest {
  attacker: PlayerState;
  runtime: WeaponRuntime;
  targets: readonly PlayerState[];
  now: number;
}

// ---------------------------------------------------------------------------
// Per-player combat bookkeeping
// ---------------------------------------------------------------------------

interface CombatRecord {
  /** Server seconds of the last damage taken. Drives regeneration delay. */
  lastDamagedAt: number;
  /** Server seconds of the last shot fired. Drives the fire-rate check. */
  lastFireAt: number;
  /** Who hurt this player last, for assist/killcam bookkeeping by the caller. */
  lastAttacker: PlayerId;
  /** Rejected-shot counter; a caller may use it to escalate to a kick. */
  rejections: number;
}

function newRecord(): CombatRecord {
  return {
    lastDamagedAt: Number.NEGATIVE_INFINITY,
    lastFireAt: Number.NEGATIVE_INFINITY,
    lastAttacker: 0,
    rejections: 0,
  };
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/** Where the round leaves the gun. Eye height, not muzzle: the camera aims. */
export function shotOrigin(state: PlayerState, out: Vec3): Vec3 {
  out.x = state.position.x;
  out.y = state.position.y + eyeHeightForStance(state.stance);
  out.z = state.position.z;
  return out;
}

interface TraceEvent {
  t: number;
  /** null for a player hit. */
  brush: Brush | null;
  point: Vec3;
  normal: Vec3;
  target: PlayerState | null;
  part: HitboxPart;
}

/**
 * Walk one bullet through the world and every candidate player, near to far.
 *
 * PENETRATION. On reaching a brush:
 *   - not `penetrable`, or no penetrations left  -> the round STOPS. Full stop:
 *     FMJ cannot punch a hole in the hull.
 *   - otherwise the round continues and every subsequent hit is scaled by
 *     `MATERIAL_PENETRATION[material] * weapon.penetrationDamage`, which
 *     compounds across surfaces. Talon (0.65) through the catwalk rail (Metal,
 *     0.5) delivers 32.5% of its damage; with FMJ (0.9) it delivers 45%.
 *
 * COLLATERALS. Hitting a player never stops the round. That is the entire point:
 * the bullet keeps going through the first victim and can kill everyone lined up
 * behind them, and all of them come back from ONE call.
 */
function traceShot(
  origin: Vec3,
  dir: Vec3,
  shooterId: PlayerId,
  targets: readonly PlayerState[],
  rw: ResolvedWeapon,
  maxRange: number,
  world: CollisionWorld = createCollisionWorld(),
): { events: TraceEvent[]; damageScale: number[]; penetratedAt: boolean[] } {
  const events: TraceEvent[] = [];

  // World: only ever need the nearest (penetrationCount + 1) surfaces — the
  // round cannot survive more than that many.
  const worldHits = raycastWorldAllIn(world, origin, dir, maxRange, Math.max(1, rw.penetrationCount + 1));
  for (let i = 0; i < worldHits.length; i++) {
    const h = worldHits[i];
    events.push({ t: h.t, brush: h.brush, point: h.point, normal: h.normal, target: null, part: HitboxPart.Chest });
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (!target || target.id === shooterId) continue;
    if (!target.alive) continue;
    const hit = rayVsPlayer(origin, dir, target, maxRange);
    if (!hit) continue;
    events.push({
      t: hit.t,
      brush: null,
      point: {
        x: origin.x + dir.x * hit.t,
        y: origin.y + dir.y * hit.t,
        z: origin.z + dir.z * hit.t,
      },
      normal: { x: -dir.x, y: -dir.y, z: -dir.z },
      target,
      part: hit.part,
    });
  }

  // Near to far. Ties break world-first so a player standing flush against a
  // wall cannot be hit "through" it by a floating-point coincidence.
  events.sort((a, b) => (a.t !== b.t ? a.t - b.t : (a.brush ? 0 : 1) - (b.brush ? 0 : 1)));

  const damageScale: number[] = [];
  const penetratedAt: boolean[] = [];
  let scale = 1;
  let used = 0;
  let anyPenetration = false;
  let stopAt = events.length;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    damageScale.push(scale);
    penetratedAt.push(anyPenetration);
    if (!e.brush) continue;

    if (!e.brush.penetrable || used >= rw.penetrationCount) {
      stopAt = i + 1; // include the surface itself, as an impact
      break;
    }
    used++;
    anyPenetration = true;
    scale *= MATERIAL_PENETRATION[e.brush.material] * rw.penetrationDamage;
    if (!(scale > 0)) {
      stopAt = i + 1;
      break;
    }
  }

  events.length = Math.min(events.length, stopAt);
  damageScale.length = events.length;
  penetratedAt.length = events.length;
  return { events, damageScale, penetratedAt };
}

// ---------------------------------------------------------------------------
// The combat system
// ---------------------------------------------------------------------------

export class CombatSystem {
  private records = new Map<PlayerId, CombatRecord>();

  private record(id: PlayerId): CombatRecord {
    let r = this.records.get(id);
    if (!r) {
      r = newRecord();
      this.records.set(id, r);
    }
    return r;
  }

  removePlayer(id: PlayerId): void {
    this.records.delete(id);
  }

  /** Clear a player's combat bookkeeping on (re)spawn. */
  onSpawn(state: PlayerState, now: number): void {
    const r = this.record(state.id);
    r.lastDamagedAt = now;
    r.lastFireAt = Number.NEGATIVE_INFINITY;
    r.lastAttacker = 0;
    state.health = MAX_HEALTH;
    state.alive = true;
  }

  /** Who last damaged this player. 0 when nobody has. */
  lastAttacker(id: PlayerId): PlayerId {
    return this.record(id).lastAttacker;
  }

  /** How many shots this player has had rejected. An anti-cheat escalation hook. */
  rejectionCount(id: PlayerId): number {
    return this.record(id).rejections;
  }

  // -------------------------------------------------------------------------
  // Validation — the anti-cheat floor
  // -------------------------------------------------------------------------

  /**
   * Everything that must be true before a trigger pull becomes a bullet.
   * Returns the rejection reason, or null when the shot is legitimate.
   *
   * This is a FLOOR, not a proof of innocence: it stops the cheap attacks
   * (rate-of-fire hacks, firing while dead, firing with an empty magazine,
   * firing mid-reload, claiming to be scoped while hipfiring) using only
   * server-owned state.
   *
   * The runtime may be passed from EITHER SIDE of the trigger pull:
   *   - after `advanceWeapon` consumed it (`firedThisTick` is set, the round is
   *     already spent and the bolt is cycling) — the normal server flow;
   *   - before it, in which case `canFire` must hold.
   * Anything else is a client asserting a shot the server's own state machine
   * never produced, and is rejected.
   *
   * Every rejection is `IllegalFire`; `RateLimited` is reserved for the
   * connection-level limiter in the net layer, which is a different problem.
   */
  validateFire(req: FireRequest): CorrectionReason | null {
    const { shooter, runtime, resolved, now } = req;

    if (!shooter || !shooter.alive) return CorrectionReason.IllegalFire;
    if (resolved.magSize <= 0) return CorrectionReason.IllegalFire;
    if (runtime.action !== WeaponAction.Idle && runtime.action !== WeaponAction.Cycling) {
      // Reloading, swapping, or mid-melee. The gun is not pointing anywhere.
      return CorrectionReason.IllegalFire;
    }
    if (!runtime.firedThisTick) {
      if (runtime.ammoInMag <= 0) return CorrectionReason.IllegalFire;
      if (!canFire(runtime, resolved)) return CorrectionReason.IllegalFire;
    }

    const rec = this.record(shooter.id);
    if (now - rec.lastFireAt < resolved.cycleTime - FIRE_RATE_TOLERANCE) {
      return CorrectionReason.IllegalFire;
    }

    // The client may tell us what it thought its sights were doing. If it
    // disagrees with the authoritative runtime, it does not get the benefit.
    if (req.claimedAdsState !== undefined) {
      const claimedAiming =
        req.claimedAdsState === AdsState.Raising || req.claimedAdsState === AdsState.Scoped;
      if (claimedAiming !== isAiming(runtime)) return CorrectionReason.IllegalFire;
    }
    if (req.claimedAdsProgress !== undefined) {
      const d = req.claimedAdsProgress - runtime.adsProgress;
      if (d > ADS_CLAIM_TOLERANCE || d < -ADS_CLAIM_TOLERANCE) return CorrectionReason.IllegalFire;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  /**
   * Resolve one trigger pull.
   *
   * Call this on the tick `advanceWeapon` reported `firedThisTick` — the
   * runtime has already spent the round and started the bolt cycle, and this
   * function decides what that round did.
   *
   * The returned `context` is a `Partial<TrickshotContext>` carrying everything
   * the scoring module cannot see for itself: `timeSinceAccuracyLock` (the
   * rising-edge stopwatch — the quickscope/camp discriminator), `adsState`,
   * `adsProgress`, `wasAirborne`, `stanceAtFire`, and per-victim `distance` and
   * `part`. Hand it to `ScoreKeeper.onKill` unchanged.
   */
  fireWeapon(req: FireRequest): FireResult {
    const { shooter, runtime, resolved, input, targets, now } = req;

    const origin = vec3();
    shotOrigin(shooter, origin);
    const aim = vec3();
    viewDirection(shooter.yaw, shooter.pitch, aim);

    const reason = this.validateFire(req);
    if (reason !== null) {
      this.record(shooter.id).rejections++;
      return emptyResult(reason, origin, aim);
    }

    const rec = this.record(shooter.id);
    rec.lastFireAt = now;

    // Spread. Seeded from (shooterId, inputSeq) so the client's prediction of
    // this exact bullet used the exact same cone sample.
    const spread = spreadForShot(runtime, resolved, shooter);
    const rng = makeShotRng(shooter.id, input.seq);
    const dir = vec3();
    applySpread(aim, spread, rng, dir);

    const { events, damageScale, penetratedAt } = traceShot(
      origin,
      dir,
      shooter.id,
      targets,
      resolved,
      MAX_SHOT_RANGE,
      req.world,
    );

    const hits: ShotHit[] = [];
    const hitMessages: HitMsg[] = [];
    const victims: TrickshotVictim[] = [];
    const impacts: SurfaceImpact[] = [];
    const struck = new Set<PlayerId>();

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.brush) {
        impacts.push({
          point: e.point,
          normal: e.normal,
          brushId: e.brush.id,
          material: e.brush.material,
          penetrated: i + 1 < events.length,
        });
        continue;
      }

      const victim = e.target;
      if (!victim) continue;
      // One bullet cannot hit the same player twice, however the capsules
      // overlap.
      if (struck.has(victim.id)) continue;
      struck.add(victim.id);

      const damage = resolved.damage[e.part] * damageScale[i];
      const killed = this.applyDamage(victim, damage, shooter.id, now);

      hits.push({
        victimId: victim.id,
        part: e.part,
        damage,
        distance: e.t,
        killed,
        penetrated: penetratedAt[i],
        point: e.point,
        normal: e.normal,
        healthAfter: victim.health,
      });
      hitMessages.push({
        attackerId: shooter.id,
        victimId: victim.id,
        part: e.part,
        damage,
        penetrated: penetratedAt[i],
        point: { x: e.point.x, y: e.point.y, z: e.point.z },
        normal: { x: e.normal.x, y: e.normal.y, z: e.normal.z },
      });
      if (killed) victims.push({ id: victim.id, part: e.part, distance: e.t });
    }

    return {
      fired: true,
      reason: null,
      origin,
      direction: dir,
      spread,
      hits,
      hitMessages,
      victims,
      impacts,
      context: this.buildContext(shooter, runtime, victims, now),
    };
  }

  /**
   * Melee. `MELEE_RANGE` in front of the eye, instant kill from ANY angle
   * (`MELEE_DAMAGE` is 150 against 100 health) — there is no backstab rule
   * because there is no non-lethal melee to distinguish it from.
   *
   * Geometry blocks it: a wall between attacker and victim stops the swing even
   * if the victim is within range.
   */
  meleeAttack(req: MeleeRequest): FireResult {
    const { attacker, runtime, targets, now } = req;

    const origin = vec3();
    shotOrigin(attacker, origin);
    const dir = vec3();
    viewDirection(attacker.yaw, attacker.pitch, dir);

    if (!attacker.alive) return emptyResult(CorrectionReason.IllegalFire, origin, dir);

    let bestT = MELEE_RANGE;
    let bestTarget: PlayerState | null = null;
    let bestPart: HitboxPart = HitboxPart.Chest;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.id === attacker.id || !t.alive) continue;
      const hit = rayVsPlayer(origin, dir, t, MELEE_RANGE);
      if (!hit) continue;
      if (hit.t < bestT) {
        bestT = hit.t;
        bestTarget = t;
        bestPart = hit.part;
      }
    }

    const impacts: SurfaceImpact[] = [];
    const wall = raycastWorldAll(origin, dir, bestTarget ? bestT : MELEE_RANGE, 1);
    if (wall.length > 0 && (!bestTarget || wall[0].t < bestT)) {
      impacts.push({
        point: wall[0].point,
        normal: wall[0].normal,
        brushId: wall[0].brush.id,
        material: wall[0].brush.material,
        penetrated: false,
      });
      bestTarget = null;
    }

    const hits: ShotHit[] = [];
    const hitMessages: HitMsg[] = [];
    const victims: TrickshotVictim[] = [];

    if (bestTarget) {
      const point = {
        x: origin.x + dir.x * bestT,
        y: origin.y + dir.y * bestT,
        z: origin.z + dir.z * bestT,
      };
      const normal = { x: -dir.x, y: -dir.y, z: -dir.z };
      const killed = this.applyDamage(bestTarget, MELEE_DAMAGE, attacker.id, now);
      hits.push({
        victimId: bestTarget.id,
        part: bestPart,
        damage: MELEE_DAMAGE,
        distance: bestT,
        killed,
        penetrated: false,
        point,
        normal,
        healthAfter: bestTarget.health,
      });
      hitMessages.push({
        attackerId: attacker.id,
        victimId: bestTarget.id,
        part: bestPart,
        damage: MELEE_DAMAGE,
        penetrated: false,
        point,
        normal,
      });
      if (killed) victims.push({ id: bestTarget.id, part: bestPart, distance: bestT });
    }

    const context = this.buildContext(attacker, runtime, victims, now);
    // A knife is never a scoped shot, whatever the sights were doing.
    context.adsState = AdsState.Hip;
    context.adsProgress = 0;
    context.timeSinceAccuracyLock = Number.POSITIVE_INFINITY;

    return {
      fired: true,
      reason: null,
      origin,
      direction: dir,
      spread: 0,
      hits,
      hitMessages,
      victims,
      impacts,
      context,
    };
  }

  // -------------------------------------------------------------------------
  // Damage, death, regeneration
  // -------------------------------------------------------------------------

  /**
   * Apply damage and resolve death. Returns true if this is the blow that
   * killed. Mutates the victim state, which is the server's own copy.
   */
  applyDamage(victim: PlayerState, amount: number, attackerId: PlayerId, now: number): boolean {
    if (!victim.alive) return false;
    if (!(amount > 0)) return false;

    const rec = this.record(victim.id);
    rec.lastDamagedAt = now;
    rec.lastAttacker = attackerId;

    victim.health -= amount;
    if (victim.health <= 0) {
      victim.health = 0;
      victim.alive = false;
      return true;
    }
    return false;
  }

  /**
   * Health regeneration for one player, one tick.
   * Nothing happens for `HEALTH_REGEN_DELAY` after the last damage taken; after
   * that health climbs at `HEALTH_REGEN_RATE` per second up to `MAX_HEALTH`.
   */
  regenerate(state: PlayerState, dt: number, now: number): void {
    if (!state.alive) return;
    if (state.health >= MAX_HEALTH) return;
    const rec = this.record(state.id);
    if (now - rec.lastDamagedAt < HEALTH_REGEN_DELAY) return;
    state.health += HEALTH_REGEN_RATE * dt;
    if (state.health > MAX_HEALTH) state.health = MAX_HEALTH;
  }

  /** Regeneration for a whole roster. Call once per server tick. */
  tickHealth(states: Iterable<PlayerState>, dt: number, now: number): void {
    for (const s of states) this.regenerate(s, dt, now);
  }

  // -------------------------------------------------------------------------
  // Trickshot context
  // -------------------------------------------------------------------------

  /**
   * Assemble the half of `TrickshotContext` that only combat knows.
   *
   * `timeSinceAccuracyLock` is copied VERBATIM from the runtime. It is a
   * rising-edge stopwatch (0 the instant the scope crosses the accuracy lock,
   * `Infinity` the instant ADS is released) and nothing here may reinterpret it
   * — a quickscope reads ~0.02 and a ten-second camp reads ~10, and that
   * difference is the whole mode.
   *
   * `yawHistory`, `recentKillTimes` and `jumpedRecently` are deliberately left
   * out: the ScoreKeeper already tracks them per player and fills them in.
   */
  private buildContext(
    shooter: PlayerState,
    runtime: WeaponRuntime,
    victims: TrickshotVictim[],
    now: number,
  ): Partial<TrickshotContext> {
    return {
      shooter,
      timeSinceAccuracyLock: runtime.timeSinceAccuracyLock,
      adsState: runtime.adsState,
      adsProgress: runtime.adsProgress,
      victims,
      now,
      wasAirborne: shooter.onGround === false,
      stanceAtFire: shooter.stance ?? Stance.Stand,
      proneTransition: (shooter.proneTime ?? 0) > 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Free helpers, for callers that do not want the class
// ---------------------------------------------------------------------------

/**
 * Pure trace with no state, no validation and no damage — the shot a client
 * would predict. Returns the same event walk `fireWeapon` uses.
 */
export function previewShot(
  shooter: PlayerState,
  runtime: WeaponRuntime,
  resolved: ResolvedWeapon,
  input: ClientInput,
  targets: readonly PlayerState[],
): { origin: Vec3; direction: Vec3; spread: number; distance: number } {
  const origin = vec3();
  shotOrigin(shooter, origin);
  const aim = vec3();
  viewDirection(shooter.yaw, shooter.pitch, aim);
  const spread = spreadForShot(runtime, resolved, shooter);
  const rng = makeShotRng(shooter.id, input.seq);
  const dir = vec3();
  applySpread(aim, spread, rng, dir);

  const { events } = traceShot(origin, dir, shooter.id, targets, resolved, MAX_SHOT_RANGE);
  let distance = MAX_SHOT_RANGE;
  for (let i = 0; i < events.length; i++) {
    if (events[i].brush || events[i].target) {
      distance = events[i].t;
      break;
    }
  }
  return { origin, direction: dir, spread, distance };
}

/** The weapon a kill should be attributed to. Melee reports the knife. */
export function weaponForKill(runtime: WeaponRuntime): WeaponId {
  return runtime.action === WeaponAction.Melee ? WeaponId.Knife : runtime.weapon;
}
