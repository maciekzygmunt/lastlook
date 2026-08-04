// Bundle the prebuilt web UI into the npm package (spec §9: no build step at install time).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(serverRoot, '..', 'web', 'dist');
const dest = join(serverRoot, 'dist', 'web');

if (!existsSync(join(src, 'index.html'))) {
  console.error('copy-web: packages/web/dist is missing — run `npm run build -w @lastlook/web` first');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

// npm renders the README from the package root, not the monorepo root
const monorepoRoot = join(serverRoot, '..', '..');
for (const file of ['README.md', 'LICENSE']) {
  cpSync(join(monorepoRoot, file), join(serverRoot, file));
}
