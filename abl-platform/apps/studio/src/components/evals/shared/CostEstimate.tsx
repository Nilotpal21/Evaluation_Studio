/**
 * CostEstimate — Estimated cost breakdown for an eval run.
 *
 * Shows conversation costs, judging costs, and total estimate based on
 * the matrix dimensions (personas x scenarios x evaluators x variants).
 */

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { DollarSign } from 'lucide-react';

interface CostEstimateProps {
  personas: number;
  scenarios: number;
  evaluators: number;
  variants: number;
  className?: string;
}

const COST_PER_CONVERSATION = 0.02;
const COST_PER_JUDGMENT = 0.01;

export function CostEstimate({
  personas,
  scenarios,
  evaluators,
  variants,
  className,
}: CostEstimateProps) {
  const t = useTranslations('evals');
  const conversations = personas * scenarios * variants;
  const judgments = personas * scenarios * variants * evaluators;
  const conversationCost = conversations * COST_PER_CONVERSATION;
  const judgingCost = judgments * COST_PER_JUDGMENT;
  const totalCost = conversationCost + judgingCost;

  return (
    <div className={clsx('bg-background-muted rounded-lg p-3', className)}>
      <div className="flex items-center gap-1.5 mb-2">
        <DollarSign className="w-3.5 h-3.5 text-muted" />
        <span className="text-xs font-medium text-foreground">{t('cost_estimate.title')}</span>
      </div>

      <div className="space-y-1.5 text-xs">
        <div className="flex items-center justify-between text-muted">
          <span>
            {t('cost_estimate.conversations', {
              count: conversations.toLocaleString(),
              cost: COST_PER_CONVERSATION.toFixed(2),
            })}
          </span>
          <span className="text-foreground">${conversationCost.toFixed(2)}</span>
        </div>

        <div className="flex items-center justify-between text-muted">
          <span>
            {t('cost_estimate.judging', {
              count: judgments.toLocaleString(),
              cost: COST_PER_JUDGMENT.toFixed(2),
            })}
          </span>
          <span className="text-foreground">${judgingCost.toFixed(2)}</span>
        </div>

        <div className="border-t border-default pt-1.5 flex items-center justify-between font-medium">
          <span className="text-foreground">{t('cost_estimate.total')}</span>
          <span className="text-foreground">${totalCost.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
