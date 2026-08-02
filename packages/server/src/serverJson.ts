import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthResponse } from './app.js';

export interface ServerJson {
  repoPath: string;
  port: number;
  pid: number;
  startedAt: string;
}

export function serverJsonPath(repoDir: string): string {
  return join(repoDir, 'server.json');
}

export function readServerJson(repoDir: string): ServerJson | null {
  try {
    return JSON.parse(readFileSync(serverJsonPath(repoDir), 'utf8')) as ServerJson;
  } catch {
    return null;
  }
}

export function writeServerJson(repoDir: string, info: ServerJson): void {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(serverJsonPath(repoDir), JSON.stringify(info, null, 2) + '\n');
}

export function removeServerJson(repoDir: string): void {
  rmSync(serverJsonPath(repoDir), { force: true });
}

/** A server.json is live only if the recorded port answers /api/health for the same repo. */
export async function isHealthy(info: ServerJson): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${info.port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as Partial<HealthResponse>;
    return body.ok === true && body.repoPath === info.repoPath;
  } catch {
    return false;
  }
}
