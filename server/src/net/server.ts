/**
 * DECKSHOT — the game server.
 *
 * Owner: netcode-core.
 *
 * `createGameServer` ATTACHES to an existing Node HTTP server rather than
 * creating its own. That is the whole reason the game can be one link: the
 * orchestrator's `server/src/index.ts` serves the built client from `/` and
 * mounts this on `/ws` of the same listener, so there is exactly one port, one
 * origin, no CORS, no second hostname, and no socket URL to configure in the
 * client. `ws(s)://<same host>/ws` always works, including behind a
 * TLS-terminating proxy.
 *
 * DIVISION OF LABOUR, because there are three modules in this loop:
 *
 *   `LobbyRegistry` (lobby-ui-hud) owns membership, codes, host migration,
 *   reconnect, the ScoreKeeper and the round phase. It sends its own Error and
 *   LobbyState frames — this file must never duplicate them.
 *
 *   `GameRoom` (this directory) owns the simulation: movement, weapons, lag
 *   compensation, combat, snapshots, spawns and respawns. It reads its roster
 *   from the Lobby every tick and pushes kills back into it.
 *
 *   `WsConnection` (this directory) owns the bytes and nothing else.
 *
 * One `FixedLoop` per lobby drives the simulation; one more drives the
 * registry's own clock, which is what expires reconnect grace and empty
 * lobbies.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  ClientMessage,
  ErrorCode,
  PROTOCOL_VERSION,
  ServerMessage,
  type AnyClientMessage,
} from '../../../shared/protocol.js';
import { DEFAULT_LOADOUT, type LobbyCode, type PlayerId } from '../../../shared/types.js';
import { MAX_PLAYERS, SNAPSHOT_RATE, TICK_RATE } from '../../../shared/tuning.js';
import { LobbyRegistry } from '../rooms/registry.js';
import type { Lobby } from '../rooms/lobby.js';
import { WsConnection, type ConnectionHandler, type RateLimits, type SocketLike } from './connection.js';
import { FixedLoop, monotonicNow } from './loop.js';
import { GameRoom } from './room.js';
import type { SimHooks } from './hooks.js';

/** Used when `server/src/index.ts` does not pass one. */
export const DEFAULT_PORT = 8080;

/** The single WebSocket endpoint. Hard-coded on purpose: it is a contract. */
export const WS_PATH = '/ws';

export interface GameServerOptions {
  /** Path to accept upgrades on. Defaults to `/ws`. */
  path?: string;
  /** Share a registry with the rest of the process. One is made if omitted. */
  registry?: LobbyRegistry;
  /** Weapons and combat. Defaults to the real modules; injectable for tests. */
  hooks?: SimHooks;
  /** Per-connection rate limits. */
  limits?: Partial<RateLimits>;
  /** Reject clients whose Hello version is not PROTOCOL_VERSION. Default true. */
  strictVersion?: boolean;
  /** Injectable clock, in ms. */
  now?: () => number;
  /** Start the simulation loops. Default true; tests drive ticks by hand. */
  autoStart?: boolean;
}

interface Session {
  conn: WsConnection;
  name: string;
  /** The lobby this connection is in, or null before create/join/quickPlay. */
  code: LobbyCode | null;
  playerId: PlayerId;
}

export interface GameServer {
  readonly registry: LobbyRegistry;
  /** Attaches a socket directly. Used by tests and alternative transports. */
  handleSocket(socket: SocketLike, remoteAddress?: string): WsConnection;
  roomFor(code: LobbyCode): GameRoom | undefined;
  rooms(): IterableIterator<[LobbyCode, GameRoom]>;
  /** Advances every loop to `nowMs`. Only meaningful with autoStart: false. */
  advanceTo(nowMs: number): void;
  stats(): {
    connections: number;
    lobbies: number;
    players: number;
    tickRate: number;
    snapshotRate: number;
  };
  close(): Promise<void>;
}

export function createGameServer(httpServer: HttpServer, opts: GameServerOptions = {}): GameServer {
  const path = opts.path ?? WS_PATH;
  const clock = opts.now ?? monotonicNow;
  const registry = opts.registry ?? new LobbyRegistry();
  const strictVersion = opts.strictVersion !== false;
  const autoStart = opts.autoStart !== false;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const sessions = new Map<number, Session>();
  const rooms = new Map<LobbyCode, { room: GameRoom; loop: FixedLoop; lobby: Lobby }>();

  // -------------------------------------------------------------------------
  // Rooms follow lobbies
  // -------------------------------------------------------------------------

  function ensureRoom(lobby: Lobby): GameRoom {
    const existing = rooms.get(lobby.code);
    // A host switching the lobby's mode (FFA <-> ZOMBIES) changes the map,
    // the roster rules and the whole simulation shape: rebuild the room.
    if (existing && existing.room.mode !== lobby.mode) closeRoom(lobby.code);
    else if (existing) return existing.room;

    const room = new GameRoom({
      code: lobby.code,
      mode: lobby.mode,
      scoreLimit: lobby.scoreLimit,
      timeLimit: lobby.timeLimit,
      hooks: opts.hooks,
      // The Lobby owns the ScoreKeeper and the phase machine.
      scoring: lobby,
    });

    const loop = new FixedLoop(
      (tick, nowMs) => {
        syncRoster(lobby, room);
        room.tick(tick, nowMs);
        pushPings(lobby, room);
      },
      {
        hz: TICK_RATE,
        now: clock,
        onStall: (skippedMs) => {
          console.warn(`[deckshot] lobby ${lobby.code} stalled, skipped ${Math.round(skippedMs)}ms`);
        },
      }
    );
    if (autoStart) loop.start();
    rooms.set(lobby.code, { room, loop, lobby });
    return room;
  }

  /**
   * Mirrors the lobby roster into the simulation.
   *
   * Pull, not push: the registry has four ways for membership to change (join,
   * leave, disconnect, grace expiry) and subscribing to all of them is four
   * chances to leak a player who exists in one structure and not the other. A
   * twelve-entry reconciliation at 60 Hz costs nothing and cannot drift.
   */
  function syncRoster(lobby: Lobby, room: GameRoom): void {
    const members = lobby.membersList();
    const live = new Set<PlayerId>();

    for (const m of members) {
      live.add(m.playerId);
      const existing = room.get(m.playerId);
      if (!existing) {
        room.addPlayer({
          id: m.playerId,
          name: m.name,
          team: m.team,
          loadout: m.loadout ?? DEFAULT_LOADOUT,
          conn: m.conn,
        });
        continue;
      }
      if (existing.conn !== m.conn) room.setConnection(m.playerId, m.conn);
      if (existing.state.name !== m.name) room.setName(m.playerId, m.name);
      if (existing.state.team !== m.team) room.setTeam(m.playerId, m.team);
      if (existing.state.loadout !== m.loadout) room.setLoadout(m.playerId, m.loadout);
    }

    for (const p of Array.from(room.list())) {
      if (!live.has(p.id)) room.removePlayer(p.id);
    }
  }

  /** The server measures RTT; the lobby roster displays it. */
  function pushPings(lobby: Lobby, room: GameRoom): void {
    for (const m of lobby.membersList()) {
      if (!m.conn) continue;
      const ping = room.pingOf(m.playerId);
      if (ping !== m.ping) m.ping = ping;
    }
  }

  function closeRoom(code: LobbyCode): void {
    const entry = rooms.get(code);
    if (!entry) return;
    entry.loop.stop();
    rooms.delete(code);
  }

  /** Creates rooms for new lobbies and tears down rooms for dead ones. */
  function reconcileRooms(): void {
    const alive = new Set<LobbyCode>();
    for (const lobby of registry.allLobbies()) {
      alive.add(lobby.code);
      ensureRoom(lobby);
    }
    for (const code of Array.from(rooms.keys())) {
      if (!alive.has(code)) closeRoom(code);
    }
  }

  // The registry's own clock: reconnect grace, empty-lobby TTL, phase machine.
  const registryLoop = new FixedLoop(
    (_tick, nowMs) => {
      registry.tick(nowMs);
      reconcileRooms();
    },
    { hz: TICK_RATE, now: clock }
  );
  if (autoStart) registryLoop.start();

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Attaches a connection to whatever lobby the registry just put it in.
   *
   * The registry has already sent the Error frame on failure and already
   * broadcast LobbyState on success — all this owes the client is a Welcome.
   */
  function afterPlacement(session: Session, result: Lobby | ErrorCode): void {
    if (typeof result === 'number') return; // the registry already reported it
    const info = registry.sessionFor(session.conn);
    if (!info) return;

    session.code = result.code;
    session.playerId = info.playerId;

    const room = ensureRoom(result);
    syncRoster(result, room);

    session.conn.send({
      type: ServerMessage.Welcome,
      data: {
        playerId: info.playerId,
        resumeToken: info.resumeToken,
        serverTime: clock(),
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
      },
    });
    session.conn.send({ type: ServerMessage.RoundState, data: result.buildRoundState(clock()) });
  }

  const handler: ConnectionHandler = {
    onMessage(conn: WsConnection, msg: AnyClientMessage): void {
      const session = sessions.get(conn.id);
      if (!session) return;

      if (!conn.helloReceived && msg.type !== ClientMessage.Hello) {
        conn.send({
          type: ServerMessage.Error,
          data: { code: ErrorCode.Unknown, message: 'Hello first.' },
        });
        conn.close('no hello');
        return;
      }

      switch (msg.type) {
        case ClientMessage.Hello: {
          if (conn.helloReceived) return;
          if (strictVersion && msg.data.version !== PROTOCOL_VERSION) {
            conn.send({
              type: ServerMessage.Error,
              data: {
                code: ErrorCode.VersionMismatch,
                message: `Server is on ${PROTOCOL_VERSION}. Reload the page.`,
              },
            });
            conn.close('version mismatch');
            return;
          }
          conn.helloReceived = true;
          session.name = msg.data.name ?? '';
          if (msg.data.resumeToken) {
            afterPlacement(session, registry.resume(conn, msg.data.resumeToken));
          }
          return;
        }

        case ClientMessage.CreateLobby:
          afterPlacement(session, registry.create(conn, msg.data, session.name));
          return;

        case ClientMessage.JoinLobby:
          afterPlacement(session, registry.join(conn, msg.data.code, session.name));
          return;

        case ClientMessage.QuickPlay:
          afterPlacement(session, registry.quickPlay(conn, session.name));
          return;

        case ClientMessage.LeaveLobby: {
          const code = session.code;
          registry.leave(conn);
          session.code = null;
          session.playerId = 0;
          if (code) {
            const lobby = registry.lobbyByCode(code);
            const room = rooms.get(code)?.room;
            if (lobby && room) syncRoster(lobby, room);
          }
          return;
        }

        case ClientMessage.SetReady:
          registry.setReady(conn, msg.data.ready);
          return;

        case ClientMessage.SetLoadout:
          registry.setLoadout(conn, msg.data.loadout);
          // The cosmetic skin applies to the live body immediately; the rest
          // of the loadout applies on next respawn as before.
          if (session.code) rooms.get(session.code)?.room.setSkin(session.playerId, msg.data.loadout.skin);
          return;

        case ClientMessage.SetMatchConfig:
          registry.setMatchConfig(conn, msg.data);
          return;

        case ClientMessage.Chat:
          registry.chat(conn, msg.data.text);
          return;

        case ClientMessage.Input: {
          if (!session.code) return;
          rooms.get(session.code)?.room.onInput(session.playerId, msg.data.inputs);
          return;
        }

        case ClientMessage.Pong: {
          if (!session.code) return;
          const entry = rooms.get(session.code);
          if (!entry) return;
          entry.room.onPong(session.playerId, msg.data.time, clock());
          registry.setPing(conn, entry.room.pingOf(session.playerId));
          return;
        }

        case ClientMessage.RequestRespawn:
          if (session.code) rooms.get(session.code)?.room.requestRespawn(session.playerId);
          return;

        case ClientMessage.Purchase:
          if (session.code) {
            rooms.get(session.code)?.room.onPurchase(session.playerId, msg.data.kind, msg.data.itemId);
          }
          return;

        case ClientMessage.Interact:
          if (session.code) {
            rooms.get(session.code)?.room.onInteract(session.playerId, msg.data.target);
          }
          return;

        default:
          return;
      }
    },

    onClose(conn: WsConnection): void {
      const session = sessions.get(conn.id);
      sessions.delete(conn.id);
      // The registry grace-holds the slot for RECONNECT_GRACE_MS; the room
      // keeps simulating the player with a null connection until it expires.
      registry.disconnect(conn);
      if (session?.code) {
        const lobby = registry.lobbyByCode(session.code);
        const room = rooms.get(session.code)?.room;
        if (lobby && room) syncRoster(lobby, room);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  function handleSocket(socket: SocketLike, remoteAddress?: string): WsConnection {
    const conn = new WsConnection(socket, handler, {
      remoteAddress,
      limits: opts.limits,
      now: () => Date.now(),
    });
    sessions.set(conn.id, { conn, name: '', code: null, playerId: 0 });
    return conn;
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    // Anything that is not ours is left alone, so a future endpoint can add
    // its own upgrade handler without fighting this one.
    if (pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      handleSocket(ws as unknown as SocketLike, remoteAddressOf(req));
    });
  };

  httpServer.on('upgrade', onUpgrade);

  return {
    registry,
    handleSocket,
    roomFor: (code) => rooms.get(code)?.room,
    rooms: () => mapRooms(rooms),
    advanceTo(nowMs: number): void {
      registryLoop.advanceTo(nowMs);
      for (const entry of rooms.values()) entry.loop.advanceTo(nowMs);
    },
    stats() {
      let players = 0;
      for (const entry of rooms.values()) players += entry.room.playerCount;
      return {
        connections: sessions.size,
        lobbies: rooms.size,
        players,
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
      };
    },
    async close() {
      registryLoop.stop();
      httpServer.off('upgrade', onUpgrade);
      for (const code of Array.from(rooms.keys())) closeRoom(code);
      for (const session of sessions.values()) session.conn.close('server shutting down');
      sessions.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function* mapRooms(
  rooms: Map<LobbyCode, { room: GameRoom; loop: FixedLoop; lobby: Lobby }>
): IterableIterator<[LobbyCode, GameRoom]> {
  for (const [code, entry] of rooms) yield [code, entry.room];
}

function remoteAddressOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export { MAX_PLAYERS };
