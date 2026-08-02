import { useEffect, useMemo, useState } from 'react';
import { parsePatchFiles } from '@pierre/diffs';
import type { FileDiffMetadata, ThemeTypes } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { fetchDiff, fetchHealth, type DiffMode, type DiffResponse } from './api';
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

export default function App() {
  const [mode, setMode] = useState<DiffMode>('uncommitted');
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('split');
  const [themeType, setThemeType] = useState<ThemeTypes>('dark');
  const [state, setState] = useState<DiffState>({ kind: 'loading' });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState('');

  useEffect(() => {
    fetchHealth().then(
      (h) => setRepoPath(h.repoPath),
      () => setRepoPath('')
    );
  }, []);

  useEffect(() => {
    let stale = false;
    setState({ kind: 'loading' });
    setSelectedFile(null);
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
        </div>
      </header>

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
            <FileSection key={file.name} file={file} diffStyle={diffStyle} themeType={themeType} />
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

function FileSection({
  file,
  diffStyle,
  themeType,
}: {
  file: FileDiffMetadata;
  diffStyle: 'unified' | 'split';
  themeType: ThemeTypes;
}) {
  const options = useMemo(() => ({ diffStyle, themeType }), [diffStyle, themeType]);
  return (
    <div className="file-section">
      <FileDiff fileDiff={file} options={options} />
    </div>
  );
}
