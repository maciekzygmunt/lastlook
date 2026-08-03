export type DiffMode = 'uncommitted' | 'branch' | 'pr' | 'last-commit';

export type FileChangeStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffFile {
  path: string;
  status: FileChangeStatus;
  changedLines: number;
  oldPath?: string;
  binary?: boolean;
  size?: number;
  /** Patch content withheld from `patch` (spec §6.4); fetch it via fetchFilePatch. */
  stub?: boolean;
}

export interface DiffResponse {
  mode: DiffMode;
  params: Record<string, string>;
  hash: string;
  headSha: string;
  patch: string;
  files: DiffFile[];
}

export interface HealthResponse {
  ok: boolean;
  repoPath: string;
  version: string;
}

export type Side = 'deletions' | 'additions';
export type CommentStatus = 'draft' | 'open' | 'resolved' | 'dismissed';

/** Line-anchored, or file-scoped (binary files, spec §6.3) with all four line fields null. */
export interface CommentAnchor {
  file: string;
  side: Side | null;
  startLine: number | null;
  endLine: number | null;
  excerpt: string | null;
}

export interface Comment {
  id: string;
  reviewId: string | null;
  status: CommentStatus;
  body: string;
  anchor: CommentAnchor;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Review {
  id: string;
  submittedAt: string;
  mode: DiffMode;
  params: Record<string, string>;
  headSha: string;
  diffHash: string;
  patch: string;
  body: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error;
    throw new ApiError(res.status, message ?? `${url} failed with ${res.status}`);
  }
  return body as T;
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export function fetchDiff(
  mode: DiffMode,
  params: Record<string, string> = {}
): Promise<DiffResponse> {
  return request(`/api/diff?${new URLSearchParams({ mode, ...params })}`);
}

/** Load-on-demand for a stub file: its full patch segment from the current diff. */
export function fetchFilePatch(
  mode: DiffMode,
  params: Record<string, string>,
  path: string
): Promise<{ path: string; patch: string }> {
  return request(`/api/diff/file?${new URLSearchParams({ mode, ...params, path })}`);
}

export function fetchHealth(): Promise<HealthResponse> {
  return request('/api/health');
}

export async function fetchComments(status?: CommentStatus): Promise<Comment[]> {
  const query = status ? `?status=${status}` : '';
  const { comments } = await request<{ comments: Comment[] }>(`/api/comments${query}`);
  return comments;
}

export function createDraft(body: string, anchor: CommentAnchor): Promise<Comment> {
  return request('/api/comments', jsonInit('POST', { body, anchor }));
}

export function updateDraft(id: string, patch: { body?: string; anchor?: CommentAnchor }): Promise<Comment> {
  return request(`/api/comments/${id}`, jsonInit('PATCH', patch));
}

export function deleteDraft(id: string): Promise<void> {
  return request(`/api/comments/${id}`, { method: 'DELETE' });
}

export function dismissComment(id: string): Promise<Comment> {
  return request(`/api/comments/${id}/dismiss`, { method: 'POST' });
}

export function submitReview(payload: {
  mode: DiffMode;
  params: Record<string, string>;
  hash: string;
  body?: string;
}): Promise<{ review: Review; comments: Comment[] }> {
  return request('/api/reviews', jsonInit('POST', payload));
}
