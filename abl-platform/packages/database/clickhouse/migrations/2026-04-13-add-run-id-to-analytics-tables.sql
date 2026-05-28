-- ABLP-280 — Add run_id + pipeline_id columns to analytics tables
-- so Studio Data tab and Run Detail drawer can link rows to runs.
--
-- Note: Tables live in the abl_platform database. Some tables already have
-- pipeline_id / pipeline_type columns added by their compute services;
-- ADD COLUMN IF NOT EXISTS is a no-op for those.
--
-- DEFAULT '' ensures backward compatibility with rows already written
-- without these fields.

-- ── message_sentiment ──────────────────────────────────────────────
ALTER TABLE abl_platform.message_sentiment
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.message_sentiment
  ADD INDEX IF NOT EXISTS idx_message_sentiment_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.message_sentiment
  ADD INDEX IF NOT EXISTS idx_message_sentiment_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── conversation_sentiment ─────────────────────────────────────────
ALTER TABLE abl_platform.conversation_sentiment
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.conversation_sentiment
  ADD INDEX IF NOT EXISTS idx_conversation_sentiment_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.conversation_sentiment
  ADD INDEX IF NOT EXISTS idx_conversation_sentiment_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── intent_classifications ─────────────────────────────────────────
ALTER TABLE abl_platform.intent_classifications
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.intent_classifications
  ADD INDEX IF NOT EXISTS idx_intent_classifications_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.intent_classifications
  ADD INDEX IF NOT EXISTS idx_intent_classifications_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── quality_evaluations ────────────────────────────────────────────
ALTER TABLE abl_platform.quality_evaluations
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.quality_evaluations
  ADD INDEX IF NOT EXISTS idx_quality_evaluations_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.quality_evaluations
  ADD INDEX IF NOT EXISTS idx_quality_evaluations_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── conversation_outcomes ──────────────────────────────────────────
ALTER TABLE abl_platform.conversation_outcomes
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.conversation_outcomes
  ADD INDEX IF NOT EXISTS idx_conversation_outcomes_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.conversation_outcomes
  ADD INDEX IF NOT EXISTS idx_conversation_outcomes_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── goal_completions ───────────────────────────────────────────────
ALTER TABLE abl_platform.goal_completions
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.goal_completions
  ADD INDEX IF NOT EXISTS idx_goal_completions_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.goal_completions
  ADD INDEX IF NOT EXISTS idx_goal_completions_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── hallucination_evaluations ──────────────────────────────────────
ALTER TABLE abl_platform.hallucination_evaluations
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.hallucination_evaluations
  ADD INDEX IF NOT EXISTS idx_hallucination_evaluations_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.hallucination_evaluations
  ADD INDEX IF NOT EXISTS idx_hallucination_evaluations_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── knowledge_gap_evaluations ──────────────────────────────────────
ALTER TABLE abl_platform.knowledge_gap_evaluations
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.knowledge_gap_evaluations
  ADD INDEX IF NOT EXISTS idx_knowledge_gap_evaluations_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.knowledge_gap_evaluations
  ADD INDEX IF NOT EXISTS idx_knowledge_gap_evaluations_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── guardrail_evaluations ──────────────────────────────────────────
ALTER TABLE abl_platform.guardrail_evaluations
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.guardrail_evaluations
  ADD INDEX IF NOT EXISTS idx_guardrail_evaluations_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.guardrail_evaluations
  ADD INDEX IF NOT EXISTS idx_guardrail_evaluations_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── context_evaluations ────────────────────────────────────────────
ALTER TABLE abl_platform.context_evaluations
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.context_evaluations
  ADD INDEX IF NOT EXISTS idx_context_evaluations_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.context_evaluations
  ADD INDEX IF NOT EXISTS idx_context_evaluations_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── conversation_mentions ──────────────────────────────────────────
ALTER TABLE abl_platform.conversation_mentions
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.conversation_mentions
  ADD INDEX IF NOT EXISTS idx_conversation_mentions_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.conversation_mentions
  ADD INDEX IF NOT EXISTS idx_conversation_mentions_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── customer_predictive_features ───────────────────────────────────
ALTER TABLE abl_platform.customer_predictive_features
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.customer_predictive_features
  ADD INDEX IF NOT EXISTS idx_customer_predictive_features_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.customer_predictive_features
  ADD INDEX IF NOT EXISTS idx_customer_predictive_features_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── friction_detections ────────────────────────────────────────────
ALTER TABLE abl_platform.friction_detections
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.friction_detections
  ADD INDEX IF NOT EXISTS idx_friction_detections_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.friction_detections
  ADD INDEX IF NOT EXISTS idx_friction_detections_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── anomaly_detections ─────────────────────────────────────────────
ALTER TABLE abl_platform.anomaly_detections
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.anomaly_detections
  ADD INDEX IF NOT EXISTS idx_anomaly_detections_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.anomaly_detections
  ADD INDEX IF NOT EXISTS idx_anomaly_detections_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── drift_detections ───────────────────────────────────────────────
ALTER TABLE abl_platform.drift_detections
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.drift_detections
  ADD INDEX IF NOT EXISTS idx_drift_detections_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.drift_detections
  ADD INDEX IF NOT EXISTS idx_drift_detections_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── toxicity_evaluations ───────────────────────────────────────────
ALTER TABLE abl_platform.toxicity_evaluations
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.toxicity_evaluations
  ADD INDEX IF NOT EXISTS idx_toxicity_evaluations_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.toxicity_evaluations
  ADD INDEX IF NOT EXISTS idx_toxicity_evaluations_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── message_toxicity ───────────────────────────────────────────────
ALTER TABLE abl_platform.message_toxicity
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.message_toxicity
  ADD INDEX IF NOT EXISTS idx_message_toxicity_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.message_toxicity
  ADD INDEX IF NOT EXISTS idx_message_toxicity_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ── insight_results ────────────────────────────────────────────────
ALTER TABLE abl_platform.insight_results
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '';

ALTER TABLE abl_platform.insight_results
  ADD INDEX IF NOT EXISTS idx_insight_results_run_id run_id TYPE minmax GRANULARITY 1;

ALTER TABLE abl_platform.insight_results
  ADD INDEX IF NOT EXISTS idx_insight_results_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;
