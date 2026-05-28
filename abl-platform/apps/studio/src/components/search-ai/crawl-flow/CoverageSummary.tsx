'use client';

/**
 * CoverageSummary — Post-discovery transparency panel.
 *
 * Shows discovered categories with confidence bars, unexplored nav gaps,
 * objectives tracking, and iteration history.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Compass, Plus, ArrowRight, Grid3X3 } from 'lucide-react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '@/lib/animation';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import type {
  CoverageAnalysis,
  DiscoveryObjective,
  DiscoveryIteration,
  DiscoveredCategory,
  SelectionSummary,
} from './types';

// ─── Props ──────────────────────────────────────────────────────────

interface CoverageSummaryProps {
  coverage: CoverageAnalysis;
  objectives: DiscoveryObjective[];
  iterations: DiscoveryIteration[];
  selectionSummary?: SelectionSummary;
  onExplore: (url: string) => void;
  onAddObjective: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Format a duration in ms to human-readable. */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

// ─── Sub-components ─────────────────────────────────────────────────

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 rounded-full bg-background-muted overflow-hidden">
        <div
          className={clsx(
            'h-full rounded-full transition-all duration-500',
            pct >= 70 ? 'bg-success' : pct >= 40 ? 'bg-warning' : 'bg-error',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}

function CategoryRow({
  category,
  t,
}: {
  category: DiscoveredCategory;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-foreground truncate flex-1 min-w-0">{category.label}</span>
      <span className="text-[10px] text-muted whitespace-nowrap">
        {t('coverage_urls_found', { count: category.urlCount.toString() })}
      </span>
      <ConfidenceBar confidence={category.confidence} />
      {category.matchedObjectives.length > 0 && (
        <Badge variant="accent" className="text-[9px]">
          {category.matchedObjectives.length}
        </Badge>
      )}
    </div>
  );
}

function UnexploredRow({
  label,
  onExplore,
  t,
}: {
  label: string;
  onExplore: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted truncate flex-1 min-w-0">{label}</span>
      <Button variant="ghost" size="xs" onClick={onExplore} icon={<Compass className="w-3 h-3" />}>
        {t('coverage_explore_btn')}
      </Button>
    </div>
  );
}

/** Get the trigger icon component for an iteration */
function TriggerIcon({ trigger }: { trigger: DiscoveryIteration['trigger'] }) {
  switch (trigger) {
    case 'initial':
      return <Compass className="w-3 h-3 shrink-0" />;
    case 'explore-branch':
      return <ArrowRight className="w-3 h-3 shrink-0" />;
    case 'add-sample':
      return <Plus className="w-3 h-3 shrink-0" />;
    case 'explore-all-nav':
    case 'explore-all':
      return <Grid3X3 className="w-3 h-3 shrink-0" />;
    default:
      return <Compass className="w-3 h-3 shrink-0" />;
  }
}

function IterationRow({ iteration }: { iteration: DiscoveryIteration }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[10px] text-muted">
      <TriggerIcon trigger={iteration.trigger} />
      <span className="font-mono truncate flex-1 min-w-0">
        {(() => {
          try {
            return new URL(iteration.seedUrl).pathname;
          } catch {
            return iteration.seedUrl;
          }
        })()}
      </span>
      <span className="whitespace-nowrap tabular-nums">+{iteration.newUrlsDiscovered}</span>
      <span className="whitespace-nowrap tabular-nums">{iteration.pagesVisited}p</span>
      <span className="whitespace-nowrap tabular-nums">
        {formatDurationMs(iteration.durationMs)}
      </span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function CoverageSummary({
  coverage,
  objectives,
  iterations,
  selectionSummary,
  onExplore,
  onAddObjective,
}: CoverageSummaryProps) {
  const t = useTranslations('search_ai.crawl_flow');

  const exploredCategories = useMemo(
    () => coverage.categories.filter((c) => c.explored),
    [coverage.categories],
  );

  const unexploredCategories = useMemo(
    () => coverage.categories.filter((c) => !c.explored),
    [coverage.categories],
  );

  const navCoveragePct = Math.round(coverage.navCoverageRatio * 100);

  // Aggregate stats across iterations
  const aggregateStats = useMemo(() => {
    if (iterations.length === 0) return null;
    const totalUrls = iterations.reduce((sum, it) => sum + it.newUrlsDiscovered, 0);
    const totalPages = iterations.reduce((sum, it) => sum + it.pagesVisited, 0);
    return { count: iterations.length, urls: totalUrls, pages: totalPages };
  }, [iterations]);

  // Selection progress percentage
  const selectionPct = useMemo(() => {
    if (!selectionSummary || selectionSummary.availableCount === 0) return 0;
    return Math.min(
      100,
      Math.round((selectionSummary.selectedCount / selectionSummary.availableCount) * 100),
    );
  }, [selectionSummary]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.gentle}
      className="space-y-3"
    >
      <Card hoverable={false} padding="sm">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">{t('coverage_title')}</h3>
          <span className="text-[10px] text-muted">
            {t('coverage_nav_coverage', { ratio: navCoveragePct.toString() })}
          </span>
        </div>

        {/* Selected vs available counter */}
        {selectionSummary && selectionSummary.availableCount > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-foreground">
                {t('iterate_counter', {
                  selected: selectionSummary.selectedCount.toString(),
                  available: selectionSummary.availableCount.toString(),
                })}
              </span>
              <span className="text-[10px] text-muted tabular-nums">{selectionPct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-background-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500"
                style={{ width: `${selectionPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Categories section */}
        {exploredCategories.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] font-medium text-muted uppercase tracking-wide">
                {t('coverage_categories')}{' '}
                <span className="normal-case font-normal">
                  {t('coverage_categories_qualifier')}
                </span>
              </span>
              <span className="text-[10px] text-subtle">{t('coverage_confidence')}</span>
            </div>
            <div className="divide-y divide-default">
              {exploredCategories.map((cat) => (
                <CategoryRow key={cat.label} category={cat} t={t} />
              ))}
            </div>
          </div>
        )}

        {/* Not Yet Explored section */}
        {(unexploredCategories.length > 0 || coverage.unexploredNavCategories.length > 0) && (
          <div className="mb-3">
            <span className="text-[10px] font-medium text-muted uppercase tracking-wide block mb-1.5">
              {t('coverage_not_explored')}
            </span>
            <div className="divide-y divide-default">
              {unexploredCategories.map((cat) => (
                <UnexploredRow
                  key={cat.label}
                  label={`${cat.label} (${cat.urlCount})`}
                  onExplore={() => onExplore(cat.pattern)}
                  t={t}
                />
              ))}
              {coverage.unexploredNavCategories.map((label) => (
                <UnexploredRow key={label} label={label} onExplore={() => onExplore(label)} t={t} />
              ))}
            </div>
            {unexploredCategories.length + coverage.unexploredNavCategories.length > 0 && (
              <p className="text-[10px] text-muted mt-1.5 italic">
                {t('coverage_unexplored_branches', {
                  count: (
                    unexploredCategories.length + coverage.unexploredNavCategories.length
                  ).toString(),
                })}
              </p>
            )}
          </div>
        )}

        {/* Objectives section */}
        {objectives.length > 0 && (
          <div className="mb-3">
            <span className="text-[10px] font-medium text-muted uppercase tracking-wide block mb-1.5">
              {t('coverage_objectives')}
            </span>
            <div className="space-y-1.5">
              {objectives.map((obj) => (
                <div key={obj.id} className="flex items-center gap-3 text-xs">
                  <span className="text-foreground truncate flex-1 min-w-0">{obj.query}</span>
                  <span className="text-muted whitespace-nowrap tabular-nums">
                    {obj.matchCount}/{obj.estimatedTotal}
                  </span>
                  <ConfidenceBar
                    confidence={obj.estimatedTotal > 0 ? obj.matchCount / obj.estimatedTotal : 0}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Iteration history */}
        {iterations.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-medium text-muted uppercase tracking-wide">
                {t('coverage_iteration_history')}
              </span>
              {aggregateStats && (
                <span className="text-[10px] text-muted">
                  {t('iterate_history_aggregate', {
                    count: aggregateStats.count.toString(),
                    urls: aggregateStats.urls.toString(),
                    pages: aggregateStats.pages.toString(),
                  })}
                </span>
              )}
            </div>
            <div className="divide-y divide-default">
              {iterations.map((iter) => (
                <IterationRow key={iter.id} iteration={iter} />
              ))}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-2 border-t border-default">
          <Button
            variant="primary"
            size="sm"
            icon={<ArrowRight className="w-3.5 h-3.5" />}
            onClick={() => onExplore('__proceed__')}
          >
            {t('coverage_proceed')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={onAddObjective}
          >
            {t('coverage_add_objective')}
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}
