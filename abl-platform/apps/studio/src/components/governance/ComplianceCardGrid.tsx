'use client';

import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ComplianceCard } from './ComplianceCard';
import type { AgentStatus } from '../../lib/governance-contracts';

interface ComplianceCardGridProps {
  agents: AgentStatus[];
  isLoading: boolean;
}

export function ComplianceCardGrid({ agents, isLoading }: ComplianceCardGridProps) {
  const t = useTranslations('governance');

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const allRules = agents.flatMap((agent) =>
    agent.rules.map((rule) => ({ rule, agentName: agent.agentName })),
  );

  if (allRules.length === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck className="w-6 h-6" />}
        title={t('compliance.empty_title')}
        description={t('compliance.empty_description')}
      />
    );
  }

  // Sort: FAIL first, then WARN, then PASS/NOT_EVALUATED
  const sorted = [...allRules].sort((a, b) => {
    const order = { FAIL: 0, WARN: 1, NOT_EVALUATED: 2, PASS: 3 };
    return (order[a.rule.status] ?? 2) - (order[b.rule.status] ?? 2);
  });

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {sorted.map(({ rule, agentName }, i) => (
        <ComplianceCard
          key={`${agentName}-${rule.pipelineType}-${rule.metric}-${i}`}
          rule={rule}
          agentName={agentName}
        />
      ))}
    </div>
  );
}
