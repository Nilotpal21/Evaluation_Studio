'use client';

/**
 * ScopeFiltersTab
 *
 * Single-column scrollable view matching the v5 wireframe exactly.
 * Sections: Impact, Sites, File Types, Size Limit, Exclude Patterns,
 * Date Range, Schedule, Filter Rules.
 *
 * Data sources: proposal sections (has site names), connector filterConfig,
 * discovery (often empty for fresh connectors).
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Globe,
  FileText,
  Ruler,
  Calendar,
  Clock,
  Settings2,
  ChevronDown,
  Search,
  Ban,
  X,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { toast } from 'sonner';
import { updateConnectorConfig } from '../../../api/search-ai';
import { useConnector } from '../../../hooks/useConnector';
import { useConnectorDiscovery } from '../../../hooks/useConnectorDiscovery';
import { useConnectorProposal } from '../../../hooks/useConnectorProposal';

interface ScopeFiltersTabProps {
  indexId: string;
  connectorId: string;
  onNavigateToPreview?: () => void;
}

const FILE_TYPE_PRESETS = [
  { id: 'pdf', label: 'PDF', extensions: ['.pdf'] },
  { id: 'docx', label: 'Word (.docx)', extensions: ['.docx', '.doc'] },
  { id: 'pptx', label: 'PowerPoint', extensions: ['.pptx', '.ppt'] },
  { id: 'xlsx', label: 'Excel', extensions: ['.xlsx', '.xls'] },
  { id: 'txt', label: 'Text (.txt)', extensions: ['.txt'] },
  { id: 'images', label: 'Images', extensions: ['.png', '.jpg', '.jpeg', '.gif', '.svg'] },
  { id: 'html', label: 'HTML', extensions: ['.html', '.htm'] },
  { id: 'csv', label: 'CSV', extensions: ['.csv'] },
  { id: 'md', label: 'Markdown', extensions: ['.md'] },
];

const SCHEDULE_OPTIONS = ['disabled', 'hourly', 'daily', 'weekly', 'monthly'] as const;

const DEFAULT_EXCLUDE_PATTERNS = ['~$*', '.tmp', 'Thumbs.db', '_archive/*'];

const COMMON_PATTERNS = [
  '*.bak',
  'drafts/**',
  '~$*',
  '_old/**',
  '*.tmp',
  'node_modules/**',
  '.git/**',
];

interface SiteInfo {
  id: string;
  name: string;
  url: string;
  driveCount: number;
}

export function ScopeFiltersTab({
  indexId,
  connectorId,
  onNavigateToPreview,
}: ScopeFiltersTabProps) {
  const t = useTranslations('search_ai.sharepoint.scope_filters');
  const { connector, mutate: mutateConnector } = useConnector(indexId, connectorId);
  const { discovery } = useConnectorDiscovery(connectorId);
  const { proposal } = useConnectorProposal(indexId, connectorId);

  const filterConfig = (connector?.filterConfig ?? {}) as Record<string, unknown>;
  const standardConfig = (filterConfig.standard ?? {}) as Record<string, unknown>;
  const scopeConfig = (filterConfig.scope ?? {}) as Record<string, unknown>;

  // ─── ALL sites from proposal (164 sites with names) ───
  const allSites = useMemo<SiteInfo[]>(() => {
    if (discovery?.sites && discovery.sites.length > 0) {
      return discovery.sites.map((s) => ({
        id: s.siteId,
        name: s.name,
        url: '',
        driveCount: s.libraryCount ?? 0,
      }));
    }
    const ps = (proposal?.sections?.scope?.data as Record<string, unknown>)?.sites;
    if (Array.isArray(ps)) {
      return ps.map((s: Record<string, unknown>) => ({
        id: String(s.siteId ?? s.url ?? s.name ?? ''),
        name: String(s.name ?? s.url ?? ''),
        url: String(s.url ?? ''),
        driveCount: (s.driveCount as number) ?? 0,
      }));
    }
    return [];
  }, [discovery, proposal]);

  const totalSiteCount = useMemo(() => {
    const pc = (proposal?.sections?.scope?.data as Record<string, unknown>)?.siteCount as number;
    return pc ?? allSites.length;
  }, [proposal, allSites]);

  // Site selection — derived from live connector data (SWR), never stale.
  // isAllSelected + displayIds reflect the DB. editIds is only for the picker.
  const dbSiteMode = useMemo(
    () => (scopeConfig.siteMode as string | undefined) ?? 'all',
    [scopeConfig.siteMode],
  );
  const dbSiteIds = useMemo(
    () => (scopeConfig.siteIds as string[] | undefined) ?? [],
    [scopeConfig.siteIds],
  );
  const isAllSelected = dbSiteMode !== 'selected' || dbSiteIds.length === 0;

  // Editing state — persists after picker closes until save/reset
  const [editIds, setEditIds] = useState<Set<string>>(new Set());
  const [hasEdited, setHasEdited] = useState(false);

  // The "effective" selected set: from local edits if user changed anything, else from DB
  const selectedIds = hasEdited
    ? editIds
    : new Set(isAllSelected ? allSites.map((s) => s.id) : dbSiteIds);

  // ─── Site picker state ───
  const [showSitePicker, setShowSitePicker] = useState(false);
  const [siteSearch, setSiteSearch] = useState('');

  const openSitePicker = useCallback(() => {
    // Only initialize editIds if user hasn't made edits yet
    if (!hasEdited) {
      if (isAllSelected) {
        setEditIds(new Set(allSites.map((s) => s.id)));
      } else {
        setEditIds(new Set(dbSiteIds));
      }
    }
    setShowSitePicker(true);
  }, [hasEdited, isAllSelected, allSites, dbSiteIds]);

  const closeSitePicker = useCallback(() => {
    setShowSitePicker(false);
    // Don't reset hasEdited — edits persist until save
  }, []);

  const filteredSites = useMemo(() => {
    if (!siteSearch.trim()) return allSites;
    const terms = siteSearch
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    return allSites.filter((s) =>
      terms.some(
        (term) => s.name.toLowerCase().includes(term) || s.url.toLowerCase().includes(term),
      ),
    );
  }, [allSites, siteSearch]);

  const toggleSite = useCallback((id: string) => {
    setEditIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    setHasEdited(true);
  }, []);

  // Debug: remove after confirming fix works
  // eslint-disable-next-line no-console
  console.log('[ScopeFiltersTab] RENDER:', {
    hasEdited,
    dbSiteMode,
    dbSiteIdsCount: dbSiteIds.length,
    isAllSelected,
    editIdsSize: editIds.size,
    allSitesLength: allSites.length,
    connectorLoaded: !!connector,
  });

  // Build a name lookup map from allSites
  const siteNameMap = useMemo(() => {
    const map = new Map<string, string>();
    allSites.forEach((s) => map.set(s.id, s.name));
    return map;
  }, [allSites]);

  // Resolve a list of IDs to chip objects, falling back to extracting name from composite ID
  const resolveChips = useCallback(
    (ids: string[]) =>
      ids.slice(0, 4).map((id) => ({
        id,
        name: siteNameMap.get(id) || id.split(',')[0].replace('.sharepoint.com', ''),
      })),
    [siteNameMap],
  );

  // Chips for display
  const siteChips = useMemo(() => {
    if (hasEdited) {
      if (editIds.size === 0) return [];
      return resolveChips(Array.from(editIds));
    }
    if (isAllSelected) {
      return allSites.slice(0, 4).map((s) => ({ id: s.id, name: s.name }));
    }
    return resolveChips(dbSiteIds);
  }, [allSites, dbSiteIds, isAllSelected, hasEdited, editIds, resolveChips]);
  const selectedCount = hasEdited
    ? editIds.size
    : isAllSelected
      ? totalSiteCount
      : dbSiteIds.length;
  const moreSitesCount = Math.max(0, selectedCount - siteChips.length);

  // ─── File types ───
  const currentExts = (standardConfig.fileExtensions as Record<string, unknown>)?.extensions;
  const [activeFileTypes, setActiveFileTypes] = useState<Set<string>>(() => {
    const exts = Array.isArray(currentExts) ? currentExts : [];
    const active = new Set<string>();
    FILE_TYPE_PRESETS.forEach((p) => {
      if (p.extensions.some((e) => exts.includes(e))) active.add(p.id);
    });
    if (active.size === 0) ['pdf', 'docx', 'pptx', 'xlsx', 'txt'].forEach((id) => active.add(id));
    return active;
  });

  // ─── Exclude patterns ───
  const [excludePatterns, setExcludePatterns] = useState<string[]>(() => {
    const saved = (scopeConfig.folderPaths as Record<string, unknown>)?.exclude;
    return Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_EXCLUDE_PATTERNS;
  });
  const [showAddPattern, setShowAddPattern] = useState(false);
  const [newPattern, setNewPattern] = useState('');

  const addPattern = useCallback(() => {
    const p = newPattern.trim();
    if (p && !excludePatterns.includes(p)) {
      setExcludePatterns((prev) => [...prev, p]);
      setNewPattern('');
      setShowAddPattern(false);
    }
  }, [newPattern, excludePatterns]);

  const removePattern = useCallback((pattern: string) => {
    setExcludePatterns((prev) => prev.filter((p) => p !== pattern));
  }, []);

  // ─── Other state ───
  const [maxFileSize, setMaxFileSize] = useState(() => {
    const b = standardConfig.maxFileSizeBytes as number | null;
    return b ? String(Math.round(b / (1024 * 1024))) : '50';
  });
  const [schedule, setSchedule] = useState(() => {
    const c = connector?.connectionConfig as Record<string, unknown> | undefined;
    return String(c?.syncSchedule ?? 'daily');
  });
  const [scheduleTime, setScheduleTime] = useState(() => {
    const c = connector?.connectionConfig as Record<string, unknown> | undefined;
    return String(c?.syncScheduleTime ?? '02:00');
  });
  const [scheduleDayOfWeek, setScheduleDayOfWeek] = useState(() => {
    const c = connector?.connectionConfig as Record<string, unknown> | undefined;
    return String(c?.syncScheduleDayOfWeek ?? 'monday');
  });
  const [dateFrom, setDateFrom] = useState(() => {
    return String((standardConfig.dateRange as Record<string, unknown>)?.from ?? '');
  });
  const [dateTo, setDateTo] = useState(() => {
    return String((standardConfig.dateRange as Record<string, unknown>)?.to ?? '');
  });
  const [showRules, setShowRules] = useState(false);
  const [showRuleBuilder, setShowRuleBuilder] = useState(false);
  const [ruleField, setRuleField] = useState('');
  const [ruleOperator, setRuleOperator] = useState('contains');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleAction, setRuleAction] = useState<'exclude' | 'include'>('exclude');
  const [rules, setRules] = useState<
    Array<{ field: string; operator: string; value: string; action: string }>
  >([]);

  const addRule = useCallback(() => {
    if (ruleField && ruleValue.trim()) {
      setRules((prev) => [
        ...prev,
        { field: ruleField, operator: ruleOperator, value: ruleValue.trim(), action: ruleAction },
      ]);
      setRuleField('');
      setRuleValue('');
      setShowRuleBuilder(false);
    }
  }, [ruleField, ruleOperator, ruleValue, ruleAction]);

  const removeRule = useCallback((idx: number) => {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Estimates
  const estimatedDocs = useMemo(() => {
    if (discovery?.sites) return discovery.sites.reduce((s, x) => s + (x.fileCount ?? 0), 0);
    return connector?.syncState?.totalDocuments ?? 0;
  }, [discovery, connector]);

  const formatBytes = (b: number) => {
    if (b === 0) return '—';
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };
  const estimatedSize = useMemo(() => {
    if (discovery?.sites) return discovery.sites.reduce((s, x) => s + (x.sizeBytes ?? 0), 0);
    return 0;
  }, [discovery]);

  const saveConfig = useCallback(async () => {
    try {
      const selectedExtensions = FILE_TYPE_PRESETS.filter((ft) =>
        activeFileTypes.has(ft.id),
      ).flatMap((ft) => ft.extensions);

      const computedSiteMode = hasEdited ? 'selected' : isAllSelected ? 'all' : 'selected';
      const computedSiteIds = hasEdited ? Array.from(editIds) : isAllSelected ? [] : dbSiteIds;

      // Debug: remove after confirming fix works
      // eslint-disable-next-line no-console
      console.log('[ScopeFiltersTab] SAVE:', {
        hasEdited,
        isAllSelected,
        editIdsSize: editIds.size,
        computedSiteMode,
        computedSiteIdsCount: computedSiteIds.length,
        dbSiteMode,
        dbSiteIdsCount: dbSiteIds.length,
      });

      const newFilterConfig = {
        ...filterConfig,
        standard: {
          ...standardConfig,
          fileExtensions: {
            mode: 'allowlist' as const,
            extensions: selectedExtensions,
          },
          maxFileSizeBytes: Number(maxFileSize) * 1024 * 1024,
          ...(dateFrom || dateTo
            ? { dateRange: { from: dateFrom || undefined, to: dateTo || undefined } }
            : {}),
        },
        scope: {
          ...scopeConfig,
          siteMode: computedSiteMode,
          siteIds: computedSiteIds,
          folderPaths: {
            include: [],
            exclude: excludePatterns,
          },
        },
      };

      // eslint-disable-next-line no-console
      console.log('[ScopeFiltersTab] PUT request:', {
        url: `/api/search-ai/indexes/${indexId}/connectors/${connectorId}`,
        siteMode: computedSiteMode,
        siteIdsCount: computedSiteIds.length,
      });

      const result = await updateConnectorConfig(indexId, connectorId, {
        filterConfig: newFilterConfig,
        connectionConfig: {
          ...(connector?.connectionConfig as Record<string, unknown>),
          syncSchedule: schedule,
          syncScheduleTime: scheduleTime,
          syncScheduleDayOfWeek: scheduleDayOfWeek,
        },
      });

      // eslint-disable-next-line no-console
      console.log('[ScopeFiltersTab] PUT response:', result);

      // Revalidate the SWR cache in background so reopening sees fresh data
      mutateConnector();
      toast.success('Configuration saved');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ScopeFiltersTab] PUT FAILED:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
    }
  }, [
    activeFileTypes,
    filterConfig,
    standardConfig,
    scopeConfig,
    editIds,
    hasEdited,
    isAllSelected,
    allSites,
    excludePatterns,
    maxFileSize,
    schedule,
    indexId,
    connectorId,
    mutateConnector,
    connector,
  ]);

  return (
    <div className="p-5 space-y-5">
      {/* ── Impact Summary ── */}
      <div className="rounded-xl border border-success/20 bg-success/5 p-4">
        <p className="text-xs font-semibold text-success mb-2">📊 {t('impact_title')}</p>
        <div className="grid grid-cols-4 gap-2">
          {[
            { val: String(selectedCount), lbl: t('impact_sites') },
            {
              val: estimatedDocs > 0 ? `~${estimatedDocs.toLocaleString()}` : '—',
              lbl: t('impact_docs'),
            },
            {
              val: estimatedSize > 0 ? `~${formatBytes(estimatedSize)}` : '—',
              lbl: t('impact_size'),
            },
            { val: schedule, lbl: t('impact_schedule') },
          ].map((item, i) => (
            <div key={i} className="text-center p-2 rounded-lg bg-background-muted/50">
              <p className="text-lg font-bold text-foreground">{item.val}</p>
              <p className="text-[10px] text-muted">{item.lbl}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── 1. Sites ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-info" /> {t('sites_title')}
            </h4>
            <p className="text-xs text-muted mt-0.5">{t('sites_subtitle')}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => (showSitePicker ? closeSitePicker() : openSitePicker())}
          >
            {t('sites_edit')}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {siteChips.map((s) => (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-info/10 text-info border border-info/20"
            >
              {s.name}
              <button
                type="button"
                onClick={() => toggleSite(s.id)}
                className="text-info/50 hover:text-error"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {moreSitesCount > 0 && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs bg-background-muted text-muted border border-default">
              +{moreSitesCount} more
            </span>
          )}
          {siteChips.length === 0 && selectedCount > 0 && (
            <span className="text-xs text-muted">
              {isAllSelected
                ? `All ${totalSiteCount} sites included`
                : `${selectedCount} ${selectedCount === 1 ? 'site' : 'sites'} selected`}
            </span>
          )}
        </div>

        {/* Inline site picker — shows ALL sites, not just selected */}
        {showSitePicker && (
          <div className="mt-2 p-3 border border-default rounded-lg bg-background-subtle">
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
              <input
                type="text"
                value={siteSearch}
                onChange={(e) => setSiteSearch(e.target.value)}
                placeholder="Search by name, URL, or ID (comma-separated)..."
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-default rounded-md bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              />
            </div>
            <div className="flex gap-1.5 mb-2 items-center flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setEditIds((p) => {
                    const n = new Set(p);
                    filteredSites.forEach((s) => n.add(s.id));
                    return n;
                  });
                  setHasEdited(true);
                }}
                className="px-2 py-1 text-[10px] font-medium border border-default rounded bg-background-subtle hover:bg-background-elevated"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditIds((p) => {
                    const n = new Set(p);
                    filteredSites.forEach((s) => n.delete(s.id));
                    return n;
                  });
                  setHasEdited(true);
                }}
                className="px-2 py-1 text-[10px] font-medium border border-default rounded bg-background-subtle hover:bg-background-elevated"
              >
                Clear Visible
              </button>
              {editIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setEditIds(new Set());
                    setHasEdited(true);
                  }}
                  className="px-2 py-1 text-[10px] font-medium text-error border border-error/30 rounded hover:bg-error/5"
                >
                  Clear All
                </button>
              )}
              <span className="text-[10px] font-semibold text-accent bg-accent/10 px-2 py-0.5 rounded-full">
                {editIds.size} of {totalSiteCount} selected
              </span>
              {siteSearch.trim() && filteredSites.length !== allSites.length && (
                <span className="text-[10px] text-muted">{filteredSites.length} matches</span>
              )}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5 max-h-60 overflow-y-auto">
              {[...filteredSites]
                .sort((a, b) => {
                  // Show unselected first so user can see what's NOT picked
                  const aS = editIds.has(a.id) ? 1 : 0;
                  const bS = editIds.has(b.id) ? 1 : 0;
                  if (aS !== bS) return aS - bS;
                  return a.name.localeCompare(b.name);
                })
                .map((site) => {
                  const checked = editIds.has(site.id);
                  return (
                    <div
                      key={site.id}
                      onClick={() => toggleSite(site.id)}
                      className={`flex items-start gap-2 p-2.5 rounded-lg cursor-pointer transition-all text-xs ${checked ? 'border-[1.5px] border-accent bg-accent-subtle' : 'border-[1.5px] border-border hover:border-foreground-muted hover:bg-background-muted'}`}
                    >
                      <div
                        className={`w-4 h-4 rounded flex items-center justify-center shrink-0 mt-0.5 ${checked ? 'bg-accent border-2 border-accent' : 'border-2 border-border'}`}
                      >
                        {checked && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            className="text-white"
                          >
                            <path
                              d="M2 5L4.5 7.5L8 3"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-[12px] text-foreground truncate">
                          {site.name}
                        </div>
                        {site.driveCount > 0 && (
                          <div className="text-[10px] text-foreground-muted mt-1">
                            {site.driveCount}{' '}
                            {site.driveCount === 1 ? 'Document Library' : 'Document Libraries'}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-default" />

      {/* ── 2. File Types ── */}
      <div>
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-1">
          <FileText className="w-3.5 h-3.5 text-accent" /> {t('file_types_title')}
        </h4>
        <p className="text-xs text-muted mb-2">{t('file_types_subtitle')}</p>
        <div className="flex flex-wrap gap-1.5">
          {FILE_TYPE_PRESETS.map((ft) => (
            <button
              key={ft.id}
              type="button"
              onClick={() =>
                setActiveFileTypes((p) => {
                  const n = new Set(p);
                  if (n.has(ft.id)) n.delete(ft.id);
                  else n.add(ft.id);
                  return n;
                })
              }
              className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${activeFileTypes.has(ft.id) ? 'bg-info/10 text-info border-info/20' : 'bg-background-subtle text-muted border-default hover:border-info/30'}`}
            >
              {ft.label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-default" />

      {/* ── 3. Size Limit ── */}
      <div>
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-1">
          <Ruler className="w-3.5 h-3.5 text-success" /> {t('size_title')}
        </h4>
        <p className="text-xs text-muted mb-2">{t('size_subtitle')}</p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={maxFileSize}
            onChange={(e) => setMaxFileSize(e.target.value)}
            className="w-20 text-center px-3 py-1.5 rounded-lg border border-default bg-background-subtle text-foreground text-sm focus:outline-none focus:border-accent"
          />
          <span className="text-xs text-muted">MB per file</span>
        </div>
      </div>

      <div className="border-t border-default" />

      {/* ── 4. Date Range ── */}
      <div>
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-1">
          <Calendar className="w-3.5 h-3.5 text-info" /> {t('date_title')}
        </h4>
        <p className="text-xs text-muted mb-2">{t('date_subtitle')}</p>
        <div className="flex items-center gap-2">
          <div>
            <label className="text-[10px] text-muted block mb-1">{t('date_from')}</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-default bg-background-subtle text-foreground text-xs focus:outline-none focus:border-accent"
            />
          </div>
          <span className="text-muted mt-4">—</span>
          <div>
            <label className="text-[10px] text-muted block mb-1">{t('date_to')}</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-default bg-background-subtle text-foreground text-xs focus:outline-none focus:border-accent"
            />
          </div>
        </div>
      </div>

      <div className="border-t border-default" />

      {/* ── 5. Exclude Patterns ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Ban className="w-3.5 h-3.5 text-error" /> {t('exclude_title')}
            </h4>
            <p className="text-xs text-muted mt-0.5">{t('exclude_subtitle')}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowAddPattern(true)}>
            + Add pattern
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {excludePatterns.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-warning/10 text-warning border border-warning/20"
            >
              {p}
              <button
                type="button"
                onClick={() => removePattern(p)}
                className="text-warning/50 hover:text-error"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        {showAddPattern && (
          <div className="p-3 border border-default rounded-lg bg-background-subtle space-y-3">
            <h4 className="text-xs font-semibold text-foreground">Add exclude pattern</h4>
            <input
              type="text"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              placeholder="Enter a glob pattern..."
              className="w-full px-3 py-1.5 text-xs border border-default rounded-md bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              onKeyDown={(e) => {
                if (e.key === 'Enter') addPattern();
              }}
            />
            <p className="text-[10px] text-muted">
              Use glob patterns to match file or folder names. Files matching any pattern will be
              skipped during sync.
            </p>
            <p className="text-[10px] text-muted">Click to use a common pattern:</p>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_PATTERNS.map((cp) => (
                <button
                  key={cp}
                  type="button"
                  onClick={() => {
                    setNewPattern(cp);
                  }}
                  className="px-2 py-0.5 text-[10px] border border-default rounded bg-background-subtle hover:bg-background-elevated text-muted"
                >
                  {cp}
                </button>
              ))}
            </div>
            <div className="p-2 rounded bg-background-muted border border-default text-[10px] text-muted space-y-0.5">
              <p className="font-semibold text-foreground">Pattern reference:</p>
              <p>
                <code className="text-accent">*</code> matches any filename ·{' '}
                <code className="text-accent">**</code> matches all subfolders recursively
              </p>
              <p>
                <code className="text-accent">*.pdf</code> matches all PDFs ·{' '}
                <code className="text-accent">drafts/*</code> matches files directly in drafts
              </p>
              <p>
                <code className="text-accent font-bold">drafts/**</code> matches everything under
                drafts
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-default">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowAddPattern(false);
                  setNewPattern('');
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={addPattern} disabled={!newPattern.trim()}>
                Add Pattern
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-default" />

      {/* ── 6. Schedule ── */}
      <div>
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-1">
          <Clock className="w-3.5 h-3.5 text-accent" /> {t('schedule_title')}
        </h4>
        <p className="text-xs text-muted mb-2">{t('schedule_subtitle')}</p>
        <div className="flex gap-1.5">
          {SCHEDULE_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setSchedule(opt)}
              className={`px-3 py-1.5 rounded-lg text-xs border font-medium transition-colors ${schedule === opt ? 'border-accent bg-accent/10 text-accent' : 'border-default bg-background-subtle text-muted hover:border-accent/30'}`}
            >
              {t(`schedule_${opt}`)}
            </button>
          ))}
        </div>

        {/* Schedule time picker — shown when schedule is not disabled */}
        {schedule !== 'disabled' && (
          <div className="flex items-center gap-4 mt-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{t('schedule_time_label')}</span>
              <input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="rounded-lg border border-default bg-background-subtle px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-accent"
              />
            </div>
            {schedule === 'weekly' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{t('schedule_day_label')}</span>
                <select
                  value={scheduleDayOfWeek}
                  onChange={(e) => setScheduleDayOfWeek(e.target.value)}
                  className="rounded-lg border border-default bg-background-subtle px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-accent appearance-none pr-6"
                  style={{
                    backgroundImage:
                      "url(\"data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%236b7280' viewBox='0 0 16 16'%3e%3cpath d='M8 11L3 6h10z'/%3e%3c/svg%3e\")",
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 6px center',
                  }}
                >
                  <option value="monday">Monday</option>
                  <option value="tuesday">Tuesday</option>
                  <option value="wednesday">Wednesday</option>
                  <option value="thursday">Thursday</option>
                  <option value="friday">Friday</option>
                  <option value="saturday">Saturday</option>
                  <option value="sunday">Sunday</option>
                </select>
              </div>
            )}
            <span className="text-[10px] text-muted">(UTC)</span>
          </div>
        )}
      </div>

      <div className="border-t border-default" />

      {/* ── 6. Filter Rules (includes exclude patterns) ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Settings2 className="w-3.5 h-3.5 text-muted" /> {t('rules_title')}
            </h4>
            <p className="text-xs text-muted mt-0.5">{t('rules_subtitle')}</p>
          </div>
          {rules.length > 0 && <Badge variant="info">{rules.length} rules</Badge>}
        </div>

        {/* Existing rules */}
        {rules.length > 0 && (
          <div className="space-y-2 mb-3">
            {rules.map((rule, idx) => (
              <div key={idx} className="p-3 rounded-lg border border-default bg-background-subtle">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-foreground">
                    <span className={rule.action === 'exclude' ? 'text-error' : 'text-success'}>
                      {rule.action === 'exclude' ? '✗' : '✓'}
                    </span>{' '}
                    {rule.action === 'exclude' ? 'Exclude' : 'Include'} rule
                  </span>
                  <button
                    type="button"
                    onClick={() => removeRule(idx)}
                    className="text-xs text-error hover:underline"
                  >
                    Remove
                  </button>
                </div>
                <p className="text-xs text-muted">
                  IF <strong className="text-foreground">{rule.field}</strong> {rule.operator}{' '}
                  <strong className="text-foreground">&quot;{rule.value}&quot;</strong> →{' '}
                  <span
                    className={
                      rule.action === 'exclude'
                        ? 'text-error font-medium'
                        : 'text-success font-medium'
                    }
                  >
                    {rule.action === 'exclude' ? 'Exclude' : 'Include'}
                  </span>
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Rule builder — matching wireframe exactly */}
        {showRuleBuilder ? (
          <div className="p-4 rounded-lg border border-accent bg-accent-subtle space-y-4">
            <p className="text-xs font-semibold text-accent">✨ New Filter Rule</p>

            {/* Row 1: IF + field + operator */}
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-muted w-6">IF</span>
              <select
                value={ruleField}
                onChange={(e) => setRuleField(e.target.value)}
                className="px-3 py-2 text-xs border border-default rounded-lg bg-background-subtle text-foreground min-w-[140px]"
              >
                <option value="">Select field...</option>
                <optgroup label="Document">
                  <option value="File name">File name</option>
                  <option value="File type">File type</option>
                  <option value="File size">File size</option>
                  <option value="Folder path">Folder path</option>
                </optgroup>
                <optgroup label="SharePoint">
                  <option value="Site name">Site name</option>
                  <option value="Library name">Library name</option>
                  <option value="Author">Author</option>
                </optgroup>
              </select>
              <select
                value={ruleOperator}
                onChange={(e) => setRuleOperator(e.target.value)}
                className="px-3 py-2 text-xs border border-default rounded-lg bg-background-subtle text-foreground min-w-[120px]"
              >
                <option value="equals">equals</option>
                <option value="not equals">not equals</option>
                <option value="contains">contains</option>
                <option value="does not contain">does not contain</option>
                <option value="starts with">starts with</option>
                <option value="ends with">ends with</option>
                <option value="matches regex">matches regex</option>
              </select>
            </div>

            {/* Row 2: Value (full width) */}
            <div className="pl-9">
              <input
                type="text"
                value={ruleValue}
                onChange={(e) => setRuleValue(e.target.value)}
                placeholder="Enter value..."
                className="w-full px-3 py-2 text-xs border border-default rounded-lg bg-background-subtle text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              />
            </div>

            {/* Row 3: Action */}
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-muted w-6">→</span>
              <select
                value={ruleAction}
                onChange={(e) => setRuleAction(e.target.value as 'exclude' | 'include')}
                className="px-3 py-2 text-xs border border-default rounded-lg bg-background-subtle text-foreground min-w-[120px]"
              >
                <option value="exclude">Exclude</option>
                <option value="include">Include</option>
              </select>
              <span className="text-[10px] text-muted">
                Matching documents will be {ruleAction}d
              </span>
            </div>

            {/* Preview */}
            {ruleField && ruleValue.trim() && (
              <div className="p-2.5 rounded-lg bg-background-muted border border-default text-xs text-muted">
                📋 Preview: IF <strong className="text-foreground">{ruleField}</strong>{' '}
                {ruleOperator} <strong className="text-foreground">&quot;{ruleValue}&quot;</strong>{' '}
                →{' '}
                <span
                  className={
                    ruleAction === 'exclude' ? 'text-error font-medium' : 'text-success font-medium'
                  }
                >
                  {ruleAction === 'exclude' ? 'Exclude' : 'Include'}
                </span>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2 border-t border-default">
              <Button variant="secondary" size="sm" onClick={() => setShowRuleBuilder(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={addRule} disabled={!ruleField || !ruleValue.trim()}>
                Add Rule
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setShowRuleBuilder(true)}>
            + Add Rule
          </Button>
        )}
      </div>

      {/* ── Save / Reset Footer ── */}
      <div className="sticky bottom-0 bg-background-elevated border-t border-default px-5 py-3 -mx-5 -mb-5 flex items-center justify-between">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setActiveFileTypes(() => {
              const active = new Set<string>();
              ['pdf', 'docx', 'pptx', 'xlsx', 'txt'].forEach((id) => active.add(id));
              return active;
            });
            setMaxFileSize('50');
            setSchedule('daily');
            setExcludePatterns(DEFAULT_EXCLUDE_PATTERNS);
            setRules([]);
            toast.success('Reset to defaults');
          }}
        >
          Reset to Defaults
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void saveConfig()}>
            Save Configuration
          </Button>
          {onNavigateToPreview && (
            <Button
              size="sm"
              onClick={async () => {
                await saveConfig();
                onNavigateToPreview();
              }}
            >
              Save & Continue →
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
