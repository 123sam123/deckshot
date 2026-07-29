/**
 * DECKSHOT — the authoritative match simulation.
 *
 * Owner: netcode-core.
 *
 * One `GameRoom` per lobby. It is driven by `FixedLoop` at exactly TICK_RATE
 * and is the only thing in the process allowed to decide what happened.
 *
 * Tick order is a contract, not an implementation detail. The client's
 * prediction runs the same sequence in the same order, and any divergence here
 * shows up as reconciliation jitter:
 *
 *   1. drain one input per player (repeat the last on starvation)
 *   2. advance the weapon state machine   <- BEFORE movement, because ADS
 *   3. advance movement                      state gates movement speed
 *   4. write this tick into the lag-comp history
 *   5. resolve fire events against rewound opponents
 *   6. damage, death, respawn, out-of-bounds, health regen
 *   7. round phase and scoring
 *   8. every third tick, snapshot every client
 *
 * Step 8 also snaps the authoritative position and velocity onto the wire's
 * quantization grid. That is not cosmetic: it is what stops the server and the
 * client disagreeing forever about the sub-centimetre remainder the wire
 * cannot carry. See the header of `shared/quantize.ts`.
 */

import {
  ServerMessage,
  type AnyServerMessage,
  type CorrectionReason,
  type KillMsg,
  type SnapshotMsg,
} from '../../../shared/protocol.js';
import {
  DEFAULT_LOADOUT,
  GameMode,
  InputButton,
  RoundPhase,
  Stance,
  TeamId,
  WeaponId,
  AdsState,
  emptyInput,
  seqDiff,
  vec3,
  type ClientInput,
  type Loadout,
  type PlayerId,
  type PlayerState,
} from '../../../shared/types.js';
import {
  COUNTDOWN_TIME,
  HEALTH_REGEN_DELAY,
  HEALTH_REGEN_RATE,
  MAX_HEALTH,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  OOB_COUNTDOWN,
  POST_MATCH_TIME,
  RESPAWN_DELAY,
  SNAPSHOT_RATE,
  SPAWN_MIN_ENEMY_DIST,
  TICK_DT,
  TICK_RATE,
} from '../../../shared/tuning.js';
import { SPAWN_POINTS, type SpawnPoint } from '../../../shared/mapdata.js';
import { createCollisionWorld, type CollisionWorld, type MovementState } from '../../../shared/movement.js';
import { stepPlayerMovement } from '../sim/movement.js';
import { ScoreKeeper } from '../sim/scoring.js';
import { snapPositionInPlace, snapVelocityInPlace } from '../../../shared/quantize.js';
import type { Connection } from '../rooms/types.js';
import { InputQueue } from './inputqueue.js';
import { LagCompHistory, RewindPool } from './lagcomp.js';
import { ClientBaseline, SnapshotAssembler } from './snapshot.js';
import {
  createDefaultHooks,
  readRuntime,
  runtimeFired,
  type FireContext,
  type FireVictim,
  type SimHooks,
} from './hooks.js';
import type { TrickshotContext } from '../../../shared/trickshot.js';

/**
 * Where kills and aim history go.
 *
 * `server/src/rooms/lobby.ts` (lobby-ui-hud) satisfies this structurally: the
 * Lobby owns the `ScoreKeeper` and the round phase, and broadcasts the KillMsg
 * itself. When a sink is supplied the room stops running its own scoring and
 * phase machine entirely — two ScoreKeepers on one match would double-count
 * every kill and end the game at half the score limit.
 */
export interface ScoringSink {
  registerKill(
    killerId: PlayerId,
    victimId: PlayerId,
    partial: Partial<TrickshotContext>
  ): KillMsg;
  recordYaw(id: PlayerId, tSeconds: number, yaw: number, onGround: boolean): void;
  readonly scoreKeeper?: ScoreKeeper;
}

/** Ticks between snapshots. 60 / 20 = 3. */
export const SNAPSHOT_EVERY = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE));

/** How often the server probes latency. */
const PING_INTERVAL_MS = 1000;

/** Smoothing on the measured RTT. Fast enough to track a route change. */
const RTT_SMOOTHING = 0.25;

/** Inputs consumed in one tick when the queue is running deep. */
const MAX_INPUTS_PER_TICK = 2;
/** Queue depth above which catch-up kicks in. */
const CATCHUP_DEPTH = 4;

export interface RoomPlayerInit {
  id: PlayerId;
  name: string;
  team: TeamId;
  loadout?: Loadout;
  conn?: Connection | null;
}

export interface RoomPlayer {
  readonly id: PlayerId;
  /** Dense index into the lag-comp ring. */
  readonly slot: number;
  conn: Connection | null;
  state: MovementState;
  queue: InputQueue;
  /** Last input actually applied; repeated when the queue starves. */
  lastInput: ClientInput;
  /** Seq of the newest input this player's simulation accounts for. */
  ackedSeq: number;
  baseline: ClientBaseline;
  weaponRuntime: unknown;
  /** Spec for the weapon in hand. Re-picked when a swap completes. */
  resolvedWeapon: unknown;
  primaryWeapon: unknown;
  secondaryWeapon: unknown;
  /** True if the player fired since the last snapshot went out. */
  firedLatch: boolean;
  respawnAtMs: number;
  respawnRequested: boolean;
  oobSeconds: number;
  lastDamageAtMs: number;
  rttMs: number;
  pendingPingTime: number;
  lastPingSentMs: number;
  suspicious: number;
  spawnCursor: number;
}

export interface GameRoomOptions {
  code: string;
  mode?: GameMode;
  scoreLimit?: number;
  timeLimit?: number;
  hooks?: SimHooks;
  /** Auto-respawn without waiting for RequestRespawn. Default true. */
  autoRespawn?: boolean;
  /**
   * Delegates scoring and the round phase to the lobby layer. Pass the `Lobby`
   * when running under `LobbyRegistry`; omit it for a standalone room.
   */
  scoring?: ScoringSink;
}

export class GameRoom {
  readonly code: string;
  readonly mode: GameMode;
  /** Owned only when no external sink was supplied. */
  readonly scoring: ScoreKeeper;
  private readonly sink: ScoringSink | null;

  private readonly world: CollisionWorld = createCollisionWorld();
  private readonly history = new LagCompHistory(MAX_PLAYERS);
  private readonly rewind = new RewindPool();
  private readonly assembler = new SnapshotAssembler();
  private readonly hooks: SimHooks;
  private readonly autoRespawn: boolean;

  private readonly players = new Map<PlayerId, RoomPlayer>();
  private readonly slotsUsed = new Uint8Array(MAX_PLAYERS);

  /** Fire events collected during the movement pass, resolved after history. */
  private readonly pendingFire: RoomPlayer[] = [];
  /** Scratch target list handed to combat. Reused every shot. */
  private readonly targetScratch: PlayerState[] = [];
  private readonly victimScratch: FireVictim[] = [];

  private phase: RoundPhase = RoundPhase.Warmup;
  private phaseEndsAtMs = 0;
  private tickIndex = 0;
  private nowMs = 0;
  private lastRoundBroadcastMs = 0;
  private matchStartedAtMs = 0;

  constructor(opts: GameRoomOptions) {
    this.code = opts.code;
    this.mode = opts.mode ?? GameMode.SnipersOnlyFFA;
    this.scoring = new ScoreKeeper(this.mode, opts.scoreLimit ?? 0, opts.timeLimit ?? 0);
    this.sink = opts.scoring ?? null;
    this.hooks = opts.hooks ?? createDefaultHooks();
    this.autoRespawn = opts.autoRespawn !== false;
  }

  /** The ScoreKeeper that is actually authoritative for this room. */
  private get keeper(): ScoreKeeper {
    return this.sink?.scoreKeeper ?? this.scoring;
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  get playerCount(): number {
    return this.players.size;
  }

  get roundPhase(): RoundPhase {
    return this.phase;
  }

  get currentTick(): number {
    return this.tickIndex;
  }

  list(): IterableIterator<RoomPlayer> {
    return this.players.values();
  }

  get(id: PlayerId): RoomPlayer | undefined {
    return this.players.get(id);
  }

  addPlayer(init: RoomPlayerInit): RoomPlayer | null {
    if (this.players.has(init.id)) return this.players.get(init.id)!;
    const slot = this.takeSlot();
    if (slot < 0) return null;

    const loadout = init.loadout ?? DEFAULT_LOADOUT;
    const state = createPlayerState(init.id, init.name, init.team, loadout);

    const p: RoomPlayer = {
      id: init.id,
      slot,
      conn: init.conn ?? null,
      state,
      queue: new InputQueue(),
      lastInput: emptyInput(),
      ackedSeq: 0,
      baseline: new ClientBaseline(),
      weaponRuntime: null,
      resolvedWeapon: null,
      primaryWeapon: null,
      secondaryWeapon: null,
      firedLatch: false,
      respawnAtMs: 0,
      respawnRequested: false,
      oobSeconds: 0,
      lastDamageAtMs: -1e9,
      rttMs: 0,
      pendingPingTime: 0,
      lastPingSentMs: 0,
      suspicious: 0,
      spawnCursor: init.id,
    };

    this.rebuildWeapon(p);
    this.players.set(init.id, p);
    if (!this.sink) {
      this.scoring.addPlayer(init.id, init.team);
      this.scoring.setName(init.id, init.name);
    }
    this.spawn(p);
    return p;
  }

  removePlayer(id: PlayerId): void {
    const p = this.players.get(id);
    if (!p) return;
    this.slotsUsed[p.slot] = 0;
    this.players.delete(id);
    if (!this.sink) this.scoring.removePlayer(id);
  }

  setConnection(id: PlayerId, conn: Connection | null): void {
    const p = this.players.get(id);
    if (!p) return;
    p.conn = conn;
    // A reconnecting client has no baseline it can prove it received.
    p.baseline = new ClientBaseline();
  }

  setLoadout(id: PlayerId, loadout: Loadout): void {
    const p = this.players.get(id);
    if (!p) return;
    p.state.loadout = loadout;
    this.rebuildWeapon(p);
  }

  setName(id: PlayerId, name: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.state.name = name;
    if (!this.sink) this.scoring.setName(id, name);
  }

  setTeam(id: PlayerId, team: TeamId): void {
    const p = this.players.get(id);
    if (!p) return;
    p.state.team = team;
    if (!this.sink) this.scoring.setTeam(id, team);
  }

  private takeSlot(): number {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (this.slotsUsed[i] === 0) {
        this.slotsUsed[i] = 1;
        return i;
      }
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Client traffic
  // -------------------------------------------------------------------------

  /**
   * Accepts a batch of redundant inputs.
   *
   * `ClientInput.tick` doubles as the client's acknowledgement of the newest
   * snapshot it has applied — the protocol has no dedicated ack field, and the
   * two meanings coincide, because the client's estimate of the server clock
   * IS the last snapshot tick it saw. See "Contract friction".
   */
  onInput(id: PlayerId, inputs: readonly ClientInput[]): void {
    const p = this.players.get(id);
    if (!p || inputs.length === 0) return;
    for (let i = 0; i < inputs.length; i++) p.queue.push(inputs[i]);
    // The FIRST input's tick, not the last: the wire transmits one base tick
    // and derives the rest as base+i, so only inputs[0] carries the value the
    // client actually wrote. At worst the ack is two ticks stale, which is
    // irrelevant for choosing a baseline.
    this.assembler.ack(p.baseline, inputs[0].tick & 0xffff, this.nowMs);
  }

  onPong(id: PlayerId, time: number, nowMs: number): void {
    const p = this.players.get(id);
    if (!p) return;
    if (p.pendingPingTime === 0 || time !== p.pendingPingTime) return;
    const rtt = nowMs - time;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) return;
    p.rttMs = p.rttMs === 0 ? rtt : p.rttMs + (rtt - p.rttMs) * RTT_SMOOTHING;
    p.state.ping = Math.round(p.rttMs);
    p.pendingPingTime = 0;
  }

  requestRespawn(id: PlayerId): void {
    const p = this.players.get(id);
    if (p) p.respawnRequested = true;
  }

  /** Round-trip time in ms, as measured by the server. */
  pingOf(id: PlayerId): number {
    const p = this.players.get(id);
    return p ? Math.round(p.rttMs) : 0;
  }

  broadcast(msg: AnyServerMessage, exceptId?: PlayerId): void {
    for (const p of this.players.values()) {
      if (p.conn && p.id !== exceptId) p.conn.send(msg);
    }
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  tick(tick: number, nowMs: number): void {
    this.tickIndex = tick;
    this.nowMs = nowMs;
    const nowSec = nowMs / 1000;
    this.pendingFire.length = 0;

    // --- 1..3: input, weapons, movement -------------------------------------
    for (const p of this.players.values()) {
      const input = this.nextInput(p);
      // Captured before movement, which overwrites `prevButtons` with this
      // tick's buttons — read it afterwards and every rising edge disappears.
      const prevButtons = p.state.prevButtons ?? 0;
      this.advanceWeapon(p, input);
      this.advanceMovement(p, input);
      this.recordYaw(p.id, nowSec, p.state.yaw, p.state.onGround);
      if (this.detectFire(p, input, prevButtons)) this.pendingFire.push(p);
    }

    // --- 4: history ---------------------------------------------------------
    this.history.beginTick(tick, nowMs);
    for (const p of this.players.values()) this.history.record(p.slot, p.state);

    // --- 5: lag-compensated firing -----------------------------------------
    for (let i = 0; i < this.pendingFire.length; i++) {
      this.resolveFire(this.pendingFire[i], nowMs, nowSec);
    }

    // --- 6: bodies, timers -------------------------------------------------
    for (const p of this.players.values()) this.postSim(p, nowMs, nowSec);

    // --- 7: round phase ----------------------------------------------------
    this.advancePhase(nowMs, nowSec);

    // --- 8: replication ----------------------------------------------------
    this.sendPings(nowMs);
    if (tick % SNAPSHOT_EVERY === 0) this.sendSnapshots(tick, nowMs);

    this.hooks.postTick?.(tick, Array.from(this.players.values(), (p) => p.state));
  }

  /**
   * One input per tick, with a small catch-up when the queue has run deep
   * (the client's clock is ahead, or a burst arrived after loss) and a repeat
   * of the last input when it has run dry.
   *
   * Repeating verbatim is deliberate: `applyMovement` derives rising edges
   * from `prevButtons`, so a repeated input re-triggers nothing. A held jump
   * stays held; it does not bunny-hop for free during packet loss.
   */
  private nextInput(p: RoomPlayer): ClientInput {
    let used: ClientInput | null = null;
    const budget = p.queue.size > CATCHUP_DEPTH ? MAX_INPUTS_PER_TICK : 1;
    for (let i = 0; i < budget; i++) {
      const next = p.queue.shift();
      if (!next) break;
      if (used) {
        // Catch-up: run the intermediate input through the simulation too, so
        // no input is ever silently discarded.
        this.advanceWeapon(p, used);
        this.advanceMovement(p, used);
      }
      used = next;
    }
    if (used) {
      copyInput(used, p.lastInput);
      p.ackedSeq = used.seq;
    }
    return p.lastInput;
  }

  private advanceMovement(p: RoomPlayer, input: ClientInput): void {
    const result = stepPlayerMovement(p.state, input, TICK_DT, this.world);
    p.state = result.state;
    if (result.suspicious) p.suspicious++;
    if (result.outOfBounds && p.state.alive) p.oobSeconds += TICK_DT;
    else if (!result.outOfBounds) p.oobSeconds = 0;
  }

  private advanceWeapon(p: RoomPlayer, input: ClientInput): void {
    const weapons = this.hooks.weapons;
    if (!weapons || !p.resolvedWeapon || p.weaponRuntime === null) return;
    p.weaponRuntime = weapons.advanceWeapon(p.weaponRuntime, input, TICK_DT, p.resolvedWeapon);
    const v = readRuntime(p.weaponRuntime);
    const s = p.state;

    // A completed swap changes which weapon is in hand; the spec for the NEXT
    // tick has to follow it, or the sidearm keeps firing at sniper cycle time.
    if (v.activeWeapon !== undefined && v.activeWeapon !== s.activeWeapon) {
      p.resolvedWeapon = this.specFor(p, v.activeWeapon);
    }

    if (weapons.syncStateFromRuntime) {
      weapons.syncStateFromRuntime(s, p.weaponRuntime, this.nowMs);
    } else {
      if (v.adsState !== undefined) s.adsState = v.adsState;
      if (v.adsProgress !== undefined) s.adsProgress = v.adsProgress;
      if (v.ammoInMag !== undefined) s.ammoInMag = v.ammoInMag;
      if (v.ammoReserve !== undefined) s.ammoReserve = v.ammoReserve;
      if (v.actionEndsAt !== undefined) s.actionEndsAt = v.actionEndsAt;
      if (v.activeWeapon !== undefined) s.activeWeapon = v.activeWeapon;
    }

    const override = v.adsMoveSpeedOverride ?? v.adsMoveSpeed;
    if (override !== undefined) s.adsMoveSpeedOverride = override;
  }

  /** The resolved spec for whichever of the two weapons `id` names. */
  private specFor(p: RoomPlayer, id: WeaponId): unknown {
    const primaryId = p.state.loadout?.primary ?? WeaponId.Talon;
    return id === primaryId ? p.primaryWeapon : p.secondaryWeapon;
  }

  private rebuildWeapon(p: RoomPlayer): void {
    const weapons = this.hooks.weapons;
    if (!weapons) return;
    const l = p.state.loadout ?? DEFAULT_LOADOUT;
    p.primaryWeapon = weapons.resolveLoadout
      ? weapons.resolveLoadout(l)
      : weapons.resolveWeapon(l.primary, l.attachments as unknown as never);
    p.secondaryWeapon = weapons.resolveSecondary
      ? weapons.resolveSecondary(l)
      : p.primaryWeapon;
    p.resolvedWeapon = p.primaryWeapon;
    p.weaponRuntime = weapons.createWeaponRuntime
      ? weapons.createWeaponRuntime(p.resolvedWeapon, p.state)
      : {};
    // Movement reads `adsMoveSpeedOverride`, never the loadout. This is the
    // only place the Lightweight Stock reaches the character controller.
    weapons.applyLoadoutToState?.(p.state, p.resolvedWeapon);
    // Publish the fresh magazine immediately: the first snapshot after a spawn
    // goes out before the first `advanceWeapon`, and an ammo counter that
    // reads 0 for 16 ms on every respawn is a visible flicker.
    weapons.syncStateFromRuntime?.(p.state, p.weaponRuntime, this.nowMs);
  }

  /**
   * Did this player fire this tick?
   *
   * The weapon module is authoritative when it is present. Without it, the
   * rising edge of the fire button is used so an injected `resolveFire` still
   * has something to work with — a reduced game, not a broken one.
   */
  private detectFire(p: RoomPlayer, input: ClientInput, prevButtons: number): boolean {
    if (!p.state.alive) return false;
    if (this.hooks.weapons && p.weaponRuntime) return runtimeFired(p.weaponRuntime) > 0;
    if (!this.hooks.resolveFire) return false;
    const down = (input.buttons & InputButton.Fire) !== 0;
    return down && (prevButtons & InputButton.Fire) === 0;
  }

  /**
   * Rewinds every other player to where the shooter saw them and hands those
   * states to combat.
   *
   * The rewind target is `now - (rtt/2 + INTERP_DELAY_MS)`: half the round trip
   * for the packet's flight, plus the interpolation delay, because the client
   * renders remote players that far in the past by design.
   */
  private resolveFire(p: RoomPlayer, nowMs: number, nowSec: number): void {
    p.firedLatch = true;
    const resolve = this.hooks.resolveFire;
    if (!resolve) return;

    const rewindMs = LagCompHistory.rewindForRtt(p.rttMs);
    const targetTime = nowMs - rewindMs;

    this.rewind.reset();
    const targets = this.targetScratch;
    targets.length = 0;
    for (const other of this.players.values()) {
      if (other.id === p.id) continue;
      const copy = this.rewind.take(other.state);
      this.history.sample(other.slot, targetTime, copy);
      targets.push(copy);
    }

    const ctx: FireContext = {
      shooter: p.state,
      targets,
      rewindMs,
      tick: this.tickIndex,
      nowMs,
      nowSeconds: nowSec,
      input: p.lastInput,
      weaponRuntime: p.weaponRuntime,
      resolvedWeapon: p.resolvedWeapon,
    };

    let outcome;
    try {
      outcome = resolve(ctx);
    } catch (err) {
      // A throw from combat must not take the tick — and therefore the whole
      // lobby — down with it.
      logOnce('resolveFire threw', err);
      return;
    }
    if (!outcome) return;

    if (outcome.reason !== null && outcome.reason !== undefined) {
      // The server's own state machine says this shot was impossible. Tell the
      // shooter so their prediction stops showing a bullet that never existed.
      this.sendCorrection(p, outcome.reason);
      return;
    }

    if (outcome.hitMessages) {
      for (let i = 0; i < outcome.hitMessages.length; i++) {
        this.broadcast({ type: ServerMessage.Hit, data: outcome.hitMessages[i] });
      }
    }

    // Combat resolved against the REWOUND CLONES and applied its damage there.
    // Re-apply it to the live players here: the clones are scratch, and death,
    // respawn timers and replication all belong to the room.
    const victims = this.victimScratch;
    victims.length = 0;
    if (outcome.hits) {
      for (let i = 0; i < outcome.hits.length; i++) {
        const h = outcome.hits[i];
        const victim = this.players.get(h.victimId);
        if (!victim || !victim.state.alive) continue;
        if (this.applyDamage(victim, h.damage, nowMs)) {
          victims.push({ id: h.victimId, part: h.part, distance: h.distance });
        }
      }
    }

    if (victims.length > 0) {
      this.reportKill(p, victims, nowSec, outcome.context);
    }
  }

  /** A rejected predicted action: snap the client back to the truth. */
  private sendCorrection(p: RoomPlayer, reason: CorrectionReason): void {
    if (!p.conn) return;
    const s = p.state;
    p.conn.send({
      type: ServerMessage.Correction,
      data: {
        seq: p.ackedSeq,
        reason,
        state: {
          id: s.id,
          position: vec3(s.position.x, s.position.y, s.position.z),
          velocity: vec3(s.velocity.x, s.velocity.y, s.velocity.z),
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
        },
      },
    });
  }

  /** Returns true when the damage was lethal. */
  private applyDamage(victim: RoomPlayer, amount: number, nowMs: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    victim.state.health -= amount;
    victim.lastDamageAtMs = nowMs;
    if (victim.state.health > 0) return false;
    victim.state.health = 0;
    victim.state.alive = false;
    victim.respawnAtMs = nowMs + RESPAWN_DELAY * 1000;
    victim.respawnRequested = false;
    return true;
  }

  private recordYaw(id: PlayerId, tSeconds: number, yaw: number, onGround: boolean): void {
    if (this.sink) this.sink.recordYaw(id, tSeconds, yaw, onGround);
    else this.scoring.recordYaw(id, tSeconds, yaw, onGround);
  }

  /**
   * One call per BULLET, not per victim — `ScoreKeeper.onKill` credits every
   * listed victim a death and the shooter a kill, so a second call for a
   * collateral would double count.
   */
  private reportKill(
    killer: RoomPlayer,
    victims: FireVictim[],
    nowSec: number,
    context?: Partial<TrickshotContext>
  ): void {
    const v = readRuntime(killer.weaponRuntime);
    const partial: Partial<TrickshotContext> = {
      shooter: killer.state,
      now: nowSec,
      adsState: killer.state.adsState,
      adsProgress: killer.state.adsProgress,
      timeSinceAccuracyLock: v.timeSinceAccuracyLock,
      stanceAtFire: killer.state.stance,
      wasAirborne: !killer.state.onGround,
      // A dropshot is "fired mid-transition", so the countdown being non-zero
      // is exactly the condition, not its remaining value.
      proneTransition: (killer.state.proneTime ?? 0) > 0,
      // Combat knows more than the room does about the shot itself; anything
      // it supplied wins.
      ...(context ?? {}),
    };
    // The room is authoritative about who actually died: it applied the damage
    // to the live players, combat only touched the rewound clones.
    partial.victims = victims.slice();
    this.emitKill(killer.id, victims[0].id, partial);
    this.syncStats(killer.id);
    for (let i = 0; i < victims.length; i++) this.syncStats(victims[i].id);
  }

  /** Self-inflicted death (out of bounds). No score, still a death. */
  private killSelf(p: RoomPlayer, nowMs: number, nowSec: number): void {
    p.state.alive = false;
    p.state.health = 0;
    p.respawnAtMs = nowMs + RESPAWN_DELAY * 1000;
    p.oobSeconds = 0;
    this.emitKill(0, p.id, { now: nowSec, shooter: p.state });
    this.syncStats(p.id);
  }

  /** The lobby broadcasts its own KillMsg; a standalone room broadcasts ours. */
  private emitKill(
    killerId: PlayerId,
    victimId: PlayerId,
    partial: Partial<TrickshotContext>
  ): void {
    if (this.sink) {
      this.sink.registerKill(killerId, victimId, partial);
      return;
    }
    const msg: KillMsg = this.scoring.onKill(killerId, victimId, partial);
    this.broadcast({ type: ServerMessage.Kill, data: msg });
  }

  private syncStats(id: PlayerId): void {
    const p = this.players.get(id);
    if (!p) return;
    const stats = this.keeper.statsFor(id);
    if (!stats) return;
    p.state.score = stats.score;
    p.state.kills = stats.kills;
    p.state.deaths = stats.deaths;
    p.state.streak = stats.streak;
  }

  private postSim(p: RoomPlayer, nowMs: number, nowSec: number): void {
    const s = p.state;

    if (s.alive) {
      if (p.oobSeconds >= OOB_COUNTDOWN) {
        this.killSelf(p, nowMs, nowSec);
        return;
      }
      if (s.health < MAX_HEALTH && nowMs - p.lastDamageAtMs >= HEALTH_REGEN_DELAY * 1000) {
        s.health = Math.min(MAX_HEALTH, s.health + HEALTH_REGEN_RATE * TICK_DT);
      }
      return;
    }

    const due = nowMs >= p.respawnAtMs;
    if (due && (this.autoRespawn || p.respawnRequested)) this.spawn(p);
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Picks the spawn furthest from living enemies.
   *
   * Deterministic by design — `shared/rng.ts` is owned by weapons-hitreg and
   * the simulation may not call `Math.random`. Ties break on a per-player
   * cursor so two players spawning on the same tick do not stack.
   */
  private chooseSpawn(p: RoomPlayer): SpawnPoint {
    let best: SpawnPoint = SPAWN_POINTS[p.spawnCursor % SPAWN_POINTS.length];
    let bestScore = -Infinity;
    const n = SPAWN_POINTS.length;
    for (let i = 0; i < n; i++) {
      const sp = SPAWN_POINTS[(p.spawnCursor + i) % n];
      let nearest = Infinity;
      for (const other of this.players.values()) {
        if (other.id === p.id || !other.state.alive) continue;
        if (this.mode === GameMode.TeamDeathmatch && other.state.team === p.state.team) continue;
        const dx = other.state.position.x - sp.position.x;
        const dy = other.state.position.y - sp.position.y;
        const dz = other.state.position.z - sp.position.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < nearest) nearest = d;
      }
      // Anything past the minimum distance is equally safe; prefer variety.
      const score = nearest === Infinity ? SPAWN_MIN_ENEMY_DIST * 2 : Math.min(nearest, SPAWN_MIN_ENEMY_DIST * 2);
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    p.spawnCursor = (p.spawnCursor + 5) % n;
    return best;
  }

  spawn(p: RoomPlayer): void {
    const sp = this.chooseSpawn(p);
    const s = p.state;
    s.position.x = sp.position.x;
    s.position.y = sp.position.y;
    s.position.z = sp.position.z;
    s.velocity.x = 0;
    s.velocity.y = 0;
    s.velocity.z = 0;
    s.yaw = sp.yaw;
    s.pitch = 0;
    s.stance = Stance.Stand;
    s.onGround = true;
    s.slideTime = 0;
    s.slideCooldown = 0;
    s.sprintTime = 0;
    s.prevButtons = 0;
    s.proneTime = 0;
    s.health = MAX_HEALTH;
    s.alive = true;
    s.adsState = AdsState.Hip;
    s.adsProgress = 0;
    s.actionEndsAt = 0;
    p.oobSeconds = 0;
    p.respawnRequested = false;
    p.lastDamageAtMs = -1e9;
    this.rebuildWeapon(p);

    // The spawn angle is authoritative, so the client's controller must adopt
    // it — the Spawn message is what tells it to.
    this.broadcast({
      type: ServerMessage.Spawn,
      data: { playerId: p.id, position: vec3(s.position.x, s.position.y, s.position.z), yaw: s.yaw, loadout: s.loadout },
    });
  }

  // -------------------------------------------------------------------------
  // Round phase
  // -------------------------------------------------------------------------

  private advancePhase(nowMs: number, nowSec: number): void {
    // The Lobby runs the phase machine and broadcasts RoundState/MatchOver
    // when one exists. Running a second one here would fight it.
    if (this.sink) return;
    let changed = false;

    switch (this.phase) {
      case RoundPhase.Warmup:
        if (this.players.size >= MIN_PLAYERS_TO_START) {
          this.phase = RoundPhase.Countdown;
          this.phaseEndsAtMs = nowMs + COUNTDOWN_TIME * 1000;
          changed = true;
        }
        break;
      case RoundPhase.Countdown:
        if (this.players.size < MIN_PLAYERS_TO_START) {
          this.phase = RoundPhase.Warmup;
          changed = true;
        } else if (nowMs >= this.phaseEndsAtMs) {
          this.phase = RoundPhase.Live;
          this.matchStartedAtMs = nowMs;
          this.scoring.startMatch(nowSec);
          changed = true;
        }
        break;
      case RoundPhase.Live: {
        const result = this.scoring.tick(nowSec);
        if (result.ended) {
          this.phase = RoundPhase.Over;
          this.phaseEndsAtMs = nowMs + POST_MATCH_TIME * 1000;
          changed = true;
          if (result.result) {
            this.broadcast({ type: ServerMessage.MatchOver, data: result.result });
          }
        }
        break;
      }
      case RoundPhase.Over:
        if (nowMs >= this.phaseEndsAtMs) {
          this.phase = RoundPhase.Warmup;
          changed = true;
        }
        break;
      default:
        break;
    }

    if (changed || nowMs - this.lastRoundBroadcastMs >= 1000) {
      this.lastRoundBroadcastMs = nowMs;
      this.broadcast({ type: ServerMessage.RoundState, data: this.roundState(nowMs) });
    }
  }

  roundState(nowMs: number): {
    phase: RoundPhase;
    timeRemaining: number;
    scoreLimit: number;
    teamScores: [number, number];
  } {
    let timeRemaining: number;
    if (this.phase === RoundPhase.Live) timeRemaining = this.scoring.timeRemaining();
    else if (this.phase === RoundPhase.Warmup) timeRemaining = 0;
    else timeRemaining = Math.max(0, (this.phaseEndsAtMs - nowMs) / 1000);
    return {
      phase: this.phase,
      timeRemaining,
      scoreLimit: this.scoring.scoreLimit,
      teamScores: this.scoring.teamScores(),
    };
  }

  // -------------------------------------------------------------------------
  // Replication
  // -------------------------------------------------------------------------

  private sendPings(nowMs: number): void {
    for (const p of this.players.values()) {
      if (!p.conn) continue;
      if (nowMs - p.lastPingSentMs < PING_INTERVAL_MS) continue;
      p.lastPingSentMs = nowMs;
      p.pendingPingTime = nowMs;
      p.conn.send({ type: ServerMessage.Ping, data: { time: nowMs } });
    }
  }

  private sendSnapshots(tick: number, nowMs: number): void {
    // THE quantization commit. Everything downstream — the frame table, the
    // wire, and the client's reconciliation — now agrees on these exact
    // values, and so does the server's next tick.
    for (const p of this.players.values()) {
      snapPositionInPlace(p.state.position);
      snapVelocityInPlace(p.state.velocity);
    }

    this.assembler.beginTick(tick);
    for (const p of this.players.values()) {
      this.assembler.addPlayer(p.state, { fired: p.firedLatch });
    }

    for (const p of this.players.values()) {
      if (!p.conn) continue;
      const msg: SnapshotMsg = this.assembler.buildFor(p.baseline, p.ackedSeq, nowMs);
      p.conn.send({ type: ServerMessage.Snapshot, data: msg });
    }

    for (const p of this.players.values()) p.firedLatch = false;
  }

  /** Diagnostics for the bandwidth test and the ops endpoint. */
  stats(): {
    players: number;
    tick: number;
    phase: RoundPhase;
    historySamples: number;
    suspicious: number;
  } {
    let suspicious = 0;
    for (const p of this.players.values()) suspicious += p.suspicious;
    return {
      players: this.players.size,
      tick: this.tickIndex,
      phase: this.phase,
      historySamples: this.history.sampleCount,
      suspicious,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createPlayerState(
  id: PlayerId,
  name: string,
  team: TeamId,
  loadout: Loadout
): MovementState {
  return {
    id,
    position: vec3(0, 0, 0),
    velocity: vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    slideTime: 0,
    slideCooldown: 0,
    sprintTime: 0,
    prevButtons: 0,
    proneTime: 0,
    health: MAX_HEALTH,
    alive: true,
    activeWeapon: loadout.primary ?? WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    ammoInMag: 0,
    ammoReserve: 0,
    actionEndsAt: 0,
    name,
    team,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout,
    ping: 0,
  };
}

export function copyInput(src: ClientInput, dst: ClientInput): void {
  dst.seq = src.seq;
  dst.tick = src.tick;
  dst.moveX = src.moveX;
  dst.moveZ = src.moveZ;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.buttons = src.buttons;
}

const loggedOnce = new Set<string>();
function logOnce(tag: string, err: unknown): void {
  if (loggedOnce.has(tag)) return;
  loggedOnce.add(tag);
  console.error(`[deckshot] ${tag}:`, err);
}

export { seqDiff };
