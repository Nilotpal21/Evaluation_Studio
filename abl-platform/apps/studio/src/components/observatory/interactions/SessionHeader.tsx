/**
 * SessionHeader — Top stats bar for the Interactions tab.
 *
 * Displays: session ID, status badge, interaction count, agent count,
 * LLM call count, tool call count, total duration.
 */

import { useMemo } from 'react';
import { getBadgeIntentStyles } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import { ContextWindowBar } from './ContextWindowBar';
import { formatDuration } from './format-utils';
import type { SessionSummary } from './types';

interface SessionHeaderProps {
  summary: SessionSummary;
}

export function SessionHeader({ summary }: SessionHeaderProps) {
  const statusBadge = useMemo(() => {
    switch (summary.status) {
      case 'completed':
        return { label: 'Completed', intent: 'success' as const };
      case 'failed':
        return { label: 'Failed', intent: 'error' as const };
      case 'running':
        return { label: 'Running', intent: 'info' as const };
    }
  }, [summary.status]);

  const badgeStyles = getBadgeIntentStyles(statusBadge.intent);

  return (
    <div className="px-3 py-2.5 bg-background-subtle border-b border-border-muted">
      {/* Top row: session ID + status */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-mono text-foreground-subtle">
          #{summary.sessionId.slice(0, 8)}
        </span>
        <span
          className={clsx(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-medium leading-none',
            badgeStyles.badge,
          )}
        >
          <span className={clsx('h-1.5 w-1.5 rounded-full', badgeStyles.dot)} />
          {statusBadge.label}
        </span>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs text-foreground-muted flex-wrap">
        <Stat label="Interactions" value={summary.interactionCount} />
        <Stat label="Agents" value={summary.agentCount} />
        <Stat label="LLM calls" value={summary.llmCallCount} />
        <Stat label="Tool calls" value={summary.toolCallCount} />
        <Stat label="Duration" value={formatDuration(summary.totalDurationMs)} />

        {summary.totalTokensIn + summary.totalTokensOut > 0 && (
          <Stat
            label="Tokens"
            value={(summary.totalTokensIn + summary.totalTokensOut).toLocaleString()}
          />
        )}
        {summary.totalCost > 0 && <Stat label="Cost" value={`$${summary.totalCost.toFixed(4)}`} />}
      </div>

      {/* Context window bar — only shown when context window size is available from trace data */}
      {/* L4: Context limit applies to input tokens only, not input+output */}
      {summary.maxContextWindowSize > 0 && (
        <div className="mt-2">
          <ContextWindowBar
            tokensUsed={summary.totalTokensIn}
            contextLimit={summary.maxContextWindowSize}
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-foreground-subtle">{label}:</span>
      <span className="font-semibold text-foreground">{value}</span>
    </div>
  );
}
