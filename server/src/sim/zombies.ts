/**
 * DECKSHOT — SURVIVAL zombie horde: pool, spawning, AI stepping, attacks.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * Zombies are `PlayerState`-shaped entities (ids >= ZOMBIE_ID_BASE, team
 * Bravo) so the whole combat/replication stack — 7-capsule hitboxes,
 * penetration collaterals, delta snapshots, interpolation, lag comp — works on
 * them unchanged. This module is SERVER-ONLY (the client interpolates zombies,
 * never predicts them) but still obeys the no-`Math.random()` rule: every
 * random draw comes from `shared/rng.ts` seeded by (tick, zombie index).
 */

import {
  capsuleSweep,
  type CollisionWorld,
} from '../../../shared/collision.js';
import {
  PLAYER_HEIGHT_STAND,
  PLAYER_RADIUS,
  TICK_RATE,
  eyeHeightForStance,
} from '../../../shared/tuning.js';
import { AdsState, Stance, TeamId, WeaponId, type PlayerId, type PlayerState, type Vec3 } from '../../../shared/types.js';
import { DEFAULT_LOADOUT } from '../../../shared/types.js';
import { hashSeed3, makeRng } from '../../../shared/rng.js';
import { findPath, nearestNode, type NavGraph } from '../../../shared/navgraph.js';
import {
  ZOMBIES_ALIVE_MAX,
  ZOMBIE_ID_BASE,
  ZOMBIE_MELEE_INTERVAL,
  ZOMBIE_MELEE_RANGE,
  isZombieId,
} from '../../../shared/survival.js';
import type { MapDef } from '../../../shared/maps.js';

export { isZombieId };

const GRAVITY_FALL = 12; // m/s of downward drift when off the ground
const WAYPOINT_REACH = 0.8; // m, horizontal
const DIRECT_CHASE_RANGE = 10; // m: close enough to skip the graph and walk at the player
const REPATH_TICKS = Math.round(TICK_RATE * 0.8);
/** Stagger: at most this many zombies recompute a path on one tick. */
const REPATHS_PER_TICK = 4;

export interface ZombieAttack {
  zombieId: PlayerId;
  targetId: PlayerId;
}

interface ZombieRec {
  state: PlayerState;
  active: boolean;
  /** Lag-comp slot; fixed per pool index. */
  slot: number;
  path: number[] | null;
  pathIndex: number;
  repathAtTick: number;
  attackReadyAtTick: number;
  targetId: PlayerId;
  speed: number;
}

function makeZombieState(id: PlayerId): PlayerState {
  return {
    id,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    stance: Stance.Stand,
    onGround: true,
    slideTime: 0,
    slideCooldown: 0,
    sprintTime: 0,
    health: 0,
    alive: false,
    activeWeapon: WeaponId.Knife,
    adsState: AdsState.Hip,
    adsProgress: 0,
    ammoInMag: 0,
    ammoReserve: 0,
    actionEndsAt: 0,
    name: 'Drowned',
    team: TeamId.Bravo,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 0,
  };
}

/** Minimal view of a living squad member the horde needs. */
export interface HordeTarget {
  state: PlayerState;
  downed: boolean;
}

export class ZombieHorde {
  private readonly pool: ZombieRec[] = [];
  private readonly map: MapDef;
  private readonly graph: NavGraph;
  /** Base for lag-comp slots (players occupy 0..slotBase-1). */
  private readonly slotBase: number;
  private repathCursor = 0;

  constructor(map: MapDef, graph: NavGraph, slotBase: number) {
    this.map = map;
    this.graph = graph;
    this.slotBase = slotBase;
    for (let i = 0; i < ZOMBIES_ALIVE_MAX + 4; i++) {
      this.pool.push({
        state: makeZombieState(ZOMBIE_ID_BASE + i),
        active: false,
        slot: slotBase + i,
        path: null,
        pathIndex: 0,
        repathAtTick: 0,
        attackReadyAtTick: 0,
        targetId: 0,
        speed: 2,
      });
    }
  }

  get aliveCount(): number {
    let n = 0;
    for (const z of this.pool) if (z.active) n++;
    return n;
  }

  /** Active zombies. The record's `state` is the live authoritative state. */
  *actives(): IterableIterator<{ state: PlayerState; slot: number }> {
    for (const z of this.pool) if (z.active) yield z;
  }

  byId(id: PlayerId): { state: PlayerState; slot: number } | null {
    if (!isZombieId(id)) return null;
    const z = this.pool[id - ZOMBIE_ID_BASE];
    return z && z.active ? z : null;
  }

  clear(): void {
    for (const z of this.pool) {
      z.active = false;
      z.state.alive = false;
      z.path = null;
    }
  }

  /**
   * Spawn one zombie at a spawner in an open zone, preferring spawners near
   * living players. Deterministic: the pick is seeded from (tick, pool index).
   * Returns the spawned id, or 0 when the pool or spawner set is exhausted.
   */
  spawn(
    tick: number,
    zoneMask: number,
    health: number,
    speed: number,
    targets: readonly HordeTarget[],
  ): PlayerId {
    let rec: ZombieRec | null = null;
    for (const z of this.pool) {
      if (!z.active) {
        rec = z;
        break;
      }
    }
    if (!rec) return 0;

    const candidates = this.map.zombieSpawners.filter((s) => (zoneMask & (1 << s.zone)) !== 0);
    if (candidates.length === 0) return 0;

    // Rank spawners by distance to the nearest non-downed player, then pick
    // one of the best three with a seeded roll so trains cannot be farmed
    // from one perfectly predictable window.
    const ranked = candidates
      .map((s) => {
        let d = Infinity;
        for (const t of targets) {
          if (!t.state.alive || t.downed) continue;
          const dx = s.pos.x - t.state.position.x;
          const dz = s.pos.z - t.state.position.z;
          const dist = dx * dx + dz * dz;
          if (dist < d) d = dist;
        }
        return { s, d };
      })
      .sort((a, b) => a.d - b.d || a.s.pos.x - b.s.pos.x || a.s.pos.z - b.s.pos.z);

    const rng = makeRng(hashSeed3(tick | 0, rec.slot | 0, 0x5eed));
    const pick = ranked[rng.nextUint32() % Math.min(3, ranked.length)].s;

    const st = rec.state;
    st.position.x = pick.pos.x;
    st.position.y = pick.pos.y;
    st.position.z = pick.pos.z;
    st.velocity.x = 0;
    st.velocity.y = 0;
    st.velocity.z = 0;
    st.yaw = 0;
    st.health = health;
    st.alive = true;
    st.onGround = true;
    rec.active = true;
    rec.speed = speed;
    rec.path = null;
    rec.pathIndex = 0;
    rec.repathAtTick = 0;
    rec.attackReadyAtTick = tick + Math.round(TICK_RATE * 0.5);
    rec.targetId = 0;
    return st.id;
  }

  /**
   * Apply damage to a zombie. Mutates the live state; returns true when this
   * blow killed it. Death deactivates the record (the snapshot layer signals
   * removal by absence).
   */
  damage(id: PlayerId, amount: number): { killed: boolean; healthAfter: number } | null {
    const z = isZombieId(id) ? this.pool[id - ZOMBIE_ID_BASE] : undefined;
    if (!z || !z.active || !z.state.alive) return null;
    if (!(amount > 0)) return { killed: false, healthAfter: z.state.health };
    z.state.health -= amount;
    if (z.state.health <= 0) {
      z.state.health = 0;
      z.state.alive = false;
      z.active = false;
      return { killed: true, healthAfter: 0 };
    }
    return { killed: false, healthAfter: z.state.health };
  }

  /** Kill every active zombie (the Nuke). Returns how many died. */
  killAll(): number {
    let n = 0;
    for (const z of this.pool) {
      if (!z.active) continue;
      z.state.health = 0;
      z.state.alive = false;
      z.active = false;
      n++;
    }
    return n;
  }

  /**
   * One tick of horde AI: choose targets, follow the nav graph, steer with the
   * capsule sweep, and emit melee attacks for the director to resolve.
   */
  step(
    tick: number,
    dt: number,
    world: CollisionWorld,
    zoneMask: number,
    targets: readonly HordeTarget[],
  ): ZombieAttack[] {
    const attacks: ZombieAttack[] = [];
    let repaths = 0;

    for (const z of this.pool) {
      if (!z.active) continue;
      const st = z.state;

      // --- pick a target: nearest living, non-downed player -----------------
      let target: HordeTarget | null = null;
      let bestD = Infinity;
      for (const t of targets) {
        if (!t.state.alive || t.downed) continue;
        const dx = t.state.position.x - st.position.x;
        const dy = t.state.position.y - st.position.y;
        const dz = t.state.position.z - st.position.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          target = t;
        }
      }
      if (!target) {
        // Whole squad is down; shamble in place while the wipe resolves.
        continue;
      }
      z.targetId = target.state.id;
      const tp = target.state.position;

      // --- attack when in reach --------------------------------------------
      const flatDx = tp.x - st.position.x;
      const flatDz = tp.z - st.position.z;
      const flatDist = Math.sqrt(flatDx * flatDx + flatDz * flatDz);
      const vertical = Math.abs(tp.y - st.position.y);
      if (flatDist <= ZOMBIE_MELEE_RANGE && vertical <= 1.6) {
        st.yaw = Math.atan2(-flatDx, -flatDz);
        if (tick >= z.attackReadyAtTick) {
          z.attackReadyAtTick = tick + Math.round(ZOMBIE_MELEE_INTERVAL * TICK_RATE);
          attacks.push({ zombieId: st.id, targetId: target.state.id });
        }
        continue;
      }

      // --- choose a waypoint ------------------------------------------------
      let wx = tp.x;
      let wy = tp.y;
      let wz = tp.z;
      const closeAndLevel = flatDist < DIRECT_CHASE_RANGE && vertical < 1.2;
      if (!closeAndLevel) {
        const stale = z.path === null || tick >= z.repathAtTick || z.pathIndex >= (z.path?.length ?? 0);
        if (stale && repaths < REPATHS_PER_TICK) {
          repaths++;
          z.repathAtTick = tick + REPATH_TICKS;
          const from = nearestNode(this.graph, st.position, zoneMask);
          const to = nearestNode(this.graph, tp, zoneMask);
          z.path = from >= 0 && to >= 0 ? findPath(this.graph, from, to, zoneMask) : null;
          z.pathIndex = 0;
          // Skip the first node when we are already on top of it.
          if (z.path && z.path.length > 1) {
            const n0 = this.graph.nodes[z.path[0]].pos;
            const ddx = n0.x - st.position.x;
            const ddz = n0.z - st.position.z;
            if (Math.sqrt(ddx * ddx + ddz * ddz) < WAYPOINT_REACH) z.pathIndex = 1;
          }
        }
        if (z.path && z.pathIndex < z.path.length) {
          const node = this.graph.nodes[z.path[z.pathIndex]].pos;
          const ndx = node.x - st.position.x;
          const ndz = node.z - st.position.z;
          if (Math.sqrt(ndx * ndx + ndz * ndz) < WAYPOINT_REACH) {
            z.pathIndex++;
          }
          if (z.pathIndex < z.path.length) {
            const wp = this.graph.nodes[z.path[z.pathIndex]].pos;
            wx = wp.x;
            wy = wp.y;
            wz = wp.z;
          }
        }
      }

      // --- locomotion: horizontal sweep + slide + ground snap ---------------
      this.move(st, wx, wy, wz, z.speed, dt, world);
    }
    return attacks;
  }

  private move(
    st: PlayerState,
    wx: number,
    wy: number,
    wz: number,
    speed: number,
    dt: number,
    world: CollisionWorld,
  ): void {
    const dx = wx - st.position.x;
    const dz = wz - st.position.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return;
    const nx = dx / len;
    const nz = dz / len;
    const stepLen = Math.min(speed * dt, len);

    st.yaw = Math.atan2(-nx, -nz);
    st.velocity.x = nx * speed;
    st.velocity.z = nz * speed;

    const from = { x: st.position.x, y: st.position.y + 0.05, z: st.position.z };
    const to = { x: from.x + nx * stepLen, y: from.y, z: from.z + nz * stepLen };
    const sweep = capsuleSweep(world, from, to, PLAYER_RADIUS, PLAYER_HEIGHT_STAND - 0.1);
    let px = sweep.position.x;
    let py = sweep.position.y;
    let pz = sweep.position.z;

    if (sweep.hit) {
      // Slide the blocked remainder along the wall once.
      const rem = stepLen * (1 - sweep.fraction);
      const dot = nx * sweep.normal.x + nz * sweep.normal.z;
      let sx = nx - sweep.normal.x * dot;
      let sz = nz - sweep.normal.z * dot;
      const sl = Math.sqrt(sx * sx + sz * sz);
      if (sl > 1e-4 && rem > 1e-4) {
        sx /= sl;
        sz /= sl;
        const slide = capsuleSweep(
          world,
          { x: px, y: py, z: pz },
          { x: px + sx * rem, y: py, z: pz + sz * rem },
          PLAYER_RADIUS,
          PLAYER_HEIGHT_STAND - 0.1,
        );
        px = slide.position.x;
        py = slide.position.y;
        pz = slide.position.z;
      }
    }

    // Ground snap: allow a 0.5m step up, otherwise fall.
    const drop = capsuleSweep(
      world,
      { x: px, y: py + 0.5, z: pz },
      { x: px, y: py - 2.0, z: pz },
      PLAYER_RADIUS,
      PLAYER_HEIGHT_STAND - 0.1,
    );
    if (drop.hit) {
      st.position.x = px;
      st.position.y = drop.position.y;
      st.position.z = pz;
      st.onGround = true;
      st.velocity.y = 0;
    } else {
      st.position.x = px;
      st.position.y = py - GRAVITY_FALL * dt;
      st.position.z = pz;
      st.onGround = false;
      st.velocity.y = -GRAVITY_FALL;
    }
  }

  /** Eye position helper for the director's revive/attack raycasts. */
  static eyeOf(state: PlayerState, out: Vec3): Vec3 {
    out.x = state.position.x;
    out.y = state.position.y + eyeHeightForStance(state.stance);
    out.z = state.position.z;
    return out;
  }
}
