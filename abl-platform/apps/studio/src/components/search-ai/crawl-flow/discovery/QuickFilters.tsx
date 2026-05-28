'use client';

/**
 * QuickFilters — Single-select filter for the discovery tree.
 *
 * Uses SegmentedControl. Options: All / Selected / Suggested / Unexplored / Errors.
 * Each shows a count badge. Composes with existing search filter.
 */

import { useMemo } from 'react';
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl';
import type { UnifiedTreeStats } from './unified-tree-types';

export type QuickFilterValue = 'all' | 'selected' | 'suggested' | 'unexplored' | 'errors';

export interface QuickFiltersProps {
  stats: UnifiedTreeStats;
  value: QuickFilterValue;
  onChange: (value: QuickFilterValue) => void;
}

export function QuickFilters({ stats, value, onChange }: QuickFiltersProps) {
  const options: SegmentOption[] = useMemo(
    () => [
      { id: 'all', label: 'All', badge: stats.totalNodes },
      { id: 'selected', label: 'Selected', badge: stats.includedNodes },
      { id: 'suggested', label: 'Suggested', badge: stats.autoMatchedNodes },
      { id: 'unexplored', label: 'Unexplored', badge: stats.unexploredNodes },
      { id: 'errors', label: 'Errors', badge: stats.errorNodes },
    ],
    [stats],
  );

  // Hide filters that have 0 items (except "all" which always shows)
  const visibleOptions = useMemo(
    () => options.filter((o) => o.id === 'all' || (o.badge as number) > 0),
    [options],
  );

  // If only "all" is available, don't render the filter at all
  if (visibleOptions.length <= 1) return null;

  return (
    <div className="px-4 pb-2" data-testid="tree-quick-filters">
      <SegmentedControl
        options={visibleOptions}
        value={value}
        onChange={(v) => onChange(v as QuickFilterValue)}
        size="sm"
        ariaLabel="Filter tree nodes"
      />
    </div>
  );
}
