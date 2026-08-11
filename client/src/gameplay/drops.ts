/**
 * DECKSHOT — ZOMBIES power-up drops: the spinning pickups the old mode never
 * had (power-ups used to apply invisibly, squad-wide, the moment they rolled).
 *
 * Owner: zombies.
 *
 * Presentation only: the server owns pickup detection and the effect. Each
 * drop is a glowing octahedron + point-light halo that bobs, spins, and
 * blinks through its final seconds; spawn/pickup/expire audio comes from
 * diffing the authoritative drop list in main.ts, not from here.
 */

import * as THREE from 'three';
import type { PowerupDrop } from '../../../shared/protocol.js';
import { DROP_BLINK_TIME } from '../../../shared/zombies.js';

const DROP_COLORS: Record<number, number> = {
  0: 0x58e07c, // Max Ammo — green
  1: 0xff4d5a, // Insta-Kill — red
  2: 0xffc93c, // Double Points — gold
  3: 0xffffff, // Nuke — white flash
  4: 0x3be8c8, // Carpenter — teal
};

interface DropRec {
  id: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  spin: number;
}

export class DropsPool {
  private readonly scene: THREE.Scene;
  private readonly live = new Map<number, DropRec>();
  private readonly geo = new THREE.OctahedronGeometry(0.28);
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  sync(drops: readonly PowerupDrop[], dt: number): void {
    this.time += dt;
    const seen = new Set<number>();
    for (const d of drops) {
      seen.add(d.id);
      let rec = this.live.get(d.id);
      if (!rec) {
        const mat = new THREE.MeshStandardMaterial({
          color: DROP_COLORS[d.kind] ?? 0xffffff,
          emissive: DROP_COLORS[d.kind] ?? 0xffffff,
          emissiveIntensity: 1.6,
          roughness: 0.3,
          metalness: 0.2,
        });
        const mesh = new THREE.Mesh(this.geo, mat);
        mesh.castShadow = false;
        mesh.userData.noShadow = true;
        this.scene.add(mesh);
        rec = { id: d.id, mesh, mat, spin: (d.id % 7) * 0.9 };
        this.live.set(d.id, rec);
      }
      rec.mesh.position.set(d.pos.x, d.pos.y + 0.75 + Math.sin(this.time * 2.2 + rec.spin) * 0.12, d.pos.z);
      rec.mesh.rotation.y = this.time * 1.8 + rec.spin;
      // Blink through the final window so its exit is telegraphed.
      const blink =
        d.secondsLeft < DROP_BLINK_TIME ? (Math.sin(this.time * (14 - d.secondsLeft)) > 0 ? 1 : 0.25) : 1;
      rec.mat.emissiveIntensity = 1.6 * blink;
      rec.mesh.visible = blink > 0.2 || d.secondsLeft >= DROP_BLINK_TIME;
    }
    for (const [id, rec] of this.live) {
      if (seen.has(id)) continue;
      this.scene.remove(rec.mesh);
      rec.mat.dispose();
      this.live.delete(id);
    }
  }

  clear(): void {
    for (const rec of this.live.values()) {
      this.scene.remove(rec.mesh);
      rec.mat.dispose();
    }
    this.live.clear();
  }

  dispose(): void {
    this.clear();
    this.geo.dispose();
  }
}
