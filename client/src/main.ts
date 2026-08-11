/**
 * DECKSHOT — client entry point.
 *
 * This is the integration seam: every subsystem was built independently against
 * a contract, and this file is where they meet. It owns the frame loop, the
 * camera, and the translation between UI intent and network messages. It
 * deliberately contains no gameplay rules — those live in `shared/`, where the
 * server runs the identical code.
 *
 * Loop shape:
 *   - Input and simulation run on a FIXED 60Hz accumulator, because prediction
 *     replay must step at exactly the rate the server does.
 *   - Rendering runs once per animation frame, decoupled, interpolating remote
 *     players 100ms in the past.
 */

import * as THREE from 'three';

import { Renderer, Materials } from './engine/index.js';
import { buildWorld, type WorldHandle } from './world/index.js';
import { NetClient, type RemotePlayerState } from './net/index.js';
import { InputController } from './gameplay/controller.js';
import { PredictedWeapons, WeaponEventType } from './gameplay/weapons.js';
import { Viewmodel } from './gameplay/viewmodel.js';
import { Effects } from './gameplay/effects/index.js';
import { AvatarPool, type AvatarState } from './gameplay/avatars.js';
import { Audio } from './audio/index.js';
import { mountUI, type UIBridge, type UIHandle, type UISettings } from './ui/index.js';

import { TICK_DT, TICK_RATE, RESPAWN_DELAY, WEAPONS, eyeHeightForStance } from '../../shared/tuning.js';
import {
  AdsState,
  AttachmentId,
  CamoId,
  GameMode,
  InputButton,
  Stance,
  TeamId,
  WeaponId,
  type Loadout,
  type PlayerId,
} from '../../shared/types.js';
import { MATERIAL_PENETRATION, SurfaceMaterial } from '../../shared/mapdata.js';
import type { ScoreboardEntry, ZombiesStateMsg } from '../../shared/protocol.js';
import { createCollisionWorld } from '../../shared/collision.js';
import { InteractableKind, collisionBrushesFor, mapForMode } from '../../shared/maps.js';
import {
  InteractTarget,
  MAX_PERKS,
  PERK_COSTS,
  PERK_COST_SECOND_WIND_SOLO,
  PERK_NAMES,
  PerkId,
  PurchaseKind,
  ammoCostFor,
  BOX_COST,
  FORGE_COST,
  WALL_COSTS,
  filterDownedButtons,
  hasPerk,
  isFogRound,
  isZombieId,
  perkCount,
  speedMultForPerks,
} from '../../shared/zombies.js';
import { HordePool } from './gameplay/horde.js';
import { DropsPool } from './gameplay/drops.js';
import { DoorManager } from './world/doors.js';
import { BarricadeManager } from './world/barricades.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
if (!canvas || !uiRoot) throw new Error('index.html is missing #game or #ui');

const renderer = new Renderer(canvas);
let world: WorldHandle = buildWorld(renderer.scene, Materials);
const avatars = new AvatarPool(renderer.scene);
const horde = new HordePool(renderer.scene);
const drops = new DropsPool(renderer.scene);
const viewmodel = new Viewmodel(renderer.viewmodelScene);

/** The zombies map, resolved once from the same registry the server uses. */
const ZMAP = mapForMode(GameMode.Zombies);

Effects.init({
  scene: renderer.scene,
  camera: renderer.camera,
  addDynamicLight: (pos, color, intensity, lifetime) => renderer.addDynamicLight(pos, color, intensity, lifetime),
});

const controller = new InputController(canvas);
const weapons = new PredictedWeapons(undefined, controller);

const net = new NetClient({
  // The weapon runtime is advanced by the net layer so that prediction and
  // reconciliation step it in the same order the server does.
  advanceWeapon: (input, dt) => {
    weapons.update(input, dt);
  },
});

// Dev-only debug handle: lets tooling (screenshot drivers, console poking)
// read positions and aim the camera without going through pointer lock.
// Stripped from production builds by the DEV guard.
if (import.meta.env.DEV) {
  (window as unknown as { __deckshot?: unknown }).__deckshot = { net, controller };
}

// ---------------------------------------------------------------------------
// Camera state
// ---------------------------------------------------------------------------

renderer.camera.rotation.order = 'YXZ';
renderer.viewmodelCamera.rotation.order = 'YXZ';

/** Player-chosen world FOV in radians; scoping lerps from this toward the scope FOV. */
let baseFov = renderer.camera.fov * THREE.MathUtils.DEG2RAD;

const camPos = new THREE.Vector3();
const camForward = new THREE.Vector3();
const camUp = new THREE.Vector3(0, 1, 0);

let lastYaw = 0;
let lastPitch = 0;

// ---------------------------------------------------------------------------
// UI bridge — UI intent in, network messages out
// ---------------------------------------------------------------------------

const bridge: UIBridge = {
  createLobby: (mode, scoreLimit) => net.createLobby(mode, scoreLimit),
  joinLobby: (code) => net.joinLobby(code),
  quickPlay: () => net.quickPlay(),
  leaveLobby: () => {
    net.leaveLobby();
    controller.releaseLock();
    ensureWorld(null, 0);
  },
  setReady: (ready) => net.setReady(ready),
  setMatchConfig: (mode, scoreLimit, timeLimit) => net.setMatchConfig(mode, scoreLimit, timeLimit),
  setLoadout: (loadout) => {
    applyLoadout(loadout);
    net.setLoadout(loadout);
  },
  setName: (name) => {
    // Applied on the next connect; the socket carries the name in Hello.
    pendingName = name;
  },
  requestRespawn: () => net.requestRespawn(),
  sendChat: (text) => net.chat(text),
  applySettings: (s) => applySettings(s),
};

const ui: UIHandle = mountUI(uiRoot, bridge);

let pendingName = ui.getName();

function applySettings(s: UISettings): void {
  controller.setSensitivity(s.sensitivity);
  baseFov = s.fovDegrees * THREE.MathUtils.DEG2RAD;
  Audio.setMasterVolume(s.masterVolume);
  // invertY is persisted and surfaced by the UI, but the input controller
  // exposes no inversion hook — see DECISIONS.md. Not silently ignored:
  // it is recorded as a known gap rather than faked here.
}

/**
 * A loadout change has to reach BOTH the predicted weapon state and the
 * viewmodel. Missing the second half is silent: the gun simply never appears,
 * because the Viewmodel builds no mesh until setWeapon is called.
 */
function applyLoadout(loadout: Loadout): void {
  weapons.setLoadout(loadout);
  viewmodel.setWeapon(loadout.primary, loadout.camo, [...loadout.attachments]);
}

applySettings(ui.getSettings());
applyLoadout(ui.getLoadout());

// ---------------------------------------------------------------------------
// Network events -> UI and effects
// ---------------------------------------------------------------------------

net.on('welcome', (msg) => {
  ui.setLocalPlayerId(msg.playerId);
  localId = msg.playerId;
});
net.on('lobby', (msg) => {
  ui.onLobbyState(msg);
  zombiesActive = msg.mode === GameMode.Zombies;
  lobbySize = msg.players.length;
  ensureWorld(msg.mode, lastZombies?.zoneMask ?? 1);
});
net.on('zombies', (msg) => {
  diffZombiesState(lastZombies, msg);
  lastZombies = msg;
  ui.onZombiesState(msg);
  weapons.applyZombiesState(msg);
  // ADRENALINE reaches movement through PlayerState.speedMult on BOTH sides:
  // the server sets it from its perk record, prediction mirrors it here —
  // miss this and every post-perk step rubber-bands.
  net.predictor.state.speedMult = speedMultForPerks(msg.perks);
  if (zombiesActive) ensureWorld(GameMode.Zombies, msg.zoneMask);
  doors?.setZoneMask(msg.zoneMask);
  barricades?.setPlanks(msg.planks);
});
net.on('round', (msg) => ui.onRoundState(msg));
net.on('chat', (msg) => ui.onChat(msg));
net.on('error', (msg) => ui.onError(msg));
net.on('matchover', (msg) => {
  ui.onMatchOver(msg);
  controller.releaseLock();
});

net.on('open', () => {
  ui.onConnectionState('connected');
  void Audio.init().then(() => Audio.startAmbient());
});
net.on('close', () => ui.onConnectionState('reconnecting'));

net.on('spawn', (msg) => {
  if (msg.playerId === localId) {
    if (zombiesActive) {
      // The pistol start. ZombiesState corrects the pair within a second if
      // this respawn actually restored a bought arsenal.
      applyLoadout({
        primary: WeaponId.Kestrel,
        attachments: [AttachmentId.None, AttachmentId.None, AttachmentId.None],
        camo: CamoId.Gunmetal,
        skin: ui.getLoadout().skin,
      });
    } else {
      applyLoadout(msg.loadout);
    }
    weapons.reset();
    controller.setAngles(msg.yaw, 0);
    controller.requestLock();
  }
});

net.on('kill', (msg) => {
  ui.onKill(msg);
  if (msg.killerId === localId && msg.victimId !== localId) {
    Effects.triggerHitmarker('kill');
  }
});

net.on('hit', (msg) => {
  Effects.spawnImpact(msg.point, msg.normal, SurfaceMaterial.Composite);
  if (msg.attackerId === localId) {
    Effects.spawnBlood(msg.point, msg.normal, false);
    Effects.triggerHitmarker(msg.part === 0 /* Head */ ? 'headshot' : 'hit');
  }
  if (msg.victimId === localId) {
    // Damage direction, as an angle relative to where the camera is looking.
    const dx = msg.point.x - camPos.x;
    const dz = msg.point.z - camPos.z;
    ui.showDamageFrom(Math.atan2(dx, dz) - lastYaw);
    renderer.setDamageIntensity(1);
  }
});

// A remote player fired: muzzle flash, tracer and a whizz-by if it passed
// close. For the horde the same flag means "swung" — lunge, don't flash.
net.on('fired', (id) => {
  const remote = lastRemotes.get(id);
  if (!remote) return;
  if (isZombieId(id)) {
    horde.triggerAttack(id);
    Audio.play('zombie_attack', { position: remote.position });
    return;
  }
  const origin = {
    x: remote.position.x,
    y: remote.position.y + eyeHeightForStance(remote.stance),
    z: remote.position.z,
  };
  const dir = {
    x: -Math.sin(remote.yaw) * Math.cos(remote.pitch),
    y: Math.sin(remote.pitch),
    z: -Math.cos(remote.yaw) * Math.cos(remote.pitch),
  };
  const end = { x: origin.x + dir.x * 120, y: origin.y + dir.y * 120, z: origin.z + dir.z * 120 };
  Effects.spawnMuzzleFlash(origin, dir);
  Effects.spawnTracer(origin, end);
  Audio.play('sniper_fire', { position: origin });
  Audio.playWhizz(origin, end);
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let localId: PlayerId = 0;
let accumulator = 0;
let lastFrame = performance.now();
/** Last frame's interpolated remotes, so the `fired` event can locate a shooter. */
let lastRemotes: Map<PlayerId, RemotePlayerState> = new Map();

const avatarStates = new Map<PlayerId, AvatarState>();
const zombieStates = new Map<PlayerId, RemotePlayerState>();
const scoreboard: ScoreboardEntry[] = [];

// --- ZOMBIES client state ----------------------------------------------------

let zombiesActive = false;
let lobbySize = 1;
let lastZombies: ZombiesStateMsg | null = null;
let localDowned = false;
let wasDowned = false;
let prevUseDown = false;
let lastButtons = 0;
let viewmodelWeapon: WeaponId | null = null;
let doors: DoorManager | null = null;
let barricades: BarricadeManager | null = null;
/** Zombie ids seen last frame, for death audio on removal. */
let prevZombieIds = new Set<PlayerId>();
let groanTimer = 0;
const downedNames: string[] = [];

/**
 * Play the audio a ZombiesState transition implies. Pure diff of the previous
 * against the next message — the server never sends explicit sound cues.
 */
function diffZombiesState(prev: ZombiesStateMsg | null, next: ZombiesStateMsg): void {
  if (!zombiesActive) return;
  if (!prev) return;
  if (next.round > prev.round) {
    Audio.play(isFogRound(next.round) ? 'fog_round' : 'round_start');
  } else if (next.phase !== prev.phase && next.phase === 0 /* Intermission */ && prev.round > 0) {
    Audio.play('round_end');
  }
  if (next.powerOn && !prev.powerOn) Audio.play('perk_jingle');
  if (next.perks !== prev.perks && perkCount(next.perks) > perkCount(prev.perks)) {
    Audio.play('perk_jingle');
  }
  if (next.forged !== prev.forged && next.forged > prev.forged) Audio.play('forge_upgrade');
  if (next.points < prev.points) Audio.play('buy');
  if (next.boxOffer !== 255 && prev.boxOffer === 255) Audio.play('box_offer');
  // Drops: new ids shimmer in; ids that left early were picked up; ids that
  // ran their clock out expired.
  for (const d of next.drops) {
    if (!prev.drops.some((p) => p.id === d.id)) Audio.play('powerup_spawn', { position: d.pos });
  }
  for (const d of prev.drops) {
    if (next.drops.some((n) => n.id === d.id)) continue;
    Audio.play(d.secondsLeft <= 1.5 ? 'powerup_expire' : 'powerup_pickup');
  }
}

/** "Hold F to revive NAME" when a downed teammate is in reach, else null. */
function revivePrompt(remotes: Map<PlayerId, RemotePlayerState>): string | null {
  const me = net.renderPosition();
  for (const [id, r] of remotes) {
    if (id === localId || isZombieId(id)) continue;
    if (!r.alive || r.downed !== true) continue;
    const dx = r.position.x - me.x;
    const dy = r.position.y - me.y;
    const dz = r.position.z - me.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= 1.9) {
      return `Hold [F] to revive ${r.name || 'your teammate'}`;
    }
  }
  return null;
}

/**
 * Which map the render world and the prediction collision world are built
 * for. The static world is built ONCE per map — doors are individual meshes
 * the DoorManager flips, so a zone purchase costs a prediction-BVH rebuild
 * and nothing else (the old mode rebuilt the whole merged world, a hitch).
 */
let worldKey = 'sundeck';
let predictionMask = -1;
function ensureWorld(mode: GameMode | null, zoneMask: number): void {
  const key = mode === GameMode.Zombies ? 'shipbreak' : 'sundeck';
  if (key !== worldKey) {
    worldKey = key;
    predictionMask = -1;
    world.dispose();
    doors?.dispose();
    doors = null;
    barricades?.dispose();
    barricades = null;
    drops.clear();
    if (mode === GameMode.Zombies) {
      // Static geometry without the doors; blockers are skipped by the
      // brush builder itself.
      const allDoorIds = new Set(ZMAP.doorBrushIdsByZone.flat());
      const staticBrushes = ZMAP.brushes.filter((b) => !allDoorIds.has(b.id));
      world = buildWorld(renderer.scene, Materials, {
        brushes: staticBrushes,
        waterLevel: ZMAP.waterLevel,
      });
      doors = new DoorManager(renderer.scene, ZMAP, Materials);
      barricades = new BarricadeManager(renderer.scene, ZMAP);
      renderer.setFogProfile(40, 300, 0xc9a684);
    } else {
      world = buildWorld(renderer.scene, Materials);
      renderer.setFogProfile();
      horde.sync(new Map(), camPos, 0);
      prevZombieIds = new Set();
    }
  }
  const mask = mode === GameMode.Zombies ? zoneMask : 0;
  if (mask !== predictionMask) {
    predictionMask = mask;
    if (mode === GameMode.Zombies) {
      const brushes = collisionBrushesFor(ZMAP, zoneMask);
      net.predictor.setWorld(createCollisionWorld(brushes, ZMAP.bounds, ZMAP.waterLevel));
    } else {
      net.predictor.setWorld(createCollisionWorld());
    }
  }
}

interface ZombiesAction {
  prompt: string;
  send: () => void;
}

/** The nearest thing [F] would do right now, or null. Pure over the inputs. */
function zombiesActionAt(pos: { x: number; y: number; z: number }): ZombiesAction | null {
  const zs = lastZombies;
  if (!zs) return null;
  const zoneOpen = (zone: number): boolean => (zs.zoneMask & (1 << zone)) !== 0;
  const dist = (p: { x: number; y: number; z: number }): number => {
    const dx = p.x - pos.x;
    const dy = p.y - pos.y;
    const dz = p.z - pos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  // A box roll waiting for us beats everything else.
  if (zs.boxOffer !== 255) {
    const name = WEAPONS[zs.boxOffer as WeaponId]?.name ?? 'weapon';
    return { prompt: `[F] Take the ${name}`, send: () => net.interact(InteractTarget.BoxTake) };
  }

  let best: ZombiesAction | null = null;
  let bestD = 2.8; // reach, slightly under the server's INTERACT_RADIUS

  for (const i of ZMAP.interactables) {
    if (!zoneOpen(i.zone)) continue;
    const d = dist(i.pos);
    if (d >= bestD) continue;
    let action: ZombiesAction | null = null;
    if (i.kind === InteractableKind.WallBuy && i.weapon !== undefined) {
      const weapon = i.weapon;
      const owned = weapons.runtime.weapon === weapon || weapons.runtime.stowedWeapon === weapon;
      const forged = (zs.forged & (1 << weapon)) !== 0;
      const cost = owned ? ammoCostFor(weapon, forged) : (WALL_COSTS[weapon] ?? 0);
      action = {
        prompt: `[F] ${WEAPONS[weapon].name}${owned ? ' ammo' : ''} — ${cost}`,
        send: () => net.purchase(PurchaseKind.Weapon, weapon),
      };
    } else if (i.kind === InteractableKind.Perk && i.perk !== undefined) {
      const perk = i.perk;
      if (hasPerk(zs.perks, perk) || perkCount(zs.perks) >= MAX_PERKS) continue;
      const solo = lobbySize <= 1;
      const cost =
        perk === PerkId.SecondWind && solo ? PERK_COST_SECOND_WIND_SOLO : PERK_COSTS[perk];
      action = {
        prompt: zs.powerOn
          ? `[F] ${PERK_NAMES[perk]} — ${cost}`
          : `${PERK_NAMES[perk]} — needs power`,
        send: () => net.purchase(PurchaseKind.Perk, perk),
      };
    } else if (i.kind === InteractableKind.Generator) {
      if (zs.powerOn) continue;
      action = { prompt: '[F] Restore the power', send: () => net.interact(InteractTarget.Power) };
    } else if (i.kind === InteractableKind.Forge) {
      const heldForged = (zs.forged & (1 << zs.held)) !== 0;
      if (heldForged) continue;
      action = {
        prompt: zs.powerOn ? `[F] The Forge — ${FORGE_COST}` : 'The Forge — needs power',
        send: () => net.purchase(PurchaseKind.Forge, 0),
      };
    } else if (i.kind === InteractableKind.CrateSpot) {
      if (zs.boxSpot !== (i.spot ?? -1)) continue;
      action = {
        prompt: `[F] Mystery box — ${BOX_COST}`,
        send: () => {
          Audio.play('box_spin');
          net.purchase(PurchaseKind.Box, 0);
        },
      };
    }
    if (action) {
      best = action;
      bestD = d;
    }
  }

  // Boarded windows: offer the repair when boards are missing.
  for (const w of ZMAP.windows) {
    if (!zoneOpen(w.zone)) continue;
    const planks = zs.planks[w.id] ?? 6;
    if (planks >= 6) continue;
    const d = dist(w.pos);
    if (d >= Math.min(bestD, 1.9)) continue;
    best = { prompt: '[F] Hold to rebuild the barrier', send: () => {} };
    bestD = d;
  }

  // Zone doors: buyable when a neighbouring zone is open and we stand at a door.
  for (const zone of ZMAP.zones) {
    if (zoneOpen(zone.id)) continue;
    if (!zone.adjacent.some((a) => zoneOpen(a))) continue;
    const doorIds = ZMAP.doorBrushIdsByZone[zone.id] ?? [];
    for (const brush of ZMAP.brushes) {
      if (!doorIds.includes(brush.id)) continue;
      const d = dist(brush.center);
      if (d >= Math.min(bestD, 3.5)) continue;
      const gated = zone.requiresPower && !zs.powerOn;
      best = {
        prompt: gated
          ? `${zone.name} — needs power`
          : `[F] Open ${zone.name} — ${zone.cost}`,
        send: () => net.purchase(PurchaseKind.Zone, zone.id),
      };
      bestD = d;
    }
  }

  return best;
}

net.connect(pendingName);
ui.onConnectionState('connecting');

requestAnimationFrame(frame);

function frame(now: number): void {
  requestAnimationFrame(frame);

  const dt = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;

  // --- fixed-rate input + prediction ---------------------------------------
  accumulator += dt;
  let steps = 0;
  while (accumulator >= TICK_DT && steps < 8) {
    const input = controller.sample();
    // ZOMBIES last stand: apply the same button mask the server applies, so
    // prediction agrees that a downed player crawls and shoots the pistol.
    if (zombiesActive && localDowned) input.buttons = filterDownedButtons(input.buttons);
    lastButtons = input.buttons;
    net.tick(now, input);
    accumulator -= TICK_DT;
    steps += 1;
  }
  // If the tab was backgrounded, drop the backlog rather than fast-forwarding
  // the simulation through hundreds of ticks.
  if (accumulator > TICK_DT * 8) accumulator = 0;

  net.update(now, dt);

  // --- camera --------------------------------------------------------------
  const local = net.localState;
  const stance: Stance = local.stance ?? Stance.Stand;

  const renderPos = net.renderPosition();
  const yaw = controller.yaw;
  const pitch = controller.pitch;

  const vmOut = viewmodel.update(dt, {
    lookDeltaYaw: yaw - lastYaw,
    lookDeltaPitch: pitch - lastPitch,
    velocity: local.velocity,
    onGround: local.onGround,
    stance,
    sprinting: horizontalSpeed(local.velocity) > 6.5 && weapons.adsState === AdsState.Hip,
    adsProgress: weapons.adsEased,
    adsState: weapons.adsState,
    cameraPos: renderPos,
    viewYaw: yaw,
    viewPitch: pitch,
  });
  lastYaw = yaw;
  lastPitch = pitch;

  camPos.set(renderPos.x, renderPos.y + eyeHeightForStance(stance), renderPos.z);
  renderer.camera.position.copy(camPos);
  renderer.camera.rotation.set(pitch + vmOut.cameraPitchOffset, yaw + vmOut.cameraYawOffset, 0);

  // NB: the viewmodel camera is pinned to identity by the Renderer itself —
  // the viewmodel scene is camera space. Do not pose it from here.

  // Recoil punch pulls the camera back along its own view axis.
  renderer.camera.getWorldDirection(camForward);
  renderer.camera.position.addScaledVector(camForward, -vmOut.cameraPunch);

  const fov = baseFov + (weapons.scopedFov() - baseFov) * weapons.adsEased;
  renderer.setWorldFov(fov);

  // --- remote players (and, in ZOMBIES, the horde) --------------------------
  const remotes = net.remotePlayers(now);
  lastRemotes = remotes;
  avatarStates.clear();
  zombieStates.clear();
  downedNames.length = 0;
  for (const [id, r] of remotes) {
    if (id === localId) continue;
    if (isZombieId(id)) {
      zombieStates.set(id, r);
      continue;
    }
    if (zombiesActive && r.alive && r.downed === true) downedNames.push(r.name || `Player ${id}`);
    avatarStates.set(id, {
      position: r.position,
      yaw: r.yaw,
      pitch: r.pitch,
      stance: r.stance,
      alive: r.alive,
      team: r.team ?? TeamId.FFA,
      name: r.name ?? '',
      loadout: r.loadout ?? weapons.loadout,
    });
  }
  avatars.sync(avatarStates, {
    localTeam: remotes.get(localId)?.team ?? TeamId.FFA,
    cameraPos: camPos,
  });

  // --- ZOMBIES: horde, drops, prompts, downed state --------------------------
  localDowned = false;
  if (zombiesActive) {
    horde.sync(zombieStates, camPos, dt);
    drops.sync(lastZombies?.drops ?? [], dt);
    doors?.update(dt);

    // Death gurgles: any id that vanished this frame died where we last saw it.
    for (const id of prevZombieIds) {
      if (zombieStates.has(id)) continue;
      const last = lastRemotes.get(id);
      Audio.play('zombie_die', last ? { position: last.position } : undefined);
    }
    // And wet emergence for the ones that just clawed in.
    for (const [id, z] of zombieStates) {
      if (!prevZombieIds.has(id)) Audio.play('zombie_spawn', { position: z.position });
    }
    prevZombieIds = new Set(zombieStates.keys());

    // Ambient groans, throttled: the nearest shambler moans every second or so.
    groanTimer -= dt;
    if (groanTimer <= 0 && zombieStates.size > 0) {
      groanTimer = 1.1 + Math.random() * 1.4;
      let nearest: RemotePlayerState | null = null;
      let nd = Infinity;
      for (const z of zombieStates.values()) {
        const dx = z.position.x - camPos.x;
        const dz = z.position.z - camPos.z;
        const d = dx * dx + dz * dz;
        if (d < nd) {
          nd = d;
          nearest = z;
        }
      }
      if (nearest && nd < 45 * 45) {
        Audio.play('zombie_groan', { position: nearest.position, pitch: 0.85 + Math.random() * 0.35 });
      }
    }

    // Blood Fog atmosphere follows the round.
    const fogRound = lastZombies !== null && isFogRound(lastZombies.round) && lastZombies.phase === 1;
    renderer.setFogProfile(fogRound ? 22 : 40, fogRound ? 160 : 300, fogRound ? 0x8f3a34 : 0xc9a684);

    const mine = net.snapshots.latest()?.players.get(localId);
    localDowned = mine?.downed === true;
    if (localDowned && !wasDowned) Audio.play('downed_sting');
    if (!localDowned && wasDowned && local.alive !== false) Audio.play('revive_ok');
    wasDowned = localDowned;

    const useDown = controller.locked && (lastButtons & InputButton.Use) !== 0;
    if (local.alive !== false && !localDowned && controller.locked) {
      const action = zombiesActionAt(net.renderPosition());
      ui.setZombiesPrompt(action ? action.prompt : revivePrompt(remotes));
      if (action && useDown && !prevUseDown && action.prompt.startsWith('[F]') ) action.send();
    } else {
      ui.setZombiesPrompt(null);
    }
    prevUseDown = useDown;
    ui.setZombiesDowned(downedNames);

    // Keep the first-person gun mesh in step with the predicted weapon.
    if (weapons.runtime.weapon !== viewmodelWeapon) {
      viewmodelWeapon = weapons.runtime.weapon;
      viewmodel.setWeapon(viewmodelWeapon, CamoId.Gunmetal, []);
    }
  } else if (viewmodelWeapon !== null) {
    viewmodelWeapon = null;
    ui.setZombiesPrompt(null);
    ui.setZombiesDowned([]);
  }

  // --- audio ---------------------------------------------------------------
  Audio.setListener(camPos, camForward, camUp);

  // --- HUD -----------------------------------------------------------------
  ui.setLocalState({
    health: local.health ?? 100,
    alive: local.alive ?? true,
    weapon: weapons.runtime.weapon,
    ammoInMag: weapons.ammoInMag,
    ammoReserve: weapons.ammoReserve,
    adsState: weapons.adsState,
    adsProgress: weapons.adsEased,
    reloading: weapons.busy,
    kills: local.kills ?? 0,
    score: local.score ?? 0,
    streak: local.streak ?? 0,
    respawnIn: local.alive === false ? RESPAWN_DELAY : 0,
    downed: localDowned,
  });

  buildScoreboard(remotes, local);
  ui.setScoreboard(scoreboard);

  // --- weapon presentation events ------------------------------------------
  for (const ev of weapons.consumeEvents()) {
    switch (ev.type) {
      case WeaponEventType.Fire:
        viewmodel.onFire();
        Audio.play(
          ev.weapon === WeaponId.Kestrel || ev.weapon === WeaponId.Osprey || ev.weapon === WeaponId.Condor
            ? 'pistol_fire'
            : 'sniper_fire',
        );
        break;
      case WeaponEventType.DryFire:
        Audio.play('dryfire');
        break;
      case WeaponEventType.ReloadStart:
        viewmodel.onReload(ev.empty);
        break;
      default:
        break;
    }
  }

  // --- render ---------------------------------------------------------------
  world.update(dt, camPos);
  Effects.update(dt);
  renderer.setDamageIntensity(Math.max(0, damageFlash -= dt * 2));
  renderer.render(dt);
}

let damageFlash = 0;

function horizontalSpeed(v: { x: number; z: number }): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

function buildScoreboard(
  remotes: Map<PlayerId, { name: string; team: TeamId; score: number; kills: number; deaths: number }>,
  local: { score?: number; kills?: number; deaths?: number }
): void {
  scoreboard.length = 0;
  for (const [id, r] of remotes) {
    if (isZombieId(id)) continue; // the horde does not get scoreboard rows
    scoreboard.push({
      id,
      name: r.name ?? `Player ${id}`,
      team: r.team ?? TeamId.FFA,
      score: r.score ?? 0,
      kills: r.kills ?? 0,
      deaths: r.deaths ?? 0,
      // Per-player best trickshot is only authoritative in MatchOver; the UI
      // shows the real values there.
      bestTrickshotScore: 0,
      bestTrickshotFlags: 0,
    } satisfies ScoreboardEntry);
  }
  scoreboard.sort((a, b) => b.score - a.score || b.kills - a.kills);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

window.addEventListener('beforeunload', () => {
  net.disconnect();
});

// Surface the material penetration table to the console in debug builds so the
// value is greppable when tuning FMJ. Zero cost otherwise.
if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as Record<string, unknown>).DECKSHOT = {
    net,
    renderer,
    weapons,
    controller,
    viewmodel,
    MATERIAL_PENETRATION,
    tickRate: TICK_RATE,
  };
}
