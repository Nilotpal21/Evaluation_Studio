/**
 * Evaluation event schemas.
 *
 * Events related to async AI evaluation pipeline: evaluation runs, results, failures.
 * These events are emitted by the evaluation dispatcher and evaluator workers.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── evaluation.started ─────────────────────────────────────────────────────

export const EvaluationStartedDataSchema = z
  .object({
    evaluation_id: z.string().optional(),
    evaluationId: z.string().optional(),
    evaluator_type: z.enum(['llm_judge', 'code_scorer', 'ml_model', 'composite']).optional(),
    evaluatorType: z.enum(['llm_judge', 'code_scorer', 'ml_model', 'composite']).optional(),
    evaluator_name: z.string().optional(),
    evaluatorName: z.string().optional(),
    target_session_id: z.string().optional(),
    targetSessionId: z.string().optional(),
    sampling_strategy: z.enum(['all', 'stratified', 'random', 'anomaly_triggered']).optional(),
    samplingStrategy: z.enum(['all', 'stratified', 'random', 'anomaly_triggered']).optional(),
    criteria_count: z.number().optional(),
    criteriaCount: z.number().optional(),
  })
  .passthrough();

export type EvaluationStartedData = z.infer<typeof EvaluationStartedDataSchema>;

eventRegistry.register('evaluation.started', EvaluationStartedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: false,
  description: 'Async evaluation run started for a session',
});

// ─── evaluation.completed ───────────────────────────────────────────────────

export const EvaluationCompletedDataSchema = z
  .object({
    evaluation_id: z.string().optional(),
    evaluationId: z.string().optional(),
    evaluator_type: z.enum(['llm_judge', 'code_scorer', 'ml_model', 'composite']).optional(),
    evaluatorType: z.enum(['llm_judge', 'code_scorer', 'ml_model', 'composite']).optional(),
    evaluator_name: z.string().optional(),
    evaluatorName: z.string().optional(),
    target_session_id: z.string().optional(),
    targetSessionId: z.string().optional(),
    scores: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
    composite_score: z.number().optional(),
    compositeScore: z.number().optional(),
    reasoning: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    latency_ms: z.number().optional(),
    latencyMs: z.number().optional(),
    model_used: z.string().optional(),
    modelUsed: z.string().optional(),
    tokens_used: z.number().optional(),
    tokensUsed: z.number().optional(),
    estimated_cost: z.number().optional(),
    estimatedCost: z.number().optional(),
  })
  .passthrough();

export type EvaluationCompletedData = z.infer<typeof EvaluationCompletedDataSchema>;

eventRegistry.register('evaluation.completed', EvaluationCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: true,
  description: 'Async evaluation completed with scores',
});

// ─── evaluation.failed ──────────────────────────────────────────────────────

export const EvaluationFailedDataSchema = z
  .object({
    evaluation_id: z.string().optional(),
    evaluationId: z.string().optional(),
    evaluator_type: z.enum(['llm_judge', 'code_scorer', 'ml_model', 'composite']).optional(),
    evaluatorType: z.enum(['llm_judge', 'code_scorer', 'ml_model', 'composite']).optional(),
    evaluator_name: z.string().optional(),
    evaluatorName: z.string().optional(),
    target_session_id: z.string().optional(),
    targetSessionId: z.string().optional(),
    error_type: z.string().optional(),
    errorType: z.string().optional(),
    error_message: z.string().optional(),
    errorMessage: z.string().optional(),
    latency_ms: z.number().optional(),
    latencyMs: z.number().optional(),
    retry_attempt: z.number().optional(),
    retryAttempt: z.number().optional(),
  })
  .passthrough();

export type EvaluationFailedData = z.infer<typeof EvaluationFailedDataSchema>;

eventRegistry.register('evaluation.failed', EvaluationFailedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: true,
  description: 'Async evaluation failed',
});

// ─── evaluation.batch.completed ─────────────────────────────────────────────

export const EvaluationBatchCompletedDataSchema = z
  .object({
    batch_id: z.string().optional(),
    batchId: z.string().optional(),
    total_evaluations: z.number().optional(),
    totalEvaluations: z.number().optional(),
    succeeded: z.number().optional(),
    failed: z.number().optional(),
    skipped: z.number().optional(),
    total_duration_ms: z.number().optional(),
    totalDurationMs: z.number().optional(),
    total_cost: z.number().optional(),
    totalCost: z.number().optional(),
    evaluator_names: z.array(z.string()).optional(),
    evaluatorNames: z.array(z.string()).optional(),
  })
  .passthrough();

export type EvaluationBatchCompletedData = z.infer<typeof EvaluationBatchCompletedDataSchema>;

eventRegistry.register('evaluation.batch.completed', EvaluationBatchCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: false,
  description: 'Batch of evaluations completed',
});

// ─── evaluation.threshold.violated ──────────────────────────────────────────

export const EvaluationThresholdViolatedDataSchema = z
  .object({
    evaluator_name: z.string().optional(),
    evaluatorName: z.string().optional(),
    metric_name: z.string().optional(),
    metricName: z.string().optional(),
    threshold: z.number().optional(),
    actual_value: z.number().optional(),
    actualValue: z.number().optional(),
    direction: z.enum(['above', 'below']).optional(),
    severity: z.enum(['warning', 'critical']).optional(),
    window_minutes: z.number().optional(),
    windowMinutes: z.number().optional(),
    sample_size: z.number().optional(),
    sampleSize: z.number().optional(),
  })
  .passthrough();

export type EvaluationThresholdViolatedData = z.infer<typeof EvaluationThresholdViolatedDataSchema>;

eventRegistry.register('evaluation.threshold.violated', EvaluationThresholdViolatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: false,
  description: 'Evaluation metric crossed alert threshold',
});

// ─── evaluation.quality.scored ──────────────────────────────────────────────

export const EvaluationQualityScoredDataSchema = z
  .object({
    evaluation_id: z.string().optional(),
    evaluationId: z.string().optional(),
    target_session_id: z.string().optional(),
    targetSessionId: z.string().optional(),
    resolution_quality: z.number().min(1).max(5).optional(),
    resolutionQuality: z.number().min(1).max(5).optional(),
    response_accuracy: z.number().min(1).max(5).optional(),
    responseAccuracy: z.number().min(1).max(5).optional(),
    helpfulness: z.number().min(1).max(5).optional(),
    coherence: z.number().min(1).max(5).optional(),
    professionalism: z.number().min(1).max(5).optional(),
    safety: z.enum(['pass', 'fail']).optional(),
    pii_handling: z.enum(['pass', 'fail']).optional(),
    piiHandling: z.enum(['pass', 'fail']).optional(),
    composite_cx_score: z.number().min(1).max(5).optional(),
    compositeCxScore: z.number().min(1).max(5).optional(),
    reasoning: z.string().optional(),
    model_used: z.string().optional(),
    modelUsed: z.string().optional(),
  })
  .passthrough();

export type EvaluationQualityScoredData = z.infer<typeof EvaluationQualityScoredDataSchema>;

eventRegistry.register('evaluation.quality.scored', EvaluationQualityScoredDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: true,
  description: 'Conversation quality evaluation scored (Tier 3 composite CX)',
});

// ─── evaluation.sentiment.analyzed ──────────────────────────────────────────

export const EvaluationSentimentAnalyzedDataSchema = z
  .object({
    evaluation_id: z.string().optional(),
    evaluationId: z.string().optional(),
    target_session_id: z.string().optional(),
    targetSessionId: z.string().optional(),
    overall_sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
    overallSentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
    sentiment_score: z.number().min(-1).max(1).optional(),
    sentimentScore: z.number().min(-1).max(1).optional(),
    trajectory: z.enum(['improving', 'stable', 'declining']).optional(),
    frustration_detected: z.boolean().optional(),
    frustrationDetected: z.boolean().optional(),
    pivot_turn: z.number().optional(),
    pivotTurn: z.number().optional(),
    turn_scores: z
      .array(
        z
          .object({
            turn: z.number(),
            role: z.enum(['user', 'agent']),
            score: z.number().min(-1).max(1),
          })
          .passthrough(),
      )
      .optional(),
    turnScores: z
      .array(
        z
          .object({
            turn: z.number(),
            role: z.enum(['user', 'agent']),
            score: z.number().min(-1).max(1),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type EvaluationSentimentAnalyzedData = z.infer<typeof EvaluationSentimentAnalyzedDataSchema>;

eventRegistry.register('evaluation.sentiment.analyzed', EvaluationSentimentAnalyzedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: false,
  description: 'Sentiment analysis completed for a session',
});

// ─── evaluation.summary.generated ───────────────────────────────────────────

export const EvaluationSummaryGeneratedDataSchema = z
  .object({
    evaluation_id: z.string().optional(),
    evaluationId: z.string().optional(),
    target_session_id: z.string().optional(),
    targetSessionId: z.string().optional(),
    executive_summary: z.string().optional(),
    executiveSummary: z.string().optional(),
    key_topics: z.array(z.string()).optional(),
    keyTopics: z.array(z.string()).optional(),
    actions_taken: z.array(z.string()).optional(),
    actionsTaken: z.array(z.string()).optional(),
    outcome: z.string().optional(),
    next_steps: z.array(z.string()).optional(),
    nextSteps: z.array(z.string()).optional(),
    risk_flags: z.array(z.string()).optional(),
    riskFlags: z.array(z.string()).optional(),
    model_used: z.string().optional(),
    modelUsed: z.string().optional(),
    tokens_used: z.number().optional(),
    tokensUsed: z.number().optional(),
  })
  .passthrough();

export type EvaluationSummaryGeneratedData = z.infer<typeof EvaluationSummaryGeneratedDataSchema>;

eventRegistry.register('evaluation.summary.generated', EvaluationSummaryGeneratedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.EVALUATION,
  containsPII: true, // Summaries may contain PII from conversation content
  description: 'Conversation summary generated',
});
