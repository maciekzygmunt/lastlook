import { describe, expect, it } from 'vitest';
import type { DiffFile, DiffMode } from '../src/api';
import { autoRefreshes, maySwap, survivingStubs, treeKey, type SwapState } from '../src/refresh';

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
