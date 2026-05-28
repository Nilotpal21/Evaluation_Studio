'use client';

/**
 * ContentBreakdown
 *
 * Renders content distribution by type (horizontal bars) and by site (list).
 * Uses useContentBreakdown hook. Shows skeleton while loading.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Progress } from '../../ui/Progress';
import { Button } from '../../ui/Button';
import { useContentBreakdown } from '../../../hooks/useContentBreakdown';

interface ContentBreakdownProps {
  indexId: string;
  connectorId: string;
}

const MAX_TYPES = 5;
const MAX_SITES = 10;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ContentBreakdown({ indexId, connectorId }: ContentBreakdownProps) {
  const t = useTranslations('search_ai.sharepoint.overview');
  const { breakdown, isLoading } = useContentBreakdown(indexId, connectorId);
  const [showAllSites, setShowAllSites] = useState(false);

  const displayTypes = useMemo(() => {
    if (!breakdown?.byType) return [];
    if (breakdown.byType.length <= MAX_TYPES) return breakdown.byType;

    const top = breakdown.byType.slice(0, MAX_TYPES);
    const rest = breakdown.byType.slice(MAX_TYPES);
    const otherCount = rest.reduce((sum, item) => sum + item.count, 0);
    const otherPercentage = rest.reduce((sum, item) => sum + item.percentage, 0);
    return [...top, { type: t('other_types'), count: otherCount, percentage: otherPercentage }];
  }, [breakdown, t]);

  const displaySites = useMemo(() => {
    if (!breakdown?.bySite) return [];
    if (showAllSites) return breakdown.bySite;
    return breakdown.bySite.slice(0, MAX_SITES);
  }, [breakdown, showAllSites]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{t('content_breakdown_title')}</h3>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-6 bg-background-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!breakdown) return null;

  const totalSites = breakdown.bySite.length;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-foreground">{t('content_breakdown_title')}</h3>

      {/* By Type */}
      {displayTypes.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted font-medium uppercase tracking-wider">{t('by_type')}</p>
          {displayTypes.map((item) => (
            <div key={item.type} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-foreground">{item.type}</span>
                <span className="text-muted">
                  {item.count} ({item.percentage.toFixed(0)}%)
                </span>
              </div>
              <Progress value={item.percentage} />
            </div>
          ))}
        </div>
      )}

      {/* By Site */}
      {displaySites.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted font-medium uppercase tracking-wider">{t('by_site')}</p>
          <div className="space-y-1.5">
            {displaySites.map((site) => (
              <div
                key={site.siteName}
                className="flex items-center justify-between text-xs py-1 border-b border-default last:border-0"
              >
                <span className="text-foreground truncate max-w-[60%]">{site.siteName}</span>
                <span className="text-muted shrink-0">
                  {site.docCount} docs &middot; {formatSize(site.size)}
                </span>
              </div>
            ))}
          </div>
          {!showAllSites && totalSites > MAX_SITES && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setShowAllSites(true)}
              aria-label={t('show_all_sites', { count: totalSites })}
            >
              {t('show_all_sites', { count: totalSites })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
