import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Above the 15 MB response cap so an over-cap diff still reaches the 413 check
const MAX_BUFFER = 64 * 1024 * 1024;

export const DIFF_MODES = ['uncommitted', 'branch', 'pr', 'last-commit'] as const;
export type DiffMode = (typeof DIFF_MODES)[number];

/** Mode-specific inputs (spec §3): `base` for branch mode, `pr` for pr mode. */
export interface DiffParams {
  base?: string;
  pr?: string;
}

/** Spec §6.4 thresholds — defaults below, overridable for tuning and tests. */
export interface DiffLimits {
  maxPatchBytes: number;
  stubChangedLines: number;
}

export const DEFAULT_LIMITS: DiffLimits = {
  maxPatchBytes: 15 * 1024 * 1024,
  stubChangedLines: 3000,
};

/** Lockfile / generated files render as collapsed stubs regardless of size (spec §6.4). */
const GENERATED_PATTERNS = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  /(^|\/)(Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|flake\.lock)$/,
  /\.min\.(js|css)$/,
];

export type FileChangeStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffFile {
  path: string;
  status: FileChangeStatus;
  changedLines: number;
  /** Renames only: the pre-rename path (anchors always use `path`, spec §6.2). */
  oldPath?: string;
  binary?: boolean;
  /** Binary files only: byte size of the new content, when resolvable. */
  size?: number;
  /** Large/generated files: patch content omitted from the diff response (spec §6.4). */
  stub?: boolean;
}

export interface DiffResult {
  mode: DiffMode;
  params: Record<string, string>;
  hash: string;
  headSha: string;
  /** Full authoritative patch — what reviews pin and `hash` covers. */
  patch: string;
  /** `patch` minus stub files' segments — what GET /api/diff returns. */
  visiblePatch: string;
  files: DiffFile[];
}

export class DiffError extends Error {
  constructor(
    readonly status: 400 | 409 | 413,
    message: string
  ) {
    super(message);
    this.name = 'DiffError';
  }
}

async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    // A diff too big even for the buffer is the size cap's problem, not a crash
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new DiffError(
        413,
        'diff output exceeds the size cap — narrow the review: diff against a closer base, ' +
          'review commits individually, or commit generated files separately'
      );
    }
    throw error;
  }
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

async function uncommittedDiff(repoPath: string): Promise<string> {
  const parts = [await git(repoPath, ['diff', 'HEAD'])];
  for (const path of await listUntracked(repoPath)) {
    parts.push(await synthesizeUntracked(repoPath, path));
  }
  return parts.join('');
}

async function lastCommitDiff(repoPath: string): Promise<string> {
  if ((await revParse(repoPath, 'HEAD~1')) === null) {
    throw new DiffError(400, 'last-commit mode needs a parent commit; HEAD is the only commit');
  }
  return git(repoPath, ['diff', 'HEAD~1', 'HEAD']);
}

async function branchDiff(repoPath: string, base: string | undefined): Promise<string> {
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
  return git(repoPath, ['diff', mergeBase, 'HEAD']);
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
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new DiffError(413, 'PR diff exceeds the size cap — review the PR in smaller pieces');
    }
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

async function prDiff(repoPath: string, pr: string | undefined): Promise<string> {
  if (!pr || !/^\d+$/.test(pr)) {
    throw new DiffError(400, 'pr mode needs a pr param — the PR number to diff');
  }
  return gh(repoPath, ['pr', 'diff', pr]);
}

/** One file's chunk of the assembled patch, plus everything parsed out of its headers. */
interface PatchSegment {
  text: string;
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  binary: boolean;
  changedLines: number;
  newOid?: string;
}

/** git C-quotes paths containing special characters in header lines. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * Path from a `diff --git a/… b/…` header, needed only when the segment has no
 * rename or `+++`/`---` lines (e.g. binary files, mode-only changes). git
 * doesn't quote spaces in this header; the midpoint split disambiguates the
 * common unrenamed case, with a last-` b/` fallback.
 */
function pathFromHeader(headerRest: string): string | null {
  const quoted = /^"a\/(.*)" "b\/(.*)"$/.exec(headerRest);
  if (quoted?.[2] !== undefined) return quoted[2];
  if (headerRest.length % 2 === 1) {
    const mid = (headerRest.length - 1) / 2;
    const oldSide = headerRest.slice(0, mid);
    const newSide = headerRest.slice(mid + 1);
    if (
      oldSide.startsWith('a/') &&
      newSide.startsWith('b/') &&
      oldSide.slice(2) === newSide.slice(2)
    ) {
      return newSide.slice(2);
    }
  }
  const idx = headerRest.lastIndexOf(' b/');
  return idx === -1 ? null : headerRest.slice(idx + 3);
}

function parseSegment(text: string): PatchSegment | null {
  const lines = text.split('\n');
  const headerRest = (lines[0] ?? '').slice('diff --git '.length);

  let status: FileChangeStatus = 'modified';
  let binary = false;
  let changedLines = 0;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let minusPath: string | undefined;
  let plusPath: string | undefined;
  let newOid: string | undefined;

  for (const line of lines.slice(1)) {
    if (line.startsWith('new file mode ')) status = 'added';
    else if (line.startsWith('deleted file mode ')) status = 'deleted';
    else if (line.startsWith('rename from ')) renameFrom = unquote(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) renameTo = unquote(line.slice('rename to '.length));
    else if (line.startsWith('index ')) {
      newOid = /^index [0-9a-f]+\.\.([0-9a-f]+)/.exec(line)?.[1];
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
    else if (line.startsWith('--- ')) {
      // git appends a TAB after paths containing spaces on ---/+++ lines
      const p = unquote(line.slice(4).replace(/\t$/, ''));
      if (p.startsWith('a/')) minusPath = p.slice(2);
    } else if (line.startsWith('+++ ')) {
      const p = unquote(line.slice(4).replace(/\t$/, ''));
      if (p.startsWith('b/')) plusPath = p.slice(2);
    } else if (line.startsWith('+') || line.startsWith('-')) changedLines++;
  }

  if (renameFrom !== undefined && renameTo !== undefined) {
    return { text, path: renameTo, oldPath: renameFrom, status: 'renamed', binary, changedLines };
  }
  // Deletions have `+++ /dev/null`, so the old-side path is the file's identity
  const path = plusPath ?? minusPath ?? pathFromHeader(headerRest);
  if (path === null) return null;
  return { text, path, status, binary, changedLines, newOid };
}

/**
 * Split the assembled patch at `diff --git` headers. Deriving files[] from the
 * patch itself (instead of a second `--name-only` git call) keeps the listing
 * atomic with the patch — a second call could race worktree edits or a PR push.
 */
function parseSegments(patch: string): PatchSegment[] {
  const segments: PatchSegment[] = [];
  const starts: number[] = [];
  let pos = 0;
  while (pos < patch.length) {
    const at = patch.indexOf('diff --git ', pos);
    if (at === -1) break;
    if (at === 0 || patch[at - 1] === '\n') starts.push(at);
    pos = at + 1;
  }
  for (const [i, start] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1] : patch.length;
    const segment = parseSegment(patch.slice(start, end));
    if (segment) segments.push(segment);
  }
  return segments;
}

const ALL_ZEROS = /^0+$/;

/**
 * Byte size of a binary file's new content: the blob when it exists (committed
 * modes), else the worktree file (uncommitted edits and untracked files, whose
 * oids aren't in the object db). Unresolvable (e.g. deleted binary) → undefined.
 */
async function binarySize(repoPath: string, segment: PatchSegment): Promise<number | undefined> {
  if (segment.newOid && !ALL_ZEROS.test(segment.newOid)) {
    try {
      return Number((await git(repoPath, ['cat-file', '-s', segment.newOid])).trim());
    } catch {
      // worktree-side oid, not in the object db — fall through to disk
    }
  }
  try {
    return (await stat(join(repoPath, segment.path))).size;
  } catch {
    return undefined;
  }
}

function isStub(segment: PatchSegment, limits: DiffLimits): boolean {
  if (segment.binary) return false;
  return (
    segment.changedLines > limits.stubChangedLines ||
    GENERATED_PATTERNS.some((re) => re.test(segment.path))
  );
}

async function buildFiles(
  repoPath: string,
  segments: PatchSegment[],
  limits: DiffLimits
): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  for (const segment of segments) {
    const file: DiffFile = {
      path: segment.path,
      status: segment.status,
      changedLines: segment.changedLines,
    };
    if (segment.oldPath !== undefined) file.oldPath = segment.oldPath;
    if (segment.binary) {
      file.binary = true;
      const size = await binarySize(repoPath, segment);
      if (size !== undefined) file.size = size;
    }
    if (isStub(segment, limits)) file.stub = true;
    files.push(file);
  }
  return files;
}

/** The full segment for one file of the current diff (stub or not), or null if absent. */
export function extractFilePatch(patch: string, path: string): string | null {
  return parseSegments(patch).find((s) => s.path === path)?.text ?? null;
}

export async function computeDiff(
  repoPath: string,
  mode: DiffMode,
  params: DiffParams = {},
  limits: DiffLimits = DEFAULT_LIMITS
): Promise<DiffResult> {
  const headSha = await revParse(repoPath, 'HEAD');
  if (headSha === null) {
    throw new DiffError(400, 'repository has no commits yet — nothing to diff against');
  }

  let patch: string;
  // Echoed params hold exactly the keys the mode consumed (spec §3), so the
  // review pins them at submit and stray query params never leak in.
  let echo: Record<string, string> = {};
  switch (mode) {
    case 'uncommitted':
      patch = await uncommittedDiff(repoPath);
      break;
    case 'last-commit':
      patch = await lastCommitDiff(repoPath);
      break;
    case 'branch':
      patch = await branchDiff(repoPath, params.base);
      echo = { base: params.base as string };
      break;
    case 'pr':
      patch = await prDiff(repoPath, params.pr);
      echo = { pr: params.pr as string };
      break;
  }

  const bytes = Buffer.byteLength(patch);
  if (bytes > limits.maxPatchBytes) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    throw new DiffError(
      413,
      `diff is ${mb(bytes)} MB, over the ${mb(limits.maxPatchBytes)} MB cap — narrow the review: ` +
        'diff against a closer base, review commits individually, or commit generated files separately'
    );
  }

  const segments = parseSegments(patch);
  const files = await buildFiles(repoPath, segments, limits);
  const stubbed = new Set(files.filter((f) => f.stub).map((f) => f.path));

  return {
    mode,
    params: echo,
    hash: createHash('sha256').update(patch).digest('hex'),
    headSha,
    patch,
    visiblePatch: stubbed.size
      ? segments.filter((s) => !stubbed.has(s.path)).map((s) => s.text).join('')
      : patch,
    files,
  };
}
