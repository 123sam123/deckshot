/**
 * DECKSHOT — authoritative match scoring.
 *
 * Owner: trickshot-scoring.
 *
 * The ScoreKeeper is the only thing in the server that decides what a kill was
 * worth. The net layer feeds it kills and yaw samples; it hands back a fully
 * populated KillMsg ready to broadcast, and eventually a MatchOverMsg.
 *
 * Two rules it exists to enforce:
 *   1. Trickshot flags are derived here, from server state, never accepted
 *      from a client.
 *   2. A death you caused yourself is never a trickshot.
 */

import type { KillMsg, MatchOverMsg, ScoreboardEntry } from '../../../shared/protocol.js';
import {
  FFA_SCORE_LIMIT,
  MATCH_TIME_LIMIT,
  SPIN_LOOKBACK,
  TDM_SCORE_LIMIT,
  TICK_RATE,
  ATTACHMENTS,
} from '../../../shared/tuning.js';
import {
  JUMPSHOT_WINDOW,
  evaluateTrickshot,
  type TrickshotContext,
  type TrickshotVictim,
  type YawSample,
} from '../../../shared/trickshot.js';
import {
  AdsState,
  AttachmentId,
  DEFAULT_LOADOUT,
  GameMode,
  HitboxPart,
  Stance,
  TeamId,
  WeaponId,
  vec3,
} from '../../../shared/types.js';
import type { Loadout, PlayerId, PlayerState, Vec3 } from '../../../shared/types.js';

/**
 * Yaw ring buffer capacity. SPIN_LOOKBACK seconds at TICK_RATE is 90 samples;
 * a couple of spares absorb a late or duplicated tick. This is a hard cap —
 * the buffer is allocated once per player and never grows.
 */
export const YAW_HISTORY_SIZE = Math.ceil(SPIN_LOOKBACK * TICK_RATE) + 2;

/** Recent-kill timestamps retained per player. Bounded; pruned by FEED_WINDOW. */
const KILL_TIME_CAP = 16;

interface PlayerRecord {
  id: PlayerId;
  team: TeamId;
  name: string;
  score: number;
  kills: number;
  deaths: number;
  streak: number;
  bestStreak: number;
  bestTrickshotScore: number;
  bestTrickshotFlags: number;
  /** Server times (seconds) of this player's kills, ascending, pruned. */
  recentKillTimes: number[];

  // Yaw ring buffer — parallel typed arrays, zero allocation per sample.
  yawT: Float64Array;
  yawY: Float64Array;
  yawG: Uint8Array;
  /** Total samples ever written; the write head is `yawCount % YAW_HISTORY_SIZE`. */
  yawCount: number;
}

export interface TickResult {
  ended: boolean;
  result?: MatchOverMsg;
}

function makeRecord(id: PlayerId, team: TeamId): PlayerRecord {
  return {
    id,
    team,
    name: `Player ${id}`,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    bestStreak: 0,
    bestTrickshotScore: 0,
    bestTrickshotFlags: 0,
    recentKillTimes: [],
    yawT: new Float64Array(YAW_HISTORY_SIZE),
    yawY: new Float64Array(YAW_HISTORY_SIZE),
    yawG: new Uint8Array(YAW_HISTORY_SIZE),
    yawCount: 0,
  };
}

/**
 * A minimally valid PlayerState, used only when the caller did not supply the
 * rewound shooter state. Never authoritative for anything but avoiding a
 * crash — a missing shooter means no positional modifiers.
 */
function placeholderState(id: PlayerId, team: TeamId): PlayerState {
  return {
    id,
    position: vec3(),
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    slideTime: 0,
    slideCooldown: 0,
    sprintTime: 0,
    health: 100,
    alive: true,
    activeWeapon: WeaponId.Talon,
    adsState: AdsState.Hip,
    adsProgress: 0,
    ammoInMag: 0,
    ammoReserve: 0,
    actionEndsAt: 0,
    name: `Player ${id}`,
    team,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 0,
  };
}

function isSuppressed(loadout: Loadout | undefined): boolean {
  if (!loadout || !loadout.attachments) return false;
  for (let i = 0; i < loadout.attachments.length; i++) {
    const a = loadout.attachments[i] as AttachmentId;
    if (a === AttachmentId.None) continue;
    const spec = ATTACHMENTS[a];
    if (spec && spec.flags && spec.flags.suppressed) return true;
  }
  return false;
}

export class ScoreKeeper {
  readonly mode: GameMode;
  readonly scoreLimit: number;
  readonly timeLimit: number;

  private players = new Map<PlayerId, PlayerRecord>();
  /** Team kill totals, kept outside PlayerRecord so a leaver cannot erase them. */
  private teamKills: [number, number] = [0, 0];
  /** Scoreboard rows for players who left, so the final board stays honest. */
  private departed: ScoreboardEntry[] = [];

  private matchStart = Number.NaN;
  private now = 0;
  private ended = false;
  private finalResult: MatchOverMsg | null = null;

  private best: KillMsg | null = null;

  constructor(mode: GameMode, scoreLimit: number, timeLimit: number) {
    this.mode = mode;
    const defaultLimit = mode === GameMode.TeamDeathmatch ? TDM_SCORE_LIMIT : FFA_SCORE_LIMIT;
    this.scoreLimit = Number.isFinite(scoreLimit) && scoreLimit > 0 ? scoreLimit : defaultLimit;
    this.timeLimit = Number.isFinite(timeLimit) && timeLimit > 0 ? timeLimit : MATCH_TIME_LIMIT;
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  addPlayer(id: PlayerId, team: TeamId): void {
    if (this.players.has(id)) {
      const existing = this.players.get(id)!;
      existing.team = team;
      return;
    }
    this.players.set(id, makeRecord(id, team));
  }

  removePlayer(id: PlayerId): void {
    const rec = this.players.get(id);
    if (!rec) return;
    this.departed.push(this.entryFor(rec));
    this.players.delete(id);
  }

  /** Late team assignment (team select, autobalance). Does not reset stats. */
  setTeam(id: PlayerId, team: TeamId): void {
    const rec = this.players.get(id);
    if (rec) rec.team = team;
  }

  setName(id: PlayerId, name: string): void {
    const rec = this.players.get(id);
    if (rec && name) rec.name = name;
  }

  has(id: PlayerId): boolean {
    return this.players.has(id);
  }

  /** Current stats for a player, for stamping into PlayerState / snapshots. */
  statsFor(
    id: PlayerId,
  ): { score: number; kills: number; deaths: number; streak: number } | null {
    const rec = this.players.get(id);
    if (!rec) return null;
    return { score: rec.score, kills: rec.kills, deaths: rec.deaths, streak: rec.streak };
  }

  /** [Alpha, Bravo] kill totals. FFA leaves both at 0 except for stray kills. */
  teamScores(): [number, number] {
    return [this.teamKills[0], this.teamKills[1]];
  }

  /** The best trickshot of the match so far, or null. */
  bestTrickshot(): KillMsg | null {
    return this.best;
  }

  // -------------------------------------------------------------------------
  // Yaw history
  // -------------------------------------------------------------------------

  /**
   * Record one tick of the shooter's aim. Called at TICK_RATE by the sim.
   * O(1), no allocation, bounded memory.
   */
  recordYaw(id: PlayerId, t: number, yaw: number, onGround: boolean): void {
    const rec = this.players.get(id);
    if (!rec) return;
    if (!Number.isFinite(t) || !Number.isFinite(yaw)) return;
    const i = rec.yawCount % YAW_HISTORY_SIZE;
    rec.yawT[i] = t;
    rec.yawY[i] = yaw;
    rec.yawG[i] = onGround ? 1 : 0;
    rec.yawCount++;
  }

  /** Chronological copy of a player's retained yaw history (oldest first). */
  yawHistory(id: PlayerId): YawSample[] {
    const rec = this.players.get(id);
    if (!rec) return [];
    const out: YawSample[] = [];
    const total = rec.yawCount;
    const start = Math.max(0, total - YAW_HISTORY_SIZE);
    for (let n = start; n < total; n++) {
      const i = n % YAW_HISTORY_SIZE;
      out.push({ t: rec.yawT[i], yaw: rec.yawY[i], onGround: rec.yawG[i] === 1 });
    }
    return out;
  }

  /**
   * True if the shooter's ground contact was lost within JUMPSHOT_WINDOW of
   * `now`. Derived from the same ring buffer, so scoring needs nothing from
   * the movement module.
   */
  private jumpedRecently(rec: PlayerRecord, now: number): boolean {
    const total = rec.yawCount;
    const start = Math.max(0, total - YAW_HISTORY_SIZE);
    let prevGround = true;
    let havePrev = false;
    let lastLeaveT = Number.NEGATIVE_INFINITY;
    for (let n = start; n < total; n++) {
      const i = n % YAW_HISTORY_SIZE;
      const g = rec.yawG[i] === 1;
      if (havePrev && prevGround && !g) lastLeaveT = rec.yawT[i];
      prevGround = g;
      havePrev = true;
    }
    return lastLeaveT > Number.NEGATIVE_INFINITY && now - lastLeaveT <= JUMPSHOT_WINDOW + 1e-9;
  }

  // -------------------------------------------------------------------------
  // Kills
  // -------------------------------------------------------------------------

  /**
   * Register a death and return the KillMsg to broadcast.
   *
   * `partial` carries whatever the combat module knows: the rewound shooter
   * state, ADS timing, the victim list for the bullet. Anything omitted is
   * filled from tracked state or defaulted conservatively — a missing field
   * can only ever cost the shooter a modifier, never invent one.
   *
   * CALL ONCE PER BULLET, not once per victim. `partial.victims` lists every
   * player the round killed; `victimId` names the one the killfeed leads with.
   * Every listed victim is credited a death and the shooter a kill here, so a
   * second call for a collateral victim would double count.
   */
  onKill(killerId: PlayerId, victimId: PlayerId, partial: Partial<TrickshotContext>): KillMsg {
    const now = Number.isFinite(partial.now as number) ? (partial.now as number) : this.now;
    this.now = Math.max(this.now, now);

    const killer = this.players.get(killerId);
    const victim = this.players.get(victimId);

    // Victim always takes the death and loses the streak, however they died.
    if (victim) {
      victim.deaths++;
      victim.streak = 0;
    }

    const shooter = partial.shooter ?? placeholderState(killerId, killer?.team ?? TeamId.None);
    const victims: TrickshotVictim[] = (partial.victims && partial.victims.length > 0
      ? partial.victims
      : [{ id: victimId, part: HitboxPart.Chest, distance: 0 }]
    ).filter((v) => !!v);

    const self = killerId === 0 || killerId === victimId || !killer;
    const teamKill =
      !self &&
      this.mode === GameMode.TeamDeathmatch &&
      !!victim &&
      killer.team === victim.team &&
      killer.team !== TeamId.None;

    const primary = victims.find((v) => v.id === victimId) ?? victims[0];

    if (self || teamKill) {
      // Suicide, out-of-bounds, or a teamkill: a death, no score, no flags,
      // and the killer's streak (if there is one) is broken.
      if (killer && !self) killer.streak = 0;
      return {
        killerId,
        victimId,
        weapon: shooter.activeWeapon ?? WeaponId.Talon,
        part: primary ? primary.part : HitboxPart.Chest,
        distance: 0,
        trickshot: 0,
        collateralCount: 0,
        score: 0,
        suppressed: isSuppressed(shooter.loadout),
        killerPosition: cloneVec(shooter.position),
      };
    }

    const ctx: TrickshotContext = {
      shooter,
      yawHistory: partial.yawHistory ?? this.yawHistory(killerId),
      timeSinceAccuracyLock: Number.isFinite(partial.timeSinceAccuracyLock as number)
        ? (partial.timeSinceAccuracyLock as number)
        : Number.POSITIVE_INFINITY,
      adsState: partial.adsState ?? shooter.adsState ?? AdsState.Hip,
      adsProgress: partial.adsProgress ?? shooter.adsProgress ?? 0,
      victims,
      recentKillTimes: partial.recentKillTimes ?? killer.recentKillTimes,
      now,
      wasAirborne: partial.wasAirborne ?? shooter.onGround === false,
      stanceAtFire: partial.stanceAtFire ?? shooter.stance ?? Stance.Stand,
      jumpedRecently: partial.jumpedRecently ?? this.jumpedRecently(killer, now),
    };
    if (partial.proneTransition !== undefined) ctx.proneTransition = partial.proneTransition;

    const { flags, score } = evaluateTrickshot(ctx);

    // Every victim of the bullet counts as a kill for the shooter.
    const kills = Math.max(1, victims.length);
    killer.kills += kills;
    killer.score += score;
    killer.streak += kills;
    if (killer.streak > killer.bestStreak) killer.bestStreak = killer.streak;
    this.addTeamKills(killer.team, kills);

    // Extra victims of the same bullet take their death here — see the
    // one-call-per-bullet rule in the onKill docstring.
    for (let i = 0; i < victims.length; i++) {
      const v = victims[i];
      if (v.id === victimId) continue;
      const other = this.players.get(v.id);
      if (other) {
        other.deaths++;
        other.streak = 0;
      }
    }

    killer.recentKillTimes.push(now);
    this.pruneKillTimes(killer, now);

    if (score > killer.bestTrickshotScore) {
      killer.bestTrickshotScore = score;
      killer.bestTrickshotFlags = flags;
    }

    const msg: KillMsg = {
      killerId,
      victimId,
      weapon: shooter.activeWeapon ?? WeaponId.Talon,
      part: primary ? primary.part : HitboxPart.Chest,
      distance: primary && Number.isFinite(primary.distance) ? primary.distance : 0,
      trickshot: flags,
      collateralCount: victims.length,
      score,
      suppressed: isSuppressed(shooter.loadout),
      killerPosition: cloneVec(shooter.position),
    };

    if (flags !== 0 && (!this.best || score > this.best.score)) {
      this.best = msg;
    }

    return msg;
  }

  private addTeamKills(team: TeamId, n: number): void {
    if (team === TeamId.Alpha) this.teamKills[0] += n;
    else if (team === TeamId.Bravo) this.teamKills[1] += n;
  }

  private pruneKillTimes(rec: PlayerRecord, now: number): void {
    const times = rec.recentKillTimes;
    // Keep only what feed detection can still use, and never more than the cap.
    const cutoff = now - 60;
    let i = 0;
    while (i < times.length && times[i] < cutoff) i++;
    if (i > 0) times.splice(0, i);
    if (times.length > KILL_TIME_CAP) times.splice(0, times.length - KILL_TIME_CAP);
  }

  // -------------------------------------------------------------------------
  // Match end
  // -------------------------------------------------------------------------

  /** Explicit match start. Optional — the first tick() sets it if unused. */
  startMatch(nowSeconds: number): void {
    this.matchStart = nowSeconds;
    this.now = nowSeconds;
  }

  /** Seconds remaining in the match, clamped at 0. */
  timeRemaining(): number {
    if (!Number.isFinite(this.matchStart)) return this.timeLimit;
    return Math.max(0, this.timeLimit - (this.now - this.matchStart));
  }

  tick(nowSeconds: number): TickResult {
    if (Number.isFinite(nowSeconds)) {
      this.now = nowSeconds;
      if (!Number.isFinite(this.matchStart)) this.matchStart = nowSeconds;
    }

    if (this.ended) {
      return this.finalResult ? { ended: true, result: this.finalResult } : { ended: true };
    }

    const elapsed = Number.isFinite(this.matchStart) ? this.now - this.matchStart : 0;
    const timeUp = elapsed >= this.timeLimit;
    const limitHit = this.scoreLimitReached();

    if (!timeUp && !limitHit) return { ended: false };

    this.ended = true;
    this.finalResult = this.buildResult();
    return { ended: true, result: this.finalResult };
  }

  /**
   * Progress toward the score limit. Deliberately measured in KILLS, not in
   * trickshot points: FFA_SCORE_LIMIT is 30 while a single stylish kill is
   * worth over a thousand points, so the limit can only be a kill count.
   * Trickshot points decide the ranking, kills decide when the match is over.
   */
  private scoreLimitReached(): boolean {
    if (this.mode === GameMode.TeamDeathmatch) {
      return this.teamKills[0] >= this.scoreLimit || this.teamKills[1] >= this.scoreLimit;
    }
    for (const rec of this.players.values()) {
      if (rec.kills >= this.scoreLimit) return true;
    }
    return false;
  }

  private entryFor(rec: PlayerRecord): ScoreboardEntry {
    return {
      id: rec.id,
      name: rec.name,
      team: rec.team,
      score: rec.score,
      kills: rec.kills,
      deaths: rec.deaths,
      bestTrickshotScore: rec.bestTrickshotScore,
      bestTrickshotFlags: rec.bestTrickshotFlags,
    };
  }

  /** Sorted: score desc, kills desc, deaths asc, id asc. Stable and total. */
  scoreboard(): ScoreboardEntry[] {
    const rows: ScoreboardEntry[] = [];
    for (const rec of this.players.values()) rows.push(this.entryFor(rec));
    for (let i = 0; i < this.departed.length; i++) rows.push(this.departed[i]);
    rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      return a.id - b.id;
    });
    return rows;
  }

  private buildResult(): MatchOverMsg {
    const board = this.scoreboard();
    let winnerId: PlayerId = board.length > 0 ? board[0].id : 0;
    let winnerTeam: TeamId = TeamId.FFA;

    if (this.mode === GameMode.TeamDeathmatch) {
      if (this.teamKills[0] > this.teamKills[1]) winnerTeam = TeamId.Alpha;
      else if (this.teamKills[1] > this.teamKills[0]) winnerTeam = TeamId.Bravo;
      else winnerTeam = TeamId.None; // draw
      // Best player on the winning side, or overall on a draw.
      const winner =
        winnerTeam === TeamId.None ? board[0] : board.find((e) => e.team === winnerTeam);
      winnerId = winner ? winner.id : 0;
    }

    return {
      scoreboard: board,
      winnerId,
      winnerTeam,
      bestTrickshot: this.best,
    };
  }
}

function cloneVec(v: Vec3 | undefined): Vec3 {
  return v ? vec3(v.x, v.y, v.z) : vec3();
}
