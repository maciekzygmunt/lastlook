import type { CommentAnchor, DiffResponse } from './api';

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Short local timestamp for review rows and the past-review banner. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Topbar chip naming the pull request a PR-mode diff resolved to: `#42 · Add auth flow`.
 * Null for the other modes, so the chip only ever describes a PR that actually loaded.
 * The number comes from the echoed params — the same number the review would pin.
 */
export function prChipLabel(diff: DiffResponse): string | null {
  if (diff.mode !== 'pr') return null;
  const number = diff.params.pr;
  if (!number) return null;
  // A pull request can be untitled; the number alone still identifies it
  return diff.prTitle ? `#${number} · ${diff.prTitle}` : `#${number}`;
}

/** Human label for where a comment anchors: a line, a range, or the whole file (spec §6.3). */
export function formatLines(anchor: CommentAnchor): string {
  if (anchor.startLine === null || anchor.endLine === null) return 'file';
  return anchor.startLine === anchor.endLine
    ? `line ${anchor.endLine}`
    : `lines ${anchor.startLine}–${anchor.endLine}`;
}
