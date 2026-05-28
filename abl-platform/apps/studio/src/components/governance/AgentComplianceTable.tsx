'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, ShieldCheck } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { DataTable, type Column } from '../ui/DataTable';
import { AgentComplianceDetailPanel } from './AgentComplianceDetailPanel';
import type { AgentStatus, AgentOverallStatus } from '../../lib/governance-contracts';

interface AgentComplianceTableProps {
  agents: AgentStatus[];
  isLoading: boolean;
  onAddPolicy: () => void;
}

function statusBadgeVariant(status: AgentOverallStatus) {
  switch (status) {
    case 'PASS':
      return 'success' as const;
    case 'WARN':
      return 'warning' as const;
    case 'FAIL':
      return 'error' as const;
    default:
      return 'default' as const;
  }
}

function statusLabel(status: AgentOverallStatus, t: (k: string) => string): string {
  switch (status) {
    case 'PASS':
      return t('status.pass');
    case 'WARN':
      return t('status.warn');
    case 'FAIL':
      return t('status.fail');
    default:
      return t('status.not_evaluated');
  }
}

export function AgentComplianceTable({
  agents,
  isLoading,
  onAddPolicy,
}: AgentComplianceTableProps) {
  const t = useTranslations('governance');
  const [selectedAgent, setSelectedAgent] = useState<AgentStatus | null>(null);
  const columns: Column<AgentStatus>[] = [
    {
      key: 'agent',
      label: t('table.col.agent'),
      render: (agent) => (
        <span className="flex items-center gap-2 font-medium">
          <Bot className="w-3.5 h-3.5 text-muted shrink-0" />
          {agent.agentName}
        </span>
      ),
      sortable: true,
      sortValue: (agent) => agent.agentName,
    },
    {
      key: 'status',
      label: t('table.col.status'),
      render: (agent) => (
        <Badge variant={statusBadgeVariant(agent.overallStatus)}>
          {statusLabel(agent.overallStatus, t)}
        </Badge>
      ),
      sortable: true,
      sortValue: (agent) => agent.overallStatus,
    },
    {
      key: 'rules',
      label: t('table.col.rules'),
      render: (agent) => <span className="text-muted">{agent.rules.length}</span>,
      sortable: true,
      sortValue: (agent) => agent.rules.length,
    },
    {
      key: 'pass',
      label: t('table.col.pass'),
      render: (agent) => (
        <span className="text-success font-medium">
          {agent.rules.filter((rule) => rule.status === 'PASS').length}
        </span>
      ),
      sortable: true,
      sortValue: (agent) => agent.rules.filter((rule) => rule.status === 'PASS').length,
    },
    {
      key: 'fail',
      label: t('table.col.fail'),
      render: (agent) => (
        <span className="text-error font-medium">
          {agent.rules.filter((rule) => rule.status === 'FAIL').length}
        </span>
      ),
      sortable: true,
      sortValue: (agent) => agent.rules.filter((rule) => rule.status === 'FAIL').length,
    },
  ];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck className="w-6 h-6" />}
        title={t('table.empty_title')}
        description={t('table.empty_description')}
        action={
          <Button variant="primary" size="sm" onClick={onAddPolicy}>
            {t('policy.create')}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-default">
        <DataTable
          columns={columns}
          data={agents}
          keyExtractor={(agent) => agent.agentName}
          onRowClick={setSelectedAgent}
        />
      </div>

      <AgentComplianceDetailPanel agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
    </>
  );
}
