import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';

/**
 * Spec §9 / ticket 18: `npm pack` + running the tarball's bin in a fresh repo
 * serves the full UI with no build step. Builds web + server for real, packs,
 * and runs the packed bin — slow (~30s), but it is the publish-readiness proof.
 */

const monorepoRoot = join(import.meta.dirname, '..', '..', '..');
const tmpdirs: string[] = [];
let server: ChildProcess | undefined;

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}

afterAll(() => {
  if (server && server.exitCode === null) server.kill('SIGKILL');
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
});

describe('npm pack → run in a fresh repo', () => {
  it('serves the bundled web UI from the tarball with no build step', { timeout: 240_000 }, async () => {
    // real builds: web first (server's prepack copies its dist into the package)
    execFileSync('npm', ['run', 'build', '-w', '@reviewd/web'], { cwd: monorepoRoot });

    const packDest = makeTmp('reviewd-pack-');
    const tarball = execFileSync(
      'npm',
      ['pack', '-w', '@reviewd/server', '--pack-destination', packDest],
      { cwd: monorepoRoot, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .at(-1)!;
    execFileSync('tar', ['-xzf', join(packDest, tarball)], { cwd: packDest });
    const packageDir = join(packDest, 'package');

    // no install step: the packed bin resolves deps from the monorepo's node_modules.
    // That symlink would mask an undeclared runtime dep (hoisted devDeps satisfy it
    // here but not for a real npx user), so first assert every bare import in the
    // packed JS is declared in dependencies.
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    for (const file of readdirSync(join(packageDir, 'dist')).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(join(packageDir, 'dist', file), 'utf8');
      // top-level statements only — a bare `from '…'` also appears inside string literals
      for (const match of source.matchAll(/(?:^|\n)(?:import|export)\b[^;'"]*?from\s+['"]([^'"\n]+)['"]/g)) {
        const spec = match[1]!;
        if (spec.startsWith('.') || spec.startsWith('node:') || builtinModules.includes(spec))
          continue;
        const dep = spec.split('/', spec.startsWith('@') ? 2 : 1).join('/');
        expect(declared, `${file} imports undeclared dependency ${spec}`).toContain(dep);
      }
    }
    // npm's global-bin link executes the file itself — without a shebang the
    // shell runs the JS as a shell script ("import: command not found")
    const cliSource = readFileSync(join(packageDir, 'dist', 'cli.js'), 'utf8');
    expect(cliSource.startsWith('#!/usr/bin/env node\n')).toBe(true);

    symlinkSync(join(monorepoRoot, 'node_modules'), join(packageDir, 'node_modules'), 'dir');

    const repo = makeTmp('reviewd-pack-repo-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const dataDir = makeTmp('reviewd-pack-data-');

    server = spawn(process.execPath, [join(packageDir, 'dist', 'cli.js')], {
      cwd: repo,
      env: { ...process.env, REVIEWD_DATA_DIR: dataDir, REVIEWD_BASE_PORT: '25900' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout!.on('data', (chunk) => (out += chunk));
    server.stderr!.on('data', (chunk) => (out += chunk));

    await waitFor(() => out.includes('http://'), 30_000).catch(() => {
      throw new Error(`server never started:\n${out}`);
    });
    const url = out.match(/http:\/\/\S+/)![0];

    const index = await fetch(url);
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('<div id="root">');

    // the hashed JS bundle referenced by index.html is served too
    const src = html.match(/src="([^"]+\.js)"/)![1];
    const asset = await fetch(`${url}${src}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');

    const health = (await (await fetch(`${url}/api/health`)).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);

    // the tarball itself carries the UI — belt and braces against a leaked workspace fallback
    const files = execFileSync('tar', ['-tzf', join(packDest, tarball)], { encoding: 'utf8' });
    expect(files).toContain('package/dist/web/index.html');
    expect(readFileSync(join(packageDir, 'dist', 'web', 'index.html'), 'utf8')).toContain('root');
  });
});
