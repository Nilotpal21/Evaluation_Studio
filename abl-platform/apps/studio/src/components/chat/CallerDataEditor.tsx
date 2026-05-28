/**
 * CallerDataEditor
 *
 * Popover with a key-value editor for caller data (session.* variables).
 * Stored in localStorage — not persisted to DB.
 * Shown as a small icon button next to the "New Chat" button.
 */

import { useState, useRef, useEffect } from 'react';
import { Settings2, Plus, X } from 'lucide-react';
import { useCallerDataStore } from '../../store/caller-data-store';

export function CallerDataEditor() {
  const entries = useCallerDataStore((s) => s.entries);
  const setEntry = useCallerDataStore((s) => s.setEntry);
  const removeEntry = useCallerDataStore((s) => s.removeEntry);
  const hasEntries = Object.keys(entries).length > 0;

  const [open, setOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleAdd = () => {
    const key = newKey.trim();
    if (!key) return;
    setEntry(key, newValue);
    setNewKey('');
    setNewValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className={`p-2 rounded-lg transition-default cursor-pointer ${
          hasEntries
            ? 'text-accent hover:text-accent-emphasis hover:bg-accent-subtle'
            : 'text-muted hover:text-foreground hover:bg-background-muted'
        }`}
        title="Session caller data"
      >
        <Settings2 className="w-4 h-4" />
        {hasEntries && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-accent rounded-full" />
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-full left-0 mt-1 z-50 w-72 bg-background border border-default rounded-lg shadow-lg"
        >
          <div className="p-3 border-b border-default">
            <div className="text-xs font-medium text-foreground">Caller Data</div>
            <div className="text-[10px] text-muted mt-0.5">
              Sent as session.* on every new chat. Stored in browser only.
            </div>
          </div>

          {/* Existing entries */}
          <div className="max-h-48 overflow-y-auto">
            {Object.entries(entries).map(([key, value]) => (
              <div
                key={key}
                className="flex items-center gap-1.5 px-3 py-1.5 border-b border-default last:border-b-0 group"
              >
                <span className="text-xs font-mono text-accent min-w-0 truncate flex-shrink-0 max-w-[90px]">
                  {key}
                </span>
                <span className="text-xs text-subtle">=</span>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setEntry(key, e.target.value)}
                  className="flex-1 min-w-0 text-xs font-mono bg-transparent text-foreground outline-none border-b border-transparent focus:border-accent"
                />
                <button
                  onClick={() => removeEntry(key)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-subtle hover:text-danger transition-default cursor-pointer flex-shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>

          {/* Add new entry */}
          <div className="p-2 border-t border-default flex items-center gap-1.5">
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="key"
              className="w-20 text-xs font-mono px-1.5 py-1 bg-background-subtle border border-default rounded text-foreground placeholder:text-subtle outline-none focus:border-accent"
            />
            <span className="text-xs text-subtle">=</span>
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="value"
              className="flex-1 min-w-0 text-xs font-mono px-1.5 py-1 bg-background-subtle border border-default rounded text-foreground placeholder:text-subtle outline-none focus:border-accent"
            />
            <button
              onClick={handleAdd}
              disabled={!newKey.trim()}
              className="p-1 rounded text-muted hover:text-foreground hover:bg-background-muted transition-default cursor-pointer disabled:opacity-30 disabled:cursor-default"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
