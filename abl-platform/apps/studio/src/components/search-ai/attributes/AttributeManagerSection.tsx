/**
 * AttributeManagerSection
 *
 * Main orchestrator for the Attribute Manager within the KG tab.
 * Renders tier stat cards, inner tabs (Review Queue | All Attributes | Stats),
 * filter bar, and the attribute table.
 *
 * Pre-wires extension points for T-5 (merge dialog) and T-6 (bulk bar).
 */

'use client';

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import {
  Search,
  Shield,
  CheckCircle,
  Beaker,
  Sparkles,
  XCircle,
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAttributes, useReviewQueue, useAttributeStats } from '../../../hooks/useAttributes';
import { bulkAttributeAction } from '../../../api/search-ai';
import type {
  AttributeRegistryItem,
  AttributeTier,
  AttributeFilters,
} from '../../../api/search-ai';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { AttributeTable } from './AttributeTable';
import { AttributeDetailPanel } from './AttributeDetailPanel';
import { AttributeTierBadge } from './AttributeTierBadge';
import { AttributeMergeDialog } from './AttributeMergeDialog';
import { AttributeBulkBar } from './AttributeBulkBar';

interface AttributeManagerSectionProps {
  indexId: string;
}

type InnerTab = 'review' | 'all' | 'stats';

const TIER_ICONS: Record<AttributeTier, React.ReactNode> = {
  permanent: <Shield className="w-3.5 h-3.5" />,
  approved: <CheckCircle className="w-3.5 h-3.5" />,
  beta: <Beaker className="w-3.5 h-3.5" />,
  novel: <Sparkles className="w-3.5 h-3.5" />,
  discarded: <XCircle className="w-3.5 h-3.5" />,
};

export function AttributeManagerSection({ indexId }: AttributeManagerSectionProps) {
  const t = useTranslations('search_ai.kg');

  // ── Inner tab state ──
  const [selectedTab, setSelectedTab] = useState<InnerTab>('all');

  // ── Filters ──
  const [filters, setFilters] = useState<AttributeFilters>({});
  const [searchInput, setSearchInput] = useState('');

  // ── Detail panel ──
  const [selectedAttributeId, setSelectedAttributeId] = useState<string | null>(null);

  // ── T-5 extension point: merge candidate ──
  const [mergeCandidate, setMergeCandidate] = useState<{
    source: AttributeRegistryItem;
    target: AttributeRegistryItem;
  } | null>(null);

  // ── T-6 extension point: bulk selection ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── Data hooks ──
  const {
    data: attributes,
    total,
    isLoading: attrsLoading,
    mutate: refreshAttributes,
  } = useAttributes(indexId, filters);

  const {
    mergeConflicts,
    placementReview,
    typeConflicts,
    total: reviewTotal,
    isLoading: reviewLoading,
    mutate: refreshReview,
  } = useReviewQueue(indexId);

  const { data: stats, isLoading: statsLoading } = useAttributeStats(indexId);

  // ── Handlers ──
  const handleSearch = useCallback(() => {
    setFilters((prev) => ({ ...prev, search: searchInput || undefined, page: 1 }));
  }, [searchInput]);

  const handleTierFilter = useCallback((tier: AttributeTier | undefined) => {
    setFilters((prev) => ({ ...prev, tier, page: 1 }));
  }, []);

  const handleSelectAttribute = useCallback((attr: AttributeRegistryItem) => {
    setSelectedAttributeId(attr._id);
  }, []);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === attributes.length) {
        return new Set();
      }
      return new Set(attributes.map((a) => a._id));
    });
  }, [attributes]);

  const handleSave = useCallback(() => {
    refreshAttributes();
    refreshReview();
  }, [refreshAttributes, refreshReview]);

  const handleCloseDetail = useCallback(() => {
    setSelectedAttributeId(null);
  }, []);

  // T-5 extension: merge click handler (wired to review queue items)
  const handleMergeClick = useCallback(
    (source: AttributeRegistryItem, target: AttributeRegistryItem) => {
      setMergeCandidate({ source, target });
    },
    [],
  );

  // T-6 extension: bulk action handler
  const handleBulkAction = useCallback(
    async (action: 'approve' | 'discard' | 'changeTier', targetTier?: AttributeTier) => {
      if (selectedIds.size === 0) return;
      try {
        await bulkAttributeAction(indexId, action, Array.from(selectedIds), targetTier);
        toast.success(t('attr_bulk_action_success', { action, count: selectedIds.size }));
        setSelectedIds(new Set());
        refreshAttributes();
        refreshReview();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [indexId, selectedIds, refreshAttributes, refreshReview],
  );

  // ── Tier stat cards ──
  const tierCounts = stats?.byTier ?? {};

  return (
    <div className="space-y-4">
      {/* Tier Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {(['permanent', 'approved', 'beta', 'novel', 'discarded'] as AttributeTier[]).map(
          (tier) => (
            <button
              key={tier}
              onClick={() => handleTierFilter(filters.tier === tier ? undefined : tier)}
              className={clsx(
                'flex items-center gap-2.5 p-3 rounded-lg border transition-default text-left',
                filters.tier === tier
                  ? 'border-accent bg-accent/5'
                  : 'border-default hover:bg-background-muted',
              )}
            >
              <span className="text-muted">{TIER_ICONS[tier]}</span>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-semibold leading-tight">{tierCounts[tier] ?? 0}</p>
                <p className="text-xs text-muted capitalize truncate">{t(`attr_tier_${tier}`)}</p>
              </div>
            </button>
          ),
        )}
      </div>

      {/* Inner Tabs + Search */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1 bg-background-muted rounded-lg p-1">
          <button
            onClick={() => setSelectedTab('review')}
            className={clsx(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-default',
              selectedTab === 'review'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
          >
            <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" />
            {t('attr_tab_review')}
            {reviewTotal > 0 && (
              <Badge variant="warning" className="ml-1.5">
                {reviewTotal}
              </Badge>
            )}
          </button>
          <button
            onClick={() => setSelectedTab('all')}
            className={clsx(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-default',
              selectedTab === 'all'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
          >
            <ArrowUpDown className="w-3.5 h-3.5 inline mr-1.5" />
            {t('attr_tab_all')}
          </button>
          <button
            onClick={() => setSelectedTab('stats')}
            className={clsx(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-default',
              selectedTab === 'stats'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
          >
            <BarChart3 className="w-3.5 h-3.5 inline mr-1.5" />
            {t('attr_tab_stats')}
          </button>
        </div>

        {/* Search */}
        {selectedTab !== 'stats' && (
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder={t('attr_search_placeholder')}
                className="pl-8 pr-3 py-1.5 text-sm rounded-md border border-default bg-background focus:outline-none focus:ring-1 focus:ring-border-focus w-64"
              />
            </div>
          </div>
        )}
      </div>

      {/* T-6: Bulk action bar */}
      {selectedIds.size > 0 && (
        <AttributeBulkBar
          selectedCount={selectedIds.size}
          onApprove={() => handleBulkAction('approve')}
          onDiscard={() => handleBulkAction('discard')}
          onChangeTier={(tier) => handleBulkAction('changeTier', tier)}
          onClearSelection={() => setSelectedIds(new Set())}
        />
      )}

      {/* Review Queue Tab */}
      {selectedTab === 'review' && (
        <div className="space-y-4">
          {reviewLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="skeleton h-20 w-full" />
              ))}
            </div>
          ) : reviewTotal === 0 ? (
            <EmptyState
              icon={<CheckCircle className="w-4 h-4" />}
              title={t('attr_review_empty_title')}
              description={t('attr_review_empty_description')}
            />
          ) : (
            <>
              {/* Placement Review */}
              {placementReview.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-warning" />
                    {t('attr_placement_review')} ({placementReview.length})
                  </h4>
                  <div className="space-y-2">
                    {placementReview.map((attr) => (
                      <button
                        key={attr._id}
                        onClick={() => setSelectedAttributeId(attr._id)}
                        className="w-full flex items-center justify-between p-3 rounded-md border border-default hover:bg-background-muted transition-default text-left"
                      >
                        <div>
                          <p className="text-sm font-medium">
                            {attr.displayName || attr.attributeId}
                          </p>
                          <p className="text-xs text-muted">
                            {attr.productScope} &middot;{' '}
                            {t('attr_doc_count', {
                              count: (attr.documentCount ?? 0).toLocaleString(),
                            })}
                          </p>
                        </div>
                        <AttributeTierBadge tier={attr.tier} />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Merge Conflicts */}
              {mergeConflicts.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-error" />
                    {t('attr_merge_conflicts')} ({mergeConflicts.length})
                  </h4>
                  <div className="space-y-2">
                    {mergeConflicts.map((conflict) => (
                      <div
                        key={conflict.attributeId}
                        className="p-3 rounded-md border border-default"
                      >
                        <p className="text-sm font-medium mb-2">{conflict.attributeId}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {conflict.attributes.map((attr, i) => (
                            <button
                              key={attr._id}
                              onClick={() => setSelectedAttributeId(attr._id)}
                              className="text-xs px-2 py-1 rounded border border-default hover:bg-background-muted transition-default"
                            >
                              {attr.displayName || attr.attributeId}
                              <span className="ml-1 text-muted">({attr.productScope})</span>
                            </button>
                          ))}
                          {conflict.attributes.length >= 2 && (
                            <button
                              onClick={() =>
                                handleMergeClick(conflict.attributes[0], conflict.attributes[1])
                              }
                              className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground hover:opacity-90 transition-default"
                            >
                              {t('attr_merge_button')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Type Conflicts */}
              {typeConflicts.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning" />
                    {t('attr_type_conflicts')} ({typeConflicts.length})
                  </h4>
                  <div className="space-y-2">
                    {typeConflicts.map((conflict) => (
                      <div
                        key={conflict.attributeId}
                        className="p-3 rounded-md border border-default"
                      >
                        <p className="text-sm font-medium mb-2">{conflict.attributeId}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {conflict.attributes.map((attr) => (
                            <button
                              key={attr._id}
                              onClick={() => setSelectedAttributeId(attr._id)}
                              className="text-xs px-2 py-1 rounded border border-default hover:bg-background-muted transition-default"
                            >
                              {attr.dataType}
                              <span className="ml-1 text-muted">({attr.productScope})</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* All Attributes Tab */}
      {selectedTab === 'all' && (
        <div>
          {attrsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="skeleton h-12 w-full" />
              ))}
            </div>
          ) : (
            <>
              <AttributeTable
                attributes={attributes}
                onSelect={handleSelectAttribute}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
                onToggleSelectAll={handleToggleSelectAll}
              />

              {/* Simple pagination */}
              {total > (filters.limit ?? 20) && (
                <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-default">
                  <button
                    onClick={() =>
                      setFilters((prev) => ({
                        ...prev,
                        page: Math.max(1, (prev.page ?? 1) - 1),
                      }))
                    }
                    disabled={(filters.page ?? 1) <= 1}
                    className="px-3 py-1 text-sm rounded-md border border-default disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-muted transition-default"
                  >
                    {t('attr_previous')}
                  </button>
                  <span className="text-sm text-muted">
                    {t('attr_page_of', {
                      page: filters.page ?? 1,
                      total: Math.ceil(total / (filters.limit ?? 20)),
                    })}
                  </span>
                  <button
                    onClick={() =>
                      setFilters((prev) => ({
                        ...prev,
                        page: (prev.page ?? 1) + 1,
                      }))
                    }
                    disabled={(filters.page ?? 1) >= Math.ceil(total / (filters.limit ?? 20))}
                    className="px-3 py-1 text-sm rounded-md border border-default disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-muted transition-default"
                  >
                    {t('attr_next')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Stats Tab */}
      {selectedTab === 'stats' && (
        <div className="space-y-4">
          {statsLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="skeleton h-24 w-full" />
              ))}
            </div>
          ) : stats ? (
            <>
              {/* Recent Promotions */}
              {stats.recentPromotions.length > 0 && (
                <Card className="p-4" hoverable={false}>
                  <h4 className="text-sm font-medium mb-3">
                    {t('attr_recent_promotions')} ({stats.recentPromotions.length})
                  </h4>
                  <div className="space-y-2">
                    {stats.recentPromotions.map((attr) => (
                      <div key={attr._id} className="flex items-center justify-between text-sm">
                        <span>{attr.displayName || attr.attributeId}</span>
                        <AttributeTierBadge tier={attr.tier} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Recent Demotions */}
              {stats.recentDemotions.length > 0 && (
                <Card className="p-4" hoverable={false}>
                  <h4 className="text-sm font-medium mb-3">
                    {t('attr_recent_demotions')} ({stats.recentDemotions.length})
                  </h4>
                  <div className="space-y-2">
                    {stats.recentDemotions.map((attr) => (
                      <div key={attr._id} className="flex items-center justify-between text-sm">
                        <span>{attr.displayName || attr.attributeId}</span>
                        <AttributeTierBadge tier={attr.tier} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Interaction Stats */}
              {Object.keys(stats.interactionStats).length > 0 && (
                <Card className="p-4" hoverable={false}>
                  <h4 className="text-sm font-medium mb-3">{t('attr_interaction_stats')}</h4>
                  <div className="space-y-2">
                    {Object.entries(stats.interactionStats).map(([key, s]) => (
                      <div key={key} className="flex items-center justify-between text-sm">
                        <span className="text-muted">{key}</span>
                        <div className="flex items-center gap-3 text-xs">
                          <span>
                            {s.impressions} {t('attr_impressions')}
                          </span>
                          <span>
                            {s.clicks} {t('attr_clicks')}
                          </span>
                          <span>
                            {(s.clickRate * 100).toFixed(1)}
                            {t('attr_ctr')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {stats.recentPromotions.length === 0 &&
                stats.recentDemotions.length === 0 &&
                Object.keys(stats.interactionStats).length === 0 && (
                  <EmptyState
                    icon={<BarChart3 className="w-8 h-8" />}
                    title={t('attr_no_stats_yet_title')}
                    description={t('attr_no_stats_yet_description')}
                  />
                )}
            </>
          ) : (
            <EmptyState
              icon={<BarChart3 className="w-8 h-8" />}
              title={t('attr_no_stats_title')}
              description={t('attr_no_stats_description')}
            />
          )}
        </div>
      )}

      {/* T-5: AttributeMergeDialog */}
      {mergeCandidate && (
        <AttributeMergeDialog
          source={mergeCandidate.source}
          target={mergeCandidate.target}
          indexId={indexId}
          open={!!mergeCandidate}
          onClose={() => setMergeCandidate(null)}
          onMergeComplete={handleSave}
        />
      )}

      {/* Detail Panel */}
      <AttributeDetailPanel
        attributeId={selectedAttributeId}
        indexId={indexId}
        onClose={handleCloseDetail}
        onSave={handleSave}
      />
    </div>
  );
}
