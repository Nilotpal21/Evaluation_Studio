import type { ExtendedTraceEvent, Span } from '../../types';

export interface SpanLlmMetrics {
  llmCallCount: number;
  cost: number;
  hasCost: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasTokens: boolean;
  latencyMs: number;
  hasLatency: boolean;
}

export interface SpanSummary {
  span: Span;
  cost?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
}

export interface WaterfallSummaryMetrics {
  totalCost: number;
  totalTokens: number;
  totalDuration: number;
  errorCount: number;
  spanCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickNumericValue(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number') {
      return candidate;
    }
  }

  return undefined;
}

function getEventLlmMetrics(
  event: ExtendedTraceEvent,
): Omit<SpanLlmMetrics, 'llmCallCount' | 'totalTokens'> | null {
  if (event.type !== 'llm_call') {
    return null;
  }

  const data = event.data ?? {};
  const usage = isRecord(data.usage) ? data.usage : {};

  const promptTokens = pickNumericValue(
    data.promptTokens,
    data.tokensIn,
    data.prompt_tokens,
    data.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.input_tokens,
  );
  const completionTokens = pickNumericValue(
    data.completionTokens,
    data.tokensOut,
    data.completion_tokens,
    data.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.output_tokens,
  );
  const cost = pickNumericValue(data.cost);
  const latencyMs = pickNumericValue(
    data.latencyMs,
    data.durationMs,
    data.latency_ms,
    data.duration_ms,
  );

  return {
    cost: cost ?? 0,
    hasCost: cost !== undefined,
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    hasTokens: promptTokens !== undefined || completionTokens !== undefined,
    latencyMs: latencyMs ?? 0,
    hasLatency: latencyMs !== undefined,
  };
}

export function getSpanLlmMetrics(span: Span): SpanLlmMetrics | null {
  let llmCallCount = 0;
  let cost = 0;
  let hasCost = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let hasTokens = false;
  let latencyMs = 0;
  let hasLatency = false;

  for (const event of span.events) {
    const eventMetrics = getEventLlmMetrics(event);
    if (!eventMetrics) {
      continue;
    }

    llmCallCount += 1;
    cost += eventMetrics.cost;
    promptTokens += eventMetrics.promptTokens;
    completionTokens += eventMetrics.completionTokens;
    latencyMs += eventMetrics.latencyMs;
    hasCost ||= eventMetrics.hasCost;
    hasTokens ||= eventMetrics.hasTokens;
    hasLatency ||= eventMetrics.hasLatency;
  }

  if (llmCallCount === 0) {
    return null;
  }

  return {
    llmCallCount,
    cost,
    hasCost,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    hasTokens,
    latencyMs,
    hasLatency,
  };
}

export function getDecisionEvents(span: Span): ExtendedTraceEvent[] {
  return span.events.filter((event) => event.type === 'decision');
}

export function buildSpanSummary(span: Span): SpanSummary {
  const metrics = getSpanLlmMetrics(span);

  return {
    span,
    cost: metrics?.hasCost ? metrics.cost : undefined,
    promptTokens: metrics?.hasTokens ? metrics.promptTokens : undefined,
    completionTokens: metrics?.hasTokens ? metrics.completionTokens : undefined,
    totalTokens: metrics?.hasTokens ? metrics.totalTokens : undefined,
    latencyMs: metrics?.hasLatency ? metrics.latencyMs : undefined,
  };
}

export function buildSpanSummaries(spans: Iterable<Span>): SpanSummary[] {
  return Array.from(spans, (span) => buildSpanSummary(span));
}

export function summarizeSpanSummaries(summaries: Iterable<SpanSummary>): WaterfallSummaryMetrics {
  let totalCost = 0;
  let totalTokens = 0;
  let totalDuration = 0;
  let errorCount = 0;
  let spanCount = 0;

  for (const summary of summaries) {
    spanCount += 1;

    if (summary.cost !== undefined) {
      totalCost += summary.cost;
    }
    if (summary.totalTokens !== undefined) {
      totalTokens += summary.totalTokens;
    }
    if (summary.span.durationMs !== undefined) {
      totalDuration += summary.span.durationMs;
    }
    if (summary.span.status === 'error') {
      errorCount += 1;
    }
  }

  return { totalCost, totalTokens, totalDuration, errorCount, spanCount };
}
