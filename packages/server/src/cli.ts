import { serve } from '@hono/node-server';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { repoDataDir } from './paths.js';
import { BASE_PORT, findFreePort } from './port.js';
import { isHealthy, readServerJson, removeServerJson, writeServerJson } from './serverJson.js';

function resolveRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    console.error('reviewd: not inside a git repository');
    process.exit(1);
  }
}

function packageVersion(): string {
  // fileURLToPath, not import.meta.dirname — the latter needs Node >= 20.11 but engines allows >= 20
  const pkg = JSON.parse(
    readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8')
  );
  return pkg.version as string;
}

function webDistDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('@reviewd/web/package.json')), 'dist');
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const repoPath = resolveRepoRoot();
  const repoDir = repoDataDir(repoPath);

  const existing = readServerJson(repoDir);
  if (existing && (await isHealthy(existing))) {
    console.log(`reviewd already running for ${repoPath} — http://localhost:${existing.port}`);
    return;
  }

  const basePort = Number(process.env.REVIEWD_BASE_PORT ?? BASE_PORT);
  const port = await findFreePort(basePort);
  const app = createApp({ repoPath, version: packageVersion(), webDistDir: webDistDir() });

  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    writeServerJson(repoDir, {
      repoPath,
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    console.log(`reviewd — ${repoPath} — http://localhost:${port}`);
  });

  const shutdown = (): void => {
    removeServerJson(repoDir);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
