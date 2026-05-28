'use client';

interface CompletionIndicatorProps {
  completion?: {
    usage: { totalTokens: number };
    latencyMs: number;
    model: string;
  };
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function CompletionIndicator({ completion }: CompletionIndicatorProps) {
  if (!completion) return null;
  const { usage, latencyMs, model } = completion;
  if (usage.totalTokens === 0 && latencyMs === 0) return null;

  const parts: string[] = [];
  if (latencyMs > 0) parts.push(formatLatency(latencyMs));
  if (usage.totalTokens > 0) parts.push(`${formatTokens(usage.totalTokens)} tokens`);
  if (model) parts.push(model);

  if (parts.length === 0) return null;

  return (
    <div className="mt-1 text-right text-[11px] text-foreground-muted/50 select-none">
      {parts.join(' · ')}
    </div>
  );
}
