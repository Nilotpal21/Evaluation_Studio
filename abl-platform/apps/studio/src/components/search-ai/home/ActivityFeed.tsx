/**
 * ActivityFeed Component
 *
 * Shows a timeline of recent knowledge base activity.
 * Uses a registry pattern to map action strings to icons and navigation targets.
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { RefreshCw, RotateCcw, GitBranch, BookOpen, Map, Activity, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { SkeletonText } from '../../ui/Skeleton';
import {
  fetchActivity,
  type ActivityFeedResponse,
  type ActivityItem,
} from '../../../api/search-ai';
import { useNavigationStore } from '../../../store/navigation-store';

// =============================================================================
// ACTION REGISTRY
// =============================================================================

interface ActivityActionConfig {
  pattern: RegExp;
  i18nKey: string;
  icon: React.ReactNode;
  targetSection: string | null;
  targetSubSection?: string;
}

const ACTIVITY_ACTION_REGISTRY: ActivityActionConfig[] = [
  {
    pattern: /^source\.sync/,
    i18nKey: 'activity_source_sync',
    icon: <RefreshCw className="w-3.5 h-3.5" />,
    targetSection: 'data',
  },
  {
    pattern: /^index\.rebuild/,
    i18nKey: 'activity_index_rebuild',
    icon: <RotateCcw className="w-3.5 h-3.5" />,
    targetSection: null,
  },
  {
    pattern: /^pipeline\./,
    i18nKey: 'activity_pipeline',
    icon: <GitBranch className="w-3.5 h-3.5" />,
    targetSection: 'intelligence',
    targetSubSection: 'pipeline',
  },
  {
    pattern: /^vocabulary\./,
    i18nKey: 'activity_vocabulary',
    icon: <BookOpen className="w-3.5 h-3.5" />,
    targetSection: 'intelligence',
    targetSubSection: 'vocabulary',
  },
  {
    pattern: /^mapping\./,
    i18nKey: 'activity_mapping',
    icon: <Map className="w-3.5 h-3.5" />,
    targetSection: 'intelligence',
    targetSubSection: 'fields',
  },
];

const FALLBACK_ACTION: ActivityActionConfig = {
  pattern: /.*/,
  i18nKey: 'activity_unknown',
  icon: <Activity className="w-3.5 h-3.5" />,
  targetSection: null,
};

function resolveAction(action: string): ActivityActionConfig {
  return ACTIVITY_ACTION_REGISTRY.find((c) => c.pattern.test(action)) ?? FALLBACK_ACTION;
}

// =============================================================================
// TIMESTAMP FORMATTING
// =============================================================================

// Matches next-intl's t() return type for simple string translations
type TranslateTimeFn = (key: string, values?: Record<string, number>) => string;

function formatRelativeTime(timestamp: string, t: TranslateTimeFn): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffHours < 1) {
      const diffMinutes = Math.max(1, Math.floor(diffMs / (1000 * 60)));
      return t('time_minutes_ago', { count: diffMinutes });
    }
    if (diffHours < 24) {
      return t('time_hours_ago', { count: diffHours });
    }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) {
      return t('time_yesterday');
    }
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

// =============================================================================
// COMPONENT
// =============================================================================

interface ActivityFeedProps {
  kbId: string;
}

const PAGE_SIZE = 10;

export function ActivityFeed({ kbId }: ActivityFeedProps) {
  const t = useTranslations('search_ai.operations');
  const setTab = useNavigationStore((s) => s.setTab);
  const setTabAndSubSection = useNavigationStore((s) => s.setTabAndSubSection);
  const [allActivities, setAllActivities] = useState<ActivityItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const { data, error, isLoading } = useSWR<ActivityFeedResponse>(
    kbId ? `/api/search-ai/knowledge-bases/${kbId}/activity?limit=${PAGE_SIZE}` : null,
    () => fetchActivity(kbId, { limit: PAGE_SIZE }),
    { revalidateOnFocus: false },
  );

  // Reset accumulated activities when SWR revalidates the first page
  const prevDataRef = useRef(data);
  useEffect(() => {
    if (data && data !== prevDataRef.current && prevDataRef.current !== undefined) {
      // SWR revalidated — reset to fresh data
      setAllActivities([]);
      setOffset(0);
      setLoadMoreError(false);
    }
    prevDataRef.current = data;
  }, [data]);

  // Merge initial data with loaded-more activities
  const activities = allActivities.length > 0 ? allActivities : (data?.activities ?? []);
  const hasMore =
    allActivities.length > 0 ? offset + PAGE_SIZE < (data?.total ?? 0) : (data?.hasMore ?? false);

  const handleLoadMore = useCallback(async () => {
    const nextOffset = offset + PAGE_SIZE;
    setIsLoadingMore(true);
    setLoadMoreError(false);
    try {
      const moreData = await fetchActivity(kbId, {
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      const currentActivities = allActivities.length > 0 ? allActivities : (data?.activities ?? []);
      setAllActivities([...currentActivities, ...moreData.activities]);
      setOffset(nextOffset);
    } catch (_err) {
      setLoadMoreError(true);
    } finally {
      setIsLoadingMore(false);
    }
  }, [offset, kbId, allActivities, data?.activities]);

  return (
    <Card hoverable={false} padding="lg">
      <h4 className="text-sm font-semibold text-foreground mb-2">{t('activity_title')}</h4>

      {isLoading ? (
        <SkeletonText lines={4} />
      ) : error ? (
        <p className="text-xs text-muted">{t('activity_error')}</p>
      ) : activities.length === 0 ? (
        <p className="text-xs text-muted">{t('activity_empty')}</p>
      ) : (
        <div className="space-y-2">
          {activities.map((item) => {
            const config = resolveAction(item.action);
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-md bg-background-muted px-3 py-2"
              >
                <div className="shrink-0 text-muted">{config.icon}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">
                    {t(config.i18nKey)}
                  </p>
                  <p className="text-xs text-muted">
                    {formatRelativeTime(item.timestamp, t as TranslateTimeFn)}
                  </p>
                </div>
                {config.targetSection !== null && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      if (config.targetSubSection) {
                        setTabAndSubSection(config.targetSection, config.targetSubSection);
                      } else {
                        setTab(config.targetSection);
                      }
                    }}
                  >
                    {t('activity_view')} <ArrowRight className="w-3 h-3" />
                  </Button>
                )}
              </div>
            );
          })}

          {loadMoreError && (
            <p className="text-xs text-error text-center py-1">{t('activity_error')}</p>
          )}
          {hasMore && (
            <Button
              variant="ghost"
              size="xs"
              className="w-full"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              loading={isLoadingMore}
            >
              {t('activity_load_more')}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
