/**
 * DECKSHOT effects — ejected shell casings.
 *
 * Physics-lite brass: gravity, tumble, a couple of bounces off an assumed
 * floor height, then fade-out. Pooled InstancedMesh; the first bounce plays
 * the brass tinkle.
 *
 * Owner: viewmodel-vfx-audio.
 */

import * as THREE from 'three';
import type { Vec3 } from '../../../../shared/types.js';
import { Audio } from '../../audio/index.js';

const MAX_CASINGS = 32;
const LIFETIME = 4.0;
const BOUNCE_DAMP = 0.38;

interface Casing {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  angVel: THREE.Vector3;
  floorY: number;
  age: number;
  bounces: number;
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const S = new THREE.Vector3();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

export class CasingPool {
  private mesh: THREE.InstancedMesh;
  private casings: Casing[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    // A brass cylinder reads perfectly at this size; a box is cheaper and
    // indistinguishable at speed — use a slightly beveled-looking thin box.
    const geo = new THREE.CylinderGeometry(0.008, 0.009, 0.055, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc9a227,
      metalness: 0.85,
      roughness: 0.35,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CASINGS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX_CASINGS; i++) {
      this.mesh.setMatrixAt(i, ZERO_SCALE);
      this.casings.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        angVel: new THREE.Vector3(),
        floorY: 0,
        age: 0,
        bounces: 0,
      });
    }
    scene.add(this.mesh);
  }

  spawn(pos: Vec3, vel: Vec3, floorY?: number): void {
    const c = this.casings[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_CASINGS;
    c.active = true;
    c.pos.set(pos.x, pos.y, pos.z);
    c.vel.set(
      vel.x + (Math.random() - 0.5) * 0.6,
      vel.y + (Math.random() - 0.5) * 0.4,
      vel.z + (Math.random() - 0.5) * 0.6
    );
    c.rot.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    c.angVel.set((Math.random() - 0.5) * 25, (Math.random() - 0.5) * 25, (Math.random() - 0.5) * 25);
    c.floorY = floorY ?? pos.y - 1.55;
    c.age = 0;
    c.bounces = 0;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < MAX_CASINGS; i++) {
      const c = this.casings[i];
      if (!c.active) continue;
      c.age += dt;
      if (c.age > LIFETIME) {
        c.active = false;
        this.mesh.setMatrixAt(i, ZERO_SCALE);
        dirty = true;
        continue;
      }
      c.vel.y -= 12.5 * dt;
      c.pos.addScaledVector(c.vel, dt);
      c.rot.x += c.angVel.x * dt;
      c.rot.y += c.angVel.y * dt;
      c.rot.z += c.angVel.z * dt;
      if (c.pos.y < c.floorY + 0.01 && c.vel.y < 0) {
        c.pos.y = c.floorY + 0.01;
        c.vel.y = -c.vel.y * BOUNCE_DAMP;
        c.vel.x *= 0.6;
        c.vel.z *= 0.6;
        c.angVel.multiplyScalar(0.5);
        c.bounces++;
        if (c.bounces === 1) {
          Audio.play('casing', {
            position: { x: c.pos.x, y: c.pos.y, z: c.pos.z },
            volume: 0.5,
          });
        }
        if (c.bounces > 3) {
          c.vel.set(0, 0, 0);
          c.angVel.set(0, 0, 0);
        }
      }
      // Shrink away over the last half second.
      const fade = Math.min(1, (LIFETIME - c.age) * 2);
      Q.setFromEuler(c.rot);
      S.setScalar(fade);
      M.compose(c.pos, Q, S);
      this.mesh.setMatrixAt(i, M);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
