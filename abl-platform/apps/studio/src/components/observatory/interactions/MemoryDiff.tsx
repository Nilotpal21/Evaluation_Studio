/**
 * MemoryDiff — Git-style diff view of session state changes.
 *
 * Design spec Section 8.2. Shows:
 * - Memory reads (what the agent knew going in)
 * - Memory writes (git-style diff: added/changed/removed/unchanged)
 * - Source attribution (which tool wrote each key)
 * - Running stats footer
 */

import { useMemo, useState } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { DiffLine, type DiffType } from './DiffLine';
import type { InteractionStep } from './types';

// =============================================================================
// EXPORTED TYPES + LOGIC (testable without React)
// =============================================================================

export interface MemoryDiffEntry {
  type: DiffType;
  key: string;
  value?: string;
  oldValue?: string;
  source?: string;
}

/**
 * Compute the git-style diff between two context state objects.
 *
 * Compares before/after context snapshots and produces a list of
 * add/change/remove/unchanged entries for visualization.
 *
 * @param before - Context state before the interaction
 * @param after - Context state after the interaction
 * @param sourceMap - Optional mapping of key → tool that wrote it (for attribution)
 * @returns Array of diff entries sorted by type (added, changed, removed, unchanged)
 *
 * @remarks
 * - Values are stringified for comparison (JSON.stringify for objects)
 * - Unchanged keys are included but can be filtered for display
 * - Pure function - no side effects, suitable for unit testing
 *
 * @example
 * ```ts
 * const before = { count: 0, user: 'alice' };
 * const after = { count: 1, user: 'alice', balance: 100 };
 * const diff = computeMemoryDiff(before, after);
 * // Returns: [
 * //   { type: 'added', key: 'balance', value: '100' },
 * //   { type: 'changed', key: 'count', value: '1', oldValue: '0' },
 * //   { type: 'unchanged', key: 'user', value: 'alice' }
 * // ]
 * ```
 */
export function computeMemoryDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  sourceMap?: Record<string, string>,
): MemoryDiffEntry[] {
  const entries: MemoryDiffEntry[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const inBefore = key in before;
    const inAfter = key in after;
    const source = sourceMap?.[key];

    if (inAfter && !inBefore) {
      entries.push({
        type: 'added',
        key,
        value: stringify(after[key]),
        source,
      });
    } else if (inBefore && !inAfter) {
      entries.push({
        type: 'removed',
        key,
        oldValue: stringify(before[key]),
      });
    } else if (inBefore && inAfter) {
      const beforeStr = stringify(before[key]);
      const afterStr = stringify(after[key]);
      if (beforeStr !== afterStr) {
        entries.push({
          type: 'changed',
          key,
          value: afterStr,
          oldValue: beforeStr,
          source,
        });
      } else {
        entries.push({
          type: 'unchanged',
          key,
          value: afterStr,
        });
      }
    }
  }

  // Sort: added first, then changed, then removed, then unchanged
  const order: Record<DiffType, number> = { added: 0, changed: 1, removed: 2, unchanged: 3 };
  entries.sort((a, b) => order[a.type] - order[b.type]);

  return entries;
}

function stringify(val: unknown): string {
  if (val === undefined || val === null) return 'null';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

// =============================================================================
// REACT COMPONENT
// =============================================================================

interface MemoryDiffProps {
  step: InteractionStep;
}

export function MemoryDiff({ step }: MemoryDiffProps) {
  const [showReads, setShowReads] = useState(false);
  const styles = getIntentStyles('info');

  const { entries, stats, reads } = useMemo(() => {
    const contextBefore = (step.data.contextBefore as Record<string, unknown>) ?? {};
    const contextAfter = (step.data.contextAfter as Record<string, unknown>) ?? {};
    const sourceMap = (step.data.sourceMap as Record<string, string>) ?? {};
    const readKeys = (step.data.readKeys as string[]) ?? [];

    const diffEntries = computeMemoryDiff(contextBefore, contextAfter, sourceMap);

    const added = diffEntries.filter((e) => e.type === 'added').length;
    const changed = diffEntries.filter((e) => e.type === 'changed').length;
    const removed = diffEntries.filter((e) => e.type === 'removed').length;
    const unchanged = diffEntries.filter((e) => e.type === 'unchanged').length;

    // Build reads list
    const readEntries = readKeys.map((key) => ({
      key,
      value: stringify(contextBefore[key] ?? contextAfter[key]),
    }));

    return {
      entries: diffEntries,
      stats: { added, changed, removed, unchanged, total: diffEntries.length },
      reads: readEntries,
    };
  }, [step]);

  // If no context data, show simple summary from step events
  if (entries.length === 0 && reads.length === 0) {
    return (
      <div className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}>
        <span className="text-foreground-muted">State change</span>
        {step.data.key ? (
          <span className="ml-2 font-mono text-foreground">{String(step.data.key)}</span>
        ) : null}
        {step.data.value !== undefined ? (
          <span className="ml-1 font-mono text-success">= {stringify(step.data.value)}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Memory reads (collapsible) */}
      {reads.length > 0 && (
        <div className="border-b border-border-muted">
          <button
            onClick={() => setShowReads(!showReads)}
            aria-expanded={showReads}
            aria-label={`${showReads ? 'Hide' : 'Show'} memory reads with ${reads.length} keys`}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-background-elevated/50 transition-colors"
          >
            {showReads ? (
              <ChevronDown className="w-3 h-3 text-foreground-muted" />
            ) : (
              <ChevronRight className="w-3 h-3 text-foreground-muted" />
            )}
            <span className="text-foreground-muted font-medium">Memory Reads</span>
            <span className="text-foreground-subtle text-[9px]">{reads.length} keys</span>
          </button>
          {showReads && (
            <div
              role="region"
              aria-label="Memory reads content"
              className="px-3 pb-1.5 space-y-0.5"
            >
              {reads.map((r) => (
                <div
                  key={r.key}
                  className="flex gap-2 text-[10px] font-mono text-foreground-subtle"
                >
                  <span>{r.key}</span>
                  <span className="opacity-50">→</span>
                  <span className="truncate">{r.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Memory writes — diff lines */}
      {entries.length > 0 && (
        <div className="px-1 py-1.5 space-y-0.5">
          {entries.map((entry) => (
            <DiffLine
              key={entry.key}
              type={entry.type}
              keyName={entry.key}
              value={entry.value}
              oldValue={entry.oldValue}
              source={entry.source}
            />
          ))}
        </div>
      )}

      {/* Stats footer */}
      <div className="px-3 py-1.5 border-t border-border-muted flex items-center gap-3 text-[9px] text-foreground-subtle">
        {stats.added > 0 && <span className="text-success">● {stats.added} added</span>}
        {stats.changed > 0 && <span className="text-warning">● {stats.changed} changed</span>}
        {stats.removed > 0 && <span className="text-error">● {stats.removed} removed</span>}
        {stats.unchanged > 0 && <span>● {stats.unchanged} unchanged</span>}
        <span className="ml-auto">Total keys: {stats.total}</span>
      </div>
    </div>
  );
}
