import { serve } from '@hono/node-server';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  return pkg.version as string;
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
  const app = createApp({ repoPath, version: packageVersion() });

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
