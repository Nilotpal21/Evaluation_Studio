// apps/studio/src/components/arch/panels/ArchDiffEditor.tsx
'use client';

/**
 * ArchDiffEditor — Read-only Monaco DiffEditor for ABL modifications.
 *
 * Mirrors ArchDSLViewer.tsx's language registration (ABL tokenizer, abl-dark
 * theme, hover provider) but uses Monaco's DiffEditor so the user sees a
 * proper side-by-side (or inline) diff with syntax highlighting.
 *
 * Error markers: only errors with a definite line AND no agent field become
 * gutter markers on the modified side. Dependent-agent errors and line-less
 * errors must be rendered in a separate banner by the caller.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { DiffEditor, type DiffOnMount, type Monaco } from '@monaco-editor/react';
import type { editor, IDisposable } from 'monaco-editor';
import { ablYamlTokenizer } from '@/lib/abl-monarch';
import { getHoverInfo } from '@abl/language-service';

export interface ArchDiffEditorErrorMarker {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ArchDiffEditorProps {
  original: string;
  modified: string;
  fileName: string;
  renderSideBySide?: boolean;
  errorMarkers?: ArchDiffEditorErrorMarker[];
  className?: string;
}

export interface ArchDiffEditorHandle {
  /** Scroll the modified side so the given line is centered. */
  jumpToLine: (line: number) => void;
}

export const ArchDiffEditor = forwardRef<ArchDiffEditorHandle, ArchDiffEditorProps>(
  function ArchDiffEditor(
    { original, modified, fileName, renderSideBySide = true, errorMarkers, className },
    ref,
  ) {
    const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const disposablesRef = useRef<IDisposable[]>([]);
    // Tracks whether this instance is currently mounted. Cleared BEFORE refs
    // are nulled during unmount so any in-flight deferred work (e.g. a queued
    // applyErrorMarkers microtask) bails out before touching disposed models.
    const mountedRef = useRef(true);
    // Tracks the latest errorMarkers so handleMount can apply them if the
    // effect below fired before the editor mounted (initial render on a
    // blocked-state reload is the trigger case).
    const errorMarkersRef = useRef<ArchDiffEditorErrorMarker[] | undefined>(errorMarkers);

    useImperativeHandle(ref, () => ({
      jumpToLine(line: number) {
        const modifiedEditor = editorRef.current?.getModifiedEditor();
        if (modifiedEditor) {
          modifiedEditor.revealLineInCenter(line);
          modifiedEditor.setPosition({ lineNumber: line, column: 1 });
        }
      },
    }));

    // Extracted so both the effect (reactive updates) and handleMount
    // (initial mount after effect already ran) can apply markers.
    const applyErrorMarkers = useCallback((markers: ArchDiffEditorErrorMarker[] | undefined) => {
      // Bail out if we're mid-unmount or a deferred microtask survived past
      // the component's lifetime — touching models during Monaco's own
      // setModel/dispose sequence triggers "TextModel got disposed before
      // DiffEditorWidget model got reset".
      if (!mountedRef.current) return;
      const monaco = monacoRef.current;
      const diffEditor = editorRef.current;
      if (!monaco || !diffEditor) return;
      const modifiedModel = diffEditor.getModifiedEditor().getModel();
      // Guard: model may already be disposed during unmount
      if (!modifiedModel || modifiedModel.isDisposed()) return;

      if (!markers || markers.length === 0) {
        monaco.editor.setModelMarkers(modifiedModel, 'arch-ai-validation', []);
        return;
      }

      const lineCount = modifiedModel.getLineCount();
      const monacoMarkers: editor.IMarkerData[] = markers
        // Drop markers whose line number exceeds the current model (stale markers from old content)
        .filter((m) => m.line >= 1 && m.line <= lineCount)
        .map((m) => ({
          startLineNumber: m.line,
          startColumn: 1,
          endLineNumber: m.line,
          endColumn: modifiedModel.getLineMaxColumn(m.line),
          message: m.message,
          severity:
            m.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        }));

      monaco.editor.setModelMarkers(modifiedModel, 'arch-ai-validation', monacoMarkers);
    }, []);

    const handleMount: DiffOnMount = useCallback(
      (diffEditor, monaco) => {
        editorRef.current = diffEditor;
        monacoRef.current = monaco;

        // Register ABL language (idempotent)
        monaco.languages.register({ id: 'abl' });
        monaco.languages.setMonarchTokensProvider('abl', ablYamlTokenizer);

        monaco.editor.defineTheme('abl-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'keyword', foreground: '6ea1f7', fontStyle: 'bold' },
            { token: 'type.identifier', foreground: '34d399' },
            { token: 'string', foreground: 'fbbf24' },
            { token: 'number', foreground: '60a5fa' },
            { token: 'constant', foreground: '60a5fa' },
            { token: 'comment', foreground: '6b7280' },
            { token: 'operator', foreground: 'f9fafb' },
            { token: 'variable', foreground: 'f472b6' },
          ],
          colors: {
            'editor.background': '#0a0a0a',
            'editor.foreground': '#fafafa',
            'editor.lineHighlightBackground': '#1a1a1a',
            'editor.selectionBackground': '#3b82f633',
            'editorCursor.foreground': '#3b82f6',
            'editorLineNumber.foreground': '#525252',
            'editorLineNumber.activeForeground': '#a3a3a3',
          },
        });
        monaco.editor.setTheme('abl-dark');

        const hoverDisposable = monaco.languages.registerHoverProvider('abl', {
          provideHover(model, position) {
            const info = getHoverInfo(model.getValue(), {
              line: position.lineNumber,
              column: position.column,
            });
            if (!info) return null;
            return {
              contents: [{ value: info.contents }],
              range: {
                startLineNumber: info.line,
                startColumn: 1,
                endLineNumber: info.line,
                endColumn: model.getLineMaxColumn(info.line),
              },
            };
          },
        });
        disposablesRef.current.push(hoverDisposable);

        // If markers were set before the editor mounted (e.g. blocked-state
        // page reload), apply them now — the effect below already ran with
        // null refs and returned early, so this is the only remaining path.
        applyErrorMarkers(errorMarkersRef.current);
      },
      [applyErrorMarkers],
    );

    useEffect(() => {
      errorMarkersRef.current = errorMarkers;
      // Defer to the next microtask. When `errorMarkers`, `original`, and
      // `modified` update in the same render (the common case — validation
      // result arrives with a new proposal), @monaco-editor/react's internal
      // setValue/setModel runs during this effect tick. Deferring lets that
      // settle so we never call setModelMarkers against a model that Monaco
      // is mid-way through replacing.
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        applyErrorMarkers(errorMarkers);
      });
      return () => {
        cancelled = true;
      };
    }, [errorMarkers, applyErrorMarkers]);

    useEffect(() => {
      return () => {
        // Mark unmounted FIRST so any deferred microtask that fires after
        // this cleanup bails out before touching models.
        mountedRef.current = false;
        const diffEditor = editorRef.current;
        const monaco = monacoRef.current;
        const diffModel = diffEditor?.getModel();

        if (monaco && diffModel) {
          if (!diffModel.original.isDisposed()) {
            monaco.editor.setModelMarkers(diffModel.original, 'arch-ai-validation', []);
          }
          if (!diffModel.modified.isDisposed()) {
            monaco.editor.setModelMarkers(diffModel.modified, 'arch-ai-validation', []);
          }
        }

        if (diffEditor && diffModel) {
          diffEditor.setModel(null);
        }

        editorRef.current = null;
        monacoRef.current = null;
        for (const d of disposablesRef.current) d.dispose();
        disposablesRef.current = [];
      };
    }, []);

    const filePath = `src/agents/${fileName}.abl.yaml`;

    return (
      <div className={`flex h-full flex-col ${className ?? ''}`}>
        <div className="flex-shrink-0 border-b border-border/50 px-3 py-1.5 text-[10px] font-mono text-foreground-muted/50">
          {filePath}
        </div>
        <div className="flex-1 min-h-0">
          <DiffEditor
            height="100%"
            language="abl"
            original={original}
            modified={modified}
            onMount={handleMount}
            theme="abl-dark"
            options={{
              readOnly: true,
              renderSideBySide,
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              padding: { top: 12, bottom: 12 },
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
          />
        </div>
      </div>
    );
  },
);
