'use client';

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import type { editor } from 'monaco-editor';
import { useEditorStore } from '../../../store/editor-store';
import {
  getCommandsForSection,
  filterCommands,
  groupCommandsByCategory,
  type Command,
} from './CommandRegistry';
import type { DSLSection } from './DSLContextDetector';

interface CommandPaletteWidgetProps {
  editorRef: RefObject<editor.IStandaloneCodeEditor | null>;
  projectId?: string;
  onCommandSelect?: (command: Command) => void;
}

export function CommandPaletteWidget({
  editorRef,
  projectId,
  onCommandSelect,
}: CommandPaletteWidgetProps) {
  const isOpen = useEditorStore((s) => s.commandPaletteOpen);
  const position = useEditorStore((s) => s.commandPalettePosition);
  const section = useEditorStore((s) => s.commandPaletteSection) as DSLSection | null;
  const setOpen = useEditorStore((s) => s.setCommandPaletteOpen);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = section ? getCommandsForSection(section) : [];
  const filtered = filterCommands(commands, query);
  const grouped = groupCommandsByCategory(filtered);
  const flatFiltered = filtered;

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Focus happens after render
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatFiltered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = flatFiltered[selectedIndex];
        if (cmd) selectCommand(cmd);
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, flatFiltered, selectedIndex]);

  const close = useCallback(() => {
    setOpen(false);
    editorRef.current?.focus();
  }, [setOpen, editorRef]);

  const selectCommand = useCallback(
    (cmd: Command) => {
      close();

      // Remove the "/" character that triggered the palette
      const ed = editorRef.current;
      if (ed) {
        const pos = ed.getPosition();
        if (pos) {
          const model = ed.getModel();
          if (model) {
            const lineContent = model.getLineContent(pos.lineNumber);
            const slashIndex = lineContent.lastIndexOf('/', pos.column - 1);
            if (slashIndex >= 0) {
              ed.executeEdits('command-palette', [
                {
                  range: {
                    startLineNumber: pos.lineNumber,
                    startColumn: slashIndex + 1,
                    endLineNumber: pos.lineNumber,
                    endColumn: pos.column,
                  },
                  text: '',
                  forceMoveMarkers: true,
                },
              ]);
            }
          }
        }
      }

      onCommandSelect?.(cmd);
    },
    [close, editorRef, onCommandSelect],
  );

  if (!isOpen || !position) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.1 }}
        className="fixed z-50"
        style={{ top: position.top, left: position.left }}
      >
        <div className="w-[320px] bg-background-elevated border border-default rounded-lg shadow-xl overflow-hidden">
          {/* Context badge */}
          {section && section !== 'root' && (
            <div className="px-3 py-1.5 text-xs text-accent bg-accent-subtle border-b border-default">
              Context: {section.toUpperCase()} section
            </div>
          )}

          {/* Search (hidden for small palettes, shown for root) */}
          {section === 'root' && (
            <div className="px-3 py-2 border-b border-default">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="Search commands..."
                className="w-full px-2 py-1 text-xs bg-background-muted border border-default rounded-md text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus"
              />
            </div>
          )}

          {/* Command list */}
          <div
            className="max-h-[320px] overflow-y-auto"
            role="listbox"
            aria-label="Available commands"
          >
            {Object.entries(grouped).map(([category, categoryCommands]) => (
              <div key={category}>
                {Object.keys(grouped).length > 1 && (
                  <div
                    className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-subtle bg-background-muted"
                    role="presentation"
                    aria-label={`${category} commands`}
                  >
                    {category}
                  </div>
                )}
                {categoryCommands.map((cmd) => {
                  const globalIdx = flatFiltered.indexOf(cmd);
                  return (
                    <button
                      key={cmd.id}
                      role="option"
                      aria-selected={globalIdx === selectedIndex}
                      className={clsx(
                        'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-default',
                        globalIdx === selectedIndex
                          ? 'bg-accent-subtle border-l-2 border-accent text-foreground'
                          : 'text-foreground-muted hover:bg-background-muted',
                      )}
                      onClick={() => selectCommand(cmd)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      aria-label={`${cmd.label}: ${cmd.description}`}
                    >
                      <span className="font-mono font-semibold text-foreground-muted">
                        {cmd.label}
                      </span>
                      <span className="text-subtle ml-auto">{cmd.description}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-3 py-1.5 text-[10px] text-subtle border-t border-default flex gap-3">
            <span>
              <kbd className="px-1 py-0.5 bg-background-muted rounded text-[9px]">↑↓</kbd> Navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-background-muted rounded text-[9px]">⏎</kbd> Select
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-background-muted rounded text-[9px]">Esc</kbd> Close
            </span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
