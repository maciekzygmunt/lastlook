import type { FileDiffMetadata } from '@pierre/diffs';
import type { GitStatus } from '@pierre/trees';

export function fileStatus(f: FileDiffMetadata): GitStatus {
  if (f.type === 'new') return 'added';
  if (f.type === 'deleted') return 'deleted';
  if (f.prevName && f.prevName !== f.name) return 'renamed';
  return 'modified';
}
