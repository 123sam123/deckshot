import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Client build. Output lands in dist/public, which the Node server serves
 * statically alongside the WebSocket endpoint — one port, one URL, one link
 * to send a friend.
 */
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      // In dev the game server runs separately; proxy the socket to it so the
      // client's location-derived URL works unchanged in dev and prod.
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  worker: {
    format: 'es',
  },
});
