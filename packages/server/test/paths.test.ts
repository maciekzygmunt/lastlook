import { describe, expect, it } from 'vitest';
import { repoDataDir } from '../src/paths.js';

describe('repoDataDir', () => {
  it('places the dir under the data root, never inside the repo', () => {
    const dir = repoDataDir('/Users/alice/projects/my-app', '/Users/alice/.diff-review');
    expect(dir.startsWith('/Users/alice/.diff-review/repos/')).toBe(true);
    expect(dir.includes('/Users/alice/projects/my-app')).toBe(false);
  });

  it('derives <sanitized-path>-<shorthash> from the repo path', () => {
    const dir = repoDataDir('/Users/alice/projects/my-app', '/data');
    expect(dir).toMatch(/^\/data\/repos\/users-alice-projects-my-app-[0-9a-f]{8}$/);
  });

  it('is deterministic for the same path', () => {
    expect(repoDataDir('/a/b', '/data')).toBe(repoDataDir('/a/b', '/data'));
  });

  it('distinguishes repos whose sanitized names collide', () => {
    // '-' and '/' both sanitize to '-', so only the hash separates these
    expect(repoDataDir('/home/x/my-app', '/data')).not.toBe(repoDataDir('/home/x/my/app', '/data'));
  });
});
