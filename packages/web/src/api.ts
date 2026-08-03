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

export type Side = 'deletions' | 'additions';
export type CommentStatus = 'draft' | 'open' | 'resolved' | 'dismissed';

export interface CommentAnchor {
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
  excerpt: string;
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error;
    throw new Error(message ?? `${url} failed with ${res.status}`);
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

export function fetchDiff(mode: DiffMode): Promise<DiffResponse> {
  return request(`/api/diff?mode=${mode}`);
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
