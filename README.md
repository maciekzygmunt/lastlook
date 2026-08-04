# lastlook

**One last look before you ship.**

lastlook is a local code-review app for agent-written changes. Run it inside any git repo, review the diff in your browser with inline comments (GitHub-style draft → submit), then tell your CLI agent (Claude Code, Codex, Cursor, …) to fetch and resolve those comments over plain HTTP.

Everything stays on localhost. Nothing is ever written into the repo being reviewed.

## Why

Agents write a lot of code, and reading it in terminal scroll-back is a bad way to catch problems. lastlook gives you a real diff viewer with inline comments — and closes the loop by exposing those comments over a local HTTP API, so the agent that wrote the code can fix them and mark them resolved while you watch.

## Quick start

```sh
cd your-repo
npx lastlook
```

That prints one line — `lastlook — /path/to/repo — http://localhost:4700` — and stays in the foreground. Open the URL, review, Ctrl-C to stop. The web UI ships prebuilt in the package; there is no build step.

**Requirements:** Node ≥ 20 and git. The `gh` CLI (authenticated) is needed only for PR mode — every other mode works without it.

### CLI flags

| Flag | Effect |
| --- | --- |
| `--open` | Also launch your browser (default is print-the-URL only; `$BROWSER` overrides the platform opener) |
| `--force` | Stop and replace an already-running lastlook for this repo. Without it, a second launch just prints the running server's URL and exits |

The server listens on port 4700, scanning upward (4701, 4702, …) on conflict.

## Diff modes

Pick the mode in the UI's top bar:

| Mode | Shows |
| --- | --- |
| Uncommitted (default) | Worktree vs `HEAD`, including untracked files |
| Last commit | `HEAD~1` vs `HEAD` |
| Branch | Merge-base of a chosen base branch vs worktree |
| PR | A GitHub pull request, via the `gh` CLI |

## The review → resolve loop

1. Your agent finishes a change. Launch `npx lastlook` and open the URL.
2. Click a line number (or drag a range) in the diff to draft inline comments; submit them as one review. Submitting pins a snapshot of the diff — later code changes never shift your comments.
3. In your agent, run `/resolve-review`. It fetches the open comments over HTTP, fixes each one in the code, and flips it to resolved — you watch the status chips update live in the UI.
4. Comments the agent disagrees with (or that need no change) stay open with an explanation; dismiss them in the UI. The next round of feedback is a new review.

### Installing the agent skill

The `resolve-review` skill is distributed with the [skills CLI](https://github.com/vercel-labs/skills), which installs it for Claude Code, Codex, Cursor, and friends:

```sh
npx skills add maciekzygmunt/lastlook --skill resolve-review
```

lastlook itself never installs skills and never writes files into your repo.

## Where data lives

Review data lives under `~/.lastlook/` (override with `$LASTLOOK_DATA_DIR`), keyed by repo path. Past reviews are browsable read-only from the sidebar; the server keeps the last 5 fully-settled ones and prunes the rest. Delete `~/.lastlook/` at any time to start fresh — your repos are untouched.

## Development

npm-workspaces monorepo:

| Package | What it is |
| --- | --- |
| `packages/server` | Hono API + CLI — the published `lastlook` package |
| `packages/web` | React UI, bundled into the server package at build time |
| `skills/resolve-review` | The agent skill |

```sh
npm install
npm run build      # web UI, then server (copies web dist into the package)
npm test           # all workspaces; includes an npm-pack integration test
npm run dev        # server on tsx, serving the last-built web UI
```

Contributions welcome — open an issue or PR.

## License

[MIT](LICENSE) © Maciej Zygmunt
