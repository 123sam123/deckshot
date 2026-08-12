/**
 * DECKSHOT — lobby registry tests (owner: lobby-ui-hud).
 *
 * The registry is driven entirely by its own clock (registry.tick(nowMs)),
 * so every timing behaviour here — reconnect grace, empty-lobby TTL, the
 * countdown — is tested deterministically with no mocked timers.
 */

import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  LOBBY_CODE_ALPHABET,
  LOBBY_CODE_LENGTH,
  LOBBY_EMPTY_TTL_MS,
  RECONNECT_GRACE_MS,
  ServerMessage,
} from '../shared/protocol.js';
import type { AnyServerMessage } from '../shared/protocol.js';
import { COUNTDOWN_TIME, MAX_PLAYERS } from '../shared/tuning.js';
import { GameMode, RoundPhase, TeamId } from '../shared/types.js';
import { MapId } from '../shared/mapdef.js';
import { Lobby, LobbyRegistry } from '../server/src/rooms/index.js';
import type { Connection } from '../server/src/rooms/index.js';

let nextConnId = 1;
let nextAddr = 1;

class FakeConn implements Connection {
  readonly id = nextConnId++;
  readonly remoteAddress: string;
  sent: AnyServerMessage[] = [];
  closed = false;

  constructor(remoteAddress?: string) {
    this.remoteAddress = remoteAddress ?? `10.0.${(nextAddr >> 8) & 0xff}.${nextAddr++ & 0xff}`;
  }

  send(msg: AnyServerMessage): void {
    this.sent.push(msg);
  }

  close(): void {
    this.closed = true;
  }

  lastError(): { code: ErrorCode; message: string } | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i];
      if (m.type === ServerMessage.Error) return m.data;
    }
    return undefined;
  }
}

function asLobby(result: Lobby | ErrorCode): Lobby {
  expect(result).toBeInstanceOf(Lobby);
  return result as Lobby;
}

function pid(reg: LobbyRegistry, conn: Connection): number {
  const session = reg.sessionFor(conn);
  expect(session).not.toBeNull();
  return session!.playerId;
}

/** Ready everyone up and tick through the countdown into Live. */
function startMatch(reg: LobbyRegistry, lobby: Lobby, conns: FakeConn[], t: number): number {
  for (const c of conns) reg.setReady(c, true);
  reg.tick(t); // Warmup -> Countdown
  expect(lobby.phase).toBe(RoundPhase.Countdown);
  t += COUNTDOWN_TIME * 1000 + 50;
  reg.tick(t); // Countdown -> Live
  expect(lobby.phase).toBe(RoundPhase.Live);
  return t;
}

describe('lobby codes', () => {
  it('generates collision-free, alphabet-clean codes across many creations', () => {
    const reg = new LobbyRegistry();
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const lobby = asLobby(
        reg.create(new FakeConn(), { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, `P${i}`),
      );
      expect(lobby.code).toHaveLength(LOBBY_CODE_LENGTH);
      for (const ch of lobby.code) expect(LOBBY_CODE_ALPHABET).toContain(ch);
      codes.add(lobby.code);
    }
    expect(codes.size).toBe(200);
  });

  it('joins case-insensitively', () => {
    const reg = new LobbyRegistry();
    const lobby = asLobby(
      reg.create(new FakeConn(), { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'Host'),
    );
    const joiner = new FakeConn();
    const joined = asLobby(reg.join(joiner, lobby.code.toLowerCase(), 'Friend'));
    expect(joined.code).toBe(lobby.code);
  });
});

describe('join failures are loud', () => {
  it('returns LobbyNotFound for an unknown code and sends the Error frame', () => {
    const reg = new LobbyRegistry();
    const conn = new FakeConn();
    expect(reg.join(conn, 'ZZZZ', 'X')).toBe(ErrorCode.LobbyNotFound);
    expect(conn.lastError()?.code).toBe(ErrorCode.LobbyNotFound);
  });

  it('rejects codes containing ambiguous characters outside the alphabet', () => {
    const reg = new LobbyRegistry();
    const conn = new FakeConn();
    expect(reg.join(conn, 'A0B1', 'X')).toBe(ErrorCode.LobbyNotFound);
    expect(reg.join(conn, 'ABC', 'X')).toBe(ErrorCode.LobbyNotFound);
  });

  it('returns LobbyFull for the 13th player, counting held slots', () => {
    const reg = new LobbyRegistry();
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    for (let i = 1; i < MAX_PLAYERS; i++) {
      asLobby(reg.join(new FakeConn(), lobby.code, `P${i}`));
    }
    expect(lobby.slotCount()).toBe(MAX_PLAYERS);
    const extra = new FakeConn();
    expect(reg.join(extra, lobby.code, 'Late')).toBe(ErrorCode.LobbyFull);
    expect(extra.lastError()?.code).toBe(ErrorCode.LobbyFull);
  });
});

describe('host migration', () => {
  it('promotes the longest-connected player and the match continues', () => {
    const reg = new LobbyRegistry();
    let t = 0;
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    t = 1000;
    reg.tick(t);
    const p2 = new FakeConn();
    asLobby(reg.join(p2, lobby.code, 'Second'));
    t = 2000;
    reg.tick(t);
    const p3 = new FakeConn();
    asLobby(reg.join(p3, lobby.code, 'Third'));

    const hostId = pid(reg, host);
    const p2Id = pid(reg, p2);
    expect(lobby.hostId).toBe(hostId);

    t = startMatch(reg, lobby, [host, p2, p3], t + 100);

    reg.disconnect(host);
    // Longest-connected remaining player takes over, immediately.
    expect(lobby.hostId).toBe(p2Id);
    // The match does not end or reset.
    expect(lobby.phase).toBe(RoundPhase.Live);
    reg.tick(t + 1000);
    expect(lobby.phase).toBe(RoundPhase.Live);
    // The promotion was broadcast.
    const state = lobby.buildLobbyState();
    expect(state.hostId).toBe(p2Id);
    expect(state.players.find((p) => p.id === p2Id)?.isHost).toBe(true);
  });
});

describe('reconnect', () => {
  function liveLobbyWithScore(): {
    reg: LobbyRegistry;
    lobby: Lobby;
    host: FakeConn;
    other: FakeConn;
    otherId: number;
    token: string;
    t: number;
  } {
    const reg = new LobbyRegistry();
    let t = 0;
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    const other = new FakeConn();
    asLobby(reg.join(other, lobby.code, 'Sharp'));
    const otherId = pid(reg, other);
    const token = reg.sessionFor(other)!.resumeToken;
    t = startMatch(reg, lobby, [host, other], t + 100);
    // Two kills for the reconnecting player: score, kills, streak all nonzero.
    lobby.registerKill(otherId, pid(reg, host), { now: t / 1000 });
    lobby.registerKill(otherId, pid(reg, host), { now: t / 1000 + 1 });
    return { reg, lobby, host, other, otherId, token, t };
  }

  it('restores PlayerId, score, kills, deaths and streak within the grace period', () => {
    const { reg, lobby, other, otherId, token, t } = liveLobbyWithScore();
    const before = lobby.scoreKeeper.statsFor(otherId);
    // Exact score depends on trickshot evaluation (owned elsewhere); what
    // matters here is that it is nonzero and survives the reconnect intact.
    expect(before).toMatchObject({ kills: 2, deaths: 0, streak: 2 });
    expect(before!.score).toBeGreaterThan(0);

    reg.disconnect(other);
    reg.tick(t + RECONNECT_GRACE_MS - 1000);

    const fresh = new FakeConn();
    const resumed = asLobby(reg.resume(fresh, token));
    expect(resumed.code).toBe(lobby.code);
    expect(pid(reg, fresh)).toBe(otherId);
    expect(lobby.scoreKeeper.statsFor(otherId)).toEqual(before);
    expect(lobby.phase).toBe(RoundPhase.Live);
  });

  it('rejects the token after the grace period and frees the slot', () => {
    const { reg, lobby, other, otherId, token, t } = liveLobbyWithScore();
    reg.disconnect(other);
    reg.tick(t + RECONNECT_GRACE_MS + 1);

    expect(lobby.memberByPlayerId(otherId)).toBeUndefined();
    const fresh = new FakeConn();
    expect(reg.resume(fresh, token)).toBe(ErrorCode.LobbyNotFound);
    expect(fresh.lastError()?.code).toBe(ErrorCode.LobbyNotFound);
  });

  it('rejects a token that was never issued', () => {
    const { reg } = liveLobbyWithScore();
    const fresh = new FakeConn();
    expect(reg.resume(fresh, 'not-a-real-token')).toBe(ErrorCode.LobbyNotFound);
  });
});

describe('empty-lobby TTL', () => {
  it('reclaims an empty lobby after the TTL and not before', () => {
    const reg = new LobbyRegistry();
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    const code = lobby.code;
    reg.leave(host);

    reg.tick(LOBBY_EMPTY_TTL_MS - 1);
    expect(reg.lobbyByCode(code)).toBeDefined();

    reg.tick(LOBBY_EMPTY_TTL_MS);
    expect(reg.lobbyByCode(code)).toBeUndefined();
  });

  it('lets a friend join an emptied lobby before the TTL, resetting it', () => {
    const reg = new LobbyRegistry();
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    reg.leave(host);
    reg.tick(LOBBY_EMPTY_TTL_MS - 1);

    const friend = new FakeConn();
    asLobby(reg.join(friend, lobby.code, 'F'));
    reg.tick(LOBBY_EMPTY_TTL_MS * 2); // well past the original deadline
    expect(reg.lobbyByCode(lobby.code)).toBeDefined();
  });
});

describe('quick play', () => {
  it('fills the fullest joinable lobby instead of scattering people', () => {
    const reg = new LobbyRegistry();
    const a = asLobby(
      reg.create(new FakeConn(), { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'A'),
    );
    asLobby(reg.join(new FakeConn(), a.code, 'A2'));
    asLobby(reg.join(new FakeConn(), a.code, 'A3'));
    const b = asLobby(
      reg.create(new FakeConn(), { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'B'),
    );
    // A full lobby must be skipped even though it has the most players.
    const full = asLobby(
      reg.create(new FakeConn(), { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'F'),
    );
    for (let i = 1; i < MAX_PLAYERS; i++) asLobby(reg.join(new FakeConn(), full.code, `F${i}`));
    expect(full.hasSpace()).toBe(false);

    const seeker = new FakeConn();
    const joined = asLobby(reg.quickPlay(seeker, 'Seeker'));
    expect(joined.code).toBe(a.code);
    expect(b.slotCount()).toBe(1);
  });

  it('creates a lobby when none have space', () => {
    const reg = new LobbyRegistry();
    const seeker = new FakeConn();
    const lobby = asLobby(reg.quickPlay(seeker, 'Solo'));
    expect(lobby.slotCount()).toBe(1);
    expect(reg.lobbyCount()).toBe(1);
  });
});

describe('rate limiting', () => {
  it('limits lobby creation per address', () => {
    const reg = new LobbyRegistry();
    const addr = '203.0.113.7';
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const res = reg.create(
        new FakeConn(addr),
        { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 },
        'Spam',
      );
      if (res === ErrorCode.RateLimited) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('limits join attempts per address and recovers after the window', () => {
    const reg = new LobbyRegistry();
    const addr = '203.0.113.9';
    let sawLimit = false;
    for (let i = 0; i < 20; i++) {
      const res = reg.join(new FakeConn(addr), 'ZZZZ', 'Spam');
      if (res === ErrorCode.RateLimited) {
        sawLimit = true;
        break;
      }
      expect(res).toBe(ErrorCode.LobbyNotFound);
    }
    expect(sawLimit).toBe(true);

    // The window slides: the same address may try again later.
    reg.tick(60_000);
    expect(reg.join(new FakeConn(addr), 'ZZZZ', 'Calm')).toBe(ErrorCode.LobbyNotFound);
  });
});

describe('match flow extras', () => {
  it('late joiners land in a match in progress with scoring active', () => {
    const reg = new LobbyRegistry();
    let t = 0;
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    const p2 = new FakeConn();
    asLobby(reg.join(p2, lobby.code, 'P2'));
    t = startMatch(reg, lobby, [host, p2], t + 100);

    const late = new FakeConn();
    asLobby(reg.join(late, lobby.code, 'Late'));
    const lateId = pid(reg, late);
    expect(lobby.inProgress).toBe(true);
    expect(lobby.buildLobbyState().inProgress).toBe(true);
    expect(lobby.scoreKeeper.has(lateId)).toBe(true);
    // The newcomer was handed the running match clock, not left waiting.
    expect(late.sent.some((m) => m.type === ServerMessage.RoundState)).toBe(true);
  });

  it('assigns and balances TDM teams', () => {
    const reg = new LobbyRegistry();
    const host = new FakeConn();
    const lobby = asLobby(
      reg.create(host, { mode: GameMode.TeamDeathmatch, scoreLimit: 50 }, 'H'),
    );
    const conns = [host];
    for (let i = 0; i < 5; i++) {
      const c = new FakeConn();
      asLobby(reg.join(c, lobby.code, `P${i}`));
      conns.push(c);
    }
    const members = lobby.membersList();
    const alpha = members.filter((m) => m.team === TeamId.Alpha).length;
    const bravo = members.filter((m) => m.team === TeamId.Bravo).length;
    expect(alpha + bravo).toBe(6);
    expect(Math.abs(alpha - bravo)).toBeLessThanOrEqual(1);
  });

  it('aborts the countdown when a player un-readies', () => {
    const reg = new LobbyRegistry();
    let t = 0;
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    const p2 = new FakeConn();
    asLobby(reg.join(p2, lobby.code, 'P2'));
    reg.setReady(host, true);
    reg.setReady(p2, true);
    t += 100;
    reg.tick(t);
    expect(lobby.phase).toBe(RoundPhase.Countdown);
    reg.setReady(p2, false);
    t += 100;
    reg.tick(t);
    expect(lobby.phase).toBe(RoundPhase.Warmup);
  });

  it('only the host may change match config', () => {
    const reg = new LobbyRegistry();
    const host = new FakeConn();
    const lobby = asLobby(reg.create(host, { mode: GameMode.SnipersOnlyFFA, scoreLimit: 30 }, 'H'));
    const p2 = new FakeConn();
    asLobby(reg.join(p2, lobby.code, 'P2'));
    const res = reg.setMatchConfig(p2, {
      mode: GameMode.TeamDeathmatch,
      scoreLimit: 50,
      timeLimit: 300,
      mapId: MapId.Sundeck,
    });
    expect(res).toBe(ErrorCode.NotHost);
    expect(lobby.mode).toBe(GameMode.SnipersOnlyFFA);
    expect(
      reg.setMatchConfig(host, {
        mode: GameMode.TeamDeathmatch,
        scoreLimit: 50,
        timeLimit: 300,
        mapId: MapId.Sundeck,
      }),
    ).toBeNull();
    expect(lobby.mode).toBe(GameMode.TeamDeathmatch);
    expect(lobby.scoreLimit).toBe(50);
  });
});
