/**
 * SiteSelector Component
 *
 * Displays discovered SharePoint sites with selection controls.
 * Features:
 * - Search filtering
 * - Checkbox selection
 * - Site metadata display (name, URL, document count, size)
 * - Select All / Deselect All
 * - Save selection
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Search, Check, X, Loader2, Database, FileText, HardDrive } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Checkbox } from '../ui/Checkbox';
import { useDiscoveredSites, useSelectedSites } from '../../hooks/useDiscoveredSites';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// TYPES
// =============================================================================

interface SiteSelectorProps {
  connectorId: string;
  onSelectionChange?: (siteIds: string[]) => void;
  onClose?: () => void;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SiteSelector({ connectorId, onSelectionChange, onClose }: SiteSelectorProps) {
  const t = useTranslations('search_ai.site_selector');
  const [searchTerm, setSearchTerm] = useState('');
  const [localSelectedIds, setLocalSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Fetch discovered sites
  const { sites, isLoading, error, mutate } = useDiscoveredSites(connectorId, {
    search: searchTerm,
    limit: 100,
  });

  // Fetch current selection
  const { siteIds: currentSelection, mode, updateSelection } = useSelectedSites(connectorId);

  // Initialize local selection from server data
  useMemo(() => {
    if (mode === 'selected' && currentSelection.length > 0) {
      setLocalSelectedIds(new Set(currentSelection));
    }
  }, [currentSelection, mode]);

  // Filter sites by search term — supports comma-separated multi-search
  // e.g. "marketing, engineering" matches sites containing "marketing" OR "engineering"
  const filteredSites = useMemo(() => {
    if (!searchTerm) return sites;
    const terms = searchTerm
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length === 0) return sites;
    return sites.filter((site) =>
      terms.some(
        (term) =>
          site.name.toLowerCase().includes(term) ||
          site.displayName.toLowerCase().includes(term) ||
          site.url.toLowerCase().includes(term) ||
          site.id.toLowerCase().includes(term),
      ),
    );
  }, [sites, searchTerm]);

  // Handlers
  const handleToggleSite = (siteId: string) => {
    setLocalSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) {
        next.delete(siteId);
      } else {
        next.add(siteId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setLocalSelectedIds(new Set(filteredSites.map((s) => s.id)));
  };

  const handleDeselectAll = () => {
    setLocalSelectedIds(new Set());
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const siteIdsArray = Array.from(localSelectedIds);

      if (siteIdsArray.length === 0) {
        toast.error(t('select_at_least_one'));
        return;
      }

      await updateSelection(siteIdsArray, 'selected');
      toast.success(t('selection_updated', { count: siteIdsArray.length }));

      if (onSelectionChange) {
        onSelectionChange(siteIdsArray);
      }

      if (onClose) {
        onClose();
      }
    } catch (err) {
      const message = sanitizeError(err, t('save_failed_fallback'));
      toast.error(t('save_failed', { message }));
    } finally {
      setSaving(false);
    }
  };

  // Render loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-foreground-muted" />
        <span className="ml-2 text-sm text-foreground-subtle">{t('loading')}</span>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="p-8 text-center">
        <div className="rounded-lg bg-error-subtle p-4 text-error">
          <p className="font-medium">{t('load_failed')}</p>
          <p className="mt-1 text-sm">{error}</p>
          <Button onClick={() => mutate()} variant="secondary" size="sm" className="mt-4">
            {t('retry')}
          </Button>
        </div>
      </div>
    );
  }

  // Render empty state
  if (sites.length === 0) {
    return (
      <div className="p-8 text-center">
        <Database className="mx-auto h-12 w-12 text-foreground-muted" />
        <p className="mt-2 text-sm text-foreground-subtle">{t('empty_state')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with search and bulk actions */}
      <div className="border-b bg-background-elevated p-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
            <Input
              type="text"
              placeholder={t('search_placeholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
          <Button onClick={handleSelectAll} variant="secondary" size="sm">
            {t('select_all')}
          </Button>
          <Button onClick={handleDeselectAll} variant="secondary" size="sm">
            {t('deselect_all')}
          </Button>
        </div>

        <div className="mt-2 text-sm text-foreground-subtle">
          {t('selection_count', { selected: localSelectedIds.size, total: filteredSites.length })}
        </div>
      </div>

      {/* Site list — 2-column grid for better browsing */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filteredSites.map((site) => {
            const isSelected = localSelectedIds.has(site.id);

            return (
              <div
                key={site.id}
                onClick={() => handleToggleSite(site.id)}
                className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                  isSelected
                    ? 'border-accent bg-accent-subtle'
                    : 'border-default bg-background-elevated hover:border-foreground/20 hover:bg-background-muted'
                }`}
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={isSelected}
                    onChange={() => handleToggleSite(site.id)}
                    className="mt-0.5"
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-medium text-foreground truncate">
                        {site.displayName}
                      </h4>
                      {isSelected && <Check className="h-3.5 w-3.5 text-accent shrink-0" />}
                    </div>

                    <p className="mt-0.5 text-xs text-foreground-muted truncate">{site.url}</p>

                    {/* Site metadata */}
                    {site.profile && (
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-foreground-subtle">
                        <div className="flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          <span>
                            {t('documents_count', {
                              count: site.profile.totalDocuments.toLocaleString(),
                            })}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <HardDrive className="h-3 w-3" />
                          <span>{formatBytes(site.profile.totalSizeBytes)}</span>
                        </div>
                        {site.profile.lastActivityDate && (
                          <div className="flex items-center gap-1">
                            <span>
                              {t('last_activity', {
                                date: new Date(site.profile.lastActivityDate).toLocaleDateString(),
                              })}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer with save button */}
      <div className="border-t bg-background-elevated p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-foreground-subtle">
            {localSelectedIds.size === 0
              ? t('select_to_continue')
              : t('ready_to_sync', { count: localSelectedIds.size })}
          </p>

          <div className="flex gap-2">
            {onClose && (
              <Button onClick={onClose} variant="secondary">
                {t('cancel')}
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={localSelectedIds.size === 0 || saving}
              className="min-w-[100px]"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('save_selection')
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
