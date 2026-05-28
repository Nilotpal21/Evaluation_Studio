/**
 * DataFilterRow Component
 *
 * A single filter row: column dropdown, operator dropdown, value input.
 * Column source comes from the schema's filterable columns.
 * Op dropdown depends on column type (string gets = | in | contains, numeric/date gets = | in).
 */

'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { FilterSelect } from '../../ui/FilterSelect';
import { Button } from '../../ui/Button';
import type { ColumnMeta, DataFilter, FilterOp } from './types';

interface DataFilterRowProps {
  filter: DataFilter;
  columns: ColumnMeta[];
  onChange: (updated: DataFilter) => void;
  onRemove: () => void;
}

/** String-like CH types get contains; numeric/date do not */
function isStringType(chType: string): boolean {
  const lower = chType.toLowerCase();
  return (
    lower.includes('string') ||
    lower.includes('fixedstring') ||
    lower.includes('enum') ||
    lower.includes('uuid')
  );
}

function getOpsForColumn(columns: ColumnMeta[], columnName: string): FilterOp[] {
  const col = columns.find((c) => c.name === columnName);
  if (!col) return ['=', 'in'];
  if (isStringType(col.type)) return ['=', 'in', 'contains'];
  return ['=', 'in'];
}

export function DataFilterRow({ filter, columns, onChange, onRemove }: DataFilterRowProps) {
  const t = useTranslations('pipelines');

  const filterableColumns = useMemo(() => columns.filter((c) => c.filterable), [columns]);

  const columnOptions = useMemo(
    () => filterableColumns.map((c) => ({ value: c.name, label: c.name })),
    [filterableColumns],
  );

  const ops = useMemo(() => getOpsForColumn(columns, filter.column), [columns, filter.column]);

  const opOptions = useMemo(
    () =>
      ops.map((op) => ({
        value: op,
        label: op === '=' ? t('data.op_eq') : op === 'in' ? t('data.op_in') : t('data.op_contains'),
      })),
    [ops, t],
  );

  return (
    <div className="flex items-center gap-2">
      <FilterSelect
        options={columnOptions}
        value={filter.column}
        onChange={(v) => {
          const newOps = getOpsForColumn(columns, v);
          const newOp = newOps.includes(filter.op) ? filter.op : newOps[0];
          onChange({ column: v, op: newOp, value: filter.value });
        }}
      />
      <FilterSelect
        options={opOptions}
        value={filter.op}
        onChange={(v) => onChange({ ...filter, op: v as FilterOp })}
      />
      <input
        type="text"
        value={filter.value}
        onChange={(e) => onChange({ ...filter, value: e.target.value })}
        placeholder={t('data.filter_value_placeholder')}
        className="w-40 rounded-lg border border-default bg-background-subtle text-foreground text-sm py-1.5 px-2.5 placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
      />
      <Button variant="ghost" size="xs" onClick={onRemove} aria-label={t('data.remove_filter')}>
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
