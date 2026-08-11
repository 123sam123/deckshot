/**
 * DECKSHOT — simulation extension points.
 *
 * Owner: netcode-core.
 *
 * The authoritative loop needs two things it does not own: the weapon state
 * machine (`shared/weapons.ts`) and authoritative firing (`server/src/sim/
 * combat.ts`). Both are built by weapons-hitreg in parallel with this file.
 *
 * Rather than import modules that may not exist yet — which would take the
 * whole repo down, and INTEGRATION.md rule 3 forbids that — the loop takes
 * them as injected, structurally typed hooks. `server/src/index.ts` wires the
 * real modules in at integration:
 *
 *   createGameServer(http, { hooks: { weapons, resolveFire } })
 *
 * With no hooks the game still boots, moves, collides, scores and replicates;
 * it just does no damage. That is a reduced version, not a stub that throws.
 *
 * The one thing this file DOES fix is the lag-compensation contract: combat
 * receives rewound player states as a parameter. It never reaches into the
 * history buffer itself, because only the netcode layer knows each client's
 * RTT and therefore how far back "now" was for the person who pulled the
 * trigger.
 */

import type { CorrectionReason, HitMsg } from '../../../shared/protocol.js';
import type { MovementState } from '../../../shared/movement.js';
import type { TrickshotContext } from '../../../shared/trickshot.js';
import type {
  AttachmentId,
  ClientInput,
  HitboxPart,
  PlayerId,
  PlayerState,
  Vec3,
  WeaponId,
} from '../../../shared/types.js';
import {
  advanceWeapon,
  applyLoadoutToState,
  createWeaponRuntime,
  resolveLoadout,
  resolveSecondary,
  resolveWeapon,
  syncStateFromRuntime,
} from '../../../shared/weapons.js';
import { CombatSystem } from '../sim/combat.js';
import type { Loadout } from '../../../shared/types.js';

/**
 * `ResolvedWeapon` and `WeaponRuntime` are owned by weapons-hitreg; their
 * internals are none of the netcode layer's business. It only ever passes
 * them back to the module that made them, and reads the handful of fields
 * below through `WeaponRuntimeView`.
 */
export type ResolvedWeaponHandle = unknown;
export type WeaponRuntimeHandle = unknown;

/**
 * The fields the replication layer needs out of a weapon runtime. Every one is
 * optional and read with a fallback, so a runtime shaped slightly differently
 * degrades a feature rather than crashing a match.
 */
export interface WeaponRuntimeView {
  adsState?: number;
  adsProgress?: number;
  ammoInMag?: number;
  ammoReserve?: number;
  actionEndsAt?: number;
  /** Set by the weapon module on the tick a round leaves the barrel. */
  firedThisTick?: boolean;
  fired?: boolean;
  shotsThisTick?: number;
  /** Set by the weapon module on the tick a quick-melee begins. */
  meleeThisTick?: boolean;
  /** Movement speed override from the Lightweight Stock attachment. */
  adsMoveSpeedOverride?: number;
  adsMoveSpeed?: number;
  /** Seconds since accuracy lock, for quickscope scoring. */
  timeSinceAccuracyLock?: number;
  activeWeapon?: WeaponId;
}

/** The subset of `shared/weapons.ts` the server loop calls. */
export interface WeaponsModule {
  resolveWeapon(weapon: WeaponId, attachments: AttachmentId[]): ResolvedWeaponHandle;
  /** The held weapon for a loadout. Falls back to `resolveWeapon`. */
  resolveLoadout?(loadout: Loadout): ResolvedWeaponHandle;
  /** The stowed sidearm. Needed so a completed swap can re-resolve the spec. */
  resolveSecondary?(loadout: Loadout): ResolvedWeaponHandle;
  /** Pushes `adsMoveSpeed` onto the player state for the movement module. */
  applyLoadoutToState?(state: PlayerState, rw: ResolvedWeaponHandle): PlayerState;
  /** Copies replicated weapon fields onto a PlayerState. */
  syncStateFromRuntime?(state: PlayerState, ws: WeaponRuntimeHandle, nowMs: number): PlayerState;
  createWeaponRuntime?(rw: ResolvedWeaponHandle, state?: PlayerState): WeaponRuntimeHandle;
  advanceWeapon(
    ws: WeaponRuntimeHandle,
    input: ClientInput,
    dt: number,
    rw: ResolvedWeaponHandle
  ): WeaponRuntimeHandle;
}

/** One player killed by one bullet. Fed straight into `ScoreKeeper.onKill`. */
export interface FireVictim {
  id: PlayerId;
  part: HitboxPart;
  distance: number;
}

/**
 * Everything `server/src/sim/combat.ts` needs to resolve one trigger pull.
 *
 * `targets` is the whole point of this file: every OTHER living player, cloned
 * and rewound to where the shooter actually saw them. Combat may mutate the
 * clones freely — they are scratch copies, not the live simulation state.
 */
export interface FireContext {
  /** Live authoritative state of whoever fired. Do not mutate. */
  shooter: PlayerState;
  /** Lag-compensated clones of every other player. Safe to mutate. */
  targets: PlayerState[];
  /** How far back `targets` were rewound, in ms (already clamped). */
  rewindMs: number;
  /** Server tick the shot resolved on. */
  tick: number;
  /** Server clock in ms at the shot. */
  nowMs: number;
  /** Server clock in seconds — what ScoreKeeper and trickshot use. */
  nowSeconds: number;
  /** The input that carried the trigger pull. Seeds the spread RNG. */
  input: ClientInput;
  weaponRuntime: WeaponRuntimeHandle;
  resolvedWeapon: ResolvedWeaponHandle;
  /** The room's static geometry. Absent = the Sundeck singleton. */
  world?: unknown;
}

/**
 * What combat hands back. Structurally satisfied by `FireResult` from
 * `server/src/sim/combat.ts`.
 *
 * The room re-applies the damage to the LIVE player states. Combat resolves
 * against the rewound clones — that is the whole point of lag compensation —
 * and applies its damage there, so the clones' health is correct but nobody
 * real has been hurt yet. Death, respawn, scoring and replication all stay in
 * one place rather than being split across a scratch copy.
 */
export interface FireOutcome {
  fired?: boolean;
  /** Non-null when the shot was rejected; the room sends a Correction. */
  reason?: CorrectionReason | null;
  /** Ready-to-broadcast hit markers. */
  hitMessages?: HitMsg[];
  hits?: ReadonlyArray<{
    victimId: PlayerId;
    part: HitboxPart;
    damage: number;
    distance: number;
    killed: boolean;
  }>;
  /** Players killed by this bullet, in the order the round reached them. */
  victims?: ReadonlyArray<FireVictim>;
  /** Everything ScoreKeeper.onKill wants that only combat knows. */
  context?: Partial<TrickshotContext>;
  /** Impact point of the round for tracers, when nothing was hit. */
  endPoint?: Vec3;
}

/** Authoritative firing. Injected; `server/src/sim/combat.ts` provides it. */
export type FireResolver = (ctx: FireContext) => FireOutcome | null | undefined | void;

export interface SimHooks {
  weapons?: WeaponsModule;
  resolveFire?: FireResolver;
  /**
   * Authoritative melee. Same context shape as a shot; the resolver ignores
   * the ballistic fields. ZOMBIES is the first consumer (the knife pays 130).
   */
  resolveMelee?: FireResolver;
  /**
   * Optional per-tick escape hatch, for anything the sim gains later that
   * should not require a change to this file.
   */
  postTick?: (tick: number, players: readonly MovementState[]) => void;
}

/**
 * The production wiring: the real `shared/weapons.ts` state machine and a real
 * `CombatSystem`.
 *
 * A fresh `CombatSystem` per call, because it carries per-player fire-rate and
 * damage bookkeeping that must not be shared between lobbies — two matches
 * sharing one would let a player in lobby A rate-limit a player in lobby B.
 */
export function createDefaultHooks(): SimHooks & { combat: CombatSystem } {
  const combat = new CombatSystem();
  return {
    combat,
    weapons: {
      resolveWeapon,
      resolveLoadout,
      resolveSecondary,
      applyLoadoutToState: (state, rw) => applyLoadoutToState(state, rw as never),
      syncStateFromRuntime: (state, ws, nowMs) => syncStateFromRuntime(state, ws as never, nowMs),
      createWeaponRuntime: (rw) => createWeaponRuntime(rw as never),
      advanceWeapon: (ws, input, dt, rw) => advanceWeapon(ws as never, input, dt, rw as never),
    },
    resolveFire: (ctx) =>
      combat.fireWeapon({
        shooter: ctx.shooter,
        runtime: ctx.weaponRuntime as never,
        resolved: ctx.resolvedWeapon as never,
        input: ctx.input,
        targets: ctx.targets,
        now: ctx.nowSeconds,
        world: ctx.world as never,
      }),
    resolveMelee: (ctx) =>
      combat.meleeAttack({
        attacker: ctx.shooter,
        runtime: ctx.weaponRuntime as never,
        targets: ctx.targets,
        now: ctx.nowSeconds,
        world: ctx.world as never,
      }),
  };
}

/** Reads a weapon runtime defensively. Never throws on an unexpected shape. */
export function readRuntime(ws: WeaponRuntimeHandle): WeaponRuntimeView {
  return (ws && typeof ws === 'object' ? ws : {}) as WeaponRuntimeView;
}

/** True when the runtime says a round left the barrel this tick. */
export function runtimeFired(ws: WeaponRuntimeHandle): number {
  const v = readRuntime(ws);
  if (typeof v.shotsThisTick === 'number') return v.shotsThisTick > 0 ? v.shotsThisTick : 0;
  if (v.firedThisTick === true) return 1;
  if (v.fired === true) return 1;
  return 0;
}
