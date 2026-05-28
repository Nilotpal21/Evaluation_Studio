'use client';

import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { FilterChip } from './FilterChip';
import type { FilterColumn, FilterRow } from './AdvancedFilterPanel';
import type { PageFilterChip } from '../../lib/preferences/insights-analytics-filters';

interface ActiveFiltersStripProps {
  pageChips?: PageFilterChip[];
  onRemovePageChip?: (chipKey: string) => void;
  advancedFilters?: FilterRow[];
  advancedColumns?: FilterColumn[];
  onRemoveAdvancedFilter?: (filterId: string) => void;
  onClearAll?: () => void;
  className?: string;
}

function formatOperatorLabel(operator: FilterRow['operator']): string {
  const labels: Record<FilterRow['operator'], string> = {
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

  return labels[operator] ?? operator;
}

function getAdvancedChipLabel(columns: FilterColumn[], filter: FilterRow): string {
  return columns.find((column) => column.key === filter.columnKey)?.label ?? filter.columnKey;
}

function getAdvancedChipValue(filter: FilterRow): string {
  if (filter.operator === 'is_set' || filter.operator === 'is_not_set') {
    return formatOperatorLabel(filter.operator);
  }

  return `${formatOperatorLabel(filter.operator)} ${filter.value || '...'}`;
}

export function ActiveFiltersStrip({
  pageChips = [],
  onRemovePageChip,
  advancedFilters = [],
  advancedColumns = [],
  onRemoveAdvancedFilter,
  onClearAll,
  className,
}: ActiveFiltersStripProps) {
  const t = useTranslations('observability');
  const hasPageChips = pageChips.length > 0;
  const hasAdvancedFilters = advancedFilters.length > 0;

  if (!hasPageChips && !hasAdvancedFilters) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label="Active filters"
      className={clsx(
        'flex flex-wrap items-center gap-1.5 rounded-xl border border-default bg-background-elevated/70 px-3 py-2 shadow-sm',
        className,
      )}
    >
      {pageChips.map((chip) => (
        <FilterChip
          key={chip.key}
          label={chip.label}
          value={chip.value}
          variant="muted"
          onRemove={onRemovePageChip ? () => onRemovePageChip(chip.key) : undefined}
          removeLabel={`Clear ${chip.label} filter`}
        />
      ))}

      {hasPageChips && hasAdvancedFilters ? (
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border-default" />
      ) : null}

      {advancedFilters.map((filter) => (
        <FilterChip
          key={filter.id}
          label={getAdvancedChipLabel(advancedColumns, filter)}
          value={getAdvancedChipValue(filter)}
          variant="accent"
          onRemove={onRemoveAdvancedFilter ? () => onRemoveAdvancedFilter(filter.id) : undefined}
          removeLabel={`Remove ${getAdvancedChipLabel(advancedColumns, filter)} filter`}
        />
      ))}

      {onClearAll ? (
        <button
          type="button"
          onClick={onClearAll}
          className="ml-auto text-xs text-muted hover:text-error transition-default"
        >
          {t('filters.clearAll')}
        </button>
      ) : null}
    </div>
  );
}
