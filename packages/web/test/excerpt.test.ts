import { describe, expect, it } from 'vitest';
import { parsePatchFiles } from '@pierre/diffs';
import type { FileDiffMetadata } from '@pierre/diffs';
import { extractExcerpt } from '../src/excerpt';

// Two hunks: an edit around lines 3-5, and an addition around line 20.
const PATCH = `diff --git a/src/calc.ts b/src/calc.ts
index 1111111..2222222 100644
--- a/src/calc.ts
+++ b/src/calc.ts
@@ -2,4 +2,4 @@ function add
 const a = 1;
-const b = 2;
-const sum = a + b;
+const b = 20;
+const sum = add(a, b);
 export { sum };
@@ -18,3 +18,5 @@ function mul
 const x = 3;
 const y = 4;
+const product = mul(x, y);
+export { product };
 // end
`;

function file(): FileDiffMetadata {
  const parsed = parsePatchFiles(PATCH).flatMap((p) => p.files)[0];
  if (!parsed) throw new Error('fixture patch failed to parse');
  return parsed;
}

describe('extractExcerpt', () => {
  it('returns a single added line', () => {
    expect(extractExcerpt(file(), 'additions', 3, 3)).toBe('const b = 20;');
  });

  it('returns a range mixing context and added lines', () => {
    expect(extractExcerpt(file(), 'additions', 2, 5)).toBe(
      'const a = 1;\nconst b = 20;\nconst sum = add(a, b);\nexport { sum };'
    );
  });

  it('reads the deletions side with old-file numbering', () => {
    expect(extractExcerpt(file(), 'deletions', 3, 4)).toBe('const b = 2;\nconst sum = a + b;');
  });

  it('resolves lines in a later hunk', () => {
    expect(extractExcerpt(file(), 'additions', 20, 21)).toBe(
      'const product = mul(x, y);\nexport { product };'
    );
  });

  it('skips lines outside any hunk', () => {
    expect(extractExcerpt(file(), 'additions', 10, 12)).toBe('');
    // range straddling the gap keeps only the in-hunk part
    expect(extractExcerpt(file(), 'additions', 5, 12)).toBe('export { sum };');
  });
});
