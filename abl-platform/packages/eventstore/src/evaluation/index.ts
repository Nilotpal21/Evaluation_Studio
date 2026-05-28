/**
 * Evaluation Pipeline
 *
 * Async evaluation system for scoring conversation quality.
 * Supports LLM-as-judge, code-based scorers, and composite evaluators.
 *
 * Usage:
 *   import { EvaluationDispatcher, LLMJudgeEvaluator, CodeScorerEvaluator } from '@abl/eventstore';
 */

// Interfaces & types
export type {
  IEvaluator,
  IEvaluationDispatcher,
  IEvaluationConfigProvider,
  IConversationProvider,
  EvaluationInput,
  EvaluationOutput,
  EvaluationScore,
  EvaluatorConfig,
  ProjectEvaluationConfig,
  SamplingConfig,
  DispatcherStats,
} from './interfaces.js';

// Dispatcher
export {
  EvaluationDispatcher,
  type EvaluationDispatcherConfig,
  type IPollTargetProvider,
} from './evaluation-dispatcher.js';

// Evaluator implementations
export {
  LLMJudgeEvaluator,
  DEFAULT_QUALITY_CRITERIA,
  type LLMJudgeConfig,
  type LLMCompletionFn,
  type EvaluationCriterion,
  CodeScorerEvaluator,
  BUILT_IN_SCORERS,
  turnEfficiencyScorer,
  repetitionScorer,
  errorOutcomeScorer,
  toolSuccessScorer,
  containmentScorer,
  type CodeScorerConfig,
  type ScoringFunction,
} from './evaluators/index.js';
