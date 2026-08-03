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
  createDraft,
  deleteDraft,
  fetchComments,
  fetchDiff,
  fetchHealth,
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

type Anno = { kind: 'composer' } | { kind: 'draft'; draft: Comment };

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

  const files = useMemo(
    () =>
      state.kind === 'ready'
        ? parsePatchFiles(state.diff.patch).flatMap((p) => p.files)
        : [],
    [state]
  );

  const visibleFiles = selectedFile ? files.filter((f) => f.name === selectedFile) : files;
  const drafts = useMemo(() => comments.filter((c) => c.status === 'draft'), [comments]);

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
          <button className="primary" disabled title="Submitting reviews lands with ticket 13">
            Review changes
            {drafts.length > 0 && <span className="badge">{drafts.length}</span>}
          </button>
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
              drafts={drafts.filter((d) => d.anchor.file === file.name)}
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
  drafts: Comment[];
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
  drafts,
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
    for (const d of drafts) {
      out.push({
        side: d.anchor.side,
        lineNumber: d.anchor.endLine,
        metadata: { kind: 'draft', draft: d },
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
  }, [drafts, composer]);

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

  const draftCount = drafts.length;

  return (
    <div className="file-section">
      <FileDiff<Anno>
        fileDiff={file}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        renderHeaderMetadata={() =>
          draftCount > 0 ? (
            <span className="header-meta">
              {draftCount} draft{draftCount === 1 ? '' : 's'}
            </span>
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
          const draft = meta.draft;
          if (editingId === draft.id) {
            return (
              <Composer
                initialBody={draft.body}
                submitLabel="Save"
                onSubmit={(body) => onSaveDraftBody(draft.id, body)}
                onCancel={onCancelComposer}
              />
            );
          }
          return (
            <div className="note draft-note">
              <div className="note-head">
                <span className="chip chip-draft">Draft</span>
                <span className="muted">
                  {draft.anchor.startLine === draft.anchor.endLine
                    ? `line ${draft.anchor.endLine}`
                    : `lines ${draft.anchor.startLine}–${draft.anchor.endLine}`}
                </span>
                <div className="note-actions">
                  <button className="ghost small" onClick={() => onEditDraft(draft.id)}>
                    Edit
                  </button>
                  <button className="ghost small" onClick={() => onDeleteDraft(draft.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <p>{draft.body}</p>
            </div>
          );
        }}
      />
    </div>
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
