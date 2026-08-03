import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Spec §6.4 caps the assembled patch at ~15 MB; leave headroom before enforcement lands (ticket 16)
const MAX_BUFFER = 64 * 1024 * 1024;

export const DIFF_MODES = ['uncommitted', 'branch', 'pr', 'last-commit'] as const;
export type DiffMode = (typeof DIFF_MODES)[number];

/** Mode-specific inputs (spec §3): `base` for branch mode, `pr` for pr mode. */
export interface DiffParams {
  base?: string;
  pr?: string;
}

export interface DiffFile {
  path: string;
}

interface RawDiff {
  patch: string;
  files: DiffFile[];
}

export interface DiffResult {
  mode: DiffMode;
  params: Record<string, string>;
  hash: string;
  headSha: string;
  patch: string;
  files: DiffFile[];
}

export class DiffError extends Error {
  // 409 (hash drift) and 413 (size cap) join in later tickets — spec §5
  constructor(
    readonly status: 400 | 409 | 413,
    message: string
  ) {
    super(message);
    this.name = 'DiffError';
  }
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

async function revParse(repoPath: string, rev: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['rev-parse', '--verify', '--quiet', rev])).trim();
  } catch {
    return null;
  }
}

/** `git diff --no-index` exits 1 when the files differ; that's the expected success path. */
async function synthesizeUntracked(repoPath: string, file: string): Promise<string> {
  try {
    return await git(repoPath, ['diff', '--no-index', '--', '/dev/null', file]);
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout;
    throw error;
  }
}

async function listUntracked(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean).sort();
}

async function rangeDiff(repoPath: string, range: string[]): Promise<RawDiff> {
  const patch = await git(repoPath, ['diff', ...range]);
  const names = await git(repoPath, ['diff', ...range, '--name-only', '-z']);
  return { patch, files: names.split('\0').filter(Boolean).map((path) => ({ path })) };
}

async function uncommittedDiff(repoPath: string): Promise<RawDiff> {
  const { patch, files } = await rangeDiff(repoPath, ['HEAD']);

  const parts = [patch];
  for (const path of await listUntracked(repoPath)) {
    parts.push(await synthesizeUntracked(repoPath, path));
    files.push({ path });
  }

  return { patch: parts.join(''), files };
}

async function lastCommitDiff(repoPath: string): Promise<RawDiff> {
  if ((await revParse(repoPath, 'HEAD~1')) === null) {
    throw new DiffError(400, 'last-commit mode needs a parent commit; HEAD is the only commit');
  }
  return rangeDiff(repoPath, ['HEAD~1', 'HEAD']);
}

async function branchDiff(repoPath: string, base: string | undefined): Promise<RawDiff> {
  if (!base) {
    throw new DiffError(400, 'branch mode needs a base param — the branch to diff against');
  }
  if ((await revParse(repoPath, base)) === null) {
    throw new DiffError(400, `base branch "${base}" not found in this repository`);
  }
  let mergeBase: string;
  try {
    mergeBase = (await git(repoPath, ['merge-base', base, 'HEAD'])).trim();
  } catch {
    throw new DiffError(400, `no merge-base between "${base}" and HEAD — unrelated histories`);
  }
  return rangeDiff(repoPath, [mergeBase, 'HEAD']);
}

/** Shell out to the GitHub CLI, mapping missing/unauthenticated gh to actionable errors (spec §9). */
async function gh(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new DiffError(
        400,
        'PR mode needs the GitHub CLI — install gh (https://cli.github.com), then run `gh auth login`'
      );
    }
    const stderr = (e.stderr ?? '').trim();
    // gh prints this exact instruction when unauthenticated; matching anything
    // looser (e.g. "authentication") would relabel unrelated failures
    if (/gh auth login/i.test(stderr)) {
      throw new DiffError(400, 'GitHub CLI is not authenticated — run `gh auth login`');
    }
    throw new DiffError(400, `gh failed: ${stderr || e.message}`);
  }
}

/**
 * Paths from `diff --git` headers, so files[] always matches the patch it came
 * with — a second gh call for `--name-only` could race a push to the PR.
 * git doesn't quote spaces in this header; the midpoint split disambiguates the
 * common unrenamed case, with a last-` b/` fallback for renames.
 */
function filesFromPatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const rest = line.slice('diff --git '.length);
    const quoted = /^"a\/(.*)" "b\/(.*)"$/.exec(rest);
    if (quoted?.[2] !== undefined) {
      files.push({ path: quoted[2] });
      continue;
    }
    if (rest.length % 2 === 1) {
      const mid = (rest.length - 1) / 2;
      const oldSide = rest.slice(0, mid);
      const newSide = rest.slice(mid + 1);
      if (
        oldSide.startsWith('a/') &&
        newSide.startsWith('b/') &&
        oldSide.slice(2) === newSide.slice(2)
      ) {
        files.push({ path: newSide.slice(2) });
        continue;
      }
    }
    const idx = rest.lastIndexOf(' b/');
    if (idx !== -1) files.push({ path: rest.slice(idx + 3) });
  }
  return files;
}

async function prDiff(repoPath: string, pr: string | undefined): Promise<RawDiff> {
  if (!pr || !/^\d+$/.test(pr)) {
    throw new DiffError(400, 'pr mode needs a pr param — the PR number to diff');
  }
  const patch = await gh(repoPath, ['pr', 'diff', pr]);
  return { patch, files: filesFromPatch(patch) };
}

export async function computeDiff(
  repoPath: string,
  mode: DiffMode,
  params: DiffParams = {}
): Promise<DiffResult> {
  const headSha = await revParse(repoPath, 'HEAD');
  if (headSha === null) {
    throw new DiffError(400, 'repository has no commits yet — nothing to diff against');
  }

  let result: RawDiff;
  // Echoed params hold exactly the keys the mode consumed (spec §3), so the
  // review pins them at submit and stray query params never leak in.
  let echo: Record<string, string> = {};
  switch (mode) {
    case 'uncommitted':
      result = await uncommittedDiff(repoPath);
      break;
    case 'last-commit':
      result = await lastCommitDiff(repoPath);
      break;
    case 'branch':
      result = await branchDiff(repoPath, params.base);
      echo = { base: params.base as string };
      break;
    case 'pr':
      result = await prDiff(repoPath, params.pr);
      echo = { pr: params.pr as string };
      break;
  }

  return {
    mode,
    params: echo,
    hash: createHash('sha256').update(result.patch).digest('hex'),
    headSha,
    patch: result.patch,
    files: result.files,
  };
}
