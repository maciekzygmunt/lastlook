import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DiffError, computeDiff } from '../src/diff.js';

// PR mode shells out to `gh`, resolved via PATH — so tests swap PATH for a dir
// holding a scripted fake (or, for the missing-gh case, only a git symlink).
const ORIGINAL_PATH = process.env.PATH ?? '';
const GIT_BIN = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const tmpdirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lastlook-pr-repo-')));
  tmpdirs.push(dir);
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'tracked.txt'), 'line 1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

/** Dir containing a fake `gh` script (plus a real-git symlink so computeDiff still works). */
function makeBinDir(ghScript?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lastlook-pr-bin-')));
  tmpdirs.push(dir);
  symlinkSync(GIT_BIN, join(dir, 'git'));
  if (ghScript !== undefined) {
    const path = join(dir, 'gh');
    writeFileSync(path, ghScript);
    chmodSync(path, 0o755);
  }
  return dir;
}

const FAKE_PATCH = `diff --git a/greeting.txt b/greeting.txt
index e965047..f9d1b64 100644
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1,2 @@
 hello
+world
diff --git a/docs/my file.txt b/docs/my file.txt
index e965047..f9d1b64 100644
--- a/docs/my file.txt
+++ b/docs/my file.txt
@@ -1 +1,2 @@
 hello
+world
diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
`;

const PR_TITLE = 'Add auth flow';

// Exactly two invocation shapes are allowed, both with no extra args: the
// identity lookup `gh pr view --json number,title`, which yields the number and
// title only, and `gh pr diff 42`, which fetches the patch by that pinned
// number. Nothing else — in particular the file list must come from the patch
// itself, never from a separate gh call that a mid-review push could race.
const WORKING_GH = `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "--json" ] && [ "$4" = "number,title" ] && [ $# -eq 4 ]; then
  echo '{"number":42,"title":"${PR_TITLE}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ] && [ "$3" = "42" ] && [ $# -eq 3 ]; then
  cat <<'PATCH'
${FAKE_PATCH}PATCH
  exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`;

// Serves the patch but fails the identity lookup: an explicit number must never
// consult it, so any test using this fixture proves explicit wins outright.
const EXPLICIT_ONLY_GH = `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "diff" ] && [ "$3" = "42" ] && [ $# -eq 3 ]; then
  cat <<'PATCH'
${FAKE_PATCH}PATCH
  exit 0
fi
echo "identity lookup must not run when a number was supplied: $*" >&2
exit 1
`;

const NO_PR_FOR_BRANCH_GH = `#!/bin/sh
echo 'no pull requests found for branch "feat/auth"' >&2
exit 1
`;

const UNAUTHENTICATED_GH = `#!/bin/sh
echo "To get started with GitHub CLI, please run:  gh auth login" >&2
exit 4
`;

const NO_SUCH_PR_GH = `#!/bin/sh
echo "GraphQL: Could not resolve to a PullRequest with the number of 42." >&2
exit 1
`;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
  tmpdirs.length = 0;
});

describe('computeDiff — pr', () => {
  it('returns the PR diff and file list from gh', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(WORKING_GH) + delimiter + ORIGINAL_PATH;

    const diff = await computeDiff(repo, 'pr', { pr: '42' });

    expect(diff.mode).toBe('pr');
    expect(diff.params).toEqual({ pr: '42' });
    expect(diff.patch).toBe(FAKE_PATCH);
    // parsed from the patch headers: plain, space-in-name, and renamed files
    expect(diff.files).toEqual([
      { path: 'greeting.txt', status: 'modified', changedLines: 1, digest: expect.any(String) },
      { path: 'docs/my file.txt', status: 'modified', changedLines: 1, digest: expect.any(String) },
      {
        path: 'renamed.txt',
        status: 'renamed',
        oldPath: 'old.txt',
        changedLines: 0,
        digest: expect.any(String),
      },
    ]);
    expect(diff.headSha).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('resolves the current branch PR when no number is supplied', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(WORKING_GH) + delimiter + ORIGINAL_PATH;

    const diff = await computeDiff(repo, 'pr', {});

    // the fake gh only serves `pr diff 42`, so the patch was fetched by the
    // resolved number rather than by implicit current-branch selection
    expect(diff.patch).toBe(FAKE_PATCH);
    expect(diff.params).toEqual({ pr: '42' });
    expect(diff.prTitle).toBe(PR_TITLE);
  });

  it('keeps the resolved title out of the echoed params', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(WORKING_GH) + delimiter + ORIGINAL_PATH;

    const detected = await computeDiff(repo, 'pr', {});
    const supplied = await computeDiff(repo, 'pr', { pr: '42' });

    expect(Object.keys(detected.params)).toEqual(['pr']);
    expect(supplied.params).toEqual({ pr: '42' });
  });

  it('leaves the title unset outside pr mode', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1 changed\n');

    expect((await computeDiff(repo, 'uncommitted')).prTitle).toBeUndefined();
  });

  it('uses an explicit number as-is, without the identity lookup', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(EXPLICIT_ONLY_GH) + delimiter + ORIGINAL_PATH;

    const diff = await computeDiff(repo, 'pr', { pr: '42' });

    expect(diff.params).toEqual({ pr: '42' });
    expect(diff.patch).toBe(FAKE_PATCH);
    expect(diff.prTitle).toBeUndefined();
  });

  it('fails with 400 and a pr-param message when pr is not a number', async () => {
    const repo = makeRepo();
    for (const params of [{ pr: 'abc' }, { pr: '-1' }]) {
      const err = await computeDiff(repo, 'pr', params).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiffError);
      expect((err as DiffError).status).toBe(400);
      expect((err as DiffError).message).toMatch(/pr/i);
    }
  });

  it('names the branch and points at Branch mode when it has no PR', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-qb', 'feat/auth');
    process.env.PATH = makeBinDir(NO_PR_FOR_BRANCH_GH) + delimiter + ORIGINAL_PATH;

    const err = await computeDiff(repo, 'pr', {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(400);
    expect((err as DiffError).message).toContain('feat/auth');
    expect((err as DiffError).message).toMatch(/branch mode/i);
  });

  it('names the detached state instead of a branch on a detached HEAD', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '--detach', 'HEAD');
    process.env.PATH = makeBinDir(NO_PR_FOR_BRANCH_GH) + delimiter + ORIGINAL_PATH;

    const err = await computeDiff(repo, 'pr', {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).status).toBe(400);
    expect((err as DiffError).message).toMatch(/detached/i);
    expect((err as DiffError).message).toMatch(/branch mode/i);
  });

  it('fails with install guidance when gh is not on PATH', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir();

    // both the supplied and the detected path go through gh, so both must guide
    for (const params of [{ pr: '42' }, {}]) {
      const err = await computeDiff(repo, 'pr', params).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiffError);
      expect((err as DiffError).message).toMatch(/install/i);
      expect((err as DiffError).message).toMatch(/cli\.github\.com/);
    }
  });

  it('fails with login guidance when gh is not authenticated', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(UNAUTHENTICATED_GH) + delimiter + ORIGINAL_PATH;

    for (const params of [{ pr: '42' }, {}]) {
      const err = await computeDiff(repo, 'pr', params).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiffError);
      expect((err as DiffError).message).toMatch(/gh auth login/);
    }
  });

  it('surfaces other gh failures (e.g. unknown PR) with their stderr', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(NO_SUCH_PR_GH) + delimiter + ORIGINAL_PATH;

    const err = await computeDiff(repo, 'pr', { pr: '42' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).message).toMatch(/Could not resolve/);
  });

  it('leaves the other modes working when gh is missing', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1 changed\n');
    process.env.PATH = makeBinDir();

    const diff = await computeDiff(repo, 'uncommitted');

    expect(diff.patch).toContain('+line 1 changed');
  });
});

describe('GET /api/diff?mode=pr', () => {
  function makeApp(repoPath: string) {
    return createApp({
      repoPath,
      version: '0.1.0',
      dataDir: join(tmpdir(), 'lastlook-unused-data'),
    });
  }

  it('passes the pr param through and echoes it', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(WORKING_GH) + delimiter + ORIGINAL_PATH;

    const res = await makeApp(repo).request('/api/diff?mode=pr&pr=42');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.params).toEqual({ pr: '42' });
    expect(body.patch).toBe(FAKE_PATCH);
  });

  it('resolves the current branch PR and echoes its number without a pr param', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(WORKING_GH) + delimiter + ORIGINAL_PATH;

    const res = await makeApp(repo).request('/api/diff?mode=pr');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.params).toEqual({ pr: '42' });
    expect(body.prTitle).toBe(PR_TITLE);
    expect(body.patch).toBe(FAKE_PATCH);
  });

  it('400s with a non-numeric pr number', async () => {
    const res = await makeApp(makeRepo()).request('/api/diff?mode=pr&pr=abc');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/pr/i);
  });

  it('400s naming the branch and Branch mode when the branch has no PR', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-qb', 'feat/auth');
    process.env.PATH = makeBinDir(NO_PR_FOR_BRANCH_GH) + delimiter + ORIGINAL_PATH;

    const res = await makeApp(repo).request('/api/diff?mode=pr');

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('feat/auth');
    expect(error).toMatch(/branch mode/i);
  });
});

describe('GET /api/diff/hash?mode=pr', () => {
  function makeApp(repoPath: string) {
    return createApp({
      repoPath,
      version: '0.1.0',
      dataDir: join(tmpdir(), 'lastlook-unused-data'),
    });
  }

  it('returns only the hash and headSha the full diff endpoint returns', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(WORKING_GH) + delimiter + ORIGINAL_PATH;
    const app = makeApp(repo);

    const res = await app.request('/api/diff/hash?mode=pr&pr=42');
    const full = (await (await app.request('/api/diff?mode=pr&pr=42')).json()) as Record<
      string,
      unknown
    >;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hash: full.hash, headSha: full.headSha });
  });

  it('400s without a pr number, matching the full diff endpoint', async () => {
    const app = makeApp(makeRepo());

    const res = await app.request('/api/diff/hash?mode=pr');
    const full = await app.request('/api/diff?mode=pr');

    expect(res.status).toBe(400);
    expect(res.status).toBe(full.status);
    expect(await res.json()).toEqual(await full.json());
  });
});
