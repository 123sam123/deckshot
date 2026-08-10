/**
 * DECKSHOT — snapshot assembly and delta compression.
 *
 * Owner: netcode-core.
 *
 * Snapshots go out at SNAPSHOT_RATE (20 Hz), delta-compressed per client
 * against the last snapshot that client acknowledged. Unchanged fields cost
 * nothing but their bit in the mask; a player standing still costs three bytes
 * (id + mask) instead of twenty-two.
 *
 * Two design points worth stating, because both are easy to get wrong:
 *
 *  - The diff is computed on QUANTIZED integers, not on floats. Comparing
 *    floats would mark a field dirty every tick for a player who is
 *    effectively stationary, because the last bit of a double never settles,
 *    and delta compression would silently do nothing.
 *
 *  - The baseline history is SHARED across clients, not per client. Every
 *    client that is connected at tick T is sent the same world state at tick
 *    T, so "what was true at T" is one table. All that differs per client is
 *    which T they last acked. That turns 12 x 32 baseline copies into 32.
 */

import {
  SnapshotField,
  type SnapshotMsg,
  type SnapshotPlayer,
} from '../../../shared/protocol.js';
import { SNAPSHOT_ALL_FIELDS, type SnapshotPlayerExt } from '../../../shared/codec.js';
import {
  quantizeAngle,
  quantizePitch,
  quantizePos,
  quantizeUnit,
  quantizeVel,
} from '../../../shared/quantize.js';
import { MAX_PLAYERS } from '../../../shared/tuning.js';
import type { Loadout, PlayerId, PlayerState, TeamId } from '../../../shared/types.js';

/** Baseline tables retained. 32 at 20 Hz is 1.6 s — far longer than any RTT. */
export const BASELINE_HISTORY = 32;

/**
 * `0` is the wire's "no baseline, this is full state" sentinel, so a real tick
 * whose low 16 bits are 0 can never be used as one. It comes round once every
 * 18 minutes of uptime and costs exactly one extra full snapshot.
 */
const NO_BASELINE = 0;

/** The quantized form of one player, as it will appear on the wire. */
interface PlayerFrame {
  id: PlayerId;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  stance: number;
  flags: number;
  health: number;
  weapon: number;
  adsState: number;
  adsProgress: number;
  score: number;
  kills: number;
  deaths: number;
  streak: number;
  ping: number;
  /** Cheap change detector for the string-heavy identity block. */
  identityKey: string;
  // Source values, kept so the encoder does not have to dequantize.
  name: string;
  team: TeamId;
  loadout: Loadout;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  yawF: number;
  pitchF: number;
  adsProgressF: number;
  onGround: boolean;
  alive: boolean;
  fired: boolean;
  /** SURVIVAL: last stand (Flags bit 3). */
  downed: boolean;
  /**
   * Ceiling on which fields this entity may replicate. 0xffff for players;
   * zombies are limited to Position|Yaw|Flags — a bandwidth requirement, not
   * an optimisation (24 zombies × full fields would blow the budget).
   */
  maskLimit: number;
}

interface FrameTable {
  tick: number;
  players: Map<PlayerId, PlayerFrame>;
}

const FLAG_ON_GROUND = 1 << 0;
const FLAG_ALIVE = 1 << 1;
const FLAG_FIRED = 1 << 2;
const FLAG_DOWNED = 1 << 3;

function makeFrame(): PlayerFrame {
  return {
    id: 0,
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    stance: 0,
    flags: 0,
    health: 0,
    weapon: 0,
    adsState: 0,
    adsProgress: 0,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    ping: 0,
    identityKey: '',
    name: '',
    team: 0 as TeamId,
    loadout: { primary: 0, attachments: [0, 0, 0], camo: 0, skin: 0 } as Loadout,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yawF: 0,
    pitchF: 0,
    adsProgressF: 0,
    onGround: false,
    alive: false,
    fired: false,
    downed: false,
    maskLimit: 0xffff,
  };
}

/** Extra replicated state the frozen `PlayerState` does not carry. */
export interface ReplicationExtras {
  /** Latched by the room: true if the player fired since the last snapshot. */
  fired: boolean;
  /** Field ceiling for this entity; absent = everything (players). */
  maskLimit?: number;
}

/** Per-client delta bookkeeping. One of these hangs off every session. */
export class ClientBaseline {
  /** Low 16 bits of the newest tick this client has acknowledged. */
  ackedTick16 = NO_BASELINE;
  /** Full tick of the first snapshot ever sent to this client. */
  firstSentTick = -1;
  /** Full tick of the most recent snapshot sent. */
  lastSentTick = -1;
  /** Server clock (ms) of the last ack, for the "gone quiet" fallback. */
  lastAckAtMs = 0;
  /** Cumulative bytes sent to this client, for the bandwidth budget. */
  bytesSent = 0;

  /**
   * A client that has not acked recently gets full state. Cheaper than
   * gambling on a baseline it may never have received, and it self-heals a
   * client that reconnected mid-stream.
   */
  ackIsStale(nowMs: number, graceMs = 1000): boolean {
    return this.ackedTick16 === NO_BASELINE || nowMs - this.lastAckAtMs > graceMs;
  }
}

/**
 * Builds one world state per tick and turns it into per-client deltas.
 *
 * Usage per snapshot tick:
 *   beginTick(tick); addPlayer(...) x N; then buildFor(client, ackedSeq) for
 *   each connected client.
 */
export class SnapshotAssembler {
  private readonly history: FrameTable[] = [];
  private head = -1;
  private currentTick = 0;

  /** Frames not currently in a table, reused instead of reallocated. */
  private readonly framePool: PlayerFrame[] = [];

  /**
   * Pool of message-shaped players, and the list handed to the encoder.
   *
   * These MUST be two different arrays. Pooling out of the same array the
   * message points at means truncating the message also empties the pool, and
   * every player in the frame ends up aliasing the first one.
   */
  private readonly playerPool: SnapshotPlayerExt[] = [];
  private readonly scratchPlayers: SnapshotPlayerExt[] = [];
  private readonly scratchMsg: SnapshotMsg = {
    tick: 0,
    ackedSeq: 0,
    baselineTick: 0,
    players: [],
    removed: [],
  };

  constructor() {
    for (let i = 0; i < BASELINE_HISTORY; i++) {
      this.history.push({ tick: -1, players: new Map() });
    }
  }

  /** Opens a new world state. Recycles the table this ring slot held. */
  beginTick(tick: number): void {
    this.head = this.head < 0 ? 0 : (this.head + 1) % BASELINE_HISTORY;
    const table = this.history[this.head];
    for (const frame of table.players.values()) this.framePool.push(frame);
    table.players.clear();
    table.tick = tick;
    this.currentTick = tick;
  }

  /** Adds one player's quantized state to the open world state. */
  addPlayer(s: PlayerState, extras: ReplicationExtras): void {
    if (this.head < 0) return;
    const table = this.history[this.head];
    const f = this.framePool.pop() ?? makeFrame();

    f.id = s.id;
    f.px = quantizePos(s.position.x);
    f.py = quantizePos(s.position.y);
    f.pz = quantizePos(s.position.z);
    f.vx = quantizeVel(s.velocity.x);
    f.vy = quantizeVel(s.velocity.y);
    f.vz = quantizeVel(s.velocity.z);
    f.yaw = quantizeAngle(s.yaw);
    f.pitch = quantizePitch(s.pitch);
    f.stance = s.stance;
    f.flags =
      (s.onGround ? FLAG_ON_GROUND : 0) |
      (s.alive ? FLAG_ALIVE : 0) |
      (extras.fired ? FLAG_FIRED : 0) |
      (s.downed === true ? FLAG_DOWNED : 0);
    f.health = clampByte(s.health);
    f.weapon = s.activeWeapon;
    f.adsState = s.adsState & 0x03;
    f.adsProgress = quantizeUnit(s.adsProgress);
    f.score = clampU16(s.score);
    f.kills = clampByte(s.kills);
    f.deaths = clampByte(s.deaths);
    f.streak = clampByte(s.streak);
    f.ping = clampU16(s.ping);
    f.name = s.name;
    f.team = s.team;
    f.loadout = s.loadout;
    f.identityKey = identityKey(s);

    f.position.x = s.position.x;
    f.position.y = s.position.y;
    f.position.z = s.position.z;
    f.velocity.x = s.velocity.x;
    f.velocity.y = s.velocity.y;
    f.velocity.z = s.velocity.z;
    f.yawF = s.yaw;
    f.pitchF = s.pitch;
    f.adsProgressF = s.adsProgress;
    f.onGround = s.onGround;
    f.alive = s.alive;
    f.fired = extras.fired;
    f.downed = s.downed === true;
    f.maskLimit = extras.maskLimit ?? 0xffff;

    table.players.set(s.id, f);
  }

  /**
   * Produces the snapshot for one client.
   *
   * The returned object is scratch: encode it before calling this again. That
   * is what keeps a 12-player room from allocating 144 objects every 50 ms.
   */
  buildFor(client: ClientBaseline, ackedSeq: number, nowMs: number): SnapshotMsg {
    const table = this.history[this.head];
    const baseline = this.findBaseline(client, nowMs);

    const msg = this.scratchMsg;
    msg.tick = table.tick;
    msg.ackedSeq = ackedSeq & 0xffff;
    msg.baselineTick = baseline ? baseline.tick & 0xffff : NO_BASELINE;

    const players = this.scratchPlayers;
    players.length = 0;
    let i = 0;
    for (const cur of table.players.values()) {
      const base = baseline ? baseline.players.get(cur.id) : undefined;
      const mask = diffMask(cur, base) & cur.maskLimit;
      // A player with nothing changed still costs 3 bytes; skipping them
      // entirely would be wrong, because their absence is how removal is
      // signalled elsewhere. 3 bytes at 20 Hz is 60 B/s per idle player.
      const out = this.scratchPlayerAt(i++);
      fillMessagePlayer(out, cur, mask);
      players.push(out);
    }
    msg.players = players as unknown as SnapshotPlayer[];

    const removed = msg.removed as PlayerId[];
    removed.length = 0;
    if (baseline) {
      for (const id of baseline.players.keys()) {
        if (!table.players.has(id)) removed.push(id);
      }
    }

    if (client.firstSentTick < 0) client.firstSentTick = table.tick;
    client.lastSentTick = table.tick;
    return msg;
  }

  /** Records that a client acknowledged a snapshot tick (low 16 bits). */
  ack(client: ClientBaseline, tick16: number, nowMs: number): void {
    if (tick16 === NO_BASELINE) return;
    const found = this.findTableByTick16(tick16);
    if (!found) return;
    if (client.firstSentTick >= 0 && found.tick < client.firstSentTick) return;
    // Only move the ack forward. A reordered packet must not rewind it.
    const prev = this.findTableByTick16(client.ackedTick16);
    if (prev && found.tick <= prev.tick) return;
    client.ackedTick16 = tick16;
    client.lastAckAtMs = nowMs;
  }

  get tick(): number {
    return this.currentTick;
  }

  private findBaseline(client: ClientBaseline, nowMs: number): FrameTable | null {
    if (client.ackIsStale(nowMs)) return null;
    const table = this.findTableByTick16(client.ackedTick16);
    if (!table) return null;
    if (client.firstSentTick >= 0 && table.tick < client.firstSentTick) return null;
    if (table.tick > this.currentTick) return null;
    return table;
  }

  private findTableByTick16(tick16: number): FrameTable | null {
    if (tick16 === NO_BASELINE) return null;
    for (let i = 0; i < BASELINE_HISTORY; i++) {
      const t = this.history[i];
      if (t.tick >= 0 && (t.tick & 0xffff) === tick16) return t;
    }
    return null;
  }

  private scratchPlayerAt(i: number): SnapshotPlayerExt {
    let p = this.playerPool[i];
    if (!p) {
      p = {
        id: 0,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        stance: 0,
        onGround: false,
        alive: false,
        health: 0,
        activeWeapon: 0,
        adsState: 0,
        adsProgress: 0,
        firedThisTick: false,
      };
      this.playerPool[i] = p;
    }
    return p;
  }
}

function identityKey(s: PlayerState): string {
  const l = s.loadout;
  const a = l && l.attachments ? l.attachments : [0, 0, 0];
  // skin is part of the key: a mid-match skin change must trigger an identity
  // resend or remote clients would never see it.
  return `${s.name}|${s.team}|${l ? l.primary : 0}|${a[0]},${a[1]},${a[2]}|${l ? l.camo : 0}|${l ? (l.skin ?? 0) : 0}`;
}

function clampByte(v: number): number {
  const n = Math.round(Number.isFinite(v) ? v : 0);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function clampU16(v: number): number {
  const n = Math.round(Number.isFinite(v) ? v : 0);
  return n < 0 ? 0 : n > 0xffff ? 0xffff : n;
}

/** Which fields differ from the baseline. No baseline means everything. */
function diffMask(cur: PlayerFrame, base: PlayerFrame | undefined): number {
  if (!base) return SNAPSHOT_ALL_FIELDS;
  let mask = 0;
  if (cur.px !== base.px || cur.py !== base.py || cur.pz !== base.pz) {
    mask |= SnapshotField.Position;
  }
  if (cur.vx !== base.vx || cur.vy !== base.vy || cur.vz !== base.vz) {
    mask |= SnapshotField.Velocity;
  }
  if (cur.yaw !== base.yaw) mask |= SnapshotField.Yaw;
  if (cur.pitch !== base.pitch) mask |= SnapshotField.Pitch;
  if (cur.stance !== base.stance) mask |= SnapshotField.Stance;
  if (cur.flags !== base.flags) mask |= SnapshotField.Flags;
  if (cur.health !== base.health) mask |= SnapshotField.Health;
  if (cur.weapon !== base.weapon) mask |= SnapshotField.Weapon;
  if (cur.adsState !== base.adsState || cur.adsProgress !== base.adsProgress) {
    mask |= SnapshotField.Ads;
  }
  if (
    cur.score !== base.score ||
    cur.kills !== base.kills ||
    cur.deaths !== base.deaths ||
    cur.streak !== base.streak
  ) {
    mask |= SnapshotField.Score;
  }
  if (cur.identityKey !== base.identityKey) mask |= SnapshotField.Identity;
  // Ping crawls; a 1 ms jitter is not worth two bytes every 50 ms.
  if (Math.abs(cur.ping - base.ping) >= 5) mask |= SnapshotField.Ping;
  return mask;
}

function fillMessagePlayer(out: SnapshotPlayerExt, f: PlayerFrame, mask: number): void {
  out.id = f.id;
  out.mask = mask;
  out.position.x = f.position.x;
  out.position.y = f.position.y;
  out.position.z = f.position.z;
  out.velocity.x = f.velocity.x;
  out.velocity.y = f.velocity.y;
  out.velocity.z = f.velocity.z;
  out.yaw = f.yawF;
  out.pitch = f.pitchF;
  out.stance = f.stance;
  out.onGround = f.onGround;
  out.alive = f.alive;
  out.firedThisTick = f.fired;
  out.downed = f.downed;
  out.health = f.health;
  out.activeWeapon = f.weapon;
  out.adsState = f.adsState;
  out.adsProgress = f.adsProgressF;
  out.score = f.score;
  out.kills = f.kills;
  out.deaths = f.deaths;
  out.streak = f.streak;
  out.team = f.team;
  out.name = f.name;
  out.loadout = f.loadout;
  out.ping = f.ping;
}

export { MAX_PLAYERS };
