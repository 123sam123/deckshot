/**
 * DECKSHOT — player skins: per-part materials + decorative gear for the
 * third-person avatar bodies.
 *
 * Five original operators in a maritime-tactical register. Nothing here is
 * reproduced from any shipped game (see DECISIONS.md — original assets is what
 * keeps this distributable); the *visual language* — plate carriers, wetsuits,
 * dress whites, hardhat divers — is genre vocabulary.
 *
 * HARD CONSTRAINT: every gear mesh above the waist is inscribed INSIDE the
 * hitbox capsule union (`HITBOX_TEMPLATE`). A helmet wider than the head
 * capsule creates shots that visually hit and mechanically miss. The geometry
 * consequence is that flat boxes are almost never legal (their corners leave
 * the capsule) and surface-flush plates are invisible (buried in the body
 * mesh). So gear is built the only way that is both legal and visible:
 *
 *   - The base body capsules render slightly INSET (`HEAD_INSET`,
 *     `LIMB_INSET` — radial only, never Y), keeping the visual silhouette a
 *     hair inside the hitbox. The error direction is deliberate: a shot that
 *     visually misses by 3mm and still hits is imperceptible; the reverse is
 *     "the hit detection is broken".
 *   - Shells (helmets, visors, plates, bands) are lathes of the exact capsule
 *     profile at up to 99.9% of the true radius — proud of the inset body,
 *     inside the hitbox.
 *   - Small fittings (buttons, pouches, valves) are placed so their farthest
 *     corner stays within the capsule radius.
 *   - Only leg gear (boots, knee pads) may extend past the capsules — below
 *     the waist nothing is a one-shot kill.
 *
 * The five are spread across value AND hue so they stay separable at 40–60m
 * and in greyscale: mid olive (Vanguard), near-black (Frogman), white
 * (Commodore), dark teal/brass (Fathom), hot orange (Breacher). Headgear
 * silhouettes differ inside the same envelope: helmet+goggle band, slick
 * hooded dome, peaked cap band, crested hardhat, face shield.
 *
 * All textures are procedural canvas — no asset files, like the weapon camos.
 */

import * as THREE from 'three';

import { HITBOX_TEMPLATE } from '../../../shared/hitbox.js';
import { HitboxPart, SkinId } from '../../../shared/types.js';

/**
 * Radial (X/Z) scale for the base body capsule meshes. Head is inset more so
 * helmets and face fittings read as real relief; limbs/torso less because
 * their gear shells are thinner.
 */
export const HEAD_INSET = 0.94;
export const LIMB_INSET = 0.985;

/** Names + one-line identities, shared by the loadout UI. */
export const SKIN_INFO: ReadonlyArray<{ name: string; role: string; blurb: string }> = [
  { name: 'Vanguard', role: 'boarding assaulter', blurb: 'Olive fatigues, coyote plate carrier, ballistic helmet with goggle band.' },
  { name: 'Frogman', role: 'combat diver', blurb: 'Near-black wetsuit, hood, rebreather faceplate, crimson sash.' },
  { name: 'Commodore', role: 'fleet officer', blurb: 'Dress whites, gold buttons and cuffs, peaked cap.' },
  { name: 'Fathom', role: 'hazard diver', blurb: 'Verdigris dive suit, crested brass hardhat, amber porthole.' },
  { name: 'Breacher', role: 'hull breacher', blurb: 'Burnt-orange blast suit, steel plates, mirrored face shield.' },
];

export interface SkinAppearance {
  /** Material per hitbox part; the avatar builds its capsules from these. */
  materials: Map<HitboxPart, THREE.MeshStandardMaterial>;
  /** Decorative meshes in player-local space (Y up, origin at feet, -Z forward). */
  gear: THREE.Object3D[];
  /** Disposes every material, texture and gear geometry this skin owns. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Capsule geometry helpers
// ---------------------------------------------------------------------------

function capsuleOf(part: HitboxPart): { aY: number; bY: number; r: number } {
  const c = HITBOX_TEMPLATE.find((h) => h.part === part);
  if (!c) throw new Error(`skins: no hitbox capsule for part ${part}`);
  return { aY: c.a.y, bY: c.b.y, r: c.radius };
}

const HEAD = capsuleOf(HitboxPart.Head);
const CHEST = capsuleOf(HitboxPart.Chest);
const STOMACH = capsuleOf(HitboxPart.Stomach);

/** Capsule surface radius at height y (0 outside the capsule's Y range). */
function capsuleRadiusAt(c: { aY: number; bY: number; r: number }, y: number): number {
  if (y >= c.aY && y <= c.bY) return c.r;
  const d = y < c.aY ? c.aY - y : y - c.bY;
  const q = c.r * c.r - d * d;
  return q > 0 ? Math.sqrt(q) : 0;
}

interface GearKit {
  gear: THREE.Object3D[];
  geos: THREE.BufferGeometry[];
  mats: THREE.MeshStandardMaterial[];
  texs: THREE.Texture[];
}

const kit = (): GearKit => ({ gear: [], geos: [], mats: [], texs: [] });

function gm(k: GearKit, o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial(o);
  k.mats.push(m);
  return m;
}

function add(k: GearKit, geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial): THREE.Mesh {
  k.geos.push(geo);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  k.gear.push(m);
  return m;
}

/**
 * A shell hugging a capsule's surface between yLo..yHi, optionally only a
 * front-facing angular wedge (`phiSpan` radians centred on -Z). This is the
 * one legal shape for helmets, visors, plates and bands: it follows the
 * capsule profile at `rScale` of the true radius, so it can never leave the
 * hitbox, and it stands proud of the inset body so it actually renders.
 */
function shell(
  k: GearKit,
  mat: THREE.MeshStandardMaterial,
  c: { aY: number; bY: number; r: number },
  yLo: number,
  yHi: number,
  phiSpan = Math.PI * 2,
  rScale = 0.999,
): THREE.Mesh {
  const pts: THREE.Vector2[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const y = yLo + ((yHi - yLo) * i) / steps;
    pts.push(new THREE.Vector2(Math.max(0.001, capsuleRadiusAt(c, y) * rScale), y));
  }
  // Lathe: x = r·sin(phi), z = r·cos(phi) — front (-Z) is phi = PI.
  const geo = new THREE.LatheGeometry(pts, 20, Math.PI - phiSpan / 2, phiSpan);
  mat.side = THREE.DoubleSide;
  return add(k, geo, mat);
}

/**
 * A small box fitting on a capsule's surface at `azimuth` (0 = front, -Z),
 * pushed out as far as its own corners allow. Returns the mesh (rotated to
 * face outward).
 */
function fitting(
  k: GearKit,
  mat: THREE.MeshStandardMaterial,
  c: { aY: number; bY: number; r: number },
  azimuth: number,
  y: number,
  w: number,
  h: number,
  d: number,
): THREE.Mesh {
  // The tightest ring the box must fit inside over its own height.
  const rTop = capsuleRadiusAt(c, y + h / 2);
  const rBot = capsuleRadiusAt(c, y - h / 2);
  const rCap = Math.max(0.001, Math.min(rTop, rBot));
  const half = Math.hypot(w / 2, 0);
  const outFace = Math.sqrt(Math.max(0.0001, rCap * rCap - half * half)) - 0.0005;
  const dist = outFace - d / 2;
  const mesh = add(k, new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(-Math.sin(azimuth) * dist, y, -Math.cos(azimuth) * dist);
  mesh.rotation.y = azimuth;
  return mesh;
}

function patternTexture(k: GearKit, size: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) draw(g);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  k.texs.push(tex);
  return tex;
}

/** Deterministic pseudo-random — skins must look identical on every client. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function finish(k: GearKit, materials: Map<HitboxPart, THREE.MeshStandardMaterial>): SkinAppearance {
  return {
    materials,
    gear: k.gear,
    dispose() {
      for (const g of k.geos) g.dispose();
      for (const m of k.mats) m.dispose();
      for (const t of k.texs) t.dispose();
    },
  };
}

function partMap(m: {
  head: THREE.MeshStandardMaterial;
  chest: THREE.MeshStandardMaterial;
  stomach: THREE.MeshStandardMaterial;
  arms: THREE.MeshStandardMaterial;
  legs: THREE.MeshStandardMaterial;
}): Map<HitboxPart, THREE.MeshStandardMaterial> {
  return new Map([
    [HitboxPart.Head, m.head],
    [HitboxPart.Chest, m.chest],
    [HitboxPart.Stomach, m.stomach],
    [HitboxPart.ArmL, m.arms],
    [HitboxPart.ArmR, m.arms],
    [HitboxPart.LegL, m.legs],
    [HitboxPart.LegR, m.legs],
  ]);
}

// ---------------------------------------------------------------------------
// Per-skin builders
// ---------------------------------------------------------------------------

/** 0 — VANGUARD: boarding assaulter. Mid-value olive + coyote. Default. */
function buildVanguard(): SkinAppearance {
  const k = kit();
  const camoTex = patternTexture(k, 128, (g) => {
    const r = rng(0xa11ce);
    g.fillStyle = '#4b5540';
    g.fillRect(0, 0, 128, 128);
    const tones = ['#5d6549', '#3a4234', '#6e6f52', '#2f362b'];
    for (let i = 0; i < 42; i++) {
      g.fillStyle = tones[i % tones.length];
      g.beginPath();
      const x = r() * 128;
      const y = r() * 128;
      g.moveTo(x, y);
      for (let p = 0; p < 6; p++) g.lineTo(x + (r() - 0.5) * 34, y + (r() - 0.5) * 34);
      g.closePath();
      g.fill();
    }
  });
  const fatigues = gm(k, { map: camoTex, roughness: 0.86, metalness: 0.02 });
  const sleeves = gm(k, { color: 0x4c5443, roughness: 0.88, metalness: 0.02 });
  const balaclava = gm(k, { color: 0x39402f, roughness: 0.9 });
  const coyote = gm(k, { color: 0x8a7250, roughness: 0.82, metalness: 0.03 });
  const webbing = gm(k, { color: 0x655a42, roughness: 0.85 });
  const dark = gm(k, { color: 0x22242a, roughness: 0.45, metalness: 0.3 });
  const lens = gm(k, { color: 0x131b1f, roughness: 0.15, metalness: 0.6, emissive: 0x0a2a33, emissiveIntensity: 0.3 });

  // Ballistic helmet: coyote crown from mid-skull up, goggle band across the
  // brow, strap band below it.
  shell(k, coyote, HEAD, 1.6, 1.744);
  shell(k, lens, HEAD, 1.6, 1.638, Math.PI * 0.62, 0.9995);
  shell(k, dark, HEAD, 1.575, 1.6, Math.PI * 2, 0.997);

  // Plate carrier: front + back plates, cummerbund, triple mag pouches.
  shell(k, coyote, CHEST, 1.08, 1.26, Math.PI * 0.52);
  const back = shell(k, coyote, CHEST, 1.08, 1.26, Math.PI * 0.52);
  back.rotation.y = Math.PI;
  shell(k, webbing, CHEST, 1.06, 1.1);
  for (const az of [-0.42, 0, 0.42]) {
    fitting(k, webbing, STOMACH, az, 0.985, 0.05, 0.07, 0.035);
  }
  // Duty belt.
  shell(k, dark, STOMACH, 0.925, 0.975);

  return finish(k, partMap({ head: balaclava, chest: fatigues, stomach: fatigues, arms: sleeves, legs: fatigues }));
}

/** 1 — FROGMAN: combat diver. Near-black — the dark end of the value spread. */
function buildFrogman(): SkinAppearance {
  const k = kit();
  const neopreneTex = patternTexture(k, 128, (g) => {
    g.fillStyle = '#15181c';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#22262c';
    g.lineWidth = 2;
    for (const y of [22, 64, 106]) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(128, y);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(64, 0);
    g.lineTo(64, 128);
    g.stroke();
  });
  const wetsuit = gm(k, { map: neopreneTex, roughness: 0.42, metalness: 0.08 });
  const hood = gm(k, { color: 0x101317, roughness: 0.38, metalness: 0.08 });
  const legsMat = gm(k, { color: 0x181c22, roughness: 0.5, metalness: 0.1 });
  const rig = gm(k, { color: 0x23272e, roughness: 0.75, metalness: 0.1 });
  const steel = gm(k, { color: 0x555c64, roughness: 0.35, metalness: 0.7 });
  const visor = gm(k, { color: 0x0d1518, roughness: 0.12, metalness: 0.5, emissive: 0x123038, emissiveIntensity: 0.35 });
  const sash = gm(k, { color: 0x5e242c, roughness: 0.8 });

  // Rebreather faceplate over the lower face + slit visor at the eyes. The
  // hood is the head material itself — a slick, featureless dome.
  shell(k, rig, HEAD, 1.49, 1.59, Math.PI * 0.6);
  shell(k, visor, HEAD, 1.602, 1.634, Math.PI * 0.55, 0.9995);
  // Sternum rig panel + twin pouches.
  shell(k, rig, CHEST, 1.12, 1.27, Math.PI * 0.34);
  fitting(k, rig, CHEST, -0.5, 1.15, 0.05, 0.08, 0.03);
  fitting(k, rig, CHEST, 0.5, 1.15, 0.05, 0.08, 0.03);
  fitting(k, steel, CHEST, 0, 1.1, 0.06, 0.03, 0.03);
  // Faded crimson sash, slightly tilted.
  const sashBand = shell(k, sash, STOMACH, 0.945, 1.005);
  sashBand.rotation.z = 0.08;
  // Dive knife on the left shin (below the waist — free to protrude).
  const knife = add(k, new THREE.BoxGeometry(0.035, 0.16, 0.02), steel);
  knife.position.set(-0.19, 0.45, -0.04);

  return finish(k, partMap({ head: hood, chest: wetsuit, stomach: wetsuit, arms: wetsuit, legs: legsMat }));
}

/** 2 — COMMODORE: fleet officer. Dress whites — the light end. */
function buildCommodore(): SkinAppearance {
  const k = kit();
  const jacketTex = patternTexture(k, 128, (g) => {
    g.fillStyle = '#ecebe4';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#e2e1d8';
    for (let y = 0; y < 128; y += 4) g.fillRect(0, y, 128, 1);
  });
  const whites = gm(k, { map: jacketTex, roughness: 0.78 });
  const slacks = gm(k, { color: 0xe6e4da, roughness: 0.8 });
  const flesh = gm(k, { color: 0xb08a68, roughness: 0.75 });
  const capWhite = gm(k, { color: 0xf2f1ea, roughness: 0.7 });
  const black = gm(k, { color: 0x14151a, roughness: 0.5, metalness: 0.2 });
  const gold = gm(k, { color: 0xc9a132, roughness: 0.35, metalness: 0.85 });
  const navy = gm(k, { color: 0x1d3a66, roughness: 0.7 });

  // Peaked cap: white crown over a black band, gold badge at the front.
  shell(k, capWhite, HEAD, 1.622, 1.744);
  shell(k, black, HEAD, 1.578, 1.622, Math.PI * 2, 0.9995);
  fitting(k, gold, HEAD, 0, 1.6, 0.024, 0.02, 0.012);

  // Double-breasted front: two columns of gold buttons + navy chest bar.
  for (const y of [1.24, 1.16, 1.08]) {
    for (const side of [-1, 1]) {
      const b = add(k, new THREE.SphereGeometry(0.011, 8, 8), gold);
      // sqrt(0.045² + 0.1774²) + 0.011 = 0.194 < chest r 0.195.
      b.position.set(side * 0.045, y, -0.1774);
    }
  }
  shell(k, navy, CHEST, 1.245, 1.275, Math.PI * 0.4);
  // Epaulette discs on the shoulder caps + gold cuff rings.
  for (const side of [-1, 1]) {
    const ep = add(k, new THREE.CylinderGeometry(0.04, 0.04, 0.007, 14), gold);
    ep.position.set(side * 0.265, 1.3985, 0);
    const cuff = add(k, new THREE.CylinderGeometry(0.0847, 0.0847, 0.022, 14), gold);
    cuff.position.set(side * 0.265, 1.0, 0);
  }
  // Black dress belt.
  shell(k, black, STOMACH, 0.94, 0.985);

  return finish(k, partMap({ head: flesh, chest: whites, stomach: whites, arms: whites, legs: slacks }));
}

/** 3 — FATHOM: hazard diver. Verdigris + brass — saturated cool. */
function buildFathom(): SkinAppearance {
  const k = kit();
  const suitTex = patternTexture(k, 128, (g) => {
    const r = rng(0xfa7 + 0x40); // deterministic seed, no meaning
    g.fillStyle = '#2e5a52';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = i % 3 ? '#274d46' : '#3d6f60';
      g.beginPath();
      g.arc(r() * 128, r() * 128, 2 + r() * 7, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#8fb9a4';
    for (let i = 0; i < 26; i++) {
      g.beginPath();
      g.arc(r() * 128, r() * 128, 1 + r() * 2, 0, Math.PI * 2);
      g.fill();
    }
  });
  const suit = gm(k, { map: suitTex, roughness: 0.68, metalness: 0.12 });
  const gloves = gm(k, { color: 0x2b4f48, roughness: 0.7, metalness: 0.1 });
  const brassHead = gm(k, { color: 0x9a7b35, roughness: 0.38, metalness: 0.85 });
  const brass = gm(k, { color: 0x9a7b35, roughness: 0.38, metalness: 0.85 });
  const verdigris = gm(k, { color: 0x58907c, roughness: 0.6, metalness: 0.4 });
  const amber = gm(k, { color: 0xd99b2e, roughness: 0.15, metalness: 0.3, emissive: 0xa86a12, emissiveIntensity: 0.55 });
  const canvasStrap = gm(k, { color: 0x4a4534, roughness: 0.9 });
  const lead = gm(k, { color: 0x6b5a30, roughness: 0.45, metalness: 0.6 });

  // Hardhat: the whole head is brass (head material); a verdigris crest ridge
  // runs bow-to-stern over the crown — the one silhouette flourish the head
  // capsule has room for — with the amber porthole and side ports as fittings.
  const crest = add(k, new THREE.BoxGeometry(0.008, 0.03, 0.104), verdigris);
  crest.position.set(0, 1.714, 0); // corners stay inside the head cap sphere
  const porthole = add(k, new THREE.CylinderGeometry(0.028, 0.028, 0.014, 16), amber);
  porthole.position.set(0, 1.6075, -0.094);
  porthole.rotation.x = Math.PI / 2;
  for (const side of [-1, 1]) {
    const port = add(k, new THREE.CylinderGeometry(0.02, 0.02, 0.01, 10), brass);
    port.position.set(side * 0.098, 1.607, 0);
    port.rotation.z = Math.PI / 2;
  }
  // Brass chest plate + valve, canvas harness band, weight belt + buckle.
  shell(k, brass, CHEST, 1.13, 1.27, Math.PI * 0.5);
  fitting(k, verdigris, CHEST, 0.3, 1.2, 0.05, 0.05, 0.03);
  shell(k, canvasStrap, CHEST, 1.06, 1.1);
  shell(k, canvasStrap, STOMACH, 0.93, 0.985);
  fitting(k, brass, STOMACH, 0, 0.957, 0.05, 0.04, 0.02);
  // Lead overshoes (below the waist — allowed outward).
  for (const side of [-1, 1]) {
    const shoe = add(k, new THREE.BoxGeometry(0.1, 0.09, 0.16), lead);
    shoe.position.set(side * 0.115, 0.11, -0.02);
  }

  return finish(k, partMap({ head: brassHead, chest: suit, stomach: suit, arms: gloves, legs: suit }));
}

/** 4 — BREACHER: hull breacher. Burnt orange + steel — saturated warm. */
function buildBreacher(): SkinAppearance {
  const k = kit();
  const suitTex = patternTexture(k, 128, (g) => {
    const r = rng(0xb4ea);
    g.fillStyle = '#b4501e';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 34; i++) {
      g.fillStyle = i % 2 ? '#9c421a' : '#c25f24';
      g.beginPath();
      const x = r() * 128;
      const y = r() * 128;
      g.moveTo(x, y);
      for (let p = 0; p < 5; p++) g.lineTo(x + (r() - 0.5) * 28, y + (r() - 0.5) * 28);
      g.closePath();
      g.fill();
    }
    g.fillStyle = 'rgba(30,24,20,0.35)';
    for (let i = 0; i < 12; i++) {
      g.beginPath();
      g.arc(r() * 128, r() * 128, 3 + r() * 8, 0, Math.PI * 2);
      g.fill();
    }
  });
  const suit = gm(k, { map: suitTex, roughness: 0.8, metalness: 0.05 });
  const darkTrim = gm(k, { color: 0x37302a, roughness: 0.75, metalness: 0.1 });
  const helm = gm(k, { color: 0x3a3f45, roughness: 0.4, metalness: 0.55 });
  const steel = gm(k, { color: 0x8d949c, roughness: 0.3, metalness: 0.85 });
  const shield = gm(k, { color: 0xb9c4cc, roughness: 0.1, metalness: 0.75, emissive: 0x2a3238, emissiveIntensity: 0.25 });
  const strap = gm(k, { color: 0x2a2622, roughness: 0.85 });
  const hazard = gm(k, { color: 0xd8d2c4, roughness: 0.7 });

  // Mirrored face shield wrapping the front of the dark helmet dome, with a
  // respirator filter at the jaw.
  shell(k, shield, HEAD, 1.5, 1.68, Math.PI * 0.62);
  const filter = fitting(k, steel, HEAD, 0.55, 1.58, 0.045, 0.05, 0.04);
  filter.rotation.x = 0.25;
  // Steel blast apron: chest plate with a pale hazard bar, stomach plate.
  shell(k, steel, CHEST, 1.1, 1.27, Math.PI * 0.5);
  shell(k, hazard, CHEST, 1.235, 1.262, Math.PI * 0.5, 0.9995);
  shell(k, steel, STOMACH, 0.93, 1.01, Math.PI * 0.5);
  // Harness band + belt.
  shell(k, strap, CHEST, 1.06, 1.095);
  shell(k, strap, STOMACH, 0.912, 0.945);
  // Knee pads (below the waist — allowed outward).
  for (const side of [-1, 1]) {
    const pad = add(k, new THREE.SphereGeometry(0.075, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), steel);
    pad.position.set(side * 0.115, 0.52, -0.065);
    pad.rotation.x = -1.2;
  }

  return finish(k, partMap({ head: helm, chest: suit, stomach: suit, arms: suit, legs: darkTrim }));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const BUILDERS: Record<SkinId, () => SkinAppearance> = {
  [SkinId.Vanguard]: buildVanguard,
  [SkinId.Frogman]: buildFrogman,
  [SkinId.Commodore]: buildCommodore,
  [SkinId.Fathom]: buildFathom,
  [SkinId.Breacher]: buildBreacher,
};

/** Builds the full appearance for a skin id; out-of-range ids get the default. */
export function buildSkinAppearance(skin: SkinId): SkinAppearance {
  const b = BUILDERS[skin] ?? BUILDERS[SkinId.Vanguard];
  return b();
}
