import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/app.js';
import type { Comment } from '../src/store.js';

let dataDir: string;
let app: Hono;

const anchor = {
  file: 'src/auth.ts',
  side: 'additions' as const,
  startLine: 42,
  endLine: 44,
  excerpt: 'const token = sign(payload);\nreturn token;',
};

function makeApp(): Hono {
  return createApp({ repoPath: '/tmp/some-repo', version: '0.1.0', dataDir });
}

async function listedComments(res: Response): Promise<Comment[]> {
  return ((await res.json()) as { comments: Comment[] }).comments;
}

async function createDraft(body = 'Use a constant-time compare'): Promise<Comment> {
  const res = await app.request('/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body, anchor }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Comment;
}

/** Seed data.json with a non-draft comment, bypassing the API. */
function seedOpenComment(id: string): void {
  const data = {
    version: 1,
    reviews: [],
    comments: [
      {
        id,
        reviewId: 'rev_01SEEDED',
        status: 'open',
        body: 'submitted earlier',
        anchor,
        createdAt: '2026-08-01T00:00:00.000Z',
        resolvedAt: null,
      },
    ],
  };
  writeFileSync(join(dataDir, 'data.json'), JSON.stringify(data));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'reviewd-comments-'));
  app = makeApp();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/comments', () => {
  it('creates a draft with a cmt_ ulid id, null reviewId, and the given anchor', async () => {
    const comment = await createDraft();
    expect(comment.id).toMatch(/^cmt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(comment.status).toBe('draft');
    expect(comment.reviewId).toBeNull();
    expect(comment.body).toBe('Use a constant-time compare');
    expect(comment.anchor).toEqual(anchor);
    expect(new Date(comment.createdAt).toString()).not.toBe('Invalid Date');
    expect(comment.resolvedAt).toBeNull();
  });

  it('rejects an empty or missing body', async () => {
    for (const body of [{ anchor }, { body: '   ', anchor }]) {
      const res = await app.request('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a malformed anchor', async () => {
    const bad = [
      undefined,
      { ...anchor, file: '' },
      { ...anchor, side: 'left' },
      { ...anchor, startLine: 'x' },
      { ...anchor, endLine: undefined },
      { ...anchor, excerpt: 7 },
    ];
    for (const a of bad) {
      const res = await app.request('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'note', anchor: a }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('persists to data.json in the spec shape', async () => {
    const comment = await createDraft();
    const data = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'));
    expect(data).toEqual({ version: 1, reviews: [], comments: [comment] });
  });
});

describe('GET /api/comments', () => {
  it('lists all comments, newest last', async () => {
    const a = await createDraft('first');
    const b = await createDraft('second');
    const res = await app.request('/api/comments');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ comments: [a, b] });
  });

  it('filters by status', async () => {
    seedOpenComment('cmt_01AAAAAAAAAAAAAAAAAAAAAAAA');
    app = makeApp();
    const draft = await createDraft();

    const drafts = await app.request('/api/comments?status=draft');
    expect(await listedComments(drafts)).toEqual([draft]);

    const open = await app.request('/api/comments?status=open');
    const openComments = await listedComments(open);
    expect(openComments).toHaveLength(1);
    expect(openComments[0]?.status).toBe('open');
  });

  it('rejects an unknown status filter', async () => {
    const res = await app.request('/api/comments?status=bogus');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/comments/:id', () => {
  it('edits the body of a draft', async () => {
    const draft = await createDraft();
    const res = await app.request(`/api/comments/${draft.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Sharper wording' }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Comment;
    expect(updated.body).toBe('Sharper wording');
    expect(updated.anchor).toEqual(draft.anchor);
  });

  it('edits the anchor of a draft', async () => {
    const draft = await createDraft();
    const moved = { ...anchor, startLine: 50, endLine: 50, excerpt: 'other line' };
    const res = await app.request(`/api/comments/${draft.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchor: moved }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Comment).anchor).toEqual(moved);
  });

  it('rejects an empty patch and a malformed anchor', async () => {
    const draft = await createDraft();
    for (const patch of [{}, { body: '  ' }, { anchor: { ...anchor, side: 'nope' } }]) {
      const res = await app.request(`/api/comments/${draft.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(400);
    }
  });

  it('404s on an unknown id', async () => {
    const res = await app.request('/api/comments/cmt_01MISSINGMISSINGMISSINGMIS', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('409s on a non-draft comment', async () => {
    seedOpenComment('cmt_01BBBBBBBBBBBBBBBBBBBBBBBB');
    app = makeApp();
    const res = await app.request('/api/comments/cmt_01BBBBBBBBBBBBBBBBBBBBBBBB', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/comments/:id', () => {
  it('deletes a draft', async () => {
    const draft = await createDraft();
    const res = await app.request(`/api/comments/${draft.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const list = await app.request('/api/comments');
    expect(await listedComments(list)).toEqual([]);
  });

  it('404s on an unknown id', async () => {
    const res = await app.request('/api/comments/cmt_01MISSINGMISSINGMISSINGMIS', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('409s on a non-draft comment', async () => {
    seedOpenComment('cmt_01CCCCCCCCCCCCCCCCCCCCCCCC');
    app = makeApp();
    const res = await app.request('/api/comments/cmt_01CCCCCCCCCCCCCCCCCCCCCCCC', {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
  });
});

describe('persistence across restarts', () => {
  it('a fresh app over the same dataDir sees earlier drafts', async () => {
    const draft = await createDraft();
    const second = makeApp();
    const res = await second.request('/api/comments?status=draft');
    expect(await listedComments(res)).toEqual([draft]);
  });
});
