/**
 * Evaluation Pipeline Interfaces
 *
 * Defines contracts for the async evaluation system:
 * - IEvaluator: Produces scores/labels from conversation data
 * - IEvaluationDispatcher: Subscribes to events and fans out to evaluators
 * - Config types for evaluation criteria, sampling, and routing
 */

import type { PlatformEvent } from '../schema/platform-event.js';

// =============================================================================
// EVALUATOR INTERFACE
// =============================================================================

/** Input provided to every evaluator */
export interface EvaluationInput {
  /** Session that triggered this evaluation */
  sessionId: string;
  tenantId: string;
  projectId: string;
  /** Session purpose/source tag used for analytics isolation */
  knownSource?: 'production' | 'eval' | 'synthetic';
  /** Agent that handled the session */
  agentName?: string;
  /** Conversation messages (user + agent turns) */
  messages: Array<{
    role: 'user' | 'agent' | 'system' | 'tool';
    content: string;
    timestamp?: Date;
  }>;
  /** Trace events from the session (agent enter/exit, tool calls, decisions) */
  traceEvents: PlatformEvent[];
  /** Session-level metadata (duration, turns, cost, etc.) */
  sessionMetadata: {
    totalDurationMs: number;
    totalTurns: number;
    totalLLMCalls: number;
    totalToolCalls: number;
    totalTokens?: number;
    estimatedCost?: number;
    endReason: string;
  };
}

/** A single score produced by an evaluator */
export interface EvaluationScore {
  name: string;
  value: number | string | boolean;
  /** Human-readable reasoning for the score */
  reasoning?: string;
  /** Confidence in the score (0-1), applicable to AI evaluators */
  confidence?: number;
}

/** Output from an evaluator run */
export interface EvaluationOutput {
  evaluatorName: string;
  evaluatorType: 'llm_judge' | 'code_scorer' | 'ml_model' | 'composite';
  scores: EvaluationScore[];
  /** Composite score if multiple dimensions are evaluated */
  compositeScore?: number;
  /** LLM model used (for AI evaluators) */
  modelUsed?: string;
  /** Tokens consumed (for AI evaluators) */
  tokensUsed?: number;
  /** Cost of this evaluation */
  estimatedCost?: number;
  /** Time taken to evaluate */
  latencyMs: number;
}

/**
 * An evaluator that scores conversations.
 * Implementations may use LLM-as-judge, code-based scorers, ML models, etc.
 */
export interface IEvaluator {
  /** Unique name for this evaluator */
  readonly name: string;
  /** Type of evaluator */
  readonly type: 'llm_judge' | 'code_scorer' | 'ml_model' | 'composite';
  /**
   * Run evaluation on the given input.
   * Should not throw — return structured errors via EvaluationOutput.
   */
  evaluate(input: EvaluationInput): Promise<EvaluationOutput>;
}

// =============================================================================
// DISPATCHER CONFIGURATION
// =============================================================================

/** Sampling strategy for when to run evaluations */
export interface SamplingConfig {
  /** Sampling rate: 0-1 (0 = never, 1 = always) */
  rate: number;
  /** Strategy for selecting which sessions to evaluate */
  strategy: 'random' | 'all' | 'stratified' | 'anomaly_triggered';
  /** For stratified: field to stratify on */
  stratifyBy?: string;
}

/** Configuration for a single evaluator within a project */
export interface EvaluatorConfig {
  /** Name matching an IEvaluator.name */
  evaluatorName: string;
  /** Whether this evaluator is active */
  enabled: boolean;
  /** Sampling config (defaults to rate=1, strategy='all') */
  sampling?: SamplingConfig;
  /** Event types that trigger this evaluator (default: ['session.ended']) */
  triggerEvents?: string[];
  /** Custom configuration passed to the evaluator */
  config?: Record<string, unknown>;
}

/** Per-project evaluation configuration */
export interface ProjectEvaluationConfig {
  tenantId: string;
  projectId: string;
  /** List of evaluators configured for this project */
  evaluators: EvaluatorConfig[];
  /** Global sampling override (applied before per-evaluator sampling) */
  globalSampling?: SamplingConfig;
  /** Maximum concurrent evaluations */
  maxConcurrency?: number;
  /** Budget cap: max evaluations per day */
  dailyBudgetCap?: number;
}

// =============================================================================
// DISPATCHER INTERFACE
// =============================================================================

/** Statistics from the dispatcher */
export interface DispatcherStats {
  evaluationsStarted: number;
  evaluationsCompleted: number;
  evaluationsFailed: number;
  evaluationsSkipped: number;
}

/**
 * Provider for project evaluation configurations.
 * The runtime registers a concrete implementation (e.g., MongoDB-backed).
 */
export interface IEvaluationConfigProvider {
  getConfig(tenantId: string, projectId: string): Promise<ProjectEvaluationConfig | null>;
}

/**
 * Provider for conversation data needed by evaluators.
 * The runtime registers a concrete implementation (e.g., from message store).
 */
export interface IConversationProvider {
  getMessages(tenantId: string, sessionId: string): Promise<EvaluationInput['messages']>;
}

/**
 * The evaluation dispatcher subscribes to session events,
 * determines which evaluators to run, and fans out evaluations.
 */
export interface IEvaluationDispatcher {
  /** Register an evaluator implementation */
  registerEvaluator(evaluator: IEvaluator): void;
  /** Start processing events */
  start(): Promise<void>;
  /** Stop processing (graceful shutdown) */
  stop(): Promise<void>;
  /** Get dispatcher statistics */
  getStats(): DispatcherStats;
}
