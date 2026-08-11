/**
 * DECKSHOT — ZOMBIES horde: pool, spawning, gaits, window tearing, AI
 * stepping, wind-up melee.
 *
 * Owner: zombies (full rewrite; replaces the deleted sim/zombies.ts).
 *
 * Zombies are `PlayerState`-shaped entities (ids >= ZOMBIE_ID_BASE, team
 * Bravo) so the whole combat/replication stack — 7-capsule hitboxes,
 * penetration collaterals, delta snapshots, interpolation, lag comp — works
 * on them unchanged. SERVER-ONLY (the client interpolates zombies, never
 * predicts them), but still no `Math.random()`: every draw comes from
 * `shared/rng.ts` seeded by simulation state.
 *
 * New in the rewrite:
 *  - Speed cohorts: each spawn rolls a gait (walker/jogger/runner; sprinters
 *    on Blood Fog rounds) instead of one uniform speed per round.
 *  - Windows: a zombie spawned behind a boarded window walks to it, tears
 *    planks on a cadence, and climbs through only when they're gone. The
 *    horde moves through a world WITHOUT the player-only blocker brushes.
 *  - Telegraphed melee: a swing sets `swungAtTick` (rides the snapshot
 *    firedThisTick flag so the client can animate) and the damage lands
 *    ZOMBIE_MELEE_WINDUP later only if the victim is still in reach.
 *  - Nobody standing: the horde disengages and wanders away from the downed
 *    instead of freezing mid-map.
 */

import { capsuleSweep, type CollisionWorld } from '../../../../shared/collision.js';
import { PLAYER_HEIGHT_STAND, PLAYER_RADIUS, TICK_RATE } from '../../../../shared/tuning.js';
import {
  AdsState,
  Stance,
  TeamId,
  WeaponId,
  DEFAULT_LOADOUT,
  type PlayerId,
  type PlayerState,
} from '../../../../shared/types.js';
import { hashSeed3, makeRng } from '../../../../shared/rng.js';
import { findPath, nearestNode, type NavGraph } from '../../../../shared/navgraph.js';
import {
  DIRECT_CHASE_MAX_DY,
  DIRECT_CHASE_RANGE,
  PLANK_TEAR_INTERVAL,
  REPATHS_PER_TICK,
  REPATH_TICKS,
  WAYPOINT_RADIUS,
  ZOMBIE_DROP_DOWN,
  ZOMBIE_FALL_SPEED,
  ZOMBIE_FIRST_SWING_DELAY,
  ZOMBIE_ID_BASE,
  ZOMBIE_MELEE_INTERVAL,
  ZOMBIE_MELEE_REACH,
  ZOMBIE_MELEE_REACH_Y,
  ZOMBIE_MELEE_WINDUP,
  ZOMBIE_POOL_SIZE,
  ZOMBIE_STEP_UP,
  isZombieId,
} from '../../../../shared/zombies.js';
import type { MapDef, WindowDef } from '../../../../shared/maps.js';

export { isZombieId };

const WINDUP_TICKS = Math.round(ZOMBIE_MELEE_WINDUP * TICK_RATE);
const MELEE_TICKS = Math.round(ZOMBIE_MELEE_INTERVAL * TICK_RATE);
const TEAR_TICKS = Math.round(PLANK_TEAR_INTERVAL * TICK_RATE);
/** How far outside the window plane the tear spot sits. */
const TEAR_STANDOFF = 0.7;
/** Reach to the tear spot / inside node while crossing a window. */
const CROSS_RADIUS = 0.9;

/** A melee swing that finished its wind-up and connected. */
export interface ZombieAttack {
  zombieId: PlayerId;
  targetId: PlayerId;
}

/** Minimal view of a squad member the horde needs. */
export interface HordeTarget {
  state: PlayerState;
  downed: boolean;
}

/** The director's window state, exposed to the horde per tick. */
export interface WindowsView {
  defs: readonly WindowDef[];
  planksOf(windowId: number): number;
  /** Remove one plank. The director owns the state and dirty-marking. */
  tear(windowId: number): void;
}

interface ZombieRec {
  state: PlayerState;
  active: boolean;
  /** Lag-comp slot; fixed per pool index. */
  slot: number;
  path: number[] | null;
  pathIndex: number;
  repathAtTick: number;
  /** Tick the next swing/tear may START. */
  attackReadyAtTick: number;
  /** Pending melee: tick the wind-up completes; 0 = none. */
  windupEndsAtTick: number;
  windupTargetId: PlayerId;
  /** Last tick a swing/tear started — rides the snapshot fired flag. */
  swungAtTick: number;
  /** Window still to climb through; -1 once inside. */
  windowId: number;
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
    name: 'Breaker',
    team: TeamId.Bravo,
    score: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    loadout: DEFAULT_LOADOUT,
    ping: 0,
  };
}

export class ZombieHorde {
  private readonly pool: ZombieRec[] = [];
  private readonly map: MapDef;
  private readonly graph: NavGraph;
  private repathBudget = 0;

  constructor(map: MapDef, graph: NavGraph, slotBase: number) {
    this.map = map;
    this.graph = graph;
    for (let i = 0; i < ZOMBIE_POOL_SIZE; i++) {
      this.pool.push({
        state: makeZombieState(ZOMBIE_ID_BASE + i),
        active: false,
        slot: slotBase + i,
        path: null,
        pathIndex: 0,
        repathAtTick: 0,
        attackReadyAtTick: 0,
        windupEndsAtTick: 0,
        windupTargetId: 0,
        swungAtTick: -1,
        windowId: -1,
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
  *actives(): IterableIterator<{ state: PlayerState; slot: number; swungAtTick: number }> {
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
      z.windowId = -1;
      z.windupEndsAtTick = 0;
    }
  }

  /**
   * Spawn one zombie at a spawner in an open zone, preferring spawners near
   * standing players. Deterministic: seeded from (tick, pool index). Window
   * spawners hand the zombie a window to tear through. Returns the spawned
   * id, or 0 when the pool or spawner set is exhausted.
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

    // Rank spawners by distance to the nearest standing player, then pick one
    // of the best three with a seeded roll so a train cannot farm one
    // perfectly predictable window.
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
    rec.attackReadyAtTick = tick + Math.round(TICK_RATE * ZOMBIE_FIRST_SWING_DELAY);
    rec.windupEndsAtTick = 0;
    rec.windupTargetId = 0;
    rec.swungAtTick = -1;
    rec.windowId = pick.window !== undefined && pick.window >= 0 ? pick.window : -1;
    rec.targetId = 0;
    return st.id;
  }

  /**
   * Apply damage. Mutates the live state; reports the kill and where it died
   * (for power-up drops). Removal is signalled by absence from the snapshot.
   */
  damage(
    id: PlayerId,
    amount: number,
  ): { killed: boolean; healthAfter: number; x: number; y: number; z: number } | null {
    const z = isZombieId(id) ? this.pool[id - ZOMBIE_ID_BASE] : undefined;
    if (!z || !z.active || !z.state.alive) return null;
    const p = z.state.position;
    if (!(amount > 0)) return { killed: false, healthAfter: z.state.health, x: p.x, y: p.y, z: p.z };
    z.state.health -= amount;
    if (z.state.health <= 0) {
      z.state.health = 0;
      z.state.alive = false;
      z.active = false;
      return { killed: true, healthAfter: 0, x: p.x, y: p.y, z: p.z };
    }
    return { killed: false, healthAfter: z.state.health, x: p.x, y: p.y, z: p.z };
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
   * One tick of horde AI. `world` must be the HORDE world (window blockers
   * excluded). Emits melee attacks whose wind-up completed this tick.
   */
  step(
    tick: number,
    dt: number,
    world: CollisionWorld,
    zoneMask: number,
    targets: readonly HordeTarget[],
    windows: WindowsView,
  ): ZombieAttack[] {
    const attacks: ZombieAttack[] = [];
    this.repathBudget = REPATHS_PER_TICK;

    for (const z of this.pool) {
      if (!z.active) continue;
      const st = z.state;

      // --- resolve a pending wind-up first ----------------------------------
      if (z.windupEndsAtTick > 0 && tick >= z.windupEndsAtTick) {
        z.windupEndsAtTick = 0;
        const victim = targets.find((t) => t.state.id === z.windupTargetId);
        if (victim && victim.state.alive) {
          const dx = victim.state.position.x - st.position.x;
          const dz = victim.state.position.z - st.position.z;
          const dy = Math.abs(victim.state.position.y - st.position.y);
          const flat = Math.sqrt(dx * dx + dz * dz);
          if (flat <= ZOMBIE_MELEE_REACH * 1.25 && dy <= ZOMBIE_MELEE_REACH_Y) {
            attacks.push({ zombieId: st.id, targetId: victim.state.id });
          }
        }
      }

      // --- still behind a window? -------------------------------------------
      if (z.windowId >= 0) {
        const win = windows.defs[z.windowId];
        if (!win) {
          z.windowId = -1;
        } else if (windows.planksOf(z.windowId) > 0) {
          this.tearAtWindow(z, win, windows, tick, dt, world);
          continue;
        } else {
          // Boards are down: climb through toward the inside node.
          const inside = this.graph.nodes[win.insideNode]?.pos ?? win.pos;
          const dx = inside.x - st.position.x;
          const dz = inside.z - st.position.z;
          if (Math.sqrt(dx * dx + dz * dz) <= CROSS_RADIUS) {
            z.windowId = -1;
          } else {
            this.move(st, inside.x, inside.y, inside.z, z.speed, dt, world);
            continue;
          }
        }
      }

      // --- pick a target: nearest standing player ----------------------------
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
        // Nobody standing. Shamble away from the downed while any self-revive
        // pends — freezing mid-swing looks broken, and the wipe check will end
        // the match if nobody is coming back.
        this.wander(z, tick, dt, world, zoneMask, targets);
        continue;
      }
      z.targetId = target.state.id;
      const tp = target.state.position;

      // --- melee: start a telegraphed wind-up when in reach ------------------
      const flatDx = tp.x - st.position.x;
      const flatDz = tp.z - st.position.z;
      const flatDist = Math.sqrt(flatDx * flatDx + flatDz * flatDz);
      const vertical = Math.abs(tp.y - st.position.y);
      if (flatDist <= ZOMBIE_MELEE_REACH && vertical <= ZOMBIE_MELEE_REACH_Y) {
        st.yaw = Math.atan2(-flatDx, -flatDz);
        st.velocity.x = 0;
        st.velocity.z = 0;
        if (z.windupEndsAtTick === 0 && tick >= z.attackReadyAtTick) {
          z.attackReadyAtTick = tick + MELEE_TICKS;
          z.windupEndsAtTick = tick + WINDUP_TICKS;
          z.windupTargetId = target.state.id;
          z.swungAtTick = tick;
        }
        continue;
      }

      // --- choose a waypoint --------------------------------------------------
      let wx = tp.x;
      let wy = tp.y;
      let wz = tp.z;
      const closeAndLevel = flatDist < DIRECT_CHASE_RANGE && vertical < DIRECT_CHASE_MAX_DY;
      if (!closeAndLevel) {
        this.followPath(z, tick, zoneMask, tp);
        if (z.path && z.pathIndex < z.path.length) {
          const wp = this.graph.nodes[z.path[z.pathIndex]].pos;
          wx = wp.x;
          wy = wp.y;
          wz = wp.z;
        }
      }

      this.move(st, wx, wy, wz, z.speed, dt, world);
    }
    return attacks;
  }

  /** Stand at the tear spot and pull boards on the tear cadence. */
  private tearAtWindow(
    z: ZombieRec,
    win: WindowDef,
    windows: WindowsView,
    tick: number,
    dt: number,
    world: CollisionWorld,
  ): void {
    const st = z.state;
    // Tear spot: just outside the window plane. Window yaw faces INTO the
    // room, so outside is the negative facing direction.
    const fx = -Math.sin(win.yaw);
    const fz = -Math.cos(win.yaw);
    const sx = win.pos.x - fx * TEAR_STANDOFF;
    const sz = win.pos.z - fz * TEAR_STANDOFF;
    const dx = sx - st.position.x;
    const dz = sz - st.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > CROSS_RADIUS) {
      this.move(st, sx, win.pos.y, sz, z.speed, dt, world);
      return;
    }
    // In position: face the boards and pull.
    st.yaw = win.yaw;
    st.velocity.x = 0;
    st.velocity.z = 0;
    if (tick >= z.attackReadyAtTick) {
      z.attackReadyAtTick = tick + TEAR_TICKS;
      z.swungAtTick = tick;
      windows.tear(z.windowId);
    }
  }

  /** Path toward `tp`, staggered across the horde's repath budget. */
  private followPath(z: ZombieRec, tick: number, zoneMask: number, tp: { x: number; y: number; z: number }): void {
    const st = z.state;
    const stale = z.path === null || tick >= z.repathAtTick || z.pathIndex >= (z.path?.length ?? 0);
    if (stale && this.repathBudget > 0) {
      this.repathBudget--;
      z.repathAtTick = tick + REPATH_TICKS;
      const from = nearestNode(this.graph, st.position, zoneMask);
      const to = nearestNode(this.graph, tp, zoneMask);
      z.path = from >= 0 && to >= 0 ? findPath(this.graph, from, to, zoneMask) : null;
      z.pathIndex = 0;
      if (z.path && z.path.length > 1) {
        const n0 = this.graph.nodes[z.path[0]].pos;
        const ddx = n0.x - st.position.x;
        const ddz = n0.z - st.position.z;
        if (Math.sqrt(ddx * ddx + ddz * ddz) < WAYPOINT_RADIUS) z.pathIndex = 1;
      }
    }
    if (z.path && z.pathIndex < z.path.length) {
      const node = this.graph.nodes[z.path[z.pathIndex]].pos;
      const ndx = node.x - st.position.x;
      const ndz = node.z - st.position.z;
      if (Math.sqrt(ndx * ndx + ndz * ndz) < WAYPOINT_RADIUS) z.pathIndex++;
    }
  }

  /** Nobody standing: drift toward the node farthest from the downed. */
  private wander(
    z: ZombieRec,
    tick: number,
    dt: number,
    world: CollisionWorld,
    zoneMask: number,
    targets: readonly HordeTarget[],
  ): void {
    const st = z.state;
    let anchor: { x: number; y: number; z: number } | null = null;
    for (const t of targets) {
      if (t.state.alive && t.downed) {
        anchor = t.state.position;
        break;
      }
    }
    if (!anchor) return; // everyone is truly dead; hold still, the wipe fires
    const stale = z.path === null || z.pathIndex >= (z.path?.length ?? 0) || tick >= z.repathAtTick;
    if (stale && this.repathBudget > 0) {
      this.repathBudget--;
      z.repathAtTick = tick + REPATH_TICKS * 2;
      // Farthest open node from the downed player.
      let best = -1;
      let bestD = -1;
      for (const n of this.graph.nodes) {
        if ((zoneMask & (1 << n.zone)) === 0) continue;
        const dx = n.pos.x - anchor.x;
        const dz = n.pos.z - anchor.z;
        const d = dx * dx + dz * dz;
        if (d > bestD) {
          bestD = d;
          best = n.id;
        }
      }
      const from = nearestNode(this.graph, st.position, zoneMask);
      z.path = from >= 0 && best >= 0 ? findPath(this.graph, from, best, zoneMask) : null;
      z.pathIndex = 0;
    }
    if (z.path && z.pathIndex < z.path.length) {
      const node = this.graph.nodes[z.path[z.pathIndex]].pos;
      const ndx = node.x - st.position.x;
      const ndz = node.z - st.position.z;
      if (Math.sqrt(ndx * ndx + ndz * ndz) < WAYPOINT_RADIUS) z.pathIndex++;
      if (z.pathIndex < z.path.length) {
        const wp = this.graph.nodes[z.path[z.pathIndex]].pos;
        this.move(st, wp.x, wp.y, wp.z, z.speed * 0.6, dt, world);
      }
    }
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

    // Ground snap: allow a step up, otherwise fall.
    const drop = capsuleSweep(
      world,
      { x: px, y: py + ZOMBIE_STEP_UP, z: pz },
      { x: px, y: py - ZOMBIE_DROP_DOWN, z: pz },
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
      st.position.y = py - ZOMBIE_FALL_SPEED * dt;
      st.position.z = pz;
      st.onGround = false;
      st.velocity.y = -ZOMBIE_FALL_SPEED;
    }
  }
}
