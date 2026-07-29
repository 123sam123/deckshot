/**
 * Perf overlay — only exists when the URL contains `?debug=perf`.
 *
 * When the flag is absent, `PerfOverlay.create` returns null and the renderer
 * holds a null; the per-frame cost is a single null check. When present:
 * CPU frame time (performance.now around the render), GPU frame time via
 * EXT_disjoint_timer_query_webgl2 where the driver exposes it, plus draw
 * calls, triangles, program count and GPU memory counters from renderer.info.
 */

import type * as THREE from 'three';

const UPDATE_INTERVAL_MS = 300;
const MAX_QUERIES_IN_FLIGHT = 8;

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

function ema(prev: number, next: number, alpha = 0.1): number {
  return prev === 0 ? next : prev + (next - prev) * alpha;
}

export class PerfOverlay {
  /** Returns null unless the URL has `?debug=perf`. */
  static create(renderer: THREE.WebGLRenderer, tierLabel: string): PerfOverlay | null {
    if (typeof location === 'undefined') return null;
    if (new URLSearchParams(location.search).get('debug') !== 'perf') return null;
    return new PerfOverlay(renderer, tierLabel);
  }

  private readonly renderer: THREE.WebGLRenderer;
  private readonly root: HTMLDivElement;
  private readonly gl: WebGL2RenderingContext | null = null;
  private readonly timerExt: TimerExt | null = null;
  private readonly pending: WebGLQuery[] = [];
  private queryActive = false;

  private frameStart = 0;
  private lastFrameAt = 0;
  private cpuMs = 0;
  private gpuMs = 0;
  private fps = 0;
  private lastDomUpdate = 0;
  private readonly tierLabel: string;

  private constructor(renderer: THREE.WebGLRenderer, tierLabel: string) {
    this.renderer = renderer;
    this.tierLabel = tierLabel;

    const ctx = renderer.getContext();
    if (ctx instanceof WebGL2RenderingContext) {
      this.gl = ctx;
      this.timerExt = ctx.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    }

    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:99999',
      'padding:8px 10px',
      'background:rgba(5,8,13,0.78)',
      'color:#9fe8a9',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'border:1px solid rgba(120,200,140,0.25)',
      'border-radius:6px',
      'pointer-events:none',
      'white-space:pre',
    ].join(';');
    this.root.textContent = 'perf…';
    document.body.appendChild(this.root);
  }

  /** Call immediately before the frame's rendering work. */
  beginFrame(): void {
    const now = performance.now();
    if (this.lastFrameAt > 0) {
      const frameDt = now - this.lastFrameAt;
      if (frameDt > 0) this.fps = ema(this.fps, 1000 / frameDt, 0.08);
    }
    this.lastFrameAt = now;
    this.frameStart = now;

    if (this.gl !== null && this.timerExt !== null && !this.queryActive && this.pending.length < MAX_QUERIES_IN_FLIGHT) {
      const q = this.gl.createQuery();
      if (q !== null) {
        this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
        this.pending.push(q);
        this.queryActive = true;
      }
    }
  }

  /** Call immediately after the frame's rendering work. */
  endFrame(): void {
    const gl = this.gl;
    if (gl !== null && this.timerExt !== null && this.queryActive) {
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      this.queryActive = false;
    }
    this.cpuMs = ema(this.cpuMs, performance.now() - this.frameStart);
    this.pollQueries();
    this.updateDom();
  }

  private pollQueries(): void {
    const gl = this.gl;
    const ext = this.timerExt;
    if (gl === null || ext === null) return;
    while (this.pending.length > 0) {
      const q = this.pending[0];
      const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!available) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        this.gpuMs = ema(this.gpuMs, ns / 1e6);
      }
      gl.deleteQuery(q);
      this.pending.shift();
    }
  }

  private updateDom(): void {
    const now = performance.now();
    if (now - this.lastDomUpdate < UPDATE_INTERVAL_MS) return;
    this.lastDomUpdate = now;
    const info = this.renderer.info;
    const gpu = this.timerExt !== null ? `${this.gpuMs.toFixed(2)} ms` : 'n/a';
    this.root.textContent =
      `fps      ${this.fps.toFixed(0)}\n` +
      `cpu      ${this.cpuMs.toFixed(2)} ms\n` +
      `gpu      ${gpu}\n` +
      `calls    ${info.render.calls}\n` +
      `tris     ${info.render.triangles.toLocaleString()}\n` +
      `programs ${info.programs !== null ? info.programs.length : 0}\n` +
      `geoms    ${info.memory.geometries}  tex ${info.memory.textures}\n` +
      `quality  ${this.tierLabel}`;
  }

  dispose(): void {
    this.root.remove();
    const gl = this.gl;
    if (gl !== null) {
      if (this.queryActive && this.timerExt !== null) gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      for (const q of this.pending) gl.deleteQuery(q);
    }
    this.pending.length = 0;
  }
}
