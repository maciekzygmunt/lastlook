import type { CommentAnchor, DiffFile, DiffMode } from './api';

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
 * Identity of one file's diff view. FileDiff takes its file as initial config, the same
 * way useFileTree takes its paths, so a swapped-in diff would go on rendering the content
 * it mounted with — the staleness the mode-switch dance used to work around. Keying on
 * the digest remounts exactly the files whose content moved and leaves the rest alone.
 */
export function fileKey(file: DiffFile): string {
  return `${file.path}:${file.digest}`;
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

/** Where a comment stands against the diff currently on screen (spec §Drift). */
export type AnchorState = 'anchored' | 'drifted' | 'orphaned';

/**
 * How a comment stands against the diff now on screen. Every anchor stores an `excerpt`
 * — the code as it read when the draft was written — and comparing that with the text
 * now at the same lines is the whole of drift detection.
 *
 * The result is a label and nothing more: no comment is moved, re-anchored or deleted
 * here or anywhere downstream. Deleting what the user wrote because a background poll
 * fired is the same harm as destroying composer text; marking is the entire
 * intervention and the user decides while it is still a draft (spec §Drift).
 *
 * `currentExcerpt` reads the anchor's lines out of the current diff in the same form
 * the excerpt was captured in, and returns null when that file's content is not on
 * hand. Lines the file no longer reaches simply come back missing, so an anchor past
 * the end of a shortened file drifts rather than throwing.
 */
export function classifyAnchor(
  anchor: CommentAnchor,
  files: DiffFile[],
  currentExcerpt: (anchor: CommentAnchor) => string | null
): AnchorState {
  if (!files.some((f) => f.path === anchor.file)) return 'orphaned';
  // File-scoped anchors (binary files) carry a null excerpt by construction, so file
  // presence is the only thing they can be judged on — never drifted.
  if (anchor.excerpt === null) return 'anchored';
  const now = currentExcerpt(anchor);
  // Absent content is not evidence of change: a stub file's patch is withheld by
  // construction (spec §6.4), so a collapsed one has no content on hand from the
  // moment the page loads. Marking that would cry drift on every reload. The mark
  // fires only on code we can see has moved.
  if (now === null) return 'anchored';
  return now === anchor.excerpt ? 'anchored' : 'drifted';
}
