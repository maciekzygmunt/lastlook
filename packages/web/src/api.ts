export type DiffMode = 'uncommitted' | 'last-commit';

export interface DiffResponse {
  mode: DiffMode;
  params: Record<string, string>;
  hash: string;
  headSha: string;
  patch: string;
  files: { path: string }[];
}

export interface HealthResponse {
  ok: boolean;
  repoPath: string;
  version: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error;
    throw new Error(message ?? `${url} failed with ${res.status}`);
  }
  return body as T;
}

export function fetchDiff(mode: DiffMode): Promise<DiffResponse> {
  return getJson(`/api/diff?mode=${mode}`);
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson('/api/health');
}
