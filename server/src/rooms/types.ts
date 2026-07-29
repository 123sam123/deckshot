/**
 * DECKSHOT rooms — the transport seam.
 *
 * Owner: lobby-ui-hud.
 *
 * The lobby registry never touches a socket library. The netcode agent
 * implements `Connection` around its WebSocket handling and hands instances
 * to the registry; the registry only ever calls `send` / `close` and reads
 * `id` / `remoteAddress`. This inverts the dependency so rooms can be built
 * (and fully tested) before any transport exists.
 */

import type { AnyServerMessage } from '../../../shared/protocol.js';
import type { Loadout, PlayerId, TeamId } from '../../../shared/types.js';

/**
 * One live client socket, as the rooms layer sees it.
 * Implemented by netcode-core (`server/src/net/**`).
 */
export interface Connection {
  /** Unique per socket for the lifetime of the process. */
  readonly id: number;
  /** Encode and transmit one server message. Netcode owns the bytes. */
  send(msg: AnyServerMessage): void;
  /** Tear the socket down. `reason` is best-effort diagnostics. */
  close(reason?: string): void;
  /** Remote IP (or proxy-derived equivalent). Used for rate limiting. */
  readonly remoteAddress: string;
}

/**
 * What the netcode layer needs to build a Welcome frame after a successful
 * create/join/quickPlay/resume: the assigned PlayerId and the resume token
 * the client must present to reclaim this slot within RECONNECT_GRACE_MS.
 */
export interface SessionInfo {
  playerId: PlayerId;
  /** Unguessable; treat as a bearer credential. */
  resumeToken: string;
  name: string;
  team: TeamId;
  isHost: boolean;
}

/** One occupied (or grace-held) slot in a lobby. */
export interface LobbyMember {
  playerId: PlayerId;
  /** null while the player is disconnected and the slot is grace-held. */
  conn: Connection | null;
  name: string;
  team: TeamId;
  ready: boolean;
  /** Round-trip ms, pushed by netcode via `LobbyRegistry.setPing`. */
  ping: number;
  loadout: Loadout;
  /** Registry-clock ms at first join. Host migration picks the smallest. */
  joinedAt: number;
  resumeToken: string;
  /** Registry-clock ms at disconnect, or -1 while connected. */
  disconnectedAt: number;
}
