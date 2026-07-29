/**
 * DECKSHOT — the `Connection` implementation.
 *
 * Owner: netcode-core.
 *
 * `server/src/rooms/types.ts` declares `Connection` and everything above the
 * transport is written against it; this file is the only thing that knows a
 * WebSocket exists. That inversion is deliberate — the lobby layer is fully
 * testable without a socket, and the socket layer can be replaced (WebTransport,
 * a loopback pipe for tests) without touching a line of lobby code.
 *
 * The security posture is simple and absolute: **a malformed frame closes the
 * connection and nothing else.** Every decode is wrapped, every rate limit is
 * a token bucket with a hard ceiling, and a socket that will not drain its
 * send queue is dropped rather than allowed to grow the process heap.
 */

import { ServerMessage, type AnyClientMessage, type AnyServerMessage } from '../../../shared/protocol.js';
import { DecodeError, decodeClient, encodeServer } from '../../../shared/codec.js';
import type { Connection } from '../rooms/types.js';

/** The slice of the `ws` WebSocket API this file uses. Keeps tests honest. */
export interface SocketLike {
  readonly bufferedAmount: number;
  send(data: Uint8Array | ArrayBuffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
}

export interface ConnectionHandler {
  onMessage(conn: WsConnection, msg: AnyClientMessage): void;
  onClose(conn: WsConnection, reason: string): void;
}

export interface RateLimits {
  /** Frames per second. 60 Hz input plus cold-path slack. */
  messagesPerSecond: number;
  /** Bytes per second inbound. */
  bytesPerSecond: number;
  /** Non-hot-path frames per second (chat, lobby, loadout). */
  coldPerSecond: number;
  /** Outbound bytes queued in the OS/library before the socket is dropped. */
  maxBufferedBytes: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  messagesPerSecond: 240,
  bytesPerSecond: 64 * 1024,
  coldPerSecond: 30,
  maxBufferedBytes: 1 << 20,
};

/** A refilling token bucket. Bursts up to `capacity`, sustains `rate`/s. */
class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly capacity: number,
    now: number
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(n: number, now: number): boolean {
    const dt = (now - this.last) / 1000;
    if (dt > 0) {
      this.last = now;
      this.tokens = Math.min(this.capacity, this.tokens + dt * this.rate);
    }
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

let nextConnectionId = 1;

export class WsConnection implements Connection {
  readonly id: number;
  readonly remoteAddress: string;

  private readonly socket: SocketLike;
  private readonly handler: ConnectionHandler;
  private readonly limits: RateLimits;
  private readonly clock: () => number;

  private readonly msgBucket: TokenBucket;
  private readonly byteBucket: TokenBucket;
  private readonly coldBucket: TokenBucket;

  private closed = false;
  private closeReason = '';

  /** Set once the client has sent a valid Hello. Gates everything else. */
  helloReceived = false;
  /** Opaque slot for the dispatcher's per-connection session bookkeeping. */
  session: unknown = null;

  // --- diagnostics -------------------------------------------------------
  bytesIn = 0;
  bytesOut = 0;
  messagesIn = 0;
  messagesOut = 0;
  lastMessageAtMs: number;

  constructor(
    socket: SocketLike,
    handler: ConnectionHandler,
    opts: { remoteAddress?: string; limits?: Partial<RateLimits>; now?: () => number } = {}
  ) {
    this.id = nextConnectionId++;
    this.socket = socket;
    this.handler = handler;
    this.limits = { ...DEFAULT_RATE_LIMITS, ...opts.limits };
    this.clock = opts.now ?? (() => Date.now());
    this.remoteAddress = opts.remoteAddress ?? 'unknown';

    const now = this.clock();
    this.lastMessageAtMs = now;
    this.msgBucket = new TokenBucket(this.limits.messagesPerSecond, this.limits.messagesPerSecond, now);
    this.byteBucket = new TokenBucket(this.limits.bytesPerSecond, this.limits.bytesPerSecond, now);
    this.coldBucket = new TokenBucket(this.limits.coldPerSecond, this.limits.coldPerSecond * 2, now);

    socket.on('message', this.handleMessage);
    socket.on('close', this.handleClose);
    socket.on('error', this.handleError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(msg: AnyServerMessage): void {
    if (this.closed) return;
    let buf: ArrayBuffer;
    try {
      buf = encodeServer(msg);
    } catch (err) {
      // Encoding our own message failed: that is a server bug, not a client
      // one. Drop the frame, keep the match alive.
      console.error('[deckshot] encode failed', err);
      return;
    }

    // Backpressure. Snapshots are the only droppable traffic: the next one is
    // 50 ms away and is a superset. Everything else is a fact the client
    // cannot reconstruct, so a socket that cannot take it is a dead socket.
    if (this.socket.bufferedAmount > this.limits.maxBufferedBytes) {
      if (msg.type === ServerMessage.Snapshot) return;
      this.close('backpressure');
      return;
    }

    this.bytesOut += buf.byteLength;
    this.messagesOut++;
    try {
      this.socket.send(new Uint8Array(buf));
    } catch {
      this.close('send failed');
    }
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason ?? '';
    try {
      this.socket.close(1000, reason ? reason.slice(0, 120) : undefined);
    } catch {
      this.socket.terminate?.();
    }
    this.handler.onClose(this, this.closeReason);
  }

  private readonly handleMessage = (data: unknown, isBinary: boolean): void => {
    if (this.closed) return;
    const now = this.clock();
    this.lastMessageAtMs = now;

    if (!isBinary) {
      // The protocol is binary frames only. A text frame is either a bug or a
      // probe; neither deserves a parse attempt.
      this.close('text frame');
      return;
    }

    const bytes = toBytes(data);
    if (!bytes) {
      this.close('unreadable frame');
      return;
    }

    this.bytesIn += bytes.byteLength;
    this.messagesIn++;

    if (!this.msgBucket.take(1, now) || !this.byteBucket.take(bytes.byteLength, now)) {
      this.close('rate limit');
      return;
    }

    let msg: AnyClientMessage;
    try {
      msg = decodeClient(bytes);
    } catch (err) {
      if (err instanceof DecodeError) this.close('malformed frame');
      else this.close('decode error');
      return;
    }

    // Cold-path budget, on top of the global one. A client cannot spend its
    // whole 240 msg/s allowance on chat and lobby churn.
    if (!isHotPath(msg) && !this.coldBucket.take(1, now)) {
      this.close('cold path rate limit');
      return;
    }

    try {
      this.handler.onMessage(this, msg);
    } catch (err) {
      console.error('[deckshot] handler threw', err);
      this.close('internal error');
    }
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.handler.onClose(this, this.closeReason || 'peer closed');
  };

  private readonly handleError = (): void => {
    this.close('socket error');
  };
}

function isHotPath(msg: AnyClientMessage): boolean {
  return msg.type === 10 /* Input */ || msg.type === 11 /* Pong */;
}

/**
 * `ws` hands us a Buffer, an ArrayBuffer, or an array of Buffers depending on
 * how the frame arrived. A Buffer is usually a view into a shared pool, so the
 * byteOffset matters — reading it as a whole ArrayBuffer is a classic source
 * of "the first message works and the rest are garbage".
 */
export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    let total = 0;
    for (const part of data) {
      if (!(part instanceof Uint8Array)) return null;
      total += part.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of data as Uint8Array[]) {
      out.set(part, off);
      off += part.byteLength;
    }
    return out;
  }
  return null;
}
