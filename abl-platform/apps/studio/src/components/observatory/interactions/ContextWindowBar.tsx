/**
 * ContextWindowBar — Gradient context window usage bar.
 *
 * Three-color gradient:
 * - 0-60%: success (green)
 * - 60-80%: warning (amber)
 * - 80-100%: error (red)
 */

import clsx from 'clsx';

interface ContextWindowBarProps {
  /** Tokens used in this call */
  tokensUsed: number;
  /** Model's max context window */
  contextLimit: number;
  className?: string;
}

export function ContextWindowBar({ tokensUsed, contextLimit, className }: ContextWindowBarProps) {
  if (contextLimit <= 0) return null;

  const pct = Math.min((tokensUsed / contextLimit) * 100, 100);
  const fillColor = pct <= 60 ? 'bg-success' : pct <= 80 ? 'bg-warning' : 'bg-error';
  const textColor = pct <= 60 ? 'text-success' : pct <= 80 ? 'text-warning' : 'text-error';

  return (
    <div className={clsx('space-y-0.5', className)}>
      <div className="flex items-center justify-between text-[9px]">
        <span className="text-foreground-subtle">Context</span>
        <span className={clsx('font-mono font-medium', textColor)}>
          {Math.round(pct)}% of {formatTokenCount(contextLimit)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-background-elevated overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all duration-300', fillColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(0)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}k`;
  return String(count);
}
