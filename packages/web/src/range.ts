import type { SelectedLineRange } from '@pierre/diffs';
import type { Side } from './api';

export interface AnchorRange {
  side: Side;
  startLine: number;
  endLine: number;
}

/**
 * Collapse a Pierre line selection to the single-side range an anchor needs
 * (spec §4). In split view a drag can start on one side and end on the other;
 * old- and new-file numbering don't mix, so a cross-side drag keeps only the
 * line where it ended.
 */
export function anchorRange(range: SelectedLineRange): AnchorRange {
  const side = (range.endSide ?? range.side ?? 'additions') as Side;
  const startSide = range.side ?? side;
  if (startSide !== side) return { side, startLine: range.end, endLine: range.end };
  return {
    side,
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}
