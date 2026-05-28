'use client';

/**
 * UnifiedTreeHeader — Title, search, view toggles, actions, and stats.
 *
 * Redesigned layout:
 *   Row 1: "Site Structure (N)" title + Search input (right)
 *   Row 2: View toggle [Smart | As Discovered | By URL] + Sitemap button
 *   Row 3: Actions [Expand All] [Collapse All] | [Select suggested] [Clear] (select mode)
 *   Row 4: Stats bar (explored, suggested, unexplored counts)
 *   Sample URLs context bar (select mode only)
 */

import { useCallback } from 'react';
import { Search, X, Check, Sparkles, Globe, ChevronDown, ChevronUp, Eye, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { UnifiedTreeStats } from './unified-tree-types';

export type TreeViewMode = 'hybrid' | 'crawl-path' | 'url-path';

const VIEW_MODE_LABELS: Record<TreeViewMode, string> = {
  hybrid: 'Smart',
  'crawl-path': 'As Discovered',
  'url-path': 'By URL',
};

export interface UnifiedTreeHeaderProps {
  stats: UnifiedTreeStats;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  /** Called when user clicks "Select suggested" */
  onSelectSuggested?: () => void;
  sampleUrls?: string[];
  mode?: 'live' | 'select';
  visitedCount?: number;
  viewMode?: TreeViewMode;
  onViewModeChange?: (mode: TreeViewMode) => void;
  hasSitemap?: boolean;
  onAddFromSitemap?: () => void;
}

export function UnifiedTreeHeader({
  stats,
  searchQuery,
  onSearchChange,
  onExpandAll,
  onCollapseAll,
  onSelectAll,
  onDeselectAll,
  onSelectSuggested,
  sampleUrls,
  mode = 'select',
  visitedCount,
  viewMode = 'hybrid',
  onViewModeChange,
  hasSitemap,
  onAddFromSitemap,
}: UnifiedTreeHeaderProps) {
  const handleClearSearch = useCallback(() => {
    onSearchChange('');
  }, [onSearchChange]);

  return (
    <>
      <div className="px-4 py-3 border-b border-default" data-testid="unified-tree-header">
        {/* Row 1: Title + Search */}
        <div className="flex items-center justify-between gap-4 mb-2">
          <div className="flex items-center gap-2 shrink-0">
            <h3 className="text-sm font-semibold text-foreground">Site Structure</h3>
            <span className="text-xs text-foreground-meta">({stats.totalNodes})</span>
          </div>
          <div className="relative flex-1 max-w-[280px]">
            <Input
              placeholder="Filter nodes..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              icon={<Search className="w-3.5 h-3.5" />}
              className="text-xs py-1.5"
              data-testid="tree-search-input"
            />
            {searchQuery && (
              <button
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-background-muted transition-colors"
              >
                <X className="w-3 h-3 text-foreground-meta" />
              </button>
            )}
          </div>
        </div>

        {/* Row 2: View toggle + Sitemap (select mode only) */}
        {mode === 'select' && onViewModeChange && (
          <div className="flex items-center justify-between mb-2" data-testid="tree-view-toggle">
            <div className="flex items-center gap-1">
              {(['hybrid', 'crawl-path', 'url-path'] as const).map((vm) => (
                <Button
                  key={vm}
                  variant={viewMode === vm ? 'primary' : 'ghost'}
                  size="xs"
                  onClick={() => onViewModeChange(vm)}
                >
                  {VIEW_MODE_LABELS[vm]}
                </Button>
              ))}
            </div>
            {hasSitemap && onAddFromSitemap && (
              <Button
                variant="ghost"
                size="xs"
                onClick={onAddFromSitemap}
                icon={<Plus className="w-3.5 h-3.5" />}
              >
                Add from Sitemap
              </Button>
            )}
          </div>
        )}

        {/* Row 3: Actions (select mode) */}
        {mode === 'select' && (
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={onExpandAll}
                icon={<ChevronDown className="w-3.5 h-3.5" />}
              >
                Expand All
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={onCollapseAll}
                icon={<ChevronUp className="w-3.5 h-3.5" />}
              >
                Collapse All
              </Button>
            </div>
            <div className="flex items-center gap-1">
              {onSelectSuggested && stats.autoMatchedNodes > 0 && (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={onSelectSuggested}
                  icon={<Sparkles className="w-3.5 h-3.5" />}
                >
                  Select suggested
                </Button>
              )}
              {stats.includedNodes > 0 && (
                <Button variant="ghost" size="xs" onClick={onDeselectAll}>
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Live mode: expand/collapse only */}
        {mode === 'live' && (
          <div className="flex items-center gap-1 mb-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={onExpandAll}
              icon={<ChevronDown className="w-3.5 h-3.5" />}
            >
              Expand All
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={onCollapseAll}
              icon={<ChevronUp className="w-3.5 h-3.5" />}
            >
              Collapse All
            </Button>
          </div>
        )}

        {/* Row 4: Stats bar */}
        <div className="flex items-center gap-3 text-[11px]" data-testid="tree-stats-bar">
          {mode === 'live' ? (
            <>
              <span className="flex items-center gap-1 text-foreground-meta">
                <Globe className="w-3 h-3" />
                {stats.totalNodes} discovered
              </span>
              {visitedCount !== undefined && visitedCount > 0 && (
                <span className="flex items-center gap-1 text-info">
                  <Eye className="w-3 h-3" />
                  {visitedCount} visited
                </span>
              )}
            </>
          ) : (
            <>
              <span className="flex items-center gap-1 text-success">
                <Check className="w-3 h-3" />
                {stats.exploredNodes} explored
              </span>
              {stats.autoMatchedNodes > 0 && (
                <span className="flex items-center gap-1 text-accent">
                  <Sparkles className="w-3 h-3" />
                  {stats.autoMatchedNodes} suggested
                </span>
              )}
              <span className="flex items-center gap-1 text-foreground-meta">
                <Globe className="w-3 h-3" />
                {stats.unexploredNodes} unexplored
              </span>
              <span className="ml-auto font-medium text-foreground">
                {stats.includedNodes} sections · {stats.includedPages} pages
              </span>
            </>
          )}
        </div>
      </div>

      {/* Sample URLs context bar — select mode only */}
      {mode !== 'live' && sampleUrls && sampleUrls.length > 0 && (
        <div
          className="px-4 py-2 bg-accent-subtle/20 border-b border-default"
          data-testid="tree-sample-urls"
        >
          <div className="text-[11px] text-foreground-meta mb-1">
            Sample URLs (drive auto-matching):
          </div>
          <div className="space-y-0.5">
            {sampleUrls.map((url) => {
              let displayPath = url;
              try {
                displayPath = new URL(url).pathname;
              } catch {
                /* use full URL */
              }
              return (
                <div key={url} className="text-[10px] text-accent font-mono truncate">
                  {displayPath}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
