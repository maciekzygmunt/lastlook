import type { FileDiffMetadata } from '@pierre/diffs';
import type { Side } from './api';

/**
 * The code lines behind a diff anchor, for storage in a comment's `anchor.excerpt`
 * (spec §4). Line numbers use the side's own file numbering (new-file numbers on
 * `additions`, old-file numbers on `deletions`); lines outside every hunk are skipped.
 */
export function extractExcerpt(
  file: FileDiffMetadata,
  side: Side,
  startLine: number,
  endLine: number
): string {
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    const text = lineText(file, side, line);
    if (text !== null) lines.push(text);
  }
  return lines.join('\n');
}

function lineText(file: FileDiffMetadata, side: Side, line: number): string | null {
  const adds = side === 'additions';
  const source = adds ? file.additionLines : file.deletionLines;
  for (const hunk of file.hunks) {
    const start = adds ? hunk.additionStart : hunk.deletionStart;
    const count = adds ? hunk.additionCount : hunk.deletionCount;
    if (line < start || line >= start + count) continue;
    const text = source[(adds ? hunk.additionLineIndex : hunk.deletionLineIndex) + (line - start)];
    // Pierre stores each line with its trailing newline; excerpts want bare lines
    return text === undefined ? null : text.replace(/\r?\n$/, '');
  }
  return null;
}
