import type { CommentAnchor } from './api';

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Human label for where a comment anchors: a line, a range, or the whole file (spec §6.3). */
export function formatLines(anchor: CommentAnchor): string {
  if (anchor.startLine === null || anchor.endLine === null) return 'file';
  return anchor.startLine === anchor.endLine
    ? `line ${anchor.endLine}`
    : `lines ${anchor.startLine}–${anchor.endLine}`;
}
