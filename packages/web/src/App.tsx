import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parsePatchFiles } from '@pierre/diffs';
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
  ThemeTypes,
} from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import {
  ApiError,
  createDraft,
  deleteDraft,
  dismissComment,
  fetchComments,
  fetchDiff,
  fetchFilePatch,
  fetchHealth,
  fetchReview,
  fetchReviews,
  submitReview,
  updateDraft,
  type Comment,
  type CommentAnchor,
  type DiffFile,
  type DiffMode,
  type DiffResponse,
  type Review,
  type ReviewSummary,
  type Side,
} from './api';
import { extractExcerpt } from './excerpt';
import { formatBytes, formatDate, formatLines } from './format';
import { anchorRange } from './range';
import './App.css';

const MODES: { id: DiffMode; label: string }[] = [
  { id: 'uncommitted', label: 'Uncommitted' },
  { id: 'branch', label: 'Branch vs base' },
  { id: 'pr', label: 'PR' },
  { id: 'last-commit', label: 'Last commit' },
];

type DiffState =
  | { kind: 'loading' }
  | { kind: 'prompt'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; diff: DiffResponse };

interface ComposerTarget {
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
}

/** All-null line fields: the file-scoped anchor shape binary comments use (spec §6.3). */
function fileScopedAnchor(file: string): CommentAnchor {
  return { file, side: null, startLine: null, endLine: null, excerpt: null };
}

type Anno = { kind: 'composer' } | { kind: 'note'; note: Comment };

/** Line annotations for a file's comments; file-scoped anchors have no line to attach to. */
function noteAnnotations(notes: Comment[]): DiffLineAnnotation<Anno>[] {
  const out: DiffLineAnnotation<Anno>[] = [];
  for (const n of notes) {
    if (n.anchor.side === null || n.anchor.endLine === null) continue;
    out.push({
      side: n.anchor.side,
      lineNumber: n.anchor.endLine,
      metadata: { kind: 'note', note: n },
    });
  }
  return out;
}

export default function App() {
  const [mode, setMode] = useState<DiffMode>('uncommitted');
  const [base, setBase] = useState('main');
  const [pr, setPr] = useState('');
  // Bumped on every param commit so re-loading the same value retries the fetch
  const [paramAttempt, setParamAttempt] = useState(0);
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('split');
  const [themeType, setThemeType] = useState<ThemeTypes>('dark');
  const [state, setState] = useState<DiffState>({ kind: 'loading' });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  // Binary files take one file-scoped comment; this holds the path whose composer is open
  const [fileComposer, setFileComposer] = useState<string | null>(null);
  // Stub files expanded on demand: path → that file's parsed patch segment
  const [loadedStubs, setLoadedStubs] = useState<Record<string, FileDiffMetadata>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  // Non-null while the read-only past-review view is open (spec §7 Review history)
  const [pastReview, setPastReview] = useState<Review | null>(null);

  // Bumped on every local comment mutation so a poll response started before
  // the mutation can't overwrite the fresher local state.
  const commentsEpoch = useRef(0);

  useEffect(() => {
    fetchHealth().then(
      (h) => setRepoPath(h.repoPath),
      () => setRepoPath('')
    );
    fetchComments().then(setComments, (error: Error) => setApiError(error.message));
    fetchReviews().then(setReviews, (error: Error) => setApiError(error.message));
  }, []);

  // Live status updates: the agent resolves comments out-of-band, so poll for
  // flips instead of requiring a manual reload. Errors are ignored — the next
  // tick retries, and user-initiated calls surface their own errors.
  useEffect(() => {
    const id = setInterval(async () => {
      const before = commentsEpoch.current;
      try {
        const fresh = await fetchComments();
        if (commentsEpoch.current !== before) return;
        setComments((prev) =>
          JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh
        );
      } catch {
        // server briefly unreachable — retry next tick
      }
    }, 3000);
    return () => clearInterval(id);
  }, []);

  // Mode params sent to /api/diff; `base`/`pr` hold committed values (the
  // inputs keep their own text until the user loads it)
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (mode === 'branch') p.base = base;
    if (mode === 'pr') p.pr = pr;
    return p;
  }, [mode, base, pr]);

  useEffect(() => {
    let stale = false;
    setSelectedFile(null);
    setComposer(null);
    setFileComposer(null);
    setLoadedStubs({});
    // Touching the mode controls is a return to the current diff
    setPastReview(null);
    if (mode === 'pr' && pr === '') {
      setState({ kind: 'prompt', message: 'Enter a PR number to load its diff.' });
      return;
    }
    setState({ kind: 'loading' });
    fetchDiff(mode, params).then(
      (diff) => {
        if (!stale) setState({ kind: 'ready', diff });
      },
      (error: Error) => {
        if (!stale) setState({ kind: 'error', message: error.message });
      }
    );
    return () => {
      stale = true;
    };
  }, [mode, pr, params, paramAttempt]);

  /** Re-fetch the current mode's diff in place (409 recovery) without resetting focus. */
  const refreshDiff = useCallback(async () => {
    const diff = await fetchDiff(mode, params);
    setLoadedStubs({});
    setState({ kind: 'ready', diff });
  }, [mode, params]);

  // The response patch omits stub files (spec §6.4), so rendering is driven by the
  // server's files[]; parsed segments back only the files whose content arrived.
  const parsedByPath = useMemo(() => {
    if (state.kind !== 'ready') return new Map<string, FileDiffMetadata>();
    const parsed = parsePatchFiles(state.diff.patch).flatMap((p) => p.files);
    return new Map(parsed.map((f) => [f.name, f]));
  }, [state]);

  const files = state.kind === 'ready' ? state.diff.files : [];
  const visibleFiles = selectedFile ? files.filter((f) => f.path === selectedFile) : files;
  const drafts = useMemo(() => comments.filter((c) => c.status === 'draft'), [comments]);

  // Inline notes: drafts and open always; resolved behind the toggle; dismissed never
  const visibleComments = useMemo(
    () =>
      comments.filter(
        (c) => c.status === 'draft' || c.status === 'open' || (c.status === 'resolved' && showResolved)
      ),
    [comments, showResolved]
  );

  const openComposer = useCallback((target: ComposerTarget) => {
    setComposer(target);
    setFileComposer(null);
    setEditingId(null);
  }, []);

  const openFileComposer = useCallback((path: string) => {
    setFileComposer(path);
    setComposer(null);
    setEditingId(null);
  }, []);

  const cancelComposer = useCallback(() => {
    setComposer(null);
    setFileComposer(null);
    setEditingId(null);
  }, []);

  /** The one write path for local comment changes — keeps the epoch bump paired with the update. */
  const applyComments = useCallback((updater: (prev: Comment[]) => Comment[]) => {
    commentsEpoch.current++;
    setComments(updater);
  }, []);

  /** Wraps a comment mutation so failures surface in the error bar instead of vanishing. */
  const mutate = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
      setApiError(null);
    } catch (error) {
      setApiError((error as Error).message);
    }
  }, []);

  const loadStub = useCallback(
    (path: string) =>
      mutate(async () => {
        const { patch } = await fetchFilePatch(mode, params, path);
        const parsed = parsePatchFiles(patch).flatMap((p) => p.files)[0];
        if (!parsed) throw new Error(`could not parse the diff for ${path}`);
        setLoadedStubs((prev) => ({ ...prev, [path]: parsed }));
      }),
    [mode, params, mutate]
  );

  const addDraft = useCallback(
    (anchor: CommentAnchor, body: string) =>
      mutate(async () => {
        const created = await createDraft(body, anchor);
        applyComments((c) => [...c, created]);
        setComposer(null);
        setFileComposer(null);
      }),
    [mutate, applyComments]
  );

  const saveDraftBody = useCallback(
    (id: string, body: string) =>
      mutate(async () => {
        const updated = await updateDraft(id, { body });
        applyComments((c) => c.map((x) => (x.id === id ? updated : x)));
        setEditingId(null);
      }),
    [mutate, applyComments]
  );

  const removeDraft = useCallback(
    (id: string) =>
      mutate(async () => {
        await deleteDraft(id);
        applyComments((c) => c.filter((x) => x.id !== id));
      }),
    [mutate, applyComments]
  );

  const dismiss = useCallback(
    (id: string) =>
      mutate(async () => {
        const dismissed = await dismissComment(id);
        applyComments((c) => c.map((x) => (x.id === id ? dismissed : x)));
      }),
    [mutate, applyComments]
  );

  const openPastReview = useCallback(
    (id: string) =>
      mutate(async () => {
        const review = await fetchReview(id);
        setPastReview(review);
        setComposer(null);
        setFileComposer(null);
        setEditingId(null);
        setPopoverOpen(false);
      }),
    [mutate]
  );

  const closePastReview = useCallback(() => setPastReview(null), []);

  const submitDrafts = useCallback(
    async (summary: string) => {
      if (state.kind !== 'ready') return;
      setSubmitting(true);
      try {
        const body = summary.trim();
        const { comments: flipped } = await submitReview({
          mode: state.diff.mode,
          params: state.diff.params,
          hash: state.diff.hash,
          ...(body ? { body } : {}),
        });
        const byId = new Map(flipped.map((c) => [c.id, c]));
        applyComments((c) => c.map((x) => byId.get(x.id) ?? x));
        setPopoverOpen(false);
        setApiError(null);
        // Submit created a review and may have pruned old ones — refresh the panel
        fetchReviews().then(setReviews, () => {});
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setPopoverOpen(false);
          try {
            await refreshDiff();
            setApiError(
              'The diff changed since it was loaded — refreshed. Your drafts are kept; review and submit again.'
            );
          } catch {
            setApiError(
              'The diff changed since it was loaded, and refreshing it failed — reload the page. Your drafts are kept.'
            );
          }
        } else {
          setApiError((error as Error).message);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [state, refreshDiff, applyComments]
  );

  return (
    <div className="app" data-theme={themeType}>
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo">reviewd</span>
          {repoPath && <span className="repo-chip">{repoPath}</span>}
          <nav className="mode-switch">
            {MODES.map((m) => (
              <button
                key={m.id}
                className={mode === m.id ? 'active' : ''}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </nav>
          {mode === 'branch' && (
            <ParamForm
              key="base"
              value={base}
              placeholder="base branch"
              ariaLabel="Base branch"
              onCommit={(v) => {
                setBase(v);
                setParamAttempt((a) => a + 1);
              }}
            />
          )}
          {mode === 'pr' && (
            <ParamForm
              key="pr"
              value={pr}
              placeholder="PR number"
              ariaLabel="PR number"
              pattern="[0-9]+"
              onCommit={(v) => {
                setPr(v);
                setParamAttempt((a) => a + 1);
              }}
            />
          )}
        </div>
        <div className="topbar-right">
          <button
            className="ghost"
            onClick={() => setDiffStyle((s) => (s === 'unified' ? 'split' : 'unified'))}
            title="Toggle split / unified"
          >
            {diffStyle === 'unified' ? 'Unified' : 'Split'}
          </button>
          <button
            className="ghost"
            onClick={() => setThemeType((t) => (t === 'dark' ? 'light' : 'dark'))}
            title="Toggle theme"
          >
            {themeType === 'dark' ? 'Dark' : 'Light'}
          </button>
          <label className="toggle" title="Show or hide resolved comments">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />
            Resolved
          </label>
          <div className="popover-wrap">
            <button
              className="primary"
              disabled={state.kind !== 'ready' || drafts.length === 0 || pastReview !== null}
              title={drafts.length === 0 ? 'Draft a comment first' : undefined}
              onClick={() => setPopoverOpen((o) => !o)}
            >
              Review changes
              {drafts.length > 0 && <span className="badge">{drafts.length}</span>}
            </button>
            {popoverOpen && (
              <ReviewPopover
                drafts={drafts}
                submitting={submitting}
                onSubmit={submitDrafts}
                onClose={() => setPopoverOpen(false)}
              />
            )}
          </div>
        </div>
      </header>

      {apiError && (
        <div className="error-bar">
          {apiError}
          <button className="ghost small" onClick={() => setApiError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          {/* useFileTree treats paths as initial config, so remount whenever the diff changes */}
          {pastReview === null && state.kind === 'ready' && (
            <Tree key={`${mode}:${state.diff.hash}`} files={files} onSelect={setSelectedFile} />
          )}
          <ReviewsPanel
            draftCount={drafts.length}
            reviews={reviews}
            activeId={pastReview?.id ?? null}
            onSelect={openPastReview}
            onCurrent={closePastReview}
          />
        </aside>

        {pastReview !== null ? (
          <main className="diffs">
            <PastReviewView
              review={pastReview}
              notes={comments.filter((c) => c.reviewId === pastReview.id)}
              diffStyle={diffStyle}
              themeType={themeType}
              onBack={closePastReview}
            />
          </main>
        ) : (
        <main className="diffs">
          {state.kind === 'loading' && <p className="placeholder">Loading diff…</p>}
          {state.kind === 'prompt' && <p className="placeholder">{state.message}</p>}
          {state.kind === 'error' && <p className="placeholder error">{state.message}</p>}
          {state.kind === 'ready' && files.length === 0 && (
            <p className="placeholder">No changes in this diff.</p>
          )}
          {selectedFile && (
            <div className="focus-bar">
              <span>
                Showing <code>{selectedFile}</code>
              </span>
              <button className="ghost small" onClick={() => setSelectedFile(null)}>
                Show all files
              </button>
            </div>
          )}
          {visibleFiles.map((file) => {
            const notes = visibleComments.filter((n) => n.anchor.file === file.path);
            if (file.binary) {
              return (
                <BinaryFileCard
                  key={file.path}
                  file={file}
                  notes={notes}
                  composerOpen={fileComposer === file.path}
                  onOpenComposer={openFileComposer}
                  onCancelComposer={cancelComposer}
                  onAddDraft={addDraft}
                  onDeleteDraft={removeDraft}
                  onDismiss={dismiss}
                />
              );
            }
            const parsed = loadedStubs[file.path] ?? parsedByPath.get(file.path);
            if (file.stub && !loadedStubs[file.path]) {
              return (
                <StubFileCard
                  key={file.path}
                  file={file}
                  notes={notes}
                  onLoad={loadStub}
                  onDeleteDraft={removeDraft}
                  onDismiss={dismiss}
                />
              );
            }
            if (!parsed) return null;
            return (
              <FileSection
                key={file.path}
                file={parsed}
                diffStyle={diffStyle}
                themeType={themeType}
                notes={notes}
                composer={composer?.file === file.path ? composer : null}
                editingId={editingId}
                onOpenComposer={openComposer}
                onCancelComposer={cancelComposer}
                onAddDraft={addDraft}
                onEditDraft={setEditingId}
                onSaveDraftBody={saveDraftBody}
                onDeleteDraft={removeDraft}
                onDismiss={dismiss}
              />
            );
          })}
        </main>
        )}
      </div>
    </div>
  );
}

/** Sidebar list of past reviews plus the pending-drafts row (spec §7 Review history). */
function ReviewsPanel({
  draftCount,
  reviews,
  activeId,
  onSelect,
  onCurrent,
}: {
  draftCount: number;
  reviews: ReviewSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCurrent: () => void;
}) {
  return (
    <section className="reviews-panel">
      <h2>Reviews</h2>
      <button className={`review-row ${activeId === null ? 'active' : ''}`} onClick={onCurrent}>
        <span>Current diff</span>
        <span className="muted">
          {draftCount === 0 ? 'No pending drafts' : `${draftCount} pending draft${draftCount === 1 ? '' : 's'}`}
        </span>
      </button>
      {[...reviews].reverse().map((r) => (
        <button
          key={r.id}
          className={`review-row ${activeId === r.id ? 'active' : ''}`}
          onClick={() => onSelect(r.id)}
        >
          <span>{formatDate(r.submittedAt)}</span>
          <span className="muted">
            {r.commentCount} comment{r.commentCount === 1 ? '' : 's'} · {r.mode}
          </span>
        </button>
      ))}
      {reviews.length === 0 && <p className="muted">No submitted reviews yet.</p>}
    </section>
  );
}

/** Read-only rendering of a past review's pinned patch with its comments inline (spec §7). */
function PastReviewView({
  review,
  notes,
  diffStyle,
  themeType,
  onBack,
}: {
  review: Review;
  notes: Comment[];
  diffStyle: 'unified' | 'split';
  themeType: ThemeTypes;
  onBack: () => void;
}) {
  const files = useMemo(
    () => parsePatchFiles(review.patch).flatMap((p) => p.files),
    [review.patch]
  );
  const fileNames = useMemo(() => new Set(files.map((f) => f.name)), [files]);
  // File-scoped comments (binary files) and any file the patch parser skipped
  // have no diff line to attach to, so they render as standalone cards below.
  const detached = notes.filter(
    (n) => n.anchor.side === null || !fileNames.has(n.anchor.file)
  );

  return (
    <>
      <div className="past-banner">
        <span>
          Viewing past review · submitted {formatDate(review.submittedAt)} · {notes.length}{' '}
          comment{notes.length === 1 ? '' : 's'}
        </span>
        <button className="ghost small" onClick={onBack}>
          Back to current diff
        </button>
      </div>
      {review.body && (
        <div className="file-section review-summary">
          <p>{review.body}</p>
        </div>
      )}
      {files.map((file) => (
        <PastFileSection
          key={`${review.id}:${file.name}`}
          file={file}
          notes={notes.filter((n) => n.anchor.file === file.name && n.anchor.side !== null)}
          diffStyle={diffStyle}
          themeType={themeType}
        />
      ))}
      {detached.map((note) => (
        <div key={note.id} className="file-section stub-card">
          <div className="stub-head">
            <code>{note.anchor.file}</code>
            <span className="muted">File-level comment</span>
          </div>
          <CommentNote note={note} />
        </div>
      ))}
    </>
  );
}

/** The live view's diff card without any of its interaction: no selection, no composer. */
function PastFileSection({
  file,
  notes,
  diffStyle,
  themeType,
}: {
  file: FileDiffMetadata;
  notes: Comment[];
  diffStyle: 'unified' | 'split';
  themeType: ThemeTypes;
}) {
  const annotations = useMemo(() => noteAnnotations(notes), [notes]);

  const options = useMemo(() => ({ diffStyle, themeType }), [diffStyle, themeType]);

  return (
    <div className="file-section">
      <FileDiff<Anno>
        fileDiff={file}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={(a) =>
          a.metadata.kind === 'note' ? <CommentNote note={a.metadata.note} /> : null
        }
      />
    </div>
  );
}

/** Small topbar input whose value only takes effect on submit (Enter / Load). */
function ParamForm({
  value,
  placeholder,
  ariaLabel,
  pattern,
  onCommit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  pattern?: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <form
      className="param-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(text.trim());
      }}
    >
      <input
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel}
        pattern={pattern}
        required
        onChange={(e) => setText(e.target.value)}
      />
      <button className="ghost small" type="submit">
        Load
      </button>
    </form>
  );
}

function Tree({
  files,
  onSelect,
}: {
  files: DiffFile[];
  onSelect: (path: string | null) => void;
}) {
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  // Renamed files list under their new path (spec §6.2) with the tree's rename badge
  const gitStatus = useMemo(
    () => files.map((f) => ({ path: f.path, status: f.status })),
    [files]
  );
  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
    onSelectionChange: (selected) => {
      onSelect(selected[0] ?? null);
    },
  });

  return (
    <div className="tree-wrap">
      <FileTree model={model} />
    </div>
  );
}

interface FileSectionProps {
  file: FileDiffMetadata;
  diffStyle: 'unified' | 'split';
  themeType: ThemeTypes;
  notes: Comment[];
  composer: ComposerTarget | null;
  editingId: string | null;
  onOpenComposer: (target: ComposerTarget) => void;
  onCancelComposer: () => void;
  onAddDraft: (anchor: CommentAnchor, body: string) => void;
  onEditDraft: (id: string) => void;
  onSaveDraftBody: (id: string, body: string) => void;
  onDeleteDraft: (id: string) => void;
  onDismiss: (id: string) => void;
}

function rangeTarget(file: string, range: SelectedLineRange): ComposerTarget {
  return { file, ...anchorRange(range) };
}

function FileSection({
  file,
  diffStyle,
  themeType,
  notes,
  composer,
  editingId,
  onOpenComposer,
  onCancelComposer,
  onAddDraft,
  onEditDraft,
  onSaveDraftBody,
  onDeleteDraft,
  onDismiss,
}: FileSectionProps) {
  const annotations = useMemo(() => {
    const out = noteAnnotations(notes);
    if (composer) {
      out.push({
        side: composer.side,
        lineNumber: composer.endLine,
        metadata: { kind: 'composer' },
      });
    }
    return out;
  }, [notes, composer]);

  const selectedLines: SelectedLineRange | null = composer
    ? {
        start: composer.startLine,
        end: composer.endLine,
        side: composer.side,
        endSide: composer.side,
      }
    : null;

  const options = useMemo(
    () => ({
      diffStyle,
      themeType,
      enableLineSelection: true,
      enableGutterUtility: true,
      onLineNumberClick: (props: { lineNumber: number; annotationSide: Side }) => {
        onOpenComposer({
          file: file.name,
          side: props.annotationSide,
          startLine: props.lineNumber,
          endLine: props.lineNumber,
        });
      },
      onGutterUtilityClick: (range: SelectedLineRange) => {
        onOpenComposer(rangeTarget(file.name, range));
      },
      onLineSelectionEnd: (range: SelectedLineRange | null) => {
        if (range) onOpenComposer(rangeTarget(file.name, range));
      },
    }),
    [diffStyle, themeType, file.name, onOpenComposer]
  );

  const openCount = notes.filter((n) => n.status === 'open').length;
  const draftCount = notes.filter((n) => n.status === 'draft').length;
  const headerParts = [
    openCount > 0 && `${openCount} open`,
    draftCount > 0 && `${draftCount} draft${draftCount === 1 ? '' : 's'}`,
  ].filter(Boolean);

  return (
    <div className="file-section">
      <FileDiff<Anno>
        fileDiff={file}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        renderHeaderMetadata={() =>
          headerParts.length > 0 ? (
            <span className="header-meta">{headerParts.join(' · ')}</span>
          ) : null
        }
        renderAnnotation={(a) => {
          const meta = a.metadata;
          if (meta.kind === 'composer') {
            return (
              <Composer
                onSubmit={(body) => {
                  if (!composer) return;
                  onAddDraft(
                    {
                      file: composer.file,
                      side: composer.side,
                      startLine: composer.startLine,
                      endLine: composer.endLine,
                      excerpt: extractExcerpt(
                        file,
                        composer.side,
                        composer.startLine,
                        composer.endLine
                      ),
                    },
                    body
                  );
                }}
                onCancel={onCancelComposer}
              />
            );
          }
          const note = meta.note;
          if (note.status === 'draft' && editingId === note.id) {
            return (
              <Composer
                initialBody={note.body}
                submitLabel="Save"
                onSubmit={(body) => onSaveDraftBody(note.id, body)}
                onCancel={onCancelComposer}
              />
            );
          }
          return (
            <CommentNote
              note={note}
              onEdit={note.status === 'draft' ? onEditDraft : undefined}
              onDelete={note.status === 'draft' ? onDeleteDraft : undefined}
              onDismiss={note.status === 'open' ? onDismiss : undefined}
            />
          );
        }}
      />
    </div>
  );
}

/** Stub row for a binary change (spec §6.3): no diff, one file-level comment thread. */
function BinaryFileCard({
  file,
  notes,
  composerOpen,
  onOpenComposer,
  onCancelComposer,
  onAddDraft,
  onDeleteDraft,
  onDismiss,
}: {
  file: DiffFile;
  notes: Comment[];
  composerOpen: boolean;
  onOpenComposer: (path: string) => void;
  onCancelComposer: () => void;
  onAddDraft: (anchor: CommentAnchor, body: string) => void;
  onDeleteDraft: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const label =
    file.status === 'added'
      ? 'Binary file added'
      : file.status === 'deleted'
        ? 'Binary file deleted'
        : 'Binary file changed';
  return (
    <div className="file-section stub-card">
      <div className="stub-head">
        <code>
          {file.oldPath ? `${file.oldPath} → ` : ''}
          {file.path}
        </code>
        <span className="muted">
          {label}
          {file.size !== undefined && ` · ${formatBytes(file.size)}`}
        </span>
        {!composerOpen && notes.length === 0 && (
          <button className="ghost small" onClick={() => onOpenComposer(file.path)}>
            Comment
          </button>
        )}
      </div>
      {notes.map((note) => (
        <CommentNote
          key={note.id}
          note={note}
          onDelete={note.status === 'draft' ? onDeleteDraft : undefined}
          onDismiss={note.status === 'open' ? onDismiss : undefined}
        />
      ))}
      {composerOpen && (
        <Composer
          onSubmit={(body) => onAddDraft(fileScopedAnchor(file.path), body)}
          onCancel={onCancelComposer}
        />
      )}
    </div>
  );
}

/** Collapsed row for a large or generated file (spec §6.4); content loads on demand. */
function StubFileCard({
  file,
  notes,
  onLoad,
  onDeleteDraft,
  onDismiss,
}: {
  file: DiffFile;
  notes: Comment[];
  onLoad: (path: string) => void;
  onDeleteDraft: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="file-section stub-card">
      <div className="stub-head">
        <code>
          {file.oldPath ? `${file.oldPath} → ` : ''}
          {file.path}
        </code>
        <span className="muted">
          {file.changedLines.toLocaleString()} changed lines · collapsed (large or generated file)
        </span>
        <button className="ghost small" onClick={() => onLoad(file.path)}>
          Load diff
        </button>
      </div>
      {/* Comments on a still-collapsed file surface here rather than staying hidden */}
      {notes.map((note) => (
        <CommentNote
          key={note.id}
          note={note}
          onDelete={note.status === 'draft' ? onDeleteDraft : undefined}
          onDismiss={note.status === 'open' ? onDismiss : undefined}
        />
      ))}
    </div>
  );
}

const CHIPS: Record<Comment['status'], { className: string; label: string }> = {
  draft: { className: 'chip-draft', label: 'Draft' },
  open: { className: 'chip-open', label: 'Open' },
  resolved: { className: 'chip-resolved', label: '✓ Resolved' },
  dismissed: { className: 'chip-dismissed', label: 'Dismissed' },
};

function CommentNote({
  note,
  onEdit,
  onDelete,
  onDismiss,
}: {
  note: Comment;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  const chip = CHIPS[note.status];
  return (
    <div className={`note status-${note.status}`}>
      <div className="note-head">
        <span className={`chip ${chip.className}`}>{chip.label}</span>
        <span className="muted">{formatLines(note.anchor)}</span>
        {(onEdit || onDelete || onDismiss) && (
          <div className="note-actions">
            {onEdit && (
              <button className="ghost small" onClick={() => onEdit(note.id)}>
                Edit
              </button>
            )}
            {onDelete && (
              <button className="ghost small" onClick={() => onDelete(note.id)}>
                Delete
              </button>
            )}
            {onDismiss && (
              <button
                className="ghost small"
                title="Retire this comment without a fix"
                onClick={() => onDismiss(note.id)}
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
      <p>{note.body}</p>
    </div>
  );
}

function ReviewPopover({
  drafts,
  submitting,
  onSubmit,
  onClose,
}: {
  drafts: Comment[];
  submitting: boolean;
  onSubmit: (summary: string) => void;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState('');
  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="popover" role="dialog" aria-label="Submit review">
        <textarea
          autoFocus
          rows={3}
          placeholder="Overall summary (optional)…"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(summary);
            if (e.key === 'Escape') onClose();
          }}
        />
        <ul className="popover-drafts">
          {drafts.map((d) => (
            <li key={d.id}>
              <code>
                {d.anchor.file} · {formatLines(d.anchor)}
              </code>
              <span>{d.body}</span>
            </li>
          ))}
        </ul>
        <div className="composer-actions">
          <button className="ghost small" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary small"
            disabled={submitting}
            onClick={() => onSubmit(summary)}
          >
            {submitting
              ? 'Submitting…'
              : `Submit review (${drafts.length})`}
          </button>
        </div>
      </div>
    </>
  );
}

function Composer({
  initialBody = '',
  submitLabel = 'Add draft',
  onSubmit,
  onCancel,
}: {
  initialBody?: string;
  submitLabel?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const submit = () => {
    if (body.trim()) onSubmit(body.trim());
  };
  return (
    <div className="note composer">
      <textarea
        autoFocus
        rows={3}
        placeholder="Leave a comment for the agent…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="composer-actions">
        <button className="ghost small" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary small" disabled={!body.trim()} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
