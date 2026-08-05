import type { DiffFile, DiffMode } from './api';

/**
 * Decisions behind an in-place diff refresh, as pure functions of their inputs.
 * The app component owns the timer, the visibility listener, the pending diff and
 * the fetches; every judgement lives here.
 */

/**
 * Whether a mode polls for a moved diff. Uncommitted and last-commit are the two an
 * agent moves while the user watches, and both are a local `git diff`. Branch is left
 * out because it is the mode where the user deliberately reads a fixed range; PR is
 * left out because it shells out to the GitHub CLI, so every poll would spend
 * rate-limited network on a diff that moves when someone pushes, not when a file
 * is saved. In the excluded modes the hash poll does not run at all.
 */
export function autoRefreshes(mode: DiffMode): boolean {
  return mode === 'uncommitted' || mode === 'last-commit';
}

/** Everything that has to be idle before a fetched diff may replace the one on screen. */
export interface SwapState {
  lineComposerOpen: boolean;
  fileComposerOpen: boolean;
  editingDraft: boolean;
  submitPopoverOpen: boolean;
  viewingPastReview: boolean;
}

/**
 * Whether a swap may be applied right now. A composer holds its typed text in local
 * component state and nowhere else, so unmounting one during a swap destroys unsaved
 * writing — the worst thing this feature could do. The submit popover must not have the
 * diff move under it between opening and pressing the button, and a past review is a
 * pinned snapshot that does not move at all.
 *
 * A fetch started before a composer opened can land after it, so callers ask this at
 * apply time and not only when the fetch starts.
 */
export function maySwap(state: SwapState): boolean {
  return !(
    state.lineComposerOpen ||
    state.fileComposerOpen ||
    state.editingDraft ||
    state.submitPopoverOpen ||
    state.viewingPastReview
  );
}

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
