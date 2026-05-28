/**
 * RunDetailDrawer Component
 *
 * Slide-out drawer showing run details with four tabs:
 * Steps, Input, Output Data, and Raw JSON.
 * Polls run status every 2s until terminal.
 */

'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SlidePanel } from '../../ui/SlidePanel';
import { Tabs } from '../../ui/Tabs';
import { Skeleton } from '../../ui/Skeleton';
import { JsonViewer } from '../../ui/JsonViewer';
import { RunMetaHeader } from './RunMetaHeader';
import { StepsList } from './StepsList';
import { ClickHousePreviewTable } from '../data/ClickHousePreviewTable';
import { useRunPolling } from './useRunPolling';
import { useRunsStore } from '../../../store/pipeline-runs-store';

type DrawerTab = 'steps' | 'input' | 'output' | 'raw';

interface RunDetailDrawerProps {
  projectId: string;
}

export function RunDetailDrawer({ projectId }: RunDetailDrawerProps) {
  const t = useTranslations('pipelines');
  const openRunId = useRunsStore((s) => s.openRunId);
  const closeRun = useRunsStore((s) => s.closeRun);
  const { run, isLoading, error } = useRunPolling(openRunId);
  const [tab, setTab] = useState<DrawerTab>('steps');

  const drawerTabs = [
    { id: 'steps' as const, label: t('run_detail.tab_steps') },
    { id: 'input' as const, label: t('run_detail.tab_input') },
    { id: 'output' as const, label: t('run_detail.tab_output') },
    { id: 'raw' as const, label: t('run_detail.tab_raw') },
  ];

  // Compute time range: from (startedAt - 1h) to (completedAt ?? now + 1h)
  const drawerTimeRange = useMemo(() => {
    if (!run) return undefined;
    const ONE_HOUR = 60 * 60 * 1000;
    const from = new Date(new Date(run.startedAt).getTime() - ONE_HOUR);
    const to = run.completedAt
      ? new Date(new Date(run.completedAt).getTime() + ONE_HOUR)
      : new Date(Date.now() + ONE_HOUR);
    return { from, to };
  }, [run]);

  const drawerTitle = run?.pipelineId
    ? `${t('run_detail.title_prefix')} ${run.pipelineId}`
    : t('run_detail.title_prefix');

  return (
    <SlidePanel open={!!openRunId} onClose={closeRun} title={drawerTitle} width="lg">
      {isLoading && (
        <div className="space-y-4 p-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-8 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      )}

      {error && !isLoading && (
        <div className="text-sm text-error p-4">
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {run && !isLoading && (
        <div className="space-y-4">
          <RunMetaHeader run={run} />

          <Tabs
            tabs={drawerTabs}
            activeTab={tab}
            onTabChange={(id) => setTab(id as DrawerTab)}
            layoutId="run-detail-tabs"
          />

          <div className="mt-4">
            {tab === 'steps' && (
              <StepsList
                steps={run.steps ?? []}
                failedStepId={run.error?.stepId}
                runId={run.runId}
                pipelineId={run.pipelineId}
                projectId={projectId}
              />
            )}
            {tab === 'input' && <JsonViewer data={run.triggerInput ?? run.input} copyable />}
            {tab === 'output' && (
              <ClickHousePreviewTable
                projectId={projectId}
                pipelineId={run.pipelineId}
                runId={run.runId}
                timeRange={drawerTimeRange}
                variant="drawer"
              />
            )}
            {tab === 'raw' && <JsonViewer data={run} copyable />}
          </div>
        </div>
      )}
    </SlidePanel>
  );
}
