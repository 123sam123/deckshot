/**
 * DECKSHOT — SURVIVAL zombie bodies (the drowned crew).
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * Mirrors `AvatarPool`: bodies are built from the SAME `HITBOX_TEMPLATE` the
 * server hit-tests against, because in a mode about headshot multipliers a
 * silhouette that disagrees with the hitboxes reads as broken hit detection.
 * Shared geometry + materials across the pool: 24 zombies must not cost 24
 * material compiles, and only nearby zombies cast shadows (the perf budget).
 */

import * as THREE from 'three';

import { HITBOX_TEMPLATE } from '../../../shared/hitbox.js';
import { HitboxPart, type PlayerId, type Vec3 } from '../../../shared/types.js';

/** Beyond this distance from the camera a zombie stops casting a shadow. */
const SHADOW_RANGE = 15;

const UP = new THREE.Vector3(0, 1, 0);

export interface ZombieState {
  position: Vec3;
  yaw: number;
  alive: boolean;
}

interface CapsuleSpec {
  geo: THREE.CapsuleGeometry;
  mid: THREE.Vector3;
  quat: THREE.Quaternion;
  head: boolean;
}

/** One geometry set for every zombie in the pool. */
let capsuleSpecs: CapsuleSpec[] | null = null;
let bodyMat: THREE.MeshStandardMaterial | null = null;
let headMat: THREE.MeshStandardMaterial | null = null;

function ensureShared(): { specs: CapsuleSpec[]; body: THREE.Material; head: THREE.Material } {
  if (!capsuleSpecs) {
    capsuleSpecs = HITBOX_TEMPLATE.map((cap) => {
      const va = new THREE.Vector3(cap.a.x, cap.a.y, cap.a.z);
      const vb = new THREE.Vector3(cap.b.x, cap.b.y, cap.b.z);
      const seg = new THREE.Vector3().subVectors(vb, va);
      const len = seg.length();
      const geo = new THREE.CapsuleGeometry(cap.radius, len, 3, 8);
      const mid = va.clone().addScaledVector(seg, 0.5);
      const quat = new THREE.Quaternion();
      if (len > 1e-6) quat.setFromUnitVectors(UP, seg.clone().normalize());
      return { geo, mid, quat, head: cap.part === HitboxPart.Head };
    });
    // Waterlogged flesh and a paler, bloated head.
    bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a6b52, roughness: 0.9, metalness: 0.02 });
    headMat = new THREE.MeshStandardMaterial({ color: 0x7d8f74, roughness: 0.85, metalness: 0.02 });
  }
  return { specs: capsuleSpecs, body: bodyMat!, head: headMat! };
}

class ZombieBody {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];

  constructor() {
    const { specs, body, head } = ensureShared();
    for (const spec of specs) {
      const mesh = new THREE.Mesh(spec.geo, spec.head ? head : body);
      mesh.position.copy(spec.mid);
      mesh.quaternion.copy(spec.quat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    // A slight forward slump reads "shambler" from any distance.
    this.group.rotation.order = 'YXZ';
  }

  update(s: ZombieState, cameraPos: Vec3): void {
    this.group.position.set(s.position.x, s.position.y, s.position.z);
    this.group.rotation.y = s.yaw;
    this.group.rotation.x = 0.12;
    this.group.visible = s.alive;

    const dx = s.position.x - cameraPos.x;
    const dz = s.position.z - cameraPos.z;
    const near = dx * dx + dz * dz < SHADOW_RANGE * SHADOW_RANGE;
    for (const m of this.meshes) m.castShadow = near;
  }

  /** Geometry and materials are shared — nothing per-instance to free. */
  dispose(): void {
    this.group.clear();
  }
}

/**
 * Pools zombie bodies by entity id. `sync` once per frame with the
 * interpolated id->state pairs for ids >= ZOMBIE_ID_BASE.
 */
export class ZombiePool {
  private readonly bodies = new Map<PlayerId, ZombieBody>();
  private readonly seen = new Set<PlayerId>();

  constructor(private readonly scene: THREE.Scene) {}

  sync(zombies: Iterable<[PlayerId, ZombieState]>, cameraPos: Vec3): void {
    this.seen.clear();
    for (const [id, state] of zombies) {
      this.seen.add(id);
      let body = this.bodies.get(id);
      if (!body) {
        body = new ZombieBody();
        this.bodies.set(id, body);
        this.scene.add(body.group);
      }
      body.update(state, cameraPos);
    }
    for (const [id, body] of this.bodies) {
      if (this.seen.has(id)) continue;
      this.scene.remove(body.group);
      body.dispose();
      this.bodies.delete(id);
    }
  }

  get count(): number {
    return this.bodies.size;
  }

  dispose(): void {
    for (const [, body] of this.bodies) {
      this.scene.remove(body.group);
      body.dispose();
    }
    this.bodies.clear();
  }
}
