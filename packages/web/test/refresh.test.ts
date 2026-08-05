import { describe, expect, it } from 'vitest';
import type { CommentAnchor, DiffFile, DiffMode } from '../src/api';
import {
  autoRefreshes,
  classifyAnchor,
  fileKey,
  maySwap,
  survivingStubs,
  treeKey,
  type SwapState,
} from '../src/refresh';

/** Digest defaults per path, so two entries for the same file compare equal unless told otherwise. */
function file(path: string, over: Partial<DiffFile> = {}): DiffFile {
  return { path, status: 'modified', changedLines: 12, digest: `d:${path}`, stub: true, ...over };
}

describe('autoRefreshes', () => {
  it.each<DiffMode>(['uncommitted', 'last-commit'])('polls in %s mode', (mode) => {
    expect(autoRefreshes(mode)).toBe(true);
  });

  it.each<DiffMode>(['branch', 'pr'])('does not poll in %s mode', (mode) => {
    expect(autoRefreshes(mode)).toBe(false);
  });
});

const IDLE: SwapState = {
  lineComposerOpen: false,
  fileComposerOpen: false,
  editingDraft: false,
  submitPopoverOpen: false,
  viewingPastReview: false,
};

const SUPPRESSORS = Object.keys(IDLE) as (keyof SwapState)[];

describe('maySwap', () => {
  // Derived from the type, so a sixth condition is covered the moment it is added
  it('has a case for each of the five suppressing conditions', () => {
    expect(SUPPRESSORS).toHaveLength(5);
  });

  it('allows a swap when nothing is open', () => {
    expect(maySwap(IDLE)).toBe(true);
  });

  it.each(SUPPRESSORS)('denies a swap while %s', (condition) => {
    const blocked: SwapState = { ...IDLE, [condition]: true };
    expect(maySwap(blocked)).toBe(false);
  });

  it.each(SUPPRESSORS)('allows the deferred swap once %s clears', (condition) => {
    const blocked: SwapState = { ...IDLE, [condition]: true };
    expect(maySwap({ ...blocked, [condition]: false })).toBe(true);
  });

  it('stays denied until the last condition clears', () => {
    const both = { ...IDLE, lineComposerOpen: true, submitPopoverOpen: true };
    expect(maySwap({ ...both, lineComposerOpen: false })).toBe(false);
    expect(maySwap({ ...both, submitPopoverOpen: false })).toBe(false);
    expect(maySwap({ ...both, lineComposerOpen: false, submitPopoverOpen: false })).toBe(true);
  });
});

describe('survivingStubs', () => {
  it('keeps a stub whose file digest is unchanged', () => {
    const before = [file('src/a.ts'), file('src/b.ts')];
    const after = [file('src/a.ts'), file('src/b.ts', { digest: 'moved' })];
    expect(survivingStubs({ 'src/a.ts': 'A' }, before, after)).toEqual({ 'src/a.ts': 'A' });
  });

  it('drops a stub whose file digest moved', () => {
    expect(
      survivingStubs({ 'src/a.ts': 'A' }, [file('src/a.ts')], [file('src/a.ts', { digest: 'moved' })])
    ).toEqual({});
  });

  // The case the old metadata comparison missed: a lockfile version bump is one
  // line changed before and one line changed after, so only the digest moves
  it('drops a stub whose content changed at an identical changed-line count', () => {
    const before = [file('package-lock.json', { changedLines: 2, digest: 'v1' })];
    const after = [file('package-lock.json', { changedLines: 2, digest: 'v2' })];
    expect(survivingStubs({ 'package-lock.json': 'LOCK' }, before, after)).toEqual({});
  });

  // The digest is the sole signal; no metadata comparison survives alongside it
  it('keeps a stub whose metadata moved but whose digest did not', () => {
    const before = [file('src/a.ts', { changedLines: 12, status: 'modified' })];
    const after = [file('src/a.ts', { changedLines: 40, status: 'added' })];
    expect(survivingStubs({ 'src/a.ts': 'A' }, before, after)).toEqual({ 'src/a.ts': 'A' });
  });

  it('drops a stub for a file absent from the new diff', () => {
    expect(survivingStubs({ 'src/a.ts': 'A' }, [file('src/a.ts')], [file('src/b.ts')])).toEqual({});
  });

  it('leaves files newly present in the diff without a stub', () => {
    expect(survivingStubs({}, [file('src/a.ts')], [file('src/a.ts'), file('src/b.ts')])).toEqual({});
  });

  it('is insensitive to the order of the file lists', () => {
    const loaded = { 'src/a.ts': 'A', 'src/b.ts': 'B' };
    const before = [file('src/a.ts'), file('src/b.ts')];
    const after = [file('src/b.ts'), file('src/a.ts')];
    expect(survivingStubs(loaded, before, after)).toEqual(loaded);
  });
});

// FileDiff snapshots its file on mount, so a file whose content moved has to remount or
// it goes on rendering what it first received — the staleness this whole feature is about
describe('fileKey', () => {
  it('moves when a file’s content moves', () => {
    expect(fileKey(file('src/a.ts', { digest: 'v1' }))).not.toBe(
      fileKey(file('src/a.ts', { digest: 'v2' }))
    );
  });

  it('is stable while a file’s content is unchanged, so untouched files never remount', () => {
    expect(fileKey(file('src/a.ts', { changedLines: 12 }))).toBe(
      fileKey(file('src/a.ts', { changedLines: 40, status: 'added' }))
    );
  });

  it('separates two files that share a digest', () => {
    expect(fileKey(file('src/a.ts', { digest: 'same' }))).not.toBe(
      fileKey(file('src/b.ts', { digest: 'same' }))
    );
  });
});

describe('treeKey', () => {
  it('is stable across a content-only change', () => {
    expect(treeKey([file('src/a.ts'), file('src/b.ts')])).toBe(
      treeKey([file('src/a.ts', { changedLines: 99, digest: 'moved', stub: false }), file('src/b.ts')])
    );
  });

  // The tree renders a status badge from initial config, so a status flip must remount it
  it('differs when a file changes status', () => {
    expect(treeKey([file('src/a.ts'), file('src/b.ts')])).not.toBe(
      treeKey([file('src/a.ts', { status: 'added' }), file('src/b.ts')])
    );
  });

  it('differs when the file set changes', () => {
    const base = treeKey([file('src/a.ts'), file('src/b.ts')]);
    expect(treeKey([file('src/a.ts'), file('src/b.ts'), file('src/c.ts')])).not.toBe(base);
    expect(treeKey([file('src/a.ts')])).not.toBe(base);
    expect(treeKey([file('src/a.ts'), file('src/z.ts')])).not.toBe(base);
  });

  it('is insensitive to file ordering', () => {
    expect(treeKey([file('src/b.ts'), file('src/a.ts')])).toBe(
      treeKey([file('src/a.ts'), file('src/b.ts')])
    );
  });
});

/** A line anchor over [startLine, endLine], holding the text those lines had when written. */
function anchor(
  path: string,
  startLine: number,
  endLine: number,
  excerpt: string | null
): CommentAnchor {
  return { file: path, side: 'additions', startLine, endLine, excerpt };
}

/**
 * Stands in for the app's reader of the current diff: the lines a file has now, joined
 * over the anchor's range and skipping any it no longer reaches — the shape
 * extractExcerpt produces. A file with no entry has no content on hand.
 */
function reader(now: Record<string, string[]>) {
  return (a: CommentAnchor): string | null => {
    const lines = now[a.file];
    if (lines === undefined) return null;
    return lines.slice((a.startLine ?? 1) - 1, a.endLine ?? 0).join('\n');
  };
}

describe('classifyAnchor', () => {
  const files = [file('src/a.ts'), file('src/b.ts')];
  const now = reader({ 'src/a.ts': ['one', 'two', 'three'], 'src/b.ts': ['only'] });

  it('is anchored while the text at its lines still matches its excerpt', () => {
    expect(classifyAnchor(anchor('src/a.ts', 1, 2, 'one\ntwo'), files, now)).toBe('anchored');
    expect(classifyAnchor(anchor('src/a.ts', 3, 3, 'three'), files, now)).toBe('anchored');
  });

  it('is drifted when the text at its lines no longer matches its excerpt', () => {
    expect(classifyAnchor(anchor('src/a.ts', 1, 2, 'one\nTWO'), files, now)).toBe('drifted');
    expect(classifyAnchor(anchor('src/a.ts', 1, 2, 'one'), files, now)).toBe('drifted');
  });

  it('is orphaned when its file has left the diff', () => {
    expect(classifyAnchor(anchor('src/gone.ts', 1, 2, 'one\ntwo'), files, now)).toBe('orphaned');
  });

  // File presence is decided first: a file that left the diff is orphaned however its
  // text reads, since there is no longer anywhere on screen for the note to render
  it('is orphaned rather than anchored when a departed file would still match', () => {
    const stale = reader({ 'src/gone.ts': ['one', 'two'] });
    expect(classifyAnchor(anchor('src/gone.ts', 1, 2, 'one\ntwo'), files, stale)).toBe('orphaned');
  });

  // Binary files take a file-scoped anchor with a null excerpt (spec §6.3), so there is
  // nothing to compare and file presence is the whole judgement
  it('never drifts a file-scoped null-excerpt anchor', () => {
    const fileScoped: CommentAnchor = {
      file: 'src/a.ts',
      side: null,
      startLine: null,
      endLine: null,
      excerpt: null,
    };
    expect(classifyAnchor(fileScoped, files, now)).toBe('anchored');
    expect(classifyAnchor(fileScoped, files, () => 'anything at all')).toBe('anchored');
    expect(classifyAnchor({ ...fileScoped, file: 'src/gone.ts' }, files, now)).toBe('orphaned');
  });

  it('is drifted rather than throwing when its lines run past the end of the file', () => {
    expect(classifyAnchor(anchor('src/a.ts', 40, 42, 'one\ntwo'), files, now)).toBe('drifted');
    expect(classifyAnchor(anchor('src/b.ts', 1, 3, 'only\nmore'), files, now)).toBe('drifted');
  });

  // A stub file's patch is withheld (spec §6.4), so a collapsed one has no content on
  // hand from the moment the page loads — marking that would cry drift on every reload
  it('does not mark a file present in the diff whose content is not on hand', () => {
    expect(classifyAnchor(anchor('src/a.ts', 1, 2, 'one\ntwo'), files, () => null)).toBe('anchored');
    // ...and absent content still loses to a departed file
    expect(classifyAnchor(anchor('src/gone.ts', 1, 2, 'one\ntwo'), files, () => null)).toBe(
      'orphaned'
    );
  });

  it('leaves the comment it classifies untouched', () => {
    const drifted = anchor('src/a.ts', 1, 2, 'gone\nentirely');
    const orphaned = anchor('src/gone.ts', 1, 2, 'one\ntwo');
    classifyAnchor(drifted, files, now);
    classifyAnchor(orphaned, files, now);
    expect(drifted).toEqual(anchor('src/a.ts', 1, 2, 'gone\nentirely'));
    expect(orphaned).toEqual(anchor('src/gone.ts', 1, 2, 'one\ntwo'));
    expect(files).toEqual([file('src/a.ts'), file('src/b.ts')]);
  });
});
