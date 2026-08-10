/**
 * DECKSHOT — wire codec tests.
 *
 * Owner: netcode-core.
 *
 * Three things are being defended here:
 *   1. Every message type survives encode -> decode unchanged, including the
 *      edge values (world corners, angle wrap, empty lists, 12 players, 255
 *      byte unicode names).
 *   2. Quantization is a projection. Encode -> decode -> encode is byte
 *      identical, which is what lets the server store what it sent.
 *   3. No malformed, truncated, oversized or hostile buffer can do anything
 *      worse than throw DecodeError.
 */

import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  MAX_MESSAGE_BYTES,
  SNAPSHOT_ALL_FIELDS,
  SNAPSHOT_BASIC_FIELDS,
  codec,
  decodeClient,
  decodeServer,
  encodeClient,
  encodeServer,
  type SnapshotPlayerExt,
} from '../shared/codec.js';
import {
  dequantizeAngle,
  dequantizePos,
  dequantizeVel,
  quantizeAngle,
  quantizeAxis,
  quantizePitch,
  quantizePos,
  quantizeVel,
  snapAngle,
  snapPos,
  snapVel,
} from '../shared/quantize.js';
import {
  ClientMessage,
  CorrectionReason,
  ErrorCode,
  ServerMessage,
  SnapshotField,
  type AnyClientMessage,
  type AnyServerMessage,
  type SnapshotMsg,
} from '../shared/protocol.js';
import {
  AdsState,
  AttachmentId,
  CamoId,
  GameMode,
  HitboxPart,
  InputButton,
  RoundPhase,
  SkinId,
  Stance,
  TeamId,
  WeaponId,
  type ClientInput,
  type Loadout,
} from '../shared/types.js';
import {
  ANGLE_QUANTIZATION,
  MAX_PLAYERS,
  POS_QUANTIZATION,
  WORLD_HALF_EXTENT,
} from '../shared/tuning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOADOUT: Loadout = {
  primary: WeaponId.Talon,
  attachments: [AttachmentId.FastDraw, AttachmentId.FMJ, AttachmentId.Suppressor],
  camo: CamoId.Gold,
  skin: SkinId.Fathom,
};

function bytes(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Absolute angular difference, taking the short way round. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function roundTripClient(msg: AnyClientMessage): AnyClientMessage {
  return decodeClient(encodeClient(msg));
}

function roundTripServer(msg: AnyServerMessage): AnyServerMessage {
  return decodeServer(encodeServer(msg));
}

function snapshotPlayer(id: number, over: Partial<SnapshotPlayerExt> = {}): SnapshotPlayerExt {
  return {
    id,
    position: { x: 1.5, y: 2.25, z: -3.125 },
    velocity: { x: 0.5, y: -1.25, z: 4 },
    yaw: 0.75,
    pitch: -0.25,
    stance: Stance.Crouch,
    onGround: true,
    alive: true,
    health: 87,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Scoped,
    adsProgress: 200 / 255,
    firedThisTick: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

describe('quantize', () => {
  it('position round-trips exactly at grid points across the whole world', () => {
    for (let q = 0; q <= 0xffff; q += 137) {
      const v = dequantizePos(q);
      expect(quantizePos(v)).toBe(q);
      expect(snapPos(v)).toBe(v);
    }
  });

  it('position saturates at the world extents instead of wrapping', () => {
    expect(quantizePos(-WORLD_HALF_EXTENT)).toBe(0);
    expect(quantizePos(-1e9)).toBe(0);
    expect(quantizePos(WORLD_HALF_EXTENT)).toBe(0xffff);
    expect(quantizePos(1e9)).toBe(0xffff);
    expect(quantizePos(Number.NaN)).toBe(0);
  });

  it('position error never exceeds half a quantization step', () => {
    for (let i = 0; i < 5000; i++) {
      const v = -WORLD_HALF_EXTENT + (i / 5000) * 2 * WORLD_HALF_EXTENT;
      expect(Math.abs(snapPos(v) - v)).toBeLessThanOrEqual(POS_QUANTIZATION / 2 + 1e-12);
    }
  });

  it('angles round-trip through the +/-PI seam without losing a step', () => {
    for (let q = 0; q < 65536; q += 71) {
      const rad = dequantizeAngle(q);
      expect(rad).toBeGreaterThan(-Math.PI - 1e-9);
      expect(rad).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(quantizeAngle(rad)).toBe(q);
      expect(snapAngle(rad)).toBe(rad);
    }
  });

  it('angle quantization is invariant to full turns', () => {
    const a = 1.234;
    expect(quantizeAngle(a)).toBe(quantizeAngle(a + 2 * Math.PI));
    expect(quantizeAngle(a)).toBe(quantizeAngle(a - 6 * Math.PI));
    expect(quantizeAngle(-Math.PI + ANGLE_QUANTIZATION)).toBe(32769);
  });

  it('velocity round-trips exactly at 1/64 m/s', () => {
    for (let q = -32768; q < 32767; q += 97) {
      const v = dequantizeVel(q);
      expect(quantizeVel(v)).toBe(q);
      expect(snapVel(v)).toBe(v);
    }
  });

  it('a snapped value re-encodes byte-identically (server stores what it sent)', () => {
    // This is the property the whole reconciliation loop rests on.
    const raw = { x: 12.3456789, y: -0.000123, z: 41.999999 };
    const once = { x: snapPos(raw.x), y: snapPos(raw.y), z: snapPos(raw.z) };
    const twice = { x: snapPos(once.x), y: snapPos(once.y), z: snapPos(once.z) };
    expect(twice).toEqual(once);
    expect(quantizePos(once.x)).toBe(quantizePos(twice.x));
  });

  it('axis quantization honours the documented -127..127 range', () => {
    expect(quantizeAxis(1)).toBe(127);
    expect(quantizeAxis(-1)).toBe(-127);
    expect(quantizeAxis(0)).toBe(0);
    expect(quantizeAxis(5)).toBe(127);
  });

  it('pitch saturates rather than wrapping', () => {
    expect(quantizePitch(10)).toBe(32767);
    expect(quantizePitch(-10)).toBe(-32768);
  });
});

// ---------------------------------------------------------------------------
// Client messages
// ---------------------------------------------------------------------------

describe('client message round trips', () => {
  it('Hello with and without a resume token', () => {
    const a = roundTripClient({
      type: ClientMessage.Hello,
      data: { version: '1.0.0', name: 'Fredrin' },
    });
    expect(a).toEqual({ type: ClientMessage.Hello, data: { version: '1.0.0', name: 'Fredrin' } });

    const b = roundTripClient({
      type: ClientMessage.Hello,
      data: { version: '1.0.0', name: 'Fredrin', resumeToken: 'abc123-def456' },
    });
    expect(b.data).toEqual({ version: '1.0.0', name: 'Fredrin', resumeToken: 'abc123-def456' });
  });

  it('Hello with a unicode name', () => {
    const name = 'ﾃﾞｯｷｼｮｯﾄ 🎯🔫 Ünïcødé';
    const out = roundTripClient({ type: ClientMessage.Hello, data: { version: 'v', name } });
    expect((out.data as { name: string }).name).toBe(name);
  });

  it('Hello with a name longer than the 255-byte field is cut on a codepoint edge', () => {
    const name = '🎯'.repeat(200); // 800 UTF-8 bytes
    const out = roundTripClient({ type: ClientMessage.Hello, data: { version: 'v', name } });
    const got = (out.data as { name: string }).name;
    expect(got.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(got).length).toBeLessThanOrEqual(255);
    // No half-surrogate survived the truncation.
    expect(got).toBe('🎯'.repeat(got.length / 2));
  });

  it('CreateLobby / JoinLobby / QuickPlay / LeaveLobby / RequestRespawn', () => {
    expect(
      roundTripClient({
        type: ClientMessage.CreateLobby,
        data: { mode: GameMode.TeamDeathmatch, scoreLimit: 50 },
      })
    ).toEqual({ type: ClientMessage.CreateLobby, data: { mode: GameMode.TeamDeathmatch, scoreLimit: 50 } });

    expect(roundTripClient({ type: ClientMessage.JoinLobby, data: { code: 'K7QX' } })).toEqual({
      type: ClientMessage.JoinLobby,
      data: { code: 'K7QX' },
    });

    expect(roundTripClient({ type: ClientMessage.QuickPlay, data: {} }).type).toBe(
      ClientMessage.QuickPlay
    );
    expect(roundTripClient({ type: ClientMessage.LeaveLobby, data: {} }).type).toBe(
      ClientMessage.LeaveLobby
    );
    expect(roundTripClient({ type: ClientMessage.RequestRespawn, data: {} }).type).toBe(
      ClientMessage.RequestRespawn
    );
  });

  it('SetReady / SetMatchConfig / SetLoadout / Chat / Pong', () => {
    expect(roundTripClient({ type: ClientMessage.SetReady, data: { ready: true } }).data).toEqual({
      ready: true,
    });
    expect(
      roundTripClient({
        type: ClientMessage.SetMatchConfig,
        data: { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30, timeLimit: 600 },
      }).data
    ).toEqual({ mode: GameMode.SnipersOnlyFFA, scoreLimit: 30, timeLimit: 600 });
    expect(
      roundTripClient({ type: ClientMessage.SetLoadout, data: { loadout: LOADOUT } }).data
    ).toEqual({ loadout: LOADOUT });
    expect(roundTripClient({ type: ClientMessage.Chat, data: { text: 'gg 360 no scope' } }).data).toEqual(
      { text: 'gg 360 no scope' }
    );
    expect(roundTripClient({ type: ClientMessage.Pong, data: { time: 1234567.5 } }).data).toEqual({
      time: 1234567.5,
    });
  });

  it('every SkinId survives the loadout round trip', () => {
    for (const skin of [SkinId.Vanguard, SkinId.Frogman, SkinId.Commodore, SkinId.Fathom, SkinId.Breacher]) {
      const out = roundTripClient({
        type: ClientMessage.SetLoadout,
        data: { loadout: { ...LOADOUT, skin } },
      }).data as { loadout: Loadout };
      expect(out.loadout.skin).toBe(skin);
    }
  });

  it('an out-of-range skin byte clamps to the last skin rather than throwing', () => {
    // Simulate a stale/hostile client sending a skin id past the enum: encode
    // a valid message, then bump the skin byte (the last loadout byte) out of
    // range. The decoder must clamp, not throw — a garbage skin is a cosmetic
    // problem; closing the socket over one is a gameplay problem.
    const buf = encodeClient({ type: ClientMessage.SetLoadout, data: { loadout: LOADOUT } });
    const view = new Uint8Array(buf);
    view[view.length - 1] = 250;
    const out = decodeClient(buf).data as { loadout: Loadout };
    expect(out.loadout.skin).toBe(SkinId.Breacher);
    view[view.length - 1] = SkinId.Vanguard;
    const out2 = decodeClient(buf).data as { loadout: Loadout };
    expect(out2.loadout.skin).toBe(SkinId.Vanguard);
  });

  it('Input carries INPUT_REDUNDANCY inputs with consecutive seqs', () => {
    const inputs: ClientInput[] = [];
    for (let i = 0; i < 3; i++) {
      inputs.push({
        seq: (65534 + i) & 0xffff,
        tick: 1000 + i,
        moveX: i === 0 ? 1 : -1,
        moveZ: 0,
        yaw: 0.5 + i * 0.01,
        pitch: -0.2,
        buttons: InputButton.Fire | InputButton.Ads | InputButton.ZoomToggle,
      });
    }
    const out = roundTripClient({ type: ClientMessage.Input, data: { inputs } });
    const got = (out.data as { inputs: ClientInput[] }).inputs;
    expect(got).toHaveLength(3);
    // Seq wraps across the 16-bit boundary inside a single packet.
    expect(got.map((i) => i.seq)).toEqual([65534, 65535, 0]);
    expect(got.map((i) => i.tick)).toEqual([1000, 1001, 1002]);
    for (let i = 0; i < 3; i++) {
      expect(got[i].buttons).toBe(inputs[i].buttons);
      expect(got[i].moveX).toBeCloseTo(inputs[i].moveX, 2);
      expect(got[i].yaw).toBeCloseTo(inputs[i].yaw, 4);
      expect(got[i].pitch).toBeCloseTo(inputs[i].pitch, 4);
    }
  });

  it('Input matches the documented byte length', () => {
    const inputs: ClientInput[] = [0, 1, 2].map((i) => ({
      seq: i,
      tick: i,
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    }));
    const buf = encodeClient({ type: ClientMessage.Input, data: { inputs } });
    // u8 type + u8 count + u16 baseSeq + u32 tick + 3 * 8
    expect(buf.byteLength).toBe(1 + 1 + 2 + 4 + 3 * 8);
  });

  it('an empty Input packet is legal and decodes to no inputs', () => {
    const out = roundTripClient({ type: ClientMessage.Input, data: { inputs: [] } });
    expect((out.data as { inputs: ClientInput[] }).inputs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

describe('server message round trips', () => {
  it('Welcome', () => {
    const out = roundTripServer({
      type: ServerMessage.Welcome,
      data: { playerId: 7, resumeToken: 'tok-abc', serverTime: 987654.25, tickRate: 60, snapshotRate: 20 },
    });
    expect(out.data).toEqual({
      playerId: 7,
      resumeToken: 'tok-abc',
      serverTime: 987654.25,
      tickRate: 60,
      snapshotRate: 20,
    });
  });

  it('LobbyState with an empty roster', () => {
    const out = roundTripServer({
      type: ServerMessage.LobbyState,
      data: {
        code: 'ABCD',
        hostId: 0,
        mode: GameMode.SnipersOnlyFFA,
        scoreLimit: 30,
        timeLimit: 600,
        players: [],
        inProgress: false,
      },
    });
    expect((out.data as { players: unknown[] }).players).toEqual([]);
  });

  it('LobbyState with MAX_PLAYERS members', () => {
    const players = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      players.push({
        id: i + 1,
        name: `player-${i}-ü🎯`,
        team: i % 2 === 0 ? TeamId.Alpha : TeamId.Bravo,
        ready: i % 3 === 0,
        isHost: i === 0,
        ping: i * 13,
        loadout: LOADOUT,
      });
    }
    const out = roundTripServer({
      type: ServerMessage.LobbyState,
      data: {
        code: 'K7QX',
        hostId: 1,
        mode: GameMode.TeamDeathmatch,
        scoreLimit: 50,
        timeLimit: 600,
        players,
        inProgress: true,
      },
    });
    expect(out.data).toEqual({
      code: 'K7QX',
      hostId: 1,
      mode: GameMode.TeamDeathmatch,
      scoreLimit: 50,
      timeLimit: 600,
      players,
      inProgress: true,
    });
  });

  it('Error', () => {
    const out = roundTripServer({
      type: ServerMessage.Error,
      data: { code: ErrorCode.LobbyFull, message: 'That lobby is full.' },
    });
    expect(out.data).toEqual({ code: ErrorCode.LobbyFull, message: 'That lobby is full.' });
  });

  it('RoundState / Kill / Hit / Spawn / Chat / Ping', () => {
    expect(
      roundTripServer({
        type: ServerMessage.RoundState,
        data: { phase: RoundPhase.Live, timeRemaining: 123.5, scoreLimit: 30, teamScores: [4, 9] },
      }).data
    ).toEqual({ phase: RoundPhase.Live, timeRemaining: 123.5, scoreLimit: 30, teamScores: [4, 9] });

    const kill = {
      killerId: 3,
      victimId: 9,
      weapon: WeaponId.Talon,
      part: HitboxPart.Head,
      distance: 44.5,
      trickshot: 0b101010101010,
      collateralCount: 2,
      score: 1450,
      suppressed: true,
      killerPosition: { x: -12.5, y: 3.25, z: 20.75 },
    };
    expect(roundTripServer({ type: ServerMessage.Kill, data: kill }).data).toEqual(kill);

    const hitOut = roundTripServer({
      type: ServerMessage.Hit,
      data: {
        attackerId: 1,
        victimId: 2,
        part: HitboxPart.LegR,
        damage: 65.5,
        penetrated: true,
        point: { x: 1.25, y: 0.5, z: -2.75 },
        normal: { x: 0, y: 1, z: 0 },
      },
    }).data as { damage: number; normal: { y: number } };
    expect(hitOut.damage).toBeCloseTo(65.5, 3);
    expect(hitOut.normal.y).toBeCloseTo(1, 4);

    expect(
      roundTripServer({
        type: ServerMessage.Spawn,
        data: { playerId: 5, position: { x: 0, y: 0.75, z: 29.25 }, yaw: 0, loadout: LOADOUT },
      }).data
    ).toEqual({ playerId: 5, position: { x: 0, y: 0.75, z: 29.25 }, yaw: 0, loadout: LOADOUT });

    expect(
      roundTripServer({ type: ServerMessage.Chat, data: { playerId: 2, text: 'ez 🎯' } }).data
    ).toEqual({ playerId: 2, text: 'ez 🎯' });

    expect(roundTripServer({ type: ServerMessage.Ping, data: { time: 42.125 } }).data).toEqual({
      time: 42.125,
    });
  });

  it('Correction carries a self-contained state', () => {
    const out = roundTripServer({
      type: ServerMessage.Correction,
      data: {
        seq: 40000,
        reason: CorrectionReason.IllegalFire,
        state: snapshotPlayer(4, { mask: undefined }),
      },
    });
    const d = out.data as { seq: number; reason: number; state: SnapshotPlayerExt };
    expect(d.seq).toBe(40000);
    expect(d.reason).toBe(CorrectionReason.IllegalFire);
    expect(d.state.mask! & SNAPSHOT_BASIC_FIELDS).toBe(SNAPSHOT_BASIC_FIELDS);
    expect(d.state.position.x).toBeCloseTo(1.5, 3);
  });

  it('MatchOver with and without a best trickshot', () => {
    const board = [
      {
        id: 1,
        name: 'winner 🎯',
        team: TeamId.FFA,
        score: 123456, // deliberately > u16 to prove the wider field
        kills: 30,
        deaths: 4,
        bestTrickshotScore: 2450,
        bestTrickshotFlags: 0b1101,
      },
    ];
    const withBest = roundTripServer({
      type: ServerMessage.MatchOver,
      data: {
        scoreboard: board,
        winnerId: 1,
        winnerTeam: TeamId.FFA,
        bestTrickshot: {
          killerId: 1,
          victimId: 2,
          weapon: WeaponId.Talon,
          part: HitboxPart.Head,
          distance: 51,
          trickshot: 0b1010,
          collateralCount: 1,
          score: 2450,
          suppressed: false,
          killerPosition: { x: 1, y: 2, z: 3 },
        },
      },
    }).data as { scoreboard: typeof board; bestTrickshot: unknown };
    expect(withBest.scoreboard).toEqual(board);
    expect(withBest.bestTrickshot).not.toBeNull();

    const without = roundTripServer({
      type: ServerMessage.MatchOver,
      data: { scoreboard: [], winnerId: 0, winnerTeam: TeamId.None, bestTrickshot: null },
    }).data as { bestTrickshot: unknown };
    expect(without.bestTrickshot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe('snapshots', () => {
  it('an empty snapshot round-trips', () => {
    const msg: SnapshotMsg = { tick: 0, ackedSeq: 0, baselineTick: 0, players: [], removed: [] };
    const out = roundTripServer({ type: ServerMessage.Snapshot, data: msg }).data as SnapshotMsg;
    expect(out).toEqual(msg);
  });

  it('12 players with full state round-trip within quantization error', () => {
    const players: SnapshotPlayerExt[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      players.push(
        snapshotPlayer(i + 1, {
          mask: SNAPSHOT_ALL_FIELDS,
          position: { x: i * 3.5 - 20, y: 1.25 + i * 0.1, z: 30 - i * 4 },
          velocity: { x: i * 0.5, y: -i, z: 7.25 },
          yaw: -Math.PI + (i * Math.PI) / 6,
          pitch: -1.5 + i * 0.2,
          score: 1000 + i,
          kills: i,
          deaths: 12 - i,
          streak: i % 5,
          team: i % 2 ? TeamId.Alpha : TeamId.Bravo,
          name: `p${i}-🎯`,
          loadout: LOADOUT,
          ping: 20 + i * 11,
        })
      );
    }
    const msg: SnapshotMsg = {
      tick: 123456,
      ackedSeq: 65535,
      baselineTick: 0,
      players,
      removed: [99, 100],
    };
    const out = roundTripServer({ type: ServerMessage.Snapshot, data: msg }).data as SnapshotMsg;
    expect(out.tick).toBe(123456);
    expect(out.ackedSeq).toBe(65535);
    expect(out.removed).toEqual([99, 100]);
    expect(out.players).toHaveLength(MAX_PLAYERS);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const a = players[i];
      const b = out.players[i] as SnapshotPlayerExt;
      expect(b.id).toBe(a.id);
      expect(b.position.x).toBeCloseTo(a.position.x, 2);
      expect(b.position.y).toBeCloseTo(a.position.y, 2);
      expect(b.position.z).toBeCloseTo(a.position.z, 2);
      expect(b.velocity.z).toBeCloseTo(a.velocity.z, 1);
      // Yaw lives in (-PI, PI], so -PI legitimately decodes as +PI.
      expect(angleDelta(b.yaw, a.yaw)).toBeLessThan(1e-4);
      expect(b.pitch).toBeCloseTo(a.pitch, 4);
      expect(b.stance).toBe(a.stance);
      expect(b.alive).toBe(a.alive);
      expect(b.onGround).toBe(a.onGround);
      expect(b.health).toBe(a.health);
      expect(b.name).toBe(a.name);
      expect(b.loadout).toEqual(a.loadout);
      expect(b.ping).toBe(a.ping);
      expect(b.score).toBe(a.score);
    }
  });

  it('world-corner positions survive the encoding', () => {
    const extremes = [
      { x: -WORLD_HALF_EXTENT, y: -WORLD_HALF_EXTENT, z: -WORLD_HALF_EXTENT },
      { x: WORLD_HALF_EXTENT - POS_QUANTIZATION, y: 0, z: WORLD_HALF_EXTENT - POS_QUANTIZATION },
    ];
    for (const position of extremes) {
      const msg: SnapshotMsg = {
        tick: 1,
        ackedSeq: 0,
        baselineTick: 0,
        players: [snapshotPlayer(1, { position })],
        removed: [],
      };
      const out = roundTripServer({ type: ServerMessage.Snapshot, data: msg }).data as SnapshotMsg;
      expect(out.players[0].position.x).toBeCloseTo(position.x, 3);
      expect(out.players[0].position.z).toBeCloseTo(position.z, 3);
    }
  });

  it('re-encoding a decoded snapshot is byte-identical', () => {
    // The property that lets the server keep what it sent: one pass through
    // the codec reaches the fixed point.
    const msg: SnapshotMsg = {
      tick: 777,
      ackedSeq: 4242,
      baselineTick: 0,
      players: [
        snapshotPlayer(1, { mask: SNAPSHOT_ALL_FIELDS, name: 'ünï', loadout: LOADOUT, score: 9, kills: 1, deaths: 2, streak: 3, team: TeamId.Alpha, ping: 55 }),
        snapshotPlayer(2, { position: { x: -101.13, y: 0.001, z: 63.77 } }),
      ],
      removed: [4],
    };
    const first = encodeServer({ type: ServerMessage.Snapshot, data: msg });
    const decoded = decodeServer(first);
    const second = encodeServer(decoded);
    expect(bytes(second)).toBe(bytes(first));
  });

  it('delta compression: a still player costs far fewer bytes than a moving one', () => {
    const still = snapshotPlayer(1, { mask: 0 });
    const moving = snapshotPlayer(1, { mask: SNAPSHOT_BASIC_FIELDS });

    const size = (p: SnapshotPlayerExt): number =>
      encodeServer({
        type: ServerMessage.Snapshot,
        data: { tick: 1, ackedSeq: 1, baselineTick: 1, players: [p], removed: [] },
      }).byteLength;

    const stillBytes = size(still);
    const movingBytes = size(moving);
    // An unchanged player costs id + mask only.
    expect(movingBytes - stillBytes).toBe(6 + 6 + 2 + 2 + 1 + 1 + 1 + 1 + 2);
    expect(stillBytes * 2).toBeLessThan(movingBytes);
  });

  it('a partial mask only carries the fields it claims', () => {
    const p = snapshotPlayer(3, { mask: SnapshotField.Position | SnapshotField.Yaw });
    const out = roundTripServer({
      type: ServerMessage.Snapshot,
      data: { tick: 5, ackedSeq: 0, baselineTick: 4, players: [p], removed: [] },
    }).data as SnapshotMsg;
    const got = out.players[0] as SnapshotPlayerExt;
    expect(got.mask).toBe(SnapshotField.Position | SnapshotField.Yaw);
    expect(got.position.x).toBeCloseTo(1.5, 3);
    expect(got.yaw).toBeCloseTo(0.75, 4);
    // Absent fields decode to defaults; the client merges them from a baseline.
    expect(got.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(got.health).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

describe('malformed input', () => {
  it('rejects an empty frame', () => {
    expect(() => decodeClient(new ArrayBuffer(0))).toThrow(DecodeError);
    expect(() => decodeServer(new ArrayBuffer(0))).toThrow(DecodeError);
  });

  it('rejects an oversized frame', () => {
    const big = new ArrayBuffer(MAX_MESSAGE_BYTES + 1);
    new Uint8Array(big)[0] = ClientMessage.Chat;
    expect(() => decodeClient(big)).toThrow(DecodeError);
  });

  it('rejects unknown message types', () => {
    // 13 (Purchase) and 14 (Interact) became real messages with SURVIVAL;
    // 15 is the new first unknown client type, 77 the first unknown server one.
    for (const t of [0, 15, 63, 99, 200, 255]) {
      const buf = new Uint8Array([t, 0, 0, 0]);
      expect(() => decodeClient(buf.buffer)).toThrow(DecodeError);
    }
    for (const t of [0, 1, 63, 77, 255]) {
      const buf = new Uint8Array([t, 0, 0, 0]);
      expect(() => decodeServer(buf.buffer)).toThrow(DecodeError);
    }
  });

  it('every truncation of every message throws DecodeError and never hangs', () => {
    const clientMsgs: AnyClientMessage[] = [
      { type: ClientMessage.Hello, data: { version: '1.0.0', name: 'a🎯', resumeToken: 'tok' } },
      { type: ClientMessage.CreateLobby, data: { mode: GameMode.TeamDeathmatch, scoreLimit: 50 } },
      { type: ClientMessage.JoinLobby, data: { code: 'K7QX' } },
      { type: ClientMessage.SetLoadout, data: { loadout: LOADOUT } },
      { type: ClientMessage.Chat, data: { text: 'hello' } },
      {
        type: ClientMessage.Input,
        data: {
          inputs: [0, 1, 2].map((i) => ({
            seq: i,
            tick: i,
            moveX: 1,
            moveZ: -1,
            yaw: 1,
            pitch: 0.5,
            buttons: 3,
          })),
        },
      },
      { type: ClientMessage.Pong, data: { time: 1 } },
    ];
    for (const msg of clientMsgs) {
      const full = new Uint8Array(encodeClient(msg));
      for (let n = 1; n < full.length; n++) {
        expect(() => decodeClient(full.slice(0, n).buffer)).toThrow(DecodeError);
      }
    }

    const serverMsgs: AnyServerMessage[] = [
      {
        type: ServerMessage.Welcome,
        data: { playerId: 1, resumeToken: 'tok', serverTime: 1, tickRate: 60, snapshotRate: 20 },
      },
      {
        type: ServerMessage.LobbyState,
        data: {
          code: 'ABCD',
          hostId: 1,
          mode: GameMode.SnipersOnlyFFA,
          scoreLimit: 30,
          timeLimit: 600,
          players: [
            { id: 1, name: 'x', team: TeamId.FFA, ready: true, isHost: true, ping: 30, loadout: LOADOUT },
          ],
          inProgress: false,
        },
      },
      {
        type: ServerMessage.Snapshot,
        data: {
          tick: 10,
          ackedSeq: 5,
          baselineTick: 0,
          players: [snapshotPlayer(1, { mask: SNAPSHOT_ALL_FIELDS, name: 'n', loadout: LOADOUT, score: 1, kills: 1, deaths: 1, streak: 1, team: TeamId.FFA, ping: 1 })],
          removed: [2, 3],
        },
      },
      {
        type: ServerMessage.MatchOver,
        data: {
          scoreboard: [
            {
              id: 1,
              name: 'w',
              team: TeamId.FFA,
              score: 1,
              kills: 1,
              deaths: 1,
              bestTrickshotScore: 1,
              bestTrickshotFlags: 1,
            },
          ],
          winnerId: 1,
          winnerTeam: TeamId.FFA,
          bestTrickshot: null,
        },
      },
    ];
    for (const msg of serverMsgs) {
      const full = new Uint8Array(encodeServer(msg));
      for (let n = 1; n < full.length; n++) {
        expect(() => decodeServer(full.slice(0, n).buffer)).toThrow(DecodeError);
      }
    }
  });

  it('survives random garbage without crashing or hanging', () => {
    let seed = 0x1234abcd;
    const rand = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let trial = 0; trial < 4000; trial++) {
      const len = 1 + Math.floor(rand() * 96);
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) buf[i] = Math.floor(rand() * 256);
      // Bias the first byte toward valid discriminants so real paths get hit.
      if (trial % 2 === 0) buf[0] = 1 + Math.floor(rand() * 12);
      else buf[0] = 64 + Math.floor(rand() * 12);
      try {
        decodeClient(buf.buffer.slice(0));
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError);
      }
      try {
        decodeServer(buf.buffer.slice(0));
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError);
      }
    }
  });

  it('rejects an Input packet claiming more than INPUT_REDUNDANCY inputs', () => {
    const buf = new Uint8Array(2 + 2 + 4 + 8 * 20);
    buf[0] = ClientMessage.Input;
    buf[1] = 20;
    expect(() => decodeClient(buf.buffer)).toThrow(DecodeError);
  });

  it('rejects a snapshot claiming an absurd player count', () => {
    const buf = new Uint8Array(64);
    buf[0] = ServerMessage.Snapshot;
    buf[9] = 200; // playerCount byte
    expect(() => decodeServer(buf.buffer)).toThrow(DecodeError);
  });
});

// ---------------------------------------------------------------------------
// The frozen interface
// ---------------------------------------------------------------------------

describe('Codec interface', () => {
  it('the exported codec implements the frozen contract', () => {
    const msg: AnyClientMessage = { type: ClientMessage.QuickPlay, data: {} };
    expect(codec.decodeClient(codec.encodeClient(msg)).type).toBe(ClientMessage.QuickPlay);
    const s: AnyServerMessage = { type: ServerMessage.Ping, data: { time: 5 } };
    expect(codec.decodeServer(codec.encodeServer(s)).type).toBe(ServerMessage.Ping);
  });
});
