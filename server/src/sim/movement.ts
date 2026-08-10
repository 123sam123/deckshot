/**
 * DECKSHOT — server-side application of the shared movement function.
 *
 * Owned by: physics-movement.
 *
 * This is deliberately thin. The authoritative simulation IS `applyMovement`;
 * anything the server does differently would be a desync with the client's
 * prediction. What lives here is only what the client has no business doing:
 *
 *   - an anti-cheat floor: the position delta must be explainable by the
 *     velocity the server itself just computed, so a forged input can never
 *     produce a teleport;
 *   - non-finite state rejection, so one NaN cannot poison a snapshot;
 *   - out-of-bounds reporting, which the room logic turns into an
 *     `OOB_COUNTDOWN`. Killing the player is not decided here.
 */

import { applyMovement, type MovementState } from '../../../shared/movement.js';
import { isOutOfBounds, type CollisionWorld } from '../../../shared/collision.js';
import { STEP_HEIGHT } from '../../../shared/tuning.js';
import type { ClientInput } from '../../../shared/types.js';

export interface ServerMoveResult {
  state: MovementState;
  /**
   * The move did not follow from the simulation. The room should log it, and
   * repeated hits should be treated as a cheat signal — but a single one is
   * usually a symptom, not a cheater, so the caller decides the policy.
   */
  suspicious: boolean;
  /** Player is in the sea or outside WORLD_BOUNDS. Drives OOB_COUNTDOWN. */
  outOfBounds: boolean;
  /** True on the tick the player landed; forwarded for VFX/audio. */
  landed: boolean;
  /** Downward speed at landing, m/s. */
  impactSpeed: number;
}

/**
 * Slack added to the plausible per-tick displacement: one step-up plus the
 * collision skin and depenetration budget. Anything beyond this cannot come
 * out of `applyMovement`.
 */
const MOVE_SLACK = STEP_HEIGHT + 0.1;

/** Advances one player one tick under server authority. */
export function stepPlayerMovement(
  state: MovementState,
  input: ClientInput,
  dt: number,
  world: CollisionWorld
): ServerMoveResult {
  const before = state.position;
  const result = applyMovement(state, input, dt, world);
  const s = result.state;

  let suspicious = false;

  if (
    !Number.isFinite(s.position.x) ||
    !Number.isFinite(s.position.y) ||
    !Number.isFinite(s.position.z) ||
    !Number.isFinite(s.velocity.x) ||
    !Number.isFinite(s.velocity.y) ||
    !Number.isFinite(s.velocity.z)
  ) {
    // Poisoned state: snap back to where the player was and stop them dead.
    s.position.x = before.x;
    s.position.y = before.y;
    s.position.z = before.z;
    s.velocity.x = 0;
    s.velocity.y = 0;
    s.velocity.z = 0;
    return {
      state: s,
      suspicious: true,
      outOfBounds: false,
      landed: false,
      impactSpeed: 0,
    };
  }

  // The displacement has to be explainable by the speed at either end of the
  // tick. Velocity is server-computed and cannot be forged, so this is a hard
  // ceiling on teleports regardless of what the client sent.
  const dx = s.position.x - before.x;
  const dy = s.position.y - before.y;
  const dz = s.position.z - before.z;
  const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const vBefore = Math.sqrt(
    state.velocity.x * state.velocity.x +
      state.velocity.y * state.velocity.y +
      state.velocity.z * state.velocity.z
  );
  const vAfter = Math.sqrt(
    s.velocity.x * s.velocity.x + s.velocity.y * s.velocity.y + s.velocity.z * s.velocity.z
  );
  const allowed = (vBefore > vAfter ? vBefore : vAfter) * dt + MOVE_SLACK;
  if (moved > allowed) suspicious = true;

  return {
    state: s,
    suspicious,
    outOfBounds: isOutOfBounds(s.position, world),
    landed: result.landed,
    impactSpeed: result.impactSpeed,
  };
}
