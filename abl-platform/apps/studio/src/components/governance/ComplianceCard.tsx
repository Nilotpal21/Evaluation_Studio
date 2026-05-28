'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import type { RuleResult, RuleStatus, AgentOverallStatus } from '../../lib/governance-contracts';

interface ComplianceCardProps {
  rule: RuleResult;
  agentName: string;
}

function statusVariant(status: RuleStatus | AgentOverallStatus) {
  switch (status) {
    case 'PASS':
      return 'success' as const;
    case 'FAIL':
      return 'error' as const;
    case 'WARN':
      return 'warning' as const;
    default:
      return 'default' as const;
  }
}

export function ComplianceCard({ rule, agentName }: ComplianceCardProps) {
  const t = useTranslations('governance');

  const valueDisplay =
    rule.metricValue !== null ? rule.metricValue.toFixed(3) : t('compliance.no_data');

  return (
    <Card hoverable={false} padding="md" className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{rule.metric.replace(/_/g, ' ')}</div>
          <div className="mt-0.5 text-xs text-muted">{rule.pipelineType.replace(/_/g, ' ')}</div>
        </div>
        <Badge variant={statusVariant(rule.status)}>{rule.status}</Badge>
      </div>

      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          {t('compliance.actual')}:{' '}
          <span className="font-mono text-foreground">{valueDisplay}</span>
        </span>
        <span>
          {t('compliance.threshold')}:{' '}
          <span className="font-mono text-foreground">{rule.threshold}</span>
        </span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{agentName}</span>
        <Badge
          variant={
            rule.severity === 'critical'
              ? 'error'
              : rule.severity === 'warning'
                ? 'warning'
                : 'info'
          }
          appearance="outlined"
        >
          {rule.severity}
        </Badge>
      </div>
    </Card>
  );
}
