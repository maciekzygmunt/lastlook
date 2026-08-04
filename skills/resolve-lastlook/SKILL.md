---
name: resolve-lastlook
description: Fetch open code-review comments from this repo's local lastlook server, fix each one in the code, and mark it resolved. Use when the user asks to resolve a review, address review comments, or invokes /resolve-lastlook.
---

# resolve-lastlook

The user reviewed your changes in the lastlook web UI and submitted inline comments. Your job: fetch the open comments over HTTP, fix the code they point at, and flip each one to resolved so the user sees live progress in the UI.

Everything below is plain `curl` against a local server. Never start, restart, or kill that server yourself.

## 1. Locate the server

The server writes its port to a per-repo discovery file under the lastlook data dir (`$LASTLOOK_DATA_DIR`, defaulting to `~/.lastlook`).

```sh
REPO=$(git rev-parse --show-toplevel)
DATA=$(node -e '
  const { createHash } = require("node:crypto");
  const p = process.argv[1];
  const s = p.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const h = createHash("sha256").update(p).digest("hex").slice(0, 8);
  console.log(`${process.env.LASTLOOK_DATA_DIR || process.env.HOME + "/.lastlook"}/repos/${s}-${h}`);
' "$REPO")
PORT=$(node -e 'console.log(require(process.argv[1]).port)' "$DATA/server.json")
```

Health-check that port:

```sh
curl -fsS "http://localhost:$PORT/api/health"   # -> {"ok":true,"repoPath":...,"version":...}
```

**Fail fast.** If `server.json` is missing, or the health check fails or returns a different `repoPath`, stop and tell the user:

> no lastlook server for this repo — run `npx lastlook` and submit a review first

Do not auto-start the server. Do not retry in a loop.

## 2. Fetch the open comments and review summaries

```sh
curl -fsS "http://localhost:$PORT/api/comments?status=open"
```

If the list is empty, stop and tell the user:

> no open comments — nothing to do

Each comment looks like:

```json
{
  "id": "cmt_…",
  "reviewId": "rev_…",
  "body": "<the reviewer's instruction, markdown>",
  "anchor": {
    "file": "<repo-relative path>",
    "side": "deletions | additions",
    "startLine": 1,
    "endLine": 3,
    "excerpt": "<the code lines the comment was left on>"
  }
}
```

For each **distinct** `reviewId`, fetch the review's overall summary for context:

```sh
curl -fsS "http://localhost:$PORT/api/reviews/$REVIEW_ID"
```

Read only its `body` (may be null). **Ignore the `patch` field entirely** — it is a pinned snapshot for the UI, not for you. You work against the live code.

## 3. Locate the code for each comment

- Open the live file at `anchor.file` and search for `anchor.excerpt`. The excerpt is authoritative; the file may have moved on since the review, so prefer the excerpt match over line numbers.
- If the excerpt isn't found, fall back to `startLine`–`endLine` in the live file and read the surrounding code.
- `side: "deletions"` means the excerpt is code that was **removed** in the reviewed diff — the comment is about that removal (e.g. "don't delete this"), so the excerpt may legitimately be absent from the live file.
- `startLine`/`excerpt` of `null` means the comment is **file-scoped** (e.g. a binary file) — apply it to the file as a whole, no excerpt lookup.

## 4. Fix, then resolve — one comment at a time

Work through the comments one by one. For each:

1. Make the code change the comment asks for.
2. Immediately flip it:

```sh
curl -fsS -X POST "http://localhost:$PORT/api/comments/$COMMENT_ID/resolve"
```

Resolving right after each fix gives the user live progress in the UI, and a crash loses nothing.

**Resolve only after an actual code change that addresses the comment.** Leave a comment open — and explain why in your final summary — when:

- you disagree with it,
- it's a question rather than a change request,
- the code already does what it asks (no change needed).

The user retires those from the UI with Dismiss; that is their call, not yours. Never resolve to "acknowledge" a comment.

Verify your fixes the way this repo and your own conventions normally require — there is no mandated test run.

## 5. Re-fetch once, then summarize

After exhausting the list, re-fetch `GET /api/comments?status=open` **once**. If new comments appeared (the user submitted another review mid-run), keep going with those too.

End with a summary in chat, grouped:

- **Resolved** — each comment with a one-line note of what you changed.
- **Left open** — each comment with why you didn't resolve it (disagreement, question, already correct). This list is the user's dismiss queue.
