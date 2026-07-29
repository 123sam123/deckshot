/**
 * DECKSHOT rooms — lobby code generation and normalization.
 *
 * Owner: lobby-ui-hud.
 *
 * Codes are LOBBY_CODE_LENGTH characters from LOBBY_CODE_ALPHABET, which
 * deliberately omits O/0/I/1 — these codes get read aloud off phone screens
 * and streams. Input is case-insensitive; storage and display are uppercase.
 *
 * Randomness comes from node:crypto, not Math.random: codes and resume
 * tokens are unguessable by construction, and rooms code is not part of the
 * deterministic simulation so the shared-rng rule does not apply here.
 */

import { randomBytes, randomInt } from 'node:crypto';
import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH } from '../../../shared/protocol.js';

/**
 * Generate a fresh code that `isTaken` rejects. The alphabet space is
 * 32^4 = 1,048,576 codes; with the registry capped far below that, a
 * handful of attempts always suffices. The attempt cap only guards against
 * a pathological `isTaken` that returns true for everything.
 */
export function generateCode(isTaken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    let code = '';
    for (let i = 0; i < LOBBY_CODE_LENGTH; i++) {
      code += LOBBY_CODE_ALPHABET[randomInt(LOBBY_CODE_ALPHABET.length)];
    }
    if (!isTaken(code)) return code;
  }
  throw new Error('lobby code space exhausted');
}

/**
 * Uppercase and validate user input. Returns null for anything that cannot
 * be a code (wrong length, characters outside the alphabet) — the caller
 * maps that to ErrorCode.LobbyNotFound rather than failing silently.
 */
export function normalizeCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const up = input.trim().toUpperCase();
  if (up.length !== LOBBY_CODE_LENGTH) return null;
  for (const ch of up) {
    if (!LOBBY_CODE_ALPHABET.includes(ch)) return null;
  }
  return up;
}

/** Unguessable session credential for reconnect. 192 bits, URL-safe. */
export function generateResumeToken(): string {
  return randomBytes(24).toString('base64url');
}
