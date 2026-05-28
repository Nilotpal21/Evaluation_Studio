/**
 * ChannelCatalog — Level 1 of channel navigation.
 *
 * Grid of available channel types with instance counts and status badges.
 * Fetches all three backend sources in parallel, normalizes into unified
 * ChannelInstance records, and displays per-type instance counts.
 */

'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { CHANNEL_REGISTRY, CHANNEL_CATALOG_ORDER } from './channel-registry';
import { normalizeAllInstances } from './channel-normalizer';
import { fetchChannels } from '../../../api/channels';
import { fetchConnections } from '../../../api/channel-connections';
import { fetchSubscriptions } from '../../../api/http-async-channels';
import { Badge } from '../../ui/Badge';
import { Skeleton } from '../../ui/Skeleton';
import type { ChannelTypeId, ChannelTypeDef, ChannelCategory } from './types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChannelCatalogProps {
  projectId: string;
  onSelect: (channelType: ChannelTypeId) => void;
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

// Category labels and status badges are rendered inside the component using useTranslations.

const CATEGORY_ORDER: ChannelCategory[] = ['messaging', 'sdk', 'voice', 'webhook', 'protocol'];

// ---------------------------------------------------------------------------
// Skeleton loading grid
// ---------------------------------------------------------------------------

const SKELETON_COUNT = 6;

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div key={i} className="p-4 rounded-lg border border-default bg-background-elevated">
          <div className="flex items-start gap-3">
            <Skeleton className="shrink-0 w-8 h-8 rounded-lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-1 h-3 w-3/4" />
              <Skeleton className="mt-2 h-5 w-14 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChannelCatalog({ projectId, onSelect }: ChannelCatalogProps) {
  const t = useTranslations('channels');
  const [loading, setLoading] = useState(true);
  const [instanceCounts, setInstanceCounts] = useState<Map<ChannelTypeId, number>>(new Map());

  const CATEGORY_LABELS: Record<ChannelCategory, string> = {
    messaging: t('category_labels.messaging'),
    sdk: t('category_labels.sdk'),
    voice: t('category_labels.voice'),
    webhook: t('category_labels.webhook'),
    protocol: t('category_labels.protocol'),
  };

  function getStatusBadge(
    def: ChannelTypeDef,
    counts: Map<ChannelTypeId, number>,
  ): React.ReactNode {
    if (!def.available) {
      return <Badge>{t('coming_soon')}</Badge>;
    }

    const count = counts.get(def.id) ?? 0;
    if (count > 0) {
      return (
        <Badge variant="success" dot>
          {t('connections_count', { count })}
        </Badge>
      );
    }

    return <Badge variant="accent">{t('available')}</Badge>;
  }

  useEffect(() => {
    let cancelled = false;

    async function loadCounts() {
      const [channelsResult, connectionsResult, subscriptionsResult] = await Promise.all([
        fetchChannels(projectId).catch((err: unknown) => {
          console.error('[ChannelCatalog] Failed to fetch SDK channels:', err);
          return { channels: [] as Awaited<ReturnType<typeof fetchChannels>>['channels'] };
        }),
        fetchConnections(projectId).catch((err: unknown) => {
          console.error('[ChannelCatalog] Failed to fetch connections:', err);
          return { connections: [] as Awaited<ReturnType<typeof fetchConnections>>['connections'] };
        }),
        fetchSubscriptions(projectId).catch((err: unknown) => {
          console.error('[ChannelCatalog] Failed to fetch subscriptions:', err);
          return {
            subscriptions: [] as Awaited<ReturnType<typeof fetchSubscriptions>>['subscriptions'],
          };
        }),
      ]);

      if (cancelled) return;

      const grouped = normalizeAllInstances(
        channelsResult.channels,
        connectionsResult.connections,
        subscriptionsResult.subscriptions,
      );

      const counts = new Map<ChannelTypeId, number>();
      for (const [typeId, instances] of grouped) {
        counts.set(typeId, instances.length);
      }

      setInstanceCounts(counts);
      setLoading(false);
    }

    loadCounts();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('catalog_description')}</p>

      {loading ? (
        <CatalogSkeleton />
      ) : (
        <div className="space-y-6">
          {CATEGORY_ORDER.map((category) => {
            const channels = CHANNEL_CATALOG_ORDER.map((id) => CHANNEL_REGISTRY[id]).filter(
              (def) => def.category === category,
            );

            if (channels.length === 0) return null;

            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                    {CATEGORY_LABELS[category]}
                  </h3>
                  <div className="flex-1 border-t border-default" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {channels.map((def) => (
                    <button
                      key={def.id}
                      onClick={() => (def.available ? onSelect(def.id) : undefined)}
                      disabled={!def.available}
                      className={clsx(
                        'text-left p-4 rounded-lg border transition-default',
                        def.available
                          ? 'bg-background-elevated border-default hover:border-accent cursor-pointer card-hover'
                          : 'bg-background-subtle border-default opacity-60 cursor-default',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={clsx(
                            'shrink-0 p-2 rounded-lg',
                            def.available ? 'bg-accent-subtle' : 'bg-background-muted',
                          )}
                        >
                          {def.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-foreground">{def.name}</p>
                            {getStatusBadge(def, instanceCounts)}
                          </div>
                          <p className="mt-1 text-xs text-muted line-clamp-2">{def.description}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
