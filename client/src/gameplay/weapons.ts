/**
 * DECKSHOT — predicted local weapon state.
 *
 * Owner: weapons-hitreg.
 *
 * The local player's gun must respond on the frame the mouse button goes down.
 * Waiting ~50ms for the server to agree is the single most noticeable thing a
 * networked shooter can get wrong, and it is fatal in a mode whose whole appeal
 * is a 0.2 second flick. So this module runs the SAME `advanceWeapon` the server
 * runs, immediately, and reconciles when the server disagrees.
 *
 * What it does NOT do:
 *   - decide whether a shot hit anything (the server owns that, always)
 *   - import the renderer or the viewmodel. It exposes state; integration wires
 *     it to whatever wants to draw. The one client module it touches is the
 *     input controller, and only to tell it the scope zoom so `ADS_SENS_MULT_*`
 *     applies to the mouse.
 */

import { ScopeZoom } from './controller.js';
import type { CorrectionMsg, SnapshotPlayer } from '../../../shared/protocol.js';
import {
  FOV_IRONSIGHT,
  FOV_SCOPED_3_5X,
  FOV_SCOPED_8X,
  FOV_WORLD,
  INPUT_BUFFER_SIZE,
} from '../../../shared/tuning.js';
import {
  WeaponAction,
  advanceWeapon,
  cloneWeaponRuntime,
  easeAds,
  createWeaponRuntime,
  resolveLoadout,
  resolveSecondary,
  resolveWeapon,
  spreadForShot,
  type ResolvedWeapon,
  type WeaponRuntime,
} from '../../../shared/weapons.js';
import { AdsState, DEFAULT_LOADOUT, WeaponId } from '../../../shared/types.js';
import type { ClientInput, InputSeq, Loadout, PlayerState } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export enum WeaponEventType {
  Fire = 0,
  DryFire = 1,
  ReloadStart = 2,
  ReloadEnd = 3,
  SwapStart = 4,
  SwapEnd = 5,
  Melee = 6,
  AdsIn = 7,
  AdsOut = 8,
  ZoomChange = 9,
}

/**
 * Something the player should see or hear RIGHT NOW. Drained once per frame by
 * whatever owns the viewmodel and the audio graph.
 *
 * Events are produced only by live prediction, never by reconciliation replay —
 * replaying a corrected input stream must not fire the muzzle flash a second
 * time.
 */
export interface WeaponEvent {
  type: WeaponEventType;
  /** Runtime clock, seconds. */
  time: number;
  weapon: WeaponId;
  ammoInMag: number;
  /** ReloadStart only: the slower empty-magazine variant. */
  empty: boolean;
  /** ZoomChange only. */
  zoom: ScopeZoom;
}

/**
 * The one thing this module needs from the input controller. Structural, so
 * tests (and any future controller) can satisfy it without a DOM.
 */
export interface ScopeZoomSink {
  setScopeZoom(zoom: ScopeZoom): void;
}

/** Above this eased ADS progress the scope is "up" for sensitivity purposes. */
const ZOOM_ENGAGE = 0.5;

// ---------------------------------------------------------------------------
// Predicted weapons
// ---------------------------------------------------------------------------

interface HistoryEntry {
  seq: InputSeq;
  /** Runtime BEFORE the input at `seq` was applied. */
  before: WeaponRuntime;
}

export class PredictedWeapons {
  private primary: ResolvedWeapon;
  private secondary: ResolvedWeapon;
  private state: WeaponRuntime;
  private loadoutRef: Loadout;

  private readonly controller: ScopeZoomSink | null;
  private zoomState: ScopeZoom = ScopeZoom.None;

  private events: WeaponEvent[] = [];
  /** Suppressed while replaying a corrected input stream. */
  private emitting = true;

  private history: HistoryEntry[] = [];

  constructor(loadout: Loadout = DEFAULT_LOADOUT, controller: ScopeZoomSink | null = null) {
    this.loadoutRef = loadout;
    this.primary = resolveLoadout(loadout);
    this.secondary = resolveSecondary(loadout);
    this.state = createWeaponRuntime(this.primary);
    this.controller = controller;
  }

  // --- accessors -----------------------------------------------------------

  /** The resolved spec for the weapon currently in hand. */
  get resolved(): ResolvedWeapon {
    return this.state.weapon === this.primary.id ? this.primary : this.secondary;
  }

  get runtime(): WeaponRuntime {
    return this.state;
  }

  get loadout(): Loadout {
    return this.loadoutRef;
  }

  /**
   * EASED ADS progress, 0..1 — for the camera FOV lerp and the viewmodel pose.
   * NOT the value `accuracyLockAt` is measured against; that is
   * `runtime.adsProgress`, the raw linear one.
   */
  get adsEased(): number {
    return this.state.adsEased;
  }

  get adsState(): AdsState {
    return this.state.adsState;
  }

  get zoom(): ScopeZoom {
    return this.zoomState;
  }

  get ammoInMag(): number {
    return this.state.ammoInMag;
  }

  get ammoReserve(): number {
    return this.state.ammoReserve;
  }

  /** True while a reload / swap / melee animation owns the gun. */
  get busy(): boolean {
    return this.state.action !== WeaponAction.Idle && this.state.action !== WeaponAction.Cycling;
  }

  /** Current spread cone half-angle for the crosshair bloom. 0 when locked. */
  spread(state: PlayerState): number {
    return spreadForShot(this.state, this.resolved, state);
  }

  // --- loadout -------------------------------------------------------------

  /**
   * Swap in a new loadout. Resets the runtime — this only happens between lives.
   * The caller should also push `rw.adsMoveSpeed` onto the player state via
   * `applyLoadoutToState` so movement picks up the Lightweight Stock.
   */
  setLoadout(loadout: Loadout): void {
    this.loadoutRef = loadout;
    this.primary = resolveLoadout(loadout);
    this.secondary = resolveSecondary(loadout);
    this.state = createWeaponRuntime(this.primary);
    this.history.length = 0;
    this.updateZoom(true);
  }

  /** Full reset on respawn, keeping the loadout. */
  reset(): void {
    this.state = createWeaponRuntime(this.primary);
    this.history.length = 0;
    this.updateZoom(true);
  }

  // --- prediction ----------------------------------------------------------

  /**
   * Advance the predicted weapon by one client tick.
   *
   * Call it with the same `input` and `dt` handed to `applyMovement`, on every
   * tick, in order. Returns the new runtime (also available as `.runtime`).
   */
  update(input: ClientInput, dt: number): WeaponRuntime {
    this.pushHistory(input.seq, this.state);

    const rw = this.resolved;
    const before = this.state;
    const next = advanceWeapon(before, input, dt, rw);
    this.state = next;
    this.emitFor(before, next);
    this.updateZoom(false);
    return next;
  }

  // --- camera --------------------------------------------------------------

  /**
   * The world FOV this frame: `FOV_WORLD` at the hip, lerped by the EASED ADS
   * progress toward whichever scope the loadout resolved to.
   *
   * Iron Sight Swap barely zooms (`FOV_IRONSIGHT`, 64 degrees); Variable Zoom
   * drops to `FOV_SCOPED_8X` while the zoom button is held and the scope is
   * fully up; everything else is the default 3.5x.
   */
  worldFov(): number {
    return FOV_WORLD + (this.scopedFov() - FOV_WORLD) * this.state.adsEased;
  }

  /** The fully-scoped FOV for the current weapon and zoom level. */
  scopedFov(): number {
    const rw = this.resolved;
    if (rw.ironSights) return FOV_IRONSIGHT;
    if (rw.variableZoom && this.state.zoomLevel === 1) return FOV_SCOPED_8X;
    return FOV_SCOPED_3_5X;
  }

  /**
   * Recompute the scope zoom and, when it changed, tell the input controller so
   * `ADS_SENS_MULT_3_5X` / `ADS_SENS_MULT_8X` scale the mouse. Without this the
   * player's aim gets 3.5x more sensitive the moment the scope comes up, which
   * makes precise flicks impossible.
   */
  private updateZoom(force: boolean): void {
    const rw = this.resolved;
    let next = ScopeZoom.None;
    if (this.state.adsEased >= ZOOM_ENGAGE && !rw.ironSights) {
      next = rw.variableZoom && this.state.zoomLevel === 1 ? ScopeZoom.X8 : ScopeZoom.X3_5;
    }
    if (!force && next === this.zoomState) return;
    this.zoomState = next;
    if (this.controller) this.controller.setScopeZoom(next);
    if (!force) this.emit(WeaponEventType.ZoomChange, next);
  }

  // --- events --------------------------------------------------------------

  /** Drain the pending effect events. The caller owns them after this. */
  consumeEvents(): WeaponEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(type: WeaponEventType, zoom: ScopeZoom = ScopeZoom.None, empty = false): void {
    if (!this.emitting) return;
    this.events.push({
      type,
      time: this.state.time,
      weapon: this.state.weapon,
      ammoInMag: this.state.ammoInMag,
      empty,
      zoom,
    });
  }

  private emitFor(before: WeaponRuntime, after: WeaponRuntime): void {
    if (!this.emitting) return;
    if (after.firedThisTick) this.emit(WeaponEventType.Fire);
    if (after.dryFiredThisTick) this.emit(WeaponEventType.DryFire);
    if (after.reloadStartedThisTick) {
      this.emit(WeaponEventType.ReloadStart, ScopeZoom.None, after.reloadEmpty);
    }
    if (after.reloadEndedThisTick) this.emit(WeaponEventType.ReloadEnd);
    if (after.swapStartedThisTick) this.emit(WeaponEventType.SwapStart);
    if (after.swapEndedThisTick) this.emit(WeaponEventType.SwapEnd);
    if (after.meleeThisTick) this.emit(WeaponEventType.Melee);

    const wasAiming = before.adsState === AdsState.Raising || before.adsState === AdsState.Scoped;
    const isAimingNow = after.adsState === AdsState.Raising || after.adsState === AdsState.Scoped;
    if (isAimingNow && !wasAiming) this.emit(WeaponEventType.AdsIn);
    if (!isAimingNow && wasAiming) this.emit(WeaponEventType.AdsOut);
  }

  // --- reconciliation ------------------------------------------------------

  private pushHistory(seq: InputSeq, before: WeaponRuntime): void {
    this.history.push({ seq, before: cloneWeaponRuntime(before) });
    if (this.history.length > INPUT_BUFFER_SIZE) {
      this.history.splice(0, this.history.length - INPUT_BUFFER_SIZE);
    }
  }

  /** The predicted runtime as it stood just before input `seq` was applied. */
  runtimeBefore(seq: InputSeq): WeaponRuntime | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].seq === seq) return this.history[i].before;
    }
    return null;
  }

  /**
   * The server rejected something we predicted. Rewind to the state before the
   * offending input, take the server's word for the replicated fields, and
   * replay everything after it.
   *
   * Effects are suppressed during the replay: the muzzle flash for those inputs
   * already played once. A rejected shot cannot be un-fired visually — the
   * hitmarker simply never arrives — but it must not double up either.
   *
   * `pendingInputs` is the client's unacknowledged input buffer (netcode owns
   * it); anything at or before `correction.seq` is ignored.
   */
  reconcile(
    correction: CorrectionMsg,
    pendingInputs: readonly ClientInput[],
    dt: number,
  ): void {
    const rewound = this.runtimeBefore(correction.seq);
    if (rewound) this.state = cloneWeaponRuntime(rewound);

    this.applyServerState(correction.state);

    const trimmed: HistoryEntry[] = [];
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i].seq === correction.seq) break;
      trimmed.push(this.history[i]);
    }
    this.history = trimmed;

    this.emitting = false;
    try {
      for (let i = 0; i < pendingInputs.length; i++) {
        const input = pendingInputs[i];
        if (input.seq === correction.seq) continue; // the rejected one, dropped
        this.pushHistory(input.seq, this.state);
        this.state = advanceWeapon(this.state, input, dt, this.resolved);
      }
    } finally {
      this.emitting = true;
    }
    this.updateZoom(true);
  }

  /**
   * Snap the replicated weapon fields to the server's version.
   *
   * Only the fields the snapshot actually carries are taken; the local clock,
   * ammo reserve, sway phase and — critically — `timeSinceAccuracyLock` are
   * kept, because they are derived from the input stream that is about to be
   * replayed and the snapshot has no room for them.
   */
  applyServerState(s: SnapshotPlayer | undefined): void {
    if (!s) return;
    if (s.activeWeapon !== this.state.weapon && s.activeWeapon !== undefined) {
      // The server thinks we are holding the other gun. Believe it.
      const stowed = this.state.weapon;
      this.state.weapon = s.activeWeapon;
      this.state.stowedWeapon = stowed;
      this.state.action = WeaponAction.Idle;
      this.state.actionEndsAt = 0;
    }
    if (Number.isFinite(s.adsProgress)) {
      this.state.adsProgress = s.adsProgress;
      this.state.adsEased = easeAds(s.adsProgress);
    }
    if (s.adsState !== undefined) this.state.adsState = s.adsState;
    if (this.state.adsState === AdsState.Hip || this.state.adsState === AdsState.Lowering) {
      this.state.timeSinceAccuracyLock = Number.POSITIVE_INFINITY;
      this.state.adsHoldTime = 0;
    }
  }

  /**
   * Adopt the server's ammo counts, which the snapshot does not replicate.
   * Called by the net layer when a Correction or a fresh spawn tells it to.
   */
  setAmmo(inMag: number, reserve: number): void {
    this.state.ammoInMag = inMag;
    this.state.ammoReserve = reserve;
  }
}

/** Convenience for UI that needs a spec without owning a PredictedWeapons. */
export function specFor(loadout: Loadout | undefined, weapon: WeaponId): ResolvedWeapon {
  return resolveWeapon(weapon, loadout ? loadout.attachments : []);
}
