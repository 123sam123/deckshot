/**
 * Quality tiers — the renderer's performance dial.
 *
 * A tier is resolved once at boot: `?quality=low|medium|high` wins, otherwise a
 * quick GPU probe (unmasked renderer string) picks a starting point. Everything
 * that costs frame time hangs off the resulting QualitySettings object.
 */

import { SHADOW_MAP_SIZE } from '../../../shared/tuning.js';

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  /** Per-cascade shadow map resolution. */
  shadowMapSize: number;
  ssao: boolean;
  ssaoSamples: number;
  ssaoRings: number;
  /** SSAO renders at this fraction of screen resolution (depth-aware upsampled). */
  ssaoResolutionScale: number;
  bloom: boolean;
  /** Device pixel ratio is clamped to this (never above 2). */
  maxPixelRatio: number;
  /** Real transmission on glass (extra transmissive render pass) vs. cheap alpha. */
  glassTransmission: boolean;
  /** Size of the reusable dynamic point-light pool. */
  dynamicLightCount: number;
}

const TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    shadowMapSize: Math.min(1024, SHADOW_MAP_SIZE),
    ssao: false,
    ssaoSamples: 8,
    ssaoRings: 7,
    ssaoResolutionScale: 0.5,
    bloom: false,
    maxPixelRatio: 1,
    glassTransmission: false,
    dynamicLightCount: 4,
  },
  medium: {
    tier: 'medium',
    shadowMapSize: SHADOW_MAP_SIZE,
    ssao: true,
    ssaoSamples: 9,
    ssaoRings: 7,
    ssaoResolutionScale: 0.5,
    bloom: true,
    maxPixelRatio: 1.5,
    glassTransmission: false,
    dynamicLightCount: 8,
  },
  high: {
    tier: 'high',
    shadowMapSize: SHADOW_MAP_SIZE,
    ssao: true,
    ssaoSamples: 16,
    ssaoRings: 7,
    ssaoResolutionScale: 0.5,
    bloom: true,
    maxPixelRatio: 2,
    glassTransmission: true,
    dynamicLightCount: 8,
  },
};

function isTier(v: string | null): v is QualityTier {
  return v === 'low' || v === 'medium' || v === 'high';
}

/** Reads the GPU renderer string, unmasked where the browser allows it. */
function gpuString(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext !== null) {
      return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    }
    return String(gl.getParameter(gl.RENDERER));
  } catch {
    return '';
  }
}

/** Heuristic starting tier from the GPU string. Overridden by `?quality=`. */
export function probeTier(gl: WebGLRenderingContext | WebGL2RenderingContext): QualityTier {
  const s = gpuString(gl).toLowerCase();
  if (/swiftshader|llvmpipe|software/.test(s)) return 'low';
  if (/mali|adreno|powervr|videocore|apple a\d/.test(s)) return 'low';
  if (/intel.*(hd graphics|uhd|iris)/.test(s)) return 'medium';
  if (/apple m\d|rtx|geforce|radeon|arc a|apple gpu/.test(s)) return 'high';
  return 'medium';
}

export function resolveQuality(gl: WebGLRenderingContext | WebGL2RenderingContext): QualitySettings {
  let tier: QualityTier;
  const param = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;
  if (isTier(param)) {
    tier = param;
  } else {
    tier = probeTier(gl);
  }
  return { ...TIERS[tier] };
}
