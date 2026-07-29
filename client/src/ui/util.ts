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

/** Shareable invite link for a lobby code. */
export function inviteLink(code: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?lobby=${code}`;
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
