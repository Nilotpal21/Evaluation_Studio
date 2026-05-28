import { useTranslations } from 'next-intl';
import { Badge } from '../ui/Badge';
import { Section } from '../ui/Section';
import type { FrameworkItem, ControlStatus } from '../../lib/governance-contracts';

interface FrameworkChecklistProps {
  framework: FrameworkItem;
}

function controlStatusVariant(status: ControlStatus) {
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

export function FrameworkChecklist({ framework }: FrameworkChecklistProps) {
  const t = useTranslations('governance');

  const passCount = framework.controls.filter((c) => c.status === 'PASS').length;
  const total = framework.controls.length;
  const overallStatus = passCount === total ? 'PASS' : passCount === 0 ? 'FAIL' : 'WARN';

  return (
    <Section
      collapsible
      title={framework.label}
      description={`${passCount}/${total} ${t('frameworks.controls_pass')}`}
      actions={
        <Badge variant={controlStatusVariant(overallStatus as ControlStatus)}>
          {overallStatus}
        </Badge>
      }
    >
      <div className="divide-y divide-default">
        {framework.controls.map((control) => (
          <div key={control.controlId} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <Badge variant={controlStatusVariant(control.status)} className="mt-0.5 shrink-0">
              {control.status}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                <span className="text-muted">{control.controlId}</span> {control.requirement}
              </div>
              {control.evidence && (
                <div className="mt-1 text-xs text-foreground">{control.evidence}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
