/**
 * DECKSHOT — SURVIVAL director: rounds, economy, downs/revives, purchases,
 * power-ups, wipe detection.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * The director is a peer of `ScoreKeeper` (a `ScoringSink` consumer, not a
 * replacement): trickshot evaluation and the kill feed still run through the
 * lobby's keeper; this module turns the resulting scores into spendable points
 * and owns everything the competitive modes do not have — the round machine,
 * the horde, zone progression, last stand.
 *
 * `GameRoom` drives it and hands it live player state; weapon-runtime surgery
 * (granting guns, stashing on down) stays in the room via `SurvivalCallbacks`,
 * because the room owns the weapon module wiring.
 */

import type { AnyServerMessage, SurvivalStateMsg } from '../../../shared/protocol.js';
import { ServerMessage } from '../../../shared/protocol.js';
import { createCollisionWorld, type CollisionWorld } from '../../../shared/collision.js';
import { buildNavGraph, type NavGraph } from '../../../shared/navgraph.js';
import {
  InteractableKind,
  collisionBrushesFor,
  zoneForPosition,
  type Interactable,
  type MapDef,
} from '../../../shared/maps.js';
import { hashSeed3, makeRng } from '../../../shared/rng.js';
import {
  BLEEDOUT_TIME,
  CORPSMAN_BIT,
  CRATE_COST,
  CRATE_MOVE_USES_MAX,
  CRATE_MOVE_USES_MIN,
  CRATE_POOL,
  GUARANTEED_MAX_AMMO_EVERY,
  INTERMISSION_TIME,
  InteractTarget,
  MAX_PLAYERS_SURVIVAL,
  NUKE_POINTS,
  POINTS_PER_HIT,
  POWERUP_CHANCE,
  POWERUP_DURATION,
  PerkId,
  PowerupId,
  PurchaseKind,
  REVIVE_HEALTH,
  REVIVE_POINTS,
  REVIVE_RADIUS,
  REVIVE_TIME,
  RUNNER_HEALTH_MULT,
  RUNNER_SPEED,
  SOLO_REVIVE_DELAY,
  SOLO_REVIVE_USES,
  SurvivalPhase,
  ZOMBIES_ALIVE_MAX,
  ZOMBIE_MELEE_DAMAGE,
  hasPerk,
  healthForRound,
  isRunnerRound,
  maxHealthForPerks,
  pointsForKillScore,
  spawnIntervalTicks,
  validatePurchase,
  zombieDamageMult,
  zombiesForRound,
  zombieSpeedForRound,
} from '../../../shared/survival.js';
import {
  HitboxPart,
  InputButton,
  Stance,
  hasButton,
  type ClientInput,
  type PlayerId,
  type PlayerState,
  type WeaponId,
} from '../../../shared/types.js';
import { TICK_DT } from '../../../shared/tuning.js';
import { ZombieHorde, type HordeTarget } from './zombies.js';

/** How close you must stand to buy/flip/take something, meters. */
export const INTERACT_RADIUS = 3.0;
/** Zone purchases happen at the zone's door; this is the reach to it. */
export const DOOR_BUY_RADIUS = 4.0;
/** Seconds a crate offer waits before it is lost. */
const CRATE_OFFER_TIME = 12;
/** SurvivalState refresh cadence when nothing changed, ms. */
const STATE_REFRESH_MS = 1000;

/** What the room exposes to the director about one squad member. */
export interface SquadMember {
  id: PlayerId;
  state: PlayerState;
  lastInput: ClientInput;
}

/** Weapon/state surgery the room performs on the director's behalf. */
export interface SurvivalCallbacks {
  send(id: PlayerId, msg: AnyServerMessage): void;
  broadcast(msg: AnyServerMessage): void;
  /** Grant a weapon (full ammo) into the held slot; old held is stowed. */
  giveWeapon(id: PlayerId, weapon: WeaponId): void;
  /** Refill every carried magazine and reserve. */
  refillAmmo(id: PlayerId): void;
  /** Swap to the Kestrel-only last-stand runtime, stashing the real guns. */
  stashWeaponsForDown(id: PlayerId): void;
  /** Restore the guns stashed at down time. */
  restoreWeaponsOnRevive(id: PlayerId): void;
  /** Re-resolve weapon specs after a perk/forge purchase. */
  onLoadoutChanged(id: PlayerId): void;
  /** Respawn a dead player (round transition). */
  respawn(id: PlayerId): void;
  /** Report a bleed-out/environment death to the kill feed. */
  reportDeath(id: PlayerId): void;
  /** All players down: end the match. */
  endMatch(): void;
  /** The player's authoritative arsenal, for SurvivalState sync. */
  ammoOf(id: PlayerId): {
    held: WeaponId;
    stowed: WeaponId;
    mag: number;
    reserve: number;
    stowedMag: number;
    stowedReserve: number;
  };
}

interface SquadRecord {
  id: PlayerId;
  balance: number;
  /** Cumulative earned, for the scoreboard's sake. */
  earned: number;
  perks: number;
  forged: boolean;
  ownedWeapons: WeaponId[];
  bleedout: number;
  /** 0..1; reset when nobody is reviving. */
  reviveProgress: number;
  beingRevived: boolean;
  soloRevivesLeft: number;
  /** ms timestamp when a solo self-revive completes; 0 = none pending. */
  selfReviveAtMs: number;
  dirty: boolean;
  lastStateSentMs: number;
  killSeed: number;
}

function makeRecord(id: PlayerId): SquadRecord {
  return {
    id,
    balance: 500,
    earned: 0,
    perks: 0,
    forged: false,
    ownedWeapons: [],
    bleedout: 0,
    reviveProgress: 0,
    beingRevived: false,
    soloRevivesLeft: 0,
    selfReviveAtMs: 0,
    dirty: true,
    lastStateSentMs: 0,
    killSeed: 0,
  };
}

export class SurvivalDirector {
  readonly map: MapDef;
  readonly horde: ZombieHorde;
  /** Rebuilt on every zone purchase; the room reads this for movement + shots. */
  world: CollisionWorld;

  private readonly graph: NavGraph;
  private readonly records = new Map<PlayerId, SquadRecord>();
  private readonly cb: SurvivalCallbacks;
  private readonly seed: number;

  round = 0;
  phase: SurvivalPhase = SurvivalPhase.Intermission;
  /** Seconds left in the intermission. */
  private phaseTimer = 3;
  private toSpawn = 0;
  private nextSpawnTick = 0;
  zoneMask = 1; // zone 0 open
  powerOn = false;
  private wiped = false;

  /** Active timed power-ups: id -> ms expiry. */
  private readonly powerups = new Map<PowerupId, number>();

  // Mystery crate.
  private crateSpotIndex = 0;
  private crateUsesLeft = 5;
  private crateSpins = 0;
  private crateOffer: { playerId: PlayerId; weapon: WeaponId; expiresAtMs: number } | null = null;

  constructor(map: MapDef, slotBase: number, cb: SurvivalCallbacks, seed = 0x1e71a7a4) {
    this.map = map;
    this.cb = cb;
    this.seed = seed | 0;
    this.graph = buildNavGraph(map.navNodes);
    this.horde = new ZombieHorde(map, this.graph, slotBase);
    this.world = createCollisionWorld(
      collisionBrushesFor(map, this.zoneMask),
      map.bounds,
      map.waterLevel,
    );
  }

  // -------------------------------------------------------------------------
  // Roster / lifecycle
  // -------------------------------------------------------------------------

  private record(id: PlayerId): SquadRecord {
    let r = this.records.get(id);
    if (!r) {
      r = makeRecord(id);
      this.records.set(id, r);
    }
    return r;
  }

  addPlayer(id: PlayerId): void {
    this.record(id);
  }

  removePlayer(id: PlayerId): void {
    this.records.delete(id);
  }

  /** Fresh match: round 1 economy, zones closed, horde cleared. */
  reset(): void {
    this.round = 0;
    this.phase = SurvivalPhase.Intermission;
    this.phaseTimer = 3;
    this.toSpawn = 0;
    this.zoneMask = 1;
    this.powerOn = false;
    this.wiped = false;
    this.powerups.clear();
    this.crateSpotIndex = 0;
    this.crateSpins = 0;
    this.crateOffer = null;
    this.crateUsesLeft = this.rollCrateUses();
    this.horde.clear();
    this.rebuildWorld();
    for (const r of this.records.values()) {
      const fresh = makeRecord(r.id);
      this.records.set(r.id, fresh);
    }
  }

  private rebuildWorld(): void {
    this.world = createCollisionWorld(
      collisionBrushesFor(this.map, this.zoneMask),
      this.map.bounds,
      this.map.waterLevel,
    );
  }

  // -------------------------------------------------------------------------
  // Read side (room + snapshot integration)
  // -------------------------------------------------------------------------

  balanceOf(id: PlayerId): number {
    return this.records.get(id)?.balance ?? 0;
  }

  perksOf(id: PlayerId): number {
    return this.records.get(id)?.perks ?? 0;
  }

  forgedOf(id: PlayerId): boolean {
    return this.records.get(id)?.forged ?? false;
  }

  maxHealthOf(id: PlayerId): number {
    return maxHealthForPerks(this.perksOf(id));
  }

  zombiesRemaining(): number {
    return this.toSpawn + this.horde.aliveCount;
  }

  instaKillActive(nowMs: number): boolean {
    const t = this.powerups.get(PowerupId.InstaKill);
    return t !== undefined && t > nowMs;
  }

  doublePointsActive(nowMs: number): boolean {
    const t = this.powerups.get(PowerupId.DoublePoints);
    return t !== undefined && t > nowMs;
  }

  /** Damage multiplier for one of `shooter`'s bullets into a zombie. */
  damageMultFor(shooterId: PlayerId, part: HitboxPart, nowMs: number): number {
    const r = this.records.get(shooterId);
    return zombieDamageMult(
      r?.perks ?? 0,
      r?.forged ?? false,
      part === HitboxPart.Head,
      this.instaKillActive(nowMs),
    );
  }

  // -------------------------------------------------------------------------
  // Economy events (room calls these from its fire resolution)
  // -------------------------------------------------------------------------

  /** A bullet connected with a zombie but did not necessarily kill. */
  onZombieHit(shooterId: PlayerId, nowMs: number): void {
    const r = this.record(shooterId);
    const mult = this.doublePointsActive(nowMs) ? 2 : 1;
    r.balance += POINTS_PER_HIT * mult;
    r.earned += POINTS_PER_HIT * mult;
    r.dirty = true;
  }

  /**
   * One bullet's kills, already scored by the keeper. `trickshotScore` is the
   * keeper's verdict; points are that score at SURVIVAL_POINT_SCALE.
   */
  onZombieKills(shooterId: PlayerId, trickshotScore: number, kills: number, tick: number, nowMs: number): void {
    const r = this.record(shooterId);
    const mult = this.doublePointsActive(nowMs) ? 2 : 1;
    const pts = pointsForKillScore(trickshotScore) * mult;
    r.balance += pts;
    r.earned += pts;
    r.dirty = true;

    // Power-up roll: one per kill, seeded from the simulation.
    for (let i = 0; i < kills; i++) {
      r.killSeed++;
      const rng = makeRng(hashSeed3(this.seed, tick | 0, (shooterId << 8) ^ r.killSeed));
      if (rng.nextFloat() < POWERUP_CHANCE) this.dropPowerup(rng.nextUint32(), nowMs);
    }
  }

  private dropPowerup(roll: number, nowMs: number): void {
    // Carpenter is in the enum for canon completeness but never drops:
    // barriers are not repairable in this build.
    const droppable = [PowerupId.MaxAmmo, PowerupId.InstaKill, PowerupId.DoublePoints, PowerupId.Nuke];
    const kind = droppable[roll % droppable.length];
    this.applyPowerup(kind, nowMs);
  }

  private applyPowerup(kind: PowerupId, nowMs: number): void {
    switch (kind) {
      case PowerupId.MaxAmmo:
        for (const r of this.records.values()) this.cb.refillAmmo(r.id);
        break;
      case PowerupId.Nuke: {
        this.horde.killAll();
        for (const r of this.records.values()) {
          r.balance += NUKE_POINTS;
          r.earned += NUKE_POINTS;
        }
        break;
      }
      case PowerupId.InstaKill:
      case PowerupId.DoublePoints:
        this.powerups.set(kind, nowMs + POWERUP_DURATION * 1000);
        break;
      default:
        break;
    }
    for (const r of this.records.values()) r.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Purchases and interactions
  // -------------------------------------------------------------------------

  purchase(member: SquadMember, kind: PurchaseKind, itemId: number, nowMs: number): void {
    const r = this.record(member.id);
    if (member.state.downed === true || member.state.alive === false) return;

    const livingCount = this.livingCount();
    const ctx = {
      balance: r.balance,
      zoneMask: this.zoneMask,
      powerOn: this.powerOn,
      perks: r.perks,
      ownedWeapons: r.ownedWeapons,
      forged: r.forged,
      playerCount: Math.max(1, livingCount),
    };

    if (kind === PurchaseKind.Zone) {
      const zone = this.map.zones[itemId];
      if (!zone) return;
      // Adjacent-zone rule: some neighbouring zone must already be open, and
      // the buyer must be standing at one of this zone's doors.
      const reachable = zone.adjacent.some((a) => this.zoneIsOpen(a));
      const nearDoor = this.nearZoneDoor(member.state.position, itemId);
      const verdict = validatePurchase(kind, itemId, ctx, {
        cost: zone.cost,
        requiresPower: zone.requiresPower,
        open: (this.zoneMask & (1 << itemId)) !== 0,
        reachable: reachable && nearDoor,
      });
      if (!verdict.ok) return;
      r.balance -= verdict.cost;
      this.zoneMask |= 1 << itemId;
      this.rebuildWorld();
      this.markAllDirty();
      return;
    }

    if (kind === PurchaseKind.Weapon) {
      const weapon = itemId as WeaponId;
      if (!this.nearInteractable(member.state.position, (i) => i.kind === InteractableKind.WallBuy && i.weapon === weapon && this.zoneIsOpen(i.zone))) {
        return;
      }
      const verdict = validatePurchase(kind, itemId, ctx);
      if (!verdict.ok) return;
      r.balance -= verdict.cost;
      if (r.ownedWeapons.includes(weapon)) {
        this.cb.refillAmmo(member.id);
      } else {
        this.grantWeapon(r, member.id, weapon);
      }
      r.dirty = true;
      return;
    }

    if (kind === PurchaseKind.Perk) {
      const perk = itemId as PerkId;
      if (!this.nearInteractable(member.state.position, (i) => i.kind === InteractableKind.Perk && i.perk === perk && this.zoneIsOpen(i.zone))) {
        return;
      }
      const verdict = validatePurchase(kind, itemId, ctx);
      if (!verdict.ok) return;
      r.balance -= verdict.cost;
      r.perks |= 1 << perk;
      if (perk === PerkId.Deadeye) {
        member.state.health = maxHealthForPerks(r.perks);
      }
      if (perk === PerkId.Corpsman) {
        r.soloRevivesLeft = SOLO_REVIVE_USES;
      }
      this.cb.onLoadoutChanged(member.id);
      r.dirty = true;
      return;
    }

    if (kind === PurchaseKind.Forge) {
      if (!this.nearInteractable(member.state.position, (i) => i.kind === InteractableKind.Forge && this.zoneIsOpen(i.zone))) {
        return;
      }
      const verdict = validatePurchase(kind, itemId, ctx);
      if (!verdict.ok) return;
      r.balance -= verdict.cost;
      r.forged = true;
      this.cb.onLoadoutChanged(member.id);
      this.cb.refillAmmo(member.id);
      r.dirty = true;
      return;
    }

    if (kind === PurchaseKind.Crate) {
      const spot = this.crateSpot();
      if (!spot || !this.zoneIsOpen(spot.zone)) return;
      if (this.distance(member.state.position, spot.pos) > INTERACT_RADIUS) return;
      if (this.crateOffer) return; // one spin at a time
      const verdict = validatePurchase(kind, itemId, ctx);
      if (!verdict.ok) return;
      r.balance -= verdict.cost;
      this.crateSpins++;
      const rng = makeRng(hashSeed3(this.seed, 0xc4a7e, this.crateSpins));
      const weapon = CRATE_POOL[rng.nextUint32() % CRATE_POOL.length];
      this.crateOffer = { playerId: member.id, weapon, expiresAtMs: nowMs + CRATE_OFFER_TIME * 1000 };
      this.crateUsesLeft--;
      r.dirty = true;
      return;
    }
  }

  interact(member: SquadMember, target: InteractTarget, nowMs: number): void {
    if (member.state.downed === true || member.state.alive === false) return;
    if (target === InteractTarget.Generator) {
      if (this.powerOn) return;
      if (!this.nearInteractable(member.state.position, (i) => i.kind === InteractableKind.Generator && this.zoneIsOpen(i.zone))) {
        return;
      }
      this.powerOn = true;
      this.markAllDirty();
      return;
    }
    if (target === InteractTarget.CrateTake) {
      const offer = this.crateOffer;
      if (!offer || offer.playerId !== member.id || nowMs > offer.expiresAtMs) return;
      const spot = this.crateSpot();
      if (!spot || this.distance(member.state.position, spot.pos) > INTERACT_RADIUS) return;
      this.crateOffer = null;
      const r = this.record(member.id);
      this.grantWeapon(r, member.id, offer.weapon);
      if (this.crateUsesLeft <= 0) {
        this.crateSpotIndex = (this.crateSpotIndex + 1) % Math.max(1, this.crateSpots().length);
        this.crateUsesLeft = this.rollCrateUses();
      }
      this.markAllDirty();
    }
  }

  private grantWeapon(r: SquadRecord, id: PlayerId, weapon: WeaponId): void {
    if (!r.ownedWeapons.includes(weapon)) {
      r.ownedWeapons.push(weapon);
      if (r.ownedWeapons.length > 2) r.ownedWeapons.splice(0, r.ownedWeapons.length - 2);
    }
    this.cb.giveWeapon(id, weapon);
  }

  private rollCrateUses(): number {
    const rng = makeRng(hashSeed3(this.seed, 0xd1ce, this.crateSpins));
    return CRATE_MOVE_USES_MIN + (rng.nextUint32() % (CRATE_MOVE_USES_MAX - CRATE_MOVE_USES_MIN + 1));
  }

  private crateSpots(): Interactable[] {
    return this.map.interactables.filter((i) => i.kind === InteractableKind.CrateSpot);
  }

  crateSpot(): Interactable | null {
    const spots = this.crateSpots();
    if (spots.length === 0) return null;
    return spots[this.crateSpotIndex % spots.length];
  }

  private zoneIsOpen(zone: number): boolean {
    return (this.zoneMask & (1 << zone)) !== 0;
  }

  private nearInteractable(pos: { x: number; y: number; z: number }, pred: (i: Interactable) => boolean): boolean {
    for (const i of this.map.interactables) {
      if (!pred(i)) continue;
      if (this.distance(pos, i.pos) <= INTERACT_RADIUS) return true;
    }
    return false;
  }

  private nearZoneDoor(pos: { x: number; y: number; z: number }, zone: number): boolean {
    const ids = this.map.doorBrushIdsByZone[zone];
    if (!ids || ids.length === 0) return false;
    const idSet = new Set(ids);
    for (const brush of this.map.brushes) {
      if (!idSet.has(brush.id)) continue;
      if (this.distance(pos, brush.center) <= DOOR_BUY_RADIUS) return true;
    }
    return false;
  }

  private distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // -------------------------------------------------------------------------
  // Damage into the squad
  // -------------------------------------------------------------------------

  /** Zombie melee (or environment) damage. Handles the down-instead-of-die rule. */
  damagePlayer(member: SquadMember, amount: number, nowMs: number): void {
    const st = member.state;
    if (!st.alive || st.downed === true) return;
    st.health -= amount;
    if (st.health > 0) return;

    // Down, not dead: prone crawl, pistol only, bleeding out.
    const r = this.record(member.id);
    st.health = 1;
    st.downed = true;
    st.stance = Stance.Prone;
    st.bleedout = BLEEDOUT_TIME;
    r.bleedout = BLEEDOUT_TIME;
    r.reviveProgress = 0;
    // Perks are lost the moment you hit the deck. (The Forge survives a down.)
    r.perks = 0;
    this.cb.stashWeaponsForDown(member.id);
    this.cb.onLoadoutChanged(member.id);

    // Solo self-revive (Corpsman): schedule it.
    if (this.livingCount() === 0 && r.soloRevivesLeft > 0) {
      r.selfReviveAtMs = nowMs + SOLO_REVIVE_DELAY * 1000;
    }
    r.dirty = true;
    this.markAllDirty();
  }

  /** Players standing (alive and not downed). */
  private livingCount(): number {
    let n = 0;
    for (const m of this.currentMembers) {
      if (m.state.alive && m.state.downed !== true) n++;
    }
    return n;
  }

  /** Environment (out of bounds / the sea) killed a player outright. */
  environmentalDeath(member: SquadMember): void {
    if (!member.state.alive) return;
    this.die(member);
  }

  private die(member: SquadMember): void {
    const st = member.state;
    st.downed = false;
    st.bleedout = 0;
    st.alive = false;
    st.health = 0;
    const r = this.record(member.id);
    r.bleedout = 0;
    r.selfReviveAtMs = 0;
    // Death costs the arsenal: back to the pistol next round, points kept.
    r.ownedWeapons.length = 0;
    r.forged = false;
    r.perks = 0;
    this.cb.reportDeath(member.id);
    this.markAllDirty();
  }

  private revive(member: SquadMember, rescuerId: PlayerId | null, nowMs: number): void {
    const st = member.state;
    const r = this.record(member.id);
    st.downed = false;
    st.bleedout = 0;
    st.health = Math.min(REVIVE_HEALTH, maxHealthForPerks(r.perks));
    r.bleedout = 0;
    r.reviveProgress = 0;
    r.selfReviveAtMs = 0;
    this.cb.restoreWeaponsOnRevive(member.id);
    this.cb.onLoadoutChanged(member.id);
    if (rescuerId !== null) {
      const rescuer = this.record(rescuerId);
      const mult = this.doublePointsActive(nowMs) ? 2 : 1;
      rescuer.balance += REVIVE_POINTS * mult;
      rescuer.earned += REVIVE_POINTS * mult;
      rescuer.dirty = true;
    } else if (r.soloRevivesLeft > 0) {
      r.soloRevivesLeft--;
      if (r.soloRevivesLeft <= 0) {
        // Canon: Quick Revive leaves after the third solo use.
        r.perks &= ~CORPSMAN_BIT;
        this.cb.onLoadoutChanged(member.id);
      }
    }
    this.markAllDirty();
  }

  private markAllDirty(): void {
    for (const r of this.records.values()) r.dirty = true;
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  private currentMembers: readonly SquadMember[] = [];

  /**
   * One simulation tick. Call after player movement and before lag-comp
   * recording, so zombie positions land in this tick's history row.
   */
  tick(tick: number, nowMs: number, members: readonly SquadMember[]): void {
    this.currentMembers = members;
    if (this.wiped) return;
    for (const m of members) this.record(m.id);

    // --- expire power-ups and crate offers ---------------------------------
    for (const [kind, until] of this.powerups) {
      if (nowMs >= until) {
        this.powerups.delete(kind);
        this.markAllDirty();
      }
    }
    if (this.crateOffer && nowMs > this.crateOffer.expiresAtMs) {
      this.crateOffer = null;
      if (this.crateUsesLeft <= 0) {
        this.crateSpotIndex = (this.crateSpotIndex + 1) % Math.max(1, this.crateSpots().length);
        this.crateUsesLeft = this.rollCrateUses();
      }
      this.markAllDirty();
    }

    // --- round machine ------------------------------------------------------
    const playerCount = Math.min(MAX_PLAYERS_SURVIVAL, Math.max(1, members.length));
    if (this.phase === SurvivalPhase.Intermission) {
      this.phaseTimer -= TICK_DT;
      if (this.phaseTimer <= 0) {
        this.round++;
        this.phase = SurvivalPhase.Wave;
        this.toSpawn = zombiesForRound(this.round, playerCount);
        this.nextSpawnTick = tick;
        // Everyone dead comes back for the new round.
        for (const m of members) {
          if (!m.state.alive) this.cb.respawn(m.id);
        }
        this.markAllDirty();
      }
    } else {
      // Wave: spawn on the cadence while the budget lasts.
      if (
        this.toSpawn > 0 &&
        tick >= this.nextSpawnTick &&
        this.horde.aliveCount < ZOMBIES_ALIVE_MAX
      ) {
        const runner = isRunnerRound(this.round);
        const health = Math.max(
          1,
          Math.round(healthForRound(this.round) * (runner ? RUNNER_HEALTH_MULT : 1)),
        );
        const speed = runner ? RUNNER_SPEED : zombieSpeedForRound(this.round);
        const targets = this.hordeTargets(members);
        const id = this.horde.spawn(tick, this.zoneMask, health, speed, targets);
        if (id !== 0) {
          this.toSpawn--;
          this.nextSpawnTick = tick + spawnIntervalTicks(this.round);
          this.markAllDirty();
        }
      }
      if (this.toSpawn === 0 && this.horde.aliveCount === 0) {
        this.phase = SurvivalPhase.Intermission;
        this.phaseTimer = INTERMISSION_TIME;
        if (this.round % GUARANTEED_MAX_AMMO_EVERY === 0) {
          this.applyPowerup(PowerupId.MaxAmmo, nowMs);
        }
        this.markAllDirty();
      }
    }

    // --- horde AI + melee ---------------------------------------------------
    const targets = this.hordeTargets(members);
    const attacks = this.horde.step(tick, TICK_DT, this.world, this.zoneMask, targets);
    for (const attack of attacks) {
      const victim = members.find((m) => m.id === attack.targetId);
      if (victim) this.damagePlayer(victim, ZOMBIE_MELEE_DAMAGE, nowMs);
    }

    // --- bleedout, revives, wipe -------------------------------------------
    this.tickDownsAndRevives(members, nowMs);

    // --- mirror the spendable balance into the replicated score ------------
    for (const m of members) {
      const r = this.record(m.id);
      const score = Math.max(0, Math.min(0xffff, Math.floor(r.balance)));
      if (m.state.score !== score) m.state.score = score;
      m.state.points = r.balance;
      m.state.perks = r.perks;
    }

    // --- SurvivalState fan-out ---------------------------------------------
    for (const m of members) {
      const r = this.record(m.id);
      if (r.dirty || nowMs - r.lastStateSentMs >= STATE_REFRESH_MS) {
        r.dirty = false;
        r.lastStateSentMs = nowMs;
        this.cb.send(m.id, { type: ServerMessage.SurvivalState, data: this.stateFor(m.id, nowMs) });
      }
    }
  }

  private hordeTargets(members: readonly SquadMember[]): HordeTarget[] {
    const out: HordeTarget[] = [];
    for (const m of members) {
      out.push({ state: m.state, downed: m.state.downed === true });
    }
    return out;
  }

  private tickDownsAndRevives(members: readonly SquadMember[], nowMs: number): void {
    let anyoneUp = false;
    let anyonePending = false;

    for (const m of members) {
      const st = m.state;
      const r = this.record(m.id);
      if (st.alive && st.downed !== true) {
        anyoneUp = true;
        continue;
      }
      if (!st.alive) continue;

      // Downed: is somebody reviving them?
      let rescuer: SquadMember | null = null;
      for (const other of members) {
        if (other.id === m.id) continue;
        if (!other.state.alive || other.state.downed === true) continue;
        if (!hasButton(other.lastInput.buttons, InputButton.Use)) continue;
        if (this.distance(other.state.position, st.position) > REVIVE_RADIUS) continue;
        rescuer = other;
        break;
      }

      if (rescuer) {
        const fast = hasPerk(this.perksOf(rescuer.id), PerkId.Corpsman);
        const time = REVIVE_TIME * (fast ? 0.25 : 1);
        r.reviveProgress += TICK_DT / time;
        r.beingRevived = true;
        if (r.reviveProgress >= 1) {
          this.revive(m, rescuer.id, nowMs);
          anyoneUp = true;
          continue;
        }
      } else {
        if (r.beingRevived) r.dirty = true;
        r.beingRevived = false;
        r.reviveProgress = 0;
        // Bleedout only counts down while nobody is helping.
        r.bleedout -= TICK_DT;
        st.bleedout = Math.max(0, r.bleedout);
        if (r.selfReviveAtMs > 0 && nowMs >= r.selfReviveAtMs) {
          this.revive(m, null, nowMs);
          anyoneUp = true;
          continue;
        }
        if (r.bleedout <= 0) {
          this.die(m);
          continue;
        }
      }
      if (r.selfReviveAtMs > 0) anyonePending = true;
    }

    if (!anyoneUp && !anyonePending && members.length > 0 && this.round > 0 && !this.wiped) {
      this.wiped = true;
      this.cb.endMatch();
    }
  }

  // -------------------------------------------------------------------------
  // SurvivalState assembly
  // -------------------------------------------------------------------------

  stateFor(id: PlayerId, nowMs: number): SurvivalStateMsg {
    const r = this.record(id);
    const powerups: Array<[number, number]> = [];
    for (const [kind, until] of this.powerups) {
      powerups.push([kind, Math.max(0, (until - nowMs) / 1000)]);
    }
    const spot = this.crateSpot();
    const ammo = this.cb.ammoOf(id);
    return {
      round: this.round,
      phase: this.phase,
      timeRemaining: this.phase === SurvivalPhase.Intermission ? Math.max(0, this.phaseTimer) : 0,
      zombiesRemaining: this.zombiesRemaining(),
      powerOn: this.powerOn,
      zoneMask: this.zoneMask,
      crateZone: spot ? spot.zone : 255,
      powerups,
      yourPoints: Math.max(0, Math.floor(r.balance)),
      yourPerks: r.perks,
      yourBleedout: r.bleedout > 0 ? r.bleedout : 0,
      yourForged: r.forged,
      yourHeldWeapon: ammo.held,
      yourStowedWeapon: ammo.stowed,
      yourAmmoInMag: ammo.mag,
      yourAmmoReserve: ammo.reserve,
      yourStowedMag: ammo.stowedMag,
      yourStowedReserve: ammo.stowedReserve,
      yourCrateOffer:
        this.crateOffer && this.crateOffer.playerId === id && this.crateOffer.expiresAtMs > nowMs
          ? this.crateOffer.weapon
          : 255,
    };
  }
}
