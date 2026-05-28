'use client';

/**
 * ProposalScopeSection
 *
 * Displays scope configuration with site selection in a 2-column grid.
 * Shows "Document Libraries" (not "drives"), aggregate summary,
 * comma-separated search, and proper Select All / Clear Selection buttons.
 */

import { useState, useMemo } from 'react';
import { Globe, MapPin, Search } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';

interface Site {
  url?: string;
  name?: string;
  siteId?: string;
  driveCount?: number;
}

interface ProposalScopeSectionProps {
  variant: string;
  siteCount: number;
  sites: Site[];
  discoveryPending?: boolean;
  discoveryError?: string;
  onModify?: (data: { sites: Site[]; selectedSiteIds: string[] }) => void;
  labels: {
    variant_sites_selected: string;
    variant_sites_read_all: string;
    site_count: string;
    discovery_pending: string;
    no_sites: string;
  };
}

export function ProposalScopeSection({
  variant,
  siteCount,
  sites,
  discoveryPending,
  discoveryError,
  onModify,
  labels,
}: ProposalScopeSectionProps) {
  const isSitesSelected = variant === 'sites_selected';
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(sites.map((s) => s.siteId ?? s.url ?? '')),
  );
  const [searchQuery, setSearchQuery] = useState('');

  // Comma-separated multi-search
  const filteredSites = useMemo(() => {
    if (!searchQuery.trim()) return sites;
    const terms = searchQuery
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length === 0) return sites;
    return sites.filter((s) =>
      terms.some(
        (term) =>
          (s.name ?? '').toLowerCase().includes(term) ||
          (s.url ?? '').toLowerCase().includes(term) ||
          (s.siteId ?? '').toLowerCase().includes(term),
      ),
    );
  }, [sites, searchQuery]);

  const toggleSite = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Select All adds filtered sites to existing selection (preserves previous picks)
  const selectAll = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const s of filteredSites) next.add(s.siteId ?? s.url ?? '');
      return next;
    });
  // Clear removes only filtered sites from selection (preserves unfiltered picks)
  const clearSelection = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const filteredIds = new Set(filteredSites.map((s) => s.siteId ?? s.url ?? ''));
      for (const id of filteredIds) next.delete(id);
      return next;
    });
  // Clear ALL removes everything
  const clearAll = () => setSelectedIds(new Set());

  const handleApplySelection = () => {
    const selected = sites.filter((s) => selectedIds.has(s.siteId ?? s.url ?? ''));
    onModify?.({
      sites: selected,
      selectedSiteIds: Array.from(selectedIds),
    });
  };

  const selectedCount = selectedIds.size;
  const matchCount = filteredSites.length;
  const totalCount = sites.length;
  const hasChanges = selectedCount !== sites.length;

  return (
    <div className="space-y-3">
      {/* Variant indicator */}
      <div className="flex items-center gap-2">
        {isSitesSelected ? (
          <MapPin className="w-4 h-4 text-accent flex-shrink-0" />
        ) : (
          <Globe className="w-4 h-4 text-accent flex-shrink-0" />
        )}
        <span className="text-sm font-medium text-foreground">
          {isSitesSelected ? labels.variant_sites_selected : labels.variant_sites_read_all}
        </span>
        <Badge variant={isSitesSelected ? 'accent' : 'info'}>{labels.site_count}</Badge>
      </div>

      {/* Discovery pending notice */}
      {discoveryPending && <p className="text-xs text-muted">{labels.discovery_pending}</p>}

      {/* Discovery error */}
      {discoveryError && <p className="text-xs text-error">Discovery failed: {discoveryError}</p>}

      {/* Sites with checkboxes */}
      {sites.length > 0 ? (
        <div className="space-y-3">
          {/* Search + bulk actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, URL, or ID (comma-separated)..."
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-default rounded-md bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>
            <button
              type="button"
              onClick={selectAll}
              className="px-2.5 py-1.5 text-xs font-medium border border-default rounded-md bg-background-subtle text-foreground hover:bg-background-elevated"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="px-2.5 py-1.5 text-xs font-medium border border-default rounded-md bg-background-subtle text-foreground hover:bg-background-elevated"
            >
              Clear Visible
            </button>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="px-2.5 py-1.5 text-xs font-medium text-error border border-error/30 rounded-md hover:bg-error/5"
              >
                Clear All
              </button>
            )}
            <span className="text-xs font-semibold text-accent bg-accent/10 px-2.5 py-1 rounded-full">
              {selectedCount} of {totalCount} selected
            </span>
            {searchQuery.trim() && matchCount !== totalCount && (
              <span className="text-xs text-muted">
                {matchCount} {matchCount === 1 ? 'match' : 'matches'}
              </span>
            )}
          </div>

          {/* 2-column site grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 max-h-80 overflow-y-auto p-0.5">
            {filteredSites.map((site, idx) => {
              const id = site.siteId ?? site.url ?? String(idx);
              const checked = selectedIds.has(id);
              const libraryCount = site.driveCount ?? 0;
              return (
                <div
                  key={id}
                  onClick={() => toggleSite(id)}
                  className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                    checked
                      ? 'border-accent bg-accent/5'
                      : 'border-default bg-background-subtle hover:border-accent/40'
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 mt-0.5 text-[10px] ${
                      checked ? 'border-accent bg-accent text-accent-foreground' : 'border-default'
                    }`}
                  >
                    {checked && '✓'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {site.name ?? site.url ?? `Site ${idx + 1}`}
                    </div>
                    {site.url && site.name && (
                      <div className="text-[10px] text-muted truncate mt-0.5">{site.url}</div>
                    )}
                    {libraryCount > 0 && (
                      <div className="text-[10px] text-muted mt-1">
                        {libraryCount}{' '}
                        {libraryCount === 1 ? 'Document Library' : 'Document Libraries'}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Apply button when selection changed */}
          {onModify && hasChanges && (
            <div className="flex justify-end">
              <Button size="sm" onClick={handleApplySelection}>
                Apply Selection ({selectedCount} sites)
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">{labels.no_sites}</p>
      )}
    </div>
  );
}
