import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { DiffMode } from './diff.js';

export type Side = 'deletions' | 'additions';

export const COMMENT_STATUSES = ['draft', 'open', 'resolved', 'dismissed'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

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

/** Immutable snapshot pinned at submit (spec §4): the patch the comments were written against. */
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

export type ReviewSnapshot = Omit<Review, 'id' | 'submittedAt'>;

/** Patch-free listing shape for the sidebar Reviews panel. */
export type ReviewSummary = Omit<Review, 'patch'> & { commentCount: number };

interface DataFile {
  version: 1;
  reviews: Review[];
  comments: Comment[];
}

const EMPTY: DataFile = { version: 1, reviews: [], comments: [] };

/** Retention bound (spec §5): at most this many fully-settled reviews survive a submit. */
const MAX_SETTLED_REVIEWS = 5;

/** Per-repo comment/review storage backed by data.json in the repo's data dir (spec §2). */
export class Store {
  private data: DataFile | null = null;

  constructor(private readonly dataDir: string) {}

  listComments(status?: CommentStatus): Comment[] {
    const comments = this.load().comments;
    return status ? comments.filter((c) => c.status === status) : [...comments];
  }

  getComment(id: string): Comment | undefined {
    return this.load().comments.find((c) => c.id === id);
  }

  createDraft(body: string, anchor: CommentAnchor): Comment {
    const comment: Comment = {
      id: `cmt_${ulid()}`,
      reviewId: null,
      status: 'draft',
      body,
      anchor,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.load().comments.push(comment);
    this.save();
    return comment;
  }

  updateComment(id: string, patch: { body?: string; anchor?: CommentAnchor }): Comment {
    const comment = this.load().comments.find((c) => c.id === id);
    if (!comment) throw new Error(`no comment ${id}`);
    if (patch.body !== undefined) comment.body = patch.body;
    if (patch.anchor !== undefined) comment.anchor = patch.anchor;
    this.save();
    return comment;
  }

  /** Pin the snapshot as a new review and flip every draft to open under it. */
  submitReview(snapshot: ReviewSnapshot): { review: Review; comments: Comment[] } {
    const data = this.load();
    const review: Review = {
      id: `rev_${ulid()}`,
      submittedAt: new Date().toISOString(),
      ...snapshot,
    };
    const flipped: Comment[] = [];
    for (const comment of data.comments) {
      if (comment.status !== 'draft') continue;
      comment.status = 'open';
      comment.reviewId = review.id;
      flipped.push(comment);
    }
    data.reviews.push(review);
    this.prune(data);
    this.save();
    return { review, comments: flipped };
  }

  /**
   * Retention (spec §5): drop oldest-first so at most MAX_SETTLED_REVIEWS fully-settled
   * reviews remain, taking their comments along. A review with any open comment is
   * never pruned, regardless of age. Silent — there is no delete endpoint.
   */
  private prune(data: DataFile): void {
    const openReviewIds = new Set(
      data.comments.filter((c) => c.status === 'open').map((c) => c.reviewId)
    );
    const settled = data.reviews.filter((r) => !openReviewIds.has(r.id));
    const excess = settled.length - MAX_SETTLED_REVIEWS;
    if (excess <= 0) return;
    const pruned = new Set(settled.slice(0, excess).map((r) => r.id));
    data.reviews = data.reviews.filter((r) => !pruned.has(r.id));
    data.comments = data.comments.filter(
      (c) => c.reviewId === null || !pruned.has(c.reviewId)
    );
  }

  /** Flip an open comment to its settled status; resolve stamps resolvedAt, dismiss doesn't. */
  settleComment(id: string, status: 'resolved' | 'dismissed'): Comment {
    const comment = this.load().comments.find((c) => c.id === id);
    if (!comment) throw new Error(`no comment ${id}`);
    comment.status = status;
    if (status === 'resolved') comment.resolvedAt = new Date().toISOString();
    this.save();
    return comment;
  }

  getReview(id: string): Review | undefined {
    return this.load().reviews.find((r) => r.id === id);
  }

  listReviews(): Review[] {
    return [...this.load().reviews];
  }

  listReviewSummaries(): ReviewSummary[] {
    const data = this.load();
    const counts = new Map<string, number>();
    for (const comment of data.comments) {
      if (comment.reviewId !== null) {
        counts.set(comment.reviewId, (counts.get(comment.reviewId) ?? 0) + 1);
      }
    }
    return data.reviews.map(({ patch: _patch, ...review }) => ({
      ...review,
      commentCount: counts.get(review.id) ?? 0,
    }));
  }

  deleteComment(id: string): void {
    const data = this.load();
    data.comments = data.comments.filter((c) => c.id !== id);
    this.save();
  }

  private load(): DataFile {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(readFileSync(join(this.dataDir, 'data.json'), 'utf8')) as DataFile;
    } catch {
      this.data = structuredClone(EMPTY);
    }
    return this.data;
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    // write-then-rename so a crash mid-write can't corrupt data.json
    const tmp = join(this.dataDir, 'data.json.tmp');
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    renameSync(tmp, join(this.dataDir, 'data.json'));
  }
}
