/**
 * StageDetail Component
 *
 * Expandable accordion showing debug data for a single pipeline stage.
 * Renders stage-specific fields (corrections, resolved terms, mappings, etc.).
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { Badge } from '../../ui/Badge';
import { STAGE_I18N_MAP, type PipelineStageTrace, type PipelineDebugTrace } from './debug-types';

interface StageDetailProps {
  stageName: string;
  stage: PipelineStageTrace & Record<string, unknown>;
  isOpen: boolean;
  onToggle: () => void;
}

function PermissionFilterDetail({
  stage,
}: {
  stage: NonNullable<PipelineDebugTrace['stages']['permissionFilter']>;
}) {
  const t = useTranslations('search_ai.debug');
  if (stage.filterCount == null) return null;
  return (
    <div className="text-sm text-muted">{t('filter_count', { count: stage.filterCount })}</div>
  );
}

function PreprocessingDetail({
  stage,
}: {
  stage: NonNullable<PipelineDebugTrace['stages']['preprocessing']>;
}) {
  const t = useTranslations('search_ai.debug');
  return (
    <div className="space-y-2">
      {stage.corrections && stage.corrections.length > 0 && (
        <div>
          <span className="text-xs font-medium text-foreground">{t('corrections')}</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {stage.corrections.map((c, i) => (
              <Badge key={i} variant="info">
                {c}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {stage.entities && stage.entities.length > 0 && (
        <div>
          <span className="text-xs font-medium text-foreground">{t('entities')}</span>
          <pre className="text-xs text-muted bg-background-muted rounded p-2 mt-1 overflow-x-auto">
            {JSON.stringify(stage.entities, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function VocabularyResolutionDetail({
  stage,
}: {
  stage: NonNullable<PipelineDebugTrace['stages']['vocabularyResolution']>;
}) {
  const t = useTranslations('search_ai.debug');
  return (
    <div className="space-y-2">
      {stage.classifiedQueryType && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">{t('query_type')}:</span>
          <Badge variant="accent">{stage.classifiedQueryType}</Badge>
          {stage.classificationConfidence != null && (
            <span className="text-xs text-muted">
              ({t('confidence')}: {(stage.classificationConfidence * 100).toFixed(0)}%)
            </span>
          )}
        </div>
      )}
      {stage.resolvedTerms && stage.resolvedTerms.length > 0 && (
        <div>
          <span className="text-xs font-medium text-foreground">{t('resolved_terms')}</span>
          <table className="w-full mt-1 text-xs">
            <thead>
              <tr className="text-left text-muted border-b border-default">
                <th className="pb-1 pr-4">{t('th_original')}</th>
                <th className="pb-1 pr-4">{t('th_resolved')}</th>
                <th className="pb-1">{t('th_type')}</th>
              </tr>
            </thead>
            <tbody>
              {stage.resolvedTerms.map((term, i) => (
                <tr key={i} className="border-b border-default last:border-0">
                  <td className="py-1 pr-4 font-mono">{term.original}</td>
                  <td className="py-1 pr-4 font-mono text-accent">{term.resolved}</td>
                  <td className="py-1">
                    <Badge variant="purple">{term.type}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AliasResolutionDetail({
  stage,
}: {
  stage: NonNullable<PipelineDebugTrace['stages']['aliasResolution']>;
}) {
  if (!stage.mappings || Object.keys(stage.mappings).length === 0) return null;
  return (
    <div className="space-y-1">
      {Object.entries(stage.mappings).map(([from, to]) => (
        <div key={from} className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted">{from}</span>
          <span className="text-muted">&rarr;</span>
          <span className="font-mono text-accent">{to}</span>
        </div>
      ))}
    </div>
  );
}

function SearchExecutionDetail({
  stage,
}: {
  stage: NonNullable<PipelineDebugTrace['stages']['searchExecution']>;
}) {
  const t = useTranslations('search_ai.debug');
  return (
    <div className="flex items-center gap-4 text-sm text-muted">
      <span>
        {t('query_type')}: <Badge variant="accent">{stage.queryType}</Badge>
      </span>
      {stage.rawResultCount != null && (
        <span>
          {t('raw_results')}: {stage.rawResultCount}
        </span>
      )}
    </div>
  );
}

function RerankDetail({ stage }: { stage: NonNullable<PipelineDebugTrace['stages']['rerank']> }) {
  const t = useTranslations('search_ai.debug');
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm text-muted">
      {stage.modelUsed && (
        <span>
          {t('model_used')}: <Badge variant="info">{stage.modelUsed}</Badge>
        </span>
      )}
      {stage.resultCountBefore != null && (
        <span>{t('results_before', { count: stage.resultCountBefore })}</span>
      )}
      {stage.resultCountAfter != null && (
        <span>{t('results_after', { count: stage.resultCountAfter })}</span>
      )}
    </div>
  );
}

function MetricsDetail({ stage }: { stage: NonNullable<PipelineDebugTrace['stages']['metrics']> }) {
  const t = useTranslations('search_ai.debug');
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm text-muted">
      <span>{t('duration_ms', { ms: stage.durationMs })}</span>
      {stage.costEstimate != null && (
        <span>
          {t('cost_estimate')}: ${stage.costEstimate.toFixed(4)}
        </span>
      )}
    </div>
  );
}

const DETAIL_RENDERERS: Record<string, React.ComponentType<{ stage: never }>> = {
  permissionFilter: PermissionFilterDetail as React.ComponentType<{ stage: never }>,
  preprocessing: PreprocessingDetail as React.ComponentType<{ stage: never }>,
  vocabularyResolution: VocabularyResolutionDetail as React.ComponentType<{ stage: never }>,
  aliasResolution: AliasResolutionDetail as React.ComponentType<{ stage: never }>,
  searchExecution: SearchExecutionDetail as React.ComponentType<{ stage: never }>,
  rerank: RerankDetail as React.ComponentType<{ stage: never }>,
  metrics: MetricsDetail as React.ComponentType<{ stage: never }>,
};

export function StageDetail({ stageName, stage, isOpen, onToggle }: StageDetailProps) {
  const t = useTranslations('search_ai.debug');
  const i18nKey = (STAGE_I18N_MAP as Record<string, string>)[stageName] ?? stageName;
  const DetailRenderer = DETAIL_RENDERERS[stageName];

  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
        className={clsx(
          'flex items-center gap-2 w-full px-4 py-2.5 text-left transition-colors',
          'hover:bg-background-muted',
          isOpen && 'bg-background-muted',
        )}
      >
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-muted shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted shrink-0" />
        )}
        <span className="text-sm font-medium text-foreground">{t(i18nKey)}</span>
        <span
          className={clsx(
            'ml-auto text-xs px-1.5 py-0.5 rounded-full',
            stage.applied ? 'bg-success-subtle text-success' : 'bg-background-muted text-muted',
          )}
        >
          {stage.applied ? t('applied') : t('skipped')}
        </span>
        <span className="text-xs font-mono text-muted">
          {t('duration_ms', { ms: stage.durationMs })}
        </span>
      </button>

      {isOpen && (
        <div className="px-4 py-3 border-t border-default bg-background">
          {DetailRenderer ? (
            <DetailRenderer stage={stage as never} />
          ) : (
            <pre className="text-xs text-muted overflow-x-auto">
              {JSON.stringify(stage, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
