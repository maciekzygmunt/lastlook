import { describe, expect, it } from 'vitest';
import type { FileDiffMetadata } from '@pierre/diffs';
import { fileStatus } from '../src/status';

function meta(overrides: Partial<FileDiffMetadata>): FileDiffMetadata {
  return { name: 'src/a.ts', type: 'change', ...overrides } as FileDiffMetadata;
}

describe('fileStatus', () => {
  it('maps new files to added', () => {
    expect(fileStatus(meta({ type: 'new' }))).toBe('added');
  });

  it('maps deleted files to deleted', () => {
    expect(fileStatus(meta({ type: 'deleted' }))).toBe('deleted');
  });

  it('maps a changed prevName to renamed', () => {
    expect(fileStatus(meta({ prevName: 'src/old.ts' }))).toBe('renamed');
  });

  it('maps plain changes to modified', () => {
    expect(fileStatus(meta({}))).toBe('modified');
    expect(fileStatus(meta({ prevName: 'src/a.ts' }))).toBe('modified');
  });
});
