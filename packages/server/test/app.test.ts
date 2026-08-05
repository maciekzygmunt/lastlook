import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const tmpdirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lastlook-health-'));
  tmpdirs.push(dir);
  git(dir, 'init', '-q');
  return dir;
}

function health(repoPath: string) {
  return createApp({
    repoPath,
    version: '0.1.0',
    dataDir: join(tmpdir(), 'lastlook-unused-data'),
  }).request('/api/health');
}

afterEach(() => {
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
  tmpdirs.length = 0;
});

describe('GET /api/health', () => {
  it('returns liveness plus repoPath, version and defaultBase', async () => {
    const res = await health('/tmp/some-repo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      repoPath: '/tmp/some-repo',
      version: '0.1.0',
      defaultBase: 'main',
    });
  });

  it('reports the remote-tracking ref origin/HEAD points at', async () => {
    const repo = makeRepo();
    // `git remote set-head origin -a` writes exactly this ref, without the network
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

    const body = (await (await health(repo)).json()) as { defaultBase: string };

    expect(body.defaultBase).toBe('origin/trunk');
  });

  it('falls back to main when the repository has no remote', async () => {
    const body = (await (await health(makeRepo())).json()) as { defaultBase: string };

    expect(body.defaultBase).toBe('main');
  });

  it('falls back to main when origin exists but origin/HEAD is unset', async () => {
    const repo = makeRepo();
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');

    const body = (await (await health(repo)).json()) as { defaultBase: string };

    expect(body.defaultBase).toBe('main');
  });
});
