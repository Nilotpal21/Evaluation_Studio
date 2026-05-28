/**
 * BrowsePreviewSidebar
 *
 * Left sidebar for Browse SDK preview.
 * Contains taxonomy tree (collapsible categories) and facet checkboxes with counts.
 * Fixed 280px width.
 */

'use client';

import { useState, useCallback } from 'react';
import { ChevronRight, FolderOpen, Folder, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { Checkbox } from '../../ui/Checkbox';
import { Badge } from '../../ui/Badge';

export interface TaxonomyNode {
  id: string;
  name: string;
  documentCount: number;
  children?: TaxonomyNode[];
}

export interface FacetValue {
  value: string;
  count: number;
  active: boolean;
}

export interface FacetGroup {
  attribute: string;
  values: FacetValue[];
}

interface BrowsePreviewSidebarProps {
  taxonomy: TaxonomyNode[];
  facets: FacetGroup[];
  selectedCategory: string | null;
  onCategorySelect: (id: string) => void;
  onFacetToggle: (attribute: string, value: string) => void;
  includeBeta: boolean;
  isLoading?: boolean;
  /** Optional slot for metadata filter panel (rendered above taxonomy) */
  metadataFilterSlot?: React.ReactNode;
}

function TaxonomyTreeNode({
  node,
  depth,
  selectedCategory,
  onCategorySelect,
}: {
  node: TaxonomyNode;
  depth: number;
  selectedCategory: string | null;
  onCategorySelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedCategory === node.id;

  return (
    <div>
      <button
        onClick={() => {
          onCategorySelect(node.id);
          if (hasChildren) setExpanded(!expanded);
        }}
        className={clsx(
          'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-default text-left',
          isSelected
            ? 'bg-accent-subtle text-accent font-medium'
            : 'text-foreground hover:bg-background-muted',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren && (
          <ChevronRight
            className={clsx('w-3.5 h-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
          />
        )}
        {!hasChildren && <span className="w-3.5 shrink-0" />}
        {expanded && hasChildren ? (
          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-muted" />
        ) : (
          <Folder className="w-3.5 h-3.5 shrink-0 text-muted" />
        )}
        <span className="truncate flex-1">{node.name}</span>
        <span className="text-xs text-subtle shrink-0">{node.documentCount}</span>
      </button>

      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TaxonomyTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedCategory={selectedCategory}
              onCategorySelect={onCategorySelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FacetSection({
  group,
  onFacetToggle,
}: {
  group: FacetGroup;
  onFacetToggle: (attribute: string, value: string) => void;
}) {
  const t = useTranslations('search_ai.browse');
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const MAX_VISIBLE = 5;

  const visibleValues = showAll ? group.values : group.values.slice(0, MAX_VISIBLE);

  return (
    <div className="py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold text-muted uppercase tracking-wider hover:text-foreground transition-default"
      >
        <span>{group.attribute}</span>
        <ChevronRight className={clsx('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
      </button>

      {expanded && (
        <div className="mt-1 space-y-0.5">
          {visibleValues.map((fv) => (
            <div key={fv.value} className="flex items-center justify-between px-2 py-0.5">
              <Checkbox
                checked={fv.active}
                onChange={() => onFacetToggle(group.attribute, fv.value)}
                label={fv.value}
              />
              <Badge variant="default" className="ml-1 text-[10px]">
                {fv.count}
              </Badge>
            </div>
          ))}
          {group.values.length > MAX_VISIBLE && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="px-2 py-1 text-xs text-accent hover:underline"
            >
              {showAll
                ? t('show_less')
                : t('show_more', { count: group.values.length - MAX_VISIBLE })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function BrowsePreviewSidebar({
  taxonomy,
  facets,
  selectedCategory,
  onCategorySelect,
  onFacetToggle,
  includeBeta,
  isLoading = false,
  metadataFilterSlot,
}: BrowsePreviewSidebarProps) {
  const t = useTranslations('search_ai.browse');
  const handleCategorySelect = useCallback(
    (id: string) => {
      onCategorySelect(id);
    },
    [onCategorySelect],
  );

  return (
    <aside className="w-[280px] shrink-0 border-r border-default bg-background overflow-y-auto">
      {/* Metadata Filters (from discovery API) */}
      {metadataFilterSlot && (
        <>
          {metadataFilterSlot}
          <div className="border-t border-default mx-3" />
        </>
      )}

      {/* KG Facets — show above categories for immediate visibility */}
      {(facets.length > 0 || isLoading) && (
        <div className="p-3">
          <h3 className="px-2 mb-1 text-xs font-semibold text-muted uppercase tracking-wider">
            {t('filters')}
          </h3>
          {isLoading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 text-muted animate-spin" />
            </div>
          )}
          {!isLoading &&
            facets.map((group) => (
              <FacetSection key={group.attribute} group={group} onFacetToggle={onFacetToggle} />
            ))}
        </div>
      )}

      {/* Divider between facets and categories */}
      {(facets.length > 0 || isLoading) && <div className="border-t border-default mx-3" />}

      {/* Taxonomy Tree */}
      <div className="p-3">
        <h3 className="px-2 mb-2 text-xs font-semibold text-muted uppercase tracking-wider">
          {t('categories')}
        </h3>
        {taxonomy.length > 0 ? (
          <div className="space-y-0.5">
            {taxonomy.map((node) => (
              <TaxonomyTreeNode
                key={node.id}
                node={node}
                depth={0}
                selectedCategory={selectedCategory}
                onCategorySelect={handleCategorySelect}
              />
            ))}
          </div>
        ) : (
          <p className="px-2 text-xs text-subtle">{t('no_categories')}</p>
        )}
      </div>
    </aside>
  );
}
