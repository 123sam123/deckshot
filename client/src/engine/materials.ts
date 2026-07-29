/**
 * Materials — one shared PBR material per SurfaceMaterial, procedurally
 * textured. No downloads: every map is painted into a canvas at boot.
 *
 * Every consumer must use the same instance per surface type so the renderer
 * can batch; get them via `Materials.get(SurfaceMaterial.Teak)` etc.
 *
 * The registry is configured once by the Renderer (`configureMaterials`) with
 * the resolved quality tier, then built lazily on first access.
 */

import * as THREE from 'three';
import { SurfaceMaterial } from '../../../shared/mapdata.js';
import type { QualityTier } from './quality.js';

// ---------------------------------------------------------------------------
// Deterministic RNG — textures look identical every boot.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number, draw: (ctx: Ctx2D, w: number, h: number) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('engine/materials: 2D canvas context unavailable');
  draw(ctx, w, h);
  return c;
}

interface TexOpts {
  srgb?: boolean;
  anisotropy?: number;
}

const liveTextures: THREE.Texture[] = [];

function toTexture(c: HTMLCanvasElement, opts: TexOpts = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  if (opts.srgb === true) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = opts.anisotropy ?? currentAnisotropy;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  liveTextures.push(t);
  return t;
}

function gray(v: number): string {
  const n = Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${n},${n},${n})`;
}

// ---------------------------------------------------------------------------
// Teak deck planking — warm planks, dark caulking seams, long grain.
// Texture covers ~2m x 2m of deck; consumers pick their own UV scale.
// ---------------------------------------------------------------------------

function drawTeakColor(ctx: Ctx2D, w: number, h: number): void {
  const rng = mulberry32(1101);
  const planks = 8;
  const pw = w / planks;
  for (let i = 0; i < planks; i++) {
    // Per-plank tonal variation around a warm honey teak.
    const l = 0.86 + rng() * 0.28;
    const r = Math.round(150 * l);
    const g = Math.round(104 * l);
    const b = Math.round(62 * l);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(i * pw, 0, pw, h);

    // Long grain streaks running the length of the plank.
    const streaks = 46;
    for (let sIdx = 0; sIdx < streaks; sIdx++) {
      const x = i * pw + 3 + rng() * (pw - 6);
      const dark = rng() > 0.42;
      const a = 0.04 + rng() * 0.1;
      ctx.strokeStyle = dark ? `rgba(58,36,18,${a})` : `rgba(226,182,128,${a * 0.8})`;
      ctx.lineWidth = 0.6 + rng() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, -8);
      const wobble = 2.5 + rng() * 5;
      ctx.bezierCurveTo(x + (rng() - 0.5) * wobble, h * 0.33, x + (rng() - 0.5) * wobble, h * 0.66, x + (rng() - 0.5) * wobble, h + 8);
      ctx.stroke();
    }

    // Occasional knot.
    if (rng() > 0.6) {
      const kx = i * pw + pw * (0.25 + rng() * 0.5);
      const ky = h * rng();
      const kr = 3 + rng() * 6;
      const grad = ctx.createRadialGradient(kx, ky, 0.5, kx, ky, kr);
      grad.addColorStop(0, 'rgba(52,32,16,0.85)');
      grad.addColorStop(1, 'rgba(52,32,16,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(kx - kr, ky - kr, kr * 2, kr * 2);
    }

    // Butt joints, staggered per plank.
    const joints = 1 + Math.floor(rng() * 2);
    for (let j = 0; j < joints; j++) {
      const y = h * rng();
      ctx.fillStyle = 'rgba(30,20,10,0.7)';
      ctx.fillRect(i * pw + 1, y, pw - 2, 2.2);
      ctx.fillStyle = 'rgba(235,195,140,0.25)';
      ctx.fillRect(i * pw + 1, y + 2.2, pw - 2, 1);
    }

    // Caulking seam between planks (classic yacht deck black lines).
    ctx.fillStyle = '#181410';
    ctx.fillRect(i * pw - 1.5, 0, 3, h);
  }
  // Subtle overall sun-bleach mottling.
  for (let i = 0; i < 40; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 30 + rng() * 90;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,236,200,${0.02 + rng() * 0.03})`);
    grad.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function drawTeakDetail(ctx: Ctx2D, w: number, h: number): void {
  // Grayscale: used as roughnessMap and bumpMap. Mid-gray = roughness ~0.6.
  const rng = mulberry32(2202);
  ctx.fillStyle = gray(152);
  ctx.fillRect(0, 0, w, h);
  const planks = 8;
  const pw = w / planks;
  for (let i = 0; i < planks; i++) {
    ctx.fillStyle = gray(146 + rng() * 16);
    ctx.fillRect(i * pw, 0, pw, h);
    for (let sIdx = 0; sIdx < 40; sIdx++) {
      const x = i * pw + rng() * pw;
      ctx.strokeStyle = gray(140 + rng() * 30);
      ctx.lineWidth = 0.6 + rng() * 1.4;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (rng() - 0.5) * 6, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Caulk seams sit lower (dark bump) and rougher (bright in roughness terms
    // is handled by the value; keep them dark so bump reads a groove).
    ctx.fillStyle = gray(70);
    ctx.fillRect(i * pw - 1.5, 0, 3, h);
  }
}

// ---------------------------------------------------------------------------
// Brushed metal — directional streaks, sparse scratches, faint smudges.
// ---------------------------------------------------------------------------

function drawMetalColor(ctx: Ctx2D, w: number, h: number): void {
  const rng = mulberry32(3303);
  ctx.fillStyle = 'rgb(178,183,189)';
  ctx.fillRect(0, 0, w, h);
  // Horizontal brushing.
  for (let i = 0; i < 900; i++) {
    const y = rng() * h;
    const l = rng() * w;
    const x = rng() * w;
    const light = rng() > 0.5;
    ctx.strokeStyle = light ? `rgba(232,236,240,${0.02 + rng() * 0.05})` : `rgba(96,102,110,${0.02 + rng() * 0.05})`;
    ctx.lineWidth = 0.5 + rng();
    ctx.beginPath();
    ctx.moveTo(x - l / 2, y);
    ctx.lineTo(x + l / 2, y + (rng() - 0.5) * 1.5);
    ctx.stroke();
  }
  // Sparse deeper scratches.
  for (let i = 0; i < 26; i++) {
    const y = rng() * h;
    const x = rng() * w;
    ctx.strokeStyle = `rgba(70,74,80,${0.15 + rng() * 0.2})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.2) * 120, y + (rng() - 0.5) * 8);
    ctx.stroke();
  }
  // Smudge patches.
  for (let i = 0; i < 14; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 20 + rng() * 60;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(120,124,130,${0.05 + rng() * 0.06})`);
    grad.addColorStop(1, 'rgba(120,124,130,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function drawMetalDetail(ctx: Ctx2D, w: number, h: number): void {
  const rng = mulberry32(4404);
  ctx.fillStyle = gray(74); // roughness ~0.29 — tight, hot golden-hour speculars
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 700; i++) {
    const y = rng() * h;
    const x = rng() * w;
    const l = rng() * w * 0.8;
    ctx.strokeStyle = gray(60 + rng() * 40);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 0.5 + rng();
    ctx.beginPath();
    ctx.moveTo(x - l / 2, y);
    ctx.lineTo(x + l / 2, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Fingerprint/smudge zones go rougher.
  for (let i = 0; i < 10; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 24 + rng() * 70;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(126,126,126,0.5)');
    grad.addColorStop(1, 'rgba(126,126,126,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// ---------------------------------------------------------------------------
// White gelcoat composite — panel seams, rivet lines, faint rain streaks.
// ---------------------------------------------------------------------------

function drawCompositeColor(ctx: Ctx2D, w: number, h: number): void {
  const rng = mulberry32(5505);
  ctx.fillStyle = 'rgb(240,238,231)';
  ctx.fillRect(0, 0, w, h);
  // Very subtle large-scale tone variation.
  for (let i = 0; i < 18; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 60 + rng() * 140;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const warm = rng() > 0.5;
    grad.addColorStop(0, warm ? 'rgba(232,224,206,0.10)' : 'rgba(216,220,224,0.08)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Panel seams.
  ctx.strokeStyle = 'rgba(150,146,138,0.55)';
  ctx.lineWidth = 1.6;
  const cell = w / 4;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell + 0.5, 0);
    ctx.lineTo(i * cell + 0.5, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell + 0.5);
    ctx.lineTo(w, i * cell + 0.5);
    ctx.stroke();
  }
  // Seam highlight (bevel read).
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell + 2, 0);
    ctx.lineTo(i * cell + 2, h);
    ctx.stroke();
  }
  // Rain streaks bleeding down from seams.
  for (let i = 0; i < 60; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const len = 20 + rng() * 90;
    const grad = ctx.createLinearGradient(x, y, x, y + len);
    grad.addColorStop(0, `rgba(168,162,150,${0.05 + rng() * 0.07})`);
    grad.addColorStop(1, 'rgba(168,162,150,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, 1.2 + rng() * 1.5, len);
  }
}

function drawCompositeDetail(ctx: Ctx2D, w: number, h: number): void {
  const rng = mulberry32(6606);
  ctx.fillStyle = gray(96); // gelcoat: fairly glossy
  ctx.fillRect(0, 0, w, h);
  const cell = w / 4;
  ctx.strokeStyle = gray(150);
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell + 0.5, 0);
    ctx.lineTo(i * cell + 0.5, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell + 0.5);
    ctx.lineTo(w, i * cell + 0.5);
    ctx.stroke();
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = gray(90 + rng() * 26);
    ctx.globalAlpha = 0.25;
    const x = rng() * w;
    const y = rng() * h;
    ctx.fillRect(x, y, 2 + rng() * 5, 2 + rng() * 5);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Fabric — cream/navy awning stripes with a visible weave.
// ---------------------------------------------------------------------------

function drawFabricColor(ctx: Ctx2D, w: number, h: number): void {
  const rng = mulberry32(7707);
  ctx.fillStyle = 'rgb(233,226,211)';
  ctx.fillRect(0, 0, w, h);
  // Navy stripes.
  const stripe = w / 4;
  ctx.fillStyle = 'rgb(47,74,108)';
  for (let x = stripe * 0.5; x < w; x += stripe * 2) {
    ctx.fillRect(x, 0, stripe * 0.62, h);
  }
  // Weave crosshatch.
  ctx.globalAlpha = 0.14;
  for (let y = 0; y < h; y += 3) {
    ctx.fillStyle = (y / 3) % 2 === 0 ? '#000000' : '#ffffff';
    ctx.fillRect(0, y, w, 1);
  }
  for (let x = 0; x < w; x += 3) {
    ctx.fillStyle = (x / 3) % 2 === 0 ? '#ffffff' : '#000000';
    ctx.fillRect(x, 0, 1, h);
  }
  ctx.globalAlpha = 1;
  // Wear/fade blotches.
  for (let i = 0; i < 12; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 20 + rng() * 60;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,252,240,${0.05 + rng() * 0.07})`);
    grad.addColorStop(1, 'rgba(255,252,240,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function drawFabricDetail(ctx: Ctx2D, w: number, h: number): void {
  ctx.fillStyle = gray(238); // very rough
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.5;
  for (let y = 0; y < h; y += 3) {
    ctx.fillStyle = gray((y / 3) % 2 === 0 ? 210 : 250);
    ctx.fillRect(0, y, w, 1);
  }
  for (let x = 0; x < w; x += 3) {
    ctx.fillStyle = gray((x / 3) % 2 === 0 ? 250 : 210);
    ctx.fillRect(x, 0, 1, h);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let currentTier: QualityTier = 'high';
let currentAnisotropy = 4;
let cache: Map<SurfaceMaterial, THREE.Material> | null = null;

/**
 * Must be called (by the Renderer) before the first `Materials.get`. Safe to
 * call again only before the registry is first built.
 */
export function configureMaterials(tier: QualityTier, maxAnisotropy = 4): void {
  if (cache !== null && tier !== currentTier) {
    console.warn('engine/materials: configureMaterials called after registry was built; ignoring tier change');
    return;
  }
  currentTier = tier;
  currentAnisotropy = Math.max(1, Math.min(8, maxAnisotropy));
}

function build(): Map<SurfaceMaterial, THREE.Material> {
  const map = new Map<SurfaceMaterial, THREE.Material>();
  const texSize = currentTier === 'low' ? 512 : 1024;

  // --- Teak ---------------------------------------------------------------
  {
    const color = toTexture(makeCanvas(texSize, texSize, drawTeakColor), { srgb: true });
    const detail = toTexture(makeCanvas(texSize, texSize, drawTeakDetail));
    const m = new THREE.MeshStandardMaterial({
      name: 'deckshot/teak',
      map: color,
      roughnessMap: detail,
      bumpMap: detail,
      bumpScale: 0.8,
      roughness: 1.0, // encoded in the map
      metalness: 0.0,
      envMapIntensity: 0.8,
    });
    map.set(SurfaceMaterial.Teak, m);
  }

  // --- Metal --------------------------------------------------------------
  {
    const color = toTexture(makeCanvas(texSize, texSize, drawMetalColor), { srgb: true });
    const detail = toTexture(makeCanvas(texSize, texSize, drawMetalDetail));
    const m = new THREE.MeshStandardMaterial({
      name: 'deckshot/metal',
      map: color,
      roughnessMap: detail,
      bumpMap: detail,
      bumpScale: 0.15,
      roughness: 1.0,
      metalness: 0.92,
      envMapIntensity: 1.25,
    });
    map.set(SurfaceMaterial.Metal, m);
  }

  // --- Glass --------------------------------------------------------------
  {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'deckshot/glass',
      color: 0xcfe4e8,
      metalness: 0.0,
      roughness: 0.06,
      envMapIntensity: 1.4,
      side: THREE.DoubleSide,
    });
    if (currentTier === 'high') {
      // Real transmission: one extra transmissive pass, high tier only.
      m.transmission = 0.7;
      m.thickness = 0.08;
      m.ior = 1.5;
      m.attenuationColor = new THREE.Color(0xbfe0da);
      m.attenuationDistance = 1.5;
    } else {
      m.transparent = true;
      m.opacity = 0.3;
      m.depthWrite = false;
    }
    map.set(SurfaceMaterial.Glass, m);
  }

  // --- Composite (white gelcoat superstructure) ---------------------------
  {
    const color = toTexture(makeCanvas(texSize, texSize, drawCompositeColor), { srgb: true });
    const detail = toTexture(makeCanvas(texSize, texSize, drawCompositeDetail));
    const m = new THREE.MeshPhysicalMaterial({
      name: 'deckshot/composite',
      map: color,
      roughnessMap: detail,
      bumpMap: detail,
      bumpScale: 0.25,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.9,
    });
    if (currentTier !== 'low') {
      m.clearcoat = 0.35;
      m.clearcoatRoughness = 0.3;
    }
    map.set(SurfaceMaterial.Composite, m);
  }

  // --- Fabric -------------------------------------------------------------
  {
    const size = currentTier === 'low' ? 256 : 512;
    const color = toTexture(makeCanvas(size, size, drawFabricColor), { srgb: true });
    const detail = toTexture(makeCanvas(size, size, drawFabricDetail));
    const m = new THREE.MeshPhysicalMaterial({
      name: 'deckshot/fabric',
      map: color,
      roughnessMap: detail,
      bumpMap: detail,
      bumpScale: 0.35,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.5,
      sheen: 0.35,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(0xf5ecd8),
    });
    map.set(SurfaceMaterial.Fabric, m);
  }

  // --- Water (fallback only — map-and-ocean owns the real ocean) ----------
  {
    const m = new THREE.MeshStandardMaterial({
      name: 'deckshot/water-fallback',
      color: 0x0d3c53,
      roughness: 0.12,
      metalness: 0.0,
      envMapIntensity: 1.4,
    });
    map.set(SurfaceMaterial.Water, m);
  }

  return map;
}

export interface MaterialRegistry {
  /** The shared material instance for a surface type. Never clone it. */
  get(surface: SurfaceMaterial): THREE.Material;
  /** All materials, e.g. for pre-compilation. */
  all(): ReadonlyMap<SurfaceMaterial, THREE.Material>;
  /** Frees GPU resources and resets the registry (hot-reload safety). */
  dispose(): void;
}

export const Materials: MaterialRegistry = {
  get(surface: SurfaceMaterial): THREE.Material {
    if (cache === null) cache = build();
    const m = cache.get(surface);
    if (m === undefined) throw new Error(`engine/materials: no material for SurfaceMaterial ${surface}`);
    return m;
  },
  all(): ReadonlyMap<SurfaceMaterial, THREE.Material> {
    if (cache === null) cache = build();
    return cache;
  },
  dispose(): void {
    if (cache !== null) {
      for (const m of cache.values()) m.dispose();
      cache = null;
    }
    for (const t of liveTextures) t.dispose();
    liveTextures.length = 0;
  },
};
