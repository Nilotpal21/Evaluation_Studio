'use client';

import { useState } from 'react';
import { clsx } from 'clsx';

/**
 * ModelComparisonWidget — renders model recommendation results from recommend_model tool.
 * B20: Model Selection Intelligence — UX Design: stacked cards with promoted recommendation.
 */

interface ScoredModel {
  provider: string;
  model: string;
  reason: string;
  costTier?: 'low' | 'medium' | 'high';
  latencyTier?: 'fast' | 'moderate' | 'slow';
}

interface ModelRecommendationResult {
  agent?: string;
  primary: ScoredModel;
  fallback?: ScoredModel;
  costComparison?: { relativeSavings: string };
  recommendations?: Array<{ agent: string; primary: ScoredModel }>;
  agentCount?: number;
}

interface ModelComparisonWidgetProps {
  data: ModelRecommendationResult;
}

const COST_ICONS: Record<string, string> = { low: '$', medium: '$$', high: '$$$' };
const LATENCY_LABELS: Record<string, string> = {
  fast: '⚡ fast',
  moderate: '⏱ moderate',
  slow: '🐢 slow',
};

function ModelCard({
  model,
  isRecommended,
  collapsed,
  onToggle,
}: {
  model: ScoredModel;
  isRecommended?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const borderClass = isRecommended
    ? 'border-accent/30 bg-accent/5'
    : 'border-border/50 bg-background-muted/30';

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          'w-full text-left rounded-md border p-3 text-xs transition-colors hover:bg-surface-hover',
          borderClass,
        )}
      >
        <span className="font-medium text-foreground">{model.model}</span>
        <span className="text-foreground-muted">
          {' · '}
          {model.provider}
          {model.costTier ? ` · ${COST_ICONS[model.costTier] ?? ''}` : ''}
          {model.latencyTier ? ` · ${LATENCY_LABELS[model.latencyTier] ?? ''}` : ''}
        </span>
      </button>
    );
  }

  return (
    <div className={clsx('rounded-lg border p-4', borderClass)}>
      {isRecommended && (
        <span className="mb-2 inline-block rounded bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
          ★ Recommended
        </span>
      )}
      <div className="mb-1 text-sm font-medium text-foreground">{model.model}</div>
      <div className="mb-2 flex items-center gap-2 text-xs text-foreground-muted">
        <span>{model.provider}</span>
        {model.costTier && <span>{COST_ICONS[model.costTier]}</span>}
        {model.latencyTier && <span>{LATENCY_LABELS[model.latencyTier]}</span>}
      </div>
      <div className="text-xs text-foreground-muted">{model.reason}</div>
    </div>
  );
}

export function ModelComparisonWidget({ data }: ModelComparisonWidgetProps) {
  const [expandedAlt, setExpandedAlt] = useState<number | null>(null);

  // Topology-wide mode
  if (data.recommendations && data.agentCount) {
    return (
      <div className="my-4 rounded-lg border border-accent/20 bg-accent/5 p-4">
        <div className="mb-3 text-sm font-medium text-foreground">
          🧠 Model Recommendations — {data.agentCount} agents
        </div>
        <div className="space-y-2">
          {data.recommendations.map((rec) => (
            <div
              key={rec.agent}
              className="flex items-center justify-between rounded-md border border-border/30 bg-background-muted/20 px-3 py-2"
            >
              <span className="text-xs font-medium text-foreground">{rec.agent}</span>
              <span className="text-xs text-foreground-muted">
                {rec.primary.model} · {rec.primary.provider}
                {rec.primary.costTier ? ` · ${COST_ICONS[rec.primary.costTier]}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Single agent mode
  return (
    <div className="my-4 space-y-2">
      <div className="text-sm font-medium text-foreground">
        🧠 Model Recommendation{data.agent ? `: ${data.agent}` : ''}
      </div>

      <ModelCard model={data.primary} isRecommended />

      {data.costComparison && (
        <div className="text-xs font-medium text-success">
          💰 {data.costComparison.relativeSavings}
        </div>
      )}

      {data.fallback && (
        <div className="text-xs text-foreground-muted">
          Fallback: {data.fallback.model} ({data.fallback.provider})
        </div>
      )}
    </div>
  );
}
