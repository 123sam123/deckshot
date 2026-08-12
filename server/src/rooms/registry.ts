/**
 * DECKSHOT rooms — the lobby registry.
 *
 * Owner: lobby-ui-hud.
 *
 * The single entry point the netcode layer drives:
 *
 *   const registry = new LobbyRegistry();
 *   registry.create(conn, cfg, name)   // CreateLobby
 *   registry.join(conn, code, name)    // JoinLobby
 *   registry.quickPlay(conn, name)     // QuickPlay
 *   registry.resume(conn, token)       // Hello with a resumeToken
 *   registry.leave(conn)               // explicit LeaveLobby — slot freed now
 *   registry.disconnect(conn)          // socket dropped — slot held 30s
 *   registry.tick(nowMs)               // at TICK_RATE from the server loop
 *
 * ERROR CONTRACT: on any failure the registry has ALREADY sent the Error
 * frame to the connection (never fail silently) and returns the ErrorCode so
 * the caller can react. Do not send a second Error for the same result.
 *
 * On success the registry has already broadcast LobbyState to the lobby
 * (including the newcomer). The caller still owes the newcomer a Welcome —
 * build it from `registry.sessionFor(conn)` (playerId + resumeToken).
 */

import {
  ErrorCode,
  LOBBY_EMPTY_TTL_MS,
  RECONNECT_GRACE_MS,
  ServerMessage,
} from '../../../shared/protocol.js';
import type { CreateLobbyMsg, SetMatchConfigMsg } from '../../../shared/protocol.js';
import { FFA_SCORE_LIMIT, MATCH_TIME_LIMIT } from '../../../shared/tuning.js';
import { GameMode } from '../../../shared/types.js';
import type { Loadout, LobbyCode, PlayerId } from '../../../shared/types.js';
import { generateCode, generateResumeToken, normalizeCode } from './codes.js';
import { Lobby } from './lobby.js';
import { CHAT_RULE, CREATE_RULE, JOIN_RULE, SlidingWindowLimiter } from './ratelimit.js';
import type { Connection, SessionInfo } from './types.js';

/** Hard cap on simultaneous lobbies; far below the 32^4 code space. */
export const MAX_LOBBIES = 512;

interface TokenRecord {
  code: LobbyCode;
  playerId: PlayerId;
}

export class LobbyRegistry {
  private lobbies = new Map<LobbyCode, Lobby>();
  /** conn.id -> lobby code, for O(1) lookup of a connection's lobby. */
  private byConn = new Map<number, LobbyCode>();
  /** resumeToken -> slot. Tokens are bearer credentials; never log them. */
  private tokens = new Map<string, TokenRecord>();

  private createLimiter = new SlidingWindowLimiter(CREATE_RULE);
  private joinLimiter = new SlidingWindowLimiter(JOIN_RULE);
  private chatLimiter = new SlidingWindowLimiter(CHAT_RULE);

  /** Registry clock, ms. Advanced only by tick() — deterministic under test. */
  private now = 0;

  // -------------------------------------------------------------------------
  // Lifecycle entry points
  // -------------------------------------------------------------------------

  create(hostConn: Connection, cfg: CreateLobbyMsg, name = ''): Lobby | ErrorCode {
    this.leave(hostConn); // a connection occupies at most one lobby
    if (!this.createLimiter.allow(hostConn.remoteAddress, this.now)) {
      return this.fail(hostConn, ErrorCode.RateLimited, 'Slow down — too many lobbies created.');
    }
    if (this.lobbies.size >= MAX_LOBBIES) {
      return this.fail(hostConn, ErrorCode.Unknown, 'Server is at lobby capacity. Try Quick Play.');
    }
    return this.createInternal(hostConn, cfg, name);
  }

  join(conn: Connection, code: LobbyCode, name = ''): Lobby | ErrorCode {
    this.leave(conn);
    if (!this.joinLimiter.allow(conn.remoteAddress, this.now)) {
      return this.fail(conn, ErrorCode.RateLimited, 'Slow down — too many join attempts.');
    }
    const normalized = normalizeCode(code);
    if (!normalized) {
      return this.fail(conn, ErrorCode.LobbyNotFound, `No lobby with code "${String(code)}".`);
    }
    const lobby = this.lobbies.get(normalized);
    if (!lobby) {
      return this.fail(conn, ErrorCode.LobbyNotFound, `No lobby with code "${normalized}".`);
    }
    return this.joinInternal(conn, lobby, name);
  }

  quickPlay(conn: Connection, name = ''): Lobby | ErrorCode {
    this.leave(conn);
    if (!this.joinLimiter.allow(conn.remoteAddress, this.now)) {
      return this.fail(conn, ErrorCode.RateLimited, 'Slow down — too many join attempts.');
    }
    // Fill matches rather than scattering people: the fullest joinable lobby.
    // SURVIVAL lobbies are excluded — a co-op squad is something you join on
    // purpose with a code, not something quick-play drops a stranger into.
    let best: Lobby | undefined;
    for (const lobby of this.lobbies.values()) {
      if (lobby.mode === GameMode.Survival) continue;
      if (!lobby.hasSpace()) continue;
      if (!best || lobby.slotCount() > best.slotCount()) best = lobby;
    }
    if (best) return this.joinInternal(conn, best, name);
    if (this.lobbies.size >= MAX_LOBBIES) {
      return this.fail(conn, ErrorCode.NoLobbiesAvailable, 'No open lobbies and none can be made.');
    }
    return this.createInternal(
      conn,
      { mode: GameMode.SnipersOnlyFFA, scoreLimit: FFA_SCORE_LIMIT },
      name,
    );
  }

  /**
   * Reconnect with a resume token from a previous Welcome. Within
   * RECONNECT_GRACE_MS this restores the same PlayerId — and, because the
   * slot never left the ScoreKeeper, the same score/kills/deaths/streak.
   */
  resume(conn: Connection, token: string): Lobby | ErrorCode {
    this.leave(conn);
    if (!this.joinLimiter.allow(conn.remoteAddress, this.now)) {
      return this.fail(conn, ErrorCode.RateLimited, 'Slow down — too many join attempts.');
    }
    const rec = typeof token === 'string' && token ? this.tokens.get(token) : undefined;
    const lobby = rec ? this.lobbies.get(rec.code) : undefined;
    const member = rec && lobby ? lobby.memberByPlayerId(rec.playerId) : undefined;
    const inGrace =
      member &&
      !member.conn &&
      member.disconnectedAt >= 0 &&
      this.now - member.disconnectedAt < RECONNECT_GRACE_MS;
    if (!rec || !lobby || !member || !inGrace) {
      if (rec) this.tokens.delete(token); // one strike: a dead token stays dead
      return this.fail(conn, ErrorCode.LobbyNotFound, 'Session expired — join again.');
    }
    lobby.reattach(member.playerId, conn);
    this.byConn.set(conn.id, lobby.code);
    lobby.broadcastLobbyState(this.now);
    lobby.broadcastRoundState(this.now);
    return lobby;
  }

  /** Explicit leave: the slot frees immediately, no reconnect grace. */
  leave(conn: Connection): void {
    const code = this.byConn.get(conn.id);
    if (!code) return;
    this.byConn.delete(conn.id);
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    const member = lobby.memberByConnection(conn);
    if (!member) return;
    lobby.removeMember(member.playerId);
    this.tokens.delete(member.resumeToken);
    lobby.autoBalance();
    if (lobby.connectedCount() === 0 && lobby.emptySince < 0) lobby.emptySince = this.now;
    lobby.broadcastLobbyState(this.now);
  }

  /** Socket dropped without a LeaveLobby: hold the slot for the grace window. */
  disconnect(conn: Connection): void {
    const code = this.byConn.get(conn.id);
    if (!code) return;
    this.byConn.delete(conn.id);
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    const member = lobby.memberByConnection(conn);
    if (!member) return;
    lobby.markDisconnected(member.playerId, this.now);
    if (lobby.connectedCount() === 0 && lobby.emptySince < 0) lobby.emptySince = this.now;
    lobby.broadcastLobbyState(this.now);
  }

  /**
   * Advance the registry clock and everything that depends on it: reconnect
   * graces, phase machines, empty-lobby TTLs, rate-limit windows. Called at
   * TICK_RATE by the server loop with a monotonic ms timestamp.
   */
  tick(nowMs: number): void {
    if (Number.isFinite(nowMs) && nowMs > this.now) this.now = nowMs;
    const now = this.now;

    for (const [code, lobby] of this.lobbies) {
      // Expire grace-held slots. Their tokens die with them.
      const expired = lobby.expiredMembers(now);
      for (const m of expired) {
        lobby.removeMember(m.playerId);
        this.tokens.delete(m.resumeToken);
      }
      if (expired.length > 0) {
        lobby.autoBalance();
        lobby.broadcastLobbyState(now);
      }

      lobby.tick(now);

      // Reclaim lobbies that have been empty past the TTL.
      if (lobby.connectedCount() === 0) {
        if (lobby.emptySince < 0) lobby.emptySince = now;
        if (now - lobby.emptySince >= LOBBY_EMPTY_TTL_MS) {
          for (const m of lobby.membersList()) this.tokens.delete(m.resumeToken);
          this.lobbies.delete(code);
        }
      } else {
        lobby.emptySince = -1;
      }
    }

    this.createLimiter.prune(now);
    this.joinLimiter.prune(now);
    this.chatLimiter.prune(now);
  }

  // -------------------------------------------------------------------------
  // Per-player actions relayed by the netcode dispatch
  // -------------------------------------------------------------------------

  setReady(conn: Connection, ready: boolean): void {
    const found = this.find(conn);
    if (!found) return;
    found.lobby.setReady(found.playerId, ready);
    found.lobby.broadcastLobbyState(this.now);
  }

  setLoadout(conn: Connection, loadout: Loadout): void {
    const found = this.find(conn);
    if (!found) return;
    found.lobby.setLoadout(found.playerId, loadout);
    found.lobby.broadcastLobbyState(this.now);
  }

  setName(conn: Connection, name: string): void {
    const found = this.find(conn);
    if (!found) return;
    found.lobby.setName(found.playerId, name);
    found.lobby.broadcastLobbyState(this.now);
  }

  setPing(conn: Connection, ping: number): void {
    const found = this.find(conn);
    if (found) found.lobby.setPing(found.playerId, ping);
  }

  setMatchConfig(conn: Connection, cfg: SetMatchConfigMsg): ErrorCode | null {
    const found = this.find(conn);
    if (!found) return this.fail(conn, ErrorCode.Unknown, 'You are not in a lobby.');
    const ok = found.lobby.setMatchConfig(
      found.playerId,
      cfg.mode,
      cfg.scoreLimit,
      cfg.timeLimit,
      cfg.mapId
    );
    if (!ok) return this.fail(conn, ErrorCode.NotHost, 'Only the host can change match settings.');
    found.lobby.autoBalance();
    found.lobby.broadcastLobbyState(this.now);
    return null;
  }

  chat(conn: Connection, text: string): void {
    const found = this.find(conn);
    if (!found) return;
    if (!this.chatLimiter.allow(conn.remoteAddress, this.now)) {
      this.fail(conn, ErrorCode.RateLimited, 'Chat rate limit.');
      return;
    }
    const clean = typeof text === 'string' ? text.trim().slice(0, 120) : '';
    if (!clean) return;
    found.lobby.broadcast({
      type: ServerMessage.Chat,
      data: { playerId: found.playerId, text: clean },
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  lobbyFor(conn: Connection): Lobby | undefined {
    const code = this.byConn.get(conn.id);
    return code ? this.lobbies.get(code) : undefined;
  }

  lobbyByCode(code: string): Lobby | undefined {
    const normalized = normalizeCode(code);
    return normalized ? this.lobbies.get(normalized) : undefined;
  }

  /** Welcome-frame ingredients for a connection that just joined/resumed. */
  sessionFor(conn: Connection): SessionInfo | null {
    const lobby = this.lobbyFor(conn);
    return lobby ? lobby.sessionFor(conn) : null;
  }

  lobbyCount(): number {
    return this.lobbies.size;
  }

  allLobbies(): Lobby[] {
    return [...this.lobbies.values()];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private createInternal(hostConn: Connection, cfg: CreateLobbyMsg, name: string): Lobby {
    const code = generateCode((c) => this.lobbies.has(c));
    const lobby = new Lobby(
      code,
      cfg?.mode ?? GameMode.SnipersOnlyFFA,
      cfg?.scoreLimit ?? 0,
      MATCH_TIME_LIMIT,
      cfg?.mapId,
    );
    this.lobbies.set(code, lobby);
    this.admit(hostConn, lobby, name);
    return lobby;
  }

  private joinInternal(conn: Connection, lobby: Lobby, name: string): Lobby | ErrorCode {
    if (!lobby.hasSpace()) {
      // Capacity counts grace-held slots: a reconnecting player's seat is
      // genuinely reserved, so the 13th body is refused (MAX_PLAYERS = 12).
      return this.fail(conn, ErrorCode.LobbyFull, `Lobby ${lobby.code} is full.`);
    }
    this.admit(conn, lobby, name);
    return lobby;
  }

  private admit(conn: Connection, lobby: Lobby, name: string): void {
    const token = generateResumeToken();
    const member = lobby.addMember(conn, name, token, this.now);
    this.byConn.set(conn.id, lobby.code);
    this.tokens.set(token, { code: lobby.code, playerId: member.playerId });
    lobby.autoBalance();
    lobby.broadcastLobbyState(this.now);
    // Late join: hand the newcomer the running match clock immediately.
    if (lobby.phase !== 0) lobby.broadcastRoundState(this.now);
  }

  private fail(conn: Connection, code: ErrorCode, message: string): ErrorCode {
    try {
      conn.send({ type: ServerMessage.Error, data: { code, message } });
    } catch {
      /* the socket may already be gone; the return value still reports it */
    }
    return code;
  }

  private find(conn: Connection): { lobby: Lobby; playerId: PlayerId } | null {
    const lobby = this.lobbyFor(conn);
    if (!lobby) return null;
    const member = lobby.memberByConnection(conn);
    return member ? { lobby, playerId: member.playerId } : null;
  }
}
