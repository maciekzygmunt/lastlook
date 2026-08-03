import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/app.js';
import type { Comment, Review } from '../src/store.js';

interface SubmitResponse {
  review: Review;
  comments: Comment[];
}

interface DiffResponse {
  hash: string;
  headSha: string;
  patch: string;
}

let repo: string;
let dataDir: string;
let app: Hono;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

/** Repo with one commit plus an uncommitted edit, so mode=uncommitted has content. */
function makeDirtyRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewd-reviews-repo-')));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'tracked.txt'), 'line 1\nline 2\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'tracked.txt'), 'line 1\nline 2 changed\n');
  return dir;
}

function makeApp(): Hono {
  return createApp({ repoPath: repo, version: '0.1.0', dataDir });
}

async function fetchDiff(): Promise<DiffResponse> {
  const res = await app.request('/api/diff?mode=uncommitted');
  expect(res.status).toBe(200);
  return (await res.json()) as DiffResponse;
}

async function createDraft(body = 'Tighten this up'): Promise<Comment> {
  const res = await app.request('/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body,
      anchor: {
        file: 'tracked.txt',
        side: 'additions',
        startLine: 2,
        endLine: 2,
        excerpt: 'line 2 changed',
      },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Comment;
}

async function submit(payload: Record<string, unknown>): Promise<Response> {
  return app.request('/api/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  repo = makeDirtyRepo();
  dataDir = mkdtempSync(join(tmpdir(), 'reviewd-reviews-data-'));
  app = makeApp();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/reviews', () => {
  it('pins the snapshot and flips all drafts to open', async () => {
    const draftA = await createDraft('first');
    const draftB = await createDraft('second');
    const diff = await fetchDiff();

    const res = await submit({
      mode: 'uncommitted',
      params: {},
      hash: diff.hash,
      body: 'Overall: solid, two nits.',
    });

    expect(res.status).toBe(201);
    const { review, comments } = (await res.json()) as SubmitResponse;
    expect(review.id).toMatch(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Date(review.submittedAt).toString()).not.toBe('Invalid Date');
    expect(review.mode).toBe('uncommitted');
    expect(review.params).toEqual({});
    expect(review.headSha).toBe(diff.headSha);
    expect(review.diffHash).toBe(diff.hash);
    expect(review.patch).toBe(diff.patch);
    expect(review.body).toBe('Overall: solid, two nits.');

    expect(comments).toHaveLength(2);
    for (const comment of comments) {
      expect(comment.status).toBe('open');
      expect(comment.reviewId).toBe(review.id);
    }
    expect(comments.map((c) => c.id).sort()).toEqual([draftA.id, draftB.id].sort());
  });

  it('stores a null body when the summary is omitted or blank', async () => {
    await createDraft();
    const diff = await fetchDiff();

    const res = await submit({ mode: 'uncommitted', hash: diff.hash, body: '   ' });

    expect(res.status).toBe(201);
    expect(((await res.json()) as SubmitResponse).review.body).toBeNull();
  });

  it('rejects with 409 when the diff changed since the client fetched it, keeping drafts', async () => {
    const draft = await createDraft();
    const diff = await fetchDiff();
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 drifted\n');

    const res = await submit({ mode: 'uncommitted', hash: diff.hash });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/chang/i);

    const list = await app.request('/api/comments?status=draft');
    const { comments } = (await list.json()) as { comments: Comment[] };
    expect(comments).toEqual([draft]);
    const reviews = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8')) as {
      reviews: unknown[];
    };
    expect(reviews.reviews).toEqual([]);
  });

  it('rejects with 400 when there are no drafts to submit', async () => {
    const diff = await fetchDiff();
    const res = await submit({ mode: 'uncommitted', hash: diff.hash });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/draft/i);
  });

  it('rejects a missing or unknown mode and a missing hash with 400', async () => {
    await createDraft();
    const diff = await fetchDiff();
    for (const payload of [
      { hash: diff.hash },
      { mode: 'sideways', hash: diff.hash },
      { mode: 'uncommitted' },
      { mode: 'uncommitted', hash: 7 },
    ]) {
      const res = await submit(payload);
      expect(res.status).toBe(400);
    }
  });

  it('surfaces diff computation errors with their own status', async () => {
    await createDraft();
    // single-commit repo: last-commit mode has no parent to diff against
    const res = await submit({ mode: 'last-commit', hash: 'irrelevant' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/parent|commit/i);
  });

  it('allows a second review while the first still has open comments', async () => {
    await createDraft('round one');
    const first = await fetchDiff();
    const firstRes = await submit({ mode: 'uncommitted', hash: first.hash });
    expect(firstRes.status).toBe(201);
    const firstReview = ((await firstRes.json()) as SubmitResponse).review;

    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2 round two\n');
    await createDraft('round two');
    const second = await fetchDiff();
    const secondRes = await submit({ mode: 'uncommitted', hash: second.hash });
    expect(secondRes.status).toBe(201);
    const secondReview = ((await secondRes.json()) as SubmitResponse).review;
    expect(secondReview.id).not.toBe(firstReview.id);

    const open = await app.request('/api/comments?status=open');
    const { comments } = (await open.json()) as { comments: Comment[] };
    expect(comments).toHaveLength(2);
    expect(new Set(comments.map((c) => c.reviewId))).toEqual(
      new Set([firstReview.id, secondReview.id])
    );
  });

  it('persists the review and open comments across a restart', async () => {
    await createDraft();
    const diff = await fetchDiff();
    const res = await submit({ mode: 'uncommitted', hash: diff.hash });
    expect(res.status).toBe(201);
    const { review } = (await res.json()) as SubmitResponse;

    const second = makeApp();
    const open = await second.request('/api/comments?status=open');
    const { comments } = (await open.json()) as { comments: Comment[] };
    expect(comments).toHaveLength(1);
    expect(comments[0]?.reviewId).toBe(review.id);

    const data = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8')) as {
      reviews: Review[];
    };
    expect(data.reviews).toEqual([review]);
  });
});
