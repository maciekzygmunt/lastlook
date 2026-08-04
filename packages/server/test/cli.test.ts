import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { type Server } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { repoDataDir } from '../src/paths.js';
import { serverJsonPath as serverJsonIn } from '../src/serverJson.js';
import { closeAll, listenOn, waitFor } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
// --import with an absolute file URL keeps the CLI in a single process (tsx's
// bin would spawn a grandchild, breaking pid assertions and signal cleanup)
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

interface Launched {
  proc: ChildProcess;
  /** stdout and stderr combined */
  output: () => string;
  exited: Promise<number | null>;
}

const children: ChildProcess[] = [];
const blockers: Server[] = [];
const tmpdirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lastlook-repo-'));
  tmpdirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return realpathSync(dir);
}

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lastlook-data-'));
  tmpdirs.push(dir);
  return dir;
}

function launch(
  repo: string,
  dataDir: string,
  basePort: number,
  args: string[] = [],
  env: Record<string, string> = {}
): Launched {
  const proc = spawn(process.execPath, ['--import', TSX_LOADER, CLI, ...args], {
    cwd: repo,
    env: { ...process.env, LASTLOOK_DATA_DIR: dataDir, LASTLOOK_BASE_PORT: String(basePort), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let out = '';
  proc.stdout!.on('data', (chunk) => (out += chunk));
  proc.stderr!.on('data', (chunk) => (out += chunk));
  const exited = new Promise<number | null>((resolve) => proc.once('exit', resolve));
  return { proc, output: () => out, exited };
}

async function occupy(port: number): Promise<void> {
  blockers.push(await listenOn(port));
}

function serverJsonPath(repo: string, dataDir: string): string {
  return serverJsonIn(repoDataDir(repo, dataDir));
}

afterEach(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  children.length = 0;
  await closeAll(blockers);
  blockers.length = 0;
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
  tmpdirs.length = 0;
});

describe('lastlook CLI lifecycle', () => {
  it('prints one banner line, serves /api/health, writes server.json, clears it on SIGINT', { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const dataDir = makeDataDir();
    const run = launch(repo, dataDir, 25700);

    await waitFor(() => run.output().includes('http://'));
    const banner = run.output().trim();
    expect(banner.split('\n')).toHaveLength(1);
    expect(banner).toContain('lastlook');
    expect(banner).toContain(repo);
    const url = banner.match(/http:\/\/\S+/)![0];

    const health = (await (await fetch(`${url}/api/health`)).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.repoPath).toBe(repo);
    expect(typeof health.version).toBe('string');

    const sj = JSON.parse(readFileSync(serverJsonPath(repo, dataDir), 'utf8'));
    expect(sj.repoPath).toBe(repo);
    expect(sj.port).toBe(25700);
    expect(sj.pid).toBe(run.proc.pid);
    expect(new Date(sj.startedAt).getTime()).not.toBeNaN();

    // nothing written inside the target repo (only .git from init)
    execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString() === '' || expect.fail('repo dirtied');

    run.proc.kill('SIGINT');
    expect(await run.exited).toBe(0);
    expect(existsSync(serverJsonPath(repo, dataDir))).toBe(false);
  });

  it('scans upward on port conflict and records the chosen port', { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const dataDir = makeDataDir();
    await occupy(25720);
    const run = launch(repo, dataDir, 25720);

    await waitFor(() => run.output().includes('http://'));
    expect(run.output()).toContain(':25721');
    const sj = JSON.parse(readFileSync(serverJsonPath(repo, dataDir), 'utf8'));
    expect(sj.port).toBe(25721);
  });

  it('second launch against a healthy server prints its URL and exits without a duplicate', { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const dataDir = makeDataDir();
    const first = launch(repo, dataDir, 25740);
    await waitFor(() => first.output().includes('http://'));

    const second = launch(repo, dataDir, 25740);
    expect(await second.exited).toBe(0);
    expect(second.output()).toContain('http://localhost:25740');

    // first is untouched: still healthy, server.json still points at it
    const health = (await (await fetch('http://localhost:25740/api/health')).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    const sj = JSON.parse(readFileSync(serverJsonPath(repo, dataDir), 'utf8'));
    expect(sj.pid).toBe(first.proc.pid);
  });

  it('--force replaces a healthy existing server', { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const dataDir = makeDataDir();
    const first = launch(repo, dataDir, 25780);
    await waitFor(() => first.output().includes('http://'));

    const second = launch(repo, dataDir, 25780, ['--force']);
    await waitFor(() => second.output().includes('http://'));
    expect(await first.exited).toBe(0);

    const sj = JSON.parse(readFileSync(serverJsonPath(repo, dataDir), 'utf8'));
    expect(sj.pid).toBe(second.proc.pid);
    const health = (await (await fetch(`http://localhost:${sj.port}/api/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health.ok).toBe(true);
  });

  it('--open launches $BROWSER with the URL; default does not', { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const dataDir = makeDataDir();
    const marker = join(makeDataDir(), 'opened-url');
    const opener = join(makeDataDir(), 'fake-browser.sh');
    writeFileSync(opener, `#!/bin/sh\necho "$1" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });

    const plain = launch(repo, dataDir, 25800, [], { BROWSER: opener });
    await waitFor(() => plain.output().includes('http://'));
    expect(existsSync(marker)).toBe(false);
    plain.proc.kill('SIGINT');
    await plain.exited;

    const opened = launch(repo, dataDir, 25800, ['--open'], { BROWSER: opener });
    await waitFor(() => existsSync(marker));
    expect(readFileSync(marker, 'utf8').trim()).toBe('http://localhost:25800');
    expect(opened.output().trim().split('\n')).toHaveLength(1);
  });

  it('rejects unknown flags with usage', { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const dataDir = makeDataDir();
    const run = launch(repo, dataDir, 25820, ['--bogus']);
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain('usage: lastlook');
  });

  it('silently replaces a stale server.json', { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const dataDir = makeDataDir();
    const dir = repoDataDir(repo, dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'server.json'),
      JSON.stringify({ repoPath: repo, port: 25761, pid: 999999, startedAt: '2026-01-01T00:00:00.000Z' })
    );

    const run = launch(repo, dataDir, 25760);
    await waitFor(() => run.output().includes('http://'));
    expect(run.output()).not.toContain('already running');

    const sj = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'));
    expect(sj.pid).toBe(run.proc.pid);
    expect(sj.port).toBe(25760);
  });
});
