'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '@/components/ui/Dialog';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import {
  Bold,
  Italic,
  Code,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Minus,
  Eye,
  Pencil,
  Undo2,
  Redo2,
  X,
} from 'lucide-react';
import clsx from 'clsx';

interface MarkdownEditorModalProps {
  open: boolean;
  onClose: () => void;
  fieldName: string;
  initialValue: string;
  onSave: (value: string) => void;
}

type ViewMode = 'write' | 'preview';

/** Toolbar formatting action */
interface FormatAction {
  icon: React.ElementType;
  label: string;
  shortcut?: string;
  action: (textarea: HTMLTextAreaElement, value: string) => { text: string; cursor: number };
}

function wrapSelection(
  textarea: HTMLTextAreaElement,
  value: string,
  before: string,
  after: string,
): { text: string; cursor: number } {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = value.slice(start, end);

  if (selected) {
    const newText = value.slice(0, start) + before + selected + after + value.slice(end);
    return { text: newText, cursor: start + before.length + selected.length + after.length };
  }
  // No selection — insert placeholder
  const placeholder = 'text';
  const newText = value.slice(0, start) + before + placeholder + after + value.slice(end);
  return { text: newText, cursor: start + before.length };
}

function prefixLine(
  textarea: HTMLTextAreaElement,
  value: string,
  prefix: string,
): { text: string; cursor: number } {
  const start = textarea.selectionStart;
  // Find start of current line
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const newText = value.slice(0, lineStart) + prefix + value.slice(lineStart);
  return { text: newText, cursor: start + prefix.length };
}

const FORMAT_ACTIONS: FormatAction[] = [
  {
    icon: Bold,
    label: 'Bold',
    shortcut: 'B',
    action: (ta, v) => wrapSelection(ta, v, '**', '**'),
  },
  {
    icon: Italic,
    label: 'Italic',
    shortcut: 'I',
    action: (ta, v) => wrapSelection(ta, v, '*', '*'),
  },
  {
    icon: Code,
    label: 'Code',
    shortcut: '`',
    action: (ta, v) => wrapSelection(ta, v, '`', '`'),
  },
  {
    icon: Heading1,
    label: 'Heading 1',
    action: (ta, v) => prefixLine(ta, v, '# '),
  },
  {
    icon: Heading2,
    label: 'Heading 2',
    action: (ta, v) => prefixLine(ta, v, '## '),
  },
  {
    icon: List,
    label: 'Bullet list',
    action: (ta, v) => prefixLine(ta, v, '- '),
  },
  {
    icon: ListOrdered,
    label: 'Numbered list',
    action: (ta, v) => prefixLine(ta, v, '1. '),
  },
  {
    icon: Quote,
    label: 'Quote',
    action: (ta, v) => prefixLine(ta, v, '> '),
  },
  {
    icon: Minus,
    label: 'Divider',
    action: (_ta, v) => {
      const pos = _ta.selectionStart;
      const before = v.slice(0, pos);
      const after = v.slice(pos);
      const needsNewline = before.length > 0 && !before.endsWith('\n');
      const divider = (needsNewline ? '\n' : '') + '---\n';
      return { text: before + divider + after, cursor: pos + divider.length };
    },
  },
];

export function MarkdownEditorModal({
  open,
  onClose,
  fieldName,
  initialValue,
  onSave,
}: MarkdownEditorModalProps) {
  const t = useTranslations('abl_editor.markdown_editor');
  const [value, setValue] = useState(initialValue);
  const [mode, setMode] = useState<ViewMode>('write');
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setMode('write');
      setUndoStack([]);
      setRedoStack([]);
      setTimeout(() => textareaRef.current?.focus(), 150);
    }
  }, [open, initialValue]);

  const pushUndo = useCallback((prev: string) => {
    setUndoStack((s) => [...s.slice(-50), prev]);
    setRedoStack([]);
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, value]);
    setValue(prev);
  }, [undoStack, value]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s, value]);
    setValue(next);
  }, [redoStack, value]);

  const applyFormat = useCallback(
    (action: FormatAction) => {
      const ta = textareaRef.current;
      if (!ta) return;
      pushUndo(value);
      const result = action.action(ta, value);
      setValue(result.text);
      // Restore cursor after React re-render
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(result.cursor, result.cursor);
      });
    },
    [value, pushUndo],
  );

  const handleSave = useCallback(() => {
    onSave(value);
    onClose();
  }, [value, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+Enter → save
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        handleSave();
        return;
      }

      // Cmd+B → bold
      if (mod && e.key === 'b') {
        e.preventDefault();
        applyFormat(FORMAT_ACTIONS[0]);
        return;
      }

      // Cmd+I → italic
      if (mod && e.key === 'i') {
        e.preventDefault();
        applyFormat(FORMAT_ACTIONS[1]);
        return;
      }

      // Cmd+E → code
      if (mod && e.key === 'e') {
        e.preventDefault();
        applyFormat(FORMAT_ACTIONS[2]);
        return;
      }

      // Cmd+Z → undo
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Cmd+Shift+Z → redo
      if (mod && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Tab → insert 2 spaces
      if (e.key === 'Tab') {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        pushUndo(value);
        const newVal = value.slice(0, start) + '  ' + value.slice(end);
        setValue(newVal);
        requestAnimationFrame(() => {
          ta.setSelectionRange(start + 2, start + 2);
        });
      }
    },
    [handleSave, applyFormat, handleUndo, handleRedo, value, pushUndo],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      pushUndo(value);
      setValue(e.target.value);
    },
    [value, pushUndo],
  );

  const isDirty = value !== initialValue;
  const displayName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1).toLowerCase();
  const charCount = value.length;
  const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="4xl">
      <div className="flex flex-col">
        {/* Header with title, badge, and close button */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-foreground">
              {t('title', { field: displayName })}
            </h2>
            <span className="text-xs font-mono text-accent bg-accent-subtle px-2 py-1 rounded-md">
              {fieldName.toUpperCase()}
            </span>
            {isDirty && <span className="w-2 h-2 rounded-full bg-warning animate-pulse-soft" />}
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
            aria-label="Close dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Write / Preview toggle */}
        <div className="flex items-center justify-end mb-4">
          <div className="flex items-center bg-background-muted rounded-lg p-0.5">
            <button
              onClick={() => setMode('write')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-default',
                mode === 'write'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted hover:text-foreground',
              )}
            >
              <Pencil className="w-3.5 h-3.5" />
              {t('write')}
            </button>
            <button
              onClick={() => setMode('preview')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-default',
                mode === 'preview'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted hover:text-foreground',
              )}
            >
              <Eye className="w-3.5 h-3.5" />
              {t('preview')}
            </button>
          </div>
        </div>

        {/* Formatting toolbar — only in write mode */}
        {mode === 'write' && (
          <div className="flex items-center gap-0.5 px-1 py-1.5 mb-3 border border-default rounded-lg bg-background-subtle">
            {FORMAT_ACTIONS.map((action, i) => (
              <span key={action.label} className="contents">
                {/* Separator after code, after heading2, after numbered list */}
                {(i === 3 || i === 5 || i === 7) && <span className="w-px h-5 bg-default mx-1" />}
                <button
                  onClick={() => applyFormat(action)}
                  className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-md transition-default"
                  title={
                    action.shortcut ? `${action.label} (Cmd+${action.shortcut})` : action.label
                  }
                >
                  <action.icon className="w-4 h-4" />
                </button>
              </span>
            ))}

            <span className="w-px h-5 bg-default mx-1" />

            {/* Undo / Redo */}
            <button
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-md transition-default disabled:opacity-30"
              title="Undo (Cmd+Z)"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-md transition-default disabled:opacity-30"
              title="Redo (Cmd+Shift+Z)"
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Content area */}
        <div className="min-h-[400px] max-h-[60vh] rounded-lg border border-default overflow-hidden">
          {mode === 'write' ? (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              className={clsx(
                'w-full h-full min-h-[400px] p-6 bg-background text-foreground text-sm leading-relaxed',
                'resize-none focus:outline-none',
                'placeholder:text-subtle',
              )}
              style={{ fontFamily: 'var(--font-sans), system-ui, sans-serif' }}
              placeholder={`Start writing your ${displayName.toLowerCase()} here...\n\nTip: Use the toolbar above or keyboard shortcuts:\n  Cmd+B for bold\n  Cmd+I for italic\n  Cmd+E for code`}
              spellCheck
            />
          ) : (
            <div className="p-6 h-full min-h-[400px] overflow-y-auto bg-background">
              {value.trim() ? (
                <MarkdownContent content={value} className="text-sm max-w-prose" />
              ) : (
                <p className="text-sm text-subtle italic">{t('nothing_to_preview')}</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-default">
          <div className="flex items-center gap-4 text-xs text-subtle">
            <span>{t('word_count', { count: wordCount })}</span>
            <span>{t('char_count', { count: charCount })}</span>
            <span className="text-subtle/50">
              {t('save_shortcut', {
                key: navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl',
              })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted hover:text-foreground rounded-lg hover:bg-background-muted transition-default"
            >
              {t('cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty}
              className={clsx(
                'px-5 py-2 text-sm font-medium rounded-lg transition-default focus-ring',
                'bg-accent text-accent-foreground hover:bg-accent-muted',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {t('save')}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
