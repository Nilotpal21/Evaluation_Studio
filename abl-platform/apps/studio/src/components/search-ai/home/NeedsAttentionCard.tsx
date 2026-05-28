/**
 * NeedsAttentionCard Component
 *
 * Displays a live health check for the knowledge base.
 * Uses a category-registry pattern: each checker function inspects one
 * facet of HealthSummaryResponse and returns zero or more HealthIssues.
 */

'use client';

import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { fetchHealthSummary, type HealthSummaryResponse } from '../../../api/search-ai';
import { useNavigationStore } from '../../../store/navigation-store';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';

// =============================================================================
// TYPES
// =============================================================================

interface HealthIssue {
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  action: {
    label: string;
    section: string;
    subSection?: string;
    /** Target view within the data tab (documents/chunks/sources) */
    dataView?: 'documents' | 'chunks' | 'sources';
    /** Status filter to apply when navigating to data tab */
    statusFilter?: string;
    /** Source ID to filter by when navigating to data tab */
    sourceId?: string;
  };
}

type TranslateFn = (key: string, values?: Record<string, unknown>) => string;

// =============================================================================
// CHECKER FUNCTIONS (pure)
// =============================================================================

function checkSourceHealth(data: HealthSummaryResponse, t: TranslateFn): HealthIssue[] {
  const issues: HealthIssue[] = [];

  if (data.sources.errors.length > 0) {
    const names = data.sources.errors.map((e) => e.sourceName).join(', ');
    // Single error source: navigate directly to that source's documents with error filter
    const singleSource = data.sources.errors.length === 1 ? data.sources.errors[0] : undefined;
    issues.push({
      severity: 'error',
      title: t('source_errors', { count: data.sources.errors.length }),
      detail: names,
      action: singleSource
        ? {
            label: t('view_in_data'),
            section: 'data',
            dataView: 'documents',
            sourceId: singleSource.sourceId,
          }
        : { label: t('view_in_data'), section: 'data', dataView: 'sources' },
    });
  }

  if (data.sources.syncing > 0) {
    issues.push({
      severity: 'info',
      title: t('source_syncing', { count: data.sources.syncing }),
      detail: '',
      action: { label: t('view_in_data'), section: 'data', dataView: 'sources' },
    });
  }

  return issues;
}

function checkPipelineHealth(data: HealthSummaryResponse, t: TranslateFn): HealthIssue[] {
  const issues: HealthIssue[] = [];

  if (data.pipeline.status === 'invalid') {
    issues.push({
      severity: 'error',
      title: t('pipeline_invalid', { count: data.pipeline.errors.length }),
      detail: data.pipeline.errors.map((e) => e.message).join('; '),
      action: { label: t('view_pipeline'), section: 'intelligence', subSection: 'pipeline' },
    });
  }

  if (data.pipeline.status === 'not-configured') {
    issues.push({
      severity: 'warning',
      title: t('pipeline_not_configured'),
      detail: '',
      action: { label: t('view_pipeline'), section: 'intelligence', subSection: 'pipeline' },
    });
  }

  return issues;
}

function checkCircuitBreakerHealth(data: HealthSummaryResponse, t: TranslateFn): HealthIssue[] {
  const issues: HealthIssue[] = [];

  if (!data.circuitBreaker) return issues;

  if (data.circuitBreaker.state === 'OPEN') {
    issues.push({
      severity: 'error',
      title: t('circuit_breaker_open', {
        provider: data.circuitBreaker.provider,
      }),
      detail: '',
      action: { label: t('view_errors'), section: 'intelligence', subSection: 'pipeline' },
    });
  }

  if (data.circuitBreaker.state === 'HALF_OPEN') {
    issues.push({
      severity: 'warning',
      title: t('circuit_breaker_half_open', {
        provider: data.circuitBreaker.provider,
      }),
      detail: '',
      action: { label: t('view_errors'), section: 'intelligence', subSection: 'pipeline' },
    });
  }

  return issues;
}

function checkDocumentHealth(data: HealthSummaryResponse, t: TranslateFn): HealthIssue[] {
  const issues: HealthIssue[] = [];

  if (data.documents.errored > 0) {
    issues.push({
      severity: 'error',
      title: t('docs_errored', { count: data.documents.errored }),
      detail: '',
      action: {
        label: t('view_in_data'),
        section: 'data',
        dataView: 'documents',
        statusFilter: 'error',
      },
    });
  }

  if (data.documents.processing > 0) {
    issues.push({
      severity: 'info',
      title: t('docs_processing', { count: data.documents.processing }),
      detail: '',
      action: {
        label: t('view_in_data'),
        section: 'data',
        dataView: 'documents',
        statusFilter: 'processing',
      },
    });
  }

  return issues;
}

function checkLLMHealth(data: HealthSummaryResponse, t: TranslateFn): HealthIssue[] {
  if (data.llm?.configured === false) {
    return [
      {
        severity: 'warning',
        title: t('llm_not_configured'),
        detail: '',
        action: {
          label: t('configure_llm'),
          section: 'intelligence',
          subSection: 'pipeline',
        },
      },
    ];
  }
  return [];
}

// =============================================================================
// SEVERITY HELPERS
// =============================================================================

const severityConfig = {
  error: {
    border: 'border-l-error',
    icon: <AlertCircle className="h-4 w-4 text-error" />,
  },
  warning: {
    border: 'border-l-warning',
    icon: <AlertTriangle className="h-4 w-4 text-warning" />,
  },
  info: {
    border: 'border-l-accent',
    icon: <Info className="h-4 w-4 text-accent" />,
  },
} as const;

// =============================================================================
// COMPONENT
// =============================================================================

interface NeedsAttentionCardProps {
  kbId: string;
}

export function NeedsAttentionCard({ kbId }: NeedsAttentionCardProps) {
  const t = useTranslations('search_ai.operations');
  const setTab = useNavigationStore((s) => s.setTab);
  const setTabAndSubSection = useNavigationStore((s) => s.setTabAndSubSection);
  const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);

  const { data, error, isLoading } = useSWR<HealthSummaryResponse>(
    kbId ? `/api/search-ai/knowledge-bases/${kbId}/health-summary` : null,
    () => fetchHealthSummary(kbId),
    { refreshInterval: 30_000 },
  );

  // Collect all issues — TranslateFn matches next-intl's string return
  const translate = t as TranslateFn;
  const issues: HealthIssue[] = data
    ? [
        ...checkSourceHealth(data, translate),
        ...checkPipelineHealth(data, translate),
        ...checkCircuitBreakerHealth(data, translate),
        ...checkDocumentHealth(data, translate),
        ...checkLLMHealth(data, translate),
      ]
    : [];

  return (
    <Card hoverable={false} padding="lg">
      <h4 className="text-sm font-semibold text-foreground mb-2">{t('needs_attention')}</h4>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{t('health_loading')}</span>
        </div>
      ) : error ? (
        <p className="text-xs text-muted">{t('health_error')}</p>
      ) : issues.length === 0 ? (
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-success" />
          <p className="text-xs text-muted">{t('all_healthy')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => {
            const cfg = severityConfig[issue.severity];
            return (
              <div
                key={`${issue.severity}-${issue.title}`}
                className={`flex items-start gap-2 rounded-md border-l-2 ${cfg.border} bg-background-muted px-3 py-2`}
              >
                <div className="mt-0.5 shrink-0">{cfg.icon}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">{issue.title}</p>
                  {issue.detail && <p className="text-xs text-muted truncate">{issue.detail}</p>}
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    if (issue.action.section === 'data' && !issue.action.subSection) {
                      setPendingFilter({
                        view: issue.action.dataView ?? 'documents',
                        statusFilter: issue.action.statusFilter,
                        sourceId: issue.action.sourceId,
                      });
                    }
                    if (issue.action.subSection) {
                      setTabAndSubSection(issue.action.section, issue.action.subSection);
                    } else {
                      setTab(issue.action.section);
                    }
                  }}
                >
                  {issue.action.label}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
