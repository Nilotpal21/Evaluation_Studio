/**
 * HeatMapCell Component
 *
 * Individual clickable cell in the heat map grid. Background color is
 * determined by the average score, with a ring highlight for the selected cell.
 */

import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { Tooltip } from '../../ui/Tooltip';

interface HeatMapCellProps {
  score: number;
  count: number;
  isSelected: boolean;
  onClick: () => void;
}

function scoreBg(score: number): string {
  if (score >= 4) return 'bg-success-subtle';
  if (score >= 3) return 'bg-accent-subtle';
  if (score >= 2) return 'bg-warning-subtle';
  return 'bg-error-subtle';
}

function scoreText(score: number): string {
  if (score >= 4) return 'text-success';
  if (score >= 3) return 'text-accent';
  if (score >= 2) return 'text-warning';
  return 'text-error';
}

export function HeatMapCellComponent({ score, count, isSelected, onClick }: HeatMapCellProps) {
  const t = useTranslations('evals');
  return (
    // Wrap in a non-interactive span so the Tooltip trigger never intercepts
    // the button's click event — asChild on a button can suppress onClick on
    // some pointer sequences.
    <Tooltip content={t('heatmap.cell_tooltip', { score: score.toFixed(1), count })} side="top">
      <span className="block w-full">
        <button
          type="button"
          onClick={onClick}
          className={clsx(
            'w-full min-w-[120px] h-16 flex flex-col items-center justify-center gap-0.5',
            'cursor-pointer transition-default hover:brightness-110',
            scoreBg(score),
            isSelected && 'ring-2 ring-inset ring-accent',
          )}
        >
          <span className={clsx('text-base font-bold', scoreText(score))}>{score.toFixed(1)}</span>
          <span className="text-[10px] text-muted/70">n={count}</span>
        </button>
      </span>
    </Tooltip>
  );
}
