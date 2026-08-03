import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reviewd-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>reviewd</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(join(dir, 'assets', 'index-abc123.css'), '.app{}');
  return dir;
}

const dist = makeDist();
afterAll(() => rmSync(dist, { recursive: true, force: true }));

function makeApp(webDistDir?: string) {
  // dataDir is never written here — Store touches disk only on comment mutations
  const dataDir = join(tmpdir(), 'reviewd-unused-data');
  return createApp({ repoPath: '/tmp/some-repo', version: '0.1.0', dataDir, webDistDir });
}

describe('static web UI serving', () => {
  it('serves index.html at /', async () => {
    const res = await makeApp(dist).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('reviewd');
  });

  it('serves assets with their content types', async () => {
    const app = makeApp(dist);
    const js = await app.request('/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    const css = await app.request('/assets/index-abc123.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('falls back to index.html for unknown paths (SPA)', async () => {
    const res = await makeApp(dist).request('/some/client/route');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('does not escape the dist directory', async () => {
    const res = await makeApp(dist).request('/..%2f..%2fetc%2fpasswd');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('leaves /api routes to the API', async () => {
    const res = await makeApp(dist).request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('explains when the UI is not built', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'reviewd-empty-'));
    try {
      const res = await makeApp(empty).request('/');
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('not built');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('serves nothing without a webDistDir', async () => {
    const res = await makeApp(undefined).request('/');
    expect(res.status).toBe(404);
  });
});
