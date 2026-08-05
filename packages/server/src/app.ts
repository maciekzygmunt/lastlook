import { Hono } from 'hono';
import {
  DEFAULT_LIMITS,
  DIFF_MODES,
  DiffError,
  computeDiff,
  extractFilePatch,
  type DiffLimits,
  type DiffMode,
  type DiffParams,
} from './diff.js';
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
  /** Spec §6.4 stub/cap thresholds; tests tune them down. */
  limits?: DiffLimits;
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
  // File-scoped anchor (spec §6.3, binary files): every line field is null, together
  if (a.side === null && a.startLine === null && a.endLine === null && a.excerpt === null) {
    return { file: a.file, side: null, startLine: null, endLine: null, excerpt: null };
  }
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

/** Pick the known mode params out of a query or submit payload; unknown keys are dropped. */
function parseDiffParams(value: unknown): DiffParams {
  if (typeof value !== 'object' || value === null) return {};
  const p = value as Record<string, unknown>;
  const params: DiffParams = {};
  if (typeof p.base === 'string') params.base = p.base;
  if (typeof p.pr === 'string') params.pr = p.pr;
  return params;
}

function queryDiffParams(c: { req: { query: (key: string) => string | undefined } }): DiffParams {
  return parseDiffParams({ base: c.req.query('base'), pr: c.req.query('pr') });
}

const ANCHOR_ERROR =
  'anchor must be {file, side: deletions|additions, startLine, endLine, excerpt}';

export function createApp({
  repoPath,
  version,
  dataDir,
  webDistDir,
  limits = DEFAULT_LIMITS,
}: AppContext): Hono {
  const app = new Hono();
  const store = new Store(dataDir);

  app.get('/api/health', (c) => c.json({ ok: true, repoPath, version }));

  app.get('/api/diff', async (c) => {
    const mode = c.req.query('mode');
    if (!isDiffMode(mode)) {
      return c.json({ error: `mode must be one of: ${DIFF_MODES.join(', ')}` }, 400);
    }
    try {
      const diff = await computeDiff(repoPath, mode, queryDiffParams(c), limits);
      // Stub segments are withheld (spec §6.4); the full patch is pinned only at submit
      return c.json({
        mode: diff.mode,
        params: diff.params,
        hash: diff.hash,
        headSha: diff.headSha,
        patch: diff.visiblePatch,
        files: diff.files,
        // PR mode only; JSON-dropped when absent, so the other modes are unchanged
        prTitle: diff.prTitle,
      });
    } catch (error) {
      if (error instanceof DiffError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  // Load-on-demand for stub files (spec §6.4): one file's full segment of the current diff
  app.get('/api/diff/file', async (c) => {
    const mode = c.req.query('mode');
    if (!isDiffMode(mode)) {
      return c.json({ error: `mode must be one of: ${DIFF_MODES.join(', ')}` }, 400);
    }
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path must name a file in the current diff' }, 400);
    try {
      const diff = await computeDiff(repoPath, mode, queryDiffParams(c), limits);
      const patch = extractFilePatch(diff.patch, path);
      if (patch === null) return c.json({ error: `no file "${path}" in the current diff` }, 404);
      return c.json({ path, patch });
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

  // Terminal status flips (spec §5): resolve is the agent's, dismiss is the user's
  for (const action of ['resolve', 'dismiss'] as const) {
    app.post(`/api/comments/:id/${action}`, (c) => {
      const comment = store.getComment(c.req.param('id'));
      if (!comment) return c.json({ error: 'no such comment' }, 404);
      if (comment.status !== 'open') {
        return c.json({ error: `only open comments can be ${action}d — this one is ${comment.status}` }, 409);
      }
      return c.json(store.settleComment(comment.id, action === 'resolve' ? 'resolved' : 'dismissed'));
    });
  }

  // Patch-free summaries for the sidebar Reviews panel; the pinned patch comes via /:id
  app.get('/api/reviews', (c) => c.json({ reviews: store.listReviewSummaries() }));

  app.get('/api/reviews/:id', (c) => {
    const review = store.getReview(c.req.param('id'));
    if (!review) return c.json({ error: 'no such review' }, 404);
    return c.json(review);
  });

  app.post('/api/reviews', async (c) => {
    const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const mode = payload?.mode;
    if (typeof mode !== 'string' || !isDiffMode(mode)) {
      return c.json({ error: `mode must be one of: ${DIFF_MODES.join(', ')}` }, 400);
    }
    if (typeof payload?.hash !== 'string' || payload.hash === '') {
      return c.json({ error: 'hash must be the hash from the last GET /api/diff' }, 400);
    }

    let diff;
    try {
      diff = await computeDiff(repoPath, mode, parseDiffParams(payload?.params), limits);
    } catch (error) {
      if (error instanceof DiffError) return c.json({ error: error.message }, error.status);
      throw error;
    }
    // Checked after the await: a concurrent submit may have flipped the drafts meanwhile
    if (store.listComments('draft').length === 0) {
      return c.json({ error: 'no draft comments to submit' }, 400);
    }
    // Hash-drift guard (spec §5): the pinned snapshot must be exactly what the user reviewed
    if (diff.hash !== payload.hash) {
      return c.json(
        { error: 'the diff changed since it was last fetched — refresh and re-submit' },
        409
      );
    }

    const result = store.submitReview({
      mode: diff.mode,
      params: diff.params,
      headSha: diff.headSha,
      diffHash: diff.hash,
      patch: diff.patch,
      body: parseBody(payload.body),
    });
    return c.json(result, 201);
  });

  // Mounted last: the catch-all must not shadow /api routes
  if (webDistDir) mountWebUi(app, webDistDir);

  return app;
}
