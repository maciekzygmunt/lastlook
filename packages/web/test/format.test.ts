import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatLines } from '../src/format';

describe('formatBytes', () => {
  it('renders bytes, KB, and MB at sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('formatDate', () => {
  it('renders a short local timestamp with month, day, year, and time', () => {
    // locale- and timezone-dependent, so assert the stable parts only
    const label = formatDate('2026-08-03T12:34:00Z');
    expect(label).toContain('2026');
    expect(label).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('formatLines', () => {
  it('labels a single line, a range, and a file-scoped anchor', () => {
    const base = { file: 'a.ts', side: 'additions' as const, excerpt: 'x' };
    expect(formatLines({ ...base, startLine: 4, endLine: 4 })).toBe('line 4');
    expect(formatLines({ ...base, startLine: 2, endLine: 5 })).toBe('lines 2–5');
    expect(
      formatLines({ file: 'a.png', side: null, startLine: null, endLine: null, excerpt: null })
    ).toBe('file');
  });
});
