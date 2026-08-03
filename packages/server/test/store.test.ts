import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type CommentAnchor, type ReviewSnapshot } from '../src/store.js';

let dataDir: string;
let store: Store;

const ANCHOR: CommentAnchor = {
  file: 'tracked.txt',
  side: 'additions',
  startLine: 2,
  endLine: 2,
  excerpt: 'line 2 changed',
};

function snapshot(n: number): ReviewSnapshot {
  return {
    mode: 'uncommitted',
    params: {},
    headSha: 'abc123',
    diffHash: `hash-${n}`,
    patch: `patch ${n}`,
    body: null,
  };
}

/** Submit review #n with one open comment; returns [reviewId, commentId]. */
function submitOpenReview(n: number): [string, string] {
  const draft = store.createDraft(`comment ${n}`, ANCHOR);
  const { review } = store.submitReview(snapshot(n));
  return [review.id, draft.id];
}

/** Submit review #n and resolve its one comment, leaving it fully settled. */
function submitSettledReview(n: number): string {
  const [reviewId, commentId] = submitOpenReview(n);
  store.settleComment(commentId, 'resolved');
  return reviewId;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'reviewd-store-'));
  store = new Store(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('retention pruning on submit', () => {
  it('keeps at most 5 fully-settled reviews, pruning oldest-first with their comments', () => {
    const settled: string[] = [];
    for (let n = 1; n <= 6; n++) settled.push(submitSettledReview(n));

    // 6 settled reviews exist; the next submit prunes the oldest one
    const [seventhId] = submitOpenReview(7);

    const ids = store.listReviews().map((r) => r.id);
    expect(ids).not.toContain(settled[0]);
    expect(ids).toEqual([...settled.slice(1), seventhId]);
    // the pruned review's comments went with it
    const reviewIds = new Set(store.listComments().map((c) => c.reviewId));
    expect(reviewIds.has(settled[0]!)).toBe(false);
    expect(store.listComments()).toHaveLength(6);
  });

  it('never prunes a review with an open comment, regardless of age', () => {
    const [oldestOpenId] = submitOpenReview(1);
    const settled: string[] = [];
    for (let n = 2; n <= 7; n++) settled.push(submitSettledReview(n));

    // 6 settled + 1 open; this submit prunes the oldest *settled* review
    submitOpenReview(8);

    const ids = store.listReviews().map((r) => r.id);
    expect(ids).toContain(oldestOpenId);
    expect(ids).not.toContain(settled[0]);
    expect(store.listReviews()).toHaveLength(7);
  });

  it('does not prune while 5 or fewer settled reviews exist', () => {
    for (let n = 1; n <= 5; n++) submitSettledReview(n);
    submitOpenReview(6);
    expect(store.listReviews()).toHaveLength(6);
    expect(store.listComments()).toHaveLength(6);
  });

  it('a dismissed comment counts as settled', () => {
    const [, commentId] = submitOpenReview(1);
    store.settleComment(commentId, 'dismissed');
    for (let n = 2; n <= 6; n++) submitSettledReview(n);

    const [seventhId] = submitOpenReview(7);

    // review 1 (dismissed) was the oldest settled review, so it went first
    const ids = store.listReviews().map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(ids[ids.length - 1]).toBe(seventhId);
    const reviewIds = new Set(store.listComments().map((c) => c.reviewId));
    expect(reviewIds.has(ids[0]!)).toBe(true);
  });

  it('pruning persists: a fresh store sees the pruned data', () => {
    for (let n = 1; n <= 6; n++) submitSettledReview(n);
    submitOpenReview(7);

    const fresh = new Store(dataDir);
    expect(fresh.listReviews()).toHaveLength(6);
    expect(fresh.listComments()).toHaveLength(6);
  });
});
