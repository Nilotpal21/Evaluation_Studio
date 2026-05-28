/**
 * AttributeTable
 *
 * DataTable wrapper for attribute registry items with selection checkboxes,
 * tier badges, confidence bars, and sortable columns.
 */

import { useTranslations } from 'next-intl';
import type { AttributeRegistryItem } from '../../../api/search-ai';
import { DataTable, type Column } from '../../ui/DataTable';
import { Badge } from '../../ui/Badge';
import { AttributeTierBadge } from './AttributeTierBadge';

interface AttributeTableProps {
  attributes: AttributeRegistryItem[];
  onSelect: (attr: AttributeRegistryItem) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
}

export function AttributeTable({
  attributes,
  onSelect,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: AttributeTableProps) {
  const t = useTranslations('search_ai.kg');

  const allSelected = attributes.length > 0 && attributes.every((a) => selectedIds.has(a._id));

  const columns: Column<AttributeRegistryItem>[] = [
    {
      key: 'select',
      label: '',
      width: 'w-10',
      render: (row) => (
        <input
          type="checkbox"
          checked={selectedIds.has(row._id)}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect(row._id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-default"
        />
      ),
    },
    {
      key: 'attributeId',
      label: t('attr_col_attribute'),
      sortable: true,
      sortValue: (row) => row.displayName || row.attributeId,
      render: (row) => (
        <div>
          <p className="text-sm font-medium">{row.displayName || row.attributeId}</p>
          {row.displayName && row.displayName !== row.attributeId && (
            <p className="text-xs text-muted">{row.attributeId}</p>
          )}
        </div>
      ),
    },
    {
      key: 'productScope',
      label: t('attr_col_product'),
      sortable: true,
      sortValue: (row) => row.productScope,
      render: (row) => <Badge variant="default">{row.productScope}</Badge>,
    },
    {
      key: 'tier',
      label: t('attr_col_tier'),
      sortable: true,
      sortValue: (row) => row.tier,
      render: (row) => <AttributeTierBadge tier={row.tier} />,
    },
    {
      key: 'dataType',
      label: t('attr_col_type'),
      sortable: true,
      sortValue: (row) => row.dataType,
      render: (row) => <span className="text-sm text-muted">{row.dataType}</span>,
    },
    {
      key: 'documentCount',
      label: t('attr_col_docs'),
      sortable: true,
      sortValue: (row) => row.documentCount ?? 0,
      render: (row) => (
        <span className="text-sm font-medium">{(row.documentCount ?? 0).toLocaleString()}</span>
      ),
    },
    {
      key: 'confidence',
      label: t('attr_col_confidence'),
      sortable: true,
      sortValue: (row) => row.confidence ?? 0,
      render: (row) => {
        const pct = ((row.confidence ?? 0) * 100).toFixed(0);
        return (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-background-muted rounded-full overflow-hidden max-w-[80px]">
              <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-muted">{pct}%</span>
          </div>
        );
      },
    },
    {
      key: 'updatedAt',
      label: t('attr_col_updated'),
      sortable: true,
      sortValue: (row) => row.updatedAt,
      render: (row) => (
        <span className="text-xs text-muted">{new Date(row.updatedAt).toLocaleDateString()}</span>
      ),
    },
  ];

  return (
    <div>
      {/* Select-all header */}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleSelectAll}
          className="rounded border-default"
        />
        <span className="text-xs text-muted">
          {selectedIds.size > 0
            ? t('attr_selected_count', { count: selectedIds.size })
            : t('attr_total_count', { count: attributes.length })}
        </span>
      </div>

      <DataTable
        columns={columns}
        data={attributes}
        keyExtractor={(row) => row._id}
        onRowClick={onSelect}
        emptyMessage={t('no_attributes')}
      />
    </div>
  );
}
