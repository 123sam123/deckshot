/**
 * DECKSHOT rooms — public surface.
 *
 * Owner: lobby-ui-hud. See registry.ts for the calling contract the netcode
 * layer follows (who sends Error frames, who sends Welcome, etc).
 */

export type { Connection, LobbyMember, SessionInfo } from './types.js';
export { Lobby, sanitizeLoadout, sanitizeName } from './lobby.js';
export { LobbyRegistry, MAX_LOBBIES } from './registry.js';
export { generateCode, generateResumeToken, normalizeCode } from './codes.js';
