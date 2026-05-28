'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ClipboardList } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { DataTable, type Column } from '../ui/DataTable';
import { Pagination } from '../ui/Pagination';
import { AuditFilters } from './AuditFilters';
import { OverrideModal } from './OverrideModal';
import { useGovernanceAudit } from '../../hooks/useGovernanceAudit';
import type { AuditEvent, RuleSeverity } from '../../lib/governance-contracts';
import type { AuditQueryParams } from '../../hooks/useGovernanceAudit';

interface AuditEventTimelineProps {
  projectId: string;
  period: string;
}

function severityVariant(s: RuleSeverity) {
  return s === 'critical'
    ? ('error' as const)
    : s === 'warning'
      ? ('warning' as const)
      : ('info' as const);
}

export function AuditEventTimeline({ projectId, period }: AuditEventTimelineProps) {
  const t = useTranslations('governance');
  const [filters, setFilters] = useState<AuditQueryParams>({ period, page: 1, limit: 50 });
  const [overrideTarget, setOverrideTarget] = useState<AuditEvent | null>(null);

  // Keep period in sync with parent prop
  const effectiveFilters = { ...filters, period };

  const { events, total, page, limit, isLoading, createOverride } = useGovernanceAudit(
    projectId,
    effectiveFilters,
  );

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const handleFilterChange = (next: AuditQueryParams) => {
    setFilters({ ...next, period });
  };
  const columns: Column<AuditEvent>[] = [
    {
      key: 'type',
      label: t('audit.col.type'),
      render: (event) => (
        <Badge variant={event.eventType === 'breach' ? 'error' : 'success'}>
          {event.eventType}
        </Badge>
      ),
      sortable: true,
      sortValue: (event) => event.eventType,
    },
    {
      key: 'agent',
      label: t('audit.col.agent'),
      render: (event) => <span className="font-medium">{event.agentName}</span>,
      sortable: true,
      sortValue: (event) => event.agentName,
    },
    {
      key: 'metric',
      label: t('audit.col.metric'),
      render: (event) => <span className="text-muted font-mono text-xs">{event.metric}</span>,
      sortable: true,
      sortValue: (event) => event.metric,
    },
    {
      key: 'actual',
      label: t('audit.col.actual'),
      render: (event) => <span className="font-mono text-xs">{event.actualValue}</span>,
      sortable: true,
      sortValue: (event) => Number(event.actualValue),
    },
    {
      key: 'threshold',
      label: t('audit.col.threshold'),
      render: (event) => <span className="font-mono text-xs">{event.thresholdAtTime}</span>,
      sortable: true,
      sortValue: (event) => Number(event.thresholdAtTime),
    },
    {
      key: 'severity',
      label: t('audit.col.severity'),
      render: (event) => (
        <Badge variant={severityVariant(event.severity)} appearance="outlined">
          {event.severity}
        </Badge>
      ),
      sortable: true,
      sortValue: (event) => event.severity,
    },
    {
      key: 'timestamp',
      label: t('audit.col.timestamp'),
      render: (event) => (
        <span className="text-xs text-muted">{new Date(event.timestamp).toLocaleString()}</span>
      ),
      sortable: true,
      sortValue: (event) => new Date(event.timestamp).getTime(),
    },
    {
      key: 'actions',
      label: '',
      render: (event) => (
        <>
          {event.eventType === 'breach' && !event.overrideId && (
            <Button variant="ghost" size="xs" onClick={() => setOverrideTarget(event)}>
              {t('audit.override')}
            </Button>
          )}
          {event.overrideId && (
            <Badge variant="purple" appearance="outlined">
              {t('audit.overridden')}
            </Badge>
          )}
        </>
      ),
    },
  ];

  if (isLoading && events.length === 0) {
    return (
      <div className="space-y-2">
        <AuditFilters filters={effectiveFilters} onChange={handleFilterChange} />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AuditFilters filters={effectiveFilters} onChange={handleFilterChange} />

      {events.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-6 w-6" />}
          title={t('audit.empty_title')}
          description={t('audit.empty_description')}
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-default">
            <DataTable columns={columns} data={events} keyExtractor={(event) => event.eventRef} />
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-muted">
            <span>{t('audit.page_info', { page, totalPages, total })}</span>
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={(nextPage) =>
                handleFilterChange({ ...effectiveFilters, page: nextPage })
              }
            />
          </div>
        </>
      )}

      <OverrideModal
        event={overrideTarget}
        onClose={() => setOverrideTarget(null)}
        onSubmit={async (eventRef, justification, originalSeverity) => {
          await createOverride(eventRef, { justification, originalSeverity, policyVersion: 1 });
        }}
      />
    </div>
  );
}
