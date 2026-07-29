/**
 * DECKSHOT — NetClient.
 *
 * Owner: netcode-core.
 *
 * The single object the rest of the client talks to. It owns the socket, the
 * prediction buffer, the snapshot buffer, and the input redundancy window, and
 * it exposes exactly two clocks to the rest of the game:
 *
 *   tick(nowMs, input)   — 60 Hz, fixed. Predicts and transmits.
 *   update(nowMs, dt)    — once per rendered frame. Pumps the simulated link
 *                          and decays the reconciliation offset.
 *
 * Everything else is events. `main.ts` wires them to the UI, the renderer and
 * the audio graph; nothing outside this directory ever sees a byte.
 */

import {
  ClientMessage,
  PROTOCOL_VERSION,
  ServerMessage,
  type AnyServerMessage,
  type ChatMsg,
  type CorrectionMsg,
  type ErrorMsg,
  type HitMsg,
  type KillMsg,
  type LobbyStateMsg,
  type MatchOverMsg,
  type RoundStateMsg,
  type SnapshotMsg,
  type SpawnMsg,
  type WelcomeMsg,
} from '../../../shared/protocol.js';
import type { SnapshotPlayerExt } from '../../../shared/codec.js';
import {
  GameMode,
  emptyInput,
  seqDiff,
  vec3,
  type ClientInput,
  type Loadout,
  type LobbyCode,
  type PlayerId,
  type Vec3,
} from '../../../shared/types.js';
import {
  INPUT_BUFFER_SIZE,
  INPUT_REDUNDANCY,
  TICK_MS,
} from '../../../shared/tuning.js';
import type { MovementState } from '../../../shared/movement.js';
import { Predictor, copyInput, type ReconcileResult } from './prediction.js';
import {
  SnapshotBuffer,
  type AppliedSnapshot,
  type RemotePlayerState,
} from './interpolation.js';
import { GameSocket, type GameSocketOptions, type SocketState } from './socket.js';
import type { NetSimConfig } from './netsim.js';

const RESUME_STORAGE_KEY = 'deckshot.resume';
const RING_MASK = INPUT_BUFFER_SIZE - 1;

export interface NetClientEvents {
  open: () => void;
  close: (reason: string) => void;
  welcome: (msg: WelcomeMsg) => void;
  lobby: (msg: LobbyStateMsg) => void;
  round: (msg: RoundStateMsg) => void;
  kill: (msg: KillMsg) => void;
  hit: (msg: HitMsg) => void;
  spawn: (msg: SpawnMsg) => void;
  chat: (msg: ChatMsg) => void;
  error: (msg: ErrorMsg) => void;
  matchover: (msg: MatchOverMsg) => void;
  correction: (msg: CorrectionMsg) => void;
  snapshot: (applied: AppliedSnapshot) => void;
  /** A remote player fired on this snapshot. Drives tracers and audio. */
  fired: (id: PlayerId) => void;
  reconciled: (result: ReconcileResult) => void;
}

type Handler<K extends keyof NetClientEvents> = NetClientEvents[K];

export interface NetClientOptions extends GameSocketOptions {
  /** Display name sent in Hello. */
  name?: string;
  /** Client build/protocol version. Defaults to PROTOCOL_VERSION. */
  version?: string;
  /** Weapon prediction for the local player, injected by the gameplay layer. */
  advanceWeapon?: (input: ClientInput, dt: number) => void;
  /** Persist and reuse the resume token. Default true. */
  persistSession?: boolean;
}

export class NetClient {
  readonly socket: GameSocket;
  readonly predictor: Predictor;
  readonly snapshots = new SnapshotBuffer();

  /** Assigned by Welcome. 0 until then. */
  playerId: PlayerId = 0;
  lobby: LobbyStateMsg | null = null;
  round: RoundStateMsg | null = null;

  private readonly listeners = new Map<keyof NetClientEvents, Set<(...args: never[]) => void>>();
  private readonly outbox: ClientInput[] = [];
  /** How many entries of `outbox` are real, consecutive inputs. */
  private outboxCount = 0;
  /** Reused view onto the tail of `outbox`; never reallocated after warm-up. */
  private readonly sendList: ClientInput[] = [];
  private readonly sentAtMs = new Float64Array(INPUT_BUFFER_SIZE);
  private readonly remoteScratch = new Map<PlayerId, RemotePlayerState>();
  private readonly clock: () => number;

  private name: string;
  private readonly version: string;
  private readonly persistSession: boolean;
  private resumeToken: string | null = null;

  /** Newest snapshot tick applied. Doubles as the delta ack we transmit. */
  private ackTick = 0;
  private rttMs = 0;
  private lastSnapshotAtMs = 0;

  /** Pending lobby intent, replayed after a reconnect. */
  private intent: { kind: 'create'; mode: GameMode; scoreLimit: number } | { kind: 'join'; code: LobbyCode } | { kind: 'quick' } | null =
    null;

  constructor(opts: NetClientOptions = {}) {
    this.clock = opts.now ?? (() => Date.now());
    this.name = opts.name ?? 'Player';
    this.version = opts.version ?? PROTOCOL_VERSION;
    this.persistSession = opts.persistSession !== false;
    this.socket = new GameSocket(opts);
    this.predictor = new Predictor(0, { advanceWeapon: opts.advanceWeapon });

    for (let i = 0; i < INPUT_REDUNDANCY; i++) this.outbox.push(emptyInput());

    if (this.persistSession) this.resumeToken = readStorage(RESUME_STORAGE_KEY);

    this.socket.onOpen = (): void => {
      this.sendHello();
      this.emit('open');
    };
    this.socket.onClose = (reason): void => {
      this.emit('close', reason);
    };
    this.socket.onMessage = (msg): void => this.handle(msg);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  get connectionState(): SocketState {
    return this.socket.state;
  }

  get connected(): boolean {
    return this.socket.isOpen;
  }

  /** Round-trip time in ms, measured from our own input acknowledgements. */
  get rtt(): number {
    return Math.round(this.rttMs);
  }

  get endpoint(): string {
    return this.socket.endpoint;
  }

  get netsimConfig(): NetSimConfig {
    return this.socket.netsim.config;
  }

  connect(name?: string): void {
    if (name) this.name = name;
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.close('leaving');
  }

  setName(name: string): void {
    this.name = name;
  }

  // -------------------------------------------------------------------------
  // Cold path
  // -------------------------------------------------------------------------

  createLobby(mode: GameMode, scoreLimit: number): void {
    this.intent = { kind: 'create', mode, scoreLimit };
    this.socket.send({ type: ClientMessage.CreateLobby, data: { mode, scoreLimit } });
  }

  joinLobby(code: LobbyCode): void {
    const normalized = (code ?? '').trim().toUpperCase();
    this.intent = { kind: 'join', code: normalized };
    this.socket.send({ type: ClientMessage.JoinLobby, data: { code: normalized } });
  }

  quickPlay(): void {
    this.intent = { kind: 'quick' };
    this.socket.send({ type: ClientMessage.QuickPlay, data: {} });
  }

  leaveLobby(): void {
    this.intent = null;
    this.lobby = null;
    this.socket.send({ type: ClientMessage.LeaveLobby, data: {} });
  }

  setReady(ready: boolean): void {
    this.socket.send({ type: ClientMessage.SetReady, data: { ready } });
  }

  setLoadout(loadout: Loadout): void {
    this.socket.send({ type: ClientMessage.SetLoadout, data: { loadout } });
  }

  setMatchConfig(mode: GameMode, scoreLimit: number, timeLimit: number): void {
    this.socket.send({ type: ClientMessage.SetMatchConfig, data: { mode, scoreLimit, timeLimit } });
  }

  chat(text: string): void {
    const trimmed = text.slice(0, 200);
    if (!trimmed.trim()) return;
    this.socket.send({ type: ClientMessage.Chat, data: { text: trimmed } });
  }

  requestRespawn(): void {
    this.socket.send({ type: ClientMessage.RequestRespawn, data: {} });
  }

  // -------------------------------------------------------------------------
  // Hot path
  // -------------------------------------------------------------------------

  /**
   * One client tick. Predicts locally, then transmits this input plus the
   * previous INPUT_REDUNDANCY-1 so a single dropped datagram cannot stall the
   * server's view of us — the next packet carries the gap.
   *
   * `input.tick` carries the newest snapshot tick we have applied. The
   * protocol has no dedicated ack field and the two meanings coincide, so this
   * is the delta-compression acknowledgement channel. See "Contract friction".
   */
  tick(nowMs: number, input: ClientInput): MovementState {
    input.tick = this.ackTick;
    const state = this.predictor.predict(input);

    // Slide the redundancy window: [oldest ... newest].
    const last = this.outbox.length - 1;
    const previous = this.outboxCount > 0 ? this.outbox[last].seq : -1;
    for (let i = 0; i < last; i++) copyInput(this.outbox[i + 1], this.outbox[i]);
    copyInput(input, this.outbox[last]);
    this.sentAtMs[input.seq & RING_MASK] = nowMs;

    // The wire transmits ONE base seq and derives the rest as base+i, so the
    // window may only contain consecutive inputs. Two cases break that: the
    // first two ticks of a session, when the window still holds empty
    // placeholders, and a seq reset after a reconnect. Both restart the window
    // rather than shipping a packet whose inputs are labelled with seqs that
    // were never sampled.
    if (previous < 0 || seqDiff(input.seq, previous) !== 1) this.outboxCount = 1;
    else if (this.outboxCount < this.outbox.length) this.outboxCount++;

    const send = this.sendList;
    send.length = 0;
    for (let i = this.outbox.length - this.outboxCount; i < this.outbox.length; i++) {
      send.push(this.outbox[i]);
    }

    this.socket.send({ type: ClientMessage.Input, data: { inputs: send } });
    return state;
  }

  /** Once per rendered frame. Advances the simulated link and the smoothing. */
  update(nowMs: number, dtSeconds: number): void {
    this.socket.pump(nowMs);
    this.predictor.updateSmoothing(dtSeconds);
  }

  /** The predicted local state. Truth for gameplay, before visual smoothing. */
  get localState(): MovementState {
    return this.predictor.state;
  }

  /** Where to put the camera: predicted position plus the decaying correction. */
  renderPosition(out: Vec3 = vec3()): Vec3 {
    return this.predictor.renderPosition(out);
  }

  /**
   * Every remote player, interpolated INTERP_DELAY_MS into the past.
   * The returned map is reused between calls; do not retain it.
   */
  remotePlayers(nowMs: number): Map<PlayerId, RemotePlayerState> {
    const renderTime = this.snapshots.renderTimeAt(nowMs);
    this.snapshots.sample(renderTime, this.remoteScratch, this.playerId);
    return this.remoteScratch;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<K extends keyof NetClientEvents>(event: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (...args: never[]) => void);
    return () => this.off(event, handler);
  }

  off<K extends keyof NetClientEvents>(event: K, handler: Handler<K>): void {
    this.listeners.get(event)?.delete(handler as (...args: never[]) => void);
  }

  private emit<K extends keyof NetClientEvents>(
    event: K,
    ...args: Parameters<NetClientEvents[K]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[deckshot] listener for "${String(event)}" threw`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private sendHello(): void {
    const data: { version: string; name: string; resumeToken?: string } = {
      version: this.version,
      name: this.name,
    };
    if (this.resumeToken) data.resumeToken = this.resumeToken;
    this.socket.send({ type: ClientMessage.Hello, data });
    // If we were mid-lobby when the socket dropped and the token was refused,
    // re-state the intent so a reconnect lands us back where we were.
    if (!this.resumeToken && this.intent) this.replayIntent();
  }

  private replayIntent(): void {
    const intent = this.intent;
    if (!intent) return;
    if (intent.kind === 'create') {
      this.socket.send({
        type: ClientMessage.CreateLobby,
        data: { mode: intent.mode, scoreLimit: intent.scoreLimit },
      });
    } else if (intent.kind === 'join') {
      this.socket.send({ type: ClientMessage.JoinLobby, data: { code: intent.code } });
    } else {
      this.socket.send({ type: ClientMessage.QuickPlay, data: {} });
    }
  }

  private handle(msg: AnyServerMessage): void {
    switch (msg.type) {
      case ServerMessage.Welcome: {
        const d = msg.data as WelcomeMsg;
        this.playerId = d.playerId;
        this.resumeToken = d.resumeToken;
        if (this.persistSession) writeStorage(RESUME_STORAGE_KEY, d.resumeToken);
        this.predictor.state.id = d.playerId;
        this.emit('welcome', d);
        return;
      }
      case ServerMessage.LobbyState:
        this.lobby = msg.data as LobbyStateMsg;
        this.emit('lobby', this.lobby);
        return;
      case ServerMessage.RoundState:
        this.round = msg.data as RoundStateMsg;
        this.emit('round', this.round);
        return;
      case ServerMessage.Error: {
        const err = msg.data as ErrorMsg;
        // A refused resume token is stale; clear it so the retry is a fresh
        // join rather than an infinite loop of the same rejection.
        this.resumeToken = null;
        if (this.persistSession) writeStorage(RESUME_STORAGE_KEY, '');
        this.emit('error', err);
        return;
      }
      case ServerMessage.Snapshot:
        this.onSnapshot(msg.data as SnapshotMsg);
        return;
      case ServerMessage.Kill:
        this.emit('kill', msg.data as KillMsg);
        return;
      case ServerMessage.Hit:
        this.emit('hit', msg.data as HitMsg);
        return;
      case ServerMessage.Spawn: {
        const d = msg.data as SpawnMsg;
        if (d.playerId === this.playerId) {
          this.predictor.reset({
            position: vec3(d.position.x, d.position.y, d.position.z),
            velocity: vec3(),
            yaw: d.yaw,
            pitch: 0,
            alive: true,
          });
        }
        this.emit('spawn', d);
        return;
      }
      case ServerMessage.Chat:
        this.emit('chat', msg.data as ChatMsg);
        return;
      case ServerMessage.Ping:
        // Echo immediately: the server measures RTT, we do not delay it.
        this.socket.send({ type: ClientMessage.Pong, data: { time: msg.data.time } });
        return;
      case ServerMessage.Correction: {
        const d = msg.data as CorrectionMsg;
        this.predictor.forceState(d.state as SnapshotPlayerExt);
        this.emit('correction', d);
        return;
      }
      case ServerMessage.MatchOver:
        this.emit('matchover', msg.data as MatchOverMsg);
        return;
      default:
        return;
    }
  }

  private onSnapshot(msg: SnapshotMsg): void {
    const now = this.clock();
    const applied = this.snapshots.apply(msg, now);
    if (!applied) return;

    this.lastSnapshotAtMs = now;
    // Only acknowledge snapshots we could actually reconstruct, and never move
    // the ack backwards on a reordered packet.
    if (msg.tick > this.ackTick) this.ackTick = msg.tick;

    // Measure our own RTT from the input this snapshot acknowledges.
    const sentAt = this.sentAtMs[msg.ackedSeq & RING_MASK];
    if (sentAt > 0) {
      const sample = now - sentAt;
      if (sample >= 0 && sample < 5000) {
        this.rttMs = this.rttMs === 0 ? sample : this.rttMs + (sample - this.rttMs) * 0.2;
      }
    }

    const mine = applied.snapshot.players.get(this.playerId);
    if (mine) {
      const result = this.predictor.reconcile(mine as unknown as SnapshotPlayerExt, msg.ackedSeq);
      if (result.applied) this.emit('reconciled', result);
    }

    for (const id of applied.fired) {
      if (id !== this.playerId) this.emit('fired', id);
    }
    this.emit('snapshot', applied);
  }

  // -------------------------------------------------------------------------
  // Diagnostics — the netgraph overlay reads these
  // -------------------------------------------------------------------------

  stats(): {
    state: SocketState;
    rtt: number;
    serverPing: number;
    pendingInputs: number;
    corrections: number;
    hardCorrections: number;
    lastError: number;
    lastReplayed: number;
    snapshotAgeMs: number;
    bytesIn: number;
    bytesOut: number;
    duplicateSnapshots: number;
    missingBaselines: number;
    outOfOrderSnapshots: number;
    simulatedLoss: { sentDropped: number; recvDropped: number; inFlight: number };
  } {
    return {
      state: this.socket.state,
      rtt: this.rtt,
      serverPing: this.predictor.state.ping,
      pendingInputs: this.predictor.pendingInputs,
      corrections: this.predictor.corrections,
      hardCorrections: this.predictor.hardCorrections,
      lastError: this.predictor.lastError,
      lastReplayed: this.predictor.lastReplayed,
      snapshotAgeMs: this.lastSnapshotAtMs === 0 ? -1 : this.clock() - this.lastSnapshotAtMs,
      bytesIn: this.socket.bytesReceived,
      bytesOut: this.socket.bytesSent,
      duplicateSnapshots: this.snapshots.duplicates,
      missingBaselines: this.snapshots.missingBaselines,
      outOfOrderSnapshots: this.snapshots.outOfOrder,
      simulatedLoss: this.socket.netsim.stats(),
    };
  }
}

function readStorage(key: string): string | null {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, value);
    else globalThis.localStorage?.removeItem(key);
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
}

export { seqDiff, TICK_MS };
