'use client';

/**
 * ProfilingTrail — Animated discovery trail showing how sitemaps were found.
 *
 * Renders each profiler step (default /sitemap.xml, robots.txt directives, index
 * expansion) with a staggered reveal animation, then compacts into an expandable
 * one-line summary so it doesn't dominate the layout once the user has read it.
 *
 * Placed ABOVE StrategySelector in State2Analysis so the user reads the narrative
 * top-to-bottom: "here's what we found" → "now choose a strategy."
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
} from 'lucide-react';
import { springs, STAGGER_DELAY } from '@/lib/animation';
import { Badge } from '../../ui/Badge';
import type { SitemapDiscovery, SitemapDiscoveryStep } from '@/api/crawl';

// ─── Types ───────────────────────────────────────────────────────────

interface ProfilingTrailProps {
  /** Sitemap discovery result from the profile endpoint (T-4 ProfileResponse) */
  sitemapDiscovery?: SitemapDiscovery;
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

// ─── Component ───────────────────────────────────────────────────────

export function ProfilingTrail({ sitemapDiscovery }: ProfilingTrailProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [expanded, setExpanded] = useState(true);

  // Nothing to show if no discovery data or no steps
  if (!sitemapDiscovery || sitemapDiscovery.steps.length === 0) {
    return null;
  }

  const { steps, sitemapFiles, totalUrls } = sitemapDiscovery;
  const foundCount = sitemapFiles.length;
  const hasResults = totalUrls > 0;

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
            {t('profiling_trail_title')}
          </span>
          {hasResults ? (
            <Badge variant="success" size="sm">
              {t('profiling_trail_found_summary', {
                files: foundCount.toString(),
                urls: totalUrls.toString(),
              })}
            </Badge>
          ) : (
            <Badge variant="default" size="sm">
              {t('profiling_trail_none_found')}
            </Badge>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-muted shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted shrink-0" />
        )}
      </button>

      {/* Step-by-step trail */}
      <AnimatePresence initial={true}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.gentle}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 space-y-1.5">
              {steps.map((step, idx) => {
                const SourceIcon = stepIcon(step.source);
                const { Icon: StatusIcon, color } = statusIcon(step.status);

                return (
                  <motion.div
                    key={`${step.source}-${step.url}-${idx}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      ...springs.soft,
                      delay: idx * STAGGER_DELAY * 3, // ~150ms stagger
                    }}
                    className="flex items-center gap-2 text-xs"
                  >
                    {/* Connector dot for visual trail */}
                    <span className="w-1.5 h-1.5 rounded-full bg-border shrink-0" />

                    <SourceIcon className="w-3.5 h-3.5 text-muted shrink-0" />

                    <a
                      href={step.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline truncate"
                      title={step.url}
                      onClick={(e) => e.stopPropagation()}
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
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
