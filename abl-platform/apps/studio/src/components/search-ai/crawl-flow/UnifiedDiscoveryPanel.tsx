'use client';

/**
 * UnifiedDiscoveryPanel — BFS site discovery orchestrator.
 *
 * Uses the `useDiscovery` SSE hook to run BFS discovery and merges
 * streaming events into the unified tree via pure tree-merge functions.
 *
 * State machine: idle → starting → running → complete | error
 * Tree state is lifted to parent (State2Analysis) via `tree` / `onTreeChange`.
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Circle, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { springs } from '@/lib/animation';
import { Button } from '../../ui/Button';
import { UnifiedTree } from './discovery/UnifiedTree';
import { AddFromSitemapButton } from './discovery/AddFromSitemapButton';
import type { TreeViewMode } from './discovery/UnifiedTreeHeader';
import { useDiscovery } from '@/hooks/useDiscovery';
import {
  treeSnapshotToUnifiedTree,
  markNodeExploring,
  markNodeError,
} from './discovery/tree-merge';
import { treeToSections } from './discovery/tree-to-sections';
import type { UnifiedTreeNode } from './discovery/unified-tree-types';
import type { UnifiedDiscoveryPanelProps, ActivityEntry } from './types';
import type { StartDiscoveryRequest } from '@/api/discovery';

// ─── Constants ────────────────────────────────────────────────────────

const MAX_ACTIVITY_LOG = 200;

const PHASE_LABELS: Record<string, string> = {
  '0': 'discovery_phase_nav',
  '1a': 'discovery_phase_seeds',
  '1b': 'discovery_phase_children',
  '2': 'discovery_phase_climb',
  '3': 'discovery_phase_expand',
};

/** Unique ID counter for activity entries */
let activityIdCounter = 0;
function nextActivityId(): string {
  activityIdCounter += 1;
  return `act-${activityIdCounter}`;
}

// ─── Component ────────────────────────────────────────────────────────

export function UnifiedDiscoveryPanel({
  primaryUrl,
  sampleUrls,
  seeds,
  onSectionsReady,
  onTreeChange,
  tree,
  maxDepth,
  sourceId,
  hasSitemap,
  sitemapUrls,
}: UnifiedDiscoveryPanelProps) {
  const t = useTranslations('search_ai.crawl_flow');

  // ─── Local state ──────────────────────────────────────────────────
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [currentPhaseKey, setCurrentPhaseKey] = useState<string>('');
  const [viewMode, setViewMode] = useState<TreeViewMode>('hybrid');

  // ─── Refs ─────────────────────────────────────────────────────────
  // Guard against double-start in StrictMode
  const startedRef = useRef(false);

  // Reduced motion check
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // ─── Activity log helpers ─────────────────────────────────────────

  const addActivity = useCallback(
    (level: ActivityEntry['level'], message: string, messageParams?: Record<string, string>) => {
      const entry: ActivityEntry = {
        id: nextActivityId(),
        timestamp: Date.now(),
        level,
        message,
        messageParams,
      };
      setActivityLog((prev) => {
        const next = [...prev, entry];
        if (next.length > MAX_ACTIVITY_LOG) {
          return next.slice(next.length - MAX_ACTIVITY_LOG);
        }
        return next;
      });
    },
    [],
  );

  // ─── Discovery hook ───────────────────────────────────────────────

  const discovery = useDiscovery({
    onTreeSnapshot: (event) => {
      const unified = treeSnapshotToUnifiedTree(event.tree, sampleUrls);
      onTreeChange(unified);
    },
    onPhaseChange: (event) => {
      const phaseKey = String(event.phase);
      setCurrentPhaseKey(phaseKey);
      const labelKey = PHASE_LABELS[phaseKey];
      if (labelKey) {
        addActivity('milestone', labelKey);
      }
    },
    onActivity: (event) => {
      const level: ActivityEntry['level'] =
        event.level === 'warn' ? 'warning' : event.level === 'detail' ? 'detail' : 'milestone';
      addActivity(level, event.message);
    },
    onComplete: (event) => {
      if (event.tree) {
        const unified = treeSnapshotToUnifiedTree(event.tree, sampleUrls);
        onTreeChange(unified);
      }
      addActivity('milestone', 'discovery_complete_summary', {
        total: String(event.totalUrls),
        duration: formatDuration(event.durationMs),
      });
    },
  });

  // ─── Auto-start on mount ─────────────────────────────────────────

  useEffect(() => {
    if (startedRef.current) return;
    if (seeds.length === 0) return;
    startedRef.current = true;

    const req: StartDiscoveryRequest = {
      primaryUrl,
      sampleUrls,
      seeds,
      maxDepth,
      sourceId,
    };
    // Fire-and-forget — errors are captured by the hook's error state
    discovery.start(req).catch(() => {
      // Error state is set by the hook internally
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once on mount
  }, []);

  // ─── Configure crawl handler ──────────────────────────────────────

  const handleConfigureCrawl = useCallback(() => {
    const { sections } = treeToSections(tree);
    onSectionsReady(sections);
  }, [tree, onSectionsReady]);

  // ─── Stop handler ─────────────────────────────────────────────────

  const handleStop = useCallback(() => {
    discovery.stop().catch(() => {
      // Best effort — error logged by hook
    });
  }, [discovery]);

  // ─── Retry handler ────────────────────────────────────────────────

  const handleRetry = useCallback(() => {
    startedRef.current = false;
    const req: StartDiscoveryRequest = {
      primaryUrl,
      sampleUrls,
      seeds,
      maxDepth,
      sourceId,
    };
    startedRef.current = true;
    discovery.start(req).catch(() => {
      // Error state is set by the hook internally
    });
  }, [discovery, primaryUrl, sampleUrls, seeds, maxDepth, sourceId]);

  // ─── Explore node handler ────────────────────────────────────────

  const handleExploreNode = useCallback(
    async (nodeId: string, nodeUrl: string) => {
      // Optimistically mark node as exploring in tree
      onTreeChange(markNodeExploring(tree, nodeId, `explore-${nodeId}`));

      try {
        await discovery.exploreBranch(nodeUrl);
      } catch (err) {
        // Revert to error state on failure
        const message = err instanceof Error ? err.message : String(err);
        onTreeChange(markNodeError(tree, nodeId, message || 'Failed to start exploration'));
      }
    },
    [tree, onTreeChange, discovery],
  );

  // ─── Tree change handler (for toggle operations from UnifiedTree) ──

  const handleTreeChange = useCallback(
    (newTree: UnifiedTreeNode[]) => {
      onTreeChange(newTree);
    },
    [onTreeChange],
  );

  // ─── Derived state ───────────────────────────────────────────────

  const isRunning = discovery.status === 'running' || discovery.status === 'starting';
  const isComplete = discovery.status === 'complete';
  const isError = discovery.status === 'error';

  const phaseLabel = useMemo(() => {
    if (discovery.status === 'starting') return t('discovery_starting');
    if (isComplete) return t('discovery_exploration_complete');
    const labelKey = PHASE_LABELS[currentPhaseKey];
    if (labelKey) return t(labelKey);
    return t('discovery_exploring_site');
  }, [discovery.status, isComplete, currentPhaseKey, t]);

  // ─── Activity log filtering ───────────────────────────────────────

  const visibleActivity = useMemo(() => {
    if (showDetails) return activityLog;
    return activityLog.filter((e) => e.level === 'milestone' || e.level === 'warning');
  }, [activityLog, showDetails]);

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-3" data-testid="discovery-panel">
      {/* Phase indicator */}
      {isRunning && (
        <div className="flex items-center gap-2">
          {prefersReducedMotion ? (
            <Circle className="w-3 h-3 text-accent" />
          ) : (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-accent" />
            </span>
          )}
          <span className="text-sm font-medium text-foreground">{phaseLabel}</span>
          {prefersReducedMotion && (
            <span className="text-xs text-muted">({t('discovery_phase_running')})</span>
          )}
        </div>
      )}

      {/* Live stats */}
      {isRunning && (discovery.progress.totalUrls > 0 || discovery.progress.totalVisited > 0) && (
        <div className="text-xs text-muted">
          {t('discovery_found_urls', {
            total: String(discovery.progress.totalUrls),
            visited: String(discovery.progress.totalVisited),
          })}
        </div>
      )}

      {/* Complete header */}
      {isComplete && (
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-success" />
          <span className="text-sm font-medium text-foreground">{phaseLabel}</span>
        </div>
      )}

      {/* Error state */}
      <AnimatePresence>
        {isError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={springs.gentle}
            className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
          >
            <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
            <span className="text-sm text-destructive">
              {t('discovery_error', { message: discovery.error ?? '' })}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Activity log */}
      {visibleActivity.length > 0 && (
        <div className="space-y-1">
          <div
            className={clsx(
              'max-h-28 overflow-y-auto space-y-0.5 text-xs',
              'scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent',
            )}
          >
            {visibleActivity.map((entry) => (
              <div
                key={entry.id}
                className={clsx(
                  'flex items-start gap-1.5',
                  entry.level === 'warning' ? 'text-warning' : 'text-muted',
                )}
              >
                <span className="shrink-0 tabular-nums text-[10px] leading-4 opacity-60">
                  {new Date(entry.timestamp).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <span>{t(entry.message, entry.messageParams ?? {})}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => setShowDetails((prev) => !prev)}
            className="flex items-center gap-1 text-[11px] text-muted hover:text-foreground transition-default"
          >
            {showDetails ? (
              <>
                <ChevronUp className="w-3 h-3" />
                {t('discovery_hide_details')}
              </>
            ) : (
              <>
                <ChevronDown className="w-3 h-3" />
                {t('discovery_show_details')}
              </>
            )}
          </button>
        </div>
      )}

      {/* Unified Tree */}
      {tree.length > 0 && (
        <UnifiedTree
          tree={tree}
          onTreeChange={handleTreeChange}
          onExploreNode={handleExploreNode}
          onConfigureCrawl={handleConfigureCrawl}
          isExploring={false}
          sampleUrls={sampleUrls}
          mode={isComplete ? 'select' : 'live'}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          hasSitemap={hasSitemap}
        />
      )}

      {/* Action buttons */}
      <AnimatePresence>
        {isRunning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={springs.snappy}
            className="flex items-center gap-2 pt-1"
          >
            <Button variant="secondary" size="sm" onClick={handleStop}>
              {t('discovery_stop_review')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isComplete && tree.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={springs.snappy}
            className="flex items-center gap-2 pt-1"
          >
            <Button variant="primary" size="sm" onClick={handleConfigureCrawl}>
              {t('discovery_configure')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={springs.snappy}
            className="flex items-center gap-2 pt-1"
          >
            <Button variant="primary" size="sm" onClick={handleRetry}>
              {t('discovery_retry')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sitemap merge button+dialog — visible when discovery is complete and sitemap URLs exist */}
      {isComplete && sitemapUrls && sitemapUrls.length > 0 && (
        <AddFromSitemapButton
          primaryUrl={primaryUrl}
          tree={tree}
          onTreeChange={onTreeChange}
          sitemapUrls={sitemapUrls}
          isDiscovering={isRunning}
        />
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Format duration in ms to a human-readable string */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}
