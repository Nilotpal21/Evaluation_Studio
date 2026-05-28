/**
 * ScoreDetail Component
 *
 * Expanded detail panel showing per-evaluator score breakdown when a heat map
 * cell is clicked. Displays each evaluator's average score, variant count,
 * min/max range, and variance indicator.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X, Wrench } from 'lucide-react';
import type { HeatMapCell } from '@/hooks/useEvalData';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { EvalBadge } from '../shared/EvalBadge';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';

interface ScoreDetailProps {
  cells: HeatMapCell[];
  personaId: string;
  scenarioId: string;
  personaName: string;
  scenarioName: string;
  evaluatorNames: Record<string, string>;
  onClose: () => void;
}

interface EvaluatorBreakdown {
  evaluatorId: string;
  avgScore: number;
  count: number;
  minScore: number;
  maxScore: number;
  variance: number;
}

function varianceInfo(variance: number): {
  key: string;
  variant: 'success' | 'warning' | 'error';
} {
  if (variance <= 0.25) return { key: 'low', variant: 'success' };
  if (variance <= 1.0) return { key: 'medium', variant: 'warning' };
  return { key: 'high', variant: 'error' };
}

export function ScoreDetail({
  cells,
  personaId,
  scenarioId,
  personaName,
  scenarioName,
  evaluatorNames,
  onClose,
}: ScoreDetailProps) {
  const t = useTranslations('evals');

  // Filter cells for the selected (persona, scenario) pair and build per-evaluator breakdown
  const { evaluators, overallAvg } = useMemo(() => {
    const filtered = cells.filter((c) => c.personaId === personaId && c.scenarioId === scenarioId);

    const evals: EvaluatorBreakdown[] = filtered.map((c) => ({
      evaluatorId: c.evaluatorId,
      avgScore: c.avgScore,
      count: c.count,
      minScore: c.minScore,
      maxScore: c.maxScore,
      variance: c.variance,
    }));

    // Weight by per-evaluator variant count so this matches the heatmap cell value.
    const totalCount = evals.reduce((sum, e) => sum + e.count, 0);
    const avg =
      totalCount > 0 ? evals.reduce((sum, e) => sum + e.avgScore * e.count, 0) / totalCount : 0;

    return { evaluators: evals, overallAvg: avg };
  }, [cells, personaId, scenarioId]);

  return (
    <div className="border border-default rounded-xl p-4 bg-background-elevated">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-primary truncate">{personaName}</h3>
            <span className="text-muted text-xs">&times;</span>
            <h3 className="text-sm font-semibold text-primary truncate">{scenarioName}</h3>
          </div>
          {evaluators.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-muted">{t('score_detail.overall_average')}</span>
              <EvalBadge score={overallAvg} />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md hover:bg-background-muted transition-default text-muted hover:text-primary"
          aria-label="Close detail panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Evaluator rows */}
      {evaluators.length === 0 ? (
        <div className="text-sm text-muted py-4 text-center">
          {t('score_detail.no_evaluator_data')}
        </div>
      ) : (
        <div>
          {evaluators.map((ev, idx) => {
            const vInfo = varianceInfo(ev.variance);
            const isLast = idx === evaluators.length - 1;

            return (
              <div
                key={ev.evaluatorId}
                className={`flex items-center justify-between py-2 ${isLast ? '' : 'border-b border-default'}`}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-sm text-primary truncate">
                    {evaluatorNames[ev.evaluatorId] ?? ev.evaluatorId}
                  </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <EvalBadge score={ev.avgScore} />

                  <span className="text-xs text-muted whitespace-nowrap">n={ev.count}</span>

                  <span className="text-xs text-muted whitespace-nowrap">
                    {ev.minScore.toFixed(1)}&ndash;{ev.maxScore.toFixed(1)}
                  </span>

                  <Badge variant={vInfo.variant}>
                    {t(`score_detail.variance.${vInfo.key}` as Parameters<typeof t>[0])}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Fix in Architect — shown when overall score is poor */}
      {overallAvg > 0 && overallAvg < 3.0 && (
        <div className="mt-3 pt-3 border-t border-default">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              const evalDetails = evaluators
                .map(
                  (ev) =>
                    `- ${evaluatorNames[ev.evaluatorId] ?? ev.evaluatorId}: ${ev.avgScore.toFixed(1)}/5`,
                )
                .join('\n');
              const message = `Eval failure for persona "${personaName}" in scenario "${scenarioName}": overall score ${overallAvg.toFixed(1)}/5.\n\nPer-evaluator breakdown:\n${evalDetails}\n\nSuggest improvements to this agent.`;
              useArchAIStore.getState().setPrefillMessage(message);
              useArchAIStore.getState().openOverlay();
            }}
            icon={<Wrench className="w-3 h-3" />}
          >
            {t('score_detail.fix_in_architect')}
          </Button>
        </div>
      )}
    </div>
  );
}
