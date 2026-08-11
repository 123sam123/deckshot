/**
 * DECKSHOT rooms — one lobby: roster, match phase machine, scoring host.
 *
 * Owner: lobby-ui-hud.
 *
 * A Lobby owns:
 *   - the member roster (connected players + grace-held disconnected slots),
 *   - host assignment and migration,
 *   - TDM team assignment and auto-balance,
 *   - the round phase machine (Warmup -> Countdown -> Live -> Over -> Warmup),
 *   - a ScoreKeeper (server/src/sim/scoring.ts) per match. Scoring is NEVER
 *     reimplemented here; kills are delegated to it verbatim.
 *
 * All timing flows from the registry clock (ms) passed into methods — no
 * Date.now() — so the whole lifecycle is deterministic under test.
 */

import {
  ErrorCode,
  RECONNECT_GRACE_MS,
  ServerMessage,
} from '../../../shared/protocol.js';
import type {
  AnyServerMessage,
  KillMsg,
  LobbyPlayerInfo,
  LobbyStateMsg,
  RoundStateMsg,
  ScoreboardEntry,
} from '../../../shared/protocol.js';
import {
  COUNTDOWN_TIME,
  FFA_SCORE_LIMIT,
  MATCH_TIME_LIMIT,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  POST_MATCH_TIME,
  TDM_SCORE_LIMIT,
} from '../../../shared/tuning.js';
import {
  MAX_PLAYERS_ZOMBIES,
  MIN_PLAYERS_ZOMBIES,
  ZOMBIES_SCORE_LIMIT,
  ZOMBIES_TIME_LIMIT,
} from '../../../shared/zombies.js';
import {
  AttachmentId,
  DEFAULT_LOADOUT,
  GameMode,
  MAX_ATTACHMENTS,
  RoundPhase,
  TeamId,
} from '../../../shared/types.js';
import type { Loadout, LobbyCode, PlayerId } from '../../../shared/types.js';
import { ScoreKeeper } from '../sim/scoring.js';
import type { TrickshotContext } from '../../../shared/trickshot.js';
import type { Connection, LobbyMember, SessionInfo } from './types.js';

/** LobbyState re-broadcast cadence during Warmup, so pings stay fresh. */
const LOBBY_REFRESH_MS = 2_000;
/** RoundState re-broadcast cadence outside Warmup, so timers stay honest. */
const ROUND_REFRESH_MS = 1_000;
/** Longest name the server will store. */
const NAME_MAX = 16;

function defaultScoreLimit(mode: GameMode): number {
  if (mode === GameMode.Zombies) return ZOMBIES_SCORE_LIMIT;
  return mode === GameMode.TeamDeathmatch ? TDM_SCORE_LIMIT : FFA_SCORE_LIMIT;
}

/** Clamp an arbitrary byte to a real mode. Unknown values fall back to FFA. */
function coerceMode(mode: GameMode): GameMode {
  return mode === GameMode.TeamDeathmatch || mode === GameMode.Zombies
    ? mode
    : GameMode.SnipersOnlyFFA;
}

/** ZOMBIES is a 4-seat co-op squad; the competitive modes keep MAX_PLAYERS. */
export function maxPlayersFor(mode: GameMode): number {
  return mode === GameMode.Zombies ? MAX_PLAYERS_ZOMBIES : MAX_PLAYERS;
}

/** ZOMBIES starts solo. */
export function minPlayersFor(mode: GameMode): number {
  return mode === GameMode.Zombies ? MIN_PLAYERS_ZOMBIES : MIN_PLAYERS_TO_START;
}

/** Strip control characters, trim, clamp length. Empty stays empty. */
export function sanitizeName(raw: string): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  return out.trim().slice(0, NAME_MAX);
}

/** Coerce an arbitrary client loadout into a valid one. Never throws. */
export function sanitizeLoadout(raw: Loadout | undefined): Loadout {
  if (!raw) return { ...DEFAULT_LOADOUT, attachments: [...DEFAULT_LOADOUT.attachments] };
  const atts: AttachmentId[] = [];
  const seen = new Set<AttachmentId>();
  const source = Array.isArray(raw.attachments) ? raw.attachments : [];
  for (const a of source) {
    if (atts.length >= MAX_ATTACHMENTS) break;
    if (typeof a !== 'number' || a === AttachmentId.None) continue;
    if (a < 0 || a > AttachmentId.BallisticCompensator || !Number.isInteger(a)) continue;
    if (seen.has(a)) continue;
    seen.add(a);
    atts.push(a);
  }
  while (atts.length < MAX_ATTACHMENTS) atts.push(AttachmentId.None);
  return {
    primary: typeof raw.primary === 'number' ? raw.primary : DEFAULT_LOADOUT.primary,
    attachments: [atts[0], atts[1], atts[2]],
    camo: typeof raw.camo === 'number' ? raw.camo : DEFAULT_LOADOUT.camo,
    skin: typeof raw.skin === 'number' ? raw.skin : DEFAULT_LOADOUT.skin,
  };
}

export class Lobby {
  readonly code: LobbyCode;
  mode: GameMode;
  scoreLimit: number;
  timeLimit: number;

  phase: RoundPhase = RoundPhase.Warmup;
  hostId: PlayerId = 0;

  /**
   * The scoring authority for the current (or next) match. Recreated fresh
   * on each Countdown -> Live transition so a rematch starts from zero.
   */
  scoreKeeper: ScoreKeeper;

  /** Registry-clock ms at which the lobby went empty, or -1 while occupied. */
  emptySince = -1;

  private members = new Map<PlayerId, LobbyMember>();
  private nextPlayerId = 1;
  private phaseEndsAt = 0;
  private lastLobbyBroadcast = 0;
  private lastRoundBroadcast = 0;
  /** Registry clock at the most recent tick; endMatch anchors timers to it. */
  private lastTickNow = 0;

  constructor(code: LobbyCode, mode: GameMode, scoreLimit: number, timeLimit: number) {
    this.code = code;
    this.mode = coerceMode(mode);
    if (this.mode === GameMode.Zombies) {
      // Kills and clocks must never end a ZOMBIES match — only the wipe does.
      this.scoreLimit = ZOMBIES_SCORE_LIMIT;
      this.timeLimit = ZOMBIES_TIME_LIMIT;
    } else {
      this.scoreLimit =
        Number.isFinite(scoreLimit) && scoreLimit > 0
          ? Math.floor(scoreLimit)
          : defaultScoreLimit(this.mode);
      this.timeLimit =
        Number.isFinite(timeLimit) && timeLimit > 0 ? Math.floor(timeLimit) : MATCH_TIME_LIMIT;
    }
    this.scoreKeeper = new ScoreKeeper(this.mode, this.scoreLimit, this.timeLimit);
  }

  // -------------------------------------------------------------------------
  // Roster queries
  // -------------------------------------------------------------------------

  /** All slots, including grace-held disconnected ones. */
  membersList(): LobbyMember[] {
    return [...this.members.values()];
  }

  memberByPlayerId(id: PlayerId): LobbyMember | undefined {
    return this.members.get(id);
  }

  memberByConnection(conn: Connection): LobbyMember | undefined {
    for (const m of this.members.values()) {
      if (m.conn && m.conn.id === conn.id) return m;
    }
    return undefined;
  }

  /** Occupied slots — connected or held for reconnect. Capacity counts these. */
  slotCount(): number {
    return this.members.size;
  }

  connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.conn) n++;
    return n;
  }

  hasSpace(): boolean {
    return this.members.size < maxPlayersFor(this.mode);
  }

  get inProgress(): boolean {
    return this.phase === RoundPhase.Countdown || this.phase === RoundPhase.Live;
  }

  /** Welcome-frame ingredients for the netcode layer. */
  sessionFor(conn: Connection): SessionInfo | null {
    const m = this.memberByConnection(conn);
    if (!m) return null;
    return {
      playerId: m.playerId,
      resumeToken: m.resumeToken,
      name: m.name,
      team: m.team,
      isHost: m.playerId === this.hostId,
    };
  }

  // -------------------------------------------------------------------------
  // Roster mutation (called by the registry, which owns token bookkeeping)
  // -------------------------------------------------------------------------

  /** Add a connected member. Caller must have verified capacity. */
  addMember(conn: Connection, name: string, resumeToken: string, now: number): LobbyMember {
    const playerId = this.allocatePlayerId();
    const member: LobbyMember = {
      playerId,
      conn,
      name: sanitizeName(name) || `Recruit-${playerId}`,
      team: this.assignTeam(),
      ready: false,
      ping: 0,
      loadout: sanitizeLoadout(undefined),
      joinedAt: now,
      resumeToken,
      disconnectedAt: -1,
    };
    this.members.set(playerId, member);
    if (this.hostId === 0) this.hostId = playerId;
    this.emptySince = -1;

    // Late join: the match is running, so the newcomer scores from now.
    this.scoreKeeper.addPlayer(playerId, member.team);
    this.scoreKeeper.setName(playerId, member.name);
    return member;
  }

  /** Remove a member outright (explicit leave or expired grace). */
  removeMember(playerId: PlayerId): LobbyMember | undefined {
    const m = this.members.get(playerId);
    if (!m) return undefined;
    this.members.delete(playerId);
    this.scoreKeeper.removePlayer(playerId);
    this.ensureHost();
    return m;
  }

  /** Socket dropped: hold the slot for RECONNECT_GRACE_MS. */
  markDisconnected(playerId: PlayerId, now: number): void {
    const m = this.members.get(playerId);
    if (!m) return;
    m.conn = null;
    m.ready = false;
    m.disconnectedAt = now;
    // The match must not stall on an absent host — migrate immediately.
    this.ensureHost();
  }

  /** Reattach a returning player. Caller has validated the token and grace. */
  reattach(playerId: PlayerId, conn: Connection): LobbyMember | undefined {
    const m = this.members.get(playerId);
    if (!m) return undefined;
    m.conn = conn;
    m.disconnectedAt = -1;
    this.emptySince = -1;
    if (this.hostId === 0) this.ensureHost();
    return m;
  }

  /** Grace-expired disconnected members, given the current time. */
  expiredMembers(now: number): LobbyMember[] {
    const out: LobbyMember[] = [];
    for (const m of this.members.values()) {
      if (!m.conn && m.disconnectedAt >= 0 && now - m.disconnectedAt >= RECONNECT_GRACE_MS) {
        out.push(m);
      }
    }
    return out;
  }

  /**
   * Host migration: the longest-connected remaining player (earliest join,
   * ties by lowest id) becomes host. The match continues uninterrupted —
   * nothing in the phase machine references the host.
   */
  ensureHost(): void {
    const current = this.members.get(this.hostId);
    if (current && current.conn) return;
    let best: LobbyMember | undefined;
    for (const m of this.members.values()) {
      if (!m.conn) continue;
      if (
        !best ||
        m.joinedAt < best.joinedAt ||
        (m.joinedAt === best.joinedAt && m.playerId < best.playerId)
      ) {
        best = m;
      }
    }
    this.hostId = best ? best.playerId : 0;
  }

  private allocatePlayerId(): PlayerId {
    // u8 on the wire, 0 reserved, and ids >= ZOMBIE_ID_BASE (200) belong to
    // ZOMBIES's horde — players stay in 1..199 in every mode so the client's
    // id-range partition is unambiguous.
    for (let i = 0; i < 199; i++) {
      const candidate = ((this.nextPlayerId - 1 + i) % 199) + 1;
      if (!this.members.has(candidate)) {
        this.nextPlayerId = (candidate % 199) + 1;
        return candidate;
      }
    }
    throw new Error('lobby out of player ids'); // unreachable below MAX_PLAYERS
  }

  private assignTeam(): TeamId {
    // ZOMBIES: the whole squad is Alpha; the horde is Bravo. The frozen
    // TeamId enum is reused, never extended.
    if (this.mode === GameMode.Zombies) return TeamId.Alpha;
    if (this.mode !== GameMode.TeamDeathmatch) return TeamId.FFA;
    let alpha = 0;
    let bravo = 0;
    for (const m of this.members.values()) {
      if (m.team === TeamId.Alpha) alpha++;
      else if (m.team === TeamId.Bravo) bravo++;
    }
    return alpha <= bravo ? TeamId.Alpha : TeamId.Bravo;
  }

  /**
   * TDM auto-balance, Warmup only — nobody gets team-swapped mid-match.
   * Moves the newest joiner from the larger side until sizes differ by <= 1.
   */
  autoBalance(): boolean {
    if (this.mode !== GameMode.TeamDeathmatch || this.phase !== RoundPhase.Warmup) return false;
    let changed = false;
    for (;;) {
      const alpha: LobbyMember[] = [];
      const bravo: LobbyMember[] = [];
      for (const m of this.members.values()) {
        if (m.team === TeamId.Alpha) alpha.push(m);
        else if (m.team === TeamId.Bravo) bravo.push(m);
      }
      if (Math.abs(alpha.length - bravo.length) <= 1) return changed;
      const from = alpha.length > bravo.length ? alpha : bravo;
      const to = alpha.length > bravo.length ? TeamId.Bravo : TeamId.Alpha;
      from.sort((a, b) => b.joinedAt - a.joinedAt || b.playerId - a.playerId);
      from[0].team = to;
      this.scoreKeeper.setTeam(from[0].playerId, to);
      changed = true;
    }
  }

  /** Reassign every member's team to fit the (possibly new) mode. */
  reassignTeams(): void {
    if (this.mode !== GameMode.TeamDeathmatch) {
      const team = this.mode === GameMode.Zombies ? TeamId.Alpha : TeamId.FFA;
      for (const m of this.members.values()) {
        m.team = team;
        this.scoreKeeper.setTeam(m.playerId, team);
      }
      return;
    }
    let flip = 0;
    const sorted = [...this.members.values()].sort(
      (a, b) => a.joinedAt - b.joinedAt || a.playerId - b.playerId,
    );
    for (const m of sorted) {
      m.team = flip % 2 === 0 ? TeamId.Alpha : TeamId.Bravo;
      this.scoreKeeper.setTeam(m.playerId, m.team);
      flip++;
    }
  }

  // -------------------------------------------------------------------------
  // Config / state edits
  // -------------------------------------------------------------------------

  /** Host-only config change. Returns false when `by` is not the host. */
  setMatchConfig(by: PlayerId, mode: GameMode, scoreLimit: number, timeLimit: number): boolean {
    if (by !== this.hostId) return false;
    const nextMode = coerceMode(mode);
    // A 6+ player lobby cannot become a 4-seat ZOMBIES squad.
    if (nextMode === GameMode.Zombies && this.members.size > MAX_PLAYERS_ZOMBIES) return false;
    const modeChanged = nextMode !== this.mode;
    this.mode = nextMode;
    if (this.mode === GameMode.Zombies) {
      this.scoreLimit = ZOMBIES_SCORE_LIMIT;
      this.timeLimit = ZOMBIES_TIME_LIMIT;
    } else {
      this.scoreLimit =
        Number.isFinite(scoreLimit) && scoreLimit > 0
          ? Math.floor(scoreLimit)
          : defaultScoreLimit(this.mode);
      this.timeLimit =
        Number.isFinite(timeLimit) && timeLimit > 0 ? Math.floor(timeLimit) : MATCH_TIME_LIMIT;
    }
    if (modeChanged) this.reassignTeams();
    return true;
  }

  setReady(playerId: PlayerId, ready: boolean): void {
    const m = this.members.get(playerId);
    if (m) m.ready = !!ready;
  }

  setLoadout(playerId: PlayerId, loadout: Loadout): void {
    const m = this.members.get(playerId);
    // Applies on next respawn: the sim reads member.loadout at spawn time.
    if (m) m.loadout = sanitizeLoadout(loadout);
  }

  setName(playerId: PlayerId, name: string): void {
    const m = this.members.get(playerId);
    if (!m) return;
    const clean = sanitizeName(name);
    if (!clean) return;
    m.name = clean;
    this.scoreKeeper.setName(playerId, clean);
  }

  setPing(playerId: PlayerId, ping: number): void {
    const m = this.members.get(playerId);
    if (m && Number.isFinite(ping)) m.ping = Math.max(0, Math.min(999, Math.round(ping)));
  }

  // -------------------------------------------------------------------------
  // Scoring passthrough (the sim calls these; ScoreKeeper stays authoritative)
  // -------------------------------------------------------------------------

  /** One bullet, one call — see ScoreKeeper.onKill. Broadcasts the KillMsg. */
  registerKill(
    killerId: PlayerId,
    victimId: PlayerId,
    partial: Partial<TrickshotContext>,
  ): KillMsg {
    const msg = this.scoreKeeper.onKill(killerId, victimId, partial);
    this.broadcast({ type: ServerMessage.Kill, data: msg });
    return msg;
  }

  recordYaw(id: PlayerId, tSeconds: number, yaw: number, onGround: boolean): void {
    this.scoreKeeper.recordYaw(id, tSeconds, yaw, onGround);
  }

  /**
   * ZOMBIES squad wipe (ScoringSink.endMatch): the sim says the match is
   * over. Uses the same Over -> Warmup path a score-limit finish takes.
   */
  endMatch(): void {
    if (this.phase !== RoundPhase.Live) return;
    const now = this.lastTickNow;
    this.phase = RoundPhase.Over;
    this.phaseEndsAt = now + POST_MATCH_TIME * 1000;
    const board = this.scoreKeeper.scoreboard();
    this.broadcast({
      type: ServerMessage.MatchOver,
      data: {
        scoreboard: board,
        winnerId: board.length > 0 ? board[0].id : 0,
        winnerTeam: TeamId.Alpha,
        bestTrickshot: this.scoreKeeper.bestTrickshot(),
      },
    });
    this.broadcastRoundState(now);
  }

  scoreboard(): ScoreboardEntry[] {
    return this.scoreKeeper.scoreboard();
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  broadcast(msg: AnyServerMessage): void {
    for (const m of this.members.values()) {
      if (!m.conn) continue;
      try {
        m.conn.send(msg);
      } catch {
        /* a broken socket must not take the lobby down; netcode reports it */
      }
    }
  }

  buildLobbyState(): LobbyStateMsg {
    const players: LobbyPlayerInfo[] = [];
    for (const m of this.members.values()) {
      players.push({
        id: m.playerId,
        name: m.name,
        team: m.team,
        ready: m.ready,
        isHost: m.playerId === this.hostId,
        // A grace-held slot shows the sentinel ping so the UI can grey it out.
        ping: m.conn ? m.ping : 999,
        loadout: m.loadout,
      });
    }
    players.sort((a, b) => a.id - b.id);
    return {
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      scoreLimit: this.scoreLimit,
      timeLimit: this.timeLimit,
      players,
      inProgress: this.inProgress,
    };
  }

  buildRoundState(now: number): RoundStateMsg {
    let timeRemaining = 0;
    switch (this.phase) {
      case RoundPhase.Countdown:
      case RoundPhase.Over:
        timeRemaining = Math.max(0, (this.phaseEndsAt - now) / 1000);
        break;
      case RoundPhase.Live:
        timeRemaining = this.scoreKeeper.timeRemaining();
        break;
      default:
        timeRemaining = 0;
    }
    return {
      phase: this.phase,
      timeRemaining,
      scoreLimit: this.scoreLimit,
      teamScores: this.scoreKeeper.teamScores(),
    };
  }

  broadcastLobbyState(now: number): void {
    this.lastLobbyBroadcast = now;
    this.broadcast({ type: ServerMessage.LobbyState, data: this.buildLobbyState() });
  }

  broadcastRoundState(now: number): void {
    this.lastRoundBroadcast = now;
    this.broadcast({ type: ServerMessage.RoundState, data: this.buildRoundState(now) });
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------

  /** Drive phases. Called from the registry tick at TICK_RATE. */
  tick(now: number): void {
    this.lastTickNow = now;
    switch (this.phase) {
      case RoundPhase.Warmup: {
        if (this.readyToStart()) {
          this.phase = RoundPhase.Countdown;
          this.phaseEndsAt = now + COUNTDOWN_TIME * 1000;
          this.broadcastRoundState(now);
          this.broadcastLobbyState(now); // inProgress flipped
        } else if (now - this.lastLobbyBroadcast >= LOBBY_REFRESH_MS) {
          this.broadcastLobbyState(now); // keep pings fresh on the roster
        }
        break;
      }
      case RoundPhase.Countdown: {
        if (!this.readyToStart()) {
          // Someone left or un-readied — abort back to Warmup, loudly.
          this.phase = RoundPhase.Warmup;
          this.broadcastRoundState(now);
          this.broadcastLobbyState(now);
          break;
        }
        if (now >= this.phaseEndsAt) {
          this.startMatch(now);
        } else if (now - this.lastRoundBroadcast >= ROUND_REFRESH_MS) {
          this.broadcastRoundState(now);
        }
        break;
      }
      case RoundPhase.Live: {
        const result = this.scoreKeeper.tick(now / 1000);
        if (result.ended) {
          this.phase = RoundPhase.Over;
          this.phaseEndsAt = now + POST_MATCH_TIME * 1000;
          const over = result.result ?? {
            scoreboard: this.scoreKeeper.scoreboard(),
            winnerId: 0,
            winnerTeam: TeamId.None,
            bestTrickshot: this.scoreKeeper.bestTrickshot(),
          };
          this.broadcast({ type: ServerMessage.MatchOver, data: over });
          this.broadcastRoundState(now);
        } else if (now - this.lastRoundBroadcast >= ROUND_REFRESH_MS) {
          this.broadcastRoundState(now);
        }
        break;
      }
      case RoundPhase.Over: {
        if (now >= this.phaseEndsAt) {
          this.phase = RoundPhase.Warmup;
          for (const m of this.members.values()) m.ready = false;
          this.broadcastRoundState(now);
          this.broadcastLobbyState(now);
        } else if (now - this.lastRoundBroadcast >= ROUND_REFRESH_MS) {
          this.broadcastRoundState(now);
        }
        break;
      }
    }
  }

  private readyToStart(): boolean {
    let connected = 0;
    for (const m of this.members.values()) {
      if (!m.conn) continue;
      connected++;
      if (!m.ready) return false;
    }
    return connected >= minPlayersFor(this.mode);
  }

  private startMatch(now: number): void {
    this.phase = RoundPhase.Live;
    this.autoBalanceForStart();
    this.scoreKeeper = new ScoreKeeper(this.mode, this.scoreLimit, this.timeLimit);
    for (const m of this.members.values()) {
      this.scoreKeeper.addPlayer(m.playerId, m.team);
      this.scoreKeeper.setName(m.playerId, m.name);
    }
    this.scoreKeeper.startMatch(now / 1000);
    this.broadcastRoundState(now);
    this.broadcastLobbyState(now);
  }

  /** Balance is allowed one final pass at the moment the match locks in. */
  private autoBalanceForStart(): void {
    if (this.mode !== GameMode.TeamDeathmatch) return;
    const wasPhase = this.phase;
    this.phase = RoundPhase.Warmup; // autoBalance only runs in Warmup
    this.autoBalance();
    this.phase = wasPhase;
  }
}
