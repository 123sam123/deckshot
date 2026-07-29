/**
 * DECKSHOT — per-player input intake.
 *
 * Owner: netcode-core.
 *
 * Everything a client sends arrives here first, and the working assumption is
 * that the client is lying. The queue therefore does four jobs:
 *
 *  1. **Deduplicate.** Every packet carries INPUT_REDUNDANCY copies of recent
 *     inputs, so each seq is seen up to three times. Only the first counts.
 *  2. **Order with wrapping arithmetic.** Sequence numbers are 16 bit and
 *     wrap every 18 minutes at 60 Hz. `seqDiff` is used for every comparison;
 *     a naive `<` here is a guaranteed match-ending hang.
 *  3. **Bound.** The queue is a fixed ring. A client that floods inputs to
 *     buy itself a speed advantage fills the ring and gets its oldest inputs
 *     dropped, never the server's memory.
 *  4. **Sanitise.** Non-finite and out-of-range values never reach
 *     `applyMovement`, so one crafted packet cannot NaN-poison a snapshot.
 */

import { INPUT_BUFFER_SIZE } from '../../../shared/tuning.js';
import { PITCH_LIMIT } from '../../../shared/tuning.js';
import { emptyInput, seqDiff, type ClientInput } from '../../../shared/types.js';

/** Ring capacity. Half the client's prediction buffer is ample slack. */
export const INPUT_QUEUE_CAPACITY = INPUT_BUFFER_SIZE / 2;

/**
 * A jump larger than this is treated as a resynchronisation rather than as
 * ordinary loss: half a second of inputs is more than any real network gap the
 * redundancy scheme cannot cover, and accepting arbitrary jumps would let a
 * client skip its own history to dodge validation.
 */
export const MAX_SEQ_JUMP = 128;

export interface InputQueueStats {
  accepted: number;
  duplicates: number;
  dropped: number;
  resyncs: number;
  rejected: number;
}

export class InputQueue {
  private readonly ring: ClientInput[] = [];
  private head = 0;
  private tail = 0;
  private count = 0;

  /** Newest seq admitted so far. -1 until the first input. */
  private newestSeq = -1;

  readonly stats: InputQueueStats = {
    accepted: 0,
    duplicates: 0,
    dropped: 0,
    resyncs: 0,
    rejected: 0,
  };

  constructor(capacity: number = INPUT_QUEUE_CAPACITY) {
    for (let i = 0; i < capacity; i++) this.ring.push(emptyInput());
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.ring.length;
  }

  get latestSeq(): number {
    return this.newestSeq;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /** Forgets sequencing history. Used on respawn-into-a-new-session. */
  reset(): void {
    this.clear();
    this.newestSeq = -1;
  }

  /**
   * Offers one input. Returns true if it was queued.
   *
   * Rejection is never fatal on its own — a client behind a flaky NAT
   * produces plenty of duplicates — but the counters let the room escalate a
   * client that is only ever rejected.
   */
  push(input: ClientInput): boolean {
    if (!sanitize(input)) {
      this.stats.rejected++;
      return false;
    }

    if (this.newestSeq >= 0) {
      const d = seqDiff(input.seq, this.newestSeq);
      if (d <= 0) {
        // Already seen, or arrived out of order behind something newer.
        this.stats.duplicates++;
        return false;
      }
      if (d > MAX_SEQ_JUMP) {
        // The client's stream jumped. Start again from here rather than
        // pretend the missing ticks happened.
        this.clear();
        this.stats.resyncs++;
      }
    }

    if (this.count === this.ring.length) {
      // Full: drop the oldest so the newest input still lands. A player whose
      // packets are bursting should feel latency, not rubber-banding.
      this.head = (this.head + 1) % this.ring.length;
      this.count--;
      this.stats.dropped++;
    }

    const slot = this.ring[this.tail];
    slot.seq = input.seq;
    slot.tick = input.tick;
    slot.moveX = input.moveX;
    slot.moveZ = input.moveZ;
    slot.yaw = input.yaw;
    slot.pitch = input.pitch;
    slot.buttons = input.buttons;

    this.tail = (this.tail + 1) % this.ring.length;
    this.count++;
    this.newestSeq = input.seq;
    this.stats.accepted++;
    return true;
  }

  /** Oldest queued input without removing it. */
  peek(): ClientInput | null {
    return this.count === 0 ? null : this.ring[this.head];
  }

  /**
   * Removes and returns the oldest input.
   *
   * The returned object belongs to the ring and is valid until the queue wraps
   * back to that slot — which is `capacity` pushes away. Callers consume it
   * within the tick, so no copy is made.
   */
  shift(): ClientInput | null {
    if (this.count === 0) return null;
    const v = this.ring[this.head];
    this.head = (this.head + 1) % this.ring.length;
    this.count--;
    return v;
  }
}

/**
 * In-place validation. Returns false when the input is unusable.
 *
 * The codec already bounds every field by construction (i8 axes, u16 angles),
 * so this is the second line of defence — it matters for inputs that arrive
 * from anywhere else, including tests and future replay tooling.
 */
export function sanitize(input: ClientInput): boolean {
  if (!input) return false;
  if (!Number.isFinite(input.moveX) || !Number.isFinite(input.moveZ)) return false;
  if (!Number.isFinite(input.yaw) || !Number.isFinite(input.pitch)) return false;
  if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq > 0xffff) return false;

  input.moveX = clamp(input.moveX, -1, 1);
  input.moveZ = clamp(input.moveZ, -1, 1);
  input.pitch = clamp(input.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  input.buttons = (input.buttons | 0) & 0xffff;
  input.tick = Number.isFinite(input.tick) ? input.tick >>> 0 : 0;
  return true;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
