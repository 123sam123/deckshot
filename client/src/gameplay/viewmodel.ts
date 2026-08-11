/**
 * DECKSHOT viewmodel — the gun in your hands.
 *
 * A procedurally-built MK-7 Talon (bolt-action sniper) and Kestrel .40
 * (pistol), constructed entirely from primitives — no downloaded models.
 * All motion comes from damped spring-mass systems, not lerps: sway lags and
 * overshoots, ADS snaps with a hand-authored overshoot curve, recoil kicks
 * through springs and recovers on the weapon's recoilRecovery, the bolt
 * cycle and reloads are keyframed timelines synchronized to synthesized
 * sounds.
 *
 * Space convention (ASSUMPTION, documented for the orchestrator):
 * `renderer.viewmodelScene` is rendered by a camera sitting at the ORIGIN
 * looking down -Z with FOV_VIEWMODEL. Everything here lives in that camera
 * space; the world never touches it, so the gun never clips walls.
 *
 * Owner: viewmodel-vfx-audio.
 */

import * as THREE from 'three';
import {
  AdsState,
  AttachmentId,
  CamoId,
  Stance,
  Vec3,
  WeaponId,
} from '../../../shared/types.js';
import { ATTACHMENTS, WEAPONS, WeaponSpec } from '../../../shared/tuning.js';
import { Audio } from '../audio/index.js';
import { Effects } from './effects/index.js';

// ---------------------------------------------------------------------------
// Input / output contracts
// ---------------------------------------------------------------------------

/**
 * Everything the viewmodel needs each frame about the local player.
 * The orchestrator wires this from controller + predicted weapon state.
 */
export interface ViewmodelInput {
  /** Mouse look applied THIS FRAME, radians (yaw: +left as in PlayerState). */
  lookDeltaYaw: number;
  lookDeltaPitch: number;
  /** World-space velocity of the local player, m/s. */
  velocity: Vec3;
  onGround: boolean;
  stance: Stance;
  /** True while the sprint-hold pose should apply (sprinting, not firing). */
  sprinting: boolean;
  /** 0..1 ADS progress from the predicted weapon state (weapons-hitreg). */
  adsProgress: number;
  adsState: AdsState;
  /** Variable Zoom level while scoped: 0 = 3.5x, 1 = 8x. */
  zoomLevel?: 0 | 1;
  /**
   * OPTIONAL world-space camera pose. When provided, ejected casings and
   * muzzle flashes are also spawned in the world via Effects (so remote
   * observers... no — so the local player's casings land on the deck).
   * When absent the viewmodel still animates fully; casings are skipped.
   */
  cameraPos?: Vec3;
  viewYaw?: number;
  viewPitch?: number;
}

/** Camera-feel outputs. The camera rig consumes these every frame. */
export interface ViewmodelOutput {
  /** Recoil/land kick to ADD to camera pitch, radians. Recovers on its own. */
  cameraPitchOffset: number;
  /** Horizontal recoil to ADD to camera yaw, radians. */
  cameraYawOffset: number;
  /** Camera pull-back along the view axis, meters (recoilPunch spring). */
  cameraPunch: number;
  /** True while the scope overlay is covering the screen. */
  scopeOverlayActive: boolean;
}

// ---------------------------------------------------------------------------
// Springs — the whole feel of the gun lives in these
// ---------------------------------------------------------------------------

/**
 * Damped harmonic oscillator, semi-implicit Euler with substepping for
 * stability. zeta = 1 is critically damped (no overshoot); zeta < 1
 * underdamped (lag + overshoot — used for sway).
 */
class Spring {
  x = 0;
  v = 0;
  target = 0;

  constructor(
    public omega: number,
    public zeta: number = 1
  ) {}

  update(dt: number): number {
    // Substep so high-omega springs stay stable at low framerates.
    let remaining = dt;
    const h = 1 / 240;
    while (remaining > 0) {
      const step = Math.min(h, remaining);
      const a = -2 * this.zeta * this.omega * this.v - this.omega * this.omega * (this.x - this.target);
      this.v += a * step;
      this.x += this.v * step;
      remaining -= step;
    }
    return this.x;
  }

  impulse(v: number): void {
    this.v += v;
  }

  snap(x: number): void {
    this.x = x;
    this.v = 0;
    this.target = x;
  }
}

class Spring3 {
  readonly x = new THREE.Vector3();
  readonly v = new THREE.Vector3();
  readonly target = new THREE.Vector3();

  constructor(
    public omega: number,
    public zeta: number = 1
  ) {}

  update(dt: number): THREE.Vector3 {
    let remaining = dt;
    const h = 1 / 240;
    while (remaining > 0) {
      const step = Math.min(h, remaining);
      const w2 = this.omega * this.omega;
      const dzw = 2 * this.zeta * this.omega;
      this.v.x += (-dzw * this.v.x - w2 * (this.x.x - this.target.x)) * step;
      this.v.y += (-dzw * this.v.y - w2 * (this.x.y - this.target.y)) * step;
      this.v.z += (-dzw * this.v.z - w2 * (this.x.z - this.target.z)) * step;
      this.x.addScaledVector(this.v, step);
      remaining -= step;
    }
    return this.x;
  }

  snap(t: THREE.Vector3): void {
    this.x.copy(t);
    this.target.copy(t);
    this.v.set(0, 0, 0);
  }
}

/** Hand-authored ADS ease: fast start, slight overshoot, crisp settle. */
function adsEase(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const c1 = 1.28; // overshoot strength
  const c3 = c1 + 1;
  const q = p - 1;
  return 1 + c3 * q * q * q + c1 * q * q;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Camo materials
// ---------------------------------------------------------------------------

interface CamoSet {
  /** Furniture: stock, grip, handguard. */
  body: THREE.MeshStandardMaterial;
  /** Barrel, receiver, bolt. */
  metal: THREE.MeshStandardMaterial;
  /** Scope tube, rails, accessories — always dark. */
  accessory: THREE.MeshStandardMaterial;
}

function patternTexture(draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  draw(g);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCamoSet(camo: CamoId): CamoSet {
  const accessory = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.5, metalness: 0.6 });
  const std = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial(o);
  switch (camo) {
    case CamoId.Arctic: {
      const tex = patternTexture((g) => {
        g.fillStyle = '#dde4e8';
        g.fillRect(0, 0, 128, 128);
        for (let i = 0; i < 26; i++) {
          g.fillStyle = i % 2 ? '#aeb9bf' : '#8b979e';
          g.beginPath();
          const x = Math.random() * 128, y = Math.random() * 128;
          g.moveTo(x, y);
          for (let k = 0; k < 5; k++) g.lineTo(x + (Math.random() - 0.5) * 46, y + (Math.random() - 0.5) * 46);
          g.closePath();
          g.fill();
        }
      });
      return {
        body: std({ map: tex, roughness: 0.7, metalness: 0.1 }),
        metal: std({ color: 0xb9c2c7, roughness: 0.45, metalness: 0.75 }),
        accessory,
      };
    }
    case CamoId.Carbon:
      return {
        body: std({ color: 0x141518, roughness: 0.32, metalness: 0.55 }),
        metal: std({ color: 0x232529, roughness: 0.3, metalness: 0.85 }),
        accessory,
      };
    case CamoId.Tiger: {
      const tex = patternTexture((g) => {
        g.fillStyle = '#c9691d';
        g.fillRect(0, 0, 128, 128);
        g.fillStyle = '#141210';
        for (let i = 0; i < 9; i++) {
          const y = i * 15 + Math.random() * 6;
          g.beginPath();
          g.moveTo(-10, y);
          for (let x = 0; x <= 138; x += 16) {
            g.lineTo(x, y + Math.sin(x * 0.11 + i * 2.4) * 5);
          }
          g.lineTo(138, y + 4 + Math.random() * 5);
          for (let x = 138; x >= -10; x -= 16) {
            g.lineTo(x, y + 6 + Math.sin(x * 0.13 + i * 1.7) * 5);
          }
          g.closePath();
          g.fill();
        }
      });
      return {
        body: std({ map: tex, roughness: 0.55, metalness: 0.15 }),
        metal: std({ color: 0x2b2620, roughness: 0.4, metalness: 0.8 }),
        accessory,
      };
    }
    case CamoId.Chrome:
      return {
        // No env map is guaranteed in the viewmodel scene, so chrome is
        // faked with high specular response + slight emissive lift.
        body: std({ color: 0xe8ecf0, roughness: 0.12, metalness: 0.9, emissive: 0x223038, emissiveIntensity: 0.35 }),
        metal: std({ color: 0xf2f5f8, roughness: 0.08, metalness: 0.95, emissive: 0x2a3a44, emissiveIntensity: 0.4 }),
        accessory,
      };
    case CamoId.Gold:
      return {
        body: std({ color: 0xf5c542, roughness: 0.2, metalness: 0.95, emissive: 0x664410, emissiveIntensity: 0.45 }),
        metal: std({ color: 0xffd35c, roughness: 0.16, metalness: 1.0, emissive: 0x7a5210, emissiveIntensity: 0.5 }),
        accessory,
      };
    case CamoId.Gunmetal:
    default:
      return {
        body: std({ color: 0x2e3237, roughness: 0.6, metalness: 0.35 }),
        metal: std({ color: 0x41474e, roughness: 0.38, metalness: 0.85 }),
        accessory,
      };
  }
}

// ---------------------------------------------------------------------------
// Procedural weapon meshes
// ---------------------------------------------------------------------------

/** Handles to animatable sub-parts of a built weapon. */
export interface WeaponRig {
  root: THREE.Group;
  /** Bolt assembly (Talon) — translated back/forward during the cycle. */
  bolt: THREE.Group | null;
  /** Bolt handle subgroup — rotated up during lift. */
  boltHandle: THREE.Group | null;
  /** Pistol slide (Kestrel) — blowback on fire. */
  slide: THREE.Group | null;
  magazine: THREE.Group | null;
  /** Local-space muzzle tip. */
  muzzle: THREE.Object3D;
  /** Local-space ejection port. */
  ejectPort: THREE.Object3D;
  /** Laser beam mesh (present only with the Laser attachment). */
  laserBeam: THREE.Mesh | null;
  /** True when a scope is mounted (no IronSightSwap). */
  hasScope: boolean;
  /** Height of the aiming line above local y=0 (scope axis or iron sights). */
  sightHeight: number;
}

function box(
  w: number, h: number, d: number,
  mat: THREE.Material,
  x = 0, y = 0, z = 0
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function cyl(
  rTop: number, rBot: number, len: number,
  mat: THREE.Material,
  x = 0, y = 0, z = 0,
  alongZ = true,
  segments = 12
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, segments), mat);
  if (alongZ) m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

/**
 * The MK-7 Talon. Built along -Z (muzzle forward), bore line at local y=0,
 * origin at the receiver. Reads as a real bolt-action rifle in silhouette:
 * receiver, free-floated barrel, bolt with turned-down handle, skeleton
 * stock with cheek riser, scope with ocular/objective bells, box magazine,
 * bipod nub under the forend.
 */
function buildTalon(camo: CamoSet, attachments: AttachmentId[]): WeaponRig {
  const root = new THREE.Group();
  const has = (a: AttachmentId): boolean => attachments.includes(a);
  const ironSights = has(AttachmentId.IronSightSwap);
  const varZoom = has(AttachmentId.VariableZoom);

  // --- Receiver ---
  root.add(box(0.062, 0.075, 0.24, camo.metal, 0, 0, -0.02));
  // Ejection port cutout suggestion (darker inset panel, right side).
  root.add(box(0.004, 0.03, 0.09, camo.accessory, 0.033, 0.008, -0.04));
  // Rail on top.
  root.add(box(0.036, 0.014, 0.2, camo.accessory, 0, 0.044, -0.03));

  // --- Barrel: tapered, free-floated ---
  const barrelLen = 0.62;
  root.add(cyl(0.014, 0.019, barrelLen, camo.metal, 0, 0, -0.14 - barrelLen / 2));
  let muzzleZ = -0.14 - barrelLen;
  // Muzzle brake (replaced by suppressor when equipped).
  if (has(AttachmentId.Suppressor)) {
    const supLen = 0.17;
    const sup = cyl(0.026, 0.026, supLen, camo.accessory, 0, 0, muzzleZ - supLen / 2 + 0.02);
    root.add(sup);
    // Vent rings.
    for (let i = 0; i < 3; i++) {
      root.add(cyl(0.0268, 0.0268, 0.004, camo.metal, 0, 0, muzzleZ - 0.03 - i * 0.05));
    }
    muzzleZ = muzzleZ - supLen + 0.02;
  } else {
    root.add(cyl(0.02, 0.02, 0.05, camo.accessory, 0, 0, muzzleZ + 0.01));
    // Brake side vents.
    root.add(box(0.052, 0.008, 0.03, camo.accessory, 0, 0, muzzleZ + 0.01));
  }

  // --- Forend / handguard ---
  root.add(box(0.056, 0.055, 0.3, camo.body, 0, -0.024, -0.28));
  // Bipod nub.
  root.add(box(0.024, 0.024, 0.04, camo.accessory, 0, -0.06, -0.38));

  // --- Stock: skeletonized, cheek riser, butt pad ---
  root.add(box(0.05, 0.062, 0.2, camo.body, 0, -0.006, 0.2)); // wrist
  root.add(box(0.046, 0.11, 0.06, camo.body, 0, -0.03, 0.315)); // vertical brace
  root.add(box(0.05, 0.13, 0.045, camo.accessory, 0, -0.02, 0.36)); // butt pad
  root.add(box(0.048, 0.028, 0.16, camo.body, 0, 0.038, 0.28)); // cheek riser
  root.add(box(0.044, 0.1, 0.032, camo.body, 0, -0.085, 0.13)); // grip
  // Trigger guard.
  root.add(box(0.008, 0.005, 0.05, camo.metal, 0, -0.055, 0.055));

  // --- Magazine ---
  const magazine = new THREE.Group();
  const magLen = has(AttachmentId.ExtendedMag) ? 0.115 : 0.07;
  magazine.add(box(0.05, magLen, 0.085, camo.accessory, 0, -magLen / 2, 0));
  // Witness ridge on extended mags — visibly a different mag.
  if (has(AttachmentId.ExtendedMag)) magazine.add(box(0.054, 0.012, 0.09, camo.metal, 0, -magLen + 0.02, 0));
  magazine.position.set(0, -0.037, -0.03);
  root.add(magazine);

  // --- Bolt assembly ---
  const bolt = new THREE.Group();
  bolt.add(cyl(0.012, 0.012, 0.15, camo.metal, 0, 0.012, 0.04));
  // Bolt knob arm, turned down on the right.
  const boltHandle = new THREE.Group();
  const arm = cyl(0.006, 0.006, 0.055, camo.metal, 0.028, -0.01, 0, false);
  arm.rotation.z = 0.9;
  boltHandle.add(arm);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.013, 10, 8), camo.metal);
  knob.position.set(0.049, -0.026, 0);
  boltHandle.add(knob);
  boltHandle.position.set(0, 0.012, 0.09);
  bolt.add(boltHandle);
  root.add(bolt);

  // --- Scope (unless iron sights) ---
  let sightHeight: number;
  let hasScope = false;
  if (!ironSights) {
    hasScope = true;
    const scopeY = 0.093;
    const tubeR = varZoom ? 0.02 : 0.017;
    const objR = varZoom ? 0.038 : 0.03;
    const ocuR = varZoom ? 0.028 : 0.024;
    const tubeLen = varZoom ? 0.3 : 0.24;
    // Rings.
    root.add(box(0.016, 0.05, 0.02, camo.accessory, 0, 0.062, -0.08));
    root.add(box(0.016, 0.05, 0.02, camo.accessory, 0, 0.062, 0.04));
    // Main tube.
    root.add(cyl(tubeR, tubeR, tubeLen, camo.accessory, 0, scopeY, -0.02));
    // Objective bell (front) and ocular bell (rear).
    root.add(cyl(objR, tubeR + 0.002, 0.07, camo.accessory, 0, scopeY, -0.02 - tubeLen / 2 - 0.03));
    root.add(cyl(tubeR + 0.002, ocuR, 0.055, camo.accessory, 0, scopeY, -0.02 + tubeLen / 2 + 0.024));
    // Glass: front objective lens, faintly blue.
    const glass = new THREE.Mesh(
      new THREE.CircleGeometry(objR - 0.004, 16),
      new THREE.MeshBasicMaterial({ color: 0x8fc3e8, transparent: true, opacity: 0.55 })
    );
    glass.position.set(0, scopeY, -0.02 - tubeLen / 2 - 0.064);
    glass.rotation.y = Math.PI;
    root.add(glass);
    // Turrets.
    root.add(cyl(0.011, 0.011, 0.024, camo.accessory, 0, scopeY + 0.026, -0.02, false, 10));
    const wind = cyl(0.011, 0.011, 0.024, camo.accessory, 0.026, scopeY, -0.02, false, 10);
    wind.rotation.z = Math.PI / 2;
    root.add(wind);
    // Zoom ring on variable scopes — visibly a bigger, knurled scope.
    if (varZoom) root.add(cyl(tubeR + 0.005, tubeR + 0.005, 0.03, camo.metal, 0, scopeY, 0.1));
    sightHeight = scopeY;
  } else {
    // Iron sights: front post + rear notch, much lower sight line.
    sightHeight = 0.058;
    root.add(box(0.006, 0.03, 0.006, camo.accessory, 0, 0.048, -0.72));
    root.add(box(0.03, 0.018, 0.008, camo.accessory, 0, 0.052, 0.07));
    root.add(box(0.008, 0.026, 0.008, camo.accessory, -0.011, 0.05, 0.07));
    root.add(box(0.008, 0.026, 0.008, camo.accessory, 0.011, 0.05, 0.07));
  }

  // --- Laser (attachment): emitter + beam ---
  let laserBeam: THREE.Mesh | null = null;
  if (has(AttachmentId.Laser)) {
    root.add(box(0.02, 0.02, 0.05, camo.accessory, 0.037, -0.02, -0.42));
    const emitter = new THREE.Mesh(
      new THREE.SphereGeometry(0.005, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff2020 })
    );
    emitter.position.set(0.037, -0.02, -0.446);
    root.add(emitter);
    laserBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0012, 0.0012, 30, 4, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff3030,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    laserBeam.rotation.x = Math.PI / 2;
    laserBeam.position.set(0.037, -0.02, -0.45 - 15);
    root.add(laserBeam);
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, muzzleZ);
  root.add(muzzle);
  const ejectPort = new THREE.Object3D();
  ejectPort.position.set(0.04, 0.01, -0.04);
  root.add(ejectPort);

  return { root, bolt, boltHandle, slide: null, magazine, muzzle, ejectPort, laserBeam, hasScope, sightHeight };
}

/** The Kestrel .40 — semi-auto pistol. Origin at the backstrap, bore y=0. */
function buildKestrel(camo: CamoSet, attachments: AttachmentId[]): WeaponRig {
  const root = new THREE.Group();
  const has = (a: AttachmentId): boolean => attachments.includes(a);

  // Frame.
  root.add(box(0.03, 0.032, 0.19, camo.body, 0, -0.018, -0.075));
  // Slide.
  const slide = new THREE.Group();
  slide.add(box(0.032, 0.032, 0.2, camo.metal, 0, 0.012, -0.08));
  // Slide serrations.
  for (let i = 0; i < 4; i++) slide.add(box(0.034, 0.02, 0.003, camo.accessory, 0, 0.012, 0.0 - i * 0.012));
  // Sights on the slide.
  slide.add(box(0.005, 0.012, 0.005, camo.accessory, 0, 0.034, -0.172));
  slide.add(box(0.007, 0.01, 0.006, camo.accessory, -0.008, 0.033, 0.012));
  slide.add(box(0.007, 0.01, 0.006, camo.accessory, 0.008, 0.033, 0.012));
  root.add(slide);
  // Barrel tip visible at the front.
  let muzzleZ = -0.185;
  root.add(cyl(0.009, 0.009, 0.02, camo.metal, 0, 0.012, -0.178));
  if (has(AttachmentId.Suppressor)) {
    const supLen = 0.11;
    root.add(cyl(0.017, 0.017, supLen, camo.accessory, 0, 0.012, muzzleZ - supLen / 2 + 0.01));
    muzzleZ = muzzleZ - supLen + 0.01;
  }
  // Grip.
  const grip = box(0.032, 0.11, 0.05, camo.body, 0, -0.062, 0.012);
  grip.rotation.x = 0.18;
  root.add(grip);
  // Trigger + guard.
  root.add(box(0.006, 0.024, 0.005, camo.metal, 0, -0.045, -0.045));
  root.add(box(0.026, 0.006, 0.055, camo.accessory, 0, -0.06, -0.045));
  // Magazine (baseplate visible under the grip; extended sticks out).
  const magazine = new THREE.Group();
  const ext = has(AttachmentId.ExtendedMag) ? 0.035 : 0.008;
  magazine.add(box(0.028, ext, 0.042, camo.accessory, 0, -ext / 2, 0));
  magazine.position.set(0, -0.115, 0.028);
  root.add(magazine);
  // Laser under the dust cover.
  let laserBeam: THREE.Mesh | null = null;
  if (has(AttachmentId.Laser)) {
    root.add(box(0.018, 0.016, 0.035, camo.accessory, 0, -0.012, -0.15));
    laserBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.001, 0.001, 30, 4, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff3030, transparent: true, opacity: 0.35,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    laserBeam.rotation.x = Math.PI / 2;
    laserBeam.position.set(0, -0.012, -0.17 - 15);
    root.add(laserBeam);
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, muzzleZ);
  root.add(muzzle);
  const ejectPort = new THREE.Object3D();
  ejectPort.position.set(0.02, 0.03, -0.06);
  root.add(ejectPort);

  return {
    root, bolt: null, boltHandle: null, slide, magazine, muzzle, ejectPort,
    laserBeam, hasScope: false, sightHeight: 0.034,
  };
}

/**
 * Standalone builder so other agents (player rendering) can show the same
 * gun — with visible attachments — in third person.
 */
export function buildWeaponMesh(
  id: WeaponId,
  camo: CamoId,
  attachments: AttachmentId[]
): THREE.Group {
  const set = makeCamoSet(camo);
  const rig = usesCompactRig(id) ? buildKestrel(set, attachments) : buildTalon(set, attachments);
  return rig.root;
}

/**
 * Which procedural rig a weapon borrows. The ZOMBIES wall buys reuse the two
 * existing rigs (compact for the SMG, long gun for the rest) rather than
 * shipping four new models — the seam for real recipes is `buildWeaponMesh`.
 */
function usesCompactRig(id: WeaponId): boolean {
  return id === WeaponId.Kestrel || id === WeaponId.Osprey;
}

// ---------------------------------------------------------------------------
// Scope overlay — a real rendered element, not a PNG
// ---------------------------------------------------------------------------

const SCOPE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Full-screen clip-space quad, independent of camera transform.
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
  }
`;

const SCOPE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uGlass;     // 0..1 fade-in over the last 25% of ADS
  uniform float uBlackout;  // 1 for the 2-frame scope-up blackout
  uniform float uAspect;
  uniform vec2 uParallax;   // scope wander from gun settle, NDC-ish
  uniform float uZoom;      // 0 = 3.5x, 1 = 8x
  uniform float uTime;

  float ring(float d, float r, float w) {
    return smoothstep(w, 0.0, abs(d - r));
  }

  void main() {
    if (uBlackout > 0.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    vec2 c = uParallax * 0.06; // scope tube wanders slightly vs true aim
    float d = length(p - c);

    float R = mix(0.44, 0.40, uZoom); // aperture radius
    float edge = 0.006;

    // Black vignette outside the aperture; crisp but not aliased.
    float outside = smoothstep(R - edge, R + edge, d);

    // Interior shading: subtle darkening toward the rim (tube depth).
    float interior = 0.22 * smoothstep(R * 0.45, R, d);

    // Chromatic fringing at the rim: thin blue/orange rings just inside.
    vec3 fringe = vec3(0.0);
    fringe += vec3(0.06, 0.12, 0.30) * ring(d, R - 0.010, 0.006);
    fringe += vec3(0.25, 0.12, 0.03) * ring(d, R - 0.020, 0.006);

    // Faint lens-flare streak through the aperture centre.
    vec2 q = p - c;
    float streak = exp(-abs(q.y + q.x * 0.12) * 90.0) * exp(-abs(q.x) * 2.2);
    vec3 flare = vec3(1.0, 0.93, 0.78) * streak * 0.05;
    // Slow-moving glint.
    float glint = exp(-length(q - vec2(sin(uTime * 0.23) * 0.2, 0.13)) * 26.0);
    flare += vec3(0.9, 0.95, 1.0) * glint * 0.03;

    // Mil-dot reticle: hairline cross + dots, denser look at 8x.
    float lw = 0.0011;
    float cross_ = 0.0;
    if (abs(q.x) < lw && abs(q.y) < R) cross_ = 1.0;
    if (abs(q.y) < lw && abs(q.x) < R) cross_ = 1.0;
    // Heavy posts outside 60% radius.
    float heavy = 0.0;
    float postW = 0.0045;
    if (abs(q.x) < postW && abs(q.y) > R * 0.55 && abs(q.y) < R) heavy = 1.0;
    if (abs(q.y) < postW && abs(q.x) > R * 0.55 && abs(q.x) < R) heavy = 1.0;
    // Mil dots along the hairlines.
    float dots = 0.0;
    float spacing = mix(0.055, 0.038, uZoom);
    for (int i = 1; i <= 4; i++) {
      float o = float(i) * spacing;
      dots += smoothstep(0.0035, 0.0015, length(q - vec2(o, 0.0)));
      dots += smoothstep(0.0035, 0.0015, length(q - vec2(-o, 0.0)));
      dots += smoothstep(0.0035, 0.0015, length(q - vec2(0.0, o)));
      dots += smoothstep(0.0035, 0.0015, length(q - vec2(0.0, -o)));
    }
    float reticle = clamp(cross_ + heavy + dots, 0.0, 1.0) * (1.0 - outside);

    vec3 color = fringe + flare * (1.0 - outside);
    float dark = clamp(outside + interior + reticle * 0.92, 0.0, 1.0);

    // uGlass fades the whole overlay in over the last 25% of the ADS rise.
    float alpha = uGlass * clamp(dark + length(color), 0.0, 1.0);
    // Premultiplied-feel: darken where dark, tint where fringe/flare.
    gl_FragColor = vec4(color * uGlass, alpha);
  }
`;

class ScopeOverlay {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SCOPE_VERT,
      fragmentShader: SCOPE_FRAG,
      uniforms: {
        uGlass: { value: 0 },
        uBlackout: { value: 0 },
        uAspect: { value: 16 / 9 },
        uParallax: { value: new THREE.Vector2() },
        uZoom: { value: 0 },
        uTime: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
    // Keep aspect honest whatever camera the renderer uses.
    this.mesh.onBeforeRender = (_r, _s, camera): void => {
      const pc = camera as THREE.PerspectiveCamera;
      if (pc.isPerspectiveCamera) this.mat.uniforms.uAspect.value = pc.aspect;
    };
    scene.add(this.mesh);
  }

  update(
    time: number,
    glass: number,
    blackout: boolean,
    parallaxX: number,
    parallaxY: number,
    zoom: number
  ): void {
    this.mesh.visible = glass > 0.001 || blackout;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uGlass.value = glass;
    this.mat.uniforms.uBlackout.value = blackout ? 1 : 0;
    (this.mat.uniforms.uParallax.value as THREE.Vector2).set(parallaxX, parallaxY);
    this.mat.uniforms.uZoom.value = zoom;
  }
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

interface Pose {
  pos: THREE.Vector3;
  rot: THREE.Euler;
}

const pose = (px: number, py: number, pz: number, rx = 0, ry = 0, rz = 0): Pose => ({
  pos: new THREE.Vector3(px, py, pz),
  rot: new THREE.Euler(rx, ry, rz),
});

interface WeaponPoses {
  hip: Pose;
  ads: Pose;
  sprint: Pose;
}

function posesFor(id: WeaponId, sightHeight: number): WeaponPoses {
  if (usesCompactRig(id)) {
    return {
      hip: pose(0.14, -0.155, -0.32, 0.03, -0.06, 0.02),
      ads: pose(0, -sightHeight, -0.3),
      sprint: pose(0.1, -0.13, -0.3, 0.5, 0.35, 0.3),
    };
  }
  // Talon (also used for Knife fallback until a knife model exists).
  return {
    hip: pose(0.165, -0.215, -0.42, 0.035, -0.08, 0.03),
    ads: pose(0, -sightHeight, -0.16),
    sprint: pose(0.12, -0.17, -0.4, 0.42, 0.42, 0.32),
  };
}

// ---------------------------------------------------------------------------
// The Viewmodel
// ---------------------------------------------------------------------------

const V_TMP = new THREE.Vector3();
const DEG = Math.PI / 180;

export class Viewmodel {
  private scene: THREE.Scene;
  private rig: WeaponRig;
  private poses: WeaponPoses;
  private spec: WeaponSpec;
  private weaponId: WeaponId = WeaponId.Talon;
  private camo: CamoId = CamoId.Gunmetal;
  private attachments: AttachmentId[] = [];
  private suppressed = false;

  private scope: ScopeOverlay;
  private muzzleFlash: THREE.Mesh;
  private muzzleLight: THREE.PointLight;
  private flashTtl = 0;

  // Springs
  private posSpring = new Spring3(26, 1);
  private rotSpring = new Spring3(24, 1);
  private swayYaw = new Spring(16, 0.5);
  private swayPitch = new Spring(16, 0.5);
  private swayRoll = new Spring(12, 0.6);
  private kickZ = new Spring(30, 0.9); // viewmodel recoil translation
  private kickPitch = new Spring(26, 0.75); // viewmodel recoil rotation
  private punch = new Spring(22, 1); // camera punch (meters)
  private landDip = new Spring(18, 0.65);
  private stanceDip = new Spring(14, 0.8);

  // Camera recoil accumulators (decay on recoilRecovery).
  private camPitch = 0;
  private camYaw = 0;

  // Bob
  private bobPhase = 0;
  private bobAmp = new Spring(10, 1);

  // Idle sway / breathing
  private idleT = 0;
  private scopeHoldT = 0;

  // Timelines
  private boltT = -1; // seconds into bolt cycle, -1 = idle
  private boltDur = 0.72;
  private boltEventsFired = 0;
  private reloadT = -1;
  private reloadDur = 2.8;
  private reloadEmpty = false;
  private reloadEventsFired = 0;
  private swapT = 1; // 0..1 raise progress after setWeapon

  // Scope state
  private blackoutFrames = 0;
  private prevAdsState: AdsState = AdsState.Hip;
  private time = 0;

  private prevStance: Stance = Stance.Stand;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // The gun needs light even if the renderer hasn't lit the viewmodel
    // scene yet; these are cheap and local to this scene.
    const hemi = new THREE.HemisphereLight(0xbfd6e8, 0x2a2620, 0.9);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff2dc, 1.4);
    key.position.set(0.6, 1.2, 0.4);
    scene.add(key);

    this.spec = WEAPONS[WeaponId.Talon];
    const set = makeCamoSet(CamoId.Gunmetal);
    this.rig = buildTalon(set, []);
    this.poses = posesFor(WeaponId.Talon, this.rig.sightHeight);
    scene.add(this.rig.root);

    this.scope = new ScopeOverlay(scene);

    // Viewmodel-space muzzle flash sprite + light.
    this.muzzleFlash = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeFlashTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })
    );
    this.muzzleFlash.visible = false;
    this.muzzleFlash.renderOrder = 30;
    scene.add(this.muzzleFlash);
    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 3);
    scene.add(this.muzzleLight);

    this.posSpring.snap(this.poses.hip.pos);
    this.rotSpring.snap(V_TMP.set(this.poses.hip.rot.x, this.poses.hip.rot.y, this.poses.hip.rot.z));
  }

  setWeapon(id: WeaponId, camo: CamoId, attachments: AttachmentId[]): void {
    this.weaponId = id;
    this.camo = camo;
    this.attachments = attachments.filter((a) => a !== AttachmentId.None);
    this.suppressed = this.attachments.some((a) => ATTACHMENTS[a]?.flags?.suppressed);
    this.spec = WEAPONS[id] ?? WEAPONS[WeaponId.Talon];

    this.scene.remove(this.rig.root);
    disposeGroup(this.rig.root);
    const set = makeCamoSet(camo);
    this.rig = usesCompactRig(id) ? buildKestrel(set, this.attachments) : buildTalon(set, this.attachments);
    this.poses = posesFor(id, this.rig.sightHeight);
    this.scene.add(this.rig.root);

    // Raise-from-below swap animation.
    this.swapT = 0;
    this.boltT = -1;
    this.reloadT = -1;
    Audio.play('weapon_swap');
  }

  onFire(): void {
    const s = this.spec;
    // Camera recoil (consumed by the camera rig through ViewmodelOutput).
    this.camPitch += s.recoilVertical * (0.9 + Math.random() * 0.2);
    this.camYaw += (Math.random() * 2 - 1) * s.recoilHorizontal;
    this.punch.impulse(s.recoilPunch * 22);
    // Viewmodel kick — separate from the camera punch.
    this.kickZ.impulse(2.6 + s.recoilPunch * 14);
    this.kickPitch.impulse(3.2 + s.recoilVertical * 18);

    // Muzzle flash (viewmodel space, world light handled in update()).
    this.flashTtl = 0.055;

    if (this.weaponId === WeaponId.Talon || this.weaponId === WeaponId.Shrike) {
      // Bolt-action and pump gun share the heavy report + working-the-action beat.
      Audio.play(this.suppressed ? 'sniper_fire_suppressed' : 'sniper_fire');
      this.boltDur = Math.max(0.35, this.spec.cycleTime * 0.8);
      this.boltT = -0.12; // small delay before the hand moves
      this.boltEventsFired = 0;
    } else if (this.weaponId === WeaponId.Harrier) {
      Audio.play(this.suppressed ? 'sniper_fire_suppressed' : 'sniper_fire');
      this.ejectCasingNow();
    } else if (this.weaponId === WeaponId.Knife) {
      Audio.play('melee_swing');
    } else {
      // Kestrel and the automatics (Osprey, Condor): sharp report + brass.
      Audio.play(this.suppressed ? 'pistol_fire_suppressed' : 'pistol_fire');
      if (this.rig.slide) {
        this.rig.slide.position.z = 0.03;
      }
      this.ejectCasingNow();
    }
  }

  onReload(empty: boolean): void {
    this.reloadEmpty = empty;
    this.reloadDur = empty ? this.spec.reloadTimeEmpty : this.spec.reloadTime;
    this.reloadT = 0;
    this.reloadEventsFired = 0;
    this.boltT = -1; // reload preempts a bolt cycle
  }

  onLand(impactSpeed: number): void {
    const k = clamp(impactSpeed / 10, 0, 1.4);
    this.landDip.impulse(-1.6 * k);
    this.camPitch -= 0.9 * DEG * k;
    Audio.play('land_thud', { volume: clamp(0.3 + k * 0.7, 0, 1) });
  }

  update(dt: number, s: ViewmodelInput): ViewmodelOutput {
    dt = clamp(dt, 0, 0.1);
    this.time += dt;

    const eased = adsEase(clamp(s.adsProgress, 0, 1));
    const ads01 = clamp(s.adsProgress, 0, 1);

    // ------------------------------------------------------------------
    // Sway — impulse-driven underdamped springs: lag + overshoot on stop.
    // ------------------------------------------------------------------
    const swayScale = 1 - 0.8 * eased; // scoped guns stay near the sight line
    this.swayYaw.impulse(-s.lookDeltaYaw * 26 * swayScale);
    this.swayPitch.impulse(s.lookDeltaPitch * 22 * swayScale);
    this.swayRoll.impulse(-s.lookDeltaYaw * 9 * swayScale);
    this.swayYaw.update(dt);
    this.swayPitch.update(dt);
    this.swayRoll.update(dt);
    const swayY = clamp(this.swayYaw.x, -0.12, 0.12);
    const swayP = clamp(this.swayPitch.x, -0.1, 0.1);
    const swayR = clamp(this.swayRoll.x, -0.08, 0.08);

    // ------------------------------------------------------------------
    // Walk / sprint bob, suppressed while ADS.
    // ------------------------------------------------------------------
    const hSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    const grounded = s.onGround && hSpeed > 0.3;
    this.bobAmp.target = grounded ? clamp(hSpeed / 7.4, 0, 1) * (1 - 0.92 * eased) : 0;
    this.bobAmp.update(dt);
    if (grounded) this.bobPhase += dt * (5.2 + hSpeed * 0.85);
    const bobA = this.bobAmp.x;
    const bobX = Math.sin(this.bobPhase) * 0.012 * bobA;
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * 0.014 * bobA - Math.sin(this.bobPhase * 2) * 0.004 * bobA;
    const bobRoll = Math.sin(this.bobPhase) * 0.02 * bobA;

    // ------------------------------------------------------------------
    // Idle sway / breathing (visual; scoped hold settles over time).
    // ------------------------------------------------------------------
    this.idleT += dt;
    if (s.adsState === AdsState.Scoped) this.scopeHoldT += dt;
    else this.scopeHoldT = 0;
    const settle =
      1 - (1 - this.spec.swaySettleFactor) * smooth(0, this.spec.swaySettleTime, this.scopeHoldT);
    const idleAmp = (eased > 0.5 ? this.spec.swayAmplitude * settle : 0.35 * DEG);
    const idleX = Math.sin(this.idleT * this.spec.swayFrequency * Math.PI * 2) * idleAmp;
    const idleY = Math.sin(this.idleT * this.spec.swayFrequency * Math.PI * 2 * 0.63 + 1.7) * idleAmp * 0.7;

    // ------------------------------------------------------------------
    // Stance dip + landing dip.
    // ------------------------------------------------------------------
    if (s.stance !== this.prevStance) {
      this.stanceDip.impulse(s.stance === Stance.Prone ? -0.9 : -0.45);
      this.prevStance = s.stance;
    }
    this.stanceDip.update(dt);
    this.landDip.update(dt);

    // ------------------------------------------------------------------
    // Recoil recovery.
    // ------------------------------------------------------------------
    const rec = Math.exp((-dt * 3.2) / Math.max(this.spec.recoilRecovery, 0.05));
    this.camPitch *= rec;
    this.camYaw *= rec;
    this.kickZ.update(dt);
    this.kickPitch.update(dt);
    this.punch.update(dt);

    // ------------------------------------------------------------------
    // Pose blending: hip -> ads (eased, overshooting) -> sprint hold.
    // ------------------------------------------------------------------
    const P = this.poses;
    const sprintBlend =
      s.sprinting && ads01 < 0.05 && this.reloadT < 0 && this.boltT < 0
        ? smooth(0, 1, clamp((hSpeed - 5.2) / 2, 0, 1))
        : 0;

    V_TMP.copy(P.hip.pos).lerp(P.ads.pos, eased);
    if (sprintBlend > 0) V_TMP.lerp(P.sprint.pos, sprintBlend);
    this.posSpring.target.copy(V_TMP);

    V_TMP.set(
      P.hip.rot.x + (P.ads.rot.x - P.hip.rot.x) * eased,
      P.hip.rot.y + (P.ads.rot.y - P.hip.rot.y) * eased,
      P.hip.rot.z + (P.ads.rot.z - P.hip.rot.z) * eased
    );
    if (sprintBlend > 0) {
      V_TMP.set(
        V_TMP.x + (P.sprint.rot.x - V_TMP.x) * sprintBlend,
        V_TMP.y + (P.sprint.rot.y - V_TMP.y) * sprintBlend,
        V_TMP.z + (P.sprint.rot.z - V_TMP.z) * sprintBlend
      );
    }
    this.rotSpring.target.copy(V_TMP);

    this.posSpring.update(dt);
    this.rotSpring.update(dt);

    // ------------------------------------------------------------------
    // Timelines: swap raise, bolt cycle, reload.
    // ------------------------------------------------------------------
    if (this.swapT < 1) this.swapT = Math.min(1, this.swapT + dt / Math.max(this.spec.swapTime, 0.1));
    const swapDrop = (1 - adsEase(this.swapT)) * 0.35;

    let tlPosX = 0, tlPosY = 0, tlPosZ = 0, tlRotX = 0, tlRotY = 0, tlRotZ = 0;
    tlPosY -= swapDrop;
    tlRotX -= swapDrop * 1.4;

    tlRotZ += this.updateBolt(dt, s);
    const rl = this.updateReload(dt);
    tlPosX += rl.px; tlPosY += rl.py; tlPosZ += rl.pz;
    tlRotX += rl.rx; tlRotY += rl.ry; tlRotZ += rl.rz;

    // Pistol slide return.
    if (this.rig.slide && this.rig.slide.position.z > 0) {
      this.rig.slide.position.z = Math.max(0, this.rig.slide.position.z - dt * 0.6);
    }

    // ------------------------------------------------------------------
    // Compose the rig transform.
    // ------------------------------------------------------------------
    const root = this.rig.root;
    root.position.set(
      this.posSpring.x.x + swayY * 0.35 + bobX + tlPosX,
      this.posSpring.x.y + swayP * 0.3 + bobY + tlPosY + this.landDip.x * 0.035 + this.stanceDip.x * 0.03,
      this.posSpring.x.z + this.kickZ.x * 0.016 + tlPosZ
    );
    root.rotation.set(
      this.rotSpring.x.x + swayP + idleX * 0.5 + this.kickPitch.x * 0.014 + tlRotX + this.landDip.x * 0.04,
      this.rotSpring.x.y + swayY + idleY * 0.3 + tlRotY,
      this.rotSpring.x.z + swayR + bobRoll + tlRotZ
    );

    // ------------------------------------------------------------------
    // Muzzle flash sprite + light (viewmodel space).
    // ------------------------------------------------------------------
    if (this.flashTtl > 0) {
      this.flashTtl -= dt;
      const on = this.flashTtl > 0 && !this.suppressed;
      this.muzzleFlash.visible = on;
      this.muzzleLight.intensity = on ? 6 : 0;
      if (on) {
        this.rig.muzzle.getWorldPosition(this.muzzleFlash.position);
        this.muzzleFlash.position.z -= 0.02;
        this.muzzleFlash.rotation.z = Math.random() * Math.PI * 2;
        const sc = 0.16 + Math.random() * 0.1;
        this.muzzleFlash.scale.set(sc, sc, sc);
        this.muzzleLight.position.copy(this.muzzleFlash.position);
      }
    } else {
      this.muzzleFlash.visible = false;
      this.muzzleLight.intensity = 0;
    }

    // ------------------------------------------------------------------
    // Scope overlay: blackout on scope-up, glass fade over last 25%.
    // ------------------------------------------------------------------
    if (s.adsState === AdsState.Scoped && this.prevAdsState !== AdsState.Scoped && this.rig.hasScope) {
      this.blackoutFrames = 2; // the two-frame blackout at scope-up
      Audio.play('scope_up', { volume: 0.7 });
    }
    if (s.adsState === AdsState.Lowering && this.prevAdsState === AdsState.Scoped) {
      Audio.play('scope_down', { volume: 0.5 });
    }
    this.prevAdsState = s.adsState;

    const glass = this.rig.hasScope ? smooth(0.75, 1.0, ads01) : 0;
    const blackout = this.blackoutFrames > 0;
    if (this.blackoutFrames > 0) this.blackoutFrames--;
    // Once the eye is on the glass the gun itself must not block the view.
    root.visible = glass < 0.55 && !blackout;
    this.scope.update(
      this.time,
      glass,
      blackout,
      swayY * 4 + idleY * 2.2,
      swayP * 4 + idleX * 2.2,
      s.zoomLevel ?? 0
    );

    return {
      cameraPitchOffset: this.camPitch,
      cameraYawOffset: this.camYaw,
      cameraPunch: this.punch.x * 0.01,
      scopeOverlayActive: glass > 0.5 || blackout,
    };
  }

  // ------------------------------------------------------------------
  // Bolt cycle: lift, pull, eject, push, lock — synced to cycleTime.
  // Returns a roll offset so the whole gun tips with the hand.
  // ------------------------------------------------------------------
  private updateBolt(dt: number, s: ViewmodelInput): number {
    const rig = this.rig;
    if (this.boltT < -0.5 || !rig.bolt || !rig.boltHandle) return 0;
    this.boltT += dt;
    if (this.boltT < 0) return 0;
    const p = this.boltT / this.boltDur;
    if (p >= 1) {
      this.boltT = -1;
      rig.boltHandle.rotation.z = 0;
      rig.bolt.position.z = 0;
      return 0;
    }
    // Phase events -> sounds + casing.
    if (this.boltEventsFired === 0 && p >= 0.02) {
      Audio.play('bolt_open');
      this.boltEventsFired = 1;
    }
    if (this.boltEventsFired === 1 && p >= 0.34) {
      Audio.play('bolt_back');
      this.ejectCasingNow(s);
      this.boltEventsFired = 2;
    }
    if (this.boltEventsFired === 2 && p >= 0.74) {
      Audio.play('bolt_close');
      this.boltEventsFired = 3;
    }
    // Handle lift 0..0.18, pull 0.18..0.4, hold, push 0.55..0.78, lock 0.78..1.
    const lift = smooth(0, 0.18, p) - smooth(0.78, 0.98, p);
    const pull = smooth(0.18, 0.4, p) - smooth(0.55, 0.78, p);
    rig.boltHandle.rotation.z = lift * 1.05;
    rig.bolt.position.z = pull * 0.085;
    // The rifle rolls toward the hand as it works the bolt.
    return lift * 0.1 + pull * 0.03;
  }

  // ------------------------------------------------------------------
  // Reload: lower, mag out, mag in, (chamber when empty), raise.
  // ------------------------------------------------------------------
  private updateReload(dt: number): { px: number; py: number; pz: number; rx: number; ry: number; rz: number } {
    const none = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
    if (this.reloadT < 0) return none;
    this.reloadT += dt;
    const p = this.reloadT / this.reloadDur;
    const rig = this.rig;
    if (p >= 1) {
      this.reloadT = -1;
      if (rig.magazine) rig.magazine.visible = true;
      return none;
    }
    const magOutAt = 0.22, magInAt = 0.55, chamberAt = 0.74;
    if (this.reloadEventsFired === 0 && p >= magOutAt) {
      Audio.play('mag_out');
      if (rig.magazine) rig.magazine.visible = false;
      this.reloadEventsFired = 1;
    }
    if (this.reloadEventsFired === 1 && p >= magInAt) {
      Audio.play('mag_in');
      if (rig.magazine) rig.magazine.visible = true;
      this.reloadEventsFired = 2;
    }
    if (this.reloadEventsFired === 2 && this.reloadEmpty && p >= chamberAt) {
      Audio.play('chamber');
      // Quick visual chamber: kick the bolt springs.
      if (rig.bolt && rig.boltHandle && this.boltT < 0) {
        this.boltDur = 0.34;
        this.boltT = 0;
        this.boltEventsFired = 3; // sounds already covered by 'chamber'
      }
      this.reloadEventsFired = 3;
    }
    // Lowered, tilted working pose with a plateau in the middle.
    const down = smooth(0, 0.14, p) - smooth(0.86, 1, p);
    // A little jostle when the mag seats.
    const seat = Math.sin(clamp((p - magInAt) * 30, 0, Math.PI)) * (p >= magInAt ? 1 : 0);
    return {
      px: 0.02 * down,
      py: -0.09 * down - 0.012 * seat,
      pz: 0.03 * down,
      rx: -0.38 * down - 0.05 * seat,
      ry: 0.12 * down,
      rz: 0.28 * down,
    };
  }

  /** Spawn an ejected casing into the world (falls to the deck) if we know
   *  the camera pose; always plays through the world Effects pool. */
  private ejectCasingNow(s?: ViewmodelInput): void {
    const cam = s?.cameraPos;
    if (!cam || s.viewYaw === undefined) return;
    const yaw = s.viewYaw;
    const pitch = s.viewPitch ?? 0;
    // Forward and right in world space from yaw/pitch (yaw 0 = -Z).
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = -Math.sin(yaw) * cp, fy = sp, fz = -Math.cos(yaw) * cp;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const pos: Vec3 = {
      x: cam.x + fx * 0.35 + rx * 0.18,
      y: cam.y - 0.05 + fy * 0.35,
      z: cam.z + fz * 0.35 + rz * 0.18,
    };
    const vel: Vec3 = {
      x: rx * 1.7 + fx * 0.3,
      y: 1.9,
      z: rz * 1.7 + fz * 0.3,
    };
    Effects.spawnCasing(pos, vel, cam.y - 1.55);
  }
}

function makeFlashTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,250,230,1)');
  grad.addColorStop(0.25, 'rgba(255,200,110,0.9)');
  grad.addColorStop(0.6, 'rgba(255,120,30,0.35)');
  grad.addColorStop(1, 'rgba(255,80,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  // Star spikes.
  g.strokeStyle = 'rgba(255,230,170,0.85)';
  g.lineWidth = 3;
  for (const a of [0, Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4]) {
    g.beginPath();
    g.moveTo(32 - Math.cos(a) * 30, 32 - Math.sin(a) * 30);
    g.lineTo(32 + Math.cos(a) * 30, 32 + Math.sin(a) * 30);
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}

function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const m = mesh.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m?.dispose();
    }
  });
}
