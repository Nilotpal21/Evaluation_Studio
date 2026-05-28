'use client';

/**
 * ArchDSLViewer — Read-only Monaco editor for ABL DSL files.
 *
 * Reuses the same ABL language registration, tokenizer, theme, and hover
 * provider as the main ABLEditor so generated agent code in Arch artifact
 * panels gets the same syntax-highlighted, hover-aware experience.
 */

import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount, type Monaco } from '@monaco-editor/react';
import type { IDisposable, editor as monacoEditor } from 'monaco-editor';
import { ablYamlTokenizer } from '@/lib/abl-monarch';
import { getHoverInfo } from '@abl/language-service';

interface ArchDSLViewerProps {
  content: string;
  fileName: string;
  isMock?: boolean;
  className?: string;
  /** When true, auto-scrolls to the bottom as content grows (streaming preview). */
  streaming?: boolean;
}

/**
 * Read-only ABL Monaco viewer with syntax highlighting and hover info.
 * Mirrors ABLEditor's language registration and theme without the
 * editing toolbar, compiler integration, or store dependencies.
 */
export function ArchDSLViewer({
  content,
  fileName,
  isMock,
  className,
  streaming,
}: ArchDSLViewerProps) {
  const disposablesRef = useRef<IDisposable[]>([]);
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const filePath = isMock ? `mock-server/${fileName}` : `src/agents/${fileName}.abl.yaml`;

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (streaming && editorRef.current) {
      const editor = editorRef.current;
      const model = editor.getModel();
      if (model && !model.isDisposed()) {
        const lineCount = model.getLineCount();
        editor.revealLine(lineCount);
      }
    }
  }, [streaming, content]);

  const handleEditorMount: OnMount = useCallback((_editor, monaco: Monaco) => {
    editorRef.current = _editor;
    // Register ABL language (idempotent — Monaco ignores duplicates)
    monaco.languages.register({ id: 'abl' });
    monaco.languages.setMonarchTokensProvider('abl', ablYamlTokenizer);

    // Define theme matching the design system (same as ABLEditor)
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

    // Hover provider — shows ABL keyword/section docs on hover
    const hoverDisposable = monaco.languages.registerHoverProvider('abl', {
      provideHover(model, position) {
        if (model.isDisposed()) return null;
        const info = getHoverInfo(model.getValue(), {
          line: position.lineNumber,
          column: position.column,
        });
        if (!info) return null;
        const lineCount = model.getLineCount();
        if (info.line < 1 || info.line > lineCount) return null;
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
  }, []);

  // Dispose hover providers on unmount — handleEditorMount's return value is ignored by Monaco
  useEffect(() => {
    return () => {
      editorRef.current = null;
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
    };
  }, []);

  return (
    <div className={`flex h-full flex-col ${className ?? ''}`}>
      {/* File path header */}
      <div className="flex-shrink-0 border-b border-border/50 px-3 py-1.5 text-[10px] font-mono text-foreground-muted/50">
        {filePath}
      </div>

      {/* Monaco editor */}
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          defaultLanguage="abl"
          value={content}
          onMount={handleEditorMount}
          theme="abl-dark"
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'var(--font-mono)',
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
            padding: { top: 12, bottom: 12 },
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
            domReadOnly: true,
          }}
        />
      </div>
    </div>
  );
}
