/**
 * DECKSHOT — ZOMBIES window barricades: six planks per window, driven by the
 * authoritative plank counts in ZombiesState.
 *
 * Owner: zombies.
 *
 * Presentation only — the player-blocker brush handles collision and the
 * server owns the counts. All planks for the whole map are ONE InstancedMesh
 * (11 windows x 6 planks = 66 instances, one draw call); a count change just
 * rescales instances and plays tear/repair audio at the window.
 */

import * as THREE from 'three';
import type { MapDef } from '../../../shared/maps.js';
import { PLANKS_MAX } from '../../../shared/zombies.js';
import { Audio } from '../audio/index.js';

const PLANK_W = 1.5;
const PLANK_H = 0.22;
const PLANK_D = 0.06;

const scratchMat = new THREE.Matrix4();
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const SCALE_ONE = new THREE.Vector3(1, 1, 1);
const SCALE_ZERO = new THREE.Vector3(0, 0, 0);

export class BarricadeManager {
  private readonly map: MapDef;
  private readonly mesh: THREE.InstancedMesh;
  private counts: number[];

  constructor(scene: THREE.Scene, map: MapDef) {
    this.map = map;
    const capacity = Math.max(1, map.windows.length * PLANKS_MAX);
    const geo = new THREE.BoxGeometry(PLANK_W, PLANK_H, PLANK_D);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6e5236, roughness: 0.95 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'zombies-barricades';
    this.counts = map.windows.map(() => PLANKS_MAX);
    this.layout();
    scene.add(this.mesh);
  }

  /** Compose every plank's matrix from the current counts. */
  private layout(): void {
    let slot = 0;
    for (const w of this.map.windows) {
      const n = this.counts[w.id] ?? 0;
      for (let i = 0; i < PLANKS_MAX; i++) {
        // Planks are hung bottom-up with a per-slot jauntiness so a boarded
        // window reads hand-nailed, not procedural.
        const present = i < n;
        const y = w.pos.y - 0.55 + i * 0.24;
        const wobble = ((i * 2654435761) % 100) / 100 - 0.5;
        scratchPos.set(w.pos.x, y, w.pos.z);
        scratchEuler.set(0, w.yaw, wobble * 0.22, 'YXZ');
        scratchQuat.setFromEuler(scratchEuler);
        scratchMat.compose(scratchPos, scratchQuat, present ? SCALE_ONE : SCALE_ZERO);
        this.mesh.setMatrixAt(slot++, scratchMat);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Apply authoritative counts; tears and repairs make noise at the window. */
  setPlanks(planks: readonly number[]): void {
    let changed = false;
    for (const w of this.map.windows) {
      const next = planks[w.id];
      if (next === undefined || next === this.counts[w.id]) continue;
      const prev = this.counts[w.id];
      this.counts[w.id] = next;
      changed = true;
      const at = { x: w.pos.x, y: w.pos.y, z: w.pos.z };
      Audio.play(next < prev ? 'plank_tear' : 'plank_repair', { position: at });
    }
    if (changed) this.layout();
  }

  reset(): void {
    this.counts = this.map.windows.map(() => PLANKS_MAX);
    this.layout();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
