/**
 * DECKSHOT — binary wire codec.
 *
 * Owner: netcode-core. This is the ONLY module in the project that touches
 * bytes. Everything else speaks the typed message objects from protocol.ts.
 *
 * Rules this file exists to enforce:
 *
 *  1. Little-endian, DataView, no JSON anywhere — including the cold path.
 *  2. All numbers go through `shared/quantize.ts`, so both sides agree
 *     bit-for-bit about what a position "is".
 *  3. **A malformed packet must never crash the server.** Every read is bounds
 *     checked, every length is validated, every unknown discriminant is a
 *     typed `DecodeError`. The caller catches it and drops the connection.
 *     There is no code path here that can loop, allocate unboundedly, or
 *     dereference past the end of the buffer.
 *  4. The hot path does not allocate. Encoding reuses one grow-only scratch
 *     buffer; the single unavoidable allocation is the `ArrayBuffer` the
 *     frozen `Codec` interface requires us to return.
 */

import {
  ClientMessage,
  CorrectionReason,
  ErrorCode,
  ServerMessage,
  SnapshotField,
  type AnyClientMessage,
  type AnyServerMessage,
  type ChatMsg,
  type Codec,
  type CorrectionMsg,
  type CreateLobbyMsg,
  type ErrorMsg,
  type HelloMsg,
  type HitMsg,
  type InputMsg,
  type InteractMsg,
  type JoinLobbyMsg,
  type KillMsg,
  type LobbyPlayerInfo,
  type LobbyStateMsg,
  type MatchOverMsg,
  type PurchaseMsg,
  type RoundStateMsg,
  type ScoreboardEntry,
  type SetLoadoutMsg,
  type SetMatchConfigMsg,
  type SnapshotMsg,
  type SnapshotPlayer,
  type SpawnMsg,
  type SurvivalStateMsg,
  type WelcomeMsg,
} from './protocol.js';
import {
  dequantizeAngle,
  dequantizeAxis,
  dequantizePitch,
  dequantizePos,
  dequantizeUnit,
  dequantizeVel,
  quantizeAngle,
  quantizeAxis,
  quantizePitch,
  quantizePos,
  quantizeUnit,
  quantizeVel,
} from './quantize.js';
import {
  AdsState,
  AttachmentId,
  CamoId,
  GameMode,
  HitboxPart,
  RoundPhase,
  Stance,
  TeamId,
  WeaponId,
  type ClientInput,
  type Loadout,
  type PlayerId,
  type Vec3,
} from './types.js';
import { INPUT_REDUNDANCY, MAX_PLAYERS } from './tuning.js';

// ---------------------------------------------------------------------------
// Errors and limits
// ---------------------------------------------------------------------------

/**
 * Thrown by every decode path. The transport layer catches exactly this and
 * closes the socket; nothing else in the project is allowed to interpret a
 * malformed frame.
 */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/**
 * Hard ceiling on one frame. A full snapshot with 12 named players is under
 * 1 KB; MatchOver with 12 long unicode names is the real worst case at a few
 * KB. 64 KiB is generous and still bounds the damage a hostile client can do
 * before the socket is closed.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Longest string the wire can carry (u8 length prefix). */
export const MAX_STRING_BYTES = 255;

/** Defensive caps on decoded list lengths. */
const MAX_SNAPSHOT_PLAYERS = 64;
const MAX_SCOREBOARD_ROWS = 64;

const TEXT_ENCODER = new TextEncoder();
/** Non-fatal: invalid UTF-8 becomes U+FFFD instead of throwing. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  off = 0;

  constructor(initial = 4096) {
    this.buf = new ArrayBuffer(initial);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  reset(): void {
    this.off = 0;
  }

  /** Grow-only. The scratch buffer converges on the largest frame ever sent. */
  private ensure(n: number): void {
    const need = this.off + n;
    if (need <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < need) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.off));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
  }

  i8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.off, v | 0);
    this.off += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.off, v & 0xffff, true);
    this.off += 2;
  }

  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.off, v | 0, true);
    this.off += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.off, Number.isFinite(v) ? v : 0, true);
    this.off += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.off, Number.isFinite(v) ? v : 0, true);
    this.off += 8;
  }

  /** u8 byte-length + UTF-8. Over-long strings are cut on a codepoint edge. */
  str(s: string): void {
    const clamped = clampUtf8(typeof s === 'string' ? s : '', MAX_STRING_BYTES);
    const encoded = TEXT_ENCODER.encode(clamped);
    this.ensure(1 + encoded.length);
    this.view.setUint8(this.off, encoded.length);
    this.off += 1;
    this.bytes.set(encoded, this.off);
    this.off += encoded.length;
  }

  finish(): ArrayBuffer {
    return this.buf.slice(0, this.off);
  }

  /** Bytes written so far, without copying. Valid until the next write. */
  peek(): Uint8Array {
    return this.bytes.subarray(0, this.off);
  }
}

/**
 * Truncates to at most `max` UTF-8 bytes without splitting a codepoint.
 * Surrogate pairs are stepped over with the iterator, so an emoji is either
 * fully present or fully absent — never half a name.
 */
function clampUtf8(s: string, max: number): string {
  if (s.length * 4 <= max) return s;
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const n = utf8Length(ch);
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

function utf8Length(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c < 0x10000) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class ByteReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly len: number;
  off = 0;

  constructor(buf: ArrayBuffer | Uint8Array) {
    if (buf instanceof Uint8Array) {
      this.bytes = buf;
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.len = buf.byteLength;
    } else {
      this.bytes = new Uint8Array(buf);
      this.view = new DataView(buf);
      this.len = buf.byteLength;
    }
  }

  get remaining(): number {
    return this.len - this.off;
  }

  private need(n: number): void {
    if (n < 0 || this.off + n > this.len) {
      throw new DecodeError(`truncated: need ${n} at ${this.off} of ${this.len}`);
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }

  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.off);
    this.off += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return Number.isFinite(v) ? v : 0;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return Number.isFinite(v) ? v : 0;
  }

  str(): string {
    const n = this.u8();
    this.need(n);
    const s = TEXT_DECODER.decode(this.bytes.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
}

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

/**
 * One writer per direction. Encoding is synchronous and non-reentrant on both
 * runtimes (no await, no callbacks), so a shared scratch buffer is safe and
 * keeps the hot path allocation-free apart from the returned ArrayBuffer.
 */
const CLIENT_W = new ByteWriter(512);
const SERVER_W = new ByteWriter(4096);

// ---------------------------------------------------------------------------
// Shared field helpers
// ---------------------------------------------------------------------------

function writePos(w: ByteWriter, v: Vec3): void {
  w.u16(quantizePos(v ? v.x : 0));
  w.u16(quantizePos(v ? v.y : 0));
  w.u16(quantizePos(v ? v.z : 0));
}

function readPos(r: ByteReader): Vec3 {
  const x = dequantizePos(r.u16());
  const y = dequantizePos(r.u16());
  const z = dequantizePos(r.u16());
  return { x, y, z };
}

function writeVel(w: ByteWriter, v: Vec3): void {
  w.i16(quantizeVel(v ? v.x : 0));
  w.i16(quantizeVel(v ? v.y : 0));
  w.i16(quantizeVel(v ? v.z : 0));
}

function readVel(r: ByteReader): Vec3 {
  const x = dequantizeVel(r.i16());
  const y = dequantizeVel(r.i16());
  const z = dequantizeVel(r.i16());
  return { x, y, z };
}

/** Unit vectors (surface normals) as 3 x i16 over [-1, 1]. */
function writeNormal(w: ByteWriter, v: Vec3): void {
  w.i16(packUnit(v ? v.x : 0));
  w.i16(packUnit(v ? v.y : 0));
  w.i16(packUnit(v ? v.z : 0));
}

function readNormal(r: ByteReader): Vec3 {
  return { x: unpackUnit(r.i16()), y: unpackUnit(r.i16()), z: unpackUnit(r.i16()) };
}

function packUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const q = Math.round(v * 32767);
  return q < -32767 ? -32767 : q > 32767 ? 32767 : q;
}

function unpackUnit(q: number): number {
  return (q < -32767 ? -32767 : q > 32767 ? 32767 : q) / 32767;
}

function writeLoadout(w: ByteWriter, l: Loadout | undefined): void {
  const primary = l ? l.primary : WeaponId.Talon;
  const a = l && l.attachments ? l.attachments : [AttachmentId.None, AttachmentId.None, AttachmentId.None];
  w.u8(primary);
  w.u8(a[0] ?? AttachmentId.None);
  w.u8(a[1] ?? AttachmentId.None);
  w.u8(a[2] ?? AttachmentId.None);
  w.u8(l ? l.camo : CamoId.Gunmetal);
}

function readLoadout(r: ByteReader): Loadout {
  const primary = clampEnum(r.u8(), WeaponId.Talon, WeaponId.Harrier) as WeaponId;
  const a0 = clampAttachment(r.u8());
  const a1 = clampAttachment(r.u8());
  const a2 = clampAttachment(r.u8());
  const camo = clampEnum(r.u8(), CamoId.Gunmetal, CamoId.Gold) as CamoId;
  return { primary, attachments: [a0, a1, a2], camo };
}

/**
 * Out-of-range enum bytes are clamped, not rejected. A garbage weapon id is a
 * cosmetic problem; closing the socket over one is a gameplay problem.
 * Structural corruption (a bad length, a short buffer) still throws.
 */
function clampEnum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampAttachment(v: number): AttachmentId {
  return clampEnum(v, AttachmentId.None, AttachmentId.BallisticCompensator) as AttachmentId;
}

// ---------------------------------------------------------------------------
// Snapshot players
// ---------------------------------------------------------------------------

/**
 * `SnapshotPlayer` plus the fields `SnapshotField` names but the frozen
 * interface does not carry (Score, Identity, Ping) — see "Contract friction"
 * in the handover — plus the delta mask.
 *
 * `mask` is how delta compression stays out of the codec: the snapshot
 * assembler decides which fields changed, the codec just writes the ones it is
 * told to. A decoded player carries the mask it arrived with so the client can
 * merge it onto its baseline. When `mask` is absent on encode, every basic
 * field is written (a full, self-contained state).
 */
export interface SnapshotPlayerExt extends SnapshotPlayer {
  /** Bitfield of SnapshotField. Absent on encode means "everything basic". */
  mask?: number;
  score?: number;
  kills?: number;
  deaths?: number;
  streak?: number;
  team?: TeamId;
  name?: string;
  loadout?: Loadout;
  ping?: number;
}

/** The per-tick replicated set: everything that changes during play. */
export const SNAPSHOT_BASIC_FIELDS =
  SnapshotField.Position |
  SnapshotField.Velocity |
  SnapshotField.Yaw |
  SnapshotField.Pitch |
  SnapshotField.Stance |
  SnapshotField.Flags |
  SnapshotField.Health |
  SnapshotField.Weapon |
  SnapshotField.Ads;

/** Everything, including the join-time identity block. */
export const SNAPSHOT_ALL_FIELDS =
  SNAPSHOT_BASIC_FIELDS |
  SnapshotField.Score |
  SnapshotField.Identity |
  SnapshotField.Ping;

const FLAG_ON_GROUND = 1 << 0;
const FLAG_ALIVE = 1 << 1;
const FLAG_FIRED = 1 << 2;
const FLAG_DOWNED = 1 << 3; // SURVIVAL last stand

function writeSnapshotPlayer(w: ByteWriter, p: SnapshotPlayerExt): void {
  let mask = p.mask === undefined ? SNAPSHOT_BASIC_FIELDS : p.mask & 0xffff;

  // Never claim a field we cannot actually produce.
  if ((mask & SnapshotField.Score) !== 0 && p.score === undefined) mask &= ~SnapshotField.Score;
  if ((mask & SnapshotField.Identity) !== 0 && p.name === undefined) {
    mask &= ~SnapshotField.Identity;
  }
  if ((mask & SnapshotField.Ping) !== 0 && p.ping === undefined) mask &= ~SnapshotField.Ping;

  w.u8(p.id & 0xff);
  w.u16(mask);

  // Ascending bit order. The decoder walks the same ladder.
  if (mask & SnapshotField.Position) writePos(w, p.position);
  if (mask & SnapshotField.Velocity) writeVel(w, p.velocity);
  if (mask & SnapshotField.Yaw) w.u16(quantizeAngle(p.yaw));
  if (mask & SnapshotField.Pitch) w.i16(quantizePitch(p.pitch));
  if (mask & SnapshotField.Stance) w.u8(p.stance);
  if (mask & SnapshotField.Flags) {
    w.u8(
      (p.onGround ? FLAG_ON_GROUND : 0) |
        (p.alive ? FLAG_ALIVE : 0) |
        (p.firedThisTick ? FLAG_FIRED : 0) |
        (p.downed ? FLAG_DOWNED : 0)
    );
  }
  if (mask & SnapshotField.Health) w.u8(clampEnum(Math.round(p.health), 0, 255));
  if (mask & SnapshotField.Weapon) w.u8(p.activeWeapon);
  if (mask & SnapshotField.Ads) {
    w.u8(p.adsState & 0x03);
    w.u8(quantizeUnit(p.adsProgress));
  }
  if (mask & SnapshotField.Score) {
    // u16 per the frozen field comment. A ten-minute trickshot match can
    // exceed 65535 points, so this saturates — see "Contract friction".
    w.u16(clampEnum(Math.round(p.score ?? 0), 0, 0xffff));
    w.u8(clampEnum(Math.round(p.kills ?? 0), 0, 255));
    w.u8(clampEnum(Math.round(p.deaths ?? 0), 0, 255));
    w.u8(clampEnum(Math.round(p.streak ?? 0), 0, 255));
  }
  if (mask & SnapshotField.Identity) {
    w.u8((p.team ?? TeamId.FFA) & 0xff);
    w.str(p.name ?? '');
    writeLoadout(w, p.loadout);
  }
  if (mask & SnapshotField.Ping) w.u16(clampEnum(Math.round(p.ping ?? 0), 0, 0xffff));
}

function readSnapshotPlayer(r: ByteReader): SnapshotPlayerExt {
  const id = r.u8();
  const mask = r.u16();

  const p: SnapshotPlayerExt = {
    id,
    mask,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: false,
    alive: false,
    health: 0,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    firedThisTick: false,
  };

  if (mask & SnapshotField.Position) p.position = readPos(r);
  if (mask & SnapshotField.Velocity) p.velocity = readVel(r);
  if (mask & SnapshotField.Yaw) p.yaw = dequantizeAngle(r.u16());
  if (mask & SnapshotField.Pitch) p.pitch = dequantizePitch(r.i16());
  if (mask & SnapshotField.Stance) p.stance = clampEnum(r.u8(), Stance.Stand, Stance.Slide);
  if (mask & SnapshotField.Flags) {
    const f = r.u8();
    p.onGround = (f & FLAG_ON_GROUND) !== 0;
    p.alive = (f & FLAG_ALIVE) !== 0;
    p.firedThisTick = (f & FLAG_FIRED) !== 0;
    p.downed = (f & FLAG_DOWNED) !== 0;
  }
  if (mask & SnapshotField.Health) p.health = r.u8();
  if (mask & SnapshotField.Weapon) {
    p.activeWeapon = clampEnum(r.u8(), WeaponId.Talon, WeaponId.Harrier);
  }
  if (mask & SnapshotField.Ads) {
    p.adsState = clampEnum(r.u8() & 0x03, AdsState.Hip, AdsState.Lowering);
    p.adsProgress = dequantizeUnit(r.u8());
  }
  if (mask & SnapshotField.Score) {
    p.score = r.u16();
    p.kills = r.u8();
    p.deaths = r.u8();
    p.streak = r.u8();
  }
  if (mask & SnapshotField.Identity) {
    p.team = r.u8() as TeamId;
    p.name = r.str();
    p.loadout = readLoadout(r);
  }
  if (mask & SnapshotField.Ping) p.ping = r.u16();

  return p;
}

// ---------------------------------------------------------------------------
// Kill payload (shared between Kill and MatchOver.bestTrickshot)
// ---------------------------------------------------------------------------

function writeKill(w: ByteWriter, k: KillMsg): void {
  w.u8(k.killerId & 0xff);
  w.u8(k.victimId & 0xff);
  w.u8(k.weapon);
  w.u8(k.part);
  // Distance fits comfortably in u16 at 1/16 m over the 62 m map.
  w.u16(clampEnum(Math.round((Number.isFinite(k.distance) ? k.distance : 0) * 16), 0, 0xffff));
  w.u16(k.trickshot & 0xffff);
  w.u8(clampEnum(k.collateralCount, 0, 255));
  w.u32(Math.max(0, Math.round(Number.isFinite(k.score) ? k.score : 0)));
  w.u8(k.suppressed ? 1 : 0);
  writePos(w, k.killerPosition);
}

function readKill(r: ByteReader): KillMsg {
  const killerId = r.u8();
  const victimId = r.u8();
  const weapon = clampEnum(r.u8(), WeaponId.Talon, WeaponId.Harrier) as WeaponId;
  const part = clampEnum(r.u8(), HitboxPart.Head, HitboxPart.LegR) as HitboxPart;
  const distance = r.u16() / 16;
  const trickshot = r.u16();
  const collateralCount = r.u8();
  const score = r.u32();
  const suppressed = r.u8() !== 0;
  const killerPosition = readPos(r);
  return {
    killerId,
    victimId,
    weapon,
    part,
    distance,
    trickshot,
    collateralCount,
    score,
    suppressed,
    killerPosition,
  };
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

function encodeClientMessage(w: ByteWriter, msg: AnyClientMessage): void {
  w.u8(msg.type);
  switch (msg.type) {
    case ClientMessage.Hello: {
      const d = msg.data as HelloMsg;
      w.str(d.version ?? '');
      w.str(d.name ?? '');
      if (d.resumeToken) {
        w.u8(1);
        w.str(d.resumeToken);
      } else {
        w.u8(0);
      }
      return;
    }
    case ClientMessage.CreateLobby: {
      const d = msg.data as CreateLobbyMsg;
      w.u8(d.mode);
      w.u16(clampEnum(Math.round(d.scoreLimit), 0, 0xffff));
      return;
    }
    case ClientMessage.JoinLobby: {
      w.str((msg.data as JoinLobbyMsg).code ?? '');
      return;
    }
    case ClientMessage.QuickPlay:
    case ClientMessage.LeaveLobby:
    case ClientMessage.RequestRespawn:
      return;
    case ClientMessage.SetReady: {
      w.u8(msg.data.ready ? 1 : 0);
      return;
    }
    case ClientMessage.SetMatchConfig: {
      const d = msg.data as SetMatchConfigMsg;
      w.u8(d.mode);
      w.u16(clampEnum(Math.round(d.scoreLimit), 0, 0xffff));
      w.u16(clampEnum(Math.round(d.timeLimit), 0, 0xffff));
      return;
    }
    case ClientMessage.SetLoadout: {
      writeLoadout(w, (msg.data as SetLoadoutMsg).loadout);
      return;
    }
    case ClientMessage.Chat: {
      w.str(msg.data.text ?? '');
      return;
    }
    case ClientMessage.Input: {
      writeInput(w, msg.data as InputMsg);
      return;
    }
    case ClientMessage.Pong: {
      w.f64(msg.data.time);
      return;
    }
    case ClientMessage.Purchase: {
      const d = msg.data as PurchaseMsg;
      w.u8(d.kind & 0xff);
      w.u8(d.itemId & 0xff);
      return;
    }
    case ClientMessage.Interact: {
      w.u8((msg.data as InteractMsg).target & 0xff);
      return;
    }
    default: {
      // Exhaustiveness: a new ClientMessage without a case is a compile error.
      const never: never = msg;
      throw new DecodeError(`unencodable client message ${JSON.stringify(never)}`);
    }
  }
}

/**
 * The one layout protocol.ts specifies byte for byte:
 *
 *   u8 type, u8 count, u16 baseSeq, u32 tick, then `count` x
 *   (i8 moveX, i8 moveZ, u16 yaw, i16 pitch, u16 buttons)
 *
 * Each input's seq is baseSeq + i, so only the first is transmitted. The same
 * relation is applied to `tick`: inputs in one packet are consecutive ticks.
 */
function writeInput(w: ByteWriter, d: InputMsg): void {
  const list = d.inputs ?? [];
  const count = list.length > INPUT_REDUNDANCY ? INPUT_REDUNDANCY : list.length;
  if (count <= 0) {
    // A zero-length input packet is legal but useless; keep it decodable.
    w.u8(0);
    w.u16(0);
    w.u32(0);
    return;
  }
  const first = list[list.length - count];
  w.u8(count);
  w.u16(first.seq & 0xffff);
  w.u32(first.tick >>> 0);
  for (let i = 0; i < count; i++) {
    const inp = list[list.length - count + i];
    w.i8(quantizeAxis(inp.moveX));
    w.i8(quantizeAxis(inp.moveZ));
    w.u16(quantizeAngle(inp.yaw));
    w.i16(quantizePitch(inp.pitch));
    w.u16(inp.buttons & 0xffff);
  }
}

function readInput(r: ByteReader): InputMsg {
  const count = r.u8();
  const baseSeq = r.u16();
  const baseTick = r.u32();
  if (count > INPUT_REDUNDANCY) {
    throw new DecodeError(`input count ${count} exceeds INPUT_REDUNDANCY`);
  }
  const inputs: ClientInput[] = [];
  for (let i = 0; i < count; i++) {
    const moveX = dequantizeAxis(r.i8());
    const moveZ = dequantizeAxis(r.i8());
    const yaw = dequantizeAngle(r.u16());
    const pitch = dequantizePitch(r.i16());
    const buttons = r.u16();
    inputs.push({
      seq: (baseSeq + i) & 0xffff,
      tick: (baseTick + i) >>> 0,
      moveX,
      moveZ,
      yaw,
      pitch,
      buttons,
    });
  }
  return { inputs };
}

function decodeClientMessage(r: ByteReader): AnyClientMessage {
  const type = r.u8() as ClientMessage;
  switch (type) {
    case ClientMessage.Hello: {
      const version = r.str();
      const name = r.str();
      const hasToken = r.u8() !== 0;
      const data: HelloMsg = { version, name };
      if (hasToken) data.resumeToken = r.str();
      return { type, data };
    }
    case ClientMessage.CreateLobby:
      return {
        type,
        data: { mode: clampEnum(r.u8(), GameMode.SnipersOnlyFFA, GameMode.Survival), scoreLimit: r.u16() },
      };
    case ClientMessage.JoinLobby:
      return { type, data: { code: r.str() } };
    case ClientMessage.QuickPlay:
    case ClientMessage.LeaveLobby:
    case ClientMessage.RequestRespawn:
      return { type, data: {} };
    case ClientMessage.SetReady:
      return { type, data: { ready: r.u8() !== 0 } };
    case ClientMessage.SetMatchConfig:
      return {
        type,
        data: {
          mode: clampEnum(r.u8(), GameMode.SnipersOnlyFFA, GameMode.Survival),
          scoreLimit: r.u16(),
          timeLimit: r.u16(),
        },
      };
    case ClientMessage.SetLoadout:
      return { type, data: { loadout: readLoadout(r) } };
    case ClientMessage.Chat:
      return { type, data: { text: r.str() } };
    case ClientMessage.Input:
      return { type, data: readInput(r) };
    case ClientMessage.Pong:
      return { type, data: { time: r.f64() } };
    case ClientMessage.Purchase:
      return { type, data: { kind: r.u8(), itemId: r.u8() } };
    case ClientMessage.Interact:
      return { type, data: { target: r.u8() } };
    default:
      throw new DecodeError(`unknown client message type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

function encodeServerMessage(w: ByteWriter, msg: AnyServerMessage): void {
  w.u8(msg.type);
  switch (msg.type) {
    case ServerMessage.Welcome: {
      const d = msg.data as WelcomeMsg;
      w.u8(d.playerId & 0xff);
      w.str(d.resumeToken ?? '');
      w.f64(d.serverTime);
      w.u8(clampEnum(Math.round(d.tickRate), 0, 255));
      w.u8(clampEnum(Math.round(d.snapshotRate), 0, 255));
      return;
    }
    case ServerMessage.LobbyState: {
      const d = msg.data as LobbyStateMsg;
      w.str(d.code ?? '');
      w.u8(d.hostId & 0xff);
      w.u8(d.mode);
      w.u16(clampEnum(Math.round(d.scoreLimit), 0, 0xffff));
      w.u16(clampEnum(Math.round(d.timeLimit), 0, 0xffff));
      w.u8(d.inProgress ? 1 : 0);
      const players = d.players ?? [];
      const n = players.length > MAX_SCOREBOARD_ROWS ? MAX_SCOREBOARD_ROWS : players.length;
      w.u8(n);
      for (let i = 0; i < n; i++) {
        const p = players[i];
        w.u8(p.id & 0xff);
        w.str(p.name ?? '');
        w.u8(p.team & 0xff);
        w.u8((p.ready ? 1 : 0) | (p.isHost ? 2 : 0));
        w.u16(clampEnum(Math.round(p.ping), 0, 0xffff));
        writeLoadout(w, p.loadout);
      }
      return;
    }
    case ServerMessage.Error: {
      const d = msg.data as ErrorMsg;
      w.u8(d.code & 0xff);
      w.str(d.message ?? '');
      return;
    }
    case ServerMessage.Snapshot: {
      writeSnapshot(w, msg.data as SnapshotMsg);
      return;
    }
    case ServerMessage.RoundState: {
      const d = msg.data as RoundStateMsg;
      w.u8(d.phase);
      w.f32(d.timeRemaining);
      w.u16(clampEnum(Math.round(d.scoreLimit), 0, 0xffff));
      w.u16(clampEnum(Math.round(d.teamScores ? d.teamScores[0] : 0), 0, 0xffff));
      w.u16(clampEnum(Math.round(d.teamScores ? d.teamScores[1] : 0), 0, 0xffff));
      return;
    }
    case ServerMessage.Kill: {
      writeKill(w, msg.data as KillMsg);
      return;
    }
    case ServerMessage.Hit: {
      const d = msg.data as HitMsg;
      w.u8(d.attackerId & 0xff);
      w.u8(d.victimId & 0xff);
      w.u8(d.part);
      w.f32(d.damage);
      w.u8(d.penetrated ? 1 : 0);
      writePos(w, d.point);
      writeNormal(w, d.normal);
      return;
    }
    case ServerMessage.Spawn: {
      const d = msg.data as SpawnMsg;
      w.u8(d.playerId & 0xff);
      writePos(w, d.position);
      w.u16(quantizeAngle(d.yaw));
      writeLoadout(w, d.loadout);
      return;
    }
    case ServerMessage.Chat: {
      const d = msg.data as ChatMsg;
      w.u8(d.playerId & 0xff);
      w.str(d.text ?? '');
      return;
    }
    case ServerMessage.Ping: {
      w.f64(msg.data.time);
      return;
    }
    case ServerMessage.Correction: {
      const d = msg.data as CorrectionMsg;
      w.u16(d.seq & 0xffff);
      w.u8(d.reason & 0xff);
      const state = d.state as SnapshotPlayerExt;
      // A correction is never a delta: it must stand alone.
      const prev = state.mask;
      state.mask = prev === undefined ? SNAPSHOT_BASIC_FIELDS : prev;
      writeSnapshotPlayer(w, state);
      state.mask = prev;
      return;
    }
    case ServerMessage.MatchOver: {
      const d = msg.data as MatchOverMsg;
      const board = d.scoreboard ?? [];
      const n = board.length > MAX_SCOREBOARD_ROWS ? MAX_SCOREBOARD_ROWS : board.length;
      w.u8(n);
      for (let i = 0; i < n; i++) {
        const e = board[i];
        w.u8(e.id & 0xff);
        w.str(e.name ?? '');
        w.u8(e.team & 0xff);
        w.u32(Math.max(0, Math.round(e.score)));
        w.u16(clampEnum(Math.round(e.kills), 0, 0xffff));
        w.u16(clampEnum(Math.round(e.deaths), 0, 0xffff));
        w.u32(Math.max(0, Math.round(e.bestTrickshotScore)));
        w.u16(e.bestTrickshotFlags & 0xffff);
      }
      w.u8(d.winnerId & 0xff);
      w.u8(d.winnerTeam & 0xff);
      if (d.bestTrickshot) {
        w.u8(1);
        writeKill(w, d.bestTrickshot);
      } else {
        w.u8(0);
      }
      return;
    }
    case ServerMessage.SurvivalState: {
      const d = msg.data as SurvivalStateMsg;
      w.u16(clampEnum(Math.round(d.round), 0, 0xffff));
      w.u8(d.phase & 0xff);
      w.f32(d.timeRemaining);
      w.u16(clampEnum(Math.round(d.zombiesRemaining), 0, 0xffff));
      w.u8(d.powerOn ? 1 : 0);
      w.u16(d.zoneMask & 0xffff);
      w.u8(d.crateZone & 0xff);
      const ups = d.powerups ?? [];
      const un = ups.length > 8 ? 8 : ups.length;
      w.u8(un);
      for (let i = 0; i < un; i++) {
        w.u8(ups[i][0] & 0xff);
        w.f32(ups[i][1]);
      }
      w.u32(Math.max(0, Math.round(d.yourPoints)));
      w.u8(d.yourPerks & 0xff);
      w.f32(d.yourBleedout);
      w.u8(d.yourForged ? 1 : 0);
      w.u8(d.yourHeldWeapon & 0xff);
      w.u8(d.yourStowedWeapon & 0xff);
      w.u16(clampEnum(Math.round(d.yourAmmoInMag), 0, 0xffff));
      w.u16(clampEnum(Math.round(d.yourAmmoReserve), 0, 0xffff));
      w.u16(clampEnum(Math.round(d.yourStowedMag), 0, 0xffff));
      w.u16(clampEnum(Math.round(d.yourStowedReserve), 0, 0xffff));
      w.u8(d.yourCrateOffer & 0xff);
      return;
    }
    default: {
      const never: never = msg;
      throw new DecodeError(`unencodable server message ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Snapshot layout, following the protocol.ts comment exactly:
 *
 *   u8 type, u32 tick, u16 ackedSeq, u16 baselineTick, u8 playerCount,
 *   per player: u8 id, u16 fieldMask, present fields in ascending bit order
 *
 * then the one thing the comment omits but `SnapshotMsg` requires — the list
 * of players removed since the baseline:
 *
 *   u8 removedCount, u8 playerId x removedCount
 *
 * `baselineTick` is only 16 bits while `tick` is 32: the delta baseline is
 * always within a second of now, so the low half identifies it unambiguously.
 * 0 is reserved to mean "full state", and the assembler never picks a baseline
 * whose low 16 bits are 0.
 */
function writeSnapshot(w: ByteWriter, d: SnapshotMsg): void {
  w.u32(d.tick >>> 0);
  w.u16(d.ackedSeq & 0xffff);
  w.u16(d.baselineTick & 0xffff);
  const players = d.players ?? [];
  const n = players.length > MAX_SNAPSHOT_PLAYERS ? MAX_SNAPSHOT_PLAYERS : players.length;
  w.u8(n);
  for (let i = 0; i < n; i++) writeSnapshotPlayer(w, players[i] as SnapshotPlayerExt);
  const removed = d.removed ?? [];
  const rn = removed.length > MAX_SNAPSHOT_PLAYERS ? MAX_SNAPSHOT_PLAYERS : removed.length;
  w.u8(rn);
  for (let i = 0; i < rn; i++) w.u8(removed[i] & 0xff);
}

function readSnapshot(r: ByteReader): SnapshotMsg {
  const tick = r.u32();
  const ackedSeq = r.u16();
  const baselineTick = r.u16();
  const n = r.u8();
  if (n > MAX_SNAPSHOT_PLAYERS) throw new DecodeError(`snapshot player count ${n}`);
  const players: SnapshotPlayerExt[] = [];
  for (let i = 0; i < n; i++) players.push(readSnapshotPlayer(r));
  const rn = r.u8();
  if (rn > MAX_SNAPSHOT_PLAYERS) throw new DecodeError(`snapshot removed count ${rn}`);
  const removed: PlayerId[] = [];
  for (let i = 0; i < rn; i++) removed.push(r.u8());
  return { tick, ackedSeq, baselineTick, players, removed };
}

function decodeServerMessage(r: ByteReader): AnyServerMessage {
  const type = r.u8() as ServerMessage;
  switch (type) {
    case ServerMessage.Welcome:
      return {
        type,
        data: {
          playerId: r.u8(),
          resumeToken: r.str(),
          serverTime: r.f64(),
          tickRate: r.u8(),
          snapshotRate: r.u8(),
        },
      };
    case ServerMessage.LobbyState: {
      const code = r.str();
      const hostId = r.u8();
      const mode = clampEnum(r.u8(), GameMode.SnipersOnlyFFA, GameMode.Survival) as GameMode;
      const scoreLimit = r.u16();
      const timeLimit = r.u16();
      const inProgress = r.u8() !== 0;
      const n = r.u8();
      if (n > MAX_SCOREBOARD_ROWS) throw new DecodeError(`lobby player count ${n}`);
      const players: LobbyPlayerInfo[] = [];
      for (let i = 0; i < n; i++) {
        const id = r.u8();
        const name = r.str();
        const team = r.u8() as TeamId;
        const flags = r.u8();
        const ping = r.u16();
        const loadout = readLoadout(r);
        players.push({ id, name, team, ready: (flags & 1) !== 0, isHost: (flags & 2) !== 0, ping, loadout });
      }
      return { type, data: { code, hostId, mode, scoreLimit, timeLimit, players, inProgress } };
    }
    case ServerMessage.Error:
      return {
        type,
        data: { code: clampEnum(r.u8(), ErrorCode.Unknown, ErrorCode.RateLimited) as ErrorCode, message: r.str() },
      };
    case ServerMessage.Snapshot:
      return { type, data: readSnapshot(r) };
    case ServerMessage.RoundState: {
      const phase = clampEnum(r.u8(), RoundPhase.Warmup, RoundPhase.Over) as RoundPhase;
      const timeRemaining = r.f32();
      const scoreLimit = r.u16();
      const a = r.u16();
      const b = r.u16();
      return { type, data: { phase, timeRemaining, scoreLimit, teamScores: [a, b] } };
    }
    case ServerMessage.Kill:
      return { type, data: readKill(r) };
    case ServerMessage.Hit: {
      const attackerId = r.u8();
      const victimId = r.u8();
      const part = clampEnum(r.u8(), HitboxPart.Head, HitboxPart.LegR) as HitboxPart;
      const damage = r.f32();
      const penetrated = r.u8() !== 0;
      const point = readPos(r);
      const normal = readNormal(r);
      return { type, data: { attackerId, victimId, part, damage, penetrated, point, normal } };
    }
    case ServerMessage.Spawn: {
      const playerId = r.u8();
      const position = readPos(r);
      const yaw = dequantizeAngle(r.u16());
      const loadout = readLoadout(r);
      return { type, data: { playerId, position, yaw, loadout } };
    }
    case ServerMessage.Chat:
      return { type, data: { playerId: r.u8(), text: r.str() } };
    case ServerMessage.Ping:
      return { type, data: { time: r.f64() } };
    case ServerMessage.Correction: {
      const seq = r.u16();
      const reason = clampEnum(r.u8(), CorrectionReason.IllegalFire, CorrectionReason.RateLimited);
      const state = readSnapshotPlayer(r);
      return { type, data: { seq, reason: reason as CorrectionReason, state } };
    }
    case ServerMessage.MatchOver: {
      const n = r.u8();
      if (n > MAX_SCOREBOARD_ROWS) throw new DecodeError(`scoreboard rows ${n}`);
      const scoreboard: ScoreboardEntry[] = [];
      for (let i = 0; i < n; i++) {
        scoreboard.push({
          id: r.u8(),
          name: r.str(),
          team: r.u8() as TeamId,
          score: r.u32(),
          kills: r.u16(),
          deaths: r.u16(),
          bestTrickshotScore: r.u32(),
          bestTrickshotFlags: r.u16(),
        });
      }
      const winnerId = r.u8();
      const winnerTeam = r.u8() as TeamId;
      const hasBest = r.u8() !== 0;
      const bestTrickshot = hasBest ? readKill(r) : null;
      return { type, data: { scoreboard, winnerId, winnerTeam, bestTrickshot } };
    }
    case ServerMessage.SurvivalState: {
      const round = r.u16();
      const phase = r.u8();
      const timeRemaining = r.f32();
      const zombiesRemaining = r.u16();
      const powerOn = r.u8() !== 0;
      const zoneMask = r.u16();
      const crateZone = r.u8();
      const un = r.u8();
      if (un > 8) throw new DecodeError(`powerup count ${un}`);
      const powerups: Array<[number, number]> = [];
      for (let i = 0; i < un; i++) powerups.push([r.u8(), r.f32()]);
      const yourPoints = r.u32();
      const yourPerks = r.u8();
      const yourBleedout = r.f32();
      const yourForged = r.u8() !== 0;
      const yourHeldWeapon = clampEnum(r.u8(), WeaponId.Talon, WeaponId.Harrier) as WeaponId;
      const yourStowedWeapon = clampEnum(r.u8(), WeaponId.Talon, WeaponId.Harrier) as WeaponId;
      const yourAmmoInMag = r.u16();
      const yourAmmoReserve = r.u16();
      const yourStowedMag = r.u16();
      const yourStowedReserve = r.u16();
      const yourCrateOffer = r.u8();
      return {
        type,
        data: {
          round,
          phase,
          timeRemaining,
          zombiesRemaining,
          powerOn,
          zoneMask,
          crateZone,
          powerups,
          yourPoints,
          yourPerks,
          yourBleedout,
          yourForged,
          yourHeldWeapon,
          yourStowedWeapon,
          yourAmmoInMag,
          yourAmmoReserve,
          yourStowedMag,
          yourStowedReserve,
          yourCrateOffer,
        },
      };
    }
    default:
      throw new DecodeError(`unknown server message type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function guardInput(buf: ArrayBuffer | Uint8Array): void {
  const len = buf instanceof Uint8Array ? buf.byteLength : buf.byteLength;
  if (len === 0) throw new DecodeError('empty frame');
  if (len > MAX_MESSAGE_BYTES) throw new DecodeError(`frame too large: ${len}`);
}

export function encodeClient(msg: AnyClientMessage): ArrayBuffer {
  CLIENT_W.reset();
  encodeClientMessage(CLIENT_W, msg);
  return CLIENT_W.finish();
}

export function decodeClient(buf: ArrayBuffer | Uint8Array): AnyClientMessage {
  guardInput(buf);
  return decodeClientMessage(new ByteReader(buf));
}

export function encodeServer(msg: AnyServerMessage): ArrayBuffer {
  SERVER_W.reset();
  encodeServerMessage(SERVER_W, msg);
  return SERVER_W.finish();
}

export function decodeServer(buf: ArrayBuffer | Uint8Array): AnyServerMessage {
  guardInput(buf);
  return decodeServerMessage(new ByteReader(buf));
}

/**
 * Encoded size without producing a buffer. Used by the bandwidth accounting in
 * the snapshot assembler, which needs the number far more often than it needs
 * the bytes.
 */
export function encodedServerSize(msg: AnyServerMessage): number {
  SERVER_W.reset();
  encodeServerMessage(SERVER_W, msg);
  return SERVER_W.off;
}

export function encodedClientSize(msg: AnyClientMessage): number {
  CLIENT_W.reset();
  encodeClientMessage(CLIENT_W, msg);
  return CLIENT_W.off;
}

/** The frozen `Codec` contract from protocol.ts, implemented in full. */
export const codec: Codec = {
  encodeClient,
  decodeClient: (buf: ArrayBuffer) => decodeClient(buf),
  encodeServer,
  decodeServer: (buf: ArrayBuffer) => decodeServer(buf),
};

export default codec;

/** Re-exported so `MAX_PLAYERS` consumers do not import tuning just for a cap. */
export { MAX_PLAYERS };
