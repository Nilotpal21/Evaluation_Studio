'use client';

/**
 * SiteDiscovery — Consolidated site discovery card.
 *
 * Replaces the old ProfilingTrail + Site Profile sidebar + Discovery Summary
 * sidebar with a single, incrementally-updating card that shows:
 *
 * 1. "Analyzing site..." spinner (while profiling)
 * 2. Domain + technology (after profile arrives)
 * 3. Sitemap file list with staggered animation (after profile)
 * 4. "Organizing into sections..." spinner (while clustering)
 * 5. Pages + sections count (after clustering)
 *
 * Placed ABOVE StrategySelector in State2Analysis so the user reads the
 * narrative top-to-bottom: "here's what we found" → "now choose a strategy."
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  Bot,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Globe,
  Loader2,
  Cpu,
  LayoutGrid,
} from 'lucide-react';
import { springs, STAGGER_DELAY } from '@/lib/animation';
import { Badge } from '../../ui/Badge';
import type { SitemapDiscovery, SitemapDiscoveryStep, ProfileResponse } from '@/api/crawl';

// ─── Types ───────────────────────────────────────────────────────────

interface SiteDiscoveryProps {
  /** Profile response — null while Phase A is running */
  profile: ProfileResponse | null;
  /** Whether Phase A (profiling) is still running */
  isAnalyzing: boolean;
  /** Whether Phase B (clustering) is still running */
  clusteringInProgress: boolean;
  /** Total pages from clustering (0 while clustering) */
  totalPages: number;
  /** Total sections from clustering (0 while clustering) */
  totalSections: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Pick the right icon for a discovery step source */
function stepIcon(source: SitemapDiscoveryStep['source']) {
  if (source === 'robots.txt') return Bot;
  if (source === 'user-provided') return Globe;
  return FileText;
}

/** Pick the right status icon + color */
function statusIcon(status: SitemapDiscoveryStep['status']) {
  switch (status) {
    case 'found':
      return { Icon: CheckCircle2, color: 'text-success' };
    case 'not_found':
      return { Icon: XCircle, color: 'text-muted' };
    case 'error':
      return { Icon: AlertCircle, color: 'text-warning' };
  }
}

/** Extract short display name from full sitemap URL */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return url;
  }
}

/** Format large numbers with locale separators */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

// ─── Component ───────────────────────────────────────────────────────

export function SiteDiscovery({
  profile,
  isAnalyzing,
  clusteringInProgress,
  totalPages,
  totalSections,
}: SiteDiscoveryProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [expanded, setExpanded] = useState(true);

  const sitemapDiscovery = profile?.sitemapDiscovery;
  const hasProfile = !!profile;

  // Deduplicate steps by URL — same sitemap can be discovered via default + robots.txt
  const deduplicatedSteps = sitemapDiscovery?.steps.filter(
    (step, idx, arr) => arr.findIndex((s) => s.url === step.url) === idx,
  );
  const hasSitemapSteps = deduplicatedSteps && deduplicatedSteps.length > 0;
  const totalUrls = sitemapDiscovery?.totalUrls ?? 0;
  // Use deduplicated file count for the badge
  const foundCount = deduplicatedSteps?.filter((s) => s.status === 'found').length ?? 0;
  const hasResults = totalUrls > 0;
  const domain = profile?.domain;
  const technology = profile?.platform ?? profile?.siteType;
  const clusteringDone = hasProfile && !clusteringInProgress && !isAnalyzing;

  // Show card in 3 cases: analyzing, profile ready, or has sitemap data
  if (!isAnalyzing && !hasProfile) {
    return null;
  }

  /** Build the header summary badge text */
  const headerBadge = () => {
    if (!hasProfile) return null;
    const parts: string[] = [];
    if (hasResults) {
      parts.push(
        t('site_discovery_found_summary', {
          files: foundCount.toString(),
          urls: totalUrls.toString(),
        }),
      );
    }
    if (clusteringDone && totalPages > 0) {
      parts.push(
        t('site_discovery_sections_summary', {
          pages: formatNumber(totalPages),
          sections: totalSections.toString(),
        }),
      );
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.default}
      className="rounded-lg border border-default bg-background-subtle"
    >
      {/* Summary header — always visible, toggles expansion */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-default hover:bg-background-muted/50 rounded-lg"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="w-4 h-4 text-accent shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {t('site_discovery_title')}
          </span>
          {!hasProfile && isAnalyzing && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted shrink-0" />
          )}
          {headerBadge() && (
            <Badge variant="success" size="sm">
              {headerBadge()}
            </Badge>
          )}
          {hasProfile && !hasResults && !clusteringInProgress && totalPages === 0 && (
            <Badge variant="default" size="sm">
              {t('profiling_trail_none_found')}
            </Badge>
          )}
        </div>
        {hasProfile && (
          <>
            {expanded ? (
              <ChevronUp className="w-4 h-4 text-muted shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted shrink-0" />
            )}
          </>
        )}
      </button>

      {/* Expandable body */}
      <AnimatePresence initial={true}>
        {expanded && hasProfile && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.gentle}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 space-y-2">
              {/* Domain + technology line */}
              <motion.div
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={springs.soft}
                className="flex items-center gap-3 text-xs"
              >
                <span className="flex items-center gap-1.5 text-muted">
                  <Globe className="w-3.5 h-3.5" />
                  <span className="text-foreground font-medium">{domain}</span>
                </span>
                {technology && (
                  <span className="flex items-center gap-1.5 text-muted">
                    <Cpu className="w-3.5 h-3.5" />
                    <span className="text-foreground font-medium">{technology}</span>
                  </span>
                )}
              </motion.div>

              {/* Sitemap file trail — staggered reveal */}
              {hasSitemapSteps &&
                deduplicatedSteps.map((step, idx) => {
                  const SourceIcon = stepIcon(step.source);
                  const { Icon: StatusIcon, color } = statusIcon(step.status);

                  return (
                    <motion.div
                      key={`${step.source}-${step.url}-${idx}`}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        ...springs.soft,
                        delay: (idx + 1) * STAGGER_DELAY * 3, // +1 offset for domain line
                      }}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-border shrink-0" />
                      <SourceIcon className="w-3.5 h-3.5 text-muted shrink-0" />
                      <a
                        href={step.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted hover:text-info hover:underline truncate"
                        title={step.url}
                      >
                        {shortUrl(step.url)}
                      </a>
                      <StatusIcon className={`w-3.5 h-3.5 ${color} shrink-0`} />
                      {step.status === 'found' && step.urlCount != null && (
                        <span className="text-muted whitespace-nowrap">
                          {t('profiling_trail_step_urls', {
                            count: step.urlCount.toString(),
                          })}
                        </span>
                      )}
                      {step.type === 'index' && (
                        <Badge variant="info" size="sm">
                          {t('profiling_trail_index_badge')}
                        </Badge>
                      )}
                    </motion.div>
                  );
                })}

              {/* Clustering in progress — animated spinner */}
              {clusteringInProgress && (
                <motion.div
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={springs.soft}
                  className="flex items-center gap-2 text-xs"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />
                  <span className="text-muted">{t('site_discovery_organizing')}</span>
                </motion.div>
              )}

              {/* Pages + sections — shown after clustering completes */}
              {clusteringDone && totalPages > 0 && (
                <motion.div
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={springs.soft}
                  className="flex items-center gap-2 text-xs"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                  <span className="text-foreground font-medium">
                    {t('site_discovery_pages_sections', {
                      pages: formatNumber(totalPages),
                      sections: totalSections.toString(),
                    })}
                  </span>
                </motion.div>
              )}

              {/* No sitemap found — immediate completion */}
              {clusteringDone && !hasResults && totalPages === 0 && (
                <motion.div
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={springs.soft}
                  className="flex items-center gap-2 text-xs"
                >
                  <LayoutGrid className="w-3.5 h-3.5 text-muted shrink-0" />
                  <span className="text-muted">{t('site_discovery_no_sitemap')}</span>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
