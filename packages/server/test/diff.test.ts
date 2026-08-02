import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DiffError, computeDiff } from '../src/diff.js';

const tmpdirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reviewd-diff-'));
  tmpdirs.push(dir);
  git(dir, 'init', '-q');
  return realpathSync(dir);
}

/** Repo with one commit containing tracked.txt */
function makeCommittedRepo(): string {
  const repo = makeRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return repo;
}

afterEach(() => {
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
  tmpdirs.length = 0;
});

describe('computeDiff — uncommitted', () => {
  it('returns tracked worktree changes vs HEAD with a files listing', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.mode).toBe('uncommitted');
    expect(diff.params).toEqual({});
    expect(diff.patch).toContain('diff --git a/tracked.txt b/tracked.txt');
    expect(diff.patch).toContain('+line 2 changed');
    expect(diff.files).toEqual([{ path: 'tracked.txt' }]);
    expect(diff.headSha).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('includes untracked files as all-addition patches without touching the index', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'brand-new.txt'), 'new line 1\nnew line 2\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.patch).toContain('diff --git a/brand-new.txt b/brand-new.txt');
    expect(diff.patch).toContain('--- /dev/null');
    expect(diff.patch).toContain('+new line 1');
    expect(diff.files).toEqual([{ path: 'brand-new.txt' }]);
    // index untouched: file is still untracked, nothing staged
    expect(git(repo, 'status', '--porcelain')).toContain('?? brand-new.txt');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('combines tracked changes and untracked files in one assembled patch', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    writeFileSync(join(repo, 'brand-new.txt'), 'hello\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([{ path: 'tracked.txt' }, { path: 'brand-new.txt' }]);
    expect(diff.patch).toContain('a/tracked.txt');
    expect(diff.patch).toContain('a/brand-new.txt');
  });

  it('skips ignored files', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, '.gitignore'), 'ignored.log\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add gitignore');
    writeFileSync(join(repo, 'ignored.log'), 'noise\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.patch).toBe('');
    expect(diff.files).toEqual([]);
  });

  it('includes an empty untracked file as a header-only patch', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'empty.txt'), '');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.patch).toContain('diff --git a/empty.txt b/empty.txt');
    expect(diff.patch).toContain('new file mode');
    expect(diff.files).toEqual([{ path: 'empty.txt' }]);
  });

  it('handles untracked files in subdirectories and with spaces in the name', async () => {
    const repo = makeCommittedRepo();
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'with space.txt'), 'spaced\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([{ path: 'sub/with space.txt' }]);
    expect(diff.patch).toContain('+spaced');
  });

  it('returns an empty patch and files for a clean tree', async () => {
    const repo = makeCommittedRepo();

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.patch).toBe('');
    expect(diff.files).toEqual([]);
    expect(diff.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeDiff — last-commit', () => {
  it('returns HEAD vs HEAD~1', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 amended\n');
    writeFileSync(join(repo, 'second.txt'), 'second\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'second');
    // worktree noise must not leak into last-commit mode
    writeFileSync(join(repo, 'noise.txt'), 'noise\n');

    const diff = await computeDiff(repo, 'last-commit');

    expect(diff.mode).toBe('last-commit');
    expect(diff.files).toEqual([{ path: 'second.txt' }, { path: 'tracked.txt' }]);
    expect(diff.patch).toContain('+line 2 amended');
    expect(diff.patch).toContain('+second');
    expect(diff.patch).not.toContain('noise');
    expect(diff.headSha).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('fails with a 4xx DiffError when HEAD has no parent', async () => {
    const repo = makeCommittedRepo();

    const err = await computeDiff(repo, 'last-commit').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(400);
    expect((err as DiffError).message).toMatch(/parent|commit/i);
  });
});

describe('computeDiff — hash', () => {
  it('is stable for the same tree and changes when the diff changes', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');

    const first = await computeDiff(repo, 'uncommitted');
    const second = await computeDiff(repo, 'uncommitted');
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed again\n');
    const third = await computeDiff(repo, 'uncommitted');
    expect(third.hash).not.toBe(first.hash);
  });
});

describe('computeDiff — errors', () => {
  it('fails with a 4xx DiffError in a repo with no commits', async () => {
    const repo = makeRepo();

    const err = await computeDiff(repo, 'uncommitted').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(400);
    expect((err as DiffError).message).toMatch(/commit/i);
  });
});

describe('GET /api/diff', () => {
  function makeApp(repoPath: string) {
    return createApp({ repoPath, version: '0.1.0' });
  }

  it('returns the full response shape for mode=uncommitted, reflecting an edit and a new file', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    writeFileSync(join(repo, 'brand-new.txt'), 'hello\n');

    const res = await makeApp(repo).request('/api/diff?mode=uncommitted');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe('uncommitted');
    expect(body.params).toEqual({});
    expect(typeof body.hash).toBe('string');
    expect(typeof body.headSha).toBe('string');
    expect(body.patch).toContain('+line 2 changed');
    expect(body.patch).toContain('+hello');
    expect(body.files).toEqual([{ path: 'tracked.txt' }, { path: 'brand-new.txt' }]);
  });

  it('returns mode=last-commit', async () => {
    const repo = makeCommittedRepo();

    const res = await makeApp(repo).request('/api/diff?mode=last-commit');

    // single-commit repo: surfaced as a clear 400, not a crash
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
  });

  it('rejects a missing mode with 400', async () => {
    const res = await makeApp(makeCommittedRepo()).request('/api/diff');
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/mode/i);
  });

  it('rejects an unknown mode with 400', async () => {
    const res = await makeApp(makeCommittedRepo()).request('/api/diff?mode=sideways');
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/mode/i);
  });
});
