'use client';

/**
 * ColumnCustomizer Component
 *
 * Right-side slideout for toggling table columns on/off and reordering via
 * drag (Framer Motion Reorder). Pinned columns are always visible and cannot
 * be turned off. State is persisted to localStorage through the useColumnConfig hook.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { X, Columns, GripVertical, Pin, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';
import { AnimatePresence, motion, Reorder } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnConfig {
  key: string;
  label: string;
  /** Column is always visible and cannot be toggled off */
  pinned?: boolean;
  /** Whether the column is currently visible */
  visible: boolean;
  /** Display order (lower = further left) */
  order: number;
}

// ---------------------------------------------------------------------------
// Hook: useColumnConfig
// ---------------------------------------------------------------------------

/**
 * Manages column visibility and order, persisted to localStorage.
 *
 * @param storageKey  Unique key for localStorage (e.g. "sessions-table-cols")
 * @param defaults    Default column definitions (first render & reset)
 */
export function useColumnConfig(storageKey: string, defaults: ColumnConfig[]) {
  const [columns, setColumns] = useState<ColumnConfig[]>(() => {
    if (typeof window === 'undefined') return defaults;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as ColumnConfig[];
        // Merge with defaults to pick up new columns added after the user's snapshot
        const savedMap = new Map(parsed.map((c) => [c.key, c]));
        return defaults.map((d) => {
          const saved = savedMap.get(d.key);
          if (saved) return { ...d, visible: saved.visible, order: saved.order };
          return d;
        });
      }
    } catch {
      // corrupt storage — fall through
    }
    return defaults;
  });

  // Persist on change
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(columns));
    } catch {
      // quota exceeded — ignore
    }
  }, [columns, storageKey]);

  const reset = useCallback(() => setColumns(defaults), [defaults]);

  /** Visible columns in display order */
  const visibleColumns = useMemo(
    () => [...columns].filter((c) => c.visible).sort((a, b) => a.order - b.order),
    [columns],
  );

  return { columns, setColumns, visibleColumns, reset } as const;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ColumnCustomizerProps {
  open: boolean;
  onClose: () => void;
  columns: ColumnConfig[];
  onChange: (columns: ColumnConfig[]) => void;
  onReset: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ColumnCustomizer({
  open,
  onClose,
  columns,
  onChange,
  onReset,
  className,
}: ColumnCustomizerProps) {
  const t = useTranslations('observability');
  // Local working copy — so reorder state is tracked in one place
  const [items, setItems] = useState(columns);

  // Sync incoming prop changes
  useEffect(() => {
    setItems(columns);
  }, [columns]);

  const sorted = useMemo(() => [...items].sort((a, b) => a.order - b.order), [items]);

  const toggleVisibility = useCallback(
    (key: string) => {
      const next = items.map((c) =>
        c.key === key && !c.pinned ? { ...c, visible: !c.visible } : c,
      );
      setItems(next);
      onChange(next);
    },
    [items, onChange],
  );

  const handleReorder = useCallback(
    (reordered: ColumnConfig[]) => {
      const withOrder = reordered.map((c, i) => ({ ...c, order: i }));
      setItems(withOrder);
      onChange(withOrder);
    },
    [onChange],
  );

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={OVERLAY_BACKDROP}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className={clsx(
              'fixed right-0 top-0 bottom-0 z-50 flex flex-col',
              'w-[400px] max-w-full bg-background border-l border-default shadow-2xl',
              className,
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-default">
              <div className="flex items-center gap-2">
                <Columns className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">
                  {t('columnCustomizer.title')}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onReset}
                  className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-default"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Reorderable list */}
            <Reorder.Group
              axis="y"
              values={sorted}
              onReorder={handleReorder}
              className="flex-1 overflow-y-auto px-5 py-3 space-y-1"
            >
              {sorted.map((col) => (
                <Reorder.Item
                  key={col.key}
                  value={col}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-default select-none',
                    col.visible
                      ? 'border-default bg-background-subtle'
                      : 'border-transparent bg-background-muted/50 opacity-60',
                  )}
                  whileDrag={{ scale: 1.02, boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}
                >
                  <GripVertical className="w-3.5 h-3.5 text-subtle cursor-grab shrink-0" />

                  <span className="flex-1 text-sm text-foreground truncate">{col.label}</span>

                  {col.pinned ? (
                    <Pin className="w-3.5 h-3.5 text-accent shrink-0" />
                  ) : (
                    <button
                      onClick={() => toggleVisibility(col.key)}
                      className="p-1 rounded text-muted hover:text-foreground transition-default"
                    >
                      {col.visible ? (
                        <Eye className="w-3.5 h-3.5" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </Reorder.Item>
              ))}
            </Reorder.Group>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-default text-xs text-muted">
              Drag to reorder. {t('columnCustomizer.pinned')} columns are always visible.
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
