import { useCallback, useEffect, useMemo, useState } from 'react';
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
  fetchComments,
  fetchDiff,
  fetchHealth,
  submitReview,
  updateDraft,
  type Comment,
  type CommentAnchor,
  type DiffMode,
  type DiffResponse,
  type Side,
} from './api';
import { extractExcerpt } from './excerpt';
import { anchorRange } from './range';
import { fileStatus } from './status';
import './App.css';

type ModeSegment =
  | { id: DiffMode; label: string; enabled: true }
  | { id: 'branch' | 'pr'; label: string; enabled: false };

const MODES: ModeSegment[] = [
  { id: 'uncommitted', label: 'Uncommitted', enabled: true },
  { id: 'branch', label: 'Branch vs base', enabled: false },
  { id: 'pr', label: 'PR', enabled: false },
  { id: 'last-commit', label: 'Last commit', enabled: true },
];

type DiffState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; diff: DiffResponse };

interface ComposerTarget {
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
}

type Anno = { kind: 'composer' } | { kind: 'note'; note: Comment };

export default function App() {
  const [mode, setMode] = useState<DiffMode>('uncommitted');
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('split');
  const [themeType, setThemeType] = useState<ThemeTypes>('dark');
  const [state, setState] = useState<DiffState>({ kind: 'loading' });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchHealth().then(
      (h) => setRepoPath(h.repoPath),
      () => setRepoPath('')
    );
    fetchComments().then(setComments, (error: Error) => setApiError(error.message));
  }, []);

  useEffect(() => {
    let stale = false;
    setState({ kind: 'loading' });
    setSelectedFile(null);
    setComposer(null);
    fetchDiff(mode).then(
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
  }, [mode]);

  /** Re-fetch the current mode's diff in place (409 recovery) without resetting focus. */
  const refreshDiff = useCallback(async () => {
    const diff = await fetchDiff(mode);
    setState({ kind: 'ready', diff });
  }, [mode]);

  const files = useMemo(
    () =>
      state.kind === 'ready'
        ? parsePatchFiles(state.diff.patch).flatMap((p) => p.files)
        : [],
    [state]
  );

  const visibleFiles = selectedFile ? files.filter((f) => f.name === selectedFile) : files;
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
    setEditingId(null);
  }, []);

  const cancelComposer = useCallback(() => {
    setComposer(null);
    setEditingId(null);
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

  const addDraft = useCallback(
    (anchor: CommentAnchor, body: string) =>
      mutate(async () => {
        const created = await createDraft(body, anchor);
        setComments((c) => [...c, created]);
        setComposer(null);
      }),
    [mutate]
  );

  const saveDraftBody = useCallback(
    (id: string, body: string) =>
      mutate(async () => {
        const updated = await updateDraft(id, { body });
        setComments((c) => c.map((x) => (x.id === id ? updated : x)));
        setEditingId(null);
      }),
    [mutate]
  );

  const removeDraft = useCallback(
    (id: string) =>
      mutate(async () => {
        await deleteDraft(id);
        setComments((c) => c.filter((x) => x.id !== id));
      }),
    [mutate]
  );

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
        setComments((c) => c.map((x) => byId.get(x.id) ?? x));
        setPopoverOpen(false);
        setApiError(null);
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
    [state, refreshDiff]
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
                disabled={!m.enabled}
                title={m.enabled ? undefined : 'Not available yet'}
                onClick={() => m.enabled && setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </nav>
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
              disabled={state.kind !== 'ready' || drafts.length === 0}
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
          {state.kind === 'ready' && (
            <Tree key={`${mode}:${state.diff.hash}`} files={files} onSelect={setSelectedFile} />
          )}
        </aside>

        <main className="diffs">
          {state.kind === 'loading' && <p className="placeholder">Loading diff…</p>}
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
          {visibleFiles.map((file) => (
            <FileSection
              key={file.name}
              file={file}
              diffStyle={diffStyle}
              themeType={themeType}
              notes={visibleComments.filter((n) => n.anchor.file === file.name)}
              composer={composer?.file === file.name ? composer : null}
              editingId={editingId}
              onOpenComposer={openComposer}
              onCancelComposer={cancelComposer}
              onAddDraft={addDraft}
              onEditDraft={setEditingId}
              onSaveDraftBody={saveDraftBody}
              onDeleteDraft={removeDraft}
            />
          ))}
        </main>
      </div>
    </div>
  );
}

function Tree({
  files,
  onSelect,
}: {
  files: FileDiffMetadata[];
  onSelect: (path: string | null) => void;
}) {
  const paths = useMemo(() => files.map((f) => f.name), [files]);
  const gitStatus = useMemo(
    () => files.map((f) => ({ path: f.name, status: fileStatus(f) })),
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
}: FileSectionProps) {
  const annotations = useMemo(() => {
    const out: DiffLineAnnotation<Anno>[] = [];
    for (const n of notes) {
      out.push({
        side: n.anchor.side,
        lineNumber: n.anchor.endLine,
        metadata: { kind: 'note', note: n },
      });
    }
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
            />
          );
        }}
      />
    </div>
  );
}

function formatLines(anchor: CommentAnchor): string {
  return anchor.startLine === anchor.endLine
    ? `line ${anchor.endLine}`
    : `lines ${anchor.startLine}–${anchor.endLine}`;
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
}: {
  note: Comment;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const chip = CHIPS[note.status];
  return (
    <div className={`note status-${note.status}`}>
      <div className="note-head">
        <span className={`chip ${chip.className}`}>{chip.label}</span>
        <span className="muted">{formatLines(note.anchor)}</span>
        {(onEdit || onDelete) && (
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
