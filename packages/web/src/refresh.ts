import type { DiffFile } from './api';

/**
 * Decisions behind an in-place diff refresh, as pure functions of their inputs.
 * The app component owns the fetches and the state; every judgement lives here.
 */

/**
 * The loaded stubs that survive an old-diff → new-diff swap. A stub is kept only
 * while its file's server-supplied digest is unchanged: keeping one whose content
 * moved would pin stale content on screen, so it is dropped and re-fetched instead.
 * The rest of the entry is not consulted — none of it tracks content.
 */
export function survivingStubs<T>(
  loaded: Record<string, T>,
  previous: DiffFile[],
  next: DiffFile[]
): Record<string, T> {
  const before = new Map(previous.map((f) => [f.path, f.digest]));
  const after = new Map(next.map((f) => [f.path, f.digest]));
  const kept: Record<string, T> = {};
  for (const [path, stub] of Object.entries(loaded)) {
    const old = before.get(path);
    if (old !== undefined && old === after.get(path)) kept[path] = stub;
  }
  return kept;
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
