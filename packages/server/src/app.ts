import { Hono } from 'hono';
import { DIFF_MODES, DiffError, computeDiff, type DiffMode } from './diff.js';
import { mountWebUi } from './static.js';
import {
  COMMENT_STATUSES,
  Store,
  type CommentAnchor,
  type CommentStatus,
} from './store.js';

export interface AppContext {
  repoPath: string;
  version: string;
  dataDir: string;
  webDistDir?: string;
}

export interface HealthResponse {
  ok: boolean;
  repoPath: string;
  version: string;
}

function isDiffMode(mode: string | undefined): mode is DiffMode {
  return DIFF_MODES.includes(mode as DiffMode);
}

function isCommentStatus(status: string): status is CommentStatus {
  return COMMENT_STATUSES.includes(status as CommentStatus);
}

function parseAnchor(value: unknown): CommentAnchor | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (typeof a.file !== 'string' || a.file === '') return null;
  if (a.side !== 'deletions' && a.side !== 'additions') return null;
  if (!Number.isInteger(a.startLine) || !Number.isInteger(a.endLine)) return null;
  if (typeof a.excerpt !== 'string') return null;
  return {
    file: a.file,
    side: a.side,
    startLine: a.startLine as number,
    endLine: a.endLine as number,
    excerpt: a.excerpt,
  };
}

function parseBody(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const ANCHOR_ERROR =
  'anchor must be {file, side: deletions|additions, startLine, endLine, excerpt}';

export function createApp({ repoPath, version, dataDir, webDistDir }: AppContext): Hono {
  const app = new Hono();
  const store = new Store(dataDir);

  app.get('/api/health', (c) => c.json({ ok: true, repoPath, version }));

  app.get('/api/diff', async (c) => {
    const mode = c.req.query('mode');
    if (!isDiffMode(mode)) {
      return c.json({ error: `mode must be one of: ${DIFF_MODES.join(', ')}` }, 400);
    }
    try {
      return c.json(await computeDiff(repoPath, mode));
    } catch (error) {
      if (error instanceof DiffError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  app.get('/api/comments', (c) => {
    const status = c.req.query('status');
    if (status !== undefined && !isCommentStatus(status)) {
      return c.json({ error: `status must be one of: ${COMMENT_STATUSES.join(', ')}` }, 400);
    }
    return c.json({ comments: store.listComments(status) });
  });

  app.post('/api/comments', async (c) => {
    const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseBody(payload?.body);
    const anchor = parseAnchor(payload?.anchor);
    if (body === null) return c.json({ error: 'body must be a non-empty string' }, 400);
    if (anchor === null) return c.json({ error: ANCHOR_ERROR }, 400);
    return c.json(store.createDraft(body, anchor), 201);
  });

  app.patch('/api/comments/:id', async (c) => {
    const comment = store.getComment(c.req.param('id'));
    if (!comment) return c.json({ error: 'no such comment' }, 404);
    if (comment.status !== 'draft') {
      return c.json({ error: 'only draft comments can be edited' }, 409);
    }
    const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const patch: { body?: string; anchor?: CommentAnchor } = {};
    if (payload?.body !== undefined) {
      const body = parseBody(payload.body);
      if (body === null) return c.json({ error: 'body must be a non-empty string' }, 400);
      patch.body = body;
    }
    if (payload?.anchor !== undefined) {
      const anchor = parseAnchor(payload.anchor);
      if (anchor === null) return c.json({ error: ANCHOR_ERROR }, 400);
      patch.anchor = anchor;
    }
    if (patch.body === undefined && patch.anchor === undefined) {
      return c.json({ error: 'nothing to update — pass body and/or anchor' }, 400);
    }
    return c.json(store.updateComment(comment.id, patch));
  });

  app.delete('/api/comments/:id', (c) => {
    const comment = store.getComment(c.req.param('id'));
    if (!comment) return c.json({ error: 'no such comment' }, 404);
    if (comment.status !== 'draft') {
      return c.json({ error: 'only draft comments can be deleted' }, 409);
    }
    store.deleteComment(comment.id);
    return c.body(null, 204);
  });

  // Mounted last: the catch-all must not shadow /api routes
  if (webDistDir) mountWebUi(app, webDistDir);

  return app;
}
