import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Spec §6.4 caps the assembled patch at ~15 MB; leave headroom before enforcement lands (ticket 16)
const MAX_BUFFER = 64 * 1024 * 1024;

export const DIFF_MODES = ['uncommitted', 'last-commit'] as const;
export type DiffMode = (typeof DIFF_MODES)[number];

export interface DiffFile {
  path: string;
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

async function rangeDiff(
  repoPath: string,
  range: string[]
): Promise<{ patch: string; files: DiffFile[] }> {
  const patch = await git(repoPath, ['diff', ...range]);
  const names = await git(repoPath, ['diff', ...range, '--name-only', '-z']);
  return { patch, files: names.split('\0').filter(Boolean).map((path) => ({ path })) };
}

async function uncommittedDiff(repoPath: string): Promise<{ patch: string; files: DiffFile[] }> {
  const { patch, files } = await rangeDiff(repoPath, ['HEAD']);

  const parts = [patch];
  for (const path of await listUntracked(repoPath)) {
    parts.push(await synthesizeUntracked(repoPath, path));
    files.push({ path });
  }

  return { patch: parts.join(''), files };
}

async function lastCommitDiff(repoPath: string): Promise<{ patch: string; files: DiffFile[] }> {
  if ((await revParse(repoPath, 'HEAD~1')) === null) {
    throw new DiffError(400, 'last-commit mode needs a parent commit; HEAD is the only commit');
  }
  return rangeDiff(repoPath, ['HEAD~1', 'HEAD']);
}

export async function computeDiff(repoPath: string, mode: DiffMode): Promise<DiffResult> {
  const headSha = await revParse(repoPath, 'HEAD');
  if (headSha === null) {
    throw new DiffError(400, 'repository has no commits yet — nothing to diff against');
  }

  const { patch, files } =
    mode === 'uncommitted' ? await uncommittedDiff(repoPath) : await lastCommitDiff(repoPath);

  return {
    mode,
    params: {},
    hash: createHash('sha256').update(patch).digest('hex'),
    headSha,
    patch,
    files,
  };
}
