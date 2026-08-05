import { describe, expect, it } from 'vitest';
import type { DiffFile } from '../src/api';
import { survivingStubs, treeKey } from '../src/refresh';

function file(path: string, over: Partial<DiffFile> = {}): DiffFile {
  return { path, status: 'modified', changedLines: 12, stub: true, ...over };
}

describe('survivingStubs', () => {
  it('keeps a stub whose file entry is unchanged', () => {
    const before = [file('src/a.ts'), file('src/b.ts')];
    const after = [file('src/a.ts'), file('src/b.ts', { changedLines: 40 })];
    expect(survivingStubs({ 'src/a.ts': 'A' }, before, after)).toEqual({ 'src/a.ts': 'A' });
  });

  it('drops a stub whose file entry changed', () => {
    expect(
      survivingStubs({ 'src/a.ts': 'A' }, [file('src/a.ts')], [file('src/a.ts', { changedLines: 40 })])
    ).toEqual({});
    expect(
      survivingStubs({ 'src/a.ts': 'A' }, [file('src/a.ts')], [file('src/a.ts', { status: 'added' })])
    ).toEqual({});
    expect(
      survivingStubs({ 'src/a.ts': 'A' }, [file('src/a.ts')], [file('src/a.ts', { stub: false })])
    ).toEqual({});
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
      treeKey([file('src/a.ts', { changedLines: 99, stub: false }), file('src/b.ts')])
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
