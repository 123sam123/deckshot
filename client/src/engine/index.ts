/**
 * DECKSHOT engine — public surface.
 *
 * Contract for every other agent:
 *   - `new Renderer(canvas)` once; nobody else creates a WebGLRenderer,
 *     composer, or camera.
 *   - Add world objects to `renderer.scene`, gun meshes to
 *     `renderer.viewmodelScene`, drive `renderer.camera`'s pose.
 *   - Use `Materials.get(SurfaceMaterial.X)` for all brush surfaces — shared
 *     instances, never cloned, so draw calls batch.
 */

export { Renderer } from './renderer.js';
export { Materials, configureMaterials, type MaterialRegistry } from './materials.js';
export { resolveQuality, type QualitySettings, type QualityTier } from './quality.js';
export { SkyDome, computeSunDirection, SUN_AZIMUTH, SUN_ELEVATION } from './sky.js';
