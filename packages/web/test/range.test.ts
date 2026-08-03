import { describe, expect, it } from 'vitest';
import { anchorRange } from '../src/range';

describe('anchorRange', () => {
  it('keeps a same-side range, normalising direction', () => {
    expect(anchorRange({ start: 3, end: 7, side: 'additions', endSide: 'additions' })).toEqual({
      side: 'additions',
      startLine: 3,
      endLine: 7,
    });
    // upward drag
    expect(anchorRange({ start: 7, end: 3, side: 'deletions', endSide: 'deletions' })).toEqual({
      side: 'deletions',
      startLine: 3,
      endLine: 7,
    });
  });

  it('collapses a cross-side drag to the end line only', () => {
    expect(anchorRange({ start: 100, end: 5, side: 'deletions', endSide: 'additions' })).toEqual({
      side: 'additions',
      startLine: 5,
      endLine: 5,
    });
  });

  it('defaults a sideless range to additions', () => {
    expect(anchorRange({ start: 2, end: 4 })).toEqual({
      side: 'additions',
      startLine: 2,
      endLine: 4,
    });
  });
});
