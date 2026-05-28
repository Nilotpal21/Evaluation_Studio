/**
 * Eval Pipeline Shared Types
 *
 * Interfaces and types used across all eval pipeline activities:
 * simulate-persona, execute-agent-turn, run-eval-conversation,
 * judge-conversation, aggregate-eval-run.
 */

// ── Conversation Types ──────────────────────────────────────────────

export interface ConversationTurn {
  role: 'user' | 'agent';
  content: string;
  timestamp: string; // ISO 8601
  agentName?: string; // Track which agent responded (for handoffs)
  tokenUsage?: { input: number; output: number };
}

export interface ConversationResult {
  conversation: ConversationTurn[];
  traceEvents: TraceEvent[];
  milestonesHit: string[];
  actualAgentPath: string[];
  turnCount: number;
  toolCallCount: number;
  durationMs: number;
  tokenUsage: number;
  estimatedCost: number;
  /** Cost of customer-visible LLM calls only */
  customerVisibleCost: number;
  /** Cost broken down by model ID */
  costByModel: Record<string, number>;
  hasError: boolean;
  errorMessage?: string;
}

// ── Trace Event (extends canonical with eval-specific flexibility) ───

import type { TraceEvent as BaseTraceEvent } from '@agent-platform/shared-kernel';

/**
 * Eval pipeline trace event — relaxes the canonical TraceEvent for eval contexts
 * where type may be an arbitrary string and timestamp may be an ISO string.
 */
export interface TraceEvent extends Omit<BaseTraceEvent, 'type' | 'timestamp'> {
  type: string;
  timestamp?: string | Date;
}

// ── Persona Types ───────────────────────────────────────────────────

export interface PersonaConfig {
  _id: string;
  name: string;
  communicationStyle: string;
  domainKnowledge: string;
  behaviorTraits: string[];
  goals: string;
  constraints: string;
  sessionVariables?: Record<string, unknown>;
  systemPrompt?: string;
  isAdversarial: boolean;
  adversarialType?: string;
  version: number;
}

export interface PersonaSimulationConfig {
  personaModel?: string;
  temperature: number;
  maxTokens: number;
}

// ── Scenario Types ──────────────────────────────────────────────────

export interface ScenarioConfig {
  _id: string;
  name: string;
  entryAgent?: string;
  initialMessage?: string;
  expectedOutcome?: string;
  maxTurns: number;
  expectedMilestones: string[];
  agentPath: string[];
  maxToolCalls?: number;
  version: number;
}

// ── Evaluator Types ─────────────────────────────────────────────────

export interface ScoringRubricPoint {
  value: number;
  label: string;
  criteria: string;
  examples?: string[];
}

export interface ScoringRubric {
  scaleType: '1-5' | 'pass-fail';
  points: ScoringRubricPoint[];
}

export interface BiasSettings {
  positionSwapEnabled: boolean;
  blindEvaluation: boolean;
  crossModelJudge: boolean;
  evidenceFirstMode: boolean;
}

export interface EvaluatorConfig {
  _id: string;
  name: string;
  type: 'llm_judge' | 'code_scorer' | 'trajectory' | 'human_review';
  category: string;
  judgeModel?: string;
  judgePrompt?: string;
  chainOfThought: boolean;
  temperature: number;
  scoringRubric?: ScoringRubric;
  biasSettings: BiasSettings;
  scorerName?: string;
  scorerConfig?: Record<string, unknown>;
  trajectoryMetrics?: string[];
  humanReviewThreshold?: number;
  version: number;
}

// ── Judge Result Types ──────────────────────────────────────────────

export interface JudgeResult {
  score: number;
  passed: boolean;
  reasoning: string;
  evidence: string;
  confidence: number;
  scoreOriginal?: number;
  scoreSwapped?: number;
  wasPositionSwapped: boolean;
  judgeTokensUsed: number;
  judgeCost: number;
  judgeLatencyMs: number;
  needsHumanReview: boolean;
}

export interface TrajectoryScoreResult {
  milestoneCompletionRate: number;
  handoffCorrectnessRate: number;
  pathEfficiencyScore: number;
  toolSequenceScore?: number;
}

// ── Aggregation Types ───────────────────────────────────────────────

export interface RunSummary {
  totalConversations: number;
  totalEvaluations: number;
  avgScore: number;
  scoresByEvaluator: Record<string, number>;
  durationMs: number;
  estimatedCost: number;
  /** Cost broken down by model ID (agent-under-test LLM calls) */
  estimatedCostByModel: Record<string, number>;
  /** Cost of only customer-visible LLM calls (excludes internal extraction, guardrails, etc.) */
  customerVisibleCost: number;
  actualCost: number;
  stdDev: number;
  confidenceInterval: [number, number];
  passAtK: number;
  passExpK: number;
  /** True if not all expected conversations completed (errors or cancellations) */
  partial: boolean;
}

export interface RegressionDetail {
  evaluatorId: string;
  personaId: string;
  scenarioId: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
}

// ── Pipeline Input ──────────────────────────────────────────────────

export interface EvalRunPipelineInput {
  tenantId: string;
  projectId: string;
  runId: string;
  evalSetId: string;
  personas: PersonaConfig[];
  scenarios: ScenarioConfig[];
  evaluators: EvaluatorConfig[];
  variants: number;
  maxConcurrency: number;
  baselineRunId?: string;
  regressionThreshold?: number;
  knownSource?: 'production' | 'eval' | 'synthetic';
  evalConversationTtlDays?: number;
  evalScoreTtlDays?: number;
  personaModel?: string;
  personaModelConfig?: PersonaSimulationConfig;
}

// ── ClickHouse Row Types ────────────────────────────────────────────

export interface EvalConversationRow {
  tenant_id: string;
  project_id: string;
  run_id: string;
  persona_id: string;
  scenario_id: string;
  variant_index: number;
  conversation: string; // JSON or gz: compressed
  trace_events: string;
  tool_calls: string;
  turn_count: number;
  duration_ms: number;
  token_usage: number;
  estimated_cost: number;
  /** Cost of customer-visible LLM calls only (dollars) */
  customer_visible_cost: number;
  /** JSON-encoded Record<string, number> — cost per model ID */
  cost_by_model: string;
  milestones_hit: string[];
  actual_agent_path: string[];
  tool_call_count: number;
  known_source: 'production' | 'eval' | 'synthetic';
  ttl_override_days: number;
  has_error: number; // UInt8
  error_message: string;
  persona_version: number;
  scenario_version: number;
  created_at: string; // ISO DateTime
}

export interface EvalScoreRow {
  tenant_id: string;
  project_id: string;
  run_id: string;
  persona_id: string;
  scenario_id: string;
  variant_index: number;
  evaluator_id: string;
  score: number;
  passed: number; // UInt8
  reasoning: string;
  evidence: string;
  confidence: number;
  score_original: number;
  score_swapped: number;
  was_position_swapped: number; // UInt8
  milestone_completion_rate: number;
  handoff_correctness_rate: number;
  path_efficiency_score: number;
  known_source: 'production' | 'eval' | 'synthetic';
  ttl_override_days: number;
  needs_human_review: number; // UInt8
  human_score: number | null;
  human_reviewed_at: string | null;
  judge_tokens_used: number;
  judge_cost: number;
  judge_latency_ms: number;
  evaluator_version: number;
  created_at: string;
}

// ── Eval Cell (matrix position) ─────────────────────────────────────

export interface EvalCell {
  personaId: string;
  scenarioId: string;
  variantIndex: number;
}

// ── Constants ───────────────────────────────────────────────────────

/** Persona message sentinel indicating conversation is complete. */
export const PERSONA_END_SIGNAL = '__END__';

/** Prefix for eval session IDs to distinguish from production. */
export const EVAL_SESSION_PREFIX = 'eval-';

/** ClickHouse database name. */
export const CH_DATABASE = 'abl_platform';

/** Default runtime API URL for agent execution. */
export const DEFAULT_RUNTIME_URL = process.env['RUNTIME_URL'] ?? 'http://localhost:3112';

/**
 * Format a Date as a ClickHouse DateTime64(3)-compatible string in **UTC**:
 * `YYYY-MM-DD HH:MM:SS.mmm`.
 *
 * Built from `Date.toISOString()`, which is always UTC — the returned wall
 * time will therefore be interpreted by ClickHouse as a UTC timestamp,
 * regardless of the column's declared timezone. Callers must not pass a
 * locale-shifted Date expecting the output to follow that locale.
 */
export function toCHDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}
