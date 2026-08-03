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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewd-pr-repo-')));
  tmpdirs.push(dir);
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'tracked.txt'), 'line 1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

/** Dir containing a fake `gh` script (plus a real-git symlink so computeDiff still works). */
function makeBinDir(ghScript?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewd-pr-bin-')));
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

// Exactly one invocation shape is allowed: `gh pr diff 42` with no extra args —
// the file list must come from the patch itself, not a second racy gh call
const WORKING_GH = `#!/bin/sh
if [ "$1" != "pr" ] || [ "$2" != "diff" ] || [ "$3" != "42" ] || [ $# -ne 3 ]; then
  echo "unexpected args: $*" >&2
  exit 1
fi
cat <<'PATCH'
${FAKE_PATCH}PATCH
`.replace('${FAKE_PATCH}', FAKE_PATCH);

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
      { path: 'greeting.txt' },
      { path: 'docs/my file.txt' },
      { path: 'renamed.txt' },
    ]);
    expect(diff.headSha).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('fails with 400 and a pr-param message when pr is missing or not a number', async () => {
    const repo = makeRepo();
    for (const params of [{}, { pr: 'abc' }, { pr: '-1' }]) {
      const err = await computeDiff(repo, 'pr', params).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiffError);
      expect((err as DiffError).status).toBe(400);
      expect((err as DiffError).message).toMatch(/pr/i);
    }
  });

  it('fails with install guidance when gh is not on PATH', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir();

    const err = await computeDiff(repo, 'pr', { pr: '42' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).message).toMatch(/install/i);
    expect((err as DiffError).message).toMatch(/cli\.github\.com/);
  });

  it('fails with login guidance when gh is not authenticated', async () => {
    const repo = makeRepo();
    process.env.PATH = makeBinDir(UNAUTHENTICATED_GH) + delimiter + ORIGINAL_PATH;

    const err = await computeDiff(repo, 'pr', { pr: '42' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiffError);
    expect((err as DiffError).message).toMatch(/gh auth login/);
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
      dataDir: join(tmpdir(), 'reviewd-unused-data'),
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

  it('400s without a pr number', async () => {
    const res = await makeApp(makeRepo()).request('/api/diff?mode=pr');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/pr/i);
  });
});
