/**
 * DECKSHOT — netcode tests.
 *
 * Owner: netcode-core.
 *
 * These are the tests that decide whether the game is playable on a real
 * connection: sequence wrapping, prediction convergence, delta compression,
 * the bandwidth budget, lag compensation, and the guarantee that a hostile
 * packet costs one socket and nothing else.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import {
  ServerMessage,
  type AnyServerMessage,
  type SnapshotMsg,
} from '../shared/protocol.js';
import { decodeClient, encodeServer, type SnapshotPlayerExt } from '../shared/codec.js';
import { SNAPSHOT_ALL_FIELDS } from '../shared/codec.js';
import { SnapshotField } from '../shared/protocol.js';
import {
  DEFAULT_LOADOUT,
  GameMode,
  InputButton,
  Stance,
  TeamId,
  emptyInput,
  seqDiff,
  vec3,
  type ClientInput,
  type PlayerId,
} from '../shared/types.js';
import {
  BANDWIDTH_TARGET_BPS,
  INPUT_REDUNDANCY,
  INTERP_DELAY_MS,
  LAGCOMP_MAX_REWIND_MS,
  MAX_PLAYERS,
  RECONCILE_EPSILON,
  SNAPSHOT_RATE,
  TICK_DT,
  TICK_MS,
  TICK_RATE,
} from '../shared/tuning.js';
import { applyMovement, createCollisionWorld, type MovementState } from '../shared/movement.js';
import { snapInputInPlace, snapPositionInPlace, snapVelocityInPlace } from '../shared/quantize.js';

import { GameRoom, createPlayerState, SNAPSHOT_EVERY } from '../server/src/net/room.js';
import { InputQueue, MAX_SEQ_JUMP } from '../server/src/net/inputqueue.js';
import { LagCompHistory } from '../server/src/net/lagcomp.js';
import { FixedLoop } from '../server/src/net/loop.js';
import { WsConnection, type SocketLike } from '../server/src/net/connection.js';
import { createGameServer } from '../server/src/net/server.js';
import type { Connection } from '../server/src/rooms/types.js';

import { Predictor, blankState } from '../client/src/net/prediction.js';
import { SnapshotBuffer, type RemotePlayerState } from '../client/src/net/interpolation.js';
import { NetClient } from '../client/src/net/client.js';
import { defaultSocketUrl, type WebSocketLike } from '../client/src/net/socket.js';
import { DelayLine, NetSim, parseNetSim } from '../client/src/net/netsim.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const world = createCollisionWorld();

/** Records everything the server sends, and how many bytes it costs. */
class CaptureConnection implements Connection {
  readonly remoteAddress = 'test';
  bytes = 0;
  messages: AnyServerMessage[] = [];
  snapshots: SnapshotMsg[] = [];
  closed = false;

  constructor(readonly id: number) {}

  send(msg: AnyServerMessage): void {
    this.bytes += encodeServer(msg).byteLength;
    this.messages.push(msg);
    if (msg.type === ServerMessage.Snapshot) {
      // The assembler reuses its scratch message, so snapshots must be copied
      // out before the next client is served.
      this.snapshots.push(cloneSnapshot(msg.data as SnapshotMsg));
    }
  }

  close(): void {
    this.closed = true;
  }

  bytesOfType(type: ServerMessage): number {
    let total = 0;
    for (const m of this.messages) if (m.type === type) total += encodeServer(m).byteLength;
    return total;
  }
}

function cloneSnapshot(msg: SnapshotMsg): SnapshotMsg {
  return {
    tick: msg.tick,
    ackedSeq: msg.ackedSeq,
    baselineTick: msg.baselineTick,
    removed: msg.removed.slice(),
    players: (msg.players as SnapshotPlayerExt[]).map((p) => ({
      ...p,
      position: { ...p.position },
      velocity: { ...p.velocity },
    })),
  };
}

function input(seq: number, over: Partial<ClientInput> = {}): ClientInput {
  const i = emptyInput();
  i.seq = seq & 0xffff;
  Object.assign(i, over);
  i.seq = seq & 0xffff;
  return snapInputInPlace(i);
}

/** A minimal authoritative mirror: applyMovement, nothing else. */
class MockServer {
  state: MovementState;

  constructor(id = 1, start = vec3(0, 5, 0)) {
    this.state = createPlayerState(id, 'server', TeamId.FFA, DEFAULT_LOADOUT);
    this.state.position = { ...start };
  }

  step(inp: ClientInput): void {
    this.state = applyMovement(this.state, inp, TICK_DT, world).state;
  }

  /** Exactly what the room does before a snapshot goes out. */
  commitQuantization(): void {
    snapPositionInPlace(this.state.position);
    snapVelocityInPlace(this.state.velocity);
  }

  asSnapshotPlayer(): SnapshotPlayerExt {
    const s = this.state;
    return {
      id: s.id,
      mask: SNAPSHOT_ALL_FIELDS,
      position: { ...s.position },
      velocity: { ...s.velocity },
      yaw: s.yaw,
      pitch: s.pitch,
      stance: s.stance,
      onGround: s.onGround,
      alive: s.alive,
      health: s.health,
      activeWeapon: s.activeWeapon,
      adsState: s.adsState,
      adsProgress: s.adsProgress,
      firedThisTick: false,
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sequence arithmetic
// ---------------------------------------------------------------------------

describe('sequence wrapping', () => {
  it('seqDiff orders across the 16-bit boundary', () => {
    expect(seqDiff(5, 65530)).toBe(11);
    expect(seqDiff(65530, 5)).toBe(-11);
    expect(seqDiff(0, 65535)).toBe(1);
    expect(seqDiff(1, 1)).toBe(0);
  });

  it('the input queue deduplicates and orders through the wrap', () => {
    const q = new InputQueue();
    // The redundancy window means each seq arrives up to three times.
    for (let n = 0; n < 12; n++) {
      const seq = (65530 + n) & 0xffff;
      for (let r = 0; r < INPUT_REDUNDANCY; r++) q.push(input(seq));
    }
    expect(q.stats.accepted).toBe(12);
    expect(q.stats.duplicates).toBe(24);
    const seen: number[] = [];
    for (;;) {
      const next = q.shift();
      if (!next) break;
      seen.push(next.seq);
    }
    expect(seen).toEqual([65530, 65531, 65532, 65533, 65534, 65535, 0, 1, 2, 3, 4, 5]);
  });

  it('the input queue treats an impossible jump as a resync, not a teleport', () => {
    const q = new InputQueue();
    q.push(input(100));
    q.push(input(100 + MAX_SEQ_JUMP + 50));
    expect(q.stats.resyncs).toBe(1);
    expect(q.size).toBe(1);
    expect(q.shift()!.seq).toBe(100 + MAX_SEQ_JUMP + 50);
  });

  it('the input queue is bounded no matter how hard a client floods', () => {
    const q = new InputQueue();
    for (let i = 0; i < 10_000; i++) q.push(input(i));
    expect(q.size).toBeLessThanOrEqual(q.capacity);
    expect(q.stats.dropped).toBeGreaterThan(0);
  });

  it('rejects non-finite and malformed inputs outright', () => {
    const q = new InputQueue();
    expect(q.push({ seq: 1, tick: 0, moveX: Number.NaN, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 })).toBe(false);
    expect(q.push({ seq: -3, tick: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 })).toBe(false);
    expect(q.push({ seq: 2, tick: 0, moveX: 0, moveZ: 0, yaw: Number.POSITIVE_INFINITY, pitch: 0, buttons: 0 })).toBe(false);
    expect(q.stats.rejected).toBe(3);
    expect(q.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prediction and reconciliation
// ---------------------------------------------------------------------------

describe('prediction and reconciliation', () => {
  it('predicts identically to the server when nothing is lost', () => {
    const predictor = new Predictor(1);
    predictor.state.position = vec3(0, 5, 0);
    const server = new MockServer(1, vec3(0, 5, 0));

    for (let n = 0; n < 60; n++) {
      const inp = input(n, { moveZ: 1, yaw: 0.3 });
      predictor.predict(inp);
      server.step({ ...inp });
    }

    expect(predictor.state.position.x).toBeCloseTo(server.state.position.x, 9);
    expect(predictor.state.position.z).toBeCloseTo(server.state.position.z, 9);
  });

  it('converges after an injected divergence and does not oscillate', () => {
    const predictor = new Predictor(1);
    predictor.state.position = vec3(0, 5, 0);
    const server = new MockServer(1, vec3(0, 5, 0));

    // The server is 8 ticks behind the client — roughly 130 ms of round trip.
    const LAG = 8;
    const pending: ClientInput[] = [];
    const errors: number[] = [];

    for (let n = 0; n < 240; n++) {
      const inp = input(n, { moveZ: 1, moveX: n > 60 ? 1 : 0, yaw: 0.2 });
      predictor.predict(inp);
      pending.push({ ...inp });

      if (pending.length > LAG) {
        const due = pending.shift()!;
        server.step(due);

        // Inject a one-off divergence the client cannot possibly predict.
        if (n === 100) server.state.position.x += 0.35;

        if (n % SNAPSHOT_EVERY === 0) {
          server.commitQuantization();
          const result = predictor.reconcile(server.asSnapshotPlayer(), due.seq);
          errors.push(result.error);
          expect(result.replayed).toBeLessThanOrEqual(LAG);
        }
      }
    }

    // One real correction, at the injected divergence, and nothing after it.
    const big = errors.filter((e) => e > RECONCILE_EPSILON);
    expect(big.length).toBe(1);
    expect(big[0]).toBeGreaterThan(0.3);

    // Steady state: the residual is bounded by quantization, not growing.
    const tail = errors.slice(-20);
    for (const e of tail) expect(e).toBeLessThan(RECONCILE_EPSILON);
    expect(predictor.hardCorrections).toBe(1);
  });

  it('reconciles when the client seq is at 65530 and the ack is at 5', () => {
    const predictor = new Predictor(1);
    predictor.state.position = vec3(0, 5, 0);
    const server = new MockServer(1, vec3(0, 5, 0));

    const inputs: ClientInput[] = [];
    for (let n = 0; n < 16; n++) {
      const inp = input((65530 + n) & 0xffff, { moveZ: 1 });
      inputs.push({ ...inp });
      predictor.predict(inp);
    }
    // The server has processed up to seq 5, which is 65530 + 11 after the wrap.
    for (let i = 0; i < 12; i++) server.step({ ...inputs[i] });
    server.commitQuantization();

    const result = predictor.reconcile(server.asSnapshotPlayer(), 5);
    expect(result.applied).toBe(true);
    // Four inputs are still unacknowledged and must be replayed, not dropped.
    expect(result.replayed).toBe(4);
    expect(result.error).toBeLessThan(RECONCILE_EPSILON);

    // And the prediction still leads the server by exactly those four ticks.
    for (let i = 12; i < 16; i++) server.step({ ...inputs[i] });
    expect(predictor.state.position.z).toBeCloseTo(server.state.position.z, 6);
  });

  it('smooths the visual correction instead of teleporting the camera', () => {
    const predictor = new Predictor(1);
    predictor.state.position = vec3(0, 5, 0);
    const server = new MockServer(1, vec3(0, 5, 0));

    for (let n = 0; n < 10; n++) {
      const inp = input(n, { moveZ: 1 });
      predictor.predict(inp);
      server.step({ ...inp });
    }
    server.state.position.x += 0.5;
    server.commitQuantization();

    const beforeRender = predictor.renderPosition();
    const beforeX = beforeRender.x;
    predictor.reconcile(server.asSnapshotPlayer(), 9);

    // The simulation snapped; the render position has barely moved.
    expect(Math.abs(predictor.state.position.x - beforeX)).toBeGreaterThan(0.4);
    expect(Math.abs(predictor.renderPosition().x - beforeX)).toBeLessThan(0.01);

    // ...and it walks the rest of the way over RECONCILE_SMOOTH_MS.
    for (let f = 0; f < 12; f++) predictor.updateSmoothing(1 / 60);
    const offset = predictor.smoothingOffset();
    expect(Math.abs(offset.x)).toBeLessThan(0.05);
  });

  it('recovers when the acknowledged input has fallen out of the ring', () => {
    const predictor = new Predictor(1);
    const server = new MockServer(1, vec3(3, 5, -2));
    for (let n = 0; n < 400; n++) predictor.predict(input(n, { moveZ: 1 }));
    server.commitQuantization();
    const result = predictor.reconcile(server.asSnapshotPlayer(), 10);
    expect(result.hard).toBe(true);
    expect(predictor.state.position.x).toBeCloseTo(server.state.position.x, 6);
  });
});

// ---------------------------------------------------------------------------
// Lag compensation
// ---------------------------------------------------------------------------

describe('lag compensation', () => {
  it('rewinds a moving player to where the shooter saw them', () => {
    const history = new LagCompHistory(4);
    const state = createPlayerState(2, 'target', TeamId.FFA, DEFAULT_LOADOUT);

    // 30 ticks of a player running down +X at 10 m/s.
    for (let t = 0; t < 30; t++) {
      state.position.x = t * (10 / TICK_RATE);
      state.yaw = t * 0.05;
      history.beginTick(t, t * TICK_MS);
      history.record(0, state);
    }

    const now = 29 * TICK_MS;
    const out = createPlayerState(2, 'copy', TeamId.FFA, DEFAULT_LOADOUT);

    // A 100 ms ping means the shooter saw the world 50 + 100 = 150 ms ago.
    const rewind = LagCompHistory.rewindForRtt(100);
    expect(rewind).toBeCloseTo(50 + INTERP_DELAY_MS, 6);

    expect(history.sample(0, now - rewind, out)).toBe(true);
    const expectedX = ((now - rewind) / TICK_MS) * (10 / TICK_RATE);
    expect(out.position.x).toBeCloseTo(expectedX, 3);
  });

  it('clamps the rewind at LAGCOMP_MAX_REWIND_MS', () => {
    expect(LagCompHistory.rewindForRtt(10_000)).toBe(LAGCOMP_MAX_REWIND_MS);
    expect(LagCompHistory.rewindForRtt(0)).toBe(INTERP_DELAY_MS);
    expect(LagCompHistory.rewindForRtt(Number.NaN)).toBe(INTERP_DELAY_MS);
  });

  it('interpolates angles the short way round', () => {
    const history = new LagCompHistory(2);
    const state = createPlayerState(1, 'spin', TeamId.FFA, DEFAULT_LOADOUT);

    state.yaw = Math.PI - 0.05;
    history.beginTick(0, 0);
    history.record(0, state);
    state.yaw = -Math.PI + 0.05;
    history.beginTick(1, TICK_MS);
    history.record(0, state);

    const out = createPlayerState(1, 'copy', TeamId.FFA, DEFAULT_LOADOUT);
    history.sample(0, TICK_MS / 2, out);
    // Halfway across the seam is +/-PI, not 0. Taking the long way round here
    // would swing the hitbox through a full half-turn between two ticks.
    expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(0.02);
  });

  it('never returns garbage for a player with no history', () => {
    const history = new LagCompHistory(4);
    const out = createPlayerState(9, 'ghost', TeamId.FFA, DEFAULT_LOADOUT);
    out.position.x = 42;
    expect(history.sample(0, 1000, out)).toBe(false);
    expect(out.position.x).toBe(42);
  });

  it('clamps to the oldest sample rather than extrapolating into the past', () => {
    const history = new LagCompHistory(2);
    const state = createPlayerState(1, 'p', TeamId.FFA, DEFAULT_LOADOUT);
    for (let t = 0; t < 5; t++) {
      state.position.z = t;
      history.beginTick(t, 1000 + t * TICK_MS);
      history.record(0, state);
    }
    const out = createPlayerState(1, 'copy', TeamId.FFA, DEFAULT_LOADOUT);
    expect(history.sample(0, 0, out)).toBe(true);
    expect(out.position.z).toBe(0);
  });
});

describe('lag compensation through the room', () => {
  it('hands combat the positions the shooter actually saw, not the present', () => {
    // The netcode layer owns the rewind; combat owns the ray. This asserts the
    // seam: what combat is given is where the target WAS at
    // now - (rtt/2 + INTERP_DELAY_MS), not where they are now.
    const seen: Array<{ rewindMs: number; targetX: number; liveX: number }> = [];

    const room = new GameRoom({
      code: 'LAGC',
      hooks: {
        resolveFire: (ctx) => {
          const target = ctx.targets[0];
          seen.push({
            rewindMs: ctx.rewindMs,
            targetX: target ? target.position.x : Number.NaN,
            liveX: Number.NaN,
          });
          return null;
        },
      },
    });

    const shooter = room.addPlayer({ id: 1, name: 'shooter', team: TeamId.FFA, conn: null })!;
    const runner = room.addPlayer({ id: 2, name: 'runner', team: TeamId.FFA, conn: null })!;

    // A 200 ms ping: the shooter's screen is 100 + 100 = 200 ms in the past.
    shooter.rttMs = 200;

    for (let t = 1; t <= 60; t++) {
      // Teleport the runner along +X by a known amount each tick, so the
      // expected rewound position is arithmetic rather than physics.
      runner.state.position.x = t * 0.1;
      const fire = t === 60 ? InputButton.Fire : 0;
      room.onInput(1, [input(t, { buttons: fire })]);
      room.onInput(2, [input(t, {})]);
      room.tick(t, t * TICK_MS);
    }

    expect(seen).toHaveLength(1);
    const shot = seen[0];
    expect(shot.rewindMs).toBeCloseTo(200, 6);

    // 200 ms is 12 ticks at 60 Hz, so the runner should be handed back to
    // x = (60 - 12) * 0.1 = 4.8, not the live 6.0.
    expect(runner.state.position.x).toBeCloseTo(6.0, 6);
    expect(shot.targetX).toBeCloseTo(4.8, 2);
  });

  it('never rewinds a shooter past the hard cap', () => {
    const rewinds: number[] = [];
    const room = new GameRoom({
      code: 'LAGX',
      hooks: {
        resolveFire: (ctx) => {
          rewinds.push(ctx.rewindMs);
          return null;
        },
      },
    });
    const shooter = room.addPlayer({ id: 1, name: 's', team: TeamId.FFA, conn: null })!;
    room.addPlayer({ id: 2, name: 't', team: TeamId.FFA, conn: null });
    // A client claiming a three-second ping does not get to shoot at history.
    shooter.rttMs = 3000;
    for (let t = 1; t <= 40; t++) {
      room.onInput(1, [input(t, { buttons: t === 40 ? InputButton.Fire : 0 })]);
      room.tick(t, t * TICK_MS);
    }
    expect(rewinds).toEqual([LAGCOMP_MAX_REWIND_MS]);
  });
});

describe('weapons and combat integration', () => {
  it('the default hooks turn a held trigger into exactly one shot per cycle', () => {
    const room = new GameRoom({ code: 'FIRE' });
    const player = room.addPlayer({ id: 1, name: 'sniper', team: TeamId.FFA, conn: null })!;
    const startMag = player.state.ammoInMag;
    expect(startMag).toBeGreaterThan(0);

    // Two seconds of holding fire and ADS. The Talon cycles at 0.9 s, so a
    // held trigger on a bolt-action must not become an automatic weapon.
    let shots = 0;
    let prevMag = startMag;
    for (let t = 1; t <= 120; t++) {
      room.onInput(1, [input(t, { buttons: InputButton.Fire | InputButton.Ads })]);
      room.tick(t, t * TICK_MS);
      if (player.state.ammoInMag < prevMag) shots++;
      prevMag = player.state.ammoInMag;
    }
    expect(shots).toBeGreaterThanOrEqual(1);
    expect(shots).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// The fixed loop
// ---------------------------------------------------------------------------

describe('fixed loop', () => {
  it('runs exactly one tick per step interval and corrects drift', () => {
    let now = 0;
    const ticks: number[] = [];
    const loop = new FixedLoop((tick) => ticks.push(tick), { hz: TICK_RATE, now: () => now });
    loop.start();

    // Advance one second in ragged 7 ms chunks.
    for (let i = 0; i < 1000 / 7; i++) {
      now += 7;
      loop.advanceTo(now);
    }
    // 60 Hz for ~1 s, give or take the partial final interval.
    expect(ticks.length).toBeGreaterThanOrEqual(58);
    expect(ticks.length).toBeLessThanOrEqual(60);
    loop.stop();
  });

  it('clamps the catch-up burst instead of spiralling after a stall', () => {
    let now = 0;
    let ran = 0;
    let stalled = 0;
    const loop = new FixedLoop(() => ran++, {
      hz: TICK_RATE,
      now: () => now,
      maxCatchUpTicks: 8,
      onStall: () => stalled++,
    });
    loop.start();
    now += 5000; // five seconds of nothing: a GC pause or a suspended laptop
    loop.advanceTo(now);
    expect(ran).toBe(8);
    expect(stalled).toBe(1);
    // And it is immediately healthy again rather than owing 292 ticks.
    now += TICK_MS;
    loop.advanceTo(now);
    expect(ran).toBe(9);
    loop.stop();
  });
});

// ---------------------------------------------------------------------------
// Interpolation buffer
// ---------------------------------------------------------------------------

function fullPlayer(id: PlayerId, x: number, over: Partial<SnapshotPlayerExt> = {}): SnapshotPlayerExt {
  return {
    id,
    mask: SNAPSHOT_ALL_FIELDS,
    position: { x, y: 1, z: 0 },
    velocity: { x: 10, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    alive: true,
    health: 100,
    activeWeapon: 0,
    adsState: 0,
    adsProgress: 0,
    firedThisTick: false,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    team: TeamId.FFA,
    name: `p${id}`,
    loadout: DEFAULT_LOADOUT,
    ping: 30,
    ...over,
  };
}

function snap(tick: number, baselineTick: number, players: SnapshotPlayerExt[]): SnapshotMsg {
  return { tick, ackedSeq: tick, baselineTick, players, removed: [] };
}

describe('interpolation buffer', () => {
  it('renders remote players INTERP_DELAY_MS in the past, between snapshots', () => {
    const buf = new SnapshotBuffer();
    // Snapshots every 3 ticks; the player moves 0.5 m between each.
    for (let i = 0; i < 6; i++) {
      buf.apply(snap(i * SNAPSHOT_EVERY, 0, [fullPlayer(2, i * 0.5)]), i * (1000 / SNAPSHOT_RATE));
    }
    const out = new Map<PlayerId, RemotePlayerState>();
    // Exactly halfway between the third and fourth snapshots.
    const t = 3 * SNAPSHOT_EVERY * TICK_MS + (SNAPSHOT_EVERY * TICK_MS) / 2;
    buf.sample(t, out);
    expect(out.get(2)!.position.x).toBeCloseTo(1.75, 5);
  });

  it('ignores duplicate snapshots', () => {
    const buf = new SnapshotBuffer();
    expect(buf.apply(snap(9, 0, [fullPlayer(2, 1)]), 0)).not.toBeNull();
    expect(buf.apply(snap(9, 0, [fullPlayer(2, 1)]), 5)).toBeNull();
    expect(buf.duplicates).toBe(1);
    expect(buf.size).toBe(1);
  });

  it('accepts out-of-order snapshots and keeps the timeline sorted', () => {
    const buf = new SnapshotBuffer();
    buf.apply(snap(0, 0, [fullPlayer(2, 0)]), 0);
    buf.apply(snap(6, 0, [fullPlayer(2, 2)]), 100);
    const late = buf.apply(snap(3, 0, [fullPlayer(2, 1)]), 110);
    expect(late).not.toBeNull();
    expect(late!.outOfOrder).toBe(true);
    expect(buf.latestTick).toBe(6);

    // The late snapshot is used for interpolation in its correct position.
    const out = new Map<PlayerId, RemotePlayerState>();
    buf.sample(3 * TICK_MS, out);
    expect(out.get(2)!.position.x).toBeCloseTo(1, 5);
  });

  it('drops a delta whose baseline it never received', () => {
    const buf = new SnapshotBuffer();
    buf.apply(snap(0, 0, [fullPlayer(2, 0)]), 0);
    // Claims a baseline of tick 3, which never arrived.
    expect(buf.apply(snap(6, 3, [fullPlayer(2, 2)]), 100)).toBeNull();
    expect(buf.missingBaselines).toBe(1);
  });

  it('merges a partial delta onto the named baseline', () => {
    const buf = new SnapshotBuffer();
    buf.apply(snap(3, 0, [fullPlayer(2, 5, { name: 'sniper' })]), 0);
    const delta: SnapshotPlayerExt = {
      ...fullPlayer(2, 9),
      mask: SnapshotField.Position,
    };
    const applied = buf.apply(snap(6, 3, [delta]), 50);
    expect(applied).not.toBeNull();
    const merged = applied!.snapshot.players.get(2)!;
    expect(merged.position.x).toBe(9);
    // Everything the delta did not carry came from the baseline.
    expect(merged.name).toBe('sniper');
    expect(merged.health).toBe(100);
  });

  it('extrapolates at most MAX_EXTRAPOLATION_MS, then freezes', () => {
    const buf = new SnapshotBuffer();
    buf.apply(snap(0, 0, [fullPlayer(2, 0)]), 0);
    const out = new Map<PlayerId, RemotePlayerState>();

    buf.sample(100, out); // 100 ms past the newest snapshot, v = 10 m/s
    expect(out.get(2)!.position.x).toBeCloseTo(1.0, 5);

    buf.sample(250, out);
    expect(out.get(2)!.position.x).toBeCloseTo(2.5, 5);

    // Beyond the cap the position is frozen, not extrapolated to infinity.
    buf.sample(5000, out);
    expect(out.get(2)!.position.x).toBeCloseTo(2.5, 5);
  });

  it('drops players who leave', () => {
    const buf = new SnapshotBuffer();
    buf.apply(snap(3, 0, [fullPlayer(2, 0), fullPlayer(3, 1)]), 0);
    // A delta against tick 3 in which player 3 no longer appears.
    const applied = buf.apply(snap(6, 3, [fullPlayer(2, 0)]), 50);
    expect(applied!.removed).toEqual([3]);
    const out = new Map<PlayerId, RemotePlayerState>();
    buf.sample(6 * TICK_MS, out);
    expect(out.has(3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delta compression and bandwidth
// ---------------------------------------------------------------------------

/** Drives a room of `count` players, all moving, for `seconds`. */
function runBandwidthRoom(count: number, seconds: number): {
  room: GameRoom;
  conns: CaptureConnection[];
  ticks: number;
} {
  const room = new GameRoom({ code: 'BW01', autoRespawn: true });
  const conns: CaptureConnection[] = [];
  for (let i = 0; i < count; i++) {
    const conn = new CaptureConnection(i + 1);
    conns.push(conn);
    room.addPlayer({ id: i + 1, name: `player-${i}`, team: TeamId.FFA, conn });
  }

  const ticks = Math.round(seconds * TICK_RATE);
  const seqs = new Array(count).fill(0);
  const ackTicks = new Array(count).fill(0);

  for (let t = 1; t <= ticks; t++) {
    for (let i = 0; i < count; i++) {
      // Continuous movement: strafing, turning, and jumping. Every replicated
      // field changes every tick, which is the worst case for delta encoding.
      const seq = seqs[i]++;
      const inp = input(seq, {
        moveZ: 1,
        moveX: Math.sin((t + i * 7) * 0.05) > 0 ? 1 : -1,
        yaw: Math.sin((t + i * 11) * 0.02) * Math.PI,
        pitch: Math.sin(t * 0.03) * 0.5,
        buttons: t % 30 === 0 ? InputButton.Jump : 0,
      });
      inp.tick = ackTicks[i];
      const batch: ClientInput[] = [inp];
      room.onInput(i + 1, batch);
    }
    room.tick(t, t * TICK_MS);

    // Each client acks the newest snapshot it has received.
    for (let i = 0; i < count; i++) {
      const last = conns[i].snapshots[conns[i].snapshots.length - 1];
      if (last) ackTicks[i] = last.tick;
    }
  }

  return { room, conns, ticks };
}

describe('delta compression and bandwidth', () => {
  it('an idle player costs a fraction of a moving one', () => {
    const idle = new GameRoom({ code: 'IDLE' });
    const idleConn = new CaptureConnection(1);
    idle.addPlayer({ id: 1, name: 'still', team: TeamId.FFA, conn: idleConn });
    idle.addPlayer({ id: 2, name: 'also-still', team: TeamId.FFA, conn: null });

    let ack = 0;
    for (let t = 1; t <= 120; t++) {
      const inp = input(t, {});
      inp.tick = ack;
      idle.onInput(1, [inp]);
      idle.onInput(2, [inp]);
      idle.tick(t, t * TICK_MS);
      const last = idleConn.snapshots[idleConn.snapshots.length - 1];
      if (last) ack = last.tick;
    }

    const moving = runBandwidthRoom(2, 2);

    const idleSnapshotBytes = idleConn.bytesOfType(ServerMessage.Snapshot);
    const movingSnapshotBytes = moving.conns[0].bytesOfType(ServerMessage.Snapshot);
    expect(idleSnapshotBytes).toBeGreaterThan(0);
    expect(idleSnapshotBytes * 2).toBeLessThan(movingSnapshotBytes);
  });

  it('12 players moving continuously stay under BANDWIDTH_TARGET_BPS per client', () => {
    const seconds = 5;
    const { conns } = runBandwidthRoom(MAX_PLAYERS, seconds);

    let worst = 0;
    let total = 0;
    for (const conn of conns) {
      const bps = conn.bytes / seconds;
      total += bps;
      if (bps > worst) worst = bps;
    }
    const mean = total / conns.length;

    // Reported so the number is visible in CI, not just asserted.
    console.log(
      `[bandwidth] ${MAX_PLAYERS} players, ${SNAPSHOT_RATE} Hz snapshots: ` +
        `mean ${(mean / 1024).toFixed(2)} KB/s, worst ${(worst / 1024).toFixed(2)} KB/s ` +
        `(budget ${(BANDWIDTH_TARGET_BPS / 1024).toFixed(0)} KB/s)`
    );

    expect(worst).toBeLessThan(BANDWIDTH_TARGET_BPS);
  });

  it('a 4-player ZOMBIES room with a full 24-zombie horde stays under budget', () => {
    // The zombie field-mask reduction is a REQUIREMENT: 24 extra entities at
    // full replication would blow the 12 KB/s budget on their own.
    const seconds = 5;
    const count = 4;
    const room = new GameRoom({ code: 'BWZ1', mode: GameMode.Zombies, autoRespawn: true });
    const conns: CaptureConnection[] = [];
    for (let i = 0; i < count; i++) {
      const conn = new CaptureConnection(100 + i);
      conns.push(conn);
      room.addPlayer({ id: i + 1, name: `squad-${i}`, team: TeamId.Alpha, conn });
    }
    // Force the horde to its cap immediately; the director keeps it topped up
    // and every zombie moves toward the squad every tick — the worst case.
    const director = room.zombies!;
    for (let i = 0; i < 24; i++) director.horde.spawn(i, 1, 100_000, 3, []);
    expect(director.horde.aliveCount).toBeGreaterThanOrEqual(24);

    const ticks = Math.round(seconds * TICK_RATE);
    const seqs = new Array(count).fill(0);
    const ackTicks = new Array(count).fill(0);
    for (let t = 1; t <= ticks; t++) {
      for (let i = 0; i < count; i++) {
        const seq = seqs[i]++;
        const inp = input(seq, {
          moveZ: 1,
          moveX: Math.sin((t + i * 7) * 0.05) > 0 ? 1 : -1,
          yaw: Math.sin((t + i * 11) * 0.02) * Math.PI,
          buttons: t % 30 === 0 ? InputButton.Jump : 0,
        });
        inp.tick = ackTicks[i];
        room.onInput(i + 1, [inp]);
      }
      room.tick(t, t * TICK_MS);
      for (let i = 0; i < count; i++) {
        const last = conns[i].snapshots[conns[i].snapshots.length - 1];
        if (last) ackTicks[i] = last.tick;
      }
    }

    let worst = 0;
    for (const conn of conns) worst = Math.max(worst, conn.bytes / seconds);
    console.log(
      `[bandwidth] ZOMBIES 4 players + ${director.horde.aliveCount} zombies: ` +
        `worst ${(worst / 1024).toFixed(2)} KB/s (budget ${(BANDWIDTH_TARGET_BPS / 1024).toFixed(0)} KB/s)`
    );
    expect(worst).toBeLessThan(BANDWIDTH_TARGET_BPS);
  });

  it('the client can reconstruct every delta the server sends', () => {
    const { conns } = runBandwidthRoom(4, 2);
    const buf = new SnapshotBuffer();
    let applied = 0;
    for (const msg of conns[0].snapshots) {
      if (buf.apply(msg, msg.tick * TICK_MS)) applied++;
    }
    expect(applied).toBe(conns[0].snapshots.length);
    expect(buf.missingBaselines).toBe(0);
    const latest = buf.latest()!;
    expect(latest.players.size).toBe(4);
    for (const p of latest.players.values()) {
      expect(p.name).not.toBe('');
      expect(Number.isFinite(p.position.x)).toBe(true);
    }
  });

  it('falls back to full state when a client stops acknowledging', () => {
    const room = new GameRoom({ code: 'NOACK' });
    const conn = new CaptureConnection(1);
    room.addPlayer({ id: 1, name: 'quiet', team: TeamId.FFA, conn });
    for (let t = 1; t <= 180; t++) room.tick(t, t * TICK_MS);
    // With no acks at all, every snapshot must be self-contained.
    expect(conn.snapshots.length).toBeGreaterThan(50);
    for (const s of conn.snapshots) expect(s.baselineTick).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Quantization commit
// ---------------------------------------------------------------------------

describe('the server stores what it sent', () => {
  it('authoritative positions land on the wire grid after a snapshot', () => {
    const room = new GameRoom({ code: 'QUANT' });
    const conn = new CaptureConnection(1);
    const player = room.addPlayer({ id: 1, name: 'p', team: TeamId.FFA, conn })!;

    for (let t = 1; t <= SNAPSHOT_EVERY * 4; t++) {
      room.onInput(1, [input(t, { moveZ: 1, yaw: 0.4 })]);
      room.tick(t, t * TICK_MS);
    }

    const pos = player.state.position;
    for (const axis of [pos.x, pos.y, pos.z]) {
      // Every component is exactly representable, so re-encoding is lossless
      // and the client's reconciliation has nothing left to argue about.
      expect(snapAxisValue(axis)).toBe(axis);
    }
  });
});

function snapAxisValue(v: number): number {
  const tmp = { x: v, y: 0, z: 0 };
  snapPositionInPlace(tmp);
  return tmp.x;
}

// ---------------------------------------------------------------------------
// Hostile traffic
// ---------------------------------------------------------------------------

/** A socket that records what the server did to it. */
class FakeSocket implements SocketLike {
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  closed = false;
  closeReason = '';
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  send(data: Uint8Array | ArrayBuffer): void {
    this.sent.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data));
  }

  close(_code?: number, reason?: string): void {
    this.closed = true;
    this.closeReason = reason ?? '';
  }

  on(event: string, listener: (...args: never[]) => void): this {
    (this.handlers[event] ??= []).push(listener as (...args: unknown[]) => void);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers[event] ?? []) fn(...args);
  }
}

describe('hostile traffic', () => {
  it('a malformed frame closes the socket and nothing else', () => {
    const socket = new FakeSocket();
    let delivered = 0;
    const conn = new WsConnection(socket as SocketLike, {
      onMessage: () => delivered++,
      onClose: () => undefined,
    });
    socket.emit('message', new Uint8Array([200, 1, 2, 3]), true);
    expect(socket.closed).toBe(true);
    expect(delivered).toBe(0);
    expect(conn.isClosed).toBe(true);
  });

  it('a truncated frame closes the socket without throwing', () => {
    const socket = new FakeSocket();
    const conn = new WsConnection(socket as SocketLike, {
      onMessage: () => undefined,
      onClose: () => undefined,
    });
    expect(() => socket.emit('message', new Uint8Array([1, 5, 65, 66]), true)).not.toThrow();
    expect(conn.isClosed).toBe(true);
  });

  it('a text frame is refused without a parse attempt', () => {
    const socket = new FakeSocket();
    new WsConnection(socket as SocketLike, { onMessage: () => undefined, onClose: () => undefined });
    socket.emit('message', 'hello', false);
    expect(socket.closed).toBe(true);
    expect(socket.closeReason).toContain('text');
  });

  it('a flood is rate limited rather than absorbed', () => {
    const socket = new FakeSocket();
    let now = 0;
    let closes = 0;
    const conn = new WsConnection(socket as SocketLike, {
      onMessage: () => undefined,
      onClose: () => closes++,
    }, { now: () => now, limits: { messagesPerSecond: 30 } });

    const valid = new Uint8Array(encodeClientQuickPlay());
    for (let i = 0; i < 500 && !conn.isClosed; i++) socket.emit('message', valid, true);
    expect(conn.isClosed).toBe(true);
    expect(closes).toBe(1);
  });
});

function encodeClientQuickPlay(): ArrayBuffer {
  // ClientMessage.QuickPlay = 4, no payload.
  return new Uint8Array([4]).buffer;
}

// ---------------------------------------------------------------------------
// Network simulation
// ---------------------------------------------------------------------------

describe('netsim', () => {
  it('parses the ?netsim= flag', () => {
    expect(parseNetSim('?netsim=150,2')).toMatchObject({ rttMs: 150, lossPct: 2 });
    expect(parseNetSim('netsim=80')).toMatchObject({ rttMs: 80, lossPct: 0 });
    expect(parseNetSim('?a=1&netsim=200,5,20')).toMatchObject({ rttMs: 200, lossPct: 5, jitterMs: 20 });
    expect(parseNetSim('?other=1')).toBeNull();
    expect(parseNetSim('')).toBeNull();
    expect(parseNetSim('?netsim=abc')).toBeNull();
  });

  it('delays delivery by half the round trip in each direction', () => {
    const sim = new NetSim({ rttMs: 150, lossPct: 0, jitterMs: 0, seed: 1 });
    let got = 0;
    sim.up.push(0, () => got++);
    sim.pump(74);
    expect(got).toBe(0);
    sim.pump(75);
    expect(got).toBe(1);
  });

  it('drops approximately the requested fraction, symmetrically', () => {
    const line = new DelayLine({ rttMs: 0, lossPct: 20, jitterMs: 0, seed: 12345 });
    let sent = 0;
    for (let i = 0; i < 20_000; i++) if (line.push(0, () => undefined)) sent++;
    const lossRate = line.dropped / 20_000;
    expect(lossRate).toBeGreaterThan(0.17);
    expect(lossRate).toBeLessThan(0.23);
    expect(sent + line.dropped).toBe(20_000);
  });

  it('preserves ordering even with jitter', () => {
    const line = new DelayLine({ rttMs: 100, lossPct: 0, jitterMs: 60, seed: 7 });
    const order: number[] = [];
    for (let i = 0; i < 200; i++) line.push(i * 5, () => order.push(i));
    line.pump(100_000);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });
});

// ---------------------------------------------------------------------------
// Socket URL derivation
// ---------------------------------------------------------------------------

describe('socket url', () => {
  it('derives ws/wss from the page, never localhost', () => {
    expect(defaultSocketUrl({ protocol: 'https:', host: 'deckshot.fly.dev' })).toBe(
      'wss://deckshot.fly.dev/ws'
    );
    expect(defaultSocketUrl({ protocol: 'http:', host: '192.168.1.9:5173' })).toBe(
      'ws://192.168.1.9:5173/ws'
    );
  });
});

// ---------------------------------------------------------------------------
// End to end over a loopback socket
// ---------------------------------------------------------------------------

/** Wires a client-side WebSocketLike to a server-side SocketLike. */
function makePipe(): { client: WebSocketLike; server: SocketLike } {
  const serverHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  let clientMessage: ((ev: { data: unknown }) => void) | null = null;

  const server: SocketLike = {
    bufferedAmount: 0,
    send(data: Uint8Array | ArrayBuffer): void {
      const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
      queueMicrotask(() => clientMessage?.({ data: bytes.buffer }));
    },
    close(): void {
      for (const fn of serverHandlers.close ?? []) fn();
    },
    on(event: string, listener: (...args: never[]) => void): unknown {
      (serverHandlers[event] ??= []).push(listener as (...args: unknown[]) => void);
      return this;
    },
  } as SocketLike;

  const client: WebSocketLike = {
    binaryType: 'arraybuffer',
    readyState: 1,
    send(data: ArrayBuffer | Uint8Array): void {
      const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
      queueMicrotask(() => {
        for (const fn of serverHandlers.message ?? []) fn(bytes, true);
      });
    },
    close(): void {
      client.onclose?.();
    },
    onopen: null,
    onclose: null,
    onerror: null,
    get onmessage(): ((ev: { data: unknown }) => void) | null {
      return clientMessage;
    },
    set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
      clientMessage = fn;
    },
  };

  return { client, server };
}

describe('input redundancy window', () => {
  it('only ever transmits consecutive seqs, including on the first ticks', () => {
    const sent: Uint8Array[] = [];
    const socket: WebSocketLike = {
      binaryType: 'arraybuffer',
      readyState: 1,
      send: (data) => sent.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data)),
      close: () => undefined,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    const net = new NetClient({ factory: () => socket, netsim: null, persistSession: false });
    net.connect();
    socket.onopen?.();
    sent.length = 0; // drop the Hello

    for (let n = 0; n < 6; n++) net.tick(n * TICK_MS, input((65534 + n) & 0xffff, { moveZ: 1 }));

    const packets = sent
      .map((b) => decodeClient(b))
      .filter((m) => m.type === 10)
      .map((m) => (m.data as { inputs: ClientInput[] }).inputs);

    expect(packets).toHaveLength(6);
    // The window fills up rather than shipping placeholder inputs labelled
    // with seqs the controller never produced.
    expect(packets[0].map((i) => i.seq)).toEqual([65534]);
    expect(packets[1].map((i) => i.seq)).toEqual([65534, 65535]);
    expect(packets[2].map((i) => i.seq)).toEqual([65534, 65535, 0]);
    expect(packets[3].map((i) => i.seq)).toEqual([65535, 0, 1]);
    expect(packets[5].map((i) => i.seq)).toEqual([1, 2, 3]);
    for (const p of packets) expect(p.length).toBeLessThanOrEqual(INPUT_REDUNDANCY);
  });
});

describe('end to end', () => {
  let http: Server | null = null;
  let game: ReturnType<typeof createGameServer> | null = null;

  afterEach(async () => {
    await game?.close();
    game = null;
    http?.close();
    http = null;
  });

  it('a client connects, joins, is simulated and receives snapshots', async () => {
    http = createServer();
    game = createGameServer(http, { now: () => Date.now() });

    const pipe = makePipe();
    game.handleSocket(pipe.server, '127.0.0.1');

    const net = new NetClient({
      factory: () => pipe.client,
      netsim: null,
      persistSession: false,
      name: 'tester',
    });

    const events: string[] = [];
    net.on('welcome', () => events.push('welcome'));
    net.on('lobby', () => events.push('lobby'));

    net.connect();
    pipe.client.onopen?.();
    await sleep(30);

    net.quickPlay();
    await sleep(60);

    expect(events).toContain('welcome');
    expect(events).toContain('lobby');
    expect(net.playerId).toBeGreaterThan(0);
    expect(net.lobby?.players.length).toBe(1);

    // Drive 30 client ticks of forward movement.
    let snapshots = 0;
    net.on('snapshot', () => snapshots++);
    for (let n = 0; n < 30; n++) {
      net.tick(Date.now(), input(n, { moveZ: 1 }));
      await sleep(4);
    }
    await sleep(120);

    expect(snapshots).toBeGreaterThan(0);
    expect(net.predictor.pendingInputs).toBeLessThan(64);
    // The server agrees with us to within the reconciliation epsilon.
    expect(net.predictor.lastError).toBeLessThan(1);
  });

  it('still converges over a simulated 150 ms / 2% link', async () => {
    // The acceptance condition for `?netsim=150,2`. Everything the prediction
    // layer exists for only shows up here: inputs are in flight for 75 ms in
    // each direction, snapshots are 100 ms stale on arrival, and one packet in
    // fifty simply never turns up.
    http = createServer();
    game = createGameServer(http, { now: () => Date.now() });
    const pipe = makePipe();
    game.handleSocket(pipe.server, '127.0.0.1');

    const net = new NetClient({
      factory: () => pipe.client,
      netsim: { rttMs: 150, lossPct: 2, jitterMs: 10, seed: 0xc0ffee },
      persistSession: false,
      name: 'laggy',
    });
    net.connect();
    pipe.client.onopen?.();

    // Pump the simulated link on a real timer while the handshake completes.
    const pump = setInterval(() => net.update(Date.now(), 1 / 60), 4);
    try {
      await sleep(80);
      net.quickPlay();
      await sleep(200);
      expect(net.playerId).toBeGreaterThan(0);

      for (let n = 0; n < 90; n++) {
        net.tick(Date.now(), input(n, { moveZ: 1, yaw: 0.25 }));
        await sleep(6);
      }
      await sleep(300);

      const stats = net.stats();
      // Packets really were delayed and dropped.
      expect(stats.rtt).toBeGreaterThan(100);
      expect(stats.simulatedLoss.sentDropped + stats.simulatedLoss.recvDropped).toBeGreaterThan(0);
      // And the client still agrees with the server: no runaway divergence,
      // no oscillation, no reconciliation storm.
      expect(stats.lastError).toBeLessThan(0.5);
      expect(net.snapshots.size).toBeGreaterThan(0);
      expect(net.socket.decodeErrors).toBe(0);
    } finally {
      clearInterval(pump);
    }
  });

  it('serves the whole message set without a decode error', async () => {
    http = createServer();
    game = createGameServer(http, { now: () => Date.now() });
    const pipe = makePipe();
    game.handleSocket(pipe.server, '127.0.0.1');

    const net = new NetClient({
      factory: () => pipe.client,
      netsim: null,
      persistSession: false,
      name: 'chatter',
    });
    net.connect();
    pipe.client.onopen?.();
    await sleep(20);
    net.quickPlay();
    await sleep(60);

    const chats: string[] = [];
    net.on('chat', (m) => chats.push(m.text));
    net.chat('360 no scope 🎯');
    await sleep(60);

    expect(chats).toEqual(['360 no scope 🎯']);
    expect(net.socket.decodeErrors).toBe(0);
    expect(net.round).not.toBeNull();
  });
});
