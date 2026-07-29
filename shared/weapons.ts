/**
 * DECKSHOT — weapon resolution and the ADS / firing state machine.
 *
 * Owner: weapons-hitreg.
 *
 * This module is the mechanical heart of the game. Two rules govern everything
 * in it:
 *
 *  1. `advanceWeapon` is PURE, in exactly the sense `applyMovement` is pure:
 *     same runtime + input + dt + resolved weapon => bit-identical output, on
 *     Node and in a browser. No `Date.now()`, no `Math.random()`, no mutation
 *     of its arguments. It is replayed dozens of times per second during client
 *     reconciliation; anything impure desyncs prediction.
 *
 *  2. `timeSinceAccuracyLock` is a RISING-EDGE STOPWATCH. See the long comment
 *     on it below. It is the single field that separates a quickscope from a
 *     camp, and the trickshot module keys off nothing else.
 *
 * Engine-free: plain TypeScript, imported by both the browser and the server.
 */

import { hashSeed, type Rng } from './rng.js';
import {
  ATTACHMENTS,
  MELEE_TIME,
  SPEED_ADS,
  WEAPONS,
  type AttachmentSpec,
  type WeaponSpec,
} from './tuning.js';
import {
  AdsState,
  AttachmentId,
  HitboxPart,
  InputButton,
  MAX_ATTACHMENTS,
  Stance,
  WeaponId,
  hasButton,
} from './types.js';
import type { ClientInput, InputSeq, Loadout, PlayerState, TickNumber, Vec3 } from './types.js';

// ---------------------------------------------------------------------------
// Tunables owned by this module
// ---------------------------------------------------------------------------

/**
 * Horizontal speed (m/s) above which the MOVING hipfire cone applies.
 * Deliberately low: a player who is meaningfully strafing gets the wide cone.
 * Not in the frozen tuning file, which has the three cones but no threshold.
 */
export const HIPFIRE_MOVING_SPEED = 0.6;

/**
 * Floor on any resolved time, seconds. Stops a hypothetical stack of
 * multipliers from producing a zero or negative duration and dividing by it.
 */
const MIN_TIME = 1 / 240;

/** Slop for "the action has finished" comparisons at tick granularity. */
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Resolved weapon
// ---------------------------------------------------------------------------

/**
 * A `WeaponSpec` with every attachment modifier folded in, plus the behaviour
 * flags presentation systems need. Treat as immutable — `resolveWeapon` caches
 * and returns shared, frozen instances.
 */
export interface ResolvedWeapon extends WeaponSpec {
  /** Movement speed while scoped. `SPEED_ADS` unless Lightweight Stock is on. */
  adsMoveSpeed: number;
  suppressed: boolean;
  laserVisible: boolean;
  ironSights: boolean;
  variableZoom: boolean;
  /** The attachments that produced this, normalized (no None, deduped). */
  attachments: readonly AttachmentId[];
}

/**
 * ATTACHMENT RESOLUTION ORDER — multiplicative, then additive, then override.
 *
 * Mods are accumulated by NAMING CONVENTION, not by attachment identity:
 *
 *   `*Mult`  -> multiplied together   (product starts at 1)
 *   `*Add`   -> summed                (sum starts at 0)
 *   anything else -> absolute override, last attachment in slot order wins
 *
 * A field is then computed as `base * product + sum`, and an override replaces
 * the result outright. That order matters: Fast Draw (x0.62) plus Suppressor
 * (+0.05) gives 0.34 * 0.62 + 0.05 = 0.2608, not (0.34 + 0.05) * 0.62 = 0.2418.
 * Multiplying first means a flat penalty is a flat penalty regardless of what
 * else is bolted on, which is the only version that stays balanced as
 * attachments are added.
 *
 * NO ATTACHMENT IS NAMED IN THIS FUNCTION. Adding one is a single entry in
 * `shared/tuning.ts` and nothing else.
 */
function accumulate(ids: readonly AttachmentId[]): {
  mult: Record<string, number>;
  add: Record<string, number>;
  set: Record<string, number>;
  flags: Record<string, boolean>;
} {
  const mult: Record<string, number> = {};
  const add: Record<string, number> = {};
  const set: Record<string, number> = {};
  const flags: Record<string, boolean> = {};

  for (let i = 0; i < ids.length; i++) {
    const spec: AttachmentSpec | undefined = ATTACHMENTS[ids[i]];
    if (!spec) continue;

    const mods = spec.mods as Record<string, number | undefined> | undefined;
    if (mods) {
      // Object.keys on an object literal is insertion order — deterministic.
      const keys = Object.keys(mods);
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        const v = mods[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (key.length > 4 && key.endsWith('Mult')) {
          mult[key] = (mult[key] === undefined ? 1 : mult[key]) * v;
        } else if (key.length > 3 && key.endsWith('Add')) {
          add[key] = (add[key] === undefined ? 0 : add[key]) + v;
        } else {
          set[key] = v;
        }
      }
    }

    const f = spec.flags as Record<string, boolean | undefined> | undefined;
    if (f) {
      const keys = Object.keys(f);
      for (let k = 0; k < keys.length; k++) {
        if (f[keys[k]] === true) flags[keys[k]] = true;
      }
    }
  }

  return { mult, add, set, flags };
}

const resolveCache = new Map<string, ResolvedWeapon>();

/** Drops `None`, removes duplicates, caps at MAX_ATTACHMENTS. Order preserved. */
function normalizeAttachments(attachments: readonly AttachmentId[] | undefined): AttachmentId[] {
  const out: AttachmentId[] = [];
  if (!attachments) return out;
  for (let i = 0; i < attachments.length && out.length < MAX_ATTACHMENTS; i++) {
    const a = attachments[i];
    if (a === undefined || a === null) continue;
    if (a === AttachmentId.None) continue;
    if (!ATTACHMENTS[a]) continue;
    let dup = false;
    for (let j = 0; j < out.length; j++) if (out[j] === a) dup = true;
    if (!dup) out.push(a);
  }
  return out;
}

/**
 * Fold a set of attachments into a weapon's base spec.
 *
 * Pure and memoized: the same (weapon, attachments) always returns the same
 * frozen object, so callers may compare by identity and must not mutate.
 */
export function resolveWeapon(
  weapon: WeaponId,
  attachments: readonly AttachmentId[] = [],
): ResolvedWeapon {
  const ids = normalizeAttachments(attachments);
  const key = `${weapon}|${ids.join(',')}`;
  const cached = resolveCache.get(key);
  if (cached) return cached;

  const base: WeaponSpec = WEAPONS[weapon] ?? WEAPONS[WeaponId.Talon];
  const { mult, add, set, flags } = accumulate(ids);

  const m = (k: string): number => (mult[k] === undefined ? 1 : mult[k]);
  const a = (k: string): number => (add[k] === undefined ? 0 : add[k]);
  const s = (k: string, fallback: number): number => (set[k] === undefined ? fallback : set[k]);

  const damageMult = m('damageMult');
  const hipMult = m('hipSpreadMult');
  const recoilMult = m('recoilMult');

  const damage: Record<HitboxPart, number> = {
    [HitboxPart.Head]: base.damage[HitboxPart.Head] * damageMult,
    [HitboxPart.Chest]: base.damage[HitboxPart.Chest] * damageMult,
    [HitboxPart.Stomach]: base.damage[HitboxPart.Stomach] * damageMult,
    [HitboxPart.ArmL]: base.damage[HitboxPart.ArmL] * damageMult,
    [HitboxPart.ArmR]: base.damage[HitboxPart.ArmR] * damageMult,
    [HitboxPart.LegL]: base.damage[HitboxPart.LegL] * damageMult,
    [HitboxPart.LegR]: base.damage[HitboxPart.LegR] * damageMult,
  };

  const resolved: ResolvedWeapon = {
    id: base.id,
    name: base.name,

    adsTime: Math.max(MIN_TIME, base.adsTime * m('adsTimeMult') + a('adsTimeAdd')),
    // Never modified by an attachment: this number IS the game's identity and
    // is deliberately not purchasable.
    accuracyLockAt: base.accuracyLockAt,
    cycleTime: Math.max(MIN_TIME, base.cycleTime * m('cycleTimeMult') + a('cycleTimeAdd')),

    magSize: Math.max(0, Math.round(base.magSize * m('magSizeMult') + a('magSizeAdd'))),
    reserveAmmo: Math.max(0, Math.round(base.reserveAmmo * m('reserveAmmoMult') + a('reserveAmmoAdd'))),
    reloadTime: Math.max(MIN_TIME, base.reloadTime * m('reloadTimeMult') + a('reloadTimeAdd')),
    reloadTimeEmpty: Math.max(
      MIN_TIME,
      base.reloadTimeEmpty * m('reloadTimeMult') + a('reloadTimeAdd'),
    ),

    damage,
    penetrationDamage: s('penetrationDamage', base.penetrationDamage),
    penetrationCount: s('penetrationCount', base.penetrationCount),

    swayAmplitude: Math.max(0, base.swayAmplitude * m('swayAmplitudeMult') + a('swayAmplitudeAdd')),
    swayFrequency: Math.max(0, base.swayFrequency * m('swayFrequencyMult')),
    swaySettleFactor: base.swaySettleFactor,
    swaySettleTime: Math.max(MIN_TIME, base.swaySettleTime * m('swaySettleTimeMult')),

    recoilVertical: base.recoilVertical * recoilMult,
    recoilHorizontal: base.recoilHorizontal * recoilMult,
    recoilRecovery: Math.max(MIN_TIME, base.recoilRecovery * m('recoilRecoveryMult')),
    recoilPunch: base.recoilPunch * recoilMult,

    hipSpreadStand: Math.max(0, base.hipSpreadStand * hipMult),
    hipSpreadCrouch: Math.max(0, base.hipSpreadCrouch * hipMult),
    hipSpreadMoving: Math.max(0, base.hipSpreadMoving * hipMult),

    flinch: base.flinch * m('flinchMult'),
    swapTime: Math.max(MIN_TIME, base.swapTime * m('swapTimeMult') + a('swapTimeAdd')),
    hitscan: base.hitscan,

    adsMoveSpeed: Math.max(0, s('adsMoveSpeed', SPEED_ADS)),
    suppressed: flags.suppressed === true,
    laserVisible: flags.laserVisible === true,
    ironSights: flags.ironSights === true,
    variableZoom: flags.variableZoom === true,
    attachments: ids,
  };

  Object.freeze(resolved.damage);
  Object.freeze(resolved.attachments);
  Object.freeze(resolved);
  resolveCache.set(key, resolved);
  return resolved;
}

/** Convenience: resolve a full loadout's primary weapon. */
export function resolveLoadout(loadout: Loadout | undefined): ResolvedWeapon {
  if (!loadout) return resolveWeapon(WeaponId.Talon, []);
  return resolveWeapon(loadout.primary, loadout.attachments);
}

/**
 * Resolve the SECONDARY (always the Kestrel) with the same attachments the
 * player picked. Attachments that mean nothing on a pistol simply resolve to
 * no-ops, which keeps the swap path free of special cases.
 */
export function resolveSecondary(loadout: Loadout | undefined): ResolvedWeapon {
  const primary = loadout ? loadout.primary : WeaponId.Talon;
  const other = primary === WeaponId.Kestrel ? WeaponId.Talon : WeaponId.Kestrel;
  return resolveWeapon(other, loadout ? loadout.attachments : []);
}

/**
 * Publish the resolved ADS move speed onto the player state.
 *
 * `shared/movement.ts` reads `state.adsMoveSpeedOverride` and DELIBERATELY
 * never reads `state.loadout` — loadout interpretation is this module's job.
 * Call this whenever a loadout is applied (spawn, loadout change, weapon swap).
 *
 * Mutates and returns `state`; it is a setter, not part of the pure sim path.
 */
export function applyLoadoutToState(state: PlayerState, rw: ResolvedWeapon): PlayerState {
  state.adsMoveSpeedOverride = rw.adsMoveSpeed;
  return state;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export enum WeaponAction {
  Idle = 0,
  /** Bolt cycle / semi-auto fire interval. Blocks firing, NOT aiming. */
  Cycling = 1,
  Reloading = 2,
  Swapping = 3,
  /** Quick melee. Blocks everything, does not change the active weapon. */
  Melee = 4,
}

/**
 * Everything the weapon simulation carries between ticks.
 *
 * Plain data, structurally copied by `advanceWeapon` every tick so the client
 * can keep one snapshot per input in its prediction history and rewind to any
 * of them on a correction.
 */
export interface WeaponRuntime {
  /** Currently held weapon. `advanceWeapon` receives the ResolvedWeapon for it. */
  weapon: WeaponId;
  /** The other weapon, holstered. Swapping exchanges the two. */
  stowedWeapon: WeaponId;

  /** Simulation clock, seconds, advanced by `dt`. Never a wall clock. */
  time: number;

  ammoInMag: number;
  ammoReserve: number;
  stowedMag: number;
  stowedReserve: number;

  adsState: AdsState;
  /**
   * RAW linear ADS progress, 0..1.
   * `accuracyLockAt` is defined against THIS value. Never against `adsEased`.
   */
  adsProgress: number;
  /**
   * EASED ADS progress, 0..1. Camera FOV lerp and viewmodel pose only.
   * Never compare this to `accuracyLockAt` — the two curves differ by ~10% in
   * the middle of the transition, which is several ticks of feel.
   */
  adsEased: number;

  /**
   * SECONDS SINCE THE RISING EDGE OF ACCURACY LOCK. `Infinity` when the current
   * aim has never crossed the lock, and reset to `Infinity` the moment the
   * player leaves ADS.
   *
   * THIS IS A STOPWATCH, NOT AN ACCUMULATOR. It restarts at 0 on the tick
   * `adsProgress` crosses `accuracyLockAt` going UP, counts up from there, and
   * goes back to `Infinity` on leaving ADS. A player who flicks the scope up
   * and fires reads ~0.02; a player who has held the scope in a corner for ten
   * seconds reads ~10. `shared/trickshot.ts` decides quickscope from this value
   * and nothing else — if it were ever "time spent above the lock" measured
   * continuously, camping and flicking would be indistinguishable and the whole
   * mode would lose its identity.
   */
  timeSinceAccuracyLock: number;

  /**
   * Internal to the stopwatch. True once the aim has genuinely been BELOW the
   * accuracy lock; consumed by the next upward crossing, which is what restarts
   * the count at 0.
   *
   * Without this latch there is a frame-perfect exploit: a camper who has held
   * the scope for ten seconds releases ADS for a single tick and presses it
   * again. `adsProgress` only falls by ~0.05 in that tick — still above the
   * lock — so the aim never actually degrades, yet a naive "reset on leaving
   * ADS" would hand them a fresh 0 and a QUICKSCOPE banner for free. The latch
   * requires the sights to have actually come down.
   */
  lockArmed: boolean;

  /**
   * Internal to the stopwatch: the raw elapsed counter that
   * `timeSinceAccuracyLock` reports when the shot is locked. Kept separately so
   * a momentary drop out of ADS (which reports `Infinity`, as contracted) does
   * not destroy a camper's true hold time.
   */
  lockElapsed: number;

  /** Seconds continuously in ADS (Raising or Scoped). Drives sway settling. */
  adsHoldTime: number;

  action: WeaponAction;
  /** `time` at which `action` completes. Meaningless while Idle. */
  actionEndsAt: number;
  /** True while the in-flight reload is the slower empty-magazine variant. */
  reloadEmpty: boolean;

  /** Accumulated recoil, radians. Presentation + camera only (see note below). */
  recoilPitch: number;
  recoilYaw: number;
  /** Camera pull-back, meters. */
  recoilPunch: number;

  /** Sway noise phase, advanced by `dt * swayFrequency`. */
  swayPhase: number;
  /** Current sway offset, radians. Presentation only — never perturbs the ray. */
  swayYaw: number;
  swayPitch: number;

  /** Variable Zoom level while scoped: 0 = 3.5x, 1 = 8x. */
  zoomLevel: 0 | 1;

  lastFireTick: TickNumber;
  lastFireSeq: InputSeq;
  /** `time` of the last shot. `-Infinity` if never fired. */
  lastFireTime: number;

  // --- one-tick event flags, cleared at the top of every advance -----------
  firedThisTick: boolean;
  dryFiredThisTick: boolean;
  reloadStartedThisTick: boolean;
  reloadEndedThisTick: boolean;
  swapStartedThisTick: boolean;
  swapEndedThisTick: boolean;
  meleeThisTick: boolean;

  /** Previous tick's `ClientInput.buttons`, so rising edges can be detected. */
  prevButtons: number;
}

/** Fresh runtime for a spawning player holding `rw`. */
export function createWeaponRuntime(rw: ResolvedWeapon): WeaponRuntime {
  const stowed = rw.id === WeaponId.Kestrel ? WeaponId.Talon : WeaponId.Kestrel;
  const stowedSpec = WEAPONS[stowed];
  return {
    weapon: rw.id,
    stowedWeapon: stowed,
    time: 0,
    ammoInMag: rw.magSize,
    ammoReserve: rw.reserveAmmo,
    stowedMag: stowedSpec.magSize,
    stowedReserve: stowedSpec.reserveAmmo,
    adsState: AdsState.Hip,
    adsProgress: 0,
    adsEased: 0,
    timeSinceAccuracyLock: Number.POSITIVE_INFINITY,
    lockArmed: true,
    lockElapsed: 0,
    adsHoldTime: 0,
    action: WeaponAction.Idle,
    actionEndsAt: 0,
    reloadEmpty: false,
    recoilPitch: 0,
    recoilYaw: 0,
    recoilPunch: 0,
    swayPhase: 0,
    swayYaw: 0,
    swayPitch: 0,
    zoomLevel: 0,
    lastFireTick: 0,
    lastFireSeq: 0,
    lastFireTime: Number.NEGATIVE_INFINITY,
    firedThisTick: false,
    dryFiredThisTick: false,
    reloadStartedThisTick: false,
    reloadEndedThisTick: false,
    swapStartedThisTick: false,
    swapEndedThisTick: false,
    meleeThisTick: false,
    prevButtons: 0,
  };
}

/** Structural copy. Used by `advanceWeapon` and by prediction history. */
export function cloneWeaponRuntime(ws: WeaponRuntime): WeaponRuntime {
  return {
    weapon: ws.weapon,
    stowedWeapon: ws.stowedWeapon,
    time: ws.time,
    ammoInMag: ws.ammoInMag,
    ammoReserve: ws.ammoReserve,
    stowedMag: ws.stowedMag,
    stowedReserve: ws.stowedReserve,
    adsState: ws.adsState,
    adsProgress: ws.adsProgress,
    adsEased: ws.adsEased,
    timeSinceAccuracyLock: ws.timeSinceAccuracyLock,
    lockArmed: ws.lockArmed,
    lockElapsed: ws.lockElapsed,
    adsHoldTime: ws.adsHoldTime,
    action: ws.action,
    actionEndsAt: ws.actionEndsAt,
    reloadEmpty: ws.reloadEmpty,
    recoilPitch: ws.recoilPitch,
    recoilYaw: ws.recoilYaw,
    recoilPunch: ws.recoilPunch,
    swayPhase: ws.swayPhase,
    swayYaw: ws.swayYaw,
    swayPitch: ws.swayPitch,
    zoomLevel: ws.zoomLevel,
    lastFireTick: ws.lastFireTick,
    lastFireSeq: ws.lastFireSeq,
    lastFireTime: ws.lastFireTime,
    firedThisTick: ws.firedThisTick,
    dryFiredThisTick: ws.dryFiredThisTick,
    reloadStartedThisTick: ws.reloadStartedThisTick,
    reloadEndedThisTick: ws.reloadEndedThisTick,
    swapStartedThisTick: ws.swapStartedThisTick,
    swapEndedThisTick: ws.swapEndedThisTick,
    meleeThisTick: ws.meleeThisTick,
    prevButtons: ws.prevButtons,
  };
}

// ---------------------------------------------------------------------------
// The ADS curve
// ---------------------------------------------------------------------------

/**
 * THE HAND-AUTHORED ADS CURVE. Maps raw linear progress to the eased value the
 * camera and viewmodel use.
 *
 * Smoothstep: slow to leave the hip, quick through the middle, settling into
 * the scope rather than slamming into it. The choice matters because the FOV
 * lerp is what the player's eye reads as "aimed".
 *
 * The mechanical lock is measured on the RAW value, so eased and raw must never
 * be confused: at raw = accuracyLockAt (0.82) the eased value is 0.914, i.e.
 * the scope LOOKS 91% up when the shot becomes pinpoint. That small lead is
 * deliberate — the visual settles just as the accuracy does. Swapping the two
 * makes every shot feel a tick early or a tick late.
 */
export function easeAds(p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p;
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// Deterministic sway noise
// ---------------------------------------------------------------------------

/** Hashed value in [-1, 1) for an integer lattice point. */
function latticeValue(i: number, channel: number): number {
  return hashSeed(i, channel) * 4.656612875245797e-10 - 1; // (h / 2^31) - 1
}

/**
 * Smoothed 1D value noise. Deterministic integer hashing plus a lerp — no
 * `Math.sin(Date.now())`, no transcendental drift between hosts.
 */
function swayNoise(x: number, channel: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = latticeValue(i, channel);
  const b = latticeValue(i + 1, channel);
  return a + (b - a) * u;
}

/**
 * Sway amplitude scale at a given hold time: 1 at the moment the scope comes
 * up, decaying linearly to `swaySettleFactor` after `swaySettleTime`.
 */
export function swaySettleScale(rw: ResolvedWeapon, holdTime: number): number {
  const t = holdTime <= 0 ? 0 : holdTime >= rw.swaySettleTime ? 1 : holdTime / rw.swaySettleTime;
  return 1 + (rw.swaySettleFactor - 1) * t;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/** True when the weapon is free to start a new action. */
export function isIdle(ws: WeaponRuntime): boolean {
  return ws.action === WeaponAction.Idle || ws.time >= ws.actionEndsAt - EPS;
}

/**
 * Can this weapon put a round downrange right now?
 * Ammo, no action in progress, and the fire interval elapsed.
 * Liveness (`alive`) is the caller's business — it lives on PlayerState.
 */
export function canFire(ws: WeaponRuntime, rw: ResolvedWeapon): boolean {
  if (ws.ammoInMag <= 0) return false;
  if (rw.magSize <= 0) return false; // the knife has no magazine
  if (!isIdle(ws)) return false;
  if (ws.time - ws.lastFireTime < rw.cycleTime - EPS) return false;
  return true;
}

/** True while aiming (raising or fully scoped). Lowering does NOT count. */
export function isAiming(ws: WeaponRuntime): boolean {
  return ws.adsState === AdsState.Raising || ws.adsState === AdsState.Scoped;
}

/** True when the shot would be pinpoint: raw progress at or past the lock. */
export function isAccuracyLocked(ws: WeaponRuntime, rw: ResolvedWeapon): boolean {
  return isAiming(ws) && ws.adsProgress >= rw.accuracyLockAt - EPS;
}

/** Actions that hold the sights down. Cycling deliberately does NOT. */
function actionBlocksAds(action: WeaponAction): boolean {
  return action === WeaponAction.Reloading || action === WeaponAction.Swapping || action === WeaponAction.Melee;
}

/**
 * Advance the weapon by one tick.
 *
 * PURE. Returns a new runtime; `ws` and `input` are never written to. Every
 * time value comes from `dt` and the runtime's own clock.
 *
 * Order of operations is load-bearing:
 *   1. clock + finish any completed action
 *   2. discrete requests (swap, melee, reload) on button RISING edges
 *   3. ADS transition  — before firing, so a shot on the crossing tick is locked
 *   4. accuracy-lock stopwatch
 *   5. fire
 *   6. recoil decay and sway
 *
 * NOTE ON SWAP: when a swap completes, `weapon` changes. The caller must
 * re-resolve the ResolvedWeapon for the following tick (`ws.swapEndedThisTick`
 * flags it); `rw` is only ever the spec of the weapon held at entry.
 */
export function advanceWeapon(
  ws: WeaponRuntime,
  input: ClientInput,
  dt: number,
  rw: ResolvedWeapon,
): WeaponRuntime {
  const ns = cloneWeaponRuntime(ws);

  ns.firedThisTick = false;
  ns.dryFiredThisTick = false;
  ns.reloadStartedThisTick = false;
  ns.reloadEndedThisTick = false;
  ns.swapStartedThisTick = false;
  ns.swapEndedThisTick = false;
  ns.meleeThisTick = false;

  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
  ns.time = ws.time + step;

  const buttons = input.buttons | 0;
  const prev = ws.prevButtons | 0;
  const pressed = (b: InputButton): boolean => hasButton(buttons, b) && !hasButton(prev, b);

  // --- 1. complete a finished action --------------------------------------
  if (ns.action !== WeaponAction.Idle && ns.time >= ns.actionEndsAt - EPS) {
    switch (ns.action) {
      case WeaponAction.Reloading: {
        const room = rw.magSize - ns.ammoInMag;
        const take = room < ns.ammoReserve ? room : ns.ammoReserve;
        if (take > 0) {
          ns.ammoInMag += take;
          ns.ammoReserve -= take;
        }
        ns.reloadEndedThisTick = true;
        ns.reloadEmpty = false;
        break;
      }
      case WeaponAction.Swapping: {
        const heldWeapon = ns.weapon;
        const heldMag = ns.ammoInMag;
        const heldReserve = ns.ammoReserve;
        ns.weapon = ns.stowedWeapon;
        ns.ammoInMag = ns.stowedMag;
        ns.ammoReserve = ns.stowedReserve;
        ns.stowedWeapon = heldWeapon;
        ns.stowedMag = heldMag;
        ns.stowedReserve = heldReserve;
        ns.swapEndedThisTick = true;
        // A fresh weapon may not fire until its own cycle time has elapsed.
        ns.lastFireTime = ns.time;
        break;
      }
      default:
        break;
    }
    ns.action = WeaponAction.Idle;
    ns.actionEndsAt = 0;
  }

  // --- 2. discrete requests ------------------------------------------------
  const idle = ns.action === WeaponAction.Idle;

  if (idle && pressed(InputButton.Melee)) {
    ns.action = WeaponAction.Melee;
    ns.actionEndsAt = ns.time + MELEE_TIME;
    ns.meleeThisTick = true;
  } else if (idle && pressed(InputButton.SwapWeapon)) {
    ns.action = WeaponAction.Swapping;
    ns.actionEndsAt = ns.time + rw.swapTime;
    ns.swapStartedThisTick = true;
  } else if (
    idle &&
    pressed(InputButton.Reload) &&
    ns.ammoInMag < rw.magSize &&
    ns.ammoReserve > 0
  ) {
    ns.reloadEmpty = ns.ammoInMag <= 0;
    ns.action = WeaponAction.Reloading;
    ns.actionEndsAt = ns.time + (ns.reloadEmpty ? rw.reloadTimeEmpty : rw.reloadTime);
    ns.reloadStartedThisTick = true;
  }

  // --- 3. ADS transition ---------------------------------------------------
  const wantAds = hasButton(buttons, InputButton.Ads) && !actionBlocksAds(ns.action);
  const rate = step / rw.adsTime;

  if (wantAds) {
    ns.adsProgress = ws.adsProgress + rate;
    if (ns.adsProgress >= 1) {
      ns.adsProgress = 1;
      ns.adsState = AdsState.Scoped;
    } else {
      ns.adsState = AdsState.Raising;
    }
    ns.adsHoldTime = ws.adsHoldTime + step;
  } else {
    ns.adsProgress = ws.adsProgress - rate;
    if (ns.adsProgress <= 0) {
      ns.adsProgress = 0;
      ns.adsState = AdsState.Hip;
    } else {
      ns.adsState = AdsState.Lowering;
    }
    ns.adsHoldTime = 0;
  }
  ns.adsEased = easeAds(ns.adsProgress);

  // Variable Zoom is a hold, and only means anything once actually scoped.
  ns.zoomLevel =
    rw.variableZoom && hasButton(buttons, InputButton.ZoomToggle) && ns.adsState === AdsState.Scoped
      ? 1
      : 0;

  // --- 4. the rising-edge stopwatch ---------------------------------------
  //
  // THE quickscope discriminator. Read the field docs on
  // `timeSinceAccuracyLock` before touching a line of this.
  //
  //   below the lock            -> arm, and report Infinity
  //   crossing the lock upward  -> restart the count at 0 (this IS a quickscope)
  //   holding above the lock    -> count up (a camper reads ~10 after ten seconds)
  //   out of ADS                -> report Infinity
  //
  // Nothing outside this block may write these three fields.
  const lockedNow = ns.adsProgress >= rw.accuracyLockAt - EPS;
  if (!lockedNow) ns.lockArmed = true;

  if (lockedNow && isAiming(ns)) {
    if (ns.lockArmed) {
      ns.lockElapsed = 0; // rising edge
      ns.lockArmed = false;
    } else {
      ns.lockElapsed = ws.lockElapsed + step;
    }
    ns.timeSinceAccuracyLock = ns.lockElapsed;
  } else {
    // Still tick the underlying counter so a one-frame tap out of the scope
    // cannot launder ten seconds of camping into a fresh quickscope.
    ns.lockElapsed = ws.lockElapsed + step;
    ns.timeSinceAccuracyLock = Number.POSITIVE_INFINITY;
  }

  // --- 5. fire -------------------------------------------------------------
  // Both weapons are semi-automatic (bolt-action and semi-auto pistol), so a
  // shot requires a fresh trigger pull: the rising edge of Fire, never a hold.
  //
  // Recoil is presentation and camera only: the authoritative ray uses the
  // input's absolute view angles, which already include whatever the player's
  // aim did in response to the previous shot's kick.
  let kickPitch = 0;
  let kickYaw = 0;
  let kickPunch = 0;

  if (pressed(InputButton.Fire)) {
    if (canFire(ns, rw)) {
      ns.ammoInMag -= 1;
      ns.action = WeaponAction.Cycling;
      ns.actionEndsAt = ns.time + rw.cycleTime;
      ns.lastFireTime = ns.time;
      ns.lastFireTick = input.tick;
      ns.lastFireSeq = input.seq;
      ns.firedThisTick = true;

      const h = hashSeed(input.seq | 0, input.tick | 0);
      const sign = (h & 1) === 0 ? -1 : 1;
      const mag = 0.5 + (0.5 * ((h >>> 8) & 0xff)) / 255;
      kickPitch = rw.recoilVertical;
      kickYaw = sign * rw.recoilHorizontal * mag;
      kickPunch = rw.recoilPunch;
    } else if (ns.ammoInMag <= 0 && isIdle(ns) && rw.magSize > 0) {
      ns.dryFiredThisTick = true;
    }
  }

  // --- 6. recoil recovery and sway ----------------------------------------
  // Linear decay toward zero over `recoilRecovery`, then this tick's kick added
  // undecayed. Deliberately not `Math.exp`: transcendentals are not bit-
  // specified across hosts and this state is replayed during reconciliation.
  const decay = rw.recoilRecovery > 0 ? step / rw.recoilRecovery : 1;
  const keep = decay >= 1 ? 0 : 1 - decay;
  ns.recoilPitch = ws.recoilPitch * keep + kickPitch;
  ns.recoilYaw = ws.recoilYaw * keep + kickYaw;
  ns.recoilPunch = ws.recoilPunch * keep + kickPunch;

  ns.swayPhase = ws.swayPhase + step * rw.swayFrequency;
  if (ns.adsEased > 0 && rw.swayAmplitude > 0) {
    const amp = rw.swayAmplitude * swaySettleScale(rw, ns.adsHoldTime) * ns.adsEased;
    ns.swayYaw = amp * swayNoise(ns.swayPhase, 1);
    ns.swayPitch = amp * swayNoise(ns.swayPhase * 1.37 + 11.5, 2);
  } else {
    ns.swayYaw = 0;
    ns.swayPitch = 0;
  }

  ns.prevButtons = buttons;
  return ns;
}

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

/** Horizontal speed of a state, m/s. Local copy so this file stays standalone. */
function horizontalSpeed(state: PlayerState | undefined): number {
  if (!state || !state.velocity) return 0;
  const vx = state.velocity.x;
  const vz = state.velocity.z;
  return Math.sqrt(vx * vx + vz * vz);
}

/**
 * The hipfire cone half-angle for a stance and speed, in radians.
 * `hipSpreadMult` (the Laser) is already folded into the resolved values.
 */
export function hipfireCone(rw: ResolvedWeapon, state: PlayerState | undefined): number {
  const moving = horizontalSpeed(state) > HIPFIRE_MOVING_SPEED || (state ? !state.onGround : false);
  if (moving) return rw.hipSpreadMoving;
  const stance = state ? state.stance : Stance.Stand;
  if (stance === Stance.Crouch || stance === Stance.Prone) return rw.hipSpreadCrouch;
  if (stance === Stance.Slide) return rw.hipSpreadMoving;
  return rw.hipSpreadStand;
}

/**
 * Half-angle of the spread cone for a shot taken RIGHT NOW, in radians.
 *
 * EXACTLY ZERO at and above the accuracy lock — that is the quickscope. The
 * lock is measured against the RAW progress, never the eased one.
 *
 * Below the lock the cone interpolates linearly from the full hipfire cone (at
 * progress 0) down to 0 (at the lock). A shot 70% of the way in still carries
 * ~15% of the hipfire cone — for the Talon standing that is 0.95 degrees, about
 * a metre of error at 60m. Tighter than a hipfire, nowhere near free.
 *
 * The curve is SYMMETRIC: on the way back down the cone reopens along the same
 * raw progress it closed on. A player who releases ADS a frame before firing
 * still lands the shot, because the scope is still physically up — the sights do
 * not teleport back to the hip. What they DO forfeit is the quickscope flag,
 * which `shared/trickshot.ts` refuses for `AdsState.Lowering` on its own.
 */
export function spreadForShot(
  ws: WeaponRuntime,
  rw: ResolvedWeapon,
  state: PlayerState,
): number {
  const lock = rw.accuracyLockAt;
  if (lock > 0 && ws.adsProgress >= lock - EPS) return 0;

  const cone = hipfireCone(rw, state);
  if (ws.adsProgress <= 0 || lock <= 0) return cone;

  return cone * (1 - ws.adsProgress / lock);
}

/**
 * Rotate `dir` by a sample from a cone of half-angle `spread`.
 *
 * Both sides call THIS function with the same seeded RNG, so both sides get the
 * same bullet. Consumes exactly two values from the stream (see
 * `nextUnitCircle`) whether or not the spread is zero — an early return would
 * desynchronise the stream between a client that predicted a locked shot and a
 * server that resolved it a hair before the lock.
 */
export function applySpread(dir: Vec3, spread: number, rng: Rng, out: Vec3): Vec3 {
  const disc = rng.nextUnitCircle();

  let dx = dir.x;
  let dy = dir.y;
  let dz = dir.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len > 1e-12) {
    dx /= len;
    dy /= len;
    dz /= len;
  }

  if (!(spread > 0)) {
    out.x = dx;
    out.y = dy;
    out.z = dz;
    return out;
  }

  // Orthonormal basis around the aim direction.
  let ux = 0;
  let uy = 1;
  let uz = 0;
  if (dy > 0.99 || dy < -0.99) {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  let rx = dy * uz - dz * uy;
  let ry = dz * ux - dx * uz;
  let rz = dx * uy - dy * ux;
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rl > 1e-12) {
    rx /= rl;
    ry /= rl;
    rz /= rl;
  }
  const bx = ry * dz - rz * dy;
  const by = rz * dx - rx * dz;
  const bz = rx * dy - ry * dx;

  const t = Math.tan(spread);
  const ox = dx + (rx * disc.x + bx * disc.y) * t;
  const oy = dy + (ry * disc.x + by * disc.y) * t;
  const oz = dz + (rz * disc.x + bz * disc.y) * t;
  const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
  if (ol > 1e-12) {
    out.x = ox / ol;
    out.y = oy / ol;
    out.z = oz / ol;
  } else {
    out.x = dx;
    out.y = dy;
    out.z = dz;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PlayerState bridge
// ---------------------------------------------------------------------------

/**
 * Copy the replicated parts of the runtime onto a PlayerState.
 *
 * `PlayerState.actionEndsAt` is documented as a server time in MILLISECONDS,
 * while the runtime clock is in seconds since spawn; `nowMs` bridges the two.
 * Pass the server's current ms clock (or the client's render clock) — 0 is a
 * safe default and simply reports "idle".
 */
export function syncStateFromRuntime(
  state: PlayerState,
  ws: WeaponRuntime,
  nowMs = 0,
): PlayerState {
  state.activeWeapon = ws.weapon;
  state.adsState = ws.adsState;
  state.adsProgress = ws.adsProgress;
  state.ammoInMag = ws.ammoInMag;
  state.ammoReserve = ws.ammoReserve;
  state.actionEndsAt =
    ws.action === WeaponAction.Idle ? 0 : nowMs + (ws.actionEndsAt - ws.time) * 1000;
  return state;
}
