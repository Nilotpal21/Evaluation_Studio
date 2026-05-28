'use client';

/**
 * AdvancedFilterPanel Component
 *
 * Right-side slideout (720 px) for building filter rows.
 * Each row has: column dropdown, operator dropdown (typed per column type), value input.
 * All rows combined with AND logic. Exposes FilterTags for display above tables.
 */

import { useState, useCallback, useId } from 'react';
import { X, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilterColumnType = 'string' | 'number' | 'datetime' | 'multi_select';

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'before'
  | 'after'
  | 'is_set'
  | 'is_not_set';

export interface FilterColumn {
  key: string;
  label: string;
  type: FilterColumnType;
  /** For multi_select columns, the available options */
  options?: { value: string; label: string }[];
}

export interface FilterRow {
  id: string;
  columnKey: string;
  operator: FilterOperator;
  value: string;
}

// ---------------------------------------------------------------------------
// Filter application helper (shared across explorer tabs)
// ---------------------------------------------------------------------------

/**
 * Apply FilterRow[] to a list of records using AND logic.
 * Supports string, number, datetime, and multi_select column types.
 */
export function applyAdvancedFilters<T>(
  rows: T[],
  filters: FilterRow[],
  columns: FilterColumn[],
): T[] {
  if (filters.length === 0) return rows;

  const colMap = new Map(columns.map((c) => [c.key, c]));

  return rows.filter((row) =>
    filters.every((filter) => {
      const col = colMap.get(filter.columnKey);
      if (!col) return true;

      const rawVal = (row as Record<string, unknown>)[filter.columnKey];
      const { operator, value } = filter;

      if (operator === 'is_set') return rawVal !== undefined && rawVal !== null && rawVal !== '';
      if (operator === 'is_not_set')
        return rawVal === undefined || rawVal === null || rawVal === '';

      if (col.type === 'number') {
        const num = typeof rawVal === 'number' ? rawVal : Number(rawVal);
        const target = Number(value);
        // Exclude rows where numeric comparison is impossible
        if (isNaN(num) || isNaN(target)) return false;
        switch (operator) {
          case 'eq':
            return num === target;
          case 'neq':
            return num !== target;
          case 'gt':
            return num > target;
          case 'gte':
            return num >= target;
          case 'lt':
            return num < target;
          case 'lte':
            return num <= target;
          default:
            return true;
        }
      }

      if (col.type === 'datetime') {
        const rowDate = new Date(rawVal as string | number).getTime();
        const targetDate = new Date(value).getTime();
        if (isNaN(rowDate) || isNaN(targetDate)) return false;
        switch (operator) {
          case 'before':
            return rowDate < targetDate;
          case 'after':
            return rowDate > targetDate;
          default:
            return true;
        }
      }

      // String / multi_select
      const str = String(rawVal ?? '').toLowerCase();
      const target = value.toLowerCase();
      switch (operator) {
        case 'eq':
          return str === target;
        case 'neq':
          return str !== target;
        case 'contains':
          return str.includes(target);
        case 'not_contains':
          return !str.includes(target);
        case 'starts_with':
          return str.startsWith(target);
        case 'ends_with':
          return str.endsWith(target);
        case 'in':
          return target.split(',').some((v) => str === v.trim());
        case 'not_in':
          return !target.split(',').some((v) => str === v.trim());
        default:
          return true;
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Operator mappings per column type
// ---------------------------------------------------------------------------

const OPERATORS_BY_TYPE: Record<FilterColumnType, { value: FilterOperator; label: string }[]> = {
  string: [
    { value: 'eq', label: 'equals' },
    { value: 'neq', label: 'not equals' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'not contains' },
    { value: 'starts_with', label: 'starts with' },
    { value: 'ends_with', label: 'ends with' },
    { value: 'is_set', label: 'is set' },
    { value: 'is_not_set', label: 'is not set' },
  ],
  number: [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '!=' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '>=' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '<=' },
    { value: 'is_set', label: 'is set' },
    { value: 'is_not_set', label: 'is not set' },
  ],
  datetime: [
    { value: 'before', label: 'before' },
    { value: 'after', label: 'after' },
    { value: 'is_set', label: 'is set' },
    { value: 'is_not_set', label: 'is not set' },
  ],
  multi_select: [
    { value: 'in', label: 'is any of' },
    { value: 'not_in', label: 'is none of' },
    { value: 'is_set', label: 'is set' },
    { value: 'is_not_set', label: 'is not set' },
  ],
};

const NO_VALUE_OPERATORS = new Set<FilterOperator>(['is_set', 'is_not_set']);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AdvancedFilterPanelProps {
  open: boolean;
  onClose: () => void;
  columns: FilterColumn[];
  filters: FilterRow[];
  onChange: (filters: FilterRow[]) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdvancedFilterPanel({
  open,
  onClose,
  columns,
  filters,
  onChange,
  className,
}: AdvancedFilterPanelProps) {
  const t = useTranslations('observability');
  const panelId = useId();

  const addRow = useCallback(() => {
    const first = columns[0];
    if (!first) return;
    const ops = OPERATORS_BY_TYPE[first.type];
    const newRow: FilterRow = {
      id: `${panelId}-${Date.now()}`,
      columnKey: first.key,
      operator: ops[0].value,
      value: '',
    };
    onChange([...filters, newRow]);
  }, [columns, filters, onChange, panelId]);

  const updateRow = useCallback(
    (id: string, patch: Partial<Omit<FilterRow, 'id'>>) => {
      onChange(
        filters.map((r) => {
          if (r.id !== id) return r;
          const updated = { ...r, ...patch };
          // When column changes, reset operator + value
          if (patch.columnKey && patch.columnKey !== r.columnKey) {
            const col = columns.find((c) => c.key === patch.columnKey);
            const ops = OPERATORS_BY_TYPE[col?.type ?? 'string'];
            updated.operator = ops[0].value;
            updated.value = '';
          }
          return updated;
        }),
      );
    },
    [columns, filters, onChange],
  );

  const removeRow = useCallback(
    (id: string) => {
      onChange(filters.filter((r) => r.id !== id));
    },
    [filters, onChange],
  );

  const clearAll = useCallback(() => onChange([]), [onChange]);

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

          {/* Slideout panel */}
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className={clsx(
              'fixed right-0 top-0 bottom-0 z-50 flex flex-col',
              'w-[720px] max-w-full bg-background border-l border-default shadow-2xl',
              className,
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-default">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">{t('filters.title')}</h2>
                {filters.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-accent-subtle text-accent">
                    {filters.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {filters.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="text-xs text-muted hover:text-error transition-default"
                  >
                    {t('filters.clearAll')}
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Filter rows */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              <AnimatePresence initial={false}>
                {filters.map((row, idx) => {
                  const col = columns.find((c) => c.key === row.columnKey);
                  const colType = col?.type ?? 'string';
                  const operators = OPERATORS_BY_TYPE[colType];
                  const needsValue = !NO_VALUE_OPERATORS.has(row.operator);

                  return (
                    <motion.div
                      key={row.id}
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="flex items-start gap-2"
                    >
                      {/* AND label (after first row) */}
                      <span className="w-8 text-xs font-medium text-muted pt-2.5 shrink-0 text-center uppercase">
                        {idx === 0 ? 'Where' : 'And'}
                      </span>

                      {/* Column */}
                      <select
                        value={row.columnKey}
                        onChange={(e) => updateRow(row.id, { columnKey: e.target.value })}
                        className={clsx(
                          'w-[180px] shrink-0 appearance-none rounded-lg border border-default',
                          'bg-background-subtle text-foreground text-xs px-2 py-2',
                          'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                        )}
                      >
                        {columns.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>

                      {/* Operator */}
                      <select
                        value={row.operator}
                        onChange={(e) =>
                          updateRow(row.id, { operator: e.target.value as FilterOperator })
                        }
                        className={clsx(
                          'w-[140px] shrink-0 appearance-none rounded-lg border border-default',
                          'bg-background-subtle text-foreground text-xs px-2 py-2',
                          'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                        )}
                      >
                        {operators.map((op) => (
                          <option key={op.value} value={op.value}>
                            {op.label}
                          </option>
                        ))}
                      </select>

                      {/* Value */}
                      {needsValue && (
                        <>
                          {colType === 'multi_select' && col?.options ? (
                            <select
                              value={row.value}
                              onChange={(e) => updateRow(row.id, { value: e.target.value })}
                              className={clsx(
                                'flex-1 min-w-0 appearance-none rounded-lg border border-default',
                                'bg-background-subtle text-foreground text-xs px-2 py-2',
                                'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                              )}
                            >
                              <option value="">Select...</option>
                              {col.options.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : colType === 'datetime' ? (
                            <input
                              type="datetime-local"
                              value={row.value}
                              onChange={(e) => updateRow(row.id, { value: e.target.value })}
                              className={clsx(
                                'flex-1 min-w-0 rounded-lg border border-default',
                                'bg-background-subtle text-foreground text-xs px-2 py-2',
                                'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                              )}
                            />
                          ) : (
                            <input
                              type={colType === 'number' ? 'number' : 'text'}
                              placeholder={t('filters.valuePlaceholder')}
                              value={row.value}
                              onChange={(e) => updateRow(row.id, { value: e.target.value })}
                              className={clsx(
                                'flex-1 min-w-0 rounded-lg border border-default',
                                'bg-background-subtle text-foreground text-xs px-2 py-2 placeholder:text-subtle',
                                'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                              )}
                            />
                          )}
                        </>
                      )}

                      {/* Remove */}
                      <button
                        onClick={() => removeRow(row.id)}
                        className="p-2 shrink-0 text-muted hover:text-error transition-default rounded-lg hover:bg-background-muted"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </motion.div>
                  );
                })}
              </AnimatePresence>

              {/* Add filter button */}
              <button
                onClick={addRow}
                className={clsx(
                  'flex items-center gap-1.5 text-xs font-medium text-accent',
                  'hover:text-accent-foreground transition-default mt-2',
                )}
              >
                <Plus className="w-3.5 h-3.5" />
                {t('filters.addFilter')}
              </button>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-default flex items-center justify-end gap-3">
              <button
                onClick={onClose}
                className={clsx(
                  'px-4 py-2 text-xs font-medium rounded-lg transition-default',
                  'border border-default text-muted hover:text-foreground hover:bg-background-muted',
                )}
              >
                Close
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// FilterTags — render active filters as dismissible pills above a table
// ---------------------------------------------------------------------------

interface FilterTagsProps {
  columns: FilterColumn[];
  filters: FilterRow[];
  onChange: (filters: FilterRow[]) => void;
  className?: string;
}

export function FilterTags({ columns, filters, onChange, className }: FilterTagsProps) {
  const t = useTranslations('observability');
  if (filters.length === 0) return null;

  const colMap = new Map(columns.map((c) => [c.key, c]));

  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      {filters.map((f) => {
        const col = colMap.get(f.columnKey);
        return (
          <span
            key={f.id}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-accent-subtle text-accent border border-accent/20"
          >
            <span className="text-muted">{col?.label ?? f.columnKey}</span>
            <span>{operatorLabel(f.operator)}</span>
            {!NO_VALUE_OPERATORS.has(f.operator) && (
              <span className="text-foreground">{f.value || '...'}</span>
            )}
            <button
              onClick={() => onChange(filters.filter((r) => r.id !== f.id))}
              className="ml-0.5 p-0.5 rounded-full hover:bg-accent/20 transition-default"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}
      <button
        onClick={() => onChange([])}
        className="text-xs text-muted hover:text-error transition-default"
      >
        {t('filters.clearAll')}
      </button>
    </div>
  );
}

function operatorLabel(op: FilterOperator): string {
  const map: Record<FilterOperator, string> = {
    eq: '=',
    neq: '!=',
    contains: 'contains',
    not_contains: '!contains',
    starts_with: 'starts',
    ends_with: 'ends',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    in: 'in',
    not_in: 'not in',
    before: 'before',
    after: 'after',
    is_set: 'is set',
    is_not_set: 'is not set',
  };
  return map[op] ?? op;
}
