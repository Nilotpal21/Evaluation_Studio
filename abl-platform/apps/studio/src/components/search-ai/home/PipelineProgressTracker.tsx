/**
 * PipelineProgressTracker Component
 *
 * Replaces ProgressView on the Home tab when a KB is processing.
 * Shows a 5-step pipeline stepper, overall progress, current step details,
 * and an error callout if any documents failed.
 *
 * Data: polls status-summary API every 5s (same as previous ProgressView).
 */

import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { AlertCircle, Search, FileText, ArrowRight, Check } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Progress } from '../../ui/Progress';
import { Button } from '../../ui/Button';
import {
  fetchDocumentStatusSummary,
  type DocumentStatusSummary,
  type KnowledgeBaseDetail,
  type SearchAISource,
  type SearchAIIndex,
} from '../../../api/search-ai';
import {
  STAGE_ORDER,
  STAGE_META,
  aggregateToStages,
  getCurrentStage,
  getTotalDocuments,
  getStageIndex,
  type PipelineStage,
  type StageCounts,
} from '../../../lib/search-ai-pipeline-stages';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';

interface PipelineProgressTrackerProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  sources?: SearchAISource[];
  onNavigate?: (tab: string, subSection?: string) => void;
}

function StepDot({ state, label }: { state: 'done' | 'active' | 'pending'; label: string }) {
  const base =
    'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0';
  if (state === 'done') {
    return (
      <div className={`${base} bg-success text-white`} aria-label={`${label} — complete`}>
        <Check className="w-4 h-4" />
      </div>
    );
  }
  if (state === 'active') {
    return (
      <div
        className={`${base} bg-info text-white shadow-[0_0_0_4px_hsl(187_40%_15%)] animate-pulse`}
        aria-label={`${label} — in progress`}
      >
        <span className="text-[11px]">⟳</span>
      </div>
    );
  }
  return (
    <div
      className={`${base} bg-background-muted text-muted border-2 border-dashed border-default`}
      aria-label={`${label} — waiting`}
    />
  );
}

function StepperLine({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') {
    return <div className="flex-1 h-[3px] rounded-full bg-success" />;
  }
  if (state === 'active') {
    return <div className="flex-1 h-[3px] rounded-full bg-gradient-status-success" />;
  }
  return <div className="flex-1 h-[3px] rounded-full bg-background-muted" />;
}

function getStepState(
  stageIdx: number,
  activeIdx: number,
  allDone: boolean,
): 'done' | 'active' | 'pending' {
  if (allDone) return 'done';
  if (stageIdx < activeIdx) return 'done';
  if (stageIdx === activeIdx) return 'active';
  return 'pending';
}

function getSubText(stage: PipelineStage, stages: StageCounts): string {
  const count = stages[stage];
  if (stage === 'searchable' && count > 0) return `${count} ready`;
  if (count > 0) return `${count} in progress`;
  return '';
}

function getRemainingCount(stages: StageCounts): number {
  return stages.uploaded + stages.extracting + stages.enriching + stages.embedding;
}

export function PipelineProgressTracker({
  knowledgeBase,
  indexId,
  onNavigate,
}: PipelineProgressTrackerProps) {
  const t = useTranslations('search_ai.progress');
  const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);

  // No polling — updates arrive via WebSocket event → parent useKnowledgeBase mutate()
  // → SWR global cache invalidation cascades to all hooks sharing index keys.
  const { data: indexData } = useSWR<{ index: SearchAIIndex }>(
    indexId ? `/api/search-ai/indexes/${indexId}` : null,
    { revalidateOnFocus: true },
  );

  const { data: statusData } = useSWR<DocumentStatusSummary>(
    indexId ? `/api/search-ai/indexes/${indexId}/documents/status-summary` : null,
    () => fetchDocumentStatusSummary(indexId),
    { revalidateOnFocus: true },
  );

  const index = indexData?.index;

  const statusCounts = statusData?.documentStatuses ?? [];
  const stages = aggregateToStages(statusCounts);
  const totalDocs = getTotalDocuments(stages);
  const currentStage = getCurrentStage(stages);
  const allDone = currentStage === 'searchable' && stages.searchable === totalDocs;
  const activeIdx = currentStage === 'failed' ? -1 : getStageIndex(currentStage as PipelineStage);
  const progressPct = totalDocs > 0 ? Math.round((stages.searchable / totalDocs) * 100) : 0;
  const remaining = getRemainingCount(stages);

  return (
    <div className="space-y-6">
      <Card hoverable={false} padding="lg">
        {/* Header */}
        <div className="flex items-start gap-3.5 mb-1">
          <div className="rounded-lg bg-info-subtle p-2.5 shrink-0">
            <FileText className="w-5 h-5 text-info" />
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">{t('pipeline_title')}</h3>
            <p className="text-sm text-muted mt-0.5">{t('pipeline_description')}</p>
          </div>
        </div>

        {/* Stepper */}
        <div className="flex items-start justify-between mt-6 mb-6 px-2">
          {STAGE_ORDER.map((stage, idx) => {
            const stepState = getStepState(idx, activeIdx, allDone);
            const meta = STAGE_META[stage];
            const sub = getSubText(stage, stages);
            const lineState =
              idx < STAGE_ORDER.length - 1
                ? getStepState(idx + 1, activeIdx, allDone) === 'done'
                  ? 'done'
                  : getStepState(idx, activeIdx, allDone) === 'done' &&
                      getStepState(idx + 1, activeIdx, allDone) === 'active'
                    ? 'active'
                    : 'pending'
                : undefined;

            return (
              <div key={stage} className="flex items-start flex-1 min-w-0">
                <div className="flex flex-col items-center gap-1.5 min-w-[72px]">
                  <StepDot state={stepState} label={t(meta.labelKey)} />
                  <span
                    className={`text-[11px] font-semibold text-center leading-tight ${
                      stepState === 'done'
                        ? 'text-success'
                        : stepState === 'active'
                          ? 'text-info'
                          : 'text-muted'
                    }`}
                  >
                    {t(meta.labelKey)}
                  </span>
                  {sub && <span className="text-[11px] text-muted">{sub}</span>}
                </div>
                {lineState !== undefined && (
                  <div className="flex-1 pt-4 px-1">
                    <StepperLine state={lineState} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-1">
          {/* Overall progress */}
          <div className="rounded-lg bg-background-muted p-5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-success tabular-nums">
                {stages.searchable}
              </span>
              <span className="text-base text-muted font-medium">/ {totalDocs}</span>
            </div>
            <p className="text-sm text-muted mt-1">{t('pipeline_docs_searchable')}</p>
            <Progress value={progressPct} className="mt-3" indicatorClassName="bg-success" />
            <p className="text-xs text-muted text-right mt-1">{progressPct}%</p>
          </div>

          {/* Current step details */}
          <div className="rounded-lg bg-background-muted p-5">
            <div className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted">{t('pipeline_currently')}</span>
                <span className="font-medium text-info">
                  {STAGE_META[currentStage]?.labelKey
                    ? t(STAGE_META[currentStage].labelKey)
                    : currentStage}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted">{t('pipeline_in_step')}</span>
                <span className="font-medium text-foreground">
                  {stages[currentStage as keyof StageCounts] ?? 0} documents
                </span>
              </div>
              {remaining > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted">{t('pipeline_remaining')}</span>
                  <span className="font-medium text-foreground">
                    {t('pipeline_remaining_count', { count: remaining })}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Error callout */}
        {stages.failed > 0 && (
          <div className="flex items-start gap-2.5 mt-5 p-3.5 rounded-lg bg-error-subtle border-l-[3px] border-l-error">
            <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-error">
                {t('pipeline_failed_count', { count: stages.failed })}
              </p>
              <p className="text-xs text-muted mt-0.5">{t('pipeline_failed_description')}</p>
              <button
                className="inline-flex items-center gap-1 mt-1.5 text-xs font-medium text-error underline hover:no-underline cursor-pointer"
                onClick={() => {
                  setPendingFilter({ view: 'documents', statusFilter: 'error' });
                  onNavigate?.('data');
                }}
              >
                {t('pipeline_view_failed')} <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-5 pt-4 border-t border-default">
          <Button variant="ghost" size="xs" onClick={() => onNavigate?.('search')}>
            <Search className="w-3.5 h-3.5" />
            {t('action_try_search')}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => onNavigate?.('data')}>
            <FileText className="w-3.5 h-3.5" />
            {t('action_view_documents')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
