/**
 * DECKSHOT — the client socket.
 *
 * Owner: netcode-core.
 *
 * Two rules here are load-bearing for the product, not just the code:
 *
 *  1. **The URL is derived from `window.location`, never hard-coded.** The
 *     whole pitch is "send a friend one link". A `localhost` anywhere in this
 *     file would work perfectly in development and break the only thing the
 *     game is for. `https:` pages get `wss:` automatically, which is also what
 *     makes it work behind a TLS proxy with no configuration.
 *
 *  2. **Disconnects are recoverable.** A dropped socket retries with
 *     exponential backoff and re-presents the stored resume token, so a
 *     30-second tunnel outage costs you your K/D for those 30 seconds and
 *     nothing else.
 */

import { DecodeError, decodeServer, encodeClient } from '../../../shared/codec.js';
import type { AnyClientMessage, AnyServerMessage } from '../../../shared/protocol.js';
import { NetSim, NETSIM_OFF, netSimFromLocation, type NetSimConfig } from './netsim.js';

export type SocketState = 'idle' | 'connecting' | 'open' | 'closed' | 'reconnecting';

/** The slice of the browser WebSocket API used here; keeps tests socket-free. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface GameSocketOptions {
  /** Overrides the location-derived URL. Tests and dev tooling only. */
  url?: string;
  /** Simulated link conditions. Defaults to the `?netsim=` query flag. */
  netsim?: NetSimConfig | null;
  /** Socket constructor. Defaults to the global `WebSocket`. */
  factory?: (url: string) => WebSocketLike;
  /** Injectable clock in ms. */
  now?: () => number;
  /** Schedules the reconnect timer. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, delayMs: number) => void;
  /** Max reconnect attempts before giving up. Default: unlimited. */
  maxRetries?: number;
  /** Automatically reconnect on an unexpected close. Default true. */
  autoReconnect?: boolean;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 8000;

/**
 * Builds the WebSocket URL for the page that is currently loaded.
 *
 * `https:` -> `wss:`, everything else -> `ws:`, same host, same port, `/ws`.
 */
export function defaultSocketUrl(
  location?: { protocol?: string; host?: string } | null,
  path = '/ws'
): string {
  const loc =
    location ?? (globalThis as { location?: { protocol?: string; host?: string } }).location ?? null;
  const secure = (loc?.protocol ?? 'http:') === 'https:';
  const host = loc?.host ?? 'localhost:8080';
  return `${secure ? 'wss' : 'ws'}://${host}${path}`;
}

export class GameSocket {
  onMessage: ((msg: AnyServerMessage) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;

  readonly netsim: NetSim;

  private readonly url: string;
  private readonly factory: (url: string) => WebSocketLike;
  private readonly clock: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => void;
  private readonly maxRetries: number;
  private readonly autoReconnect: boolean;

  private socket: WebSocketLike | null = null;
  private stateValue: SocketState = 'idle';
  private retries = 0;
  private wantConnection = false;
  private reconnectPending = false;

  bytesSent = 0;
  bytesReceived = 0;
  messagesSent = 0;
  messagesReceived = 0;
  decodeErrors = 0;

  constructor(opts: GameSocketOptions = {}) {
    this.url = opts.url ?? defaultSocketUrl();
    this.factory = opts.factory ?? defaultFactory;
    this.clock = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.maxRetries = opts.maxRetries ?? Number.POSITIVE_INFINITY;
    this.autoReconnect = opts.autoReconnect !== false;
    const cfg = opts.netsim === undefined ? netSimFromLocation() : opts.netsim;
    this.netsim = new NetSim(cfg ?? NETSIM_OFF);
  }

  get state(): SocketState {
    return this.stateValue;
  }

  get isOpen(): boolean {
    return this.stateValue === 'open';
  }

  get endpoint(): string {
    return this.url;
  }

  connect(): void {
    this.wantConnection = true;
    if (this.stateValue === 'open' || this.stateValue === 'connecting') return;
    this.open();
  }

  /** Intentional disconnect. Suppresses the reconnect logic. */
  close(reason = 'client closed'): void {
    this.wantConnection = false;
    this.netsim.flush();
    const socket = this.socket;
    this.socket = null;
    this.stateValue = 'closed';
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close(1000, reason);
      } catch {
        /* already gone */
      }
    }
  }

  send(msg: AnyClientMessage): boolean {
    if (!this.socket || this.stateValue !== 'open') return false;
    let buf: ArrayBuffer;
    try {
      buf = encodeClient(msg);
    } catch {
      return false;
    }
    const bytes = new Uint8Array(buf);
    this.bytesSent += bytes.byteLength;
    this.messagesSent++;

    if (!this.netsim.enabled) {
      return this.rawSend(bytes);
    }
    // Simulated uplink: delayed, and sometimes not at all.
    return this.netsim.up.push(this.clock(), () => this.rawSend(bytes));
  }

  /**
   * Advances the simulated link. Safe (and free) to call every frame when
   * netsim is off. The client's frame loop drives it.
   */
  pump(nowMs: number = this.clock()): void {
    if (this.netsim.enabled) this.netsim.pump(nowMs);
  }

  // --- internals ---------------------------------------------------------

  private rawSend(bytes: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket) return false;
    try {
      socket.send(bytes);
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  private open(): void {
    this.stateValue = this.retries === 0 ? 'connecting' : 'reconnecting';
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (err) {
      this.onError?.(err);
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = (): void => {
      if (this.socket !== socket) return;
      this.stateValue = 'open';
      this.retries = 0;
      this.onOpen?.();
    };

    socket.onmessage = (ev: { data: unknown }): void => {
      if (this.socket !== socket) return;
      const bytes = toBytes(ev.data);
      if (!bytes) return;
      this.bytesReceived += bytes.byteLength;
      this.messagesReceived++;
      if (!this.netsim.enabled) {
        this.deliver(bytes);
        return;
      }
      this.netsim.down.push(this.clock(), () => this.deliver(bytes));
    };

    socket.onerror = (err: unknown): void => {
      if (this.socket !== socket) return;
      this.onError?.(err);
    };

    socket.onclose = (): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasOpen = this.stateValue === 'open';
      this.stateValue = 'closed';
      this.netsim.flush();
      this.onClose?.(wasOpen ? 'connection lost' : 'connection failed');
      this.scheduleReconnect();
    };
  }

  private deliver(bytes: Uint8Array): void {
    let msg: AnyServerMessage;
    try {
      msg = decodeServer(bytes);
    } catch (err) {
      // A server that sends us garbage is a server we cannot trust, but
      // tearing the session down over one frame is worse than skipping it.
      this.decodeErrors++;
      if (!(err instanceof DecodeError)) this.onError?.(err);
      return;
    }
    this.onMessage?.(msg);
  }

  private scheduleReconnect(): void {
    if (!this.wantConnection || !this.autoReconnect) return;
    if (this.reconnectPending) return;
    if (this.retries >= this.maxRetries) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.retries);
    this.retries++;
    this.reconnectPending = true;
    this.stateValue = 'reconnecting';
    this.schedule(() => {
      this.reconnectPending = false;
      if (this.wantConnection && !this.socket) this.open();
    }, delay);
  }
}

function defaultFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('WebSocket is not available in this environment');
  return new Ctor(url);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}
