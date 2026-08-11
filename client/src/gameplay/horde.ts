/**
 * DECKSHOT — ZOMBIES: the horde renderer.
 *
 * Owner: zombies (full rewrite; replaces the deleted client/src/gameplay/zombies.ts).
 *
 * DRAW-CALL BUDGET: the whole horde — up to 28 live zombies plus 8 fading
 * corpses — renders as EIGHT InstancedMeshes (head, torso, pelvis, arm L/R,
 * leg L/R, one emissive eye piece) over THREE shared materials. That is
 * 8 draw calls total against a budget of 10, versus the predecessor's
 * 7 meshes PER zombie (~170 draw calls for a full round). Only the torso and
 * head meshes cast shadows — instanced meshes cast as a whole, so per-zombie
 * shadow range toggling is gone by design; two casters is the whole bill.
 *
 * HITBOX-SILHOUETTE RULE: every part is sized from the SAME `HITBOX_TEMPLATE`
 * capsules the server hit-tests (with a small radial inset, like avatars.ts),
 * so the rest-pose silhouette can never disagree with the hitboxes — in a
 * mode scored on headshot multipliers, a fatter or thinner body reads as
 * broken hit detection. Procedural animation swings limbs around joints that
 * sit ON the template (neck, waist, shoulders, hips), keeping the animated
 * mass centred on the capsules the shots actually test.
 *
 * All per-frame math composes Matrix4s from module-scope scratch objects —
 * no Object3D graph, no per-frame allocation.
 */

import * as THREE from 'three';

import { HITBOX_TEMPLATE } from '../../../shared/hitbox.js';
import { HitboxPart, type HitboxCapsule } from '../../../shared/types.js';
import {
  ZOMBIE_MELEE_WINDUP,
  ZOMBIE_POOL_SIZE,
  isZombieId,
} from '../../../shared/zombies.js';
import type { RemotePlayerState } from '../net/interpolation.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Corpse slots on top of the live pool. Oldest corpse is evicted past this. */
const MAX_CORPSES = 8;
const CAPACITY = ZOMBIE_POOL_SIZE + MAX_CORPSES;

/** Radial inset so the visual surface sits a hair inside the hitbox. */
const INSET = 0.96;

/** Forward slump of the torso, radians (negative pitch = toward -Z). */
const LEAN = 0.15;
/** Base raised-forward reach of the arms, radians above hanging. */
const ARM_REACH = 1.2;
/** Constant outward splay of the arms, radians of roll. */
const ARM_SPLAY = 0.14;
/** Thigh swing amplitude at full stride, radians. */
const LEG_SWING = 0.5;
/** Body bob amplitude at full stride, meters (at 2x step rate). */
const BOB = 0.04;
/** Meters of travel per full gait cycle: cadence scales with speed for free. */
const STRIDE = 1.5;
/** Speed (m/s) at which the walk blend saturates; below ~0 it is the idle claw. */
const WALK_FULL_SPEED = 1.5;
/** Beyond this camera distance, secondary motion (sway/bob/claw) is skipped. */
const ANIM_LOD_DIST = 45;

// Attack lunge: raise through the windup, slam crossing the strike point at
// ZOMBIE_MELEE_WINDUP (when the server lands the damage), short recover.
const ATK_RAISE_END = ZOMBIE_MELEE_WINDUP * 0.8; // 0.28 s
const ATK_SLAM_END = ZOMBIE_MELEE_WINDUP + 0.03; // 0.38 s
const ATK_TOTAL = 0.58;
const ATK_RAISE_ARM = 0.65;
const ATK_SLAM_ARM = -1.05;
const ATK_RAISE_TORSO = 0.12;
const ATK_SLAM_TORSO = -0.45;

// Death: fold at the pelvis, sink 0.4 m, scale-Y to zero through the deck.
const DEATH_DURATION = 0.7;
const DEATH_FOLD_TIME = 0.3;
const DEATH_SINK = 0.4;

// Look: drowned shipbreaker crew.
const COVERALL_COLOR = 0x3a4440;
const RUST_COLOR = 0x74452a;
const HEAD_COLOR = 0x8a9a84;
const EYE_COLOR = 0xff7722;
const EYE_INTENSITY = 2;

const TWO_PI = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Skeleton layout, derived from the hitbox template
// ---------------------------------------------------------------------------

function capFor(part: HitboxPart): HitboxCapsule {
  for (const c of HITBOX_TEMPLATE) if (c.part === part) return c;
  throw new Error(`horde: HITBOX_TEMPLATE has no capsule for part ${part}`);
}

const midY = (c: HitboxCapsule): number => (c.a.y + c.b.y) * 0.5;
const lenOf = (c: HitboxCapsule): number => Math.abs(c.b.y - c.a.y);

const CAP_HEAD = capFor(HitboxPart.Head);
const CAP_CHEST = capFor(HitboxPart.Chest);
const CAP_STOMACH = capFor(HitboxPart.Stomach);
const CAP_ARM = capFor(HitboxPart.ArmL); // L/R are mirrors; one geometry each side
const CAP_LEG = capFor(HitboxPart.LegL);

/** Joints, in body space (+Y up, origin at the feet, -Z forward). */
const WAIST_Y = CAP_STOMACH.b.y; // fold line: top of the pelvis
const NECK_Y = CAP_HEAD.a.y - CAP_HEAD.radius;
const SHOULDER_Y = CAP_ARM.b.y;
const SHOULDER_X = Math.abs(CAP_ARM.a.x);
const HIP_Y = CAP_LEG.b.y;
const HIP_X = Math.abs(CAP_LEG.a.x);

/** Geometry-centre offsets from their joint pivots. */
const HEAD_OFF_Y = midY(CAP_HEAD) - NECK_Y;
const TORSO_OFF_Y = midY(CAP_CHEST) - WAIST_Y;
const PELVIS_Y = midY(CAP_STOMACH);
const ARM_OFF_Y = midY(CAP_ARM) - SHOULDER_Y;
const LEG_OFF_Y = midY(CAP_LEG) - HIP_Y;

// ---------------------------------------------------------------------------
// Module-scope scratch — the entire per-frame math runs through these.
// ---------------------------------------------------------------------------

const _yawQ = new THREE.Quaternion();
const _torsoQ = new THREE.Quaternion();
const _ownQ = new THREE.Quaternion();
const _chainQ = new THREE.Quaternion();
const _partQ = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _vTmp = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _ONE = new THREE.Vector3(1, 1, 1); // never mutated
const _mat = new THREE.Matrix4();
const _squash = new THREE.Matrix4();
const _zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();
const _rust = new THREE.Color();

/** Pose parameters for one zombie, filled then written. Module scope: no alloc. */
const _pose = {
  torsoPitch: 0,
  torsoRoll: 0,
  pelvisPitch: 0,
  pelvisRoll: 0,
  headYaw: 0,
  headRoll: 0,
  armL: 0,
  armR: 0,
  legL: 0,
  legR: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutQuad = (k: number): number => k * (2 - k);
const easeInQuad = (k: number): number => k * k;

/** Deterministic 0..1 from an entity id — per-zombie phase and asymmetry. */
function hash01(id: number, salt: number): number {
  let h = Math.imul(id + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Two eye quads facing -Z, authored in head-centre space so the eyes reuse the
 *  head's instance matrix verbatim (one extra draw call, zero extra math). */
function buildEyeGeometry(headRadius: number): THREE.BufferGeometry {
  const w = 0.032;
  const h = 0.02;
  const sep = 0.042; // pupil half-separation
  const y = 0.012;
  const z = -(headRadius - 0.004); // just inside the head surface

  const positions: number[] = [];
  const indices: number[] = [];
  for (const cx of [-sep, sep]) {
    const base = positions.length / 3;
    positions.push(
      cx - w / 2, y - h / 2, z,
      cx + w / 2, y - h / 2, z,
      cx + w / 2, y + h / 2, z,
      cx - w / 2, y + h / 2, z,
    );
    // Wound so the faces point -Z (the zombie's forward).
    indices.push(base, base + 3, base + 1, base + 1, base + 3, base + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const normals = new Float32Array(positions.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = -1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

// ---------------------------------------------------------------------------
// Bookkeeping records
// ---------------------------------------------------------------------------

interface Track {
  slot: number;
  hashA: number;
  hashB: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  lastYaw: number;
  /** Horizontal meters travelled — the gait phase driver. */
  dist: number;
  /** Smoothed horizontal speed, m/s. */
  speed: number;
  /** Seconds into the attack lunge, or -1 when not attacking. */
  attackT: number;
}

interface Corpse {
  slot: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hashA: number;
  t: number;
}

// ---------------------------------------------------------------------------
// HordePool
// ---------------------------------------------------------------------------

/**
 * Renders the whole horde through a fixed set of InstancedMeshes.
 *
 * `sync` every frame with the interpolated snapshot states (non-zombie ids are
 * ignored); `triggerAttack` from the net 'fired' event to play the lunge; ids
 * that vanish from `states` (or flip !alive) collapse into corpse slots.
 */
export class HordePool {
  private readonly head: THREE.InstancedMesh;
  private readonly torso: THREE.InstancedMesh;
  private readonly pelvis: THREE.InstancedMesh;
  private readonly armL: THREE.InstancedMesh;
  private readonly armR: THREE.InstancedMesh;
  private readonly legL: THREE.InstancedMesh;
  private readonly legR: THREE.InstancedMesh;
  private readonly eyes: THREE.InstancedMesh;
  private readonly meshes: THREE.InstancedMesh[];
  /** The coverall-clad parts that take the per-instance rust tint. */
  private readonly bodyMeshes: THREE.InstancedMesh[];

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly headMat: THREE.MeshStandardMaterial;
  private readonly eyeMat: THREE.MeshStandardMaterial;

  private readonly tracks = new Map<number, Track>();
  private readonly corpses: Corpse[] = [];
  private readonly freeSlots: number[] = [];
  private time = 0;
  private colorsDirty = false;

  constructor(private readonly scene: THREE.Scene) {
    // --- shared materials (3 total; instanceColor carries the tint) --------
    this.bodyMat = new THREE.MeshStandardMaterial({
      name: 'deckshot/zombie-body',
      color: 0xffffff, // multiplied by the per-instance rust-stained coverall tint
      roughness: 0.92,
      metalness: 0.04,
    });
    this.headMat = new THREE.MeshStandardMaterial({
      name: 'deckshot/zombie-head',
      color: HEAD_COLOR,
      roughness: 0.85,
      metalness: 0.02,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({
      name: 'deckshot/zombie-eyes',
      color: 0x000000,
      emissive: EYE_COLOR,
      emissiveIntensity: EYE_INTENSITY,
      fog: false, // the embers must read at 60 m and through Blood Fog
    });

    // --- geometry, authored once from the hitbox capsules -------------------
    const headGeo = new THREE.CapsuleGeometry(CAP_HEAD.radius * INSET, lenOf(CAP_HEAD), 3, 10);
    const torsoGeo = new THREE.CapsuleGeometry(CAP_CHEST.radius * INSET, lenOf(CAP_CHEST), 3, 10);
    const pelvisGeo = new THREE.CapsuleGeometry(CAP_STOMACH.radius * INSET, lenOf(CAP_STOMACH), 2, 8);
    const armGeo = new THREE.CapsuleGeometry(CAP_ARM.radius * INSET, lenOf(CAP_ARM), 2, 8);
    const legGeo = new THREE.CapsuleGeometry(CAP_LEG.radius * INSET, lenOf(CAP_LEG), 2, 8);
    const eyeGeo = buildEyeGeometry(CAP_HEAD.radius * INSET);
    this.geometries.push(headGeo, torsoGeo, pelvisGeo, armGeo, legGeo, eyeGeo);

    // --- the eight draw calls ------------------------------------------------
    // Shadows: torso + head only. Instanced meshes cast as a whole, so the old
    // per-zombie 15 m shadow toggle is replaced by capping the caster count.
    this.head = this.makeMesh(headGeo, this.headMat, 'horde/head', true);
    this.torso = this.makeMesh(torsoGeo, this.bodyMat, 'horde/torso', true);
    this.pelvis = this.makeMesh(pelvisGeo, this.bodyMat, 'horde/pelvis', false);
    this.armL = this.makeMesh(armGeo, this.bodyMat, 'horde/armL', false);
    this.armR = this.makeMesh(armGeo, this.bodyMat, 'horde/armR', false);
    this.legL = this.makeMesh(legGeo, this.bodyMat, 'horde/legL', false);
    this.legR = this.makeMesh(legGeo, this.bodyMat, 'horde/legR', false);
    this.eyes = this.makeMesh(eyeGeo, this.eyeMat, 'horde/eyes', false);
    this.eyes.receiveShadow = false;

    this.meshes = [
      this.head, this.torso, this.pelvis,
      this.armL, this.armR, this.legL, this.legR,
      this.eyes,
    ];
    this.bodyMeshes = [this.pelvis, this.torso, this.armL, this.armR, this.legL, this.legR];

    // Seed every slot's tint so an unpainted instance is never shader-black.
    for (let i = 0; i < CAPACITY; i++) {
      this.paintSlot(i, 0.5, 0.5);
      this.freeSlots.push(i);
    }
    for (const m of this.bodyMeshes) {
      if (m.instanceColor) m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
  }

  private makeMesh(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    name: string,
    castShadow: boolean,
  ): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, CAPACITY);
    m.name = name;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Per-instance placement makes the geometry bounding sphere meaningless.
    m.frustumCulled = false;
    m.castShadow = castShadow;
    m.receiveShadow = true;
    for (let i = 0; i < CAPACITY; i++) m.setMatrixAt(i, _zeroM);
    m.count = 0;
    this.scene.add(m);
    return m;
  }

  /** Rust-stained coverall tint, hashed per zombie. */
  private paintSlot(slot: number, hashA: number, hashB: number): void {
    _color.setHex(COVERALL_COLOR);
    _rust.setHex(RUST_COLOR);
    _color.lerp(_rust, hashB * 0.5);
    _color.multiplyScalar(0.8 + hashA * 0.4);
    for (const m of this.bodyMeshes) m.setColorAt(slot, _color);
    this.colorsDirty = true;
  }

  // --- slot management -------------------------------------------------------

  private claimSlot(): number {
    if (this.freeSlots.length === 0) {
      // 28 live + 8 corpses is exactly CAPACITY, so this only fires when the
      // horde is full AND all corpse slots are burning: evict the oldest body.
      const oldest = this.corpses.shift();
      if (!oldest) return -1;
      this.freeSlot(oldest.slot);
    }
    // Take the lowest free index so `.count` stays as tight as possible.
    let best = 0;
    for (let i = 1; i < this.freeSlots.length; i++) {
      if (this.freeSlots[i] < this.freeSlots[best]) best = i;
    }
    const slot = this.freeSlots[best];
    this.freeSlots[best] = this.freeSlots[this.freeSlots.length - 1];
    this.freeSlots.pop();
    return slot;
  }

  private freeSlot(slot: number): void {
    for (const m of this.meshes) m.setMatrixAt(slot, _zeroM);
    this.freeSlots.push(slot);
  }

  private killTrack(id: number, tr: Track): void {
    this.tracks.delete(id);
    this.corpses.push({
      slot: tr.slot,
      x: tr.lastX,
      y: tr.lastY,
      z: tr.lastZ,
      yaw: tr.lastYaw,
      hashA: tr.hashA,
      t: 0,
    });
    while (this.corpses.length > MAX_CORPSES) {
      const evicted = this.corpses.shift()!;
      this.freeSlot(evicted.slot);
    }
  }

  // --- public contract ---------------------------------------------------------

  /** Lunge animation for the net 'fired' event. Unknown ids are ignored. */
  triggerAttack(id: number): void {
    const tr = this.tracks.get(id);
    if (tr) tr.attackT = 0;
  }

  /** Drive the whole horde. Call once per frame with the interpolated states. */
  sync(states: Map<number, RemotePlayerState>, camPos: THREE.Vector3, dt: number): void {
    const step = dt > 0 ? Math.min(dt, 0.1) : 0;
    this.time += step;

    // --- live zombies -------------------------------------------------------
    for (const [id, s] of states) {
      if (!isZombieId(id)) continue;

      let tr = this.tracks.get(id);
      if (!s.alive) {
        if (tr) this.killTrack(id, tr);
        continue;
      }
      if (!tr) {
        const slot = this.claimSlot();
        if (slot < 0) continue; // cannot happen while CAPACITY covers pool+corpses
        tr = {
          slot,
          hashA: hash01(id, 1),
          hashB: hash01(id, 2),
          lastX: s.position.x,
          lastY: s.position.y,
          lastZ: s.position.z,
          lastYaw: s.yaw,
          dist: 0,
          speed: 0,
          attackT: -1,
        };
        this.tracks.set(id, tr);
        this.paintSlot(slot, tr.hashA, tr.hashB);
      }

      // Gait phase from actual travel: cadence scales with speed for free,
      // and a zombie parked at a window stops mid-stride instead of skating.
      const dx = s.position.x - tr.lastX;
      const dz = s.position.z - tr.lastZ;
      const moved = Math.hypot(dx, dz);
      if (moved < 2.5) {
        tr.dist += moved;
        const inst = step > 1e-4 ? moved / step : tr.speed;
        tr.speed += (inst - tr.speed) * Math.min(1, step * 10);
      } // else: teleport (spawn shuffle) — keep phase and speed
      tr.lastX = s.position.x;
      tr.lastY = s.position.y;
      tr.lastZ = s.position.z;
      tr.lastYaw = s.yaw;

      if (tr.attackT >= 0) {
        tr.attackT += step;
        if (tr.attackT > ATK_TOTAL) tr.attackT = -1;
      }

      this.writeLive(tr, s, camPos);
    }

    // --- deaths: ids that vanished from the snapshot -------------------------
    for (const [id, tr] of this.tracks) {
      if (!states.has(id)) this.killTrack(id, tr);
    }

    // --- corpses -------------------------------------------------------------
    let w = 0;
    for (let i = 0; i < this.corpses.length; i++) {
      const c = this.corpses[i];
      c.t += step;
      if (c.t >= DEATH_DURATION) {
        this.freeSlot(c.slot);
        continue;
      }
      this.writeCorpse(c);
      this.corpses[w++] = c;
    }
    this.corpses.length = w;

    // --- flush: one instanceMatrix upload per mesh per frame -----------------
    let maxSlot = -1;
    for (const tr of this.tracks.values()) if (tr.slot > maxSlot) maxSlot = tr.slot;
    for (const c of this.corpses) if (c.slot > maxSlot) maxSlot = c.slot;
    const count = maxSlot + 1;
    for (const m of this.meshes) {
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
    }
    if (this.colorsDirty) {
      for (const m of this.bodyMeshes) {
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      this.colorsDirty = false;
    }
  }

  // --- pose authoring ----------------------------------------------------------

  private writeLive(tr: Track, s: RemotePlayerState, camPos: THREE.Vector3): void {
    const dcx = s.position.x - camPos.x;
    const dcz = s.position.z - camPos.z;
    const far = dcx * dcx + dcz * dcz > ANIM_LOD_DIST * ANIM_LOD_DIST;

    const walk = clamp01(tr.speed / WALK_FULL_SPEED);
    const idle = 1 - walk;
    const phase = tr.hashA * TWO_PI + tr.dist * (TWO_PI / STRIDE);
    const swing = Math.sin(phase);
    // Per-zombie clock: desynced idle sway so a wall of zombies never metronomes.
    const t = this.time * (0.9 + tr.hashA * 0.25) + tr.hashB * 7;

    // Attack lunge: raise through the windup, slam through the strike point,
    // recover. Piecewise so the hit lands exactly when the server says it does.
    let atkArm = 0;
    let atkTorso = 0;
    if (tr.attackT >= 0) {
      const at = tr.attackT;
      if (at < ATK_RAISE_END) {
        const k = easeOutQuad(at / ATK_RAISE_END);
        atkArm = ATK_RAISE_ARM * k;
        atkTorso = ATK_RAISE_TORSO * k;
      } else if (at < ATK_SLAM_END) {
        const k = (at - ATK_RAISE_END) / (ATK_SLAM_END - ATK_RAISE_END);
        atkArm = ATK_RAISE_ARM + (ATK_SLAM_ARM - ATK_RAISE_ARM) * k;
        atkTorso = ATK_RAISE_TORSO + (ATK_SLAM_TORSO - ATK_RAISE_TORSO) * k;
      } else {
        const k = easeOutQuad((at - ATK_SLAM_END) / (ATK_TOTAL - ATK_SLAM_END));
        atkArm = ATK_SLAM_ARM * (1 - k);
        atkTorso = ATK_SLAM_TORSO * (1 - k);
      }
    }

    // Torso: permanent shamble lean, gait roll, idle sway, attack lunge.
    _pose.torsoPitch = -LEAN - 0.06 * walk + atkTorso;
    _pose.torsoRoll = far ? 0 : swing * 0.05 * walk + idle * Math.sin(t * 1.3) * 0.06;
    _pose.pelvisPitch = 0;
    _pose.pelvisRoll = far ? 0 : -swing * 0.04 * walk;

    // Head: rides the torso; sways with the gait, drifts when idling.
    _pose.headRoll = far ? 0 : Math.sin(phase + tr.hashB * 6) * 0.09 * walk + idle * Math.sin(t * 1.7) * 0.08;
    _pose.headYaw = far ? 0 : Math.sin(phase * 0.5 + tr.hashA * 4) * 0.12;

    // Arms: classic raised-forward reach, out-of-phase bob, per-id asymmetry
    // (one arm rides higher), alternating claw tears when parked at a window.
    const asym = (tr.hashB - 0.5) * 0.4;
    const bobL = far ? 0 : Math.sin(phase * 2 + tr.hashB * 4) * 0.08 * walk;
    const bobR = far ? 0 : Math.sin(phase * 2 + tr.hashB * 4 + Math.PI) * 0.08 * walk;
    const clawL = far ? 0 : idle * Math.sin(t * 3.1) * 0.3;
    const clawR = far ? 0 : idle * Math.sin(t * 3.1 + Math.PI) * 0.3;
    _pose.armL = ARM_REACH + asym + bobL + clawL + atkArm;
    _pose.armR = ARM_REACH - asym + bobR + clawR + atkArm;

    // Legs: opposing swing, amplitude ramping with speed (shamble -> pump).
    _pose.legL = swing * LEG_SWING * walk;
    _pose.legR = -swing * LEG_SWING * walk;

    // Bob at 2x step rate.
    const bobY = far ? 0 : Math.sin(phase * 2) * BOB * walk;
    this.writePose(tr.slot, s.position.x, s.position.y + bobY, s.position.z, s.yaw, 1, 0);
  }

  private writeCorpse(c: Corpse): void {
    const k = c.t / DEATH_DURATION;
    const fold = easeOutQuad(clamp01(c.t / DEATH_FOLD_TIME));
    const sink = DEATH_SINK * easeInQuad(k);
    // Fold first, then squash vertically toward the deck plane while sinking.
    const sy = 1 - clamp01((c.t - DEATH_FOLD_TIME) / (DEATH_DURATION - DEATH_FOLD_TIME));
    const lean = (c.hashA - 0.5) * 2;

    _pose.torsoPitch = -LEAN - 1.35 * fold;
    _pose.torsoRoll = 0.3 * fold * lean;
    _pose.pelvisPitch = -0.25 * fold;
    _pose.pelvisRoll = 0.15 * fold * lean;
    _pose.headRoll = 0.45 * fold * lean;
    _pose.headYaw = 0;
    _pose.armL = ARM_REACH * (1 - fold) + 0.15 * fold;
    _pose.armR = ARM_REACH * (1 - fold) + 0.15 * fold;
    _pose.legL = 0.35 * fold;
    _pose.legR = -0.25 * fold;

    this.writePose(c.slot, c.x, c.y - sink, c.z, c.yaw, sy, c.y);
  }

  /**
   * Composes and writes the eight part matrices for one slot from `_pose`.
   *
   * Two-level hierarchy, done by hand: legs and pelvis hang off the root
   * (feet position + yaw), the torso pivots at the waist, and the head and
   * arms ride the torso (pivot chained through the torso rotation). Each part
   * is `pivot + localQ * centreOffset`, rotated by yaw, translated to the
   * root, then `Matrix4.compose`d — no Object3D, no allocation.
   *
   * `sy`/`planeY`: corpse-only world-vertical squash toward the deck plane
   * (y' = planeY + sy * (y - planeY)), premultiplied so "scale-Y to zero as it
   * sinks through the deck" is exactly what happens.
   */
  private writePose(
    slot: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    sy: number,
    planeY: number,
  ): void {
    _yawQ.setFromAxisAngle(UP, yaw);

    // Pelvis — pivots about its own centre.
    _ownQ.setFromEuler(_euler.set(_pose.pelvisPitch, 0, _pose.pelvisRoll));
    this.put(this.pelvis, slot, x, y, z, 0, PELVIS_Y, 0, _ownQ, 0, 0, 0, sy, planeY);

    // Torso — pivots at the waist.
    _torsoQ.setFromEuler(_euler.set(_pose.torsoPitch, 0, _pose.torsoRoll));
    this.put(this.torso, slot, x, y, z, 0, WAIST_Y, 0, _torsoQ, 0, TORSO_OFF_Y, 0, sy, planeY);

    // Head — rides the torso: neck pivot chained through the torso rotation.
    _ownQ.setFromEuler(_euler.set(0, _pose.headYaw, _pose.headRoll));
    _chainQ.copy(_torsoQ).multiply(_ownQ);
    _vTmp.set(0, NECK_Y - WAIST_Y, 0).applyQuaternion(_torsoQ);
    const nx = _vTmp.x;
    const ny = WAIST_Y + _vTmp.y;
    const nz = _vTmp.z;
    this.put(this.head, slot, x, y, z, nx, ny, nz, _chainQ, 0, HEAD_OFF_Y, 0, sy, planeY);
    // The eyes are authored in head-centre space: reuse the head matrix as-is.
    this.eyes.setMatrixAt(slot, _mat);

    // Arms — shoulders ride the torso too.
    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? -1 : 1;
      const pitch = side === 0 ? _pose.armL : _pose.armR;
      _ownQ.setFromEuler(_euler.set(pitch, 0, sx * ARM_SPLAY));
      _chainQ.copy(_torsoQ).multiply(_ownQ);
      _vTmp.set(sx * SHOULDER_X, SHOULDER_Y - WAIST_Y, 0).applyQuaternion(_torsoQ);
      const px = _vTmp.x;
      const py = WAIST_Y + _vTmp.y;
      const pz = _vTmp.z;
      const mesh = side === 0 ? this.armL : this.armR;
      this.put(mesh, slot, x, y, z, px, py, pz, _chainQ, 0, ARM_OFF_Y, 0, sy, planeY);
    }

    // Legs — hang off the root at the hips.
    _ownQ.setFromEuler(_euler.set(_pose.legL, 0, 0));
    this.put(this.legL, slot, x, y, z, -HIP_X, HIP_Y, 0, _ownQ, 0, LEG_OFF_Y, 0, sy, planeY);
    _ownQ.setFromEuler(_euler.set(_pose.legR, 0, 0));
    this.put(this.legR, slot, x, y, z, HIP_X, HIP_Y, 0, _ownQ, 0, LEG_OFF_Y, 0, sy, planeY);
  }

  /** One part: compose position/quaternion/scale straight into the buffer. */
  private put(
    mesh: THREE.InstancedMesh,
    slot: number,
    rootX: number,
    rootY: number,
    rootZ: number,
    pivotX: number,
    pivotY: number,
    pivotZ: number,
    localQ: THREE.Quaternion,
    offX: number,
    offY: number,
    offZ: number,
    sy: number,
    planeY: number,
  ): void {
    _vTmp.set(offX, offY, offZ).applyQuaternion(localQ);
    _vTmp.x += pivotX;
    _vTmp.y += pivotY;
    _vTmp.z += pivotZ;
    _vTmp.applyQuaternion(_yawQ);
    _pos.set(rootX + _vTmp.x, rootY + _vTmp.y, rootZ + _vTmp.z);
    _partQ.copy(_yawQ).multiply(localQ);
    _mat.compose(_pos, _partQ, _ONE);
    if (sy < 1) {
      _squash.makeScale(1, sy, 1).setPosition(0, planeY * (1 - sy), 0);
      _mat.premultiply(_squash);
    }
    mesh.setMatrixAt(slot, _mat);
  }

  // --- teardown -----------------------------------------------------------------

  dispose(): void {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.dispose(); // frees the instance attribute buffers
    }
    for (const g of this.geometries) g.dispose();
    this.bodyMat.dispose();
    this.headMat.dispose();
    this.eyeMat.dispose();
    this.tracks.clear();
    this.corpses.length = 0;
    this.freeSlots.length = 0;
  }
}
