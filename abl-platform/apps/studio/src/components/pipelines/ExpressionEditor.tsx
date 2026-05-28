/**
 * ExpressionEditor — Monaco-based editor for pipeline expression fields.
 *
 * Features (ABLP-564 Phase 5):
 *   - Handlebars syntax highlighting for {{...}} expressions
 *   - Autocomplete: suggests {{steps.<node_name>.output.<field>}} paths from
 *     upstream nodes' NodeContract.outputSchema
 *   - Error markers: red squiggle for unresolved step references or unknown
 *     output fields
 *
 * The component pulls pipeline nodes and the ContractRegistry from the
 * pipeline-editor Zustand store — no prop drilling required.
 */

'use client';

import { useRef, useCallback, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { extractExpressionRefs, type ExpressionRef } from '../../lib/pipeline-expression-utils';
import { getAvailableDataNodes } from './available-data';

export { extractExpressionRefs } from '../../lib/pipeline-expression-utils';
export type { ExpressionRef };

interface ExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** ID of the node being configured — used to exclude it from autocomplete candidates. */
  currentNodeId?: string;
  /** Number of visible rows. Defaults to 8. */
  rows?: number;
  onFocus?: (insert: (text: string) => void) => void;
}

export function ExpressionEditor({
  value,
  onChange,
  disabled = false,
  currentNodeId,
  rows = 8,
  onFocus,
}: ExpressionEditorProps) {
  const nodes = usePipelineEditorStore((s) => s.nodes);
  const edges = usePipelineEditorStore((s) => s.edges);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const providerDisposables = useRef<Monaco.IDisposable[]>([]);

  // ── Validate refs and update error markers ──────────────────────────
  const updateMarkers = useCallback(
    (text: string) => {
      if (!editorRef.current || !monacoRef.current) return;
      const model = editorRef.current.getModel();
      if (!model) return;

      const upstreamNodes = getAvailableDataNodes(nodes, edges, currentNodeId ?? '');
      const upstreamRefs = new Set(upstreamNodes.flatMap((n) => [n.id, n.referenceName]));

      const markers: Monaco.editor.IMarkerData[] = [];
      const refs = extractExpressionRefs(text);

      for (const ref of refs) {
        const pos = model.getPositionAt(ref.startIndex);
        const endPos = model.getPositionAt(ref.endIndex);
        const range = {
          startLineNumber: pos.lineNumber,
          startColumn: pos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        };

        // Check node exists in upstream
        if (!upstreamRefs.has(ref.nodeId)) {
          markers.push({
            severity: monacoRef.current.MarkerSeverity.Error,
            message: `Node "${ref.nodeId}" is not a direct upstream node name.`,
            ...range,
          });
          continue;
        }

        // Check field exists in the node's output schema
        const upstream = upstreamNodes.find(
          (n) => n.id === ref.nodeId || n.referenceName === ref.nodeId,
        );
        if (upstream) {
          const fieldNames = new Set(upstream.fields.map((field) => field.fieldPath));
          if (!fieldNames.has(ref.field)) {
            markers.push({
              severity: monacoRef.current.MarkerSeverity.Warning,
              message: `Field "${ref.field}" is not declared in ${upstream.activityType}'s output schema. Available: ${upstream.fields.map((field) => field.fieldPath).join(', ')}`,
              ...range,
            });
          }
        }
      }

      monacoRef.current.editor.setModelMarkers(model, 'expression-editor', markers);
    },
    [edges, nodes, currentNodeId],
  );

  // ── Register autocomplete provider ─────────────────────────────────
  const registerProviders = useCallback(
    (monaco: typeof Monaco) => {
      // Dispose previous providers
      for (const d of providerDisposables.current) d.dispose();
      providerDisposables.current = [];

      const completionProvider = monaco.languages.registerCompletionItemProvider('handlebars', {
        triggerCharacters: ['{', '.'],
        provideCompletionItems(model, position) {
          const textUntilPosition = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });

          const upstreamNodes = getAvailableDataNodes(nodes, edges, currentNodeId ?? '');
          const suggestions: Monaco.languages.CompletionItem[] = [];

          // "{{steps." — suggest named node references
          if (/\{\{steps\.$/.test(textUntilPosition)) {
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            for (const n of upstreamNodes) {
              suggestions.push({
                label: n.referenceName,
                kind: monaco.languages.CompletionItemKind.Variable,
                insertText: n.referenceName,
                detail: `${n.label} · ${n.activityType}`,
                range,
              });
            }
            return { suggestions };
          }

          // "{{steps.X.output." — suggest output fields
          const stepMatch = /\{\{steps\.([^.}]+)\.output\.$/.exec(textUntilPosition);
          if (stepMatch) {
            const nodeId = stepMatch[1];
            const upstream = upstreamNodes.find(
              (n) => n.id === nodeId || n.referenceName === nodeId,
            );
            if (upstream) {
              if (upstream.fields.length > 0) {
                const word = model.getWordUntilPosition(position);
                const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endColumn: word.endColumn,
                };
                for (const field of upstream.fields) {
                  suggestions.push({
                    label: field.fieldPath,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: field.fieldPath + '}}',
                    detail: field.type,
                    documentation: field.description,
                    range,
                  });
                }
              }
            }
            return { suggestions };
          }

          // "{{" → suggest full steps.X.output.Y patterns
          if (/\{\{$/.test(textUntilPosition)) {
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            for (const n of upstreamNodes) {
              for (const field of n.fields) {
                suggestions.push({
                  label: `steps.${n.referenceName}.output.${field.fieldPath}`,
                  kind: monaco.languages.CompletionItemKind.Reference,
                  insertText: `steps.${n.referenceName}.output.${field.fieldPath}}}`,
                  detail: `${n.label} · ${n.activityType}`,
                  range,
                });
              }
            }
            return { suggestions };
          }

          return { suggestions: [] };
        },
      });

      providerDisposables.current.push(completionProvider);
    },
    [edges, nodes, currentNodeId],
  );

  // ── Revalidate + re-register when nodes change ──────────────────────
  useEffect(() => {
    if (monacoRef.current) {
      registerProviders(monacoRef.current);
    }
    updateMarkers(value);
  }, [nodes, currentNodeId, registerProviders, updateMarkers, value]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const d of providerDisposables.current) d.dispose();
    };
  }, []);

  const insertText = useCallback(
    (text: string) => {
      const editor = editorRef.current;
      if (!editor) {
        onChange(`${value}${text}`);
        return;
      }

      const selection = editor.getSelection();
      const range = selection ?? editor.getModel()?.getFullModelRange();
      if (!range) {
        onChange(`${value}${text}`);
        return;
      }

      editor.executeEdits('available-data', [{ range, text, forceMoveMarkers: true }]);
      const nextValue = editor.getValue();
      onChange(nextValue);
      editor.focus();
    },
    [onChange, value],
  );

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      registerProviders(monaco);
      updateMarkers(editor.getValue());

      // Update markers on every content change
      editor.onDidChangeModelContent(() => {
        updateMarkers(editor.getValue());
      });

      editor.onDidFocusEditorText(() => {
        onFocus?.(insertText);
      });
    },
    [insertText, onFocus, registerProviders, updateMarkers],
  );

  const handleChange = useCallback(
    (newValue: string | undefined) => {
      onChange(newValue ?? '');
    },
    [onChange],
  );

  return (
    <div className="rounded-md border border-input overflow-hidden">
      <Editor
        height={`${rows * 22}px`}
        language="handlebars"
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          ariaLabel: 'Pipeline expression editor',
          minimap: { enabled: false },
          lineNumbers: 'off',
          folding: false,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          readOnly: disabled,
          suggestOnTriggerCharacters: true,
          quickSuggestions: { strings: true, other: true, comments: false },
          theme: 'vs-dark',
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          contextmenu: false,
        }}
      />
    </div>
  );
}
