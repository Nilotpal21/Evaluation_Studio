/**
 * TokenBadge — Inline token count + cost badge for interaction headers.
 *
 * Example: "487 tokens · $0.0024"
 */

import clsx from 'clsx';
import type { InteractionStep } from './types';

interface TokenBadgeProps {
  steps: InteractionStep[];
  className?: string;
}

/**
 * Aggregate token counts and cost from all LLM steps in an interaction.
 *
 * Scans interaction steps for llm_call types and sums token usage and costs.
 *
 * @param steps - Array of interaction steps to aggregate
 * @returns Object with totalTokens and totalCost
 *
 * @remarks
 * - Only processes steps with type === 'llm_call'
 * - Sums tokensIn and tokensOut from step.data
 * - Sums cost from step.data
 * - Pure function - no side effects, suitable for unit testing
 *
 * @example
 * ```ts
 * const { totalTokens, totalCost } = aggregateTokens(interaction.steps);
 * // Returns: { totalTokens: 487, totalCost: 0.0024 }
 * ```
 */
export function aggregateTokens(steps: InteractionStep[]): {
  totalTokens: number;
  totalCost: number;
} {
  let totalTokens = 0;
  let totalCost = 0;

  for (const step of steps) {
    if (step.type === 'llm_call') {
      totalTokens += Number(step.data.tokensIn ?? 0) + Number(step.data.tokensOut ?? 0);
      totalCost += Number(step.data.cost ?? 0);
    }
  }

  return { totalTokens, totalCost };
}

export function TokenBadge({ steps, className }: TokenBadgeProps) {
  const { totalTokens, totalCost } = aggregateTokens(steps);

  if (totalTokens === 0) return null;

  return (
    <span className={clsx('text-[9px] font-mono text-foreground-subtle shrink-0', className)}>
      {totalTokens.toLocaleString()} tokens
      {totalCost > 0 && ` · $${totalCost.toFixed(4)}`}
    </span>
  );
}
