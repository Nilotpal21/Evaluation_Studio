/**
 * ScoreBreakdown Component
 *
 * Displays a horizontal bar chart of score components for each search result.
 * Shows overall score and source information.
 */

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import type { SearchAIResult } from '../../../api/search-ai';

interface ScoreBreakdownProps {
  results: SearchAIResult[];
}

function ScoreBar({
  score,
  label,
  colorClass,
}: {
  score: number;
  label: string;
  colorClass: string;
}) {
  const pct = Math.max(0, Math.min(100, score * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted w-20 shrink-0 truncate">{label}</span>
      <div className="flex-1 h-4 rounded-full bg-background-muted overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', colorClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-muted w-14 text-right shrink-0">
        {(score ?? 0).toFixed(3)}
      </span>
    </div>
  );
}

export function ScoreBreakdown({ results }: ScoreBreakdownProps) {
  const t = useTranslations('search_ai.debug');

  if (!results || results.length === 0) {
    return <div className="text-sm text-muted py-4 text-center">{t('no_scores')}</div>;
  }

  const hasScores = results.some((r) => r.score != null);
  if (!hasScores) {
    return <div className="text-sm text-muted py-4 text-center">{t('no_scores')}</div>;
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-foreground">{t('score_breakdown')}</h4>
      <div className="space-y-4">
        {results.map((result, idx) => {
          const label = result.source?.sourceName ?? result.documentId.slice(0, 12);
          return (
            <div key={result.chunkId ?? idx} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium text-foreground truncate max-w-[200px]">
                  #{idx + 1} {label}
                </span>
                {result.chunkId && (
                  <span className="text-muted font-mono truncate max-w-[120px]">
                    {result.chunkId.slice(0, 8)}
                  </span>
                )}
              </div>
              <ScoreBar score={result.score ?? 0} label={t('score_label')} colorClass="bg-accent" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
