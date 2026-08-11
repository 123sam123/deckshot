/**
 * DECKSHOT — ZOMBIES director: rounds, economy, purchases, windows, power-up
 * drops, downs/revives, wipe detection.
 *
 * Owner: zombies (full rewrite; replaces the deleted sim/survival.ts).
 *
 * The director is a peer of `ScoreKeeper` (a `ScoringSink` consumer, not a
 * replacement): trickshot evaluation and the kill feed still run through the
 * lobby's keeper, but points are the mode's own flat canon payouts — 10 a
 * hit, 60 a kill, 100 a headshot, 130 a knife — never the trickshot score.
 *
 * `GameRoom` drives it and hands it live player state; weapon-runtime surgery
 * (granting guns, stashing on down) stays in the room via `ZombiesCallbacks`,
 * because the room owns the weapon module wiring.
 *
 * Two collision worlds live here:
 *   - `playerWorld`  — doors closed per zoneMask, window blockers INCLUDED.
 *     Player movement and prediction run against this.
 *   - `hordeWorld`   — same doors, window blockers EXCLUDED. Zombie
 *     locomotion and bullet tracing run against this, so the horde climbs
 *     through openings and shots pass them freely.
 */

import type { AnyServerMessage, PowerupDrop, ZombiesStateMsg } from '../../../../shared/protocol.js';
import { ServerMessage } from '../../../../shared/protocol.js';
import { createCollisionWorld, type CollisionWorld } from '../../../../shared/collision.js';
import { buildNavGraph, type NavGraph } from '../../../../shared/navgraph.js';
import {
  InteractableKind,
  collisionBrushesFor,
  hordeBrushesFor,
  type Interactable,
  type MapDef,
} from '../../../../shared/maps.js';
import { hashSeed3, makeRng } from '../../../../shared/rng.js';
import {
  BLEEDOUT_TIME,
  BOX_MOVE_USES_MAX,
  BOX_MOVE_USES_MIN,
  BOX_OFFER_TIME,
  BOX_POOL,
  DOOR_BUY_RADIUS,
  DROP_LIFETIME,
  DROP_RADIUS,
  FIRST_INTERMISSION,
  FOG_HEALTH_MULT,
  GAIT_SPEED,
  INTERACT_RADIUS,
  INTERMISSION_TIME,
  InteractTarget,
  MAX_DROPS,
  MAX_PLAYERS_ZOMBIES,
  PLANKS_MAX,
  PLANK_REPAIR_INTERVAL,
  POINTS_CARPENTER,
  POINTS_HIT,
  POINTS_NUKE,
  POINTS_REPAIR,
  POINTS_REVIVE,
  POINTS_START,
  POWERUP_CHANCE,
  POWERUP_DURATION,
  PerkId,
  PowerupId,
  PurchaseKind,
  REPAIR_BUDGET_PER_ROUND,
  REPAIR_RADIUS,
  REVIVE_HEALTH,
  REVIVE_RADIUS,
  REVIVE_TIME,
  SECOND_WIND_REVIVE_MULT,
  SOLO_REVIVE_DELAY,
  SOLO_REVIVE_USES,
  ZOMBIES_ALIVE_MAX,
  ZOMBIE_MELEE_DAMAGE,
  ZombiesPhase,
  gaitForRoll,
  hasPerk,
  healthForRound,
  isFogRound,
  killPoints,
  maxHealthForPerks,
  spawnIntervalTicks,
  speedMultForPerks,
  validatePurchase,
  zombieDamageMult,
  zombiesForRound,
} from '../../../../shared/zombies.js';
import {
  HitboxPart,
  InputButton,
  Stance,
  hasButton,
  type ClientInput,
  type PlayerId,
  type PlayerState,
  type WeaponId,
} from '../../../../shared/types.js';
import { TICK_DT, TICK_RATE } from '../../../../shared/tuning.js';
import { ZombieHorde, type HordeTarget, type WindowsView } from './horde.js';

/** ZombiesState refresh cadence when nothing changed, ms. */
const STATE_REFRESH_MS = 1000;
/** Revive progress is dirty-marked on 1/20th steps, not every tick. */
const PROGRESS_STEPS = 20;

/** What the room exposes to the director about one squad member. */
export interface SquadMember {
  id: PlayerId;
  state: PlayerState;
  lastInput: ClientInput;
}

/** Weapon/state surgery the room performs on the director's behalf. */
export interface ZombiesCallbacks {
  send(id: PlayerId, msg: AnyServerMessage): void;
  broadcast(msg: AnyServerMessage): void;
  /** Grant a weapon (full ammo) into the held slot; old held is stowed. */
  giveWeapon(id: PlayerId, weapon: WeaponId): void;
  /** Refill every carried magazine and reserve. */
  refillAmmo(id: PlayerId): void;
  /** Swap to the pistol-only last-stand runtime, stashing the real guns. */
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
  /** The player's authoritative arsenal, for ZombiesState sync. */
  ammoOf(id: PlayerId): {
    held: WeaponId;
    /** 255 when nothing is stowed. */
    stowed: number;
    mag: number;
    reserve: number;
    stowedMag: number;
    stowedReserve: number;
  };
}

interface DropRec {
  id: number;
  kind: PowerupId;
  x: number;
  y: number;
  z: number;
  expiresAtMs: number;
}

interface SquadRecord {
  id: PlayerId;
  balance: number;
  /** Cumulative earned, for the scoreboard's sake. */
  earned: number;
  perks: number;
  /** Bit per WeaponId: guns this player has put through the Forge. */
  forgedMask: number;
  ownedWeapons: WeaponId[];
  bleedout: number;
  /** 0..1 while a rescuer holds F on this (downed) player. */
  reviveProgress: number;
  beingRevived: boolean;
  /** Who is reviving this downed player, 0 = nobody. */
  rescuerId: PlayerId;
  soloRevivesLeft: number;
  /** ms timestamp when a solo self-revive completes; 0 = none pending. */
  selfReviveAtMs: number;
  /** Plank-repair points income left this round. */
  repairBudget: number;
  /** Seconds of Use-hold accumulated toward the next plank. */
  repairTimer: number;
  dirty: boolean;
  lastStateSentMs: number;
  lastProgressStep: number;
  killSeed: number;
}

function makeRecord(id: PlayerId): SquadRecord {
  return {
    id,
    balance: POINTS_START,
    earned: 0,
    perks: 0,
    forgedMask: 0,
    ownedWeapons: [],
    bleedout: 0,
    reviveProgress: 0,
    beingRevived: false,
    rescuerId: 0,
    soloRevivesLeft: 0,
    selfReviveAtMs: 0,
    repairBudget: REPAIR_BUDGET_PER_ROUND,
    repairTimer: 0,
    dirty: true,
    lastStateSentMs: 0,
    lastProgressStep: 0,
    killSeed: 0,
  };
}

export class ZombiesDirector {
  readonly map: MapDef;
  readonly horde: ZombieHorde;
  /** Players collide with this (doors closed, blockers in). */
  playerWorld: CollisionWorld;
  /** Zombies and bullets use this (blockers out). */
  hordeWorld: CollisionWorld;

  private readonly graph: NavGraph;
  private readonly records = new Map<PlayerId, SquadRecord>();
  private readonly cb: ZombiesCallbacks;
  private readonly seed: number;

  round = 0;
  phase: ZombiesPhase = ZombiesPhase.Intermission;
  private phaseTimer = FIRST_INTERMISSION;
  private toSpawn = 0;
  private spawnRoll = 0;
  private nextSpawnTick = 0;
  zoneMask = 1; // zone 0 open
  powerOn = false;
  private wiped = false;

  /** Planks per window, dense by WindowDef id. */
  private readonly planks: number[] = [];

  /** Active timed effects: id -> ms expiry. */
  private readonly effects = new Map<PowerupId, number>();
  /** Power-ups lying on the deck. */
  private readonly drops: DropRec[] = [];
  private dropIdCounter = 0;

  // Mystery box.
  private boxSpotIndex = 0;
  private boxUsesLeft = 5;
  private boxSpins = 0;
  private boxOffer: { playerId: PlayerId; weapon: WeaponId; expiresAtMs: number } | null = null;

  constructor(map: MapDef, slotBase: number, cb: ZombiesCallbacks, seed = 0x2b0c5) {
    this.map = map;
    this.cb = cb;
    this.seed = seed | 0;
    this.graph = buildNavGraph(map.navNodes);
    this.horde = new ZombieHorde(map, this.graph, slotBase);
    this.playerWorld = createCollisionWorld(
      collisionBrushesFor(map, this.zoneMask),
      map.bounds,
      map.waterLevel,
    );
    this.hordeWorld = createCollisionWorld(
      hordeBrushesFor(map, this.zoneMask),
      map.bounds,
      map.waterLevel,
    );
    for (const w of map.windows) this.planks[w.id] = PLANKS_MAX;
    this.boxUsesLeft = this.rollBoxUses();
    (this.windowsView as { defs: MapDef['windows'] }).defs = map.windows;
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

  /** Fresh match: round 0 economy, zones closed, boards up, horde cleared. */
  reset(): void {
    this.round = 0;
    this.phase = ZombiesPhase.Intermission;
    this.phaseTimer = FIRST_INTERMISSION;
    this.toSpawn = 0;
    this.spawnRoll = 0;
    this.zoneMask = 1;
    this.powerOn = false;
    this.wiped = false;
    this.effects.clear();
    this.drops.length = 0;
    this.dropIdCounter = 0;
    this.boxSpotIndex = 0;
    this.boxSpins = 0;
    this.boxOffer = null;
    this.boxUsesLeft = this.rollBoxUses();
    this.horde.clear();
    for (const w of this.map.windows) this.planks[w.id] = PLANKS_MAX;
    this.rebuildWorlds();
    for (const r of this.records.values()) {
      this.records.set(r.id, makeRecord(r.id));
    }
  }

  private rebuildWorlds(): void {
    this.playerWorld = createCollisionWorld(
      collisionBrushesFor(this.map, this.zoneMask),
      this.map.bounds,
      this.map.waterLevel,
    );
    this.hordeWorld = createCollisionWorld(
      hordeBrushesFor(this.map, this.zoneMask),
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

  forgedMaskOf(id: PlayerId): number {
    return this.records.get(id)?.forgedMask ?? 0;
  }

  maxHealthOf(id: PlayerId): number {
    return maxHealthForPerks(this.perksOf(id));
  }

  zombiesRemaining(): number {
    return this.toSpawn + this.horde.aliveCount;
  }

  instaKillActive(nowMs: number): boolean {
    const t = this.effects.get(PowerupId.InstaKill);
    return t !== undefined && t > nowMs;
  }

  doublePointsActive(nowMs: number): boolean {
    const t = this.effects.get(PowerupId.DoublePoints);
    return t !== undefined && t > nowMs;
  }

  /** Damage multiplier for one of `shooter`'s bullets into a zombie. */
  damageMultFor(shooterId: PlayerId, weapon: WeaponId, part: HitboxPart, nowMs: number): number {
    const r = this.records.get(shooterId);
    return zombieDamageMult(
      r?.perks ?? 0,
      ((r?.forgedMask ?? 0) & (1 << weapon)) !== 0,
      part === HitboxPart.Head,
      this.instaKillActive(nowMs),
    );
  }

  // -------------------------------------------------------------------------
  // Economy events (room calls these from its fire/melee resolution)
  // -------------------------------------------------------------------------

  /** A bullet connected with a zombie but did not necessarily kill. */
  onZombieHit(shooterId: PlayerId, nowMs: number): void {
    const r = this.record(shooterId);
    const mult = this.doublePointsActive(nowMs) ? 2 : 1;
    r.balance += POINTS_HIT * mult;
    r.earned += POINTS_HIT * mult;
    r.dirty = true;
  }

  /**
   * One zombie died to `shooterId`. Canon flat payout by part/melee, plus the
   * power-up drop roll at the corpse.
   */
  onZombieKill(
    shooterId: PlayerId,
    part: HitboxPart,
    melee: boolean,
    x: number,
    y: number,
    z: number,
    tick: number,
    nowMs: number,
  ): void {
    const r = this.record(shooterId);
    const mult = this.doublePointsActive(nowMs) ? 2 : 1;
    const pts = killPoints(part, melee) * mult;
    r.balance += pts;
    r.earned += pts;
    r.dirty = true;

    r.killSeed++;
    const rng = makeRng(hashSeed3(this.seed, tick | 0, (shooterId << 8) ^ r.killSeed));
    if (rng.nextFloat() < POWERUP_CHANCE && this.drops.length < MAX_DROPS) {
      const droppable = [
        PowerupId.MaxAmmo,
        PowerupId.InstaKill,
        PowerupId.DoublePoints,
        PowerupId.Nuke,
        PowerupId.Carpenter,
      ];
      const kind = droppable[rng.nextUint32() % droppable.length];
      this.dropIdCounter = (this.dropIdCounter + 1) & 0xff;
      this.drops.push({ id: this.dropIdCounter, kind, x, y, z, expiresAtMs: nowMs + DROP_LIFETIME * 1000 });
      this.markAllDirty();
    }
  }

  private applyPowerup(kind: PowerupId, nowMs: number): void {
    switch (kind) {
      case PowerupId.MaxAmmo:
        for (const r of this.records.values()) this.cb.refillAmmo(r.id);
        break;
      case PowerupId.Nuke: {
        this.horde.killAll();
        for (const r of this.records.values()) {
          r.balance += POINTS_NUKE;
          r.earned += POINTS_NUKE;
        }
        break;
      }
      case PowerupId.Carpenter: {
        for (const w of this.map.windows) this.planks[w.id] = PLANKS_MAX;
        for (const r of this.records.values()) {
          r.balance += POINTS_CARPENTER;
          r.earned += POINTS_CARPENTER;
        }
        break;
      }
      case PowerupId.InstaKill:
      case PowerupId.DoublePoints:
        this.effects.set(kind, nowMs + POWERUP_DURATION * 1000);
        break;
      default:
        break;
    }
    this.markAllDirty();
  }

  // -------------------------------------------------------------------------
  // Purchases and interactions
  // -------------------------------------------------------------------------

  purchase(member: SquadMember, kind: PurchaseKind, itemId: number, nowMs: number): void {
    const r = this.record(member.id);
    if (member.state.downed === true || member.state.alive === false) return;

    const held = this.cb.ammoOf(member.id).held;
    const baseCtx = {
      kind,
      itemId,
      points: r.balance,
      perks: r.perks,
      powerOn: this.powerOn,
      zoneMask: this.zoneMask,
      zoneReachable: false,
      ownsWeapon: r.ownedWeapons.includes(itemId as WeaponId),
      heldForged: (r.forgedMask & (1 << held)) !== 0,
      solo: this.records.size <= 1,
      boxBusy: this.boxOffer !== null,
      zoneCost: 0,
    };

    switch (kind) {
      case PurchaseKind.Zone: {
        const zone = this.map.zones[itemId];
        if (!zone) return;
        if (zone.requiresPower && !this.powerOn) return;
        const reachable =
          zone.adjacent.some((a) => this.zoneIsOpen(a)) &&
          this.nearZoneDoor(member.state.position, itemId);
        const verdict = validatePurchase({
          ...baseCtx,
          zoneReachable: reachable,
          zoneCost: zone.cost,
        });
        if (!verdict.ok) return;
        r.balance -= verdict.cost;
        this.zoneMask |= 1 << itemId;
        this.rebuildWorlds();
        this.markAllDirty();
        return;
      }
      case PurchaseKind.Weapon: {
        const weapon = itemId as WeaponId;
        if (
          !this.nearInteractable(
            member.state.position,
            (i) => i.kind === InteractableKind.WallBuy && i.weapon === weapon && this.zoneIsOpen(i.zone),
          )
        ) {
          return;
        }
        // Ammo re-buys price off the FORGED status of the gun being refilled.
        const verdict = validatePurchase({
          ...baseCtx,
          heldForged: (r.forgedMask & (1 << weapon)) !== 0,
        });
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
      case PurchaseKind.Perk: {
        const perk = itemId as PerkId;
        if (
          !this.nearInteractable(
            member.state.position,
            (i) => i.kind === InteractableKind.Perk && i.perk === perk && this.zoneIsOpen(i.zone),
          )
        ) {
          return;
        }
        const verdict = validatePurchase(baseCtx);
        if (!verdict.ok) return;
        r.balance -= verdict.cost;
        r.perks |= 1 << perk;
        if (perk === PerkId.Bulwark) {
          member.state.health = maxHealthForPerks(r.perks);
        }
        if (perk === PerkId.SecondWind) {
          r.soloRevivesLeft = SOLO_REVIVE_USES;
        }
        this.cb.onLoadoutChanged(member.id);
        r.dirty = true;
        return;
      }
      case PurchaseKind.Forge: {
        if (
          !this.nearInteractable(
            member.state.position,
            (i) => i.kind === InteractableKind.Forge && this.zoneIsOpen(i.zone),
          )
        ) {
          return;
        }
        const verdict = validatePurchase(baseCtx);
        if (!verdict.ok) return;
        r.balance -= verdict.cost;
        r.forgedMask |= 1 << held;
        this.cb.onLoadoutChanged(member.id);
        this.cb.refillAmmo(member.id);
        r.dirty = true;
        return;
      }
      case PurchaseKind.Box: {
        const spot = this.boxSpot();
        if (!spot || !this.zoneIsOpen(spot.zone)) return;
        if (this.distance(member.state.position, spot.pos) > INTERACT_RADIUS) return;
        const verdict = validatePurchase(baseCtx);
        if (!verdict.ok) return;
        r.balance -= verdict.cost;
        this.boxSpins++;
        const rng = makeRng(hashSeed3(this.seed, 0xb0c5, this.boxSpins));
        const weapon = BOX_POOL[rng.nextUint32() % BOX_POOL.length];
        this.boxOffer = { playerId: member.id, weapon, expiresAtMs: nowMs + BOX_OFFER_TIME * 1000 };
        this.boxUsesLeft--;
        this.markAllDirty();
        return;
      }
      default:
        return;
    }
  }

  interact(member: SquadMember, target: InteractTarget, nowMs: number): void {
    if (member.state.downed === true || member.state.alive === false) return;
    if (target === InteractTarget.Power) {
      if (this.powerOn) return;
      if (
        !this.nearInteractable(
          member.state.position,
          (i) => i.kind === InteractableKind.Generator && this.zoneIsOpen(i.zone),
        )
      ) {
        return;
      }
      this.powerOn = true;
      this.markAllDirty();
      return;
    }
    if (target === InteractTarget.BoxTake) {
      const offer = this.boxOffer;
      if (!offer || offer.playerId !== member.id || nowMs > offer.expiresAtMs) return;
      const spot = this.boxSpot();
      if (!spot || this.distance(member.state.position, spot.pos) > INTERACT_RADIUS) return;
      this.boxOffer = null;
      const r = this.record(member.id);
      this.grantWeapon(r, member.id, offer.weapon);
      if (this.boxUsesLeft <= 0) {
        this.boxSpotIndex = (this.boxSpotIndex + 1) % Math.max(1, this.boxSpots().length);
        this.boxUsesLeft = this.rollBoxUses();
      }
      this.markAllDirty();
    }
  }

  private grantWeapon(r: SquadRecord, id: PlayerId, weapon: WeaponId): void {
    if (!r.ownedWeapons.includes(weapon)) {
      r.ownedWeapons.push(weapon);
      while (r.ownedWeapons.length > 2) {
        const dropped = r.ownedWeapons.shift();
        // A gun that leaves the arsenal loses its Forge upgrade with it.
        if (dropped !== undefined) r.forgedMask &= ~(1 << dropped);
      }
    }
    this.cb.giveWeapon(id, weapon);
  }

  private rollBoxUses(): number {
    const rng = makeRng(hashSeed3(this.seed, 0xd1ce, this.boxSpins));
    return BOX_MOVE_USES_MIN + (rng.nextUint32() % (BOX_MOVE_USES_MAX - BOX_MOVE_USES_MIN + 1));
  }

  private boxSpots(): Interactable[] {
    return this.map.interactables
      .filter((i) => i.kind === InteractableKind.CrateSpot)
      .sort((a, b) => (a.spot ?? 0) - (b.spot ?? 0));
  }

  boxSpot(): Interactable | null {
    const spots = this.boxSpots();
    if (spots.length === 0) return null;
    return spots[this.boxSpotIndex % spots.length];
  }

  private zoneIsOpen(zone: number): boolean {
    return (this.zoneMask & (1 << zone)) !== 0;
  }

  private nearInteractable(
    pos: { x: number; y: number; z: number },
    pred: (i: Interactable) => boolean,
  ): boolean {
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

  private distance(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
  ): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // -------------------------------------------------------------------------
  // Damage into the squad
  // -------------------------------------------------------------------------

  /** Zombie melee (or environment) damage. Handles down-instead-of-die. */
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
    r.rescuerId = 0;
    // Perks are lost the moment you hit the deck. (Forged guns survive a
    // down — they're stashed with the arsenal.)
    r.perks = 0;
    this.cb.stashWeaponsForDown(member.id);
    this.cb.onLoadoutChanged(member.id);

    // Solo self-revive (SECOND WIND): schedule it.
    if (this.livingCount() === 0 && r.soloRevivesLeft > 0) {
      r.selfReviveAtMs = nowMs + SOLO_REVIVE_DELAY * 1000;
    }
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
    r.rescuerId = 0;
    // Death costs the arsenal: back to the pistol next round, points kept.
    r.ownedWeapons.length = 0;
    r.forgedMask = 0;
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
    r.rescuerId = 0;
    r.selfReviveAtMs = 0;
    this.cb.restoreWeaponsOnRevive(member.id);
    this.cb.onLoadoutChanged(member.id);
    if (rescuerId !== null) {
      const rescuer = this.record(rescuerId);
      const mult = this.doublePointsActive(nowMs) ? 2 : 1;
      rescuer.balance += POINTS_REVIVE * mult;
      rescuer.earned += POINTS_REVIVE * mult;
      rescuer.dirty = true;
    } else if (r.soloRevivesLeft > 0) {
      r.soloRevivesLeft--;
      if (r.soloRevivesLeft <= 0) {
        // Canon: the self-revive perk leaves after its last solo use.
        r.perks &= ~(1 << PerkId.SecondWind);
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

  private readonly windowsView: WindowsView = {
    defs: [],
    planksOf: (id: number) => this.planks[id] ?? 0,
    tear: (id: number) => {
      if ((this.planks[id] ?? 0) > 0) {
        this.planks[id]--;
        this.markAllDirty();
      }
    },
  };

  /**
   * One simulation tick. Call after player movement and before lag-comp
   * recording, so zombie positions land in this tick's history row.
   */
  tick(tick: number, nowMs: number, members: readonly SquadMember[]): void {
    this.currentMembers = members;
    if (this.wiped) return;
    for (const m of members) this.record(m.id);

    // --- expire effects, drops and box offers -------------------------------
    for (const [kind, until] of this.effects) {
      if (nowMs >= until) {
        this.effects.delete(kind);
        this.markAllDirty();
      }
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      if (nowMs >= this.drops[i].expiresAtMs) {
        this.drops.splice(i, 1);
        this.markAllDirty();
      }
    }
    if (this.boxOffer && nowMs > this.boxOffer.expiresAtMs) {
      this.boxOffer = null;
      if (this.boxUsesLeft <= 0) {
        this.boxSpotIndex = (this.boxSpotIndex + 1) % Math.max(1, this.boxSpots().length);
        this.boxUsesLeft = this.rollBoxUses();
      }
      this.markAllDirty();
    }

    // --- round machine -------------------------------------------------------
    const playerCount = Math.min(MAX_PLAYERS_ZOMBIES, Math.max(1, members.length));
    if (this.phase === ZombiesPhase.Intermission) {
      this.phaseTimer -= TICK_DT;
      if (this.phaseTimer <= 0) {
        this.round++;
        this.phase = ZombiesPhase.Wave;
        this.toSpawn = zombiesForRound(this.round, playerCount);
        this.nextSpawnTick = tick;
        for (const r of this.records.values()) {
          r.repairBudget = REPAIR_BUDGET_PER_ROUND;
        }
        // Everyone dead comes back for the new round.
        for (const m of members) {
          if (!m.state.alive) this.cb.respawn(m.id);
        }
        this.markAllDirty();
      }
    } else {
      // Wave: spawn on the cadence while the budget lasts.
      if (this.toSpawn > 0 && tick >= this.nextSpawnTick && this.horde.aliveCount < ZOMBIES_ALIVE_MAX) {
        const fog = isFogRound(this.round);
        this.spawnRoll++;
        const rng = makeRng(hashSeed3(this.seed, tick | 0, 0x9a17 ^ this.spawnRoll));
        const gait = gaitForRoll(this.round, rng.nextFloat());
        const health = Math.max(1, Math.round(healthForRound(this.round) * (fog ? FOG_HEALTH_MULT : 1)));
        const targets = this.hordeTargets(members);
        const id = this.horde.spawn(tick, this.zoneMask, health, GAIT_SPEED[gait], targets);
        if (id !== 0) {
          this.toSpawn--;
          this.nextSpawnTick = tick + spawnIntervalTicks(this.round, TICK_RATE);
          this.markAllDirty();
        }
      }
      if (this.toSpawn === 0 && this.horde.aliveCount === 0) {
        this.phase = ZombiesPhase.Intermission;
        this.phaseTimer = INTERMISSION_TIME;
        this.markAllDirty();
      }
    }

    // --- horde AI + melee -----------------------------------------------------
    const targets = this.hordeTargets(members);
    const attacks = this.horde.step(tick, TICK_DT, this.hordeWorld, this.zoneMask, targets, this.windowsView);
    for (const attack of attacks) {
      const victim = members.find((m) => m.id === attack.targetId);
      if (victim) this.damagePlayer(victim, ZOMBIE_MELEE_DAMAGE, nowMs);
    }

    // --- drop pickups ----------------------------------------------------------
    for (const m of members) {
      if (!m.state.alive || m.state.downed === true) continue;
      for (let i = this.drops.length - 1; i >= 0; i--) {
        const d = this.drops[i];
        const dx = d.x - m.state.position.x;
        const dy = d.y - m.state.position.y;
        const dz = d.z - m.state.position.z;
        if (dx * dx + dz * dz <= DROP_RADIUS * DROP_RADIUS && Math.abs(dy) <= 2.0) {
          this.drops.splice(i, 1);
          this.applyPowerup(d.kind, nowMs);
        }
      }
    }

    // --- window repairs ---------------------------------------------------------
    this.tickRepairs(members, nowMs);

    // --- bleedout, revives, wipe -------------------------------------------------
    this.tickDownsAndRevives(members, nowMs);

    // --- mirror balances and perk effects into replicated state -------------------
    for (const m of members) {
      const r = this.record(m.id);
      const score = Math.max(0, Math.min(0xffff, Math.floor(r.balance)));
      if (m.state.score !== score) m.state.score = score;
      m.state.points = r.balance;
      m.state.perks = r.perks;
      m.state.speedMult = speedMultForPerks(r.perks);
    }

    // --- ZombiesState fan-out ------------------------------------------------------
    for (const m of members) {
      const r = this.record(m.id);
      if (r.dirty || nowMs - r.lastStateSentMs >= STATE_REFRESH_MS) {
        r.dirty = false;
        r.lastStateSentMs = nowMs;
        this.cb.send(m.id, { type: ServerMessage.ZombiesState, data: this.stateFor(m.id, nowMs) });
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

  /** Hold F near a boarded window: +1 plank per interval, paid while budget lasts. */
  private tickRepairs(members: readonly SquadMember[], nowMs: number): void {
    for (const m of members) {
      const st = m.state;
      const r = this.record(m.id);
      if (!st.alive || st.downed === true || !hasButton(m.lastInput.buttons, InputButton.Use)) {
        r.repairTimer = 0;
        continue;
      }
      // A revive in progress owns the Use button.
      if (this.isRescuing(m, members)) {
        r.repairTimer = 0;
        continue;
      }
      let win = -1;
      let best = REPAIR_RADIUS;
      for (const w of this.map.windows) {
        if ((this.planks[w.id] ?? 0) >= PLANKS_MAX) continue;
        if (!this.zoneIsOpen(w.zone)) continue;
        const d = this.distance(st.position, w.pos);
        if (d <= best) {
          best = d;
          win = w.id;
        }
      }
      if (win < 0) {
        r.repairTimer = 0;
        continue;
      }
      r.repairTimer += TICK_DT;
      if (r.repairTimer >= PLANK_REPAIR_INTERVAL) {
        r.repairTimer -= PLANK_REPAIR_INTERVAL;
        this.planks[win] = Math.min(PLANKS_MAX, (this.planks[win] ?? 0) + 1);
        if (r.repairBudget >= POINTS_REPAIR) {
          const mult = this.doublePointsActive(nowMs) ? 2 : 1;
          r.balance += POINTS_REPAIR * mult;
          r.earned += POINTS_REPAIR * mult;
          r.repairBudget -= POINTS_REPAIR;
        }
        this.markAllDirty();
      }
    }
  }

  /** Is this member currently the rescuer of someone's revive? */
  private isRescuing(m: SquadMember, members: readonly SquadMember[]): boolean {
    for (const other of members) {
      if (other.id === m.id) continue;
      const r = this.records.get(other.id);
      if (r && r.rescuerId === m.id && other.state.downed === true) return true;
    }
    return false;
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
        const fast = hasPerk(this.perksOf(rescuer.id), PerkId.SecondWind);
        const time = REVIVE_TIME * (fast ? SECOND_WIND_REVIVE_MULT : 1);
        r.reviveProgress += TICK_DT / time;
        if (!r.beingRevived || r.rescuerId !== rescuer.id) {
          r.beingRevived = true;
          r.rescuerId = rescuer.id;
          r.dirty = true;
          this.record(rescuer.id).dirty = true;
        }
        const step = Math.floor(r.reviveProgress * PROGRESS_STEPS);
        if (step !== r.lastProgressStep) {
          r.lastProgressStep = step;
          r.dirty = true;
          this.record(rescuer.id).dirty = true;
        }
        if (r.reviveProgress >= 1) {
          this.revive(m, rescuer.id, nowMs);
          anyoneUp = true;
          continue;
        }
      } else {
        if (r.beingRevived) {
          r.beingRevived = false;
          r.rescuerId = 0;
          r.reviveProgress = 0;
          r.lastProgressStep = 0;
          this.markAllDirty();
        }
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
  // ZombiesState assembly
  // -------------------------------------------------------------------------

  stateFor(id: PlayerId, nowMs: number): ZombiesStateMsg {
    const r = this.record(id);
    const effects: Array<[number, number]> = [];
    for (const [kind, until] of this.effects) {
      effects.push([kind, Math.max(0, (until - nowMs) / 1000)]);
    }
    const drops: PowerupDrop[] = this.drops.map((d) => ({
      id: d.id,
      kind: d.kind,
      pos: { x: d.x, y: d.y, z: d.z },
      secondsLeft: Math.max(0, (d.expiresAtMs - nowMs) / 1000),
    }));
    const spot = this.boxSpot();
    const ammo = this.cb.ammoOf(id);

    // The revive ring: progress of the revive this recipient is PERFORMING.
    let reviveProgress = 0;
    for (const other of this.records.values()) {
      if (other.rescuerId === id && other.beingRevived) {
        reviveProgress = Math.min(1, other.reviveProgress);
        break;
      }
    }

    return {
      round: this.round,
      phase: this.phase,
      timeRemaining: this.phase === ZombiesPhase.Intermission ? Math.max(0, this.phaseTimer) : 0,
      zombiesRemaining: this.zombiesRemaining(),
      powerOn: this.powerOn,
      zoneMask: this.zoneMask,
      boxSpot: spot ? (spot.spot ?? 255) : 255,
      effects,
      drops,
      planks: this.map.windows.map((w) => this.planks[w.id] ?? 0),
      points: Math.max(0, Math.floor(r.balance)),
      perks: r.perks,
      bleedout: r.bleedout > 0 ? r.bleedout : 0,
      selfRevives: r.soloRevivesLeft,
      forged: r.forgedMask,
      held: ammo.held,
      stowed: ammo.stowed,
      ammoMag: ammo.mag,
      ammoReserve: ammo.reserve,
      stowedMag: ammo.stowedMag,
      stowedReserve: ammo.stowedReserve,
      boxOffer:
        this.boxOffer && this.boxOffer.playerId === id && this.boxOffer.expiresAtMs > nowMs
          ? this.boxOffer.weapon
          : 255,
      repairBudget: r.repairBudget,
      reviveProgress,
      beingRevived: r.beingRevived,
    };
  }
}
