import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DiffError, computeDiff, extractFilePatch } from '../src/diff.js';

const tmpdirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lastlook-diff-'));
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
    expect(diff.files).toEqual([{ path: 'tracked.txt', status: 'modified', changedLines: 2 }]);
    expect(diff.headSha).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('includes untracked files as all-addition patches without touching the index', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'brand-new.txt'), 'new line 1\nnew line 2\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.patch).toContain('diff --git a/brand-new.txt b/brand-new.txt');
    expect(diff.patch).toContain('--- /dev/null');
    expect(diff.patch).toContain('+new line 1');
    expect(diff.files).toEqual([{ path: 'brand-new.txt', status: 'added', changedLines: 2 }]);
    // index untouched: file is still untracked, nothing staged
    expect(git(repo, 'status', '--porcelain')).toContain('?? brand-new.txt');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('combines tracked changes and untracked files in one assembled patch', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    writeFileSync(join(repo, 'brand-new.txt'), 'hello\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files.map((f) => f.path)).toEqual(['tracked.txt', 'brand-new.txt']);
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
    expect(diff.files).toEqual([{ path: 'empty.txt', status: 'added', changedLines: 0 }]);
  });

  it('handles untracked files in subdirectories and with spaces in the name', async () => {
    const repo = makeCommittedRepo();
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'with space.txt'), 'spaced\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([{ path: 'sub/with space.txt', status: 'added', changedLines: 1 }]);
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
    expect(diff.files.map((f) => f.path)).toEqual(['second.txt', 'tracked.txt']);
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

describe('computeDiff — branch', () => {
  /** main with two commits, feature branched off the first with its own commit. */
  function makeBranchedRepo(): string {
    const repo = makeCommittedRepo();
    git(repo, 'branch', '-M', 'main');
    git(repo, 'checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 feature\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feature work');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'main-only.txt'), 'moved on\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'main moved on');
    git(repo, 'checkout', '-q', 'feature');
    return repo;
  }

  it('diffs HEAD against the merge-base with base, not against base itself', async () => {
    const repo = makeBranchedRepo();
    // worktree noise must not leak into branch mode
    writeFileSync(join(repo, 'noise.txt'), 'noise\n');

    const diff = await computeDiff(repo, 'branch', { base: 'main' });

    expect(diff.mode).toBe('branch');
    expect(diff.params).toEqual({ base: 'main' });
    expect(diff.patch).toContain('+line 2 feature');
    // a diff vs main's tip would show main-only.txt as deleted
    expect(diff.patch).not.toContain('main-only');
    expect(diff.patch).not.toContain('noise');
    expect(diff.files).toEqual([{ path: 'tracked.txt', status: 'modified', changedLines: 2 }]);
    expect(diff.headSha).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('fails with 400 when the base param is missing', async () => {
    const repo = makeBranchedRepo();

    const err = await computeDiff(repo, 'branch').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(400);
    expect((err as DiffError).message).toMatch(/base/i);
  });

  it('fails with 400 when the base branch does not exist', async () => {
    const repo = makeBranchedRepo();

    const err = await computeDiff(repo, 'branch', { base: 'no-such-branch' }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(400);
    expect((err as DiffError).message).toMatch(/no-such-branch/);
  });

  it('fails with 400 when base and HEAD share no history', async () => {
    const repo = makeBranchedRepo();
    git(repo, 'checkout', '-q', '--orphan', 'lonely');
    git(repo, 'commit', '-qm', 'orphan', '--allow-empty');
    git(repo, 'checkout', '-q', 'feature');

    const err = await computeDiff(repo, 'branch', { base: 'lonely' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(400);
    expect((err as DiffError).message).toMatch(/merge-base|unrelated/i);
  });

  it('GET /api/diff?mode=branch&base=… works and 400s without base', async () => {
    const repo = makeBranchedRepo();
    const app = createApp({
      repoPath: repo,
      version: '0.1.0',
      dataDir: join(tmpdir(), 'lastlook-unused-data'),
    });

    const ok = await app.request('/api/diff?mode=branch&base=main');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.mode).toBe('branch');
    expect(body.params).toEqual({ base: 'main' });
    expect(body.patch).toContain('+line 2 feature');

    const missing = await app.request('/api/diff?mode=branch');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/base/i);
  });
});

describe('computeDiff — file metadata', () => {
  it('classifies added, modified, and deleted files with changed-line counts', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'gone.txt'), 'to be deleted\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add gone.txt');
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    rmSync(join(repo, 'gone.txt'));
    writeFileSync(join(repo, 'brand-new.txt'), 'one\ntwo\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([
      { path: 'gone.txt', status: 'deleted', changedLines: 1 },
      { path: 'tracked.txt', status: 'modified', changedLines: 2 },
      { path: 'brand-new.txt', status: 'added', changedLines: 2 },
    ]);
  });

  it('reports a rename as the new path with oldPath and status renamed', async () => {
    const repo = makeCommittedRepo();
    git(repo, 'mv', 'tracked.txt', 'renamed.txt');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([
      { path: 'renamed.txt', status: 'renamed', oldPath: 'tracked.txt', changedLines: 0 },
    ]);
    expect(diff.patch).toContain('rename from tracked.txt');
    expect(diff.patch).toContain('rename to renamed.txt');
  });

  it('anchors a rename-with-edit to the new path and counts its changed lines', async () => {
    const repo = makeCommittedRepo();
    // enough unchanged lines that git's similarity detection still calls it a rename
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repo, 'notes.txt'), lines.join('\n') + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add notes');
    git(repo, 'mv', 'notes.txt', 'renamed.txt');
    writeFileSync(join(repo, 'renamed.txt'), ['edited', ...lines.slice(1)].join('\n') + '\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([
      { path: 'renamed.txt', status: 'renamed', oldPath: 'notes.txt', changedLines: 2 },
    ]);
  });

  it('flags a committed binary change with the new blob size', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 3]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add binary');
    const grown = Buffer.from([0, 1, 2, 3, 4, 5, 6]);
    writeFileSync(join(repo, 'pic.bin'), grown);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'grow binary');

    const diff = await computeDiff(repo, 'last-commit');

    expect(diff.files).toEqual([
      { path: 'pic.bin', status: 'modified', binary: true, size: grown.length, changedLines: 0 },
    ]);
    expect(diff.patch).toContain('Binary files a/pic.bin and b/pic.bin differ');
  });

  it('flags a worktree binary change and an untracked binary, sized from disk', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 3]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add binary');
    const edited = Buffer.from([0, 1, 2, 3, 4]);
    writeFileSync(join(repo, 'pic.bin'), edited);
    const fresh = Buffer.from([0, 9, 8, 7, 6, 5]);
    writeFileSync(join(repo, 'fresh.bin'), fresh);

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([
      { path: 'pic.bin', status: 'modified', binary: true, size: edited.length, changedLines: 0 },
      { path: 'fresh.bin', status: 'added', binary: true, size: fresh.length, changedLines: 0 },
    ]);
  });
});

describe('computeDiff — large diffs (spec §6.4)', () => {
  const LIMITS = { maxPatchBytes: 15 * 1024 * 1024, stubChangedLines: 5 };

  it('stubs files over the changed-line threshold and omits them from visiblePatch', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    const big = Array.from({ length: 40 }, (_, i) => `generated line ${i}`).join('\n') + '\n';
    writeFileSync(join(repo, 'big.txt'), big);

    const diff = await computeDiff(repo, 'uncommitted', {}, LIMITS);

    expect(diff.files).toEqual([
      { path: 'tracked.txt', status: 'modified', changedLines: 2 },
      { path: 'big.txt', status: 'added', changedLines: 40, stub: true },
    ]);
    expect(diff.patch).toContain('+generated line 0');
    expect(diff.visiblePatch).toContain('+line 2 changed');
    expect(diff.visiblePatch).not.toContain('generated line');
  });

  it('stubs lockfile-pattern files regardless of size', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'package-lock.json'), '{\n  "version": 1\n}\n');

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.files).toEqual([
      { path: 'package-lock.json', status: 'added', changedLines: 3, stub: true },
    ]);
    expect(diff.visiblePatch).toBe('');
    expect(diff.patch).toContain('"version": 1');
  });

  it('hashes the full patch, not the stubbed response patch', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'package-lock.json'), '{}\n');

    const withStub = await computeDiff(repo, 'uncommitted');
    const { createHash } = await import('node:crypto');
    expect(withStub.hash).toBe(createHash('sha256').update(withStub.patch).digest('hex'));
    expect(withStub.visiblePatch).not.toBe(withStub.patch);
  });

  it('rejects a patch over maxPatchBytes with 413 and narrowing guidance', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2000) + '\n');

    const err = await computeDiff(repo, 'uncommitted', {}, {
      maxPatchBytes: 1024,
      stubChangedLines: 3000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(413);
    expect((err as DiffError).message).toMatch(/narrow/i);
  });
});

describe('extractFilePatch', () => {
  it('returns one file’s full segment, including stubbed files, and null for unknown paths', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    writeFileSync(join(repo, 'package-lock.json'), '{\n  "version": 1\n}\n');

    const diff = await computeDiff(repo, 'uncommitted');

    const segment = extractFilePatch(diff.patch, 'package-lock.json');
    expect(segment).toContain('diff --git a/package-lock.json b/package-lock.json');
    expect(segment).toContain('"version": 1');
    expect(segment).not.toContain('tracked.txt');
    expect(extractFilePatch(diff.patch, 'no-such.txt')).toBeNull();
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
    // dataDir is never written here — Store touches disk only on comment mutations
    return createApp({ repoPath, version: '0.1.0', dataDir: join(tmpdir(), 'lastlook-unused-data') });
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
    expect((body.files as { path: string }[]).map((f) => f.path)).toEqual(['tracked.txt', 'brand-new.txt']);
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

  it('returns stub files as metadata only, with their patch content withheld', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    writeFileSync(join(repo, 'package-lock.json'), '{\n  "version": 1\n}\n');

    const res = await makeApp(repo).request('/api/diff?mode=uncommitted');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { patch: string; files: Record<string, unknown>[] };
    expect(body.patch).toContain('+line 2 changed');
    expect(body.patch).not.toContain('"version": 1');
    expect(body.files).toEqual([
      { path: 'tracked.txt', status: 'modified', changedLines: 2 },
      { path: 'package-lock.json', status: 'added', changedLines: 3, stub: true },
    ]);
  });

  it('surfaces the 413 size cap through the API', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2000) + '\n');
    const app = createApp({
      repoPath: repo,
      version: '0.1.0',
      dataDir: join(tmpdir(), 'lastlook-unused-data'),
      limits: { maxPatchBytes: 1024, stubChangedLines: 3000 },
    });

    const res = await app.request('/api/diff?mode=uncommitted');

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/narrow/i);
  });
});

describe('GET /api/diff/hash', () => {
  function makeApp(repoPath: string) {
    return createApp({ repoPath, version: '0.1.0', dataDir: join(tmpdir(), 'lastlook-unused-data') });
  }

  it('returns only hash and headSha, equal to the full diff endpoint’s, for the local modes', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'second');
    writeFileSync(join(repo, 'brand-new.txt'), 'hello\n');
    const app = makeApp(repo);

    for (const mode of ['uncommitted', 'last-commit']) {
      const res = await app.request(`/api/diff/hash?mode=${mode}`);
      const full = (await (await app.request(`/api/diff?mode=${mode}`)).json()) as Record<
        string,
        unknown
      >;

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hash: full.hash, headSha: full.headSha });
    }
  });

  it('takes branch mode’s base param, and 400s without it exactly as the full diff endpoint does', async () => {
    const repo = makeCommittedRepo();
    git(repo, 'branch', '-M', 'main');
    git(repo, 'checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 feature\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feature work');
    const app = makeApp(repo);

    const res = await app.request('/api/diff/hash?mode=branch&base=main');
    const full = (await (await app.request('/api/diff?mode=branch&base=main')).json()) as Record<
      string,
      unknown
    >;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hash: full.hash, headSha: full.headSha });

    const missing = await app.request('/api/diff/hash?mode=branch');
    const missingFull = await app.request('/api/diff?mode=branch');
    expect(missing.status).toBe(400);
    expect(missing.status).toBe(missingFull.status);
    expect(await missing.json()).toEqual(await missingFull.json());

    const badBase = await app.request('/api/diff/hash?mode=branch&base=no-such-branch');
    const badBaseFull = await app.request('/api/diff?mode=branch&base=no-such-branch');
    expect(badBase.status).toBe(badBaseFull.status);
    expect(await badBase.json()).toEqual(await badBaseFull.json());
  });

  it('is stable while the diff is unchanged and changes when the diff moves', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed\n');
    const app = makeApp(repo);
    const hash = async () =>
      ((await (await app.request('/api/diff/hash?mode=uncommitted')).json()) as { hash: string })
        .hash;

    const first = await hash();
    expect(await hash()).toBe(first);

    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 changed again\n');
    expect(await hash()).not.toBe(first);
  });

  it('rejects a missing or unknown mode with the full diff endpoint’s 400 and message', async () => {
    const app = makeApp(makeCommittedRepo());

    for (const query of ['', '?mode=sideways']) {
      const res = await app.request(`/api/diff/hash${query}`);
      const full = await app.request(`/api/diff${query}`);

      expect(res.status).toBe(400);
      expect(res.status).toBe(full.status);
      expect(await res.json()).toEqual(await full.json());
    }
  });

  it('surfaces the 413 size cap the same way the full diff endpoint does', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2000) + '\n');
    const app = createApp({
      repoPath: repo,
      version: '0.1.0',
      dataDir: join(tmpdir(), 'lastlook-unused-data'),
      limits: { maxPatchBytes: 1024, stubChangedLines: 3000 },
    });

    const res = await app.request('/api/diff/hash?mode=uncommitted');
    const full = await app.request('/api/diff?mode=uncommitted');

    expect(res.status).toBe(413);
    expect(res.status).toBe(full.status);
    expect(await res.json()).toEqual(await full.json());
  });
});

describe('GET /api/diff/file', () => {
  function makeApp(repoPath: string) {
    return createApp({ repoPath, version: '0.1.0', dataDir: join(tmpdir(), 'lastlook-unused-data') });
  }

  it('returns one file’s full segment on demand, stub or not', async () => {
    const repo = makeCommittedRepo();
    writeFileSync(join(repo, 'package-lock.json'), '{\n  "version": 1\n}\n');

    const res = await makeApp(repo).request(
      '/api/diff/file?mode=uncommitted&path=package-lock.json'
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; patch: string };
    expect(body.path).toBe('package-lock.json');
    expect(body.patch).toContain('+  "version": 1');
  });

  it('404s for a path not in the current diff and 400s without a path', async () => {
    const repo = makeCommittedRepo();

    const missing = await makeApp(repo).request('/api/diff/file?mode=uncommitted&path=nope.txt');
    expect(missing.status).toBe(404);

    const noPath = await makeApp(repo).request('/api/diff/file?mode=uncommitted');
    expect(noPath.status).toBe(400);
    expect(((await noPath.json()) as { error: string }).error).toMatch(/path/i);
  });
});
