/**
 * DECKSHOT — server entry point.
 *
 * One process, one port: this serves the built client AND the game WebSocket on
 * the same listener. That is the whole reason a single invite link works with
 * nothing to configure — the client derives `ws(s)://<same host>/ws` from
 * `window.location`, so localhost and a Fly.io domain behave identically.
 *
 * In development the client is served by Vite on :5173, which proxies `/ws`
 * here; the static branch below simply finds no build directory and serves the
 * health endpoint only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGameServer, DEFAULT_PORT, WS_PATH } from './net/index.js';

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);

// dist/server/src/index.js -> dist/public
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(HERE, '../../public');
const HAS_BUILD = existsSync(PUBLIC_DIR);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const startedAt = Date.now();

const httpServer = createServer(handleRequest);
const game = createGameServer(httpServer);

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    const stats = game.stats();
    return json(res, 200, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      ...stats,
    });
  }

  if (!HAS_BUILD) {
    // Dev: Vite owns the client. Anything else reaching here is a mistake.
    return json(res, 404, {
      error: 'No client build present.',
      hint: 'Run `npm run dev` (Vite serves the client on :5173 and proxies /ws here), or `npm run build` first.',
    });
  }

  serveStatic(url.pathname, res);
}

function serveStatic(pathname: string, res: ServerResponse): void {
  // Resolve inside PUBLIC_DIR and verify containment — a naive join lets
  // `/../../etc/passwd` escape the served directory.
  const decoded = safeDecode(pathname);
  if (decoded === null) return json(res, 400, { error: 'Bad path' });

  const candidate = resolve(join(PUBLIC_DIR, normalize(decoded)));
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + sep)) {
    return json(res, 403, { error: 'Forbidden' });
  }

  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: every unknown route is the game (this is what makes
    // /?lobby=K7QX work on a hard refresh).
    file = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(file)) return json(res, 404, { error: 'Not found' });
  }

  const ext = extname(file).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';

  // Hashed asset filenames are immutable; index.html must never be cached or
  // players get a stale client against a newer protocol version.
  const cache = file.endsWith('index.html')
    ? 'no-cache'
    : ext === '.html'
      ? 'no-cache'
      : 'public, max-age=31536000, immutable';

  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  createReadStream(file)
    .on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}

function safeDecode(p: string): string | null {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

httpServer.listen(PORT, () => {
  const mode = HAS_BUILD ? 'production (serving dist/public)' : 'development (Vite serves the client)';
  console.log(`[deckshot] listening on :${PORT} — ${mode}`);
  console.log(`[deckshot] websocket path ${WS_PATH}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[deckshot] ${signal} received, shutting down`);
  // Close the game first so players get a clean disconnect rather than a
  // dropped socket they will try to reconnect to.
  await game.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
