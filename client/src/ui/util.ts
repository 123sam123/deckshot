/**
 * DECKSHOT UI — small shared helpers.
 * Owner: lobby-ui-hud.
 */

import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH } from '../../../shared/protocol.js';
import { Audio } from '../audio/index.js';

/** UI click feedback. Audio is a guaranteed no-op before init. */
export const click = (): void => Audio.play('ui_click');
export const hover = (): void => Audio.play('ui_hover', { volume: 0.5 });

/**
 * Filter raw code input down to alphabet characters, uppercased.
 * Returns the cleaned string and whether anything had to be dropped
 * (so the field can shake instead of failing silently).
 */
export function cleanCodeInput(raw: string): { code: string; rejected: boolean } {
  const up = raw.toUpperCase();
  let code = '';
  let rejected = false;
  for (const ch of up) {
    if (LOBBY_CODE_ALPHABET.includes(ch)) {
      if (code.length < LOBBY_CODE_LENGTH) code += ch;
    } else if (!/\s/.test(ch)) {
      rejected = true;
    }
  }
  return { code, rejected };
}

/** m:ss for round clocks. */
export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

// ---------------------------------------------------------------------------
// Invite links (and why LAN needs help)
// ---------------------------------------------------------------------------

/**
 * The private IPv4 address the server reported at `/lan`, or null.
 *
 * The host of a LAN game opens the game at `http://localhost:8080` and hits
 * "Copy invite link". Naively that copies a `localhost` url — which resolves
 * perfectly on every machine on the network and points each of them at their
 * own laptop. The link looks correct and can never work. So when the page
 * itself is on loopback, the invite link is rebuilt around the address the
 * server actually answers on.
 *
 * Only the HOSTNAME is taken from the server. Protocol, port and path stay
 * whatever this page was loaded with, which is what makes the same code right
 * in dev (Vite on :5173, proxying the socket) and in production (the Node
 * server on :8080 serving both) — the server's own port is the wrong answer in
 * the first case.
 */
let lanAddress: string | null = null;

/** Overrides the discovered LAN address. Tests and dev tooling only. */
export function setLanAddress(address: string | null): void {
  lanAddress = address;
}

/** The LAN address discovered at boot, if the server reported one. */
export function getLanAddress(): string | null {
  return lanAddress;
}

/** True for the hostnames that only ever mean "this machine". */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '[::1]') return true;
  // 0.0.0.0 is not loopback, but a browser pointed at it is on this machine
  // and the address is just as useless to anyone else.
  if (h === '0.0.0.0') return true;
  return /^127\./.test(h);
}

/** The slice of `window.location` an invite link is built from. */
export interface LinkLocation {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
}

/**
 * Asks the server for this machine's LAN address and remembers it.
 *
 * Best-effort by construction: off a private network the server reports
 * nothing, and behind a proxy that does not route `/lan` the fetch fails or
 * returns something else entirely. Both end with `lanAddress` still null and
 * the invite link falling back to `window.location`, which is the right answer
 * in exactly those cases.
 */
export async function discoverLanAddress(
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string | null> {
  try {
    const res = await fetchImpl('/lan');
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const raw = (body as { addresses?: unknown } | null)?.addresses;
    const first = Array.isArray(raw) ? raw.find((a) => typeof a === 'string' && a.length > 0) : null;
    setLanAddress(typeof first === 'string' ? first : null);
    return lanAddress;
  } catch {
    return null;
  }
}

/** Shareable invite link for a lobby code. */
export function inviteLink(
  code: string,
  location?: LinkLocation,
  lan: string | null = lanAddress
): string {
  const loc = location ?? window.location;
  const host = lan !== null && isLoopbackHost(loc.hostname) ? lan : loc.hostname;
  const port = loc.port ? `:${loc.port}` : '';
  return `${loc.protocol}//${host}${port}${loc.pathname}?lobby=${code}`;
}

/** The ?lobby= code from the current URL, cleaned, or null. */
export function lobbyCodeFromUrl(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('lobby');
    if (!raw) return null;
    const { code } = cleanCodeInput(raw);
    return code.length === LOBBY_CODE_LENGTH ? code : null;
  } catch {
    return null;
  }
}

/** Copy with a fallback for contexts where the async clipboard is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
