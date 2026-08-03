import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { DiffMode } from './diff.js';

export type Side = 'deletions' | 'additions';

export const COMMENT_STATUSES = ['draft', 'open', 'resolved', 'dismissed'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

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

interface DataFile {
  version: 1;
  reviews: Review[];
  comments: Comment[];
}

const EMPTY: DataFile = { version: 1, reviews: [], comments: [] };

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
    this.save();
    return { review, comments: flipped };
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
