import type { DiffFile } from './api';

/**
 * Decisions behind an in-place diff refresh, as pure functions of their inputs.
 * The app component owns the fetches and the state; every judgement lives here.
 */

/**
 * The loaded stubs that survive an old-diff → new-diff swap. A stub is kept only
 * while its file's entry is unchanged: keeping one whose file changed would pin
 * stale content on screen, so it is dropped and re-fetched on demand instead.
 */
export function survivingStubs<T>(
  loaded: Record<string, T>,
  previous: DiffFile[],
  next: DiffFile[]
): Record<string, T> {
  const before = new Map(previous.map((f) => [f.path, f]));
  const after = new Map(next.map((f) => [f.path, f]));
  const kept: Record<string, T> = {};
  for (const [path, stub] of Object.entries(loaded)) {
    const old = before.get(path);
    const fresh = after.get(path);
    if (old && fresh && sameEntry(old, fresh)) kept[path] = stub;
  }
  return kept;
}

/** Entry equality over every field the server sends — the only per-file change signal a stub has. */
function sameEntry(a: DiffFile, b: DiffFile): boolean {
  return (
    a.status === b.status &&
    a.changedLines === b.changedLines &&
    a.oldPath === b.oldPath &&
    a.binary === b.binary &&
    a.size === b.size &&
    a.stub === b.stub
  );
}

/**
 * Identity of a file list for the file tree, which treats its paths and statuses
 * as initial config and so must remount when either changes. Content-only changes
 * leave this key alone; the set of paths, and each path's status badge, move it.
 */
export function treeKey(files: DiffFile[]): string {
  return files
    .map((f) => `${f.path}\t${f.status}`)
    .sort()
    .join('\n');
}
