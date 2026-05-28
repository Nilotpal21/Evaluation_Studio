'use client';

/**
 * State 2 — Analysis & Section Review
 *
 * Left panel: site discovery card, strategy selector, section checklist, test extraction.
 * Right panel: interactive content warnings, estimated plan.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Info,
  Link2,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Search,
  Compass,
  ExternalLink,
  Pencil,
  X,
  Loader2,
  Zap,
  Settings,
} from 'lucide-react';
import { SampleUrlInput } from './SampleUrlInput';
import { DirectUrlsPanel } from './DirectUrlsPanel';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import {
  startIntelligenceAnalysis,
  getIntelligenceStatus,
  updateCrawlConfig,
  updateDiscoveryState,
} from '@/api/crawl';
import type { IntelligenceAnalysisResult } from '@/api/crawl';
import { springs } from '@/lib/animation';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { Badge } from '../../ui/Badge';
import { UnifiedDiscoveryPanel } from './UnifiedDiscoveryPanel';
import { StrategySelector } from './StrategySelector';
import { SiteDiscovery } from './SiteDiscovery';
import type {
  State2AnalysisProps,
  CrawlSection,
  DiscoveryLayerStats,
  SourceDiscoveryState,
  DiscoveryTreeNode,
  DiscoveryStrategy,
  PipelinePhase,
} from './types';
import type { UnifiedTreeNode } from './discovery/unified-tree-types';

/** Maximum pages allowed per crawl job */
const MAX_CRAWL_PAGES = 5000;

/** Format a number with thousands separators */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Format duration in ms to human-readable */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

/** Format a URL path for compact display */
function compactPath(url: string, maxLen: number = 60): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.length <= maxLen) return path;
    return path.slice(0, maxLen - 3) + '...';
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen - 3) + '...' : url;
  }
}

// ─── SectionChecklist sub-component (extracted from State2Analysis) ──

interface SectionChecklistProps {
  sections: CrawlSection[];
  filteredSections: CrawlSection[];
  includedSections: CrawlSection[];
  /** Explains why certain sections were pre-selected (path scoping) */
  selectionHint?: string;
  sectionFilter: string;
  onSectionFilterChange: (value: string) => void;
  useTreeView: boolean;
  /** Whether grouping is by sitemapFile (true) or path-segment (false) */
  hasSitemapGrouping: boolean;
  groupedSections: Map<string, CrawlSection[]>;
  ungroupedSections: CrawlSection[];
  collapsedGroups: Set<string>;
  onToggleCollapsedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  onToggleGroupSelection: (groupKey: string, checked: boolean) => void;
  onSelectAll: () => void;
  onUnselectAll: () => void;
  renderSectionRow: (section: CrawlSection) => React.ReactNode;
  t: ReturnType<typeof useTranslations>;
}

/** Title-case a path segment */
function titleCase(s: string) {
  return s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function SectionChecklist({
  sections,
  filteredSections,
  includedSections,
  selectionHint,
  sectionFilter,
  onSectionFilterChange,
  useTreeView,
  hasSitemapGrouping,
  groupedSections,
  ungroupedSections,
  collapsedGroups,
  onToggleCollapsedGroups,
  onToggleGroupSelection,
  onSelectAll,
  onUnselectAll,
  renderSectionRow,
  t,
}: SectionChecklistProps) {
  const toggleGroup = useCallback(
    (groupKey: string) => {
      onToggleCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(groupKey)) next.delete(groupKey);
        else next.add(groupKey);
        return next;
      });
    },
    [onToggleCollapsedGroups],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.default}
      className="space-y-2"
    >
      {/* Section header */}
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-semibold text-foreground">
          {t('sections_discovered_header', { total: sections.length.toString() })}
        </h4>
      </div>

      {/* Selection hint — explains why certain sections were pre-selected */}
      {selectionHint && <p className="text-xs text-muted italic">{selectionHint}</p>}

      {/* Toolbar: search + select/unselect */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
          <input
            type="text"
            value={sectionFilter}
            onChange={(e) => onSectionFilterChange(e.target.value)}
            placeholder={t('section_search_placeholder')}
            className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-xs py-1.5 pl-8 pr-3"
          />
        </div>
        {useTreeView && (
          <>
            <button
              onClick={() =>
                onToggleCollapsedGroups((prev) => {
                  if (prev.size === groupedSections.size) return new Set();
                  return new Set(groupedSections.keys());
                })
              }
              className="text-xs text-muted hover:text-foreground font-medium whitespace-nowrap transition-default"
            >
              {collapsedGroups.size === groupedSections.size
                ? t('tree_expand_all')
                : t('tree_collapse_all')}
            </button>
            <span className="text-muted text-xs">|</span>
          </>
        )}
        <button
          onClick={onSelectAll}
          className="text-xs text-accent hover:text-accent/80 font-medium whitespace-nowrap transition-default"
        >
          {t('select_all')}
        </button>
        <span className="text-muted text-xs">|</span>
        <button
          onClick={onUnselectAll}
          className="text-xs text-muted hover:text-foreground font-medium whitespace-nowrap transition-default"
        >
          {t('unselect_all')}
        </button>
      </div>

      <p className="text-xs text-muted">
        {t('section_count_summary', {
          selected: includedSections.length.toString(),
          total: sections.length.toString(),
          pages: includedSections.reduce((sum, s) => sum + s.pageCount, 0).toLocaleString(),
          totalPages: sections.reduce((sum, s) => sum + s.pageCount, 0).toLocaleString(),
        })}{' '}
        {includedSections.reduce((sum, s) => sum + s.pageCount, 0) > MAX_CRAWL_PAGES && (
          <span className="text-warning">
            {t('crawl_cap_note', { max: MAX_CRAWL_PAGES.toLocaleString() })}
          </span>
        )}
      </p>

      <div className="space-y-1.5 max-h-[calc(100vh-380px)] min-h-[200px] overflow-y-auto pr-1">
        {useTreeView ? (
          /* ─── Grouped tree view ─── */
          <>
            {Array.from(groupedSections.entries()).map(([groupKey, groupSections]) => {
              const hasActiveSearch = sectionFilter.trim().length > 0;
              const isCollapsed = hasActiveSearch ? false : collapsedGroups.has(groupKey);
              const groupPages = groupSections.reduce((sum, s) => sum + s.pageCount, 0);
              const allChecked = groupSections.every((s) => s.included);
              const someChecked = groupSections.some((s) => s.included) && !allChecked;

              return (
                <div key={groupKey} className="space-y-1">
                  {/* Group header */}
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-background-muted">
                    <button
                      onClick={() => toggleGroup(groupKey)}
                      className="p-0.5 text-muted hover:text-foreground transition-default"
                    >
                      <ChevronRight
                        className={clsx(
                          'w-3.5 h-3.5 transition-transform',
                          !isCollapsed && 'rotate-90',
                        )}
                      />
                    </button>
                    <Checkbox
                      checked={allChecked}
                      onChange={(checked) => onToggleGroupSelection(groupKey, checked)}
                    />
                    <span
                      className="text-sm font-semibold text-foreground cursor-pointer truncate max-w-[200px]"
                      onClick={() => toggleGroup(groupKey)}
                      title={groupKey}
                    >
                      {groupKey === 'root' ? t('group_root') : titleCase(groupKey)}
                    </span>
                    {hasSitemapGrouping && groupSections[0]?.sitemapOrigin && (
                      <Badge variant="info" size="sm">
                        {groupSections[0].sitemapOrigin === 'robots.txt'
                          ? t('origin_robots_txt')
                          : groupSections[0].sitemapOrigin === 'user-provided'
                            ? t('origin_user_provided')
                            : groupSections[0].sitemapOrigin === 'index'
                              ? t('origin_index')
                              : null}
                      </Badge>
                    )}
                    <Badge variant="default">
                      {t('group_sections', { count: groupSections.length.toString() })}
                    </Badge>
                    <Badge variant="default">
                      {t('group_pages', { count: formatNumber(groupPages) })}
                    </Badge>
                    {someChecked && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                    )}
                  </div>
                  {/* Group contents */}
                  {!isCollapsed && (
                    <div className="pl-4 space-y-1">
                      {groupSections.map((section) => renderSectionRow(section))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Single-section groups rendered as flat rows (no redundant nesting) */}
            {ungroupedSections.map((section) => renderSectionRow(section))}
          </>
        ) : (
          /* ─── Flat list view ─── */
          filteredSections.map((section) => renderSectionRow(section))
        )}
        {filteredSections.length === 0 && sectionFilter.trim() && (
          <p className="text-xs text-muted text-center py-3">{t('no_sections_match')}</p>
        )}
      </div>

      {/* Grand total row */}
      {sections.length > 0 && (
        <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-background-muted text-xs text-muted border border-default">
          <span className="font-medium">
            {t('section_grand_total', {
              sections: includedSections.length.toString(),
              total: sections.length.toString(),
            })}
          </span>
          <span>
            {t('pages', {
              count: includedSections.reduce((sum, s) => sum + s.pageCount, 0).toLocaleString(),
            })}
          </span>
        </div>
      )}
    </motion.div>
  );
}

export function State2Analysis({
  url,
  indexId,
  profile,
  sections,
  onSectionsChange,
  onContinue,
  onDirectCrawl,
  isAnalyzing,
  analysisSteps,
  sourceId,
  configVersion,
  initialDiscoveryState,
  clusteringInProgress,
  directUrlsText,
  onDirectUrlsTextChange,
  onDirectUrlsValidChange,
  onDirectUrlsConfigure,
  onDirectUrlsDirectCrawl,
  initialStrategy,
  onStrategyChange,
  onCustomSitemapValidated,
}: State2AnalysisProps) {
  const t = useTranslations('search_ai.crawl_flow');

  // ─── Section filter state ───────────────────────────────────────────
  const [sectionFilter, setSectionFilter] = useState('');

  // ─── Expanded sections (for viewing individual pages) ─────────────
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // ─── Strategy selection state ──────────────────────────────────────
  // Restore strategy from parent on remount (back-nav, resume, strategy switch)
  const derivedInitialStrategy =
    initialStrategy ?? (initialDiscoveryState ? 'guided-discovery' : null);
  const [strategySelected, setStrategySelected] = useState(derivedInitialStrategy != null);
  const [strategy, setStrategy] = useState<DiscoveryStrategy | null>(derivedInitialStrategy);

  // ─── Discovery pipeline state ────────────────────────────────────
  // Pipeline: idle → browser-running → http-running → complete
  const [pipelinePhase, setPipelinePhase] = useState<PipelinePhase>('idle');

  // ─── Edit samples confirmation ────────────────────────────────────
  const [showEditSamplesConfirm, setShowEditSamplesConfirm] = useState(false);

  // ─── Shared sample URLs (user's intent — "I want pages like these") ──
  const [sampleUrls, setSampleUrls] = useState<string[]>(['']);

  // ─── Discovery summary stats (persists after panels close) ──────
  const [discoveryStats, setDiscoveryStats] = useState<DiscoveryLayerStats[]>([]);
  const analysisStartTimeRef = useRef<number>(Date.now());

  // ─── O4: Minimize discovery tree/console, keep SSE connected ──────
  const [isMinimized, setIsMinimized] = useState(false);

  // ─── Unified tree state — lifted here so minimize (display:none) doesn't lose it ──
  const [unifiedTree, setUnifiedTree] = useState<UnifiedTreeNode[]>([]);

  // ─── Discovery state auto-save callback (saves to SourceConfigState) ──
  const handleSaveDiscoveryState = useCallback(
    async (state: SourceDiscoveryState) => {
      if (!sourceId) return;
      try {
        await updateDiscoveryState(indexId, sourceId, {
          discoveryState: state as unknown as Record<string, unknown>,
          discoveryStatus: 'running',
        });
      } catch {
        // Best-effort — don't block discovery for save failures
      }
    },
    [indexId, sourceId],
  );

  // ─── Auto-save unified tree to discovery state (debounced 5s) ───────
  useEffect(() => {
    if (unifiedTree.length === 0 || !sourceId) return;
    const timer = setTimeout(() => {
      handleSaveDiscoveryState({
        _treeVersion: 2,
        tree: unifiedTree as unknown as DiscoveryTreeNode[],
        discoveredUrls: [],
        objectives: [],
        navStructure: null,
        iterations: [],
        coverage: null,
        savedAt: Date.now(),
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [unifiedTree, sourceId, handleSaveDiscoveryState]);

  // ─── Manual URL paste state ──────────────────────────────────────
  const [manualPasteOpen, setManualPasteOpen] = useState(false);
  const [manualPasteText, setManualPasteText] = useState('');

  // ─── Test extraction state ──────────────────────────────────────────
  const [testUrl, setTestUrl] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<IntelligenceAnalysisResult | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ─── Section toggle ─────────────────────────────────────────────────
  const handleToggleSection = useCallback(
    (idx: number, checked: boolean) => {
      const updated = sections.map((s, i) => (i === idx ? { ...s, included: checked } : s));
      onSectionsChange(updated);
    },
    [sections, onSectionsChange],
  );

  // ─── Strategy selection handler ──────────────────────────────────────
  const handleStrategySelected = useCallback(
    (selected: DiscoveryStrategy | null) => {
      if (selected === null) {
        // User clicked "Change" — deselect strategy
        setStrategySelected(false);
        setStrategy(null);
        onStrategyChange?.(null);
        return;
      }
      setStrategySelected(true);
      setStrategy(selected);
      onStrategyChange?.(selected);

      // Clear sitemap stats from Discovery Summary — user chose discovery over sitemap
      if (selected === 'guided-discovery') {
        setDiscoveryStats((prev) => prev.filter((s) => s.method !== 'sitemap'));
      }

      // Persist strategy to source crawl config
      if (sourceId && configVersion) {
        updateCrawlConfig(indexId, sourceId, { configVersion, strategy: selected }).catch(() => {
          // Best-effort — don't block flow for save failures
        });
      }
      // All strategies proceed to section review — user clicks Continue when ready
    },
    [indexId, sourceId, configVersion, onStrategyChange],
  );

  // ─── Pipeline: Start discovery (unified panel handles BFS internally) ──
  const handleStartPipeline = useCallback(() => {
    const validSamples = sampleUrls.filter((u) => u.trim());
    if (validSamples.length === 0) return;
    setPipelinePhase('running');
  }, [sampleUrls]);

  // ─── Seeds: convert primary URL + sample URLs into BFS seed format ──
  const seeds = useMemo(() => {
    const result: Array<{ type: 'nav-section' | 'target-url'; url: string; label?: string }> = [
      { type: 'nav-section' as const, url: url, label: 'Primary URL' },
    ];
    for (const u of sampleUrls) {
      const trimmed = u.trim();
      if (trimmed) {
        result.push({ type: 'target-url' as const, url: trimmed });
      }
    }
    return result;
  }, [url, sampleUrls]);

  // ─── Sections ready: discovery tree → CrawlSection[] handoff ────────
  const handleSectionsReady = useCallback(
    (treeSections: CrawlSection[]) => {
      if (treeSections.length === 0) {
        toast.error(t('discovery_no_sections'));
        setPipelinePhase('complete');
        return;
      }
      onSectionsChange(treeSections);
      onContinue();
    },
    [onSectionsChange, onContinue, t],
  );

  // ─── Pipeline: HTTP discover complete → pipeline done ──────────────

  // ─── Select all / unselect all ─────────────────────────────────────
  const handleSelectAll = useCallback(() => {
    onSectionsChange(sections.map((s) => ({ ...s, included: true })));
  }, [sections, onSectionsChange]);

  const handleUnselectAll = useCallback(() => {
    onSectionsChange(sections.map((s) => ({ ...s, included: false })));
  }, [sections, onSectionsChange]);

  const toggleSectionExpanded = useCallback((pattern: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(pattern)) next.delete(pattern);
      else next.add(pattern);
      return next;
    });
  }, []);

  // ─── Filtered sections for display ────────────────────────────────
  // Searches section name, pattern, AND individual page URLs/titles
  const filteredSections = useMemo(() => {
    if (!sectionFilter.trim()) return sections;
    const q = sectionFilter.trim().toLowerCase();
    return sections.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.pattern.toLowerCase().includes(q) ||
        s.sitemapFile?.toLowerCase().includes(q) ||
        s.pages?.some(
          (p) => p.url.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
        ) ||
        s.examples?.some((u) => u.toLowerCase().includes(q)),
    );
  }, [sections, sectionFilter]);

  // When searching, auto-expand sections that matched via page content
  const searchMatchedSections = useMemo(() => {
    if (!sectionFilter.trim()) return new Set<string>();
    const q = sectionFilter.trim().toLowerCase();
    const matched = new Set<string>();
    for (const s of sections) {
      // Only flag sections that matched via pages/examples (not name/pattern)
      if (!s.name.toLowerCase().includes(q) && !s.pattern.toLowerCase().includes(q)) {
        const pageMatch = s.pages?.some(
          (p) => p.url.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
        );
        const exampleMatch = s.examples?.some((u) => u.toLowerCase().includes(q));
        if (pageMatch || exampleMatch) {
          matched.add(s.pattern);
        }
      }
    }
    return matched;
  }, [sections, sectionFilter]);

  // ─── Section tree grouping (F24) ────────────────────────────────────
  // Groups with only 1 section are flattened into 'ungrouped' to avoid
  // redundant nesting like "S" → "/s/ Pages".
  // Adaptive grouping: use sitemapFile as key when multi-sitemap, else path-segment
  const hasSitemapGrouping = useMemo(() => {
    const uniqueFiles = new Set(filteredSections.map((s) => s.sitemapFile).filter(Boolean));
    return uniqueFiles.size > 1;
  }, [filteredSections]);

  const { grouped: groupedSections, ungrouped: ungroupedSections } = useMemo(() => {
    const MAX_GROUP_SIZE = 15; // Sub-group by 2nd path segment when a group exceeds this
    const raw = new Map<string, CrawlSection[]>();

    for (const section of filteredSections) {
      let groupKey: string;

      if (hasSitemapGrouping && section.sitemapFile) {
        // Multi-sitemap: group by sitemap file (short display name)
        try {
          const u = new URL(section.sitemapFile);
          groupKey = u.pathname;
        } catch {
          groupKey = section.sitemapFile;
        }
      } else {
        // Default: group by first path segment
        const cleaned = section.pattern.replace(/\{[^}]+\}/g, '').replace(/\*/g, '');
        const parts = cleaned.split('/').filter(Boolean);
        groupKey = parts[0] || 'root';
      }

      const existing = raw.get(groupKey) || [];
      existing.push(section);
      raw.set(groupKey, existing);
    }

    // Sub-group oversized groups by the second path segment for better UX.
    // e.g., "Accessories" (80 sections) → "Accessories > POS Accessories" (10),
    //        "Accessories > Printer Accessories" (8), etc.
    if (!hasSitemapGrouping) {
      const oversized = Array.from(raw.entries()).filter(
        ([, secs]) => secs.length > MAX_GROUP_SIZE,
      );
      for (const [parentKey, secs] of oversized) {
        raw.delete(parentKey);
        const subMap = new Map<string, CrawlSection[]>();
        for (const sec of secs) {
          const cleaned = sec.pattern.replace(/\{[^}]+\}/g, '').replace(/\*/g, '');
          const parts = cleaned.split('/').filter(Boolean);
          const subKey =
            parts.length >= 2 ? `${titleCase(parts[0])} > ${titleCase(parts[1])}` : parentKey;
          const existing = subMap.get(subKey) || [];
          existing.push(sec);
          subMap.set(subKey, existing);
        }
        for (const [subKey, subSecs] of subMap) {
          raw.set(subKey, subSecs);
        }
      }
    }

    // Separate multi-section groups from single-section groups
    const grouped = new Map<string, CrawlSection[]>();
    const ungrouped: CrawlSection[] = [];
    for (const [key, secs] of raw) {
      if (secs.length > 1) {
        grouped.set(key, secs);
      } else {
        ungrouped.push(...secs);
      }
    }
    return { grouped, ungrouped };
  }, [filteredSections, hasSitemapGrouping]);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroupSelection = useCallback(
    (groupKey: string, checked: boolean) => {
      const groupSections = groupedSections.get(groupKey) ?? [];
      const groupPatterns = new Set(groupSections.map((s) => s.pattern));
      const updated = sections.map((s) =>
        groupPatterns.has(s.pattern) ? { ...s, included: checked } : s,
      );
      onSectionsChange(updated);
    },
    [sections, groupedSections, onSectionsChange],
  );

  // ─── Editable section names (F26) ──────────────────────────────────
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const handleStartEdit = useCallback((pattern: string, currentName: string) => {
    setEditingSection(pattern);
    setEditName(currentName);
  }, []);

  const handleFinishEdit = useCallback(
    (pattern: string) => {
      if (editName.trim()) {
        const updated = sections.map((s) =>
          s.pattern === pattern ? { ...s, name: editName.trim() } : s,
        );
        onSectionsChange(updated);
      }
      setEditingSection(null);
    },
    [editName, sections, onSectionsChange],
  );

  // ─── Derived values ─────────────────────────────────────────────────
  const includedSections = useMemo(() => sections.filter((s) => s.included), [sections]);

  const totalPages = useMemo(
    () => includedSections.reduce((sum, s) => sum + s.pageCount, 0),
    [includedSections],
  );

  const interactiveSections = useMemo(
    () => sections.filter((s) => s.warnings.length > 0),
    [sections],
  );

  const estimatedTime = useMemo(() => {
    // rough heuristic: 2s per page for http, 5s for interactive
    const regularPages = includedSections
      .filter((s) => s.warnings.length === 0)
      .reduce((sum, s) => sum + s.pageCount, 0);
    const interactivePages = includedSections
      .filter((s) => s.warnings.length > 0)
      .reduce((sum, s) => sum + s.pageCount, 0);
    const seconds = regularPages * 2 + interactivePages * 5;
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes}m`;
  }, [includedSections]);

  const analysisComplete = useMemo(
    () => analysisSteps.every((s) => s.status === 'complete'),
    [analysisSteps],
  );

  /** Total pages across ALL sections (not just included) — for threshold checks */
  const allSectionPages = useMemo(
    () => sections.reduce((sum, s) => sum + s.pageCount, 0),
    [sections],
  );

  /**
   * When user chose guided-discovery, the sitemap section list is replaced by the
   * discovery tree. The tree becomes the primary UI and sections are derived from
   * it via treeToSections() when the user clicks "Continue". The flat sitemap
   * section list should be hidden to avoid confusion.
   */
  const isDiscoveryMode = strategy === 'guided-discovery' && pipelinePhase !== 'idle';
  const isDirectUrlsMode = strategy === 'direct-urls';

  /**
   * The discovery panel (tree + SSE) should stay visible after completion —
   * the user needs to select nodes and click "Continue" from the tree.
   * pipelinePhase goes: idle → running → complete
   */
  const showDiscoveryPanel =
    strategy === 'guided-discovery' &&
    (pipelinePhase === 'running' || pipelinePhase === 'complete');

  /** Extract flat sitemap URLs from sections for "Add from Sitemap" dialog */
  const sitemapUrlsForMerge = useMemo(() => {
    if (!profile?.hasSitemap) return [];
    return sections
      .filter((s) => s.source === 'sitemap' || !s.source)
      .flatMap((s) => s.examples ?? []);
  }, [sections, profile?.hasSitemap]);

  /** Threshold: if sitemap found fewer than this many pages, explore is primary */
  const THIN_SITEMAP_THRESHOLD = 20;
  const isThinSitemap = analysisComplete && allSectionPages < THIN_SITEMAP_THRESHOLD;
  const hasNoSitemap = analysisComplete && sections.length === 0;

  /** Explain why certain sections were pre-selected */
  const selectionHint = useMemo(() => {
    if (!analysisComplete || sections.length === 0) return undefined;
    const included = sections.filter((s) => s.included);
    if (included.length === 0 || included.length === sections.length) return undefined;

    try {
      const urlPath = new URL(url).pathname;
      const pathSegments = urlPath.split('/').filter(Boolean);
      const isDeepPath = pathSegments.length > 1;

      if (isDeepPath) {
        const pathDisplay = '/' + pathSegments.join('/');
        return t('section_selection_hint_deep', {
          count: included.length.toString(),
          path: pathDisplay,
        });
      }

      return t('section_selection_hint_root', {
        count: included.length.toString(),
      });
    } catch {
      return undefined;
    }
  }, [analysisComplete, sections, url, t]);

  // ─── Report sitemap stats when analysis completes ─────────────────
  useEffect(() => {
    if (!analysisComplete) return;
    // Don't show sitemap stats when user chose guided-discovery — they explicitly
    // chose discovery over sitemap. Sitemap is available via "Add from Sitemap" later.
    if (strategy === 'guided-discovery') return;
    const sitemapSections = sections.filter((s) => s.source === 'sitemap' || !s.source);
    if (sitemapSections.length === 0) return;
    // Only report once (skip if sitemap stats already exist)
    setDiscoveryStats((prev) => {
      if (prev.some((s) => s.method === 'sitemap')) return prev;
      const sitemapPages = sitemapSections.reduce((sum, s) => sum + s.pageCount, 0);
      return [
        ...prev,
        {
          method: 'sitemap' as const,
          pagesFound: sitemapPages,
          pagesMatched: sitemapPages,
          sectionsCreated: sitemapSections.length,
          durationMs: Date.now() - analysisStartTimeRef.current,
        },
      ];
    });
  }, [analysisComplete, sections, strategy]);

  // ─── Test extraction ────────────────────────────────────────────────
  const handleTestExtraction = useCallback(async () => {
    const trimmed = testUrl.trim();
    if (!trimmed) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const { jobId } = await startIntelligenceAnalysis({
        url: trimmed,
        indexId,
      });
      if (!jobId) {
        toast.error(t('test_failed'));
        setTestLoading(false);
        return;
      }
      // Poll for result
      pollRef.current = setInterval(async () => {
        try {
          const statusResp = await getIntelligenceStatus(jobId);
          if (statusResp.data.status === 'completed' && statusResp.data.result) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setTestResult(statusResp.data.result);
            setTestLoading(false);
          } else if (statusResp.data.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            toast.error(t('test_failed'));
            setTestLoading(false);
          }
        } catch (pollErr: unknown) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          toast.error(sanitizeError(pollErr, t('test_failed')));
          setTestLoading(false);
        }
      }, 2000);
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('test_failed')));
      setTestLoading(false);
    }
  }, [testUrl, indexId, t]);

  const handleContinue = useCallback(() => {
    toast.info(t('phase2_coming'));
    onContinue();
  }, [onContinue, t]);

  /** Action bar: summary + "Crawl N Pages" + "Settings" */
  const renderActionBar = (crawlHandler?: () => void) => {
    const canCrawl = includedSections.length > 0;
    const cappedPages = Math.min(totalPages, MAX_CRAWL_PAGES);
    const isOverCap = totalPages > MAX_CRAWL_PAGES;
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={springs.gentle}
        className="rounded-lg border border-border-default bg-background-subtle p-4 space-y-3"
      >
        {/* Summary line */}
        <p className="text-sm text-muted">
          {t('crawl_action_summary', {
            selected: includedSections.length,
            total: sections.length,
            pages: formatNumber(totalPages),
            totalPages: formatNumber(allSectionPages),
          })}
        </p>
        {isOverCap && (
          <p className="text-xs text-warning">
            {t('crawl_cap_warning', { max: formatNumber(MAX_CRAWL_PAGES) })}
          </p>
        )}
        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <Button onClick={crawlHandler ?? onDirectCrawl} disabled={!canCrawl}>
            <Zap className="w-4 h-4 mr-1.5" />
            {canCrawl
              ? t('crawl_direct_button', { pages: formatNumber(cappedPages) })
              : t('select_sections_to_continue')}
          </Button>
          <Button variant="secondary" onClick={handleContinue} disabled={!canCrawl}>
            <Settings className="w-4 h-4 mr-1.5" />
            {t('crawl_settings_button')}
          </Button>
        </div>
      </motion.div>
    );
  };

  // ─── Manual URL paste handler ────────────────────────────────────────
  const handleManualPasteAdd = useCallback(() => {
    const lines = manualPasteText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Extract base domain for same-domain validation
    let baseDomain = '';
    try {
      baseDomain = new URL(url).hostname;
    } catch {
      // ignore
    }

    // Validate and filter URLs
    const validUrls: string[] = [];
    const errors: string[] = [];
    const existingUrls = new Set(
      sections.flatMap((s) => [...(s.pages ?? []).map((p) => p.url), ...(s.examples ?? [])]),
    );

    for (const line of lines) {
      try {
        const parsed = new URL(line);
        if (baseDomain && parsed.hostname !== baseDomain) {
          errors.push(line);
          continue;
        }
        if (existingUrls.has(line)) continue; // deduplicate
        validUrls.push(line);
        existingUrls.add(line);
      } catch {
        errors.push(line);
      }
    }

    if (errors.length > 0) {
      toast.error(t('manual_paste_invalid', { count: errors.length.toString() }));
    }

    if (validUrls.length === 0) return;

    // Create a "Manual" section with source='explored'
    const manualSection: CrawlSection = {
      sectionId: `sec-manual-${Date.now()}`,
      pattern: '/manual/*',
      name: t('manual_paste_section_name'),
      pageCount: validUrls.length,
      examples: validUrls,
      included: true,
      estimatedTime: `${Math.ceil((validUrls.length * 2) / 60)}m`,
      warnings: [],
      depth: 0,
      source: 'explored',
      pages: validUrls.map((u) => ({ url: u, title: '' })),
    };

    onSectionsChange([...sections, manualSection]);
    setManualPasteText('');
    setManualPasteOpen(false);
    toast.success(t('manual_paste_added', { count: validUrls.length.toString() }));
  }, [manualPasteText, url, sections, onSectionsChange, t]);

  // ─── Render ─────────────────────────────────────────────────────────

  // ─── Unified timeline (replaces renderAnalysisSteps + pipeline stepper) ──
  const validSamplesForTimeline = sampleUrls.filter((u) => u.trim());

  /** Render a single section row (used in both flat and grouped views) */
  const renderSectionRow = (section: CrawlSection) => {
    const idx = sections.indexOf(section);
    const isExpanded =
      expandedSections.has(section.pattern) || searchMatchedSections.has(section.pattern);
    const hasPages =
      (section.pages && section.pages.length > 0) ||
      (section.examples && section.examples.length > 0);

    // Derive better name from page titles when path-based name is cryptic
    let displayName = section.name;
    const isCryptic = /^\/\w\/ Pages$/.test(displayName) || displayName.length <= 2;
    if (isCryptic && section.pages && section.pages.length > 0) {
      // Find common title segment (e.g. "Products" from "Product X | Products | Epson US")
      const titles = section.pages.map((p) => p.title).filter(Boolean);
      if (titles.length > 0) {
        const segCounts = new Map<string, number>();
        for (const title of titles) {
          const parts = title
            .split(/\s*[|–—]\s*/)
            .map((s) => s.trim())
            .filter((s) => s.length >= 3 && s.length <= 40);
          for (const part of parts) segCounts.set(part, (segCounts.get(part) ?? 0) + 1);
        }
        const sorted = Array.from(segCounts.entries()).sort((a, b) => b[1] - a[1]);
        // Skip the most common segment if it appears in almost all titles (site name)
        const candidate =
          sorted.length > 1 && sorted[0][1] >= titles.length * 0.9 ? sorted[1] : sorted[0];
        if (candidate && candidate[1] >= Math.max(2, titles.length * 0.3)) {
          displayName = candidate[0];
        }
      }
    }

    return (
      <div
        key={section.pattern}
        className="rounded-lg border border-default bg-background-subtle overflow-hidden"
      >
        {/* Section header row */}
        <div className="flex items-center gap-2 px-3 py-2 group/row" title={section.pattern}>
          <Checkbox
            checked={section.included}
            onChange={(checked) => handleToggleSection(idx, checked)}
          />
          {/* Expand chevron */}
          {hasPages ? (
            <button
              onClick={() => toggleSectionExpanded(section.pattern)}
              className="p-0.5 text-muted hover:text-foreground transition-default"
              aria-label={isExpanded ? t('collapse') : t('expand')}
            >
              <ChevronRight
                className={clsx('w-3 h-3 transition-transform', isExpanded && 'rotate-90')}
              />
            </button>
          ) : (
            <span className="w-4" />
          )}
          <div className="flex-1 min-w-0">
            {/* F26: Editable section name */}
            {editingSection === section.pattern ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => handleFinishEdit(section.pattern)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleFinishEdit(section.pattern);
                  if (e.key === 'Escape') setEditingSection(null);
                }}
                autoFocus
                className="text-sm font-medium text-foreground bg-transparent border-b border-accent outline-none w-full"
                placeholder={t('section_rename_placeholder')}
              />
            ) : (
              <span
                className="text-sm font-medium text-foreground truncate block cursor-pointer group/name"
                onClick={() => handleStartEdit(section.pattern, displayName)}
              >
                {displayName}
                <Pencil className="w-2.5 h-2.5 text-muted inline-block ml-1 opacity-0 group-hover/name:opacity-100 transition-opacity" />
              </span>
            )}
            {/* URL pattern — always visible as subtitle */}
            <span className="text-[10px] text-subtle font-mono truncate block">
              {section.pattern}
            </span>
          </div>
          {section.source === 'explored' && (
            <>
              <Badge variant="accent">{t('explore_source_explored')}</Badge>
              <Badge variant="info">{t('tree_new_badge')}</Badge>
            </>
          )}
          {section.source === 'auto' && <Badge variant="warning">{t('source_auto')}</Badge>}
          {(!section.source || section.source === 'sitemap') &&
            sections.some((s) => s.source === 'explored' || s.source === 'auto') && (
              <Badge variant="default">{t('explore_source_sitemap')}</Badge>
            )}
          <span className="text-xs text-muted whitespace-nowrap">
            {t('section_composition_pages', { count: section.pageCount })}
            {section.fileTypeCounts &&
              Object.entries(section.fileTypeCounts).map(([ftype, fcount]) => (
                <span key={ftype}>
                  {' '}
                  {t('section_composition_files', { count: fcount, type: ftype.toUpperCase() })}
                </span>
              ))}{' '}
            {section.pageCount > 10
              ? t('estimated_time_range', {
                  min: Math.ceil((section.pageCount * 2) / 60).toString(),
                  max: Math.ceil((section.pageCount * 5) / 60).toString(),
                })
              : `~${section.estimatedTime}`}
          </span>
          {section.warnings.length > 0 && (
            <Badge variant="default" dot>
              {t('interactive_warning')}
            </Badge>
          )}
        </div>

        {/* Expanded page list */}
        <AnimatePresence>
          {isExpanded && hasPages && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              {(() => {
                const q = sectionFilter.trim().toLowerCase();
                // Use pages if available, otherwise fall back to examples
                const allPages: Array<{ url: string; title: string }> =
                  section.pages && section.pages.length > 0
                    ? section.pages
                    : (section.examples ?? []).map((u) => ({ url: u, title: '' }));
                const pages = q
                  ? allPages.filter(
                      (p) => p.url.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
                    )
                  : allPages;
                return (
                  <div className="border-t border-default px-3 py-2 max-h-[200px] overflow-y-auto space-y-0.5">
                    {pages.map((page) => {
                      const isMatch =
                        q &&
                        (page.url.toLowerCase().includes(q) ||
                          page.title.toLowerCase().includes(q));
                      return (
                        <a
                          key={page.url}
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={clsx(
                            'flex items-center gap-2 py-1 text-xs group/page hover:bg-accent/5 rounded -mx-1 px-1 transition-default cursor-pointer',
                            isMatch && 'bg-accent/10',
                          )}
                          title={page.url}
                        >
                          <ExternalLink
                            className={clsx(
                              'w-3 h-3 shrink-0',
                              isMatch ? 'text-accent' : 'text-muted group-hover/page:text-accent',
                            )}
                          />
                          <span className="text-foreground truncate flex-1">
                            {page.title || compactPath(page.url)}
                          </span>
                          <span className="text-accent text-[10px] shrink-0 opacity-0 group-hover/page:opacity-100 transition-default">
                            ↗
                          </span>
                        </a>
                      );
                    })}
                    {allPages.length < section.pageCount && (
                      <p className="text-[10px] text-muted pt-1">
                        {t('section_sample_note', {
                          shown: allPages.length.toString(),
                          total: formatNumber(section.pageCount),
                        })}
                      </p>
                    )}
                  </div>
                );
              })()}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  /** Use tree view when there are enough sections to warrant grouping */
  const useTreeView =
    groupedSections.size + ungroupedSections.length > 5 || filteredSections.length > 15;

  /** Shared section checklist block */
  const renderSectionList = () => (
    <>
      <SectionChecklist
        sections={sections}
        filteredSections={filteredSections}
        includedSections={includedSections}
        selectionHint={selectionHint}
        sectionFilter={sectionFilter}
        onSectionFilterChange={setSectionFilter}
        useTreeView={useTreeView}
        hasSitemapGrouping={hasSitemapGrouping}
        groupedSections={groupedSections}
        ungroupedSections={ungroupedSections}
        collapsedGroups={collapsedGroups}
        onToggleCollapsedGroups={setCollapsedGroups}
        onToggleGroupSelection={toggleGroupSelection}
        onSelectAll={handleSelectAll}
        onUnselectAll={handleUnselectAll}
        renderSectionRow={renderSectionRow}
        t={t}
      />
    </>
  );

  /** Discovery pipeline: sample URL input → browser → HTTP → sections */
  const renderDiscoveryActions = () => {
    const validSamples = validSamplesForTimeline;
    const handleAddSample = () => {
      if (sampleUrls.length < 3) setSampleUrls((prev) => [...prev, '']);
    };
    const handleRemoveSample = (idx: number) => {
      setSampleUrls((prev) => prev.filter((_, i) => i !== idx));
    };
    const handleSampleChange = (idx: number, value: string) => {
      setSampleUrls((prev) => prev.map((v, i) => (i === idx ? value : v)));
    };

    const allSectionPagesCount = sections.reduce((sum, s) => sum + s.pageCount, 0);

    return (
      <div className="space-y-4">
        {/* Site discovery — consolidated card: profile + sitemaps + clustering progress */}
        {pipelinePhase === 'idle' && (
          <SiteDiscovery
            profile={profile}
            isAnalyzing={isAnalyzing}
            clusteringInProgress={!!clusteringInProgress}
            totalPages={allSectionPages}
            totalSections={sections.length}
          />
        )}

        {/* Strategy selection — shown after profiling, stays visible with selection highlighted */}
        {pipelinePhase === 'idle' && profile && (
          <StrategySelector
            hasSitemap={profile.hasSitemap}
            sitemapPageCount={allSectionPagesCount}
            sitemapSectionCount={sections.length}
            onStrategySelected={handleStrategySelected}
            selectedStrategy={strategy}
            backendRecommendation={profile.recommendedStrategy}
            recommendationReasoning={profile.recommendationReasoning}
            clusteringInProgress={clusteringInProgress}
            onCustomSitemapValidated={onCustomSitemapValidated}
          />
        )}

        {/* Clustering loading indicator — shown when user picks Sitemap before clustering completes */}
        {pipelinePhase === 'idle' &&
          strategySelected &&
          strategy === 'crawl-sitemap' &&
          clusteringInProgress && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={springs.default}
              className="flex items-center gap-2 rounded-lg border border-default bg-background-subtle p-4"
            >
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              <p className="text-sm text-muted">{t('strategy_clustering_loading')}</p>
            </motion.div>
          )}

        {/* Sample URL input + Start button (only for guided-discovery, not sitemap) */}
        {pipelinePhase === 'idle' && strategySelected && strategy === 'guided-discovery' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={springs.default}
            className="rounded-lg border border-default bg-background-subtle p-4 space-y-3"
          >
            <SampleUrlInput
              sampleUrls={sampleUrls}
              onChange={setSampleUrls}
              sitemapPageCount={allSectionPages}
              sitemapSectionCount={sections.length}
              variant="analysis"
              domain={profile?.domain ?? undefined}
            />

            {/* Single "Start Discovery" button */}
            <Button
              size="sm"
              onClick={handleStartPipeline}
              disabled={validSamples.length === 0}
              icon={<Compass className="w-3.5 h-3.5" />}
            >
              {t('pipeline_start')}
            </Button>
          </motion.div>
        )}

        {/* Direct URLs panel (only for direct-urls strategy) */}
        {pipelinePhase === 'idle' && strategySelected && strategy === 'direct-urls' && profile && (
          <DirectUrlsPanel
            domain={profile.domain}
            initialText={directUrlsText}
            onValidUrlsChange={onDirectUrlsValidChange ?? (() => {})}
            onTextChange={onDirectUrlsTextChange ?? (() => {})}
            onConfigure={onDirectUrlsConfigure ?? (() => {})}
            onDirectCrawl={onDirectUrlsDirectCrawl}
          />
        )}

        {/* B1: Sample URL chips + edit button (visible during/after pipeline) */}
        {pipelinePhase !== 'idle' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={springs.default}
            className="rounded-lg border border-default bg-background-subtle p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted shrink-0">{t('pipeline_samples_label')}</span>
              {pipelinePhase === 'complete' && !showEditSamplesConfirm && (
                <button
                  onClick={() => setShowEditSamplesConfirm(true)}
                  className="text-[10px] text-accent hover:text-accent/80 font-medium transition-default"
                >
                  {t('pipeline_edit_samples')}
                </button>
              )}
              {showEditSamplesConfirm && (
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-warning">{t('edit_samples_confirm')}</span>
                  <button
                    onClick={() => {
                      setPipelinePhase('idle');
                      setDiscoveryStats([]);
                      setShowEditSamplesConfirm(false);
                    }}
                    className="text-accent font-medium"
                  >
                    {t('edit_samples_yes')}
                  </button>
                  <button onClick={() => setShowEditSamplesConfirm(false)} className="text-muted">
                    {t('edit_samples_no')}
                  </button>
                </div>
              )}
            </div>
            {validSamples.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {validSamples.map((sUrl, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 rounded-md bg-accent/10 text-accent text-[10px] px-2 py-0.5 font-mono truncate max-w-[300px]"
                    title={sUrl}
                  >
                    <Link2 className="w-2.5 h-2.5 shrink-0" />
                    {compactPath(sUrl, 50)}
                  </span>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* O4: Collapse/expand toggle — visible when discovery is running */}
        {showDiscoveryPanel && pipelinePhase === 'running' && (
          <button
            onClick={() => setIsMinimized((prev) => !prev)}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground font-medium transition-default"
          >
            {isMinimized ? (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                {t('discovery_expand')}
              </>
            ) : (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                {t('discovery_collapse')}
              </>
            )}
            {isMinimized && (
              <span className="text-accent ml-2">{t('discovery_running_minimized')}</span>
            )}
          </button>
        )}

        {/* Unified Discovery Panel — BFS discovery with SSE */}
        {/* Stays visible during 'running' AND 'complete' so user can select nodes */}
        {/* P5 fix: use display:none instead of unmounting so SSE stays connected when minimized */}
        {showDiscoveryPanel && (
          <div style={{ display: isMinimized ? 'none' : 'block' }}>
            <UnifiedDiscoveryPanel
              primaryUrl={url}
              sampleUrls={validSamples}
              seeds={seeds}
              tree={unifiedTree}
              onTreeChange={setUnifiedTree}
              onSectionsReady={handleSectionsReady}
              sourceId={sourceId}
              hasSitemap={profile?.hasSitemap}
              sitemapUrls={sitemapUrlsForMerge}
            />
          </div>
        )}
      </div>
    );
  };

  /** Test extraction collapsible */
  const renderTestExtraction = () => (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={springs.gentle}>
      <details open={testOpen} onToggle={(e) => setTestOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium text-muted hover:text-foreground select-none">
          <ChevronDown
            className={clsx('w-3.5 h-3.5 transition-transform', testOpen && 'rotate-180')}
          />
          {t('test_extraction')}
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted">{t('test_hint')}</p>
          <div className="flex items-start gap-2">
            <input
              type="url"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
              placeholder={t('url_placeholder')}
              disabled={testLoading}
              className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 px-3"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={handleTestExtraction}
              loading={testLoading}
              disabled={testLoading || !testUrl.trim()}
            >
              {t('test_button')}
            </Button>
          </div>

          {testResult && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={springs.snappy}
              className="rounded-lg border border-default bg-background-subtle p-3 space-y-2"
            >
              {testResult.title && (
                <p className="text-sm font-medium text-foreground">{testResult.title}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-muted">
                <span>{t('test_chars', { chars: formatNumber(testResult.bodyLength) })}</span>
                <Badge
                  variant={
                    testResult.quality === 'rich'
                      ? 'success'
                      : testResult.quality === 'thin'
                        ? 'warning'
                        : 'default'
                  }
                >
                  {testResult.quality}
                </Badge>
              </div>
              <p className="text-xs text-muted line-clamp-3">{testResult.body.slice(0, 300)}</p>
              <div className="flex items-center gap-2 pt-1">
                <Button size="xs" variant="secondary" onClick={() => toast.success(t('test_good'))}>
                  {t('test_good')}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => toast.info(t('test_fix'))}>
                  {t('test_fix')}
                </Button>
              </div>
            </motion.div>
          )}
        </div>
      </details>
    </motion.div>
  );

  /** Right sidebar */
  /** Interactive content notice — informational, system handles this automatically.
   *  Hidden in direct-urls mode (irrelevant — user provides exact URLs). */
  const renderInteractiveWarning = () =>
    interactiveSections.length > 0 && !isDirectUrlsMode ? (
      <div className="rounded-lg border border-border-default bg-background-subtle p-3 flex items-start gap-2">
        <Info className="w-4 h-4 text-muted shrink-0 mt-0.5" />
        <div>
          <p className="text-xs text-foreground font-medium">
            {t('interactive_detail', { count: interactiveSections.length })}
          </p>
          <p className="text-xs text-muted mt-0.5">
            {t('interactive_pages', {
              count: interactiveSections.reduce((sum, s) => sum + s.pageCount, 0),
            })}
          </p>
        </div>
      </div>
    ) : null;

  // ═══════════════════════════════════════════════════════════════════
  // THIN / NO SITEMAP LAYOUT
  // Sections are shown (even if only from sitemap). "Find more content"
  // two-card layout guides user to browser discovery or sample URLs.
  // ═══════════════════════════════════════════════════════════════════
  if (analysisComplete && (isThinSitemap || hasNoSitemap)) {
    return (
      <div className="space-y-5 min-h-[400px]">
        {/* Discovery actions — above sections so user sees them first */}
        {renderDiscoveryActions()}

        {/* Interactive content warning — inline */}
        {renderInteractiveWarning()}

        {/* Empty discovery guidance */}
        {pipelinePhase === 'complete' && sections.length === 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
            <p className="text-sm font-medium text-foreground">{t('discovery_empty_title')}</p>
            <p className="text-xs text-muted mt-1">{t('discovery_empty_desc')}</p>
          </div>
        )}

        {/* Section list — hidden for guided-discovery (tree replaces it) and direct-urls (own panel) */}
        {sections.length > 0 && !isDiscoveryMode && !isDirectUrlsMode && renderSectionList()}

        {/* Action bar — hidden in discovery mode and direct-urls mode (both have their own) */}
        {sections.length > 0 && !isDiscoveryMode && !isDirectUrlsMode && renderActionBar()}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // NORMAL LAYOUT — good sitemap results
  // Section list is primary. "Can't find?" link at bottom.
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div className="space-y-5 min-h-[400px]">
      {/* Site discovery card — shown during analysis before profile arrives */}
      {isAnalyzing && !profile && (
        <SiteDiscovery
          profile={null}
          isAnalyzing={isAnalyzing}
          clusteringInProgress={!!clusteringInProgress}
          totalPages={allSectionPages}
          totalSections={sections.length}
        />
      )}
      {/* Discovery actions — show as soon as profile arrives (fixes blank page) */}
      {!!profile && renderDiscoveryActions()}

      {/* Interactive content warning — inline */}
      {renderInteractiveWarning()}

      {/* Empty discovery guidance */}
      {pipelinePhase === 'complete' && sections.length === 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
          <p className="text-sm font-medium text-foreground">{t('discovery_empty_title')}</p>
          <p className="text-xs text-muted mt-1">{t('discovery_empty_desc')}</p>
        </div>
      )}

      {/* Section list — hidden for guided-discovery (tree replaces it) and direct-urls (own panel) */}
      {sections.length > 0 && !isDiscoveryMode && !isDirectUrlsMode && renderSectionList()}

      {/* Action bar — hidden in discovery mode and direct-urls mode (both have their own) */}
      {analysisComplete &&
        sections.length > 0 &&
        !isDiscoveryMode &&
        !isDirectUrlsMode &&
        renderActionBar()}
    </div>
  );
}
