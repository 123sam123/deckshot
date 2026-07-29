/**
 * Procedural canvas textures — DECKSHOT ships zero downloaded assets.
 *
 * Everything the world needs (teak planking, brushed metal, gelcoat, pool
 * tile, crate stencils, fabric, ocean detail normals, foam noise) is painted
 * into canvases at boot. All textures are tileable.
 *
 * Deterministic: seeded LCG, no Math.random(). These are presentation-only
 * and never touch the simulation, but determinism keeps screenshots stable.
 */

import * as THREE from 'three';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

function makeTexture(size: number, srgb: boolean, painter: Painter): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  painter(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Periodic value-noise fbm heightfield in [0,1]. */
export function fbmField(size: number, seed: number, octaves = 4, baseCell = 48): Float32Array {
  const out = new Float32Array(size * size);
  const rand = mulberry32(seed);
  let amp = 1;
  let total = 0;
  let cell = baseCell;
  for (let o = 0; o < octaves; o++) {
    const n = Math.max(2, Math.round(size / cell));
    const lat = new Float32Array(n * n);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * n;
      const y0 = Math.floor(fy) % n;
      const y1 = (y0 + 1) % n;
      const ty = smooth(fy - Math.floor(fy));
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * n;
        const x0 = Math.floor(fx) % n;
        const x1 = (x0 + 1) % n;
        const tx = smooth(fx - Math.floor(fx));
        const v = lerp(
          lerp(lat[y0 * n + x0], lat[y0 * n + x1], tx),
          lerp(lat[y1 * n + x0], lat[y1 * n + x1], tx),
          ty
        );
        out[y * size + x] += v * amp;
      }
    }
    total += amp;
    amp *= 0.5;
    cell /= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Grayscale tileable noise — used for ocean foam breakup. */
export function foamNoiseTexture(size = 256, seed = 911): THREE.CanvasTexture {
  const h = fbmField(size, seed, 5, 64);
  return makeTexture(size, false, (ctx) => {
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      // Sharpen toward streaky foam filaments.
      const v = Math.pow(h[i], 1.35);
      const g = Math.round(v * 255);
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Tileable normal map derived from fbm heights. RG = slope, B = up. */
export function waterNormalTexture(size = 256, seed = 407, strength = 2.4): THREE.CanvasTexture {
  const h = fbmField(size, seed, 5, 56);
  return makeTexture(size, false, (ctx) => {
    const img = ctx.createImageData(size, size);
    const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
        const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
        const inv = 1 / Math.hypot(dx, dy, 1);
        const i = (y * size + x) * 4;
        img.data[i] = Math.round((dx * inv * 0.5 + 0.5) * 255);
        img.data[i + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
        img.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Yacht deck: warm teak planks with black caulk seams and staggered joints. */
export function teakTexture(size = 512): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const rand = mulberry32(101);
    const planks = 8;
    const pw = size / planks;
    for (let p = 0; p < planks; p++) {
      const light = 30 + rand() * 12;
      ctx.fillStyle = `hsl(${26 + rand() * 8}, ${38 + rand() * 12}%, ${light}%)`;
      ctx.fillRect(p * pw, 0, pw, size);
      // Grain: long wobbly streaks running the plank (vertical).
      for (let g = 0; g < 46; g++) {
        const gx = p * pw + 2 + rand() * (pw - 4);
        const dark = rand() > 0.5;
        ctx.strokeStyle = dark ? `rgba(40, 22, 8, ${0.05 + rand() * 0.08})` : `rgba(255, 214, 150, ${0.04 + rand() * 0.05})`;
        ctx.lineWidth = 0.7 + rand() * 1.6;
        ctx.beginPath();
        ctx.moveTo(gx, -8);
        for (let y = 0; y <= size; y += 32) {
          ctx.lineTo(gx + Math.sin(y * 0.02 + g) * 2.2 * rand(), y);
        }
        ctx.stroke();
      }
      // Black caulk seam between planks.
      ctx.fillStyle = 'rgb(24, 20, 16)';
      ctx.fillRect(p * pw - 2, 0, 4, size);
      // Staggered butt joints with bung dots.
      const joints = 1 + Math.floor(rand() * 2);
      for (let j = 0; j < joints; j++) {
        const jy = rand() * size;
        ctx.fillRect(p * pw, jy - 1.5, pw, 3);
        ctx.fillStyle = 'rgba(18, 12, 6, 0.85)';
        ctx.beginPath();
        ctx.arc(p * pw + pw * 0.25, jy + 9, 2.4, 0, Math.PI * 2);
        ctx.arc(p * pw + pw * 0.75, jy + 9, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgb(24, 20, 16)';
      }
    }
    ctx.fillStyle = 'rgb(24, 20, 16)';
    ctx.fillRect(size - 2, 0, 2, size);
    ctx.fillRect(0, 0, 2, size);
  });
}

/** Brushed marine metal — pale steel with fine directional streaks. */
export function brushedMetalTexture(size = 512): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const rand = mulberry32(202);
    ctx.fillStyle = 'rgb(186, 193, 199)';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 2400; i++) {
      const y = rand() * size;
      const x = rand() * size;
      const len = 30 + rand() * 220;
      const bright = rand() > 0.5;
      ctx.strokeStyle = bright ? `rgba(255,255,255,${0.02 + rand() * 0.05})` : `rgba(70,80,90,${0.02 + rand() * 0.05})`;
      ctx.lineWidth = 0.6 + rand();
      ctx.beginPath();
      ctx.moveTo(x - len / 2, y);
      ctx.lineTo(x + len / 2, y);
      ctx.stroke();
    }
    // A few soft smudges.
    for (let i = 0; i < 18; i++) {
      const g = ctx.createRadialGradient(rand() * size, rand() * size, 4, rand() * size, rand() * size, 60 + rand() * 90);
      g.addColorStop(0, `rgba(120,130,140,${0.04 + rand() * 0.05})`);
      g.addColorStop(1, 'rgba(120,130,140,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
  });
}

/** White superstructure gelcoat with faint panel seams. */
export function gelcoatTexture(size = 256): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const rand = mulberry32(303);
    ctx.fillStyle = 'rgb(238, 241, 240)';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = rand() > 0.5 ? `rgba(255,255,255,${rand() * 0.06})` : `rgba(160,170,175,${rand() * 0.05})`;
      const w = 6 + rand() * 26;
      ctx.fillRect(rand() * size, rand() * size, w, w * (0.3 + rand()));
    }
    ctx.strokeStyle = 'rgba(120, 132, 138, 0.28)';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(1, 1, size - 2, size - 2);
    ctx.strokeStyle = 'rgba(120, 132, 138, 0.14)';
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();
  });
}

/** Supply crate: worn composite with a hazard band and stencilled markings. */
export function crateTexture(size = 512): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const rand = mulberry32(404);
    ctx.fillStyle = 'rgb(196, 189, 170)';
    ctx.fillRect(0, 0, size, size);
    // Scuffs and grime.
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rand() > 0.6 ? `rgba(110,100,80,${rand() * 0.10})` : `rgba(235,232,220,${rand() * 0.08})`;
      ctx.fillRect(rand() * size, rand() * size, 2 + rand() * 24, 1 + rand() * 5);
    }
    // Horizontal hazard band (tileable across U).
    const bandY = size * 0.72;
    const bandH = size * 0.11;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, bandY, size, bandH);
    ctx.clip();
    ctx.fillStyle = 'rgb(206, 158, 32)';
    ctx.fillRect(0, bandY, size, bandH);
    ctx.fillStyle = 'rgb(38, 38, 40)';
    for (let x = -size; x < size * 2; x += 44) {
      ctx.beginPath();
      ctx.moveTo(x, bandY + bandH);
      ctx.lineTo(x + 22, bandY);
      ctx.lineTo(x + 44, bandY);
      ctx.lineTo(x + 22, bandY + bandH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // Stencils.
    ctx.fillStyle = 'rgba(36, 52, 74, 0.85)';
    ctx.font = `bold ${Math.round(size * 0.085)}px monospace`;
    ctx.fillText('DECKSHOT', size * 0.08, size * 0.22);
    ctx.font = `bold ${Math.round(size * 0.055)}px monospace`;
    ctx.fillText('SUPPLY 07', size * 0.08, size * 0.31);
    ctx.fillText('DRY STOW', size * 0.55, size * 0.52);
    // This-way-up arrows.
    ctx.strokeStyle = 'rgba(36, 52, 74, 0.85)';
    ctx.lineWidth = size * 0.014;
    for (const ax of [size * 0.16, size * 0.24]) {
      ctx.beginPath();
      ctx.moveTo(ax, size * 0.56);
      ctx.lineTo(ax, size * 0.42);
      ctx.moveTo(ax - size * 0.035, size * 0.46);
      ctx.lineTo(ax, size * 0.42);
      ctx.lineTo(ax + size * 0.035, size * 0.46);
      ctx.stroke();
    }
  });
}

/** Pool interior: aqua mosaic tile with light grout. */
export function poolTileTexture(size = 256): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const rand = mulberry32(505);
    const n = 8;
    const t = size / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const l = 58 + rand() * 14;
        ctx.fillStyle = `hsl(${184 + rand() * 10}, ${52 + rand() * 16}%, ${l}%)`;
        ctx.fillRect(x * t + 1.5, y * t + 1.5, t - 3, t - 3);
        // Glaze highlight.
        ctx.fillStyle = `rgba(255,255,255,${0.08 + rand() * 0.10})`;
        ctx.fillRect(x * t + 3, y * t + 3, t - 12, t * 0.22);
      }
    }
  });
}

/** Cream marine canvas with navy stripes (awnings, loungers). */
export function fabricTexture(size = 256): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const rand = mulberry32(606);
    ctx.fillStyle = 'rgb(238, 229, 208)';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgb(46, 66, 104)';
    for (let x = 0; x < size; x += 64) ctx.fillRect(x, 0, 22, size);
    // Weave.
    for (let y = 0; y < size; y += 2) {
      ctx.fillStyle = `rgba(0,0,0,${0.02 + (y % 4 === 0 ? 0.03 : 0)})`;
      ctx.fillRect(0, y, size, 1);
    }
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `rgba(255,255,255,${rand() * 0.05})`;
      ctx.fillRect(rand() * size, rand() * size, 2, 2);
    }
  });
}

/** Life ring: alternating red/white quadrants along U, with rope marks. */
export function lifeRingTexture(size = 128): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const q = size / 4;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgb(214, 58, 44)' : 'rgb(240, 240, 236)';
      ctx.fillRect(i * q, 0, q, size);
    }
    ctx.strokeStyle = 'rgba(90, 70, 40, 0.5)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * q, 0);
      ctx.lineTo(i * q, size);
      ctx.stroke();
    }
  });
}

/** Twisted rope for coils. */
export function ropeTexture(size = 128): THREE.CanvasTexture {
  return makeTexture(size, true, (ctx) => {
    const rand = mulberry32(707);
    ctx.fillStyle = 'rgb(196, 174, 132)';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(120, 96, 58, 0.55)';
    ctx.lineWidth = 5;
    for (let x = -size; x < size * 2; x += 14) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + size * 0.5, size);
      ctx.stroke();
    }
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = `rgba(255, 240, 200, ${rand() * 0.1})`;
      ctx.fillRect(rand() * size, rand() * size, 3, 2);
    }
  });
}
