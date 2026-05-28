'use client';

import { useTranslations } from 'next-intl';
import { SlidePanel } from '../ui/SlidePanel';
import { Badge } from '../ui/Badge';
import type { AgentStatus, RuleStatus, RuleSeverity } from '../../lib/governance-contracts';

interface AgentComplianceDetailPanelProps {
  agent: AgentStatus | null;
  onClose: () => void;
}

function ruleStatusVariant(status: RuleStatus) {
  switch (status) {
    case 'PASS':
      return 'success' as const;
    case 'FAIL':
      return 'error' as const;
    default:
      return 'default' as const;
  }
}

function severityVariant(severity: RuleSeverity) {
  switch (severity) {
    case 'critical':
      return 'error' as const;
    case 'warning':
      return 'warning' as const;
    default:
      return 'info' as const;
  }
}

export function AgentComplianceDetailPanel({ agent, onClose }: AgentComplianceDetailPanelProps) {
  const t = useTranslations('governance');

  return (
    <SlidePanel
      open={!!agent}
      onClose={onClose}
      title={agent?.agentName ?? ''}
      description={t('panel.rules_breakdown')}
      width="lg"
    >
      {agent && (
        <div className="space-y-3">
          {agent.rules.map((rule, i) => (
            <div
              key={i}
              className="flex items-start justify-between gap-3 rounded-lg border border-default p-3"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge appearance="outlined" className="font-mono">
                    {rule.pipelineType}
                  </Badge>
                  <Badge variant={severityVariant(rule.severity)} appearance="outlined">
                    {rule.severity}
                  </Badge>
                </div>
                <div className="text-sm font-medium">{rule.metric}</div>
                <div className="text-xs text-muted">
                  {t('panel.actual')}: {rule.metricValue ?? t('panel.no_data')} /{' '}
                  {t('panel.threshold')}: {rule.threshold}
                </div>
              </div>
              <Badge variant={ruleStatusVariant(rule.status)}>{rule.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </SlidePanel>
  );
}
