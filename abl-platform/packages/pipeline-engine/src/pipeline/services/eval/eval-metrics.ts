/**
 * Eval OpenTelemetry Metrics
 *
 * 20+ instruments for observability across the eval pipeline.
 * Meter: 'abl-eval'. All metrics carry tenant_id and project_id attributes.
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('abl-eval', '1.0.0');

export const evalMetrics = {
  // ── Run Lifecycle ───────────────────────────────────────────────────
  runsStarted: meter.createCounter('eval.run.started', {
    description: 'Eval runs initiated',
  }),
  runsCompleted: meter.createCounter('eval.run.completed', {
    description: 'Eval runs finished successfully',
  }),
  runsFailed: meter.createCounter('eval.run.failed', {
    description: 'Eval runs that failed',
  }),
  runDuration: meter.createHistogram('eval.run.duration_ms', {
    description: 'End-to-end run duration in milliseconds',
  }),

  // ── Conversation Generation ─────────────────────────────────────────
  conversationsStarted: meter.createCounter('eval.conversation.started', {
    description: 'Eval conversations initiated',
  }),
  conversationsCompleted: meter.createCounter('eval.conversation.completed', {
    description: 'Eval conversations finished',
  }),
  conversationsFailed: meter.createCounter('eval.conversation.failed', {
    description: 'Eval conversations that errored',
  }),
  conversationDuration: meter.createHistogram('eval.conversation.duration_ms', {
    description: 'Single conversation duration',
  }),
  conversationTurns: meter.createHistogram('eval.conversation.turns', {
    description: 'Turns per conversation',
  }),

  // ── Persona Simulation ──────────────────────────────────────────────
  personaCallsStarted: meter.createCounter('eval.persona.started', {
    description: 'Persona LLM calls initiated',
  }),
  personaCallsCompleted: meter.createCounter('eval.persona.completed', {
    description: 'Persona LLM calls succeeded',
  }),
  personaCallsFailed: meter.createCounter('eval.persona.failed', {
    description: 'Persona LLM calls failed',
  }),
  personaDuration: meter.createHistogram('eval.persona.duration_ms', {
    description: 'Persona message generation latency',
  }),
  personaCost: meter.createHistogram('eval.persona.cost_usd', {
    description: 'Persona LLM call cost in USD',
  }),

  // ── Judging ─────────────────────────────────────────────────────────
  judgeCallsStarted: meter.createCounter('eval.judge.started', {
    description: 'Judge LLM calls initiated',
  }),
  judgeCallsCompleted: meter.createCounter('eval.judge.completed', {
    description: 'Judge LLM calls succeeded',
  }),
  judgeCallsFailed: meter.createCounter('eval.judge.failed', {
    description: 'Judge LLM calls failed',
  }),
  judgeDuration: meter.createHistogram('eval.judge.duration_ms', {
    description: 'Judge call latency',
  }),
  judgeTokensUsed: meter.createCounter('eval.judge.tokens_used', {
    description: 'Total tokens consumed by judging',
  }),
  judgeCost: meter.createHistogram('eval.judge.cost_usd', {
    description: 'Judge LLM call cost',
  }),

  // ── Cost Tracking ───────────────────────────────────────────────────
  runCost: meter.createHistogram('eval.run.cost_usd', {
    description: 'Total run cost in USD',
  }),

  // ── Scores ──────────────────────────────────────────────────────────
  scoreValue: meter.createHistogram('eval.score.value', {
    description: 'Distribution of eval scores (0-5)',
  }),
  regressionCount: meter.createCounter('eval.regression.detected', {
    description: 'Number of regression detections',
  }),

  // ── Circuit Breakers ────────────────────────────────────────────────
  circuitBreakerOpened: meter.createCounter('eval.circuit_breaker.opened', {
    description: 'Circuit breaker open events',
  }),

  // ── Rate Limiting ───────────────────────────────────────────────────
  rateLimitRejections: meter.createCounter('eval.rate_limit.rejected', {
    description: 'Requests rejected by rate limiter',
  }),
  rateLimitQueueDepth: meter.createUpDownCounter('eval.rate_limit.queue_depth', {
    description: 'Current rate limiter queue depth',
  }),

  // ── Active State (Gauges) ───────────────────────────────────────────
  activeRuns: meter.createUpDownCounter('eval.active_runs', {
    description: 'Currently executing eval runs',
  }),
  activeConversations: meter.createUpDownCounter('eval.active_conversations', {
    description: 'Currently executing eval conversations',
  }),
  activeJudgeCalls: meter.createUpDownCounter('eval.active_judge_calls', {
    description: 'Currently executing judge LLM calls',
  }),
};

/** Standard metric attributes for tenant+project scoping. */
export interface EvalMetricAttrs {
  tenant_id: string;
  project_id: string;
  eval_set_id?: string;
  evaluator_type?: string;
}
