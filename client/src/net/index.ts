/**
 * DECKSHOT — client netcode barrel.
 *
 * Owner: netcode-core. This is what `client/src/main.ts` imports.
 *
 *   const weapons = new PredictedWeapons(loadout, controller);
 *   const net = new NetClient({
 *     name,
 *     // Weapons advance BEFORE movement, on both sides. ADS state gates
 *     // movement speed, so the other order changes the distance travelled on
 *     // the transition tick and shows up as reconciliation jitter.
 *     advanceWeapon: (input, dt) => weapons.update(input, dt),
 *   });
 *   net.connect();
 *   // 60 Hz:            net.tick(now, controller.sample());
 *   // every frame:      net.update(now, dt);
 *   //                   net.renderPosition(cameraPos);
 *   //                   for (const p of net.remotePlayers(now).values()) draw(p);
 *
 * The socket URL comes from `window.location`, so the same build works on
 * localhost, on a LAN address, and behind TLS with no configuration.
 *
 * Append `?netsim=150,2` to the page URL to play the whole thing over a
 * simulated 150 ms / 2% link.
 */

export { NetClient } from './client.js';
export type { NetClientEvents, NetClientOptions } from './client.js';

export { GameSocket, defaultSocketUrl } from './socket.js';
export type { GameSocketOptions, SocketState, WebSocketLike } from './socket.js';

export { Predictor, blankState } from './prediction.js';
export type { PredictorOptions, ReconcileResult } from './prediction.js';

export {
  SnapshotBuffer,
  blankRemote,
  copyRemote,
  lerpAngle,
  SNAPSHOT_HISTORY,
} from './interpolation.js';
export type { AppliedSnapshot, RemotePlayerState, StoredSnapshot } from './interpolation.js';

export { NetSim, DelayLine, parseNetSim, netSimFromLocation, NETSIM_OFF } from './netsim.js';
export type { NetSimConfig } from './netsim.js';
