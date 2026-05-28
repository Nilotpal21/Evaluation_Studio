'use client';

/**
 * ErrorGroupingPanel — Separates crawl errors from pipeline errors.
 *
 * Section 1: Crawl Errors — grouped by backend-provided CrawlErrorType
 * Section 2: Processing Errors — pipeline failures (SearchDocuments with status=error)
 * Each group shows remediation guidance from i18n.
 *
 * Data comes from parent via props (no internal SWR fetch).
 */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { submitBatchCrawl } from '@/api/crawl';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { CrawledPage, CrawlErrorEntry, CrawlErrorType } from '@/api/crawl';

export interface ErrorGroupingPanelProps {
  jobId: string;
  indexId: string;
  sourceId: string;
  crawlErrors: CrawlErrorEntry[];
  pipelineErrors: CrawledPage[];
  /** When crawlErrors is empty but failures exist, show "details unavailable" message */
  totalFailed?: number;
  totalBlocked?: number;
}

interface CrawlErrorGroup {
  type: CrawlErrorType;
  entries: CrawlErrorEntry[];
}

interface PipelineErrorGroup {
  message: string;
  pages: CrawledPage[];
}

function truncateUrl(url: string, maxLength = 60): string {
  if (url.length <= maxLength) return url;
  return url.slice(0, maxLength) + '\u2026';
}

export function ErrorGroupingPanel({
  jobId,
  indexId,
  sourceId,
  crawlErrors,
  pipelineErrors,
  totalFailed = 0,
  totalBlocked = 0,
}: ErrorGroupingPanelProps) {
  const t = useTranslations('search_ai.crawled_pages');
  const [retryingGroup, setRetryingGroup] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Group crawl errors by type
  const crawlErrorGroups = useMemo<CrawlErrorGroup[]>(() => {
    const groups = new Map<CrawlErrorType, CrawlErrorEntry[]>();
    for (const entry of crawlErrors) {
      const existing = groups.get(entry.type) ?? [];
      existing.push(entry);
      groups.set(entry.type, existing);
    }
    return Array.from(groups.entries())
      .map(([type, entries]) => ({ type, entries }))
      .sort((a, b) => b.entries.length - a.entries.length);
  }, [crawlErrors]);

  // Group pipeline errors by error message similarity
  const pipelineErrorGroups = useMemo<PipelineErrorGroup[]>(() => {
    const groups = new Map<string, CrawledPage[]>();
    for (const page of pipelineErrors) {
      const msg = page.error || 'Unknown error';
      // Normalize: take first 80 chars to group similar messages
      const key = msg.slice(0, 80);
      const existing = groups.get(key) ?? [];
      existing.push(page);
      groups.set(key, existing);
    }
    return Array.from(groups.entries())
      .map(([message, pages]) => ({ message, pages }))
      .sort((a, b) => b.pages.length - a.pages.length);
  }, [pipelineErrors]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleRetryAll = async (urls: string[], groupKey: string) => {
    setRetryingGroup(groupKey);
    try {
      await submitBatchCrawl({
        urls,
        sourceId,
        indexId,
        strategy: 'single-page',
      });
      toast.success(t('retry_submitted', { url: `${urls.length} pages` }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('retry_failed'));
    } finally {
      setRetryingGroup(null);
    }
  };

  // Nothing to show
  if (crawlErrors.length === 0 && pipelineErrors.length === 0) {
    // Historical job with failures but no CrawlError documents
    if (totalFailed > 0 || totalBlocked > 0) {
      return (
        <div className="mt-4" data-testid="usp-error-grouping">
          <Card padding="md" hoverable={false} className="flex items-center gap-3">
            <Info className="h-4 w-4 text-info shrink-0" />
            <p className="text-sm text-muted">{t('error_details_unavailable')}</p>
          </Card>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="mt-4 space-y-4" data-testid="usp-error-grouping">
      {/* Section 1: Crawl Errors */}
      {crawlErrorGroups.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-error" />
            {t('crawl_status')}
            <Badge variant="error">{crawlErrors.length}</Badge>
          </h3>
          {crawlErrorGroups.map((group) => {
            const groupKey = `crawl-${group.type}`;
            const isExpanded = expandedGroups.has(groupKey);
            const errorTypeKey = `error_types.${group.type}` as Parameters<typeof t>[0];
            const remediationKey = `remediation.${group.type}` as Parameters<typeof t>[0];

            return (
              <Card
                key={groupKey}
                padding="md"
                hoverable={false}
                data-testid={`usp-error-group-${group.type}`}
              >
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => toggleGroup(groupKey)}
                    className="flex items-center gap-2 text-left flex-1 min-w-0"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted shrink-0" />
                    )}
                    <span className="text-sm font-medium text-foreground">{t(errorTypeKey)}</span>
                    <Badge variant="default">{group.entries.length}</Badge>
                  </button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      handleRetryAll(
                        group.entries.map((e) => e.url),
                        groupKey,
                      )
                    }
                    disabled={retryingGroup === groupKey}
                    className="ml-3 shrink-0"
                  >
                    <RefreshCw
                      className={`w-3 h-3 mr-1 ${retryingGroup === groupKey ? 'animate-spin' : ''}`}
                    />
                    {t('retry_with_ai')}
                  </Button>
                </div>
                {/* Remediation guidance */}
                <p className="text-xs text-muted mt-1 ml-6">{t(remediationKey)}</p>
                {/* Expanded URL list */}
                {isExpanded && (
                  <div className="mt-2 ml-6 space-y-1">
                    {group.entries.slice(0, 20).map((entry, idx) => (
                      <div key={`${entry.url}-${idx}`} className="flex items-center gap-2 text-xs">
                        <a
                          href={entry.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-info hover:underline truncate flex-1"
                        >
                          {truncateUrl(entry.url, 80)}
                        </a>
                        {entry.statusCode && (
                          <span className="text-muted shrink-0">{entry.statusCode}</span>
                        )}
                      </div>
                    ))}
                    {group.entries.length > 20 && (
                      <p className="text-xs text-muted">+{group.entries.length - 20} more</p>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Section 2: Processing Errors */}
      {pipelineErrorGroups.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {t('index_status')}
            <Badge variant="warning">{pipelineErrors.length}</Badge>
          </h3>
          {pipelineErrorGroups.map((group) => {
            const groupKey = `pipeline-${group.message.slice(0, 40)}`;
            const isExpanded = expandedGroups.has(groupKey);

            return (
              <Card key={groupKey} padding="md" hoverable={false}>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => toggleGroup(groupKey)}
                    className="flex items-center gap-2 text-left flex-1 min-w-0"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted shrink-0" />
                    )}
                    <span className="text-sm text-foreground truncate">{group.message}</span>
                    <Badge variant="default">{group.pages.length}</Badge>
                  </button>
                </div>
                {isExpanded && (
                  <div className="mt-2 ml-6 space-y-1">
                    {group.pages.slice(0, 20).map((page, idx) => (
                      <div key={`${page.url}-${idx}`} className="flex items-center gap-2 text-xs">
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-info hover:underline truncate flex-1"
                        >
                          {truncateUrl(page.url, 80)}
                        </a>
                      </div>
                    ))}
                    {group.pages.length > 20 && (
                      <p className="text-xs text-muted">+{group.pages.length - 20} more</p>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
