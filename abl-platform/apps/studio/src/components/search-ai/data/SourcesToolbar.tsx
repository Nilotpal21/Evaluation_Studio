/**
 * SourcesToolbar Component
 *
 * Extracted toolbar with search input, quick filter pills for statuses,
 * group-by selector, view mode toggle, and sort controls.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Search, LayoutGrid, List } from 'lucide-react';
import { Input } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { QuickFilterPills } from './QuickFilterPills';

export type GroupBy = 'none' | 'type' | 'status' | 'tenant';

interface SourcesToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  statusFilter: string | null;
  onStatusFilterChange: (status: string | null) => void;
  groupBy: GroupBy;
  onGroupByChange: (group: GroupBy) => void;
  viewMode: 'card' | 'table';
  onViewModeChange: (mode: string) => void;
  statusCounts: Record<string, number>;
}

export function SourcesToolbar({
  searchValue,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  groupBy,
  onGroupByChange,
  viewMode,
  onViewModeChange,
  statusCounts,
}: SourcesToolbarProps) {
  const t = useTranslations('search_ai.sources_table.toolbar');

  const viewModeOptions = useMemo(
    () => [
      { id: 'card', label: t('view_card'), icon: <LayoutGrid className="w-3.5 h-3.5" /> },
      { id: 'table', label: t('view_table'), icon: <List className="w-3.5 h-3.5" /> },
    ],
    [t],
  );

  const groupByOptions = useMemo(
    () => [
      { id: 'none', label: t('group_none') },
      { id: 'type', label: t('group_type') },
      { id: 'status', label: t('group_status') },
    ],
    [t],
  );

  return (
    <div className="space-y-2 mb-3">
      {/* Top row: search + group-by + view toggle */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <Input
            icon={<Search className="w-4 h-4" />}
            placeholder={t('search_placeholder')}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label={t('search_placeholder')}
          />
        </div>
        <SegmentedControl
          options={groupByOptions}
          value={groupBy}
          onChange={(v) => onGroupByChange(v as GroupBy)}
          size="sm"
          ariaLabel={t('group_by_label')}
        />
        <SegmentedControl
          options={viewModeOptions}
          value={viewMode}
          onChange={onViewModeChange}
          size="sm"
          ariaLabel={t('view_toggle')}
        />
      </div>

      {/* Quick filter pills */}
      <QuickFilterPills
        statusCounts={statusCounts}
        activeStatus={statusFilter}
        onStatusClick={onStatusFilterChange}
      />
    </div>
  );
}
