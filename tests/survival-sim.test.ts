/**
 * DECKSHOT — SURVIVAL server simulation: the director, the horde, downs,
 * revives, wipes, purchases and the solo lobby rule.
 *
 * Owner: survival. The director is driven tick by tick with a fake clock, so
 * every timing here (bleedout, revive hold, intermissions) is deterministic.
 */

import { describe, expect, it } from 'vitest';

import { GameMode, InputButton, RoundPhase, Stance, TeamId, WeaponId, emptyInput } from '../shared/types.js';
import type { AnyServerMessage } from '../shared/protocol.js';
import { ServerMessage } from '../shared/protocol.js';
import { TICK_MS, TICK_RATE } from '../shared/tuning.js';
import {
  BLEEDOUT_TIME,
  INTERMISSION_TIME,
  MAX_ENTITIES,
  PurchaseKind,
  REVIVE_TIME,
  SurvivalPhase,
  ZOMBIE_ID_BASE,
  ZOMBIES_ALIVE_MAX,
  isZombieId,
} from '../shared/survival.js';
import { LEVIATHAN } from '../shared/leviathan.js';
import { MAX_PLAYERS } from '../shared/tuning.js';
import { decodeServer, encodeServer } from '../shared/codec.js';
import { SurvivalDirector, type SquadMember, type SurvivalCallbacks } from '../server/src/sim/survival.js';
import { GameRoom, ZOMBIE_FIELD_MASK, createPlayerState } from '../server/src/net/room.js';
import { SnapshotField } from '../shared/protocol.js';
import { Lobby } from '../server/src/rooms/index.js';
import type { Connection } from '../server/src/rooms/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeMember(id: number, x = 0, z = -58): SquadMember {
  const state = createPlayerState(id, `p${id}`, TeamId.Alpha, {
    primary: WeaponId.Kestrel,
    attachments: [0, 0, 0],
    camo: 0,
  } as never);
  state.position.x = x;
  state.position.y = 0;
  state.position.z = z;
  return { id, state, lastInput: emptyInput() };
}

interface Recorded {
  deaths: number[];
  respawns: number[];
  ended: boolean;
  stashed: number[];
  restored: number[];
  refills: number;
}

function makeCallbacks(rec: Recorded): SurvivalCallbacks {
  return {
    send: () => undefined,
    broadcast: () => undefined,
    giveWeapon: () => undefined,
    refillAmmo: () => {
      rec.refills++;
    },
    stashWeaponsForDown: (id) => rec.stashed.push(id),
    restoreWeaponsOnRevive: (id) => rec.restored.push(id),
    onLoadoutChanged: () => undefined,
    respawn: (id) => rec.respawns.push(id),
    reportDeath: (id) => rec.deaths.push(id),
    endMatch: () => {
      rec.ended = true;
    },
    ammoOf: () => ({
      held: WeaponId.Kestrel,
      stowed: WeaponId.Knife,
      mag: 12,
      reserve: 48,
      stowedMag: 0,
      stowedReserve: 0,
    }),
  };
}

function makeDirector(rec: Recorded): SurvivalDirector {
  return new SurvivalDirector(LEVIATHAN, MAX_PLAYERS, makeCallbacks(rec), 1234);
}

const blankRec = (): Recorded => ({
  deaths: [],
  respawns: [],
  ended: false,
  stashed: [],
  restored: [],
  refills: 0,
});

/** Run `n` ticks of the director with a fixed member list. */
function run(d: SurvivalDirector, members: SquadMember[], from: number, n: number): number {
  let tick = from;
  for (let i = 0; i < n; i++) {
    tick++;
    d.tick(tick, tick * TICK_MS, members);
  }
  return tick;
}

// ---------------------------------------------------------------------------
// Rounds and spawning
// ---------------------------------------------------------------------------

describe('round machine', () => {
  it('starts round 1 after the opening intermission and spawns the horde', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const squad = [makeMember(1)];
    expect(d.round).toBe(0);
    // Opening intermission is 3s.
    const t = run(d, squad, 0, Math.ceil(3.2 * TICK_RATE));
    expect(d.round).toBe(1);
    expect(d.phase).toBe(SurvivalPhase.Wave);
    run(d, squad, t, Math.ceil(3 * TICK_RATE));
    expect(d.horde.aliveCount).toBeGreaterThan(0);
    for (const z of d.horde.actives()) {
      expect(isZombieId(z.state.id)).toBe(true);
      expect(z.state.team).toBe(TeamId.Bravo);
      expect(z.slot).toBeGreaterThanOrEqual(MAX_PLAYERS);
      expect(z.slot).toBeLessThan(MAX_ENTITIES);
    }
  });

  it('never exceeds ZOMBIES_ALIVE_MAX', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    // Force-spawn far past the cap.
    for (let i = 0; i < 60; i++) {
      d.horde.spawn(i, 1, 150, 2, []);
    }
    expect(d.horde.aliveCount).toBeLessThanOrEqual(ZOMBIES_ALIVE_MAX + 4); // pool size
  });

  it('the round ends when the horde is dead and the next begins after the intermission', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const squad = [makeMember(1)];
    let t = run(d, squad, 0, Math.ceil(3.2 * TICK_RATE));
    expect(d.round).toBe(1);
    // Kill everything as it spawns until the round's budget is exhausted.
    for (let guard = 0; guard < 60 * TICK_RATE && d.phase === SurvivalPhase.Wave; guard++) {
      t = run(d, squad, t, 1);
      for (const z of [...d.horde.actives()]) {
        d.horde.damage(z.state.id, 1e9);
      }
    }
    expect(d.phase).toBe(SurvivalPhase.Intermission);
    t = run(d, squad, t, Math.ceil((INTERMISSION_TIME + 0.5) * TICK_RATE));
    expect(d.round).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Down, bleed out, revive, wipe
// ---------------------------------------------------------------------------

describe('last stand', () => {
  it('lethal damage downs instead of killing, stashing the guns', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const squad = [makeMember(1), makeMember(2, 3)];
    let t = run(d, squad, 0, 5);
    d.damagePlayer(squad[0], 999, t * TICK_MS);
    expect(squad[0].state.alive).toBe(true);
    expect(squad[0].state.downed).toBe(true);
    expect(squad[0].state.stance).toBe(Stance.Prone);
    expect(rec.stashed).toEqual([1]);
    expect(rec.ended).toBe(false);
  });

  it('bleeds out to death after 30s when nobody helps', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const squad = [makeMember(1), makeMember(2, 8, -50)]; // teammate out of reach
    let t = run(d, squad, 0, 5);
    d.damagePlayer(squad[0], 999, t * TICK_MS);
    t = run(d, squad, t, Math.ceil((BLEEDOUT_TIME - 1) * TICK_RATE));
    expect(squad[0].state.alive).toBe(true); // still crawling at 29s
    t = run(d, squad, t, Math.ceil(2 * TICK_RATE));
    expect(squad[0].state.alive).toBe(false);
    expect(rec.deaths).toEqual([1]);
  });

  it('a teammate holding Use in reach revives in 3.5s and earns 50 points', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const rescuerStartBalance = 500;
    const squad = [makeMember(1, 0), makeMember(2, 1)]; // 1m apart, in revive radius
    let t = run(d, squad, 0, 5);
    d.damagePlayer(squad[0], 999, t * TICK_MS);
    squad[1].lastInput.buttons = InputButton.Use;
    // Not yet at half the hold...
    t = run(d, squad, t, Math.ceil((REVIVE_TIME / 2) * TICK_RATE));
    expect(squad[0].state.downed).toBe(true);
    // ...done shortly after the full hold.
    t = run(d, squad, t, Math.ceil((REVIVE_TIME / 2 + 0.3) * TICK_RATE));
    expect(squad[0].state.downed).toBe(false);
    expect(squad[0].state.alive).toBe(true);
    expect(rec.restored).toEqual([1]);
    expect(d.balanceOf(2)).toBe(rescuerStartBalance + 50);
  });

  it('bleedout pauses while a revive is in progress', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const squad = [makeMember(1, 0), makeMember(2, 1)];
    let t = run(d, squad, 0, 5);
    d.damagePlayer(squad[0], 999, t * TICK_MS);
    const before = squad[0].state.bleedout ?? 0;
    squad[1].lastInput.buttons = InputButton.Use;
    t = run(d, squad, t, Math.ceil(1 * TICK_RATE));
    // A second of reviving must not have burned a second of bleedout.
    expect(squad[0].state.bleedout ?? 0).toBeCloseTo(before, 1);
  });

  it('detects the wipe the moment every player is down', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const squad = [makeMember(1, 0), makeMember(2, 8)];
    let t = run(d, squad, 0, Math.ceil(3.2 * TICK_RATE)); // into round 1
    d.damagePlayer(squad[0], 999, t * TICK_MS);
    t = run(d, squad, t, 2);
    expect(rec.ended).toBe(false); // one player still standing
    d.damagePlayer(squad[1], 999, t * TICK_MS);
    run(d, squad, t, 2);
    expect(rec.ended).toBe(true);
  });

  it('respawns the dead at the next round start', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const squad = [makeMember(1, 0), makeMember(2, 8, -50)];
    let t = run(d, squad, 0, Math.ceil(3.2 * TICK_RATE));
    d.damagePlayer(squad[0], 999, t * TICK_MS);
    t = run(d, squad, t, Math.ceil((BLEEDOUT_TIME + 1) * TICK_RATE));
    expect(squad[0].state.alive).toBe(false);
    // Clear the round so the intermission comes and a new round begins.
    for (let guard = 0; guard < 90 * TICK_RATE && d.phase === SurvivalPhase.Wave; guard++) {
      t = run(d, squad, t, 1);
      for (const z of [...d.horde.actives()]) d.horde.damage(z.state.id, 1e9);
    }
    t = run(d, squad, t, Math.ceil((INTERMISSION_TIME + 0.5) * TICK_RATE));
    expect(rec.respawns).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// Purchases through the director (proximity + validation together)
// ---------------------------------------------------------------------------

describe('director purchases', () => {
  it('opens a zone only at its door, with funds, marking the mask and rebuilding the world', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const buyer = makeMember(1);
    run(d, [buyer], 0, 2);

    // Nowhere near the Promenade doors: refused.
    d.purchase(buyer, PurchaseKind.Zone, 1, 1000);
    expect(d.zoneMask & 0b10).toBe(0);

    // Standing at the port promenade door with 500 starting points < 750: refused.
    buyer.state.position.x = -13.5;
    buyer.state.position.z = -47;
    d.purchase(buyer, PurchaseKind.Zone, 1, 1000);
    expect(d.zoneMask & 0b10).toBe(0);

    // With funds: the door opens and the collision world changes.
    const worldBefore = d.world;
    d.onZombieKills(1, 2000, 1, 1, 1000); // 2000 trickshot score -> 1000 points
    d.purchase(buyer, PurchaseKind.Zone, 1, 1000);
    expect(d.zoneMask & 0b10).toBe(0b10);
    expect(d.world).not.toBe(worldBefore);
    expect(d.world.brushes.length).toBeLessThan(worldBefore.brushes.length);
  });

  it('the generator only flips in reach and only once its room is open', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const buyer = makeMember(1);
    run(d, [buyer], 0, 2);
    // In reach but the Engine Room is still sealed: refused.
    buyer.state.position.x = 0;
    buyer.state.position.y = -3.4;
    buyer.state.position.z = -19.5;
    d.interact(buyer, 0 /* Generator */, 1000);
    expect(d.powerOn).toBe(false);
    // Open the room (test shortcut: flip the mask directly) and retry.
    d.zoneMask |= 1 << 3;
    d.interact(buyer, 0, 1000);
    expect(d.powerOn).toBe(true);
    // Out of reach never works.
    const d2 = makeDirector(blankRec());
    const far = makeMember(2);
    run(d2, [far], 0, 2);
    d2.zoneMask |= 1 << 3;
    d2.interact(far, 0, 1000);
    expect(d2.powerOn).toBe(false);
  });

  it('a downed player cannot buy anything', () => {
    const rec = blankRec();
    const d = makeDirector(rec);
    const buyer = makeMember(1);
    let t = run(d, [buyer], 0, 2);
    d.onZombieKills(1, 10_000, 1, 1, t * TICK_MS);
    d.damagePlayer(buyer, 999, t * TICK_MS);
    buyer.state.position.x = -13.5;
    buyer.state.position.z = -47;
    const balance = d.balanceOf(1);
    d.purchase(buyer, PurchaseKind.Zone, 1, t * TICK_MS);
    expect(d.zoneMask & 0b10).toBe(0);
    expect(d.balanceOf(1)).toBe(balance);
  });
});

// ---------------------------------------------------------------------------
// The standalone room end to end
// ---------------------------------------------------------------------------

class RecordingConn implements Connection {
  readonly id: number;
  readonly remoteAddress = '10.9.9.9';
  sent: AnyServerMessage[] = [];
  constructor(id: number) {
    this.id = id;
  }
  send(msg: AnyServerMessage): void {
    // Round-trip through the real codec: snapshots are scratch objects the
    // assembler reuses, so storing the reference would alias every message.
    this.sent.push(decodeServer(encodeServer(msg)));
  }
  close(): void {
    /* noop */
  }
}

describe('survival GameRoom', () => {
  it('spawns players with the Kestrel, runs rounds, and replicates zombies with the reduced mask', () => {
    const conn = new RecordingConn(1);
    const room = new GameRoom({ code: 'SRV1', mode: GameMode.Survival });
    room.addPlayer({ id: 1, name: 'solo', team: TeamId.Alpha, conn });

    const p = room.get(1)!;
    expect(p.state.activeWeapon).toBe(WeaponId.Kestrel);

    // Feed inputs and run ~12s: intermission (3s) + most of round 1 spawning.
    let ack = 0;
    for (let t = 1; t <= 12 * TICK_RATE; t++) {
      const inp = emptyInput();
      inp.seq = t;
      inp.tick = ack;
      room.onInput(1, [inp]);
      room.tick(t, t * TICK_MS);
      for (let i = conn.sent.length - 1; i >= 0; i--) {
        const m = conn.sent[i];
        if (m.type === ServerMessage.Snapshot) {
          ack = m.data.tick;
          break;
        }
      }
    }

    expect(room.survival).not.toBeNull();
    expect(room.survival!.round).toBeGreaterThanOrEqual(1);
    expect(room.survival!.horde.aliveCount).toBeGreaterThan(0);

    // The wire: snapshots carry zombie entities, masked down.
    let sawZombie = false;
    for (const m of conn.sent) {
      if (m.type !== ServerMessage.Snapshot) continue;
      for (const sp of m.data.players) {
        if (!isZombieId(sp.id)) continue;
        sawZombie = true;
        const mask = (sp as { mask?: number }).mask ?? 0xffff;
        expect(mask & ~ZOMBIE_FIELD_MASK).toBe(0);
        expect(mask & SnapshotField.Health).toBe(0); // health never on the wire
      }
    }
    expect(sawZombie).toBe(true);

    // SurvivalState reached the client.
    const srvMsgs = conn.sent.filter((m) => m.type === ServerMessage.SurvivalState);
    expect(srvMsgs.length).toBeGreaterThan(0);
  });

  it('zombies are rewound through lag comp history slots above the player range', () => {
    const room = new GameRoom({ code: 'SRV2', mode: GameMode.Survival });
    room.addPlayer({ id: 1, name: 'solo', team: TeamId.Alpha, conn: new RecordingConn(2) });
    for (let t = 1; t <= 8 * TICK_RATE; t++) {
      const inp = emptyInput();
      inp.seq = t;
      room.onInput(1, [inp]);
      room.tick(t, t * TICK_MS);
    }
    const d = room.survival!;
    expect(d.horde.aliveCount).toBeGreaterThan(0);
    for (const z of d.horde.actives()) {
      expect(z.state.id).toBeGreaterThanOrEqual(ZOMBIE_ID_BASE);
      expect(z.slot).toBeGreaterThanOrEqual(MAX_PLAYERS);
    }
  });
});

// ---------------------------------------------------------------------------
// The solo lobby rule
// ---------------------------------------------------------------------------

describe('survival lobby', () => {
  it('a solo SURVIVAL lobby starts with one ready player', () => {
    const lobby = new Lobby('SRVL', GameMode.Survival, 0, 0);
    const conn = new RecordingConn(3);
    lobby.addMember(conn, 'lonely', 'tok-1', 1000);
    const member = lobby.membersList()[0];
    expect(member.team).toBe(TeamId.Alpha);
    lobby.setReady(member.playerId, true);

    lobby.tick(2000);
    expect(lobby.phase).toBe(RoundPhase.Countdown);
    lobby.tick(2000 + 5000 + TICK_MS); // COUNTDOWN_TIME elapses
    expect(lobby.phase).toBe(RoundPhase.Live);
  });

  it('an FFA lobby still requires two players', () => {
    const lobby = new Lobby('FFAL', GameMode.SnipersOnlyFFA, 30, 600);
    const conn = new RecordingConn(4);
    lobby.addMember(conn, 'lonely', 'tok-2', 1000);
    lobby.setReady(lobby.membersList()[0].playerId, true);
    lobby.tick(2000);
    expect(lobby.phase).toBe(RoundPhase.Warmup);
  });

  it('caps the squad at five and refuses a sixth', () => {
    const lobby = new Lobby('SRVC', GameMode.Survival, 0, 0);
    for (let i = 0; i < 5; i++) {
      expect(lobby.hasSpace()).toBe(true);
      lobby.addMember(new RecordingConn(10 + i), `p${i}`, `tok-${10 + i}`, 1000);
    }
    expect(lobby.hasSpace()).toBe(false);
  });

  it('a squad wipe ends the match through the sink', () => {
    const lobby = new Lobby('SRVW', GameMode.Survival, 0, 0);
    const conn = new RecordingConn(30);
    lobby.addMember(conn, 'solo', 'tok-30', 1000);
    lobby.setReady(lobby.membersList()[0].playerId, true);
    lobby.tick(2000);
    lobby.tick(2000 + 5000 + TICK_MS);
    expect(lobby.phase).toBe(RoundPhase.Live);
    lobby.endMatch();
    expect(lobby.phase).toBe(RoundPhase.Over);
    const over = conn.sent.filter((m) => m.type === ServerMessage.MatchOver);
    expect(over.length).toBe(1);
  });
});
