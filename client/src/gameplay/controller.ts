/**
 * DECKSHOT — local input sampling.
 *
 * Owned by: physics-movement.
 *
 * Turns pointer-lock mouse deltas and key state into one `ClientInput` per
 * client tick. It does NOT import three, and it does NOT touch the network.
 *
 * Two rules that are not negotiable:
 *
 *  1. RAW MOUSE ONLY. No smoothing, no acceleration curve, no aim assist,
 *     ever. `movementX/movementY` go straight into the angle accumulator
 *     multiplied by a constant. There is no filter to tune because there is no
 *     filter.
 *  2. ABSOLUTE ANGLES. Deltas are accumulated locally between ticks and each
 *     `ClientInput` carries the resulting absolute yaw/pitch. A dropped input
 *     packet therefore cannot desync the player's aim — the next packet simply
 *     states where the crosshair is.
 */

import { InputButton, type ClientInput } from '../../../shared/types.js';
import {
  ADS_SENS_MULT_3_5X,
  ADS_SENS_MULT_8X,
  DEFAULT_SENSITIVITY,
  PITCH_LIMIT,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
} from '../../../shared/tuning.js';

// ---------------------------------------------------------------------------
// Binds
// ---------------------------------------------------------------------------

/**
 * Key bindings, by `KeyboardEvent.code` (layout independent — WASD stays where
 * W-A-S-D physically is on AZERTY too).
 */
export interface KeyBinds {
  forward: string;
  back: string;
  left: string;
  right: string;
  jump: string;
  crouch: string;
  /** Second crouch key. BO2-era muscle memory wants both Ctrl and C. */
  crouchAlt: string;
  sprint: string;
  reload: string;
  weaponPrimary: string;
  weaponSecondary: string;
  swap: string;
  melee: string;
  /** Held to select the secondary zoom level of Variable Zoom. */
  zoomToggle: string;
}

export const DEFAULT_BINDS: KeyBinds = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  crouch: 'ControlLeft',
  crouchAlt: 'KeyC',
  sprint: 'ShiftLeft',
  reload: 'KeyR',
  weaponPrimary: 'Digit1',
  weaponSecondary: 'Digit2',
  swap: 'KeyQ',
  melee: 'KeyV',
  zoomToggle: 'KeyB',
};

/** Scope zoom level, used only to scale mouse sensitivity while aiming. */
export enum ScopeZoom {
  None = 0,
  X3_5 = 1,
  X8 = 2,
}

const LS_SENSITIVITY = 'deckshot.sensitivity';
const LS_BINDS = 'deckshot.binds';

/**
 * Radians of view rotation per mouse count at sensitivity 1.0.
 * At DEFAULT_SENSITIVITY (2.4) this is ~0.30 degrees per count, which puts a
 * 360 at roughly 1200 counts — the range competitive players actually use.
 */
export const RAD_PER_COUNT = 0.0022;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class InputController {
  private readonly element: HTMLElement;
  private readonly doc: Document;

  private readonly down = new Set<string>();
  private mouseButtons = 0;

  private accumX = 0;
  private accumY = 0;

  private yawAngle = 0;
  private pitchAngle = 0;

  private sensitivity = DEFAULT_SENSITIVITY;
  private binds: KeyBinds = { ...DEFAULT_BINDS };
  private zoom: ScopeZoom = ScopeZoom.None;

  private seq = 0;
  private lockedFlag = false;
  private disposed = false;

  /** Fired whenever pointer lock is gained or lost, so the UI can pause. */
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(element: HTMLElement, opts?: { autoLockOnClick?: boolean }) {
    this.element = element;
    this.doc = element.ownerDocument;

    this.loadPrefs();

    this.doc.addEventListener('pointerlockchange', this.handleLockChange);
    this.doc.addEventListener('pointerlockerror', this.handleLockError);
    this.doc.addEventListener('keydown', this.handleKeyDown);
    this.doc.addEventListener('keyup', this.handleKeyUp);
    this.doc.addEventListener('mousemove', this.handleMouseMove);
    this.doc.addEventListener('mousedown', this.handleMouseDown);
    this.doc.addEventListener('mouseup', this.handleMouseUp);
    this.doc.addEventListener('visibilitychange', this.handleBlur);
    this.element.ownerDocument.defaultView?.addEventListener('blur', this.handleBlur);
    if (opts?.autoLockOnClick !== false) {
      this.element.addEventListener('click', this.handleClick);
    }
    // Right mouse is ADS; never let the browser menu eat it.
    this.element.addEventListener('contextmenu', this.handleContextMenu);
  }

  // --- pointer lock ------------------------------------------------------

  /** True while the pointer is locked to the canvas. */
  get locked(): boolean {
    return this.lockedFlag;
  }

  /** Request pointer lock. Must be called from a user gesture. */
  requestLock(): void {
    if (this.disposed || this.lockedFlag) return;
    const el = this.element as HTMLElement & { requestPointerLock?: () => void };
    el.requestPointerLock?.();
  }

  /** Release pointer lock (Escape does this natively too). */
  releaseLock(): void {
    if (this.doc.pointerLockElement === this.element) this.doc.exitPointerLock();
  }

  // --- settings ----------------------------------------------------------

  setSensitivity(v: number): void {
    const clamped = v < SENSITIVITY_MIN ? SENSITIVITY_MIN : v > SENSITIVITY_MAX ? SENSITIVITY_MAX : v;
    this.sensitivity = clamped;
    writeStorage(LS_SENSITIVITY, String(clamped));
  }

  getSensitivity(): number {
    return this.sensitivity;
  }

  /** Replaces one or more binds and persists the whole set. */
  setBinds(partial: Partial<KeyBinds>): void {
    this.binds = { ...this.binds, ...partial };
    writeStorage(LS_BINDS, JSON.stringify(this.binds));
  }

  getBinds(): Readonly<KeyBinds> {
    return this.binds;
  }

  /**
   * Tells the controller which zoom level is currently scoped, so mouse
   * sensitivity is scaled to keep the same on-screen travel per hand movement.
   * Called by the weapons/viewmodel layer when the ADS state changes.
   */
  setScopeZoom(zoom: ScopeZoom): void {
    this.zoom = zoom;
  }

  // --- angles ------------------------------------------------------------

  /** Absolute yaw the controller currently reports, radians. */
  get yaw(): number {
    return this.yawAngle;
  }

  /** Absolute pitch the controller currently reports, radians. */
  get pitch(): number {
    return this.pitchAngle;
  }

  /**
   * Force the view angles (respawn, killcam exit, server correction).
   * Clears any pending mouse motion so the snap is not immediately undone.
   */
  setAngles(yaw: number, pitch: number): void {
    this.yawAngle = wrapAngle(yaw);
    this.pitchAngle = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.accumX = 0;
    this.accumY = 0;
  }

  // --- sampling ----------------------------------------------------------

  /**
   * Produces the input for one client tick and consumes the accumulated mouse
   * motion. `tick` is the client's estimate of the server tick this input
   * applies to; the netcode layer supplies it.
   */
  sample(tick = 0): ClientInput {
    const scale = RAD_PER_COUNT * this.sensitivity * this.zoomSensMultiplier();
    this.yawAngle = wrapAngle(this.yawAngle - this.accumX * scale);
    this.pitchAngle = clamp(this.pitchAngle - this.accumY * scale, -PITCH_LIMIT, PITCH_LIMIT);
    this.accumX = 0;
    this.accumY = 0;

    let moveX = 0;
    let moveZ = 0;
    if (this.down.has(this.binds.forward)) moveZ += 1;
    if (this.down.has(this.binds.back)) moveZ -= 1;
    if (this.down.has(this.binds.right)) moveX += 1;
    if (this.down.has(this.binds.left)) moveX -= 1;

    let buttons = 0;
    if (this.down.has(this.binds.jump)) buttons |= InputButton.Jump;
    if (this.down.has(this.binds.crouch) || this.down.has(this.binds.crouchAlt)) {
      buttons |= InputButton.Crouch;
    }
    if (this.down.has(this.binds.sprint)) buttons |= InputButton.Sprint;
    if (this.down.has(this.binds.reload)) buttons |= InputButton.Reload;
    if (this.down.has(this.binds.melee)) buttons |= InputButton.Melee;
    if (
      this.down.has(this.binds.swap) ||
      this.down.has(this.binds.weaponPrimary) ||
      this.down.has(this.binds.weaponSecondary)
    ) {
      buttons |= InputButton.SwapWeapon;
    }
    if (this.down.has(this.binds.zoomToggle)) buttons |= InputButton.ZoomToggle;
    if ((this.mouseButtons & 1) !== 0) buttons |= InputButton.Fire;
    if ((this.mouseButtons & 2) !== 0) buttons |= InputButton.Ads;

    // Nothing may be held "through" a loss of focus.
    if (!this.lockedFlag) {
      moveX = 0;
      moveZ = 0;
      buttons = 0;
    }

    const input: ClientInput = {
      seq: this.seq,
      tick,
      moveX,
      moveZ,
      yaw: this.yawAngle,
      pitch: this.pitchAngle,
      buttons,
    };
    this.seq = (this.seq + 1) & 0xffff;
    return input;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.doc.removeEventListener('pointerlockchange', this.handleLockChange);
    this.doc.removeEventListener('pointerlockerror', this.handleLockError);
    this.doc.removeEventListener('keydown', this.handleKeyDown);
    this.doc.removeEventListener('keyup', this.handleKeyUp);
    this.doc.removeEventListener('mousemove', this.handleMouseMove);
    this.doc.removeEventListener('mousedown', this.handleMouseDown);
    this.doc.removeEventListener('mouseup', this.handleMouseUp);
    this.doc.removeEventListener('visibilitychange', this.handleBlur);
    this.element.ownerDocument.defaultView?.removeEventListener('blur', this.handleBlur);
    this.element.removeEventListener('click', this.handleClick);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);
    this.down.clear();
    this.mouseButtons = 0;
  }

  // --- internals ---------------------------------------------------------

  private zoomSensMultiplier(): number {
    if (this.zoom === ScopeZoom.X3_5) return ADS_SENS_MULT_3_5X;
    if (this.zoom === ScopeZoom.X8) return ADS_SENS_MULT_8X;
    return 1;
  }

  private loadPrefs(): void {
    const rawSens = readStorage(LS_SENSITIVITY);
    if (rawSens !== null) {
      const n = Number(rawSens);
      if (Number.isFinite(n)) {
        this.sensitivity = n < SENSITIVITY_MIN ? SENSITIVITY_MIN : n > SENSITIVITY_MAX ? SENSITIVITY_MAX : n;
      }
    }
    const rawBinds = readStorage(LS_BINDS);
    if (rawBinds !== null) {
      try {
        const parsed = JSON.parse(rawBinds) as Partial<KeyBinds>;
        if (parsed && typeof parsed === 'object') {
          const merged: KeyBinds = { ...DEFAULT_BINDS };
          for (const key of Object.keys(DEFAULT_BINDS) as (keyof KeyBinds)[]) {
            const v = parsed[key];
            if (typeof v === 'string' && v.length > 0) merged[key] = v;
          }
          this.binds = merged;
        }
      } catch {
        this.binds = { ...DEFAULT_BINDS };
      }
    }
  }

  private readonly handleClick = (): void => {
    if (!this.lockedFlag) this.requestLock();
  };

  private readonly handleContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private readonly handleLockChange = (): void => {
    const nowLocked = this.doc.pointerLockElement === this.element;
    if (nowLocked === this.lockedFlag) return;
    this.lockedFlag = nowLocked;
    if (!nowLocked) {
      // Escape was pressed (or focus was lost). Drop everything so the player
      // does not come back to a stuck key.
      this.down.clear();
      this.mouseButtons = 0;
      this.accumX = 0;
      this.accumY = 0;
    }
    this.onLockChange?.(nowLocked);
  };

  private readonly handleLockError = (): void => {
    this.lockedFlag = false;
    this.onLockChange?.(false);
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.lockedFlag) return;
    if (e.repeat) return;
    this.down.add(e.code);
    // Space and the arrow keys scroll the page otherwise.
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly handleMouseMove = (e: MouseEvent): void => {
    if (!this.lockedFlag) return;
    // Raw counts. No smoothing. No acceleration. No aim assist.
    this.accumX += e.movementX;
    this.accumY += e.movementY;
  };

  private readonly handleMouseDown = (e: MouseEvent): void => {
    if (!this.lockedFlag) return;
    this.mouseButtons |= 1 << e.button;
    e.preventDefault();
  };

  private readonly handleMouseUp = (e: MouseEvent): void => {
    this.mouseButtons &= ~(1 << e.button);
  };

  private readonly handleBlur = (): void => {
    this.down.clear();
    this.mouseButtons = 0;
    this.accumX = 0;
    this.accumY = 0;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* private mode / storage disabled — settings simply do not persist */
  }
}
