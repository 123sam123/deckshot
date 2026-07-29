/**
 * DECKSHOT — server netcode barrel.
 *
 * Owner: netcode-core. This is the surface `server/src/index.ts` imports.
 *
 * Minimal wiring for one-port deployment:
 *
 *   const http = createServer(serveStaticClient);
 *   createGameServer(http, { hooks: { weapons, resolveFire } });
 *   http.listen(Number(process.env.PORT ?? DEFAULT_PORT));
 */

export { createGameServer, DEFAULT_PORT, WS_PATH } from './server.js';
export type { GameServer, GameServerOptions } from './server.js';

export { GameRoom, createPlayerState, SNAPSHOT_EVERY } from './room.js';
export type { GameRoomOptions, RoomPlayer, RoomPlayerInit, ScoringSink } from './room.js';

export { WsConnection, DEFAULT_RATE_LIMITS, toBytes } from './connection.js';
export type { ConnectionHandler, RateLimits, SocketLike } from './connection.js';

export { FixedLoop, monotonicNow } from './loop.js';
export type { FixedLoopOptions } from './loop.js';

export { LagCompHistory, RewindPool, HISTORY_TICKS, copyPlayerInto } from './lagcomp.js';

export { SnapshotAssembler, ClientBaseline, BASELINE_HISTORY } from './snapshot.js';
export type { ReplicationExtras } from './snapshot.js';

export { InputQueue, sanitize as sanitizeInput, INPUT_QUEUE_CAPACITY, MAX_SEQ_JUMP } from './inputqueue.js';

export { createDefaultHooks, readRuntime, runtimeFired } from './hooks.js';
export type {
  FireContext,
  FireOutcome,
  FireResolver,
  FireVictim,
  SimHooks,
  WeaponRuntimeView,
  WeaponsModule,
} from './hooks.js';
