/**
 * DECKSHOT effects — tracer pool.
 *
 * Shot-aligned stretched billboards that TRAVEL from muzzle to impact at a
 * believable visual speed and fade — not instant lines. Each tracer is one
 * instance of a shared InstancedMesh; per-frame CPU work is a few dozen
 * matrix builds at most.
 *
 * Owner: viewmodel-vfx-audio.
 */

import * as THREE from 'three';
import type { Vec3 } from '../../../../shared/types.js';

const MAX_TRACERS = 64;
/** Visual bullet speed, m/s. Fast, but readable across the boat. */
const TRACER_SPEED = 340;
/** Trail length behind the head, meters. */
const TRAIL_LEN = 7;
/** Seconds the trail lingers and fades after the head lands. */
const LINGER = 0.07;

interface Tracer {
  active: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  t: number; // seconds since fired
  color: THREE.Color;
  width: number;
}

function makeTracerTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 64;
  const g = c.getContext('2d')!;
  // Bright head fading down the tail (v axis = along flight).
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.97, 'rgba(255,255,255,1)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const M = new THREE.Matrix4();
const X = new THREE.Vector3();
const Y = new THREE.Vector3();
const Z = new THREE.Vector3();
const MID = new THREE.Vector3();
const TO_CAM = new THREE.Vector3();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);
const TMP_COL = new THREE.Color();

export class TracerPool {
  private mesh: THREE.InstancedMesh;
  private tracers: Tracer[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: makeTracerTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_TRACERS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.mesh.setMatrixAt(i, ZERO_SCALE);
      this.mesh.setColorAt(i, new THREE.Color(0));
      this.tracers.push({
        active: false,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        length: 0,
        t: 0,
        color: new THREE.Color(),
        width: 0.02,
      });
    }
    scene.add(this.mesh);
  }

  spawn(from: Vec3, to: Vec3, color = 0xffe6b0, width = 0.022): void {
    const tr = this.tracers[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_TRACERS;
    tr.from.set(from.x, from.y, from.z);
    tr.to.set(to.x, to.y, to.z);
    tr.dir.subVectors(tr.to, tr.from);
    tr.length = tr.dir.length();
    if (tr.length < 0.5) {
      tr.active = false;
      return;
    }
    tr.dir.divideScalar(tr.length);
    tr.t = 0;
    tr.color.setHex(color);
    tr.width = width;
    tr.active = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    let dirty = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const tr = this.tracers[i];
      if (!tr.active) continue;
      tr.t += dt;
      const flight = tr.length / TRACER_SPEED;
      const done = tr.t - flight;
      if (done > LINGER) {
        tr.active = false;
        this.mesh.setMatrixAt(i, ZERO_SCALE);
        dirty = true;
        continue;
      }
      const headDist = Math.min(tr.t * TRACER_SPEED, tr.length);
      const tailDist = Math.max(headDist - TRAIL_LEN, 0);
      const segLen = Math.max(headDist - tailDist, 0.01);

      // Stretched billboard: local Y along flight, facing the camera.
      MID.copy(tr.dir).multiplyScalar((headDist + tailDist) * 0.5).add(tr.from);
      TO_CAM.copy(camera.position).sub(MID);
      X.crossVectors(tr.dir, TO_CAM);
      if (X.lengthSq() < 1e-8) X.set(1, 0, 0);
      X.normalize();
      Z.crossVectors(X, tr.dir).normalize();
      Y.copy(tr.dir);
      M.makeBasis(X.multiplyScalar(tr.width), Y.multiplyScalar(segLen), Z);
      M.setPosition(MID);
      this.mesh.setMatrixAt(i, M);

      // Fade out during the linger window by darkening (additive blend).
      const fade = done > 0 ? 1 - done / LINGER : 1;
      TMP_COL.copy(tr.color).multiplyScalar(fade);
      this.mesh.setColorAt(i, TMP_COL);
      dirty = true;
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
