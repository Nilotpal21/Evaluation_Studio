/**
 * ActivityTab — delivery log, recent events, error tracking.
 *
 * Strategy pattern: webhook subscriptions have delivery data, others show placeholder.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  RefreshCw,
  Activity,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Badge';
import { DataTable, type Column } from '../../../ui/DataTable';
import { EmptyState } from '../../../ui/EmptyState';
import { fetchDeliveries, type WebhookDelivery } from '../../../../api/http-async-channels';
import { sanitizeError } from '../../../../lib/sanitize-error';
import type { ChannelTabProps, ChannelTypeDef, ChannelInstance } from '../types';
import { timeAgo } from '../channel-utils';

// =============================================================================
// CONSTANTS
// =============================================================================

const DELIVERY_FETCH_LIMIT = 50;

const EVENT_TYPE_VARIANTS: Record<string, 'accent' | 'info' | 'warning' | 'default'> = {
  'agent.message': 'accent',
  'agent.response': 'info',
  'session.created': 'warning',
};

function getEventBadgeVariant(eventType: string): 'accent' | 'info' | 'warning' | 'default' {
  return EVENT_TYPE_VARIANTS[eventType] || 'default';
}

// =============================================================================
// STATUS CELL
// =============================================================================

function DeliveryStatusCell({
  status,
  labels,
}: {
  status: string;
  labels: Record<string, string>;
}) {
  if (status === 'delivered') {
    return (
      <span className="inline-flex items-center gap-1.5 text-success text-xs">
        <CheckCircle className="w-4 h-4" />
        {labels.delivered}
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-error text-xs">
        <XCircle className="w-4 h-4" />
        {labels.failed}
      </span>
    );
  }

  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5 text-warning text-xs">
        <Clock className="w-4 h-4" />
        {labels.pending}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-muted text-xs">
      <AlertTriangle className="w-4 h-4" />
      {status}
    </span>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

// DELIVERY_COLUMNS is defined inside WebhookActivityPanel to use i18n translations.

function WebhookActivityPanel({ instance }: { instance: ChannelInstance }) {
  const t = useTranslations('channels.activity');
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);

  const statusLabels = {
    delivered: t('status_delivered'),
    failed: t('status_failed'),
    pending: t('status_pending'),
  };

  const DELIVERY_COLUMNS: Column<WebhookDelivery>[] = [
    {
      key: 'eventType',
      label: t('column_event'),
      render: (d) => <Badge variant={getEventBadgeVariant(d.eventType)}>{d.eventType}</Badge>,
    },
    {
      key: 'status',
      label: t('column_status'),
      render: (d) => <DeliveryStatusCell status={d.status} labels={statusLabels} />,
    },
    {
      key: 'httpStatus',
      label: t('column_http_status'),
      render: (d) => (
        <span className="font-mono text-xs text-muted">{d.httpStatus || '\u2014'}</span>
      ),
    },
    {
      key: 'attempts',
      label: t('column_attempts'),
      render: (d) => <span className="text-xs text-foreground">{d.attempts}</span>,
      sortable: true,
      sortValue: (d) => d.attempts,
    },
    {
      key: 'deliveredAt',
      label: t('column_delivered'),
      render: (d) => <span className="text-xs text-muted">{timeAgo(d.deliveredAt)}</span>,
    },
    {
      key: 'createdAt',
      label: t('column_created'),
      render: (d) => <span className="text-xs text-muted">{timeAgo(d.createdAt)}</span>,
      sortable: true,
      sortValue: (d) => new Date(d.createdAt).getTime(),
    },
  ];

  const loadDeliveries = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchDeliveries(instance._sourceId, DELIVERY_FETCH_LIMIT);
      setDeliveries(result.deliveries);
    } catch (err) {
      toast.error(sanitizeError(err, t('load_failed')));
    } finally {
      setLoading(false);
    }
  }, [instance._sourceId]);

  useEffect(() => {
    loadDeliveries().catch((err) => console.error('[ActivityTab] Failed to load deliveries:', err));
  }, [loadDeliveries]);

  const handleRefresh = useCallback(() => {
    loadDeliveries().catch((err) => console.error('[ActivityTab] Failed to load deliveries:', err));
  }, [loadDeliveries]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{t('recent_deliveries')}</h4>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw className="w-4 h-4" />}
          onClick={handleRefresh}
        >
          {t('refresh')}
        </Button>
      </div>

      <DataTable
        columns={DELIVERY_COLUMNS}
        data={deliveries}
        keyExtractor={(d) => d.id}
        emptyMessage={t('no_deliveries')}
      />
    </div>
  );
}

function ActivityPlaceholder({ channelDef }: { channelDef: ChannelTypeDef }) {
  const t = useTranslations('channels.activity');
  return (
    <EmptyState
      icon={<Activity className="w-6 h-6" />}
      title={t('coming_soon_title')}
      description={t('coming_soon_description', { name: channelDef.name })}
    />
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ActivityTab({ channelDef, instance }: ChannelTabProps) {
  if (instance._source === 'webhook_subscription') {
    return <WebhookActivityPanel instance={instance} />;
  }

  return <ActivityPlaceholder channelDef={channelDef} />;
}
