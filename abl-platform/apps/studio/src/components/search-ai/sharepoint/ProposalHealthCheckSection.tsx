'use client';

/**
 * ProposalHealthCheckSection
 *
 * Displays health check results per design wireframe §4b:
 * connectivity, token validity, scope coverage with detail text.
 */

import { Check, X, AlertTriangle } from 'lucide-react';

interface HealthCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'warning';
  detail?: string;
}

interface ProposalHealthCheckSectionProps {
  checks: HealthCheck[];
  labels: {
    connectivity: string;
    token_validity: string;
    scope_coverage: string;
    status_pass: string;
    status_fail: string;
  };
}

function CheckIcon({ status }: { status: HealthCheck['status'] }) {
  if (status === 'pass') {
    return <Check className="w-4 h-4 text-success flex-shrink-0" />;
  }
  if (status === 'warn' || status === 'warning') {
    return <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />;
  }
  return <X className="w-4 h-4 text-error flex-shrink-0" />;
}

function statusLabel(
  status: HealthCheck['status'],
  labels: { status_pass: string; status_fail: string },
): string {
  if (status === 'pass') return labels.status_pass;
  if (status === 'warn' || status === 'warning') return 'Warning';
  return labels.status_fail;
}

export function ProposalHealthCheckSection({ checks, labels }: ProposalHealthCheckSectionProps) {
  const labelMap: Record<string, string> = {
    connectivity: labels.connectivity,
    token_validity: labels.token_validity,
    scope_coverage: labels.scope_coverage,
  };

  return (
    <div className="space-y-2">
      {checks.map((check) => (
        <div
          key={check.name}
          className="flex items-start gap-3 px-3 py-2 rounded-lg bg-background-elevated"
        >
          <div className="mt-0.5">
            <CheckIcon status={check.status} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">{labelMap[check.name] ?? check.name}</span>
              <span
                className={`text-xs ${
                  check.status === 'pass'
                    ? 'text-success'
                    : check.status === 'fail'
                      ? 'text-error'
                      : 'text-warning'
                }`}
              >
                {statusLabel(check.status, labels)}
              </span>
            </div>
            {check.detail && <p className="text-xs text-muted mt-0.5">{check.detail}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
