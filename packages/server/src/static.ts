import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Context, Hono } from 'hono';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

async function serveFile(c: Context, path: string): Promise<Response | null> {
  try {
    const body = await readFile(path);
    const type = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
    return c.body(new Uint8Array(body), 200, { 'Content-Type': type });
  } catch {
    return null;
  }
}

/** Serve the prebuilt web UI from `distDir`; unknown paths fall back to index.html (SPA). */
export function mountWebUi(app: Hono, distDir: string): void {
  const root = resolve(distDir);

  app.get('*', async (c) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      // malformed escape sequence — treat as the SPA root
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) return c.notFound();
    const requested = normalize(join(root, pathname));
    if (requested.startsWith(root + sep)) {
      const file = await serveFile(c, requested);
      if (file) return file;
    }
    const index = await serveFile(c, join(root, 'index.html'));
    if (index) return index;
    return c.text('reviewd web UI is not built — run `npm run build` in packages/web', 503);
  });
}
