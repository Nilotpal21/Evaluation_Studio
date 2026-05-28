// useMonacoCommands.ts
import { useCallback, useRef } from 'react';
import type { editor, IDisposable } from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { detectDSLContext } from './DSLContextDetector';
import { useEditorStore } from '../../../store/editor-store';
import { findFieldAtLine } from '../dsl-field-utils';

interface UseMonacoCommandsOptions {
  onMarkdownEdit?: () => void;
}

/**
 * Hook that registers "/" slash command trigger and keyboard shortcuts
 * on the Monaco editor instance. Returns a setup function to call on mount.
 *
 * When cursor is in a PERSONA/GOAL field and "/" is typed,
 * opens the markdown editor directly instead of the command palette.
 */
export function useMonacoCommands(options?: UseMonacoCommandsOptions) {
  const disposablesRef = useRef<IDisposable[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** Open command palette at editor cursor position */
  const openCommandPalette = useCallback(
    (editorInstance: editor.ICodeEditor, context: ReturnType<typeof detectDSLContext>) => {
      const position = editorInstance.getPosition();
      if (!position) return;

      const coords = editorInstance.getScrolledVisiblePosition(position);
      if (!coords) return;

      const editorDom = editorInstance.getDomNode();
      if (!editorDom) return;

      const rect = editorDom.getBoundingClientRect();
      const store = useEditorStore.getState();

      store.setCommandPalettePosition({
        top: rect.top + coords.top + 20,
        left: rect.left + coords.left,
      });
      store.setCommandPaletteSection(context.section);
      store.setCommandPaletteOpen(true);
    },
    [],
  );

  const setup = useCallback((editorInstance: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    // Clean up previous disposables
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];

    // Listen for "/" keypress to trigger command palette
    const keyDisposable = editorInstance.onKeyUp((e) => {
      if (e.keyCode !== monaco.KeyCode.Slash) return;

      const position = editorInstance.getPosition();
      if (!position) return;

      const model = editorInstance.getModel();
      if (!model) return;

      // Check that "/" isn't mid-word (e.g. in a URL like https://...)
      // Allow after: start of line, whitespace, punctuation, quotes, colons
      // Only reject when preceded by a letter, digit, or another "/"
      const lineContent = model.getLineContent(position.lineNumber);
      const charBefore = lineContent[position.column - 3]; // char before the "/"
      if (charBefore && /[a-zA-Z0-9/]/.test(charBefore)) return;

      // Check if "/" is at the start of the line (only whitespace before it)
      // position.column points AFTER the "/" so we need to subtract 2 to get text before it
      const textBeforeSlash = lineContent.substring(0, position.column - 2);
      const isAtLineStart = textBeforeSlash.trim() === '';

      // Detect DSL context
      const dslContent = model.getValue();

      // Check if cursor is inside a field value (like PERSONA, GOAL)
      const field = findFieldAtLine(dslContent, position.lineNumber);
      const isInsideFieldValue =
        field && position.lineNumber >= field.headerLine && position.lineNumber <= field.endLine;

      // If inside a field value, open markdown editor
      if (isInsideFieldValue) {
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: position.column - 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        };
        editorInstance.executeEdits('slash-cmd', [{ range, text: '' }]);

        // Open markdown editor
        if (optionsRef.current?.onMarkdownEdit) {
          optionsRef.current.onMarkdownEdit();
        }
        return;
      }

      // If "/" is at the start of a line (not inside a field), treat as root context
      // to show all available commands instead of section-specific ones
      const context = isAtLineStart
        ? {
            section: 'root' as const,
            line: position.lineNumber,
            column: position.column,
            indentLevel: 0,
            availableCommands: [],
          }
        : detectDSLContext(dslContent, {
            line: position.lineNumber,
            column: position.column,
          });

      // Default: open command palette
      openCommandPalette(editorInstance, context);
    });

    // Ctrl+Space shortcut for context picker
    const ctrlSpaceAction = editorInstance.addAction({
      id: 'abl.openContextPicker',
      label: 'ABL: Open Context Picker',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space],
      run: (ed) => {
        const model = ed.getModel();
        const position = ed.getPosition();
        if (!model || !position) return;

        const context = detectDSLContext(model.getValue(), {
          line: position.lineNumber,
          column: position.column,
        });

        openCommandPalette(ed, context);
      },
    });

    disposablesRef.current.push(keyDisposable, ctrlSpaceAction);
  }, []);

  const cleanup = useCallback(() => {
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];
  }, []);

  return { setup, cleanup };
}
