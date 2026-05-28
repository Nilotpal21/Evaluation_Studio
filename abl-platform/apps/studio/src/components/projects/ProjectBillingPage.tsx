import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart3 } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { useProjectBillingUsageReport } from '../../hooks/useBilling';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import {
  BillingUsageReportPanel,
  getBillingDateRange,
  type BillingDateRange,
} from '../billing/BillingUsageReportPanel';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';

export function ProjectBillingPage() {
  const t = useTranslations('admin');
  const projectId = useNavigationStore((state) => state.projectId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const { state: billingFilters, updateState } = usePersistedSurfaceFilters('billingUsage');
  const dateRange = billingFilters.dateRange as BillingDateRange;
  const usageRange = useMemo(() => getBillingDateRange(dateRange), [dateRange]);
  const { report, isLoading, error } = useProjectBillingUsageReport({
    projectId,
    windowStart: usageRange.windowStart,
    windowEnd: usageRange.windowEnd,
    granularity: 'day',
  });

  if (!projectId) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <EmptyState
            icon={<BarChart3 className="w-6 h-6" />}
            title={t('billing.no_project_title')}
            description={t('billing.no_project_description')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <PageHeader
          title={t('billing.project_title')}
          description={
            currentProject?.name
              ? t('billing.project_description_named', { project: currentProject.name })
              : t('billing.project_description')
          }
        />

        <BillingUsageReportPanel
          report={report}
          isLoading={isLoading}
          error={error}
          dateRange={dateRange}
          onDateRangeChange={(nextDateRange) => updateState({ dateRange: nextDateRange })}
          selectedProjectId={projectId}
        />
      </div>
    </div>
  );
}
