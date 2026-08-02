import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataRoot(): string {
  return process.env.REVIEWD_DATA_DIR ?? join(homedir(), '.diff-review');
}

export function repoDataDir(repoPath: string, root: string = dataRoot()): string {
  const sanitized = repoPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const shorthash = createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
  return join(root, 'repos', `${sanitized}-${shorthash}`);
}
