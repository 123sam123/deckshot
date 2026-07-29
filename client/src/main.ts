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

import { TICK_DT, TICK_RATE, RESPAWN_DELAY, eyeHeightForStance } from '../../shared/tuning.js';
import { AdsState, Stance, TeamId, WeaponId, type Loadout, type PlayerId } from '../../shared/types.js';
import { MATERIAL_PENETRATION, SurfaceMaterial } from '../../shared/mapdata.js';
import type { ScoreboardEntry } from '../../shared/protocol.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
if (!canvas || !uiRoot) throw new Error('index.html is missing #game or #ui');

const renderer = new Renderer(canvas);
const world: WorldHandle = buildWorld(renderer.scene, Materials);
const avatars = new AvatarPool(renderer.scene);
const viewmodel = new Viewmodel(renderer.viewmodelScene);

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
net.on('lobby', (msg) => ui.onLobbyState(msg));
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
    applyLoadout(msg.loadout);
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

// A remote player fired: muzzle flash, tracer and a whizz-by if it passed close.
net.on('fired', (id) => {
  const remote = lastRemotes.get(id);
  if (!remote) return;
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
const scoreboard: ScoreboardEntry[] = [];

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

  // --- remote players -------------------------------------------------------
  const remotes = net.remotePlayers(now);
  lastRemotes = remotes;
  avatarStates.clear();
  for (const [id, r] of remotes) {
    if (id === localId) continue;
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
  avatars.sync(avatarStates);

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
  });

  buildScoreboard(remotes, local);
  ui.setScoreboard(scoreboard);

  // --- weapon presentation events ------------------------------------------
  for (const ev of weapons.consumeEvents()) {
    switch (ev.type) {
      case WeaponEventType.Fire:
        viewmodel.onFire();
        Audio.play(ev.weapon === WeaponId.Kestrel ? 'pistol_fire' : 'sniper_fire');
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
