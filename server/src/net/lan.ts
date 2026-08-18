/**
 * DECKSHOT — LAN address discovery.
 *
 * Owner: netcode-core.
 *
 * The server already listens on every interface and the client already derives
 * `ws(s)://<same host>/ws` from `window.location`, so LAN play needs no
 * configuration — it needs the host to know WHICH url to hand out. A host who
 * opens the game at `http://localhost:8080` and hits "Copy invite link" copies
 * a `localhost` url, which resolves on every machine on the network and points
 * every one of them at their own laptop. The link looks fine and simply never
 * works.
 *
 * So: enumerate this machine's private-range IPv4 addresses, print them at
 * boot, and serve them at `/lan` for the client to prefer over a loopback
 * origin when it builds an invite link.
 *
 * Only RFC 1918 private ranges are ever reported. That is what "LAN" means, and
 * it also means a public deployment (Fly.io, a VPS) returns an empty list and
 * leaks nothing — the client then falls back to `window.location.origin`, which
 * is the correct answer there anyway.
 */

import { networkInterfaces } from 'node:os';

/** The slice of `os.NetworkInterfaceInfo` used here; keeps tests os-free. */
export interface NetIfaceInfo {
  address: string;
  /** `'IPv4'` on current Node; some versions reported the number `4`. */
  family: string | number;
  internal: boolean;
}

export type IfaceMap = Record<string, NetIfaceInfo[] | undefined>;

/**
 * True for the three RFC 1918 private IPv4 ranges, and only those.
 *
 * Deliberately excludes 127.0.0.0/8 (loopback — the very thing this module
 * exists to replace) and 169.254.0.0/16 (link-local, handed out when DHCP
 * failed; it is not a working LAN address and offering it wastes the host's
 * time).
 */
export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    octets.push(n);
  }

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Sort key, lowest first. 192.168/16 is what a consumer router hands out and
 * is therefore the address the other players are almost certainly on; 10/8 is
 * usually a corporate or VPN network; 172.16/12 is most often a Docker bridge,
 * which is reachable from nothing. Ordering costs nothing and means the first
 * url printed is the one that works.
 */
function rank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  return 2;
}

/** Every private IPv4 address on this machine, best LAN candidate first. */
export function lanAddresses(ifaces: IfaceMap = networkInterfaces()): string[] {
  const found: string[] = [];
  for (const infos of Object.values(ifaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (!isPrivateIPv4(info.address)) continue;
      if (!found.includes(info.address)) found.push(info.address);
    }
  }
  return found.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
}

/** `http://<lan ip>:<port>` for every private address, best candidate first. */
export function lanOrigins(port: number, ifaces?: IfaceMap): string[] {
  return lanAddresses(ifaces).map((address) => `http://${address}:${port}`);
}
