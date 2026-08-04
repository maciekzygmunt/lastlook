#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from './app.js';
import { openBrowser } from './browser.js';
import { repoDataDir } from './paths.js';
import { BASE_PORT, findFreePort } from './port.js';
import {
  isHealthy,
  readServerJson,
  removeServerJson,
  writeServerJson,
  type ServerJson,
} from './serverJson.js';

interface CliFlags {
  open: boolean;
  force: boolean;
}

function parseFlags(): CliFlags {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { open: { type: 'boolean' }, force: { type: 'boolean' } },
    });
    return { open: values.open ?? false, force: values.force ?? false };
  } catch (err) {
    console.error(`reviewd: ${(err as Error).message}`);
    console.error('usage: reviewd [--open] [--force]');
    process.exit(1);
  }
}

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
  // packed layout first: dist/web ships inside the npm package next to this file
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'web');
  if (existsSync(join(bundled, 'index.html'))) return bundled;
  // dev fallback: the workspace sibling's build output
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('@reviewd/web/package.json')), 'dist');
  } catch {
    return undefined;
  }
}

/** SIGTERM the recorded pid, then wait for its port to stop answering health. */
async function killServer(info: ServerJson): Promise<void> {
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await isHealthy(info))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`reviewd: existing server (pid ${info.pid}) did not stop within 5s`);
  process.exit(1);
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const repoPath = resolveRepoRoot();
  const repoDir = repoDataDir(repoPath);

  const existing = readServerJson(repoDir);
  if (existing && (await isHealthy(existing))) {
    if (!flags.force) {
      const url = `http://localhost:${existing.port}`;
      console.log(`reviewd already running for ${repoPath} — ${url}`);
      if (flags.open) openBrowser(url);
      return;
    }
    await killServer(existing);
  }

  const basePort = Number(process.env.REVIEWD_BASE_PORT ?? BASE_PORT);
  const port = await findFreePort(basePort);
  const app = createApp({
    repoPath,
    version: packageVersion(),
    dataDir: repoDir,
    webDistDir: webDistDir(),
  });

  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    writeServerJson(repoDir, {
      repoPath,
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    console.log(`reviewd — ${repoPath} — http://localhost:${port}`);
    if (flags.open) openBrowser(`http://localhost:${port}`);
  });

  const shutdown = (): void => {
    removeServerJson(repoDir);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
