/**
 * DECKSHOT effects — pooled GPU particle system.
 *
 * One InstancedBufferGeometry per blend mode; every particle's full life is
 * described by instanced attributes at spawn time and integrated in the
 * vertex shader (position, gravity, linear drag, size/color over life,
 * spin). update() only advances a clock — zero per-particle CPU cost.
 *
 * Capacity is a hard cap enforced by a ring buffer that recycles the oldest
 * slot. MAX_PARTICLES from tuning is split between the two pools by the
 * facade.
 *
 * Owner: viewmodel-vfx-audio.
 */

import * as THREE from 'three';
import type { Vec3 } from '../../../../shared/types.js';

export interface ParticleSpawn {
  pos: Vec3;
  vel: Vec3;
  /** Seconds. */
  life: number;
  /** World-space quad size at birth / death, meters. */
  size: number;
  sizeEnd: number;
  color: number;
  colorEnd?: number;
  alpha?: number;
  alphaEnd?: number;
  /** m/s^2 downward. */
  gravity?: number;
  /** Linear drag coefficient (1/s). */
  drag?: number;
  /** Radians/sec roll. */
  spin?: number;
}

const VERT = /* glsl */ `
  uniform float uTime;
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec2 aTiming;   // birth, life
  attribute vec2 aSize;     // start, end
  attribute vec4 aColA;
  attribute vec4 aColB;
  attribute vec3 aMisc;     // gravity, drag, spin
  varying vec4 vColor;
  varying vec2 vUv;

  void main() {
    float t = uTime - aTiming.x;
    float life = max(aTiming.y, 1e-4);
    float k = clamp(t / life, 0.0, 1.0);
    bool dead = t < 0.0 || t > life;

    // Analytic motion under linear drag + gravity.
    float drag = aMisc.y;
    float td = drag > 1e-4 ? (1.0 - exp(-drag * t)) / drag : t;
    vec3 world = aPos + aVel * td;
    world.y -= 0.5 * aMisc.x * t * t;

    float size = dead ? 0.0 : mix(aSize.x, aSize.y, k);
    vColor = mix(aColA, aColB, k);
    vUv = uv;

    float ang = aMisc.z * t + aTiming.x * 37.0; // birth time as a cheap seed
    float ca = cos(ang), sa = sin(ang);
    vec2 corner = position.xy; // plane geometry, +-0.5
    vec2 rot = vec2(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    mv.xy += rot * size;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying vec4 vColor;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float mask = clamp(1.0 - d * d, 0.0, 1.0);
    float a = vColor.a * mask * mask;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor.rgb, a);
  }
`;

const tmpColor = new THREE.Color();

export class ParticlePool {
  readonly capacity: number;
  private mesh: THREE.Mesh;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aTiming: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aColA: THREE.InstancedBufferAttribute;
  private aColB: THREE.InstancedBufferAttribute;
  private aMisc: THREE.InstancedBufferAttribute;
  private material: THREE.ShaderMaterial;
  private cursor = 0;
  private clock = 0;
  private dirty = false;

  constructor(scene: THREE.Scene, capacity: number, additive: boolean) {
    this.capacity = capacity;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    geo.instanceCount = capacity;

    const mk = (items: number): THREE.InstancedBufferAttribute => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    this.aPos = mk(3);
    this.aVel = mk(3);
    this.aTiming = mk(2);
    this.aSize = mk(2);
    this.aColA = mk(4);
    this.aColB = mk(4);
    this.aMisc = mk(3);
    // Birth = -1 marks a slot as never-used (dead in the shader).
    for (let i = 0; i < capacity; i++) this.aTiming.setXY(i, -1, 0.0001);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aTiming', this.aTiming);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aColA', this.aColA);
    geo.setAttribute('aColB', this.aColB);
    geo.setAttribute('aMisc', this.aMisc);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 19;
    scene.add(this.mesh);
  }

  spawn(p: ParticleSpawn): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity; // ring buffer: oldest dies
    this.aPos.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
    this.aVel.setXYZ(i, p.vel.x, p.vel.y, p.vel.z);
    this.aTiming.setXY(i, this.clock, p.life);
    this.aSize.setXY(i, p.size, p.sizeEnd);
    tmpColor.setHex(p.color);
    this.aColA.setXYZW(i, tmpColor.r, tmpColor.g, tmpColor.b, p.alpha ?? 1);
    tmpColor.setHex(p.colorEnd ?? p.color);
    this.aColB.setXYZW(i, tmpColor.r, tmpColor.g, tmpColor.b, p.alphaEnd ?? 0);
    this.aMisc.setXYZ(i, p.gravity ?? 0, p.drag ?? 0, p.spin ?? 0);
    this.dirty = true;
  }

  update(dt: number): void {
    this.clock += dt;
    this.material.uniforms.uTime.value = this.clock;
    if (this.dirty) {
      this.aPos.needsUpdate = true;
      this.aVel.needsUpdate = true;
      this.aTiming.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aColA.needsUpdate = true;
      this.aColB.needsUpdate = true;
      this.aMisc.needsUpdate = true;
      this.dirty = false;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
