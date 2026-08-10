/**
 * DECKSHOT — local input sampling.
 *
 * `InputController` is the one place where a browser event becomes a
 * `ClientInput`, and a mistake here is invisible to every other test in the
 * suite: the simulation is handed a perfectly valid bitfield, it just says the
 * wrong thing. ADS spent the project bound to the scroll wheel for exactly
 * that reason — `MouseEvent.button` (0/1/2) accumulated into a mask that was
 * then read with `MouseEvent.buttons` numbering (1/2/4), which agrees on left
 * click and disagrees on everything else.
 *
 * The DOM is stubbed rather than emulated. Only the four surfaces the
 * controller actually touches are provided, so the controller itself runs
 * completely unmodified.
 */

import { describe, expect, it } from 'vitest';

import { InputController } from '../client/src/gameplay/controller.js';
import { InputButton } from '../shared/types.js';

// ---------------------------------------------------------------------------
// A DOM, in as few lines as the controller will accept
// ---------------------------------------------------------------------------

type Handler = (e: Record<string, unknown>) => void;

class FakeTarget {
  private readonly handlers = new Map<string, Set<Handler>>();

  addEventListener(type: string, h: Handler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(h);
  }

  removeEventListener(type: string, h: Handler): void {
    this.handlers.get(type)?.delete(h);
  }

  dispatch(type: string, e: Record<string, unknown> = {}): void {
    const event = { preventDefault() {}, ...e };
    for (const h of [...(this.handlers.get(type) ?? [])]) h(event);
  }
}

class FakeDocument extends FakeTarget {
  pointerLockElement: unknown = null;
  readonly defaultView = new FakeTarget();
  exitPointerLock(): void {
    this.pointerLockElement = null;
    this.dispatch('pointerlockchange');
  }
}

class FakeCanvas extends FakeTarget {
  ownerDocument: FakeDocument;

  constructor(doc: FakeDocument) {
    super();
    this.ownerDocument = doc;
  }

  /** Pointer lock is granted synchronously here; the real one is async. */
  requestPointerLock(): void {
    this.ownerDocument.pointerLockElement = this;
    this.ownerDocument.dispatch('pointerlockchange');
  }
}

/** A controller with the pointer already locked, as in an active match. */
function locked() {
  const doc = new FakeDocument();
  const canvas = new FakeCanvas(doc);
  const controller = new InputController(canvas as unknown as HTMLElement);
  canvas.dispatch('click'); // what actually locks the pointer in game
  expect(controller.locked).toBe(true);
  return { controller, canvas, doc };
}

/** MouseEvent.button values. Not MouseEvent.buttons — that is the whole point. */
const LEFT = 0;
const MIDDLE = 1;
const RIGHT = 2;

const held = (flags: number, b: InputButton) => (flags & b) !== 0;

// ---------------------------------------------------------------------------

describe('mouse buttons', () => {
  it('binds fire to the LEFT button', () => {
    const { controller, doc } = locked();
    doc.dispatch('mousedown', { button: LEFT });
    expect(held(controller.sample().buttons, InputButton.Fire)).toBe(true);
  });

  it('binds ADS to the RIGHT button', () => {
    const { controller, doc } = locked();
    doc.dispatch('mousedown', { button: RIGHT });

    const buttons = controller.sample().buttons;
    expect(held(buttons, InputButton.Ads)).toBe(true);
    expect(held(buttons, InputButton.Fire)).toBe(false);
  });

  it('binds nothing to the MIDDLE button — the regression this file exists for', () => {
    const { controller, doc } = locked();
    doc.dispatch('mousedown', { button: MIDDLE });

    const buttons = controller.sample().buttons;
    expect(held(buttons, InputButton.Ads)).toBe(false);
    expect(held(buttons, InputButton.Fire)).toBe(false);
  });

  it('reports both when quickscoping — right held, left tapped', () => {
    const { controller, doc } = locked();
    doc.dispatch('mousedown', { button: RIGHT });
    doc.dispatch('mousedown', { button: LEFT });

    const buttons = controller.sample().buttons;
    expect(held(buttons, InputButton.Ads)).toBe(true);
    expect(held(buttons, InputButton.Fire)).toBe(true);
  });

  it('releases on mouseup', () => {
    const { controller, doc } = locked();
    doc.dispatch('mousedown', { button: RIGHT });
    expect(held(controller.sample().buttons, InputButton.Ads)).toBe(true);

    doc.dispatch('mouseup', { button: RIGHT });
    expect(held(controller.sample().buttons, InputButton.Ads)).toBe(false);
  });
});

describe('pointer lock gates everything', () => {
  it('reports no input at all while unlocked', () => {
    const doc = new FakeDocument();
    const canvas = new FakeCanvas(doc);
    const controller = new InputController(canvas as unknown as HTMLElement);

    doc.dispatch('mousedown', { button: RIGHT });
    doc.dispatch('keydown', { code: 'KeyW', repeat: false });

    const input = controller.sample();
    expect(input.buttons).toBe(0);
    expect(input.moveZ).toBe(0);
  });

  it('drops held buttons when lock is lost, so nothing sticks on Escape', () => {
    const { controller, doc } = locked();
    doc.dispatch('mousedown', { button: RIGHT });
    doc.dispatch('keydown', { code: 'KeyW', repeat: false });

    doc.exitPointerLock();
    expect(controller.locked).toBe(false);

    // Re-lock without touching the mouse: the scope must not still be up.
    doc.dispatch('click');
    const input = controller.sample();
    expect(input.buttons).toBe(0);
    expect(input.moveZ).toBe(0);
  });
});

describe('movement keys', () => {
  it('maps WASD to the movement axes', () => {
    const { controller, doc } = locked();
    doc.dispatch('keydown', { code: 'KeyW', repeat: false });
    doc.dispatch('keydown', { code: 'KeyD', repeat: false });

    const input = controller.sample();
    expect(input.moveZ).toBe(1);
    expect(input.moveX).toBe(1);
  });

  it('maps both crouch binds, because the slide lives on them', () => {
    const ctrl = locked();
    ctrl.doc.dispatch('keydown', { code: 'ControlLeft', repeat: false });
    expect(held(ctrl.controller.sample().buttons, InputButton.Crouch)).toBe(true);

    const c = locked();
    c.doc.dispatch('keydown', { code: 'KeyC', repeat: false });
    expect(held(c.controller.sample().buttons, InputButton.Crouch)).toBe(true);
  });

  it('maps sprint to shift, so shift+ctrl can start a slide', () => {
    const { controller, doc } = locked();
    doc.dispatch('keydown', { code: 'KeyW', repeat: false });
    doc.dispatch('keydown', { code: 'ShiftLeft', repeat: false });
    doc.dispatch('keydown', { code: 'ControlLeft', repeat: false });

    const buttons = controller.sample().buttons;
    expect(held(buttons, InputButton.Sprint)).toBe(true);
    expect(held(buttons, InputButton.Crouch)).toBe(true);
  });
});
