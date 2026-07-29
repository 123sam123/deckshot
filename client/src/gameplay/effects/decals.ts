/**
 * DECKSHOT effects — pooled surface decals.
 *
 * Two instanced pools over procedural canvas textures: generic bullet holes
 * (tinted per surface) and cracked-glass stars. Combined capacity is capped
 * at MAX_DECALS from tuning; each pool is a ring buffer that recycles its
 * oldest decal.
 *
 * Owner: viewmodel-vfx-audio.
 */

import * as THREE from 'three';
import { MAX_DECALS } from '../../../../shared/tuning.js';
import type { Vec3 } from '../../../../shared/types.js';

const HOLE_CAPACITY = Math.floor(MAX_DECALS * 0.75); // 96
const CRACK_CAPACITY = MAX_DECALS - HOLE_CAPACITY; // 32

function makeHoleTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  // Dark radial core with a ragged rim.
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  // Ragged chips around the rim.
  g.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.random();
    const r = 10 + Math.random() * 8;
    g.beginPath();
    g.arc(32 + Math.cos(a) * r, 32 + Math.sin(a) * r, 1.5 + Math.random() * 2.5, 0, Math.PI * 2);
    g.fill();
  }
  return new THREE.CanvasTexture(c);
}

function makeCrackTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.translate(64, 64);
  // Radial cracks with jitter and short branches.
  const rays = 9;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    g.strokeStyle = `rgba(255,255,255,${0.5 + Math.random() * 0.4})`;
    g.lineWidth = 1 + Math.random();
    g.beginPath();
    g.moveTo(0, 0);
    let x = 0, y = 0;
    const len = 40 + Math.random() * 22;
    const steps = 5;
    for (let s = 1; s <= steps; s++) {
      const r = (len * s) / steps;
      const ja = a + (Math.random() - 0.5) * 0.25;
      x = Math.cos(ja) * r;
      y = Math.sin(ja) * r;
      g.lineTo(x, y);
    }
    g.stroke();
    // Branch
    if (Math.random() < 0.7) {
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(x * 0.6, y * 0.6);
      const ba = a + (Math.random() < 0.5 ? 0.5 : -0.5);
      g.lineTo(x * 0.6 + Math.cos(ba) * 14, y * 0.6 + Math.sin(ba) * 14);
      g.stroke();
    }
  }
  // Concentric fracture rings.
  for (const r of [10, 20]) {
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 0.8;
    g.beginPath();
    g.arc(0, 0, r + Math.random() * 3, 0, Math.PI * 2);
    g.stroke();
  }
  // Bright core.
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 7);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(-8, -8, 16, 16);
  return new THREE.CanvasTexture(c);
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const ROLL = new THREE.Quaternion();
const N = new THREE.Vector3();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);
const TMP_COL = new THREE.Color();

class DecalRing {
  private mesh: THREE.InstancedMesh;
  private cursor = 0;

  constructor(scene: THREE.Scene, capacity: number, texture: THREE.Texture, renderOrder: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, ZERO_SCALE);
      this.mesh.setColorAt(i, TMP_COL.setHex(0xffffff));
    }
    scene.add(this.mesh);
  }

  place(point: Vec3, normal: Vec3, size: number, color: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.mesh.count; // recycle oldest
    N.set(normal.x, normal.y, normal.z).normalize();
    P.set(point.x, point.y, point.z).addScaledVector(N, 0.008);
    Q.setFromUnitVectors(Z_AXIS, N);
    ROLL.setFromAxisAngle(Z_AXIS, Math.random() * Math.PI * 2);
    Q.multiply(ROLL);
    S.set(size, size, 1);
    M.compose(P, Q, S);
    this.mesh.setMatrixAt(i, M);
    this.mesh.setColorAt(i, TMP_COL.setHex(color));
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class DecalPool {
  private holes: DecalRing;
  private cracks: DecalRing;

  constructor(scene: THREE.Scene) {
    this.holes = new DecalRing(scene, HOLE_CAPACITY, makeHoleTexture(), 4);
    this.cracks = new DecalRing(scene, CRACK_CAPACITY, makeCrackTexture(), 5);
  }

  /** Generic bullet hole, tinted to suit the surface. */
  hole(point: Vec3, normal: Vec3, size: number, color: number): void {
    this.holes.place(point, normal, size, color);
  }

  /** Cracked-glass star. */
  crack(point: Vec3, normal: Vec3, size: number): void {
    this.cracks.place(point, normal, size, 0xdcecff);
  }

  dispose(scene: THREE.Scene): void {
    this.holes.dispose(scene);
    this.cracks.dispose(scene);
  }
}
