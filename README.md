# reviewd

> The package name `reviewd` is provisional — final name is decided just before first npm publish.

A local code-review app for agent-written changes. Run it inside any git repo, review the diff in your browser with inline comments (GitHub-style draft → submit), then tell your CLI agent (Claude Code, Codex, Cursor, …) to fetch and resolve those comments over plain HTTP. Everything stays on localhost; nothing is ever written into the repo being reviewed.

## Requirements

- Node ≥ 20 and git
- `gh` CLI (authenticated) — only for PR mode; the other modes work without it

## Launch

```sh
cd your-repo
npx reviewd
```

Prints one line — `reviewd — /path/to/repo — http://localhost:4700` — and stays in the foreground. Ctrl-C stops it. The web UI ships prebuilt in the package; there is no build step.

- Port 4700, scanning upward (4701, 4702, …) on conflict.
- `--open` — also launch your browser (default is print-the-URL only; `$BROWSER` overrides the platform opener).
- `--force` — stop and replace an already-running reviewd for this repo. Without it, a second launch just prints the running server's URL and exits.

## Diff modes

Pick the mode in the UI's top bar:

| Mode | Shows |
| --- | --- |
| Uncommitted (default) | Worktree vs `HEAD`, including untracked files |
| Last commit | `HEAD~1` vs `HEAD` |
| Branch | Merge-base of a chosen base branch vs worktree |
| PR | A GitHub pull request, via the `gh` CLI |

## The review → resolve loop

1. Launch `npx reviewd` and open the URL after your agent finishes a change.
2. Click a line number (or drag a range) in the diff to draft inline comments; submit them as one review. Submitting pins a snapshot of the diff — later code changes never shift your comments.
3. In your agent, run `/resolve-review`. It fetches the open comments over HTTP, fixes each one in the code, and flips it to resolved — you watch the status chips update live in the UI.
4. Comments the agent disagrees with (or that need no change) stay open with an explanation; dismiss them in the UI. Next round of feedback is a new review.

Review data lives under `~/.diff-review/` keyed by repo path. Past reviews are browsable read-only from the sidebar; the server keeps the last 5 fully-settled ones.

## Installing the agent skill

The `resolve-review` skill is distributed with the [skills CLI](https://github.com/vercel-labs/skills), which installs it for Claude Code, Codex, Cursor, and friends:

```sh
npx skills add maciekzygmunt/diff --skill resolve-review
```

reviewd itself never installs skills and never writes files into your repo.

## Development

npm-workspaces monorepo: `packages/server` (Hono API + CLI, the published package), `packages/web` (React UI, bundled into the server package at build time), `skills/resolve-review` (the agent skill).

```sh
npm install
npm run build      # web UI, then server (copies web dist into the package)
npm test           # all workspaces; includes an npm-pack integration test
npm run dev        # server on tsx, serving the last-built web UI
```

## License

[MIT](LICENSE)
