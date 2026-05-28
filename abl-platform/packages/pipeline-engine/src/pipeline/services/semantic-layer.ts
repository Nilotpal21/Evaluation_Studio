/**
 * Semantic Layer — JSON schema describing all ClickHouse analytics tables
 * with human-readable metadata. Used as context for the LLM when generating
 * SQL from natural language questions.
 *
 * Tables sourced from: @agent-platform/database/clickhouse-schemas/tables/analytics
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('semantic-layer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnDescription {
  name: string;
  type: string;
  description: string;
  examples?: string[];
}

export interface TableDescription {
  table: string;
  description: string;
  columns: ColumnDescription[];
  commonQueries?: string[];
}

// ---------------------------------------------------------------------------
// Semantic Layer Definition
// ---------------------------------------------------------------------------

export const SEMANTIC_LAYER: TableDescription[] = [
  // =========================================================================
  // Base analytics tables
  // =========================================================================
  {
    table: 'abl_platform.message_sentiment',
    description: 'Per-message sentiment analysis results with frustration detection',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      { name: 'message_id', type: 'String', description: 'Unique message identifier' },
      { name: 'message_at', type: 'DateTime64(3)', description: 'When the message was sent' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the message was processed by the pipeline',
      },
      {
        name: 'role',
        type: 'LowCardinality(String)',
        description: 'Message author role (user, assistant, system)',
        examples: ['user', 'assistant'],
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent that handled the message',
      },
      {
        name: 'channel',
        type: 'LowCardinality(String)',
        description: 'Communication channel',
        examples: ['web', 'voice', 'chat'],
      },
      {
        name: 'sentiment_score',
        type: 'Float32',
        description: 'Sentiment score for this message (0-1, higher = more positive)',
      },
      {
        name: 'sentiment_label',
        type: 'LowCardinality(String)',
        description: 'Categorical sentiment label',
        examples: ['positive', 'neutral', 'negative'],
      },
      {
        name: 'frustration_detected',
        type: 'UInt8',
        description: 'Whether frustration was detected (0 or 1)',
      },
      {
        name: 'frustration_signals',
        type: 'Array(String)',
        description: 'List of frustration signals detected in the message',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for analysis',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      {
        name: 'confidence',
        type: 'Float32',
        description: 'Confidence score of the analysis (0-1)',
      },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(sentiment_score) FROM abl_platform.message_sentiment WHERE tenant_id = ? AND session_id = ?',
      'SELECT count() FROM abl_platform.message_sentiment WHERE tenant_id = ? AND frustration_detected = 1',
    ],
  },
  {
    table: 'abl_platform.conversation_sentiment',
    description:
      'Per-session aggregated sentiment analysis with trajectory and frustration metrics',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the conversation was processed',
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent that handled the conversation',
      },
      {
        name: 'channel',
        type: 'LowCardinality(String)',
        description: 'Communication channel',
        examples: ['web', 'voice', 'chat'],
      },
      {
        name: 'avg_sentiment',
        type: 'Float32',
        description: 'Average sentiment across all messages (0-1)',
      },
      {
        name: 'start_sentiment',
        type: 'Float32',
        description: 'Sentiment score of the first message (0-1)',
      },
      {
        name: 'end_sentiment',
        type: 'Float32',
        description: 'Sentiment score of the last message (0-1)',
      },
      {
        name: 'min_sentiment',
        type: 'Float32',
        description: 'Minimum sentiment score in the conversation (0-1)',
      },
      {
        name: 'max_sentiment',
        type: 'Float32',
        description: 'Maximum sentiment score in the conversation (0-1)',
      },
      {
        name: 'sentiment_trajectory',
        type: 'LowCardinality(String)',
        description: 'Overall sentiment direction',
        examples: ['improving', 'declining', 'stable', 'volatile'],
      },
      {
        name: 'sentiment_shift_count',
        type: 'UInt16',
        description: 'Number of significant sentiment changes during the conversation',
      },
      {
        name: 'frustration_turn_count',
        type: 'UInt16',
        description: 'Number of turns where frustration was detected',
      },
      {
        name: 'frustration_detected',
        type: 'UInt8',
        description: 'Whether frustration was detected at any point (0 or 1)',
      },
      { name: 'pivot_count', type: 'UInt16', description: 'Number of sentiment pivot points' },
      {
        name: 'worst_pivot_at',
        type: 'Nullable(DateTime64(3))',
        description: 'Timestamp of the worst sentiment pivot',
      },
      {
        name: 'worst_pivot_delta',
        type: 'Nullable(Float32)',
        description: 'Magnitude of the worst sentiment drop',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for analysis',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      {
        name: 'message_count',
        type: 'UInt16',
        description: 'Total number of messages in the conversation',
      },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(avg_sentiment) FROM abl_platform.conversation_sentiment WHERE tenant_id = ? AND project_id = ?',
      "SELECT count() FROM abl_platform.conversation_sentiment WHERE tenant_id = ? AND project_id = ? AND sentiment_trajectory = 'declining'",
    ],
  },
  {
    table: 'abl_platform.intent_classifications',
    description:
      'Per-session intent classification results with primary/secondary intents and confidence',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the classification was processed',
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent that handled the conversation',
      },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      {
        name: 'intent',
        type: 'LowCardinality(String)',
        description: 'Primary detected intent category',
        examples: ['billing_inquiry', 'technical_support', 'cancellation'],
      },
      {
        name: 'intent_display',
        type: 'String',
        description: 'Human-readable display name for the intent',
      },
      {
        name: 'sub_intent',
        type: 'LowCardinality(String)',
        description: 'More specific sub-intent within the primary category',
      },
      {
        name: 'confidence',
        type: 'Float32',
        description: 'Confidence score for the primary intent (0-1)',
      },
      {
        name: 'secondary_intents',
        type: 'Array(String)',
        description: 'List of secondary intents detected',
      },
      {
        name: 'is_auto_discovered',
        type: 'UInt8',
        description: 'Whether the intent was auto-discovered (1) or from taxonomy (0)',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for classification',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      {
        name: 'taxonomy_version',
        type: 'LowCardinality(String)',
        description: 'Version of the intent taxonomy used',
      },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
      { name: 'input_tokens', type: 'UInt32', description: 'Number of input tokens consumed' },
      { name: 'output_tokens', type: 'UInt32', description: 'Number of output tokens generated' },
    ],
    commonQueries: [
      'SELECT intent, count() AS cnt FROM abl_platform.intent_classifications WHERE tenant_id = ? AND project_id = ? GROUP BY intent ORDER BY cnt DESC',
    ],
  },
  {
    table: 'abl_platform.quality_evaluations',
    description: 'Per-session conversation quality evaluation with multi-dimensional scores',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the evaluation was processed',
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent evaluated',
      },
      {
        name: 'agent_version',
        type: 'LowCardinality(String)',
        description: 'Version of the agent',
      },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      { name: 'overall_score', type: 'Float32', description: 'Overall quality score (0-1)' },
      { name: 'helpfulness', type: 'Float32', description: 'Helpfulness dimension score (0-1)' },
      { name: 'accuracy', type: 'Float32', description: 'Accuracy dimension score (0-1)' },
      {
        name: 'professionalism',
        type: 'Float32',
        description: 'Professionalism dimension score (0-1)',
      },
      {
        name: 'instruction_following',
        type: 'Float32',
        description: 'Instruction following dimension score (0-1)',
      },
      {
        name: 'custom_dimensions',
        type: 'String',
        description: 'JSON string of custom evaluation dimensions and their scores',
      },
      {
        name: 'flagged',
        type: 'UInt8',
        description: 'Whether the conversation was flagged for review (0 or 1)',
      },
      {
        name: 'flag_reasons',
        type: 'Array(String)',
        description: 'Reasons the conversation was flagged',
      },
      {
        name: 'reasoning',
        type: 'String',
        description: 'LLM reasoning behind the evaluation scores',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for evaluation',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      {
        name: 'pipeline_version',
        type: 'LowCardinality(String)',
        description: 'Version of the quality evaluation pipeline',
      },
      {
        name: 'confidence',
        type: 'Float32',
        description: 'Confidence score of the evaluation (0-1)',
      },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
      { name: 'input_tokens', type: 'UInt32', description: 'Number of input tokens consumed' },
      { name: 'output_tokens', type: 'UInt32', description: 'Number of output tokens generated' },
    ],
    commonQueries: [
      'SELECT avg(overall_score), avg(helpfulness), avg(accuracy) FROM abl_platform.quality_evaluations WHERE tenant_id = ? AND project_id = ?',
      'SELECT count() FROM abl_platform.quality_evaluations WHERE tenant_id = ? AND project_id = ? AND flagged = 1',
    ],
  },

  // =========================================================================
  // Phase 1: Custom events, tags, external events
  // =========================================================================
  {
    table: 'abl_platform.custom_events',
    description: 'User-defined custom events associated with conversation sessions',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'event_name',
        type: 'String',
        description: 'Name of the custom event',
        examples: ['purchase_completed', 'escalation_requested', 'feedback_submitted'],
      },
      { name: 'properties', type: 'String', description: 'JSON string of event properties' },
      { name: 'timestamp', type: 'DateTime64(3)', description: 'When the event occurred' },
      {
        name: 'inserted_at',
        type: 'DateTime64(3)',
        description: 'When the event was inserted into the database',
      },
    ],
    commonQueries: [
      'SELECT event_name, count() AS cnt FROM abl_platform.custom_events WHERE tenant_id = ? AND project_id = ? GROUP BY event_name ORDER BY cnt DESC',
    ],
  },
  {
    table: 'abl_platform.conversation_tags',
    description: 'Tags applied to conversation sessions by rules or manually',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'tag_name',
        type: 'String',
        description: 'Name of the tag applied',
        examples: ['vip', 'escalated', 'resolved', 'needs_review'],
      },
      { name: 'applied_at', type: 'DateTime64(3)', description: 'When the tag was applied' },
      {
        name: 'applied_by',
        type: 'String',
        description: 'Who or what applied the tag (user ID or system rule)',
      },
      {
        name: 'rule_id',
        type: 'String',
        description: 'ID of the rule that triggered the tag (empty if manually applied)',
      },
    ],
    commonQueries: [
      'SELECT tag_name, count() AS cnt FROM abl_platform.conversation_tags WHERE tenant_id = ? AND project_id = ? GROUP BY tag_name ORDER BY cnt DESC',
    ],
  },
  {
    table: 'abl_platform.external_events',
    description:
      'External system events (deployments, incidents, campaigns) for correlation with analytics',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      {
        name: 'event_type',
        type: 'LowCardinality(String)',
        description: 'Type of external event',
        examples: ['deployment', 'incident', 'campaign', 'maintenance'],
      },
      { name: 'event_id', type: 'String', description: 'Unique identifier for the external event' },
      { name: 'title', type: 'String', description: 'Event title or summary' },
      { name: 'description', type: 'String', description: 'Detailed event description' },
      {
        name: 'properties',
        type: 'String',
        description: 'JSON string of event-specific properties',
      },
      { name: 'timestamp', type: 'DateTime64(3)', description: 'When the event occurred' },
      {
        name: 'duration_minutes',
        type: 'Nullable(UInt32)',
        description: 'Duration of the event in minutes (null if instantaneous)',
      },
      {
        name: 'severity',
        type: 'Nullable(String)',
        description: 'Severity level of the event',
        examples: ['low', 'medium', 'high', 'critical'],
      },
      {
        name: 'inserted_at',
        type: 'DateTime64(3)',
        description: 'When the event was inserted into the database',
      },
    ],
    commonQueries: [
      'SELECT event_type, count() AS cnt FROM abl_platform.external_events WHERE tenant_id = ? AND project_id = ? GROUP BY event_type',
    ],
  },

  // =========================================================================
  // LLM evaluation tables
  // =========================================================================
  {
    table: 'abl_platform.hallucination_evaluations',
    description:
      'Per-session hallucination detection results with faithfulness scores and claim analysis',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent evaluated',
      },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the evaluation was processed',
      },
      {
        name: 'evaluation_type',
        type: 'LowCardinality(String)',
        description: 'Type of hallucination evaluation',
      },
      {
        name: 'overall_score',
        type: 'Float64',
        description: 'Overall hallucination score (0-1, higher = less hallucination)',
      },
      {
        name: 'faithfulness_score',
        type: 'Float64',
        description: 'Faithfulness to source material (0-1)',
      },
      {
        name: 'claims',
        type: 'Array(String)',
        description: 'Claims extracted from the agent responses',
      },
      {
        name: 'unsupported_claims',
        type: 'Array(String)',
        description: 'Claims not supported by source material',
      },
      {
        name: 'consistency_index',
        type: 'Float64',
        description: 'Internal consistency of agent responses (0-1)',
      },
      {
        name: 'contradiction_detected',
        type: 'UInt8',
        description: 'Whether a contradiction was detected (0 or 1)',
      },
      {
        name: 'flagged',
        type: 'UInt8',
        description: 'Whether the conversation was flagged for hallucination review (0 or 1)',
      },
      { name: 'flag_reasons', type: 'Array(String)', description: 'Reasons for flagging' },
      {
        name: 'confidence',
        type: 'Float64',
        description: 'Confidence score of the evaluation (0-1)',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for evaluation',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      { name: 'input_tokens', type: 'UInt32', description: 'Number of input tokens consumed' },
      { name: 'output_tokens', type: 'UInt32', description: 'Number of output tokens generated' },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(overall_score), avg(faithfulness_score) FROM abl_platform.hallucination_evaluations WHERE tenant_id = ? AND project_id = ?',
      'SELECT count() FROM abl_platform.hallucination_evaluations WHERE tenant_id = ? AND project_id = ? AND flagged = 1',
    ],
  },
  {
    table: 'abl_platform.knowledge_gap_evaluations',
    description:
      'Per-session knowledge gap detection with retrieval precision and citation analysis',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent evaluated',
      },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the evaluation was processed',
      },
      {
        name: 'evaluation_type',
        type: 'LowCardinality(String)',
        description: 'Type of knowledge gap evaluation',
      },
      {
        name: 'overall_score',
        type: 'Float64',
        description: 'Overall knowledge coverage score (0-1, higher = better coverage)',
      },
      {
        name: 'retrieval_precision',
        type: 'Float64',
        description: 'Precision of knowledge retrieval (0-1)',
      },
      {
        name: 'citation_rate',
        type: 'Float64',
        description: 'Rate of proper citation usage (0-1)',
      },
      {
        name: 'gap_detected',
        type: 'UInt8',
        description: 'Whether a knowledge gap was detected (0 or 1)',
      },
      {
        name: 'gap_topics',
        type: 'Array(String)',
        description: 'Topics where knowledge gaps were identified',
      },
      {
        name: 'unused_articles',
        type: 'Array(String)',
        description: 'Retrieved articles that were not used in responses',
      },
      {
        name: 'article_ids_cited',
        type: 'Array(String)',
        description: 'IDs of articles that were cited in responses',
      },
      {
        name: 'flagged',
        type: 'UInt8',
        description: 'Whether the conversation was flagged for knowledge gap review (0 or 1)',
      },
      { name: 'flag_reasons', type: 'Array(String)', description: 'Reasons for flagging' },
      {
        name: 'confidence',
        type: 'Float64',
        description: 'Confidence score of the evaluation (0-1)',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for evaluation',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      { name: 'input_tokens', type: 'UInt32', description: 'Number of input tokens consumed' },
      { name: 'output_tokens', type: 'UInt32', description: 'Number of output tokens generated' },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(overall_score), avg(retrieval_precision) FROM abl_platform.knowledge_gap_evaluations WHERE tenant_id = ? AND project_id = ?',
      'SELECT count() FROM abl_platform.knowledge_gap_evaluations WHERE tenant_id = ? AND project_id = ? AND gap_detected = 1',
    ],
  },
  {
    table: 'abl_platform.guardrail_evaluations',
    description:
      'Per-session guardrail evaluation results with bypass detection and violation analysis',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent evaluated',
      },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the evaluation was processed',
      },
      {
        name: 'evaluation_type',
        type: 'LowCardinality(String)',
        description: 'Type of guardrail evaluation',
      },
      {
        name: 'overall_score',
        type: 'Float64',
        description: 'Overall guardrail compliance score (0-1, higher = better compliance)',
      },
      {
        name: 'false_positive_score',
        type: 'Float64',
        description: 'Rate of false positive guardrail triggers (0-1)',
      },
      {
        name: 'false_negative_score',
        type: 'Float64',
        description: 'Rate of missed guardrail violations (0-1)',
      },
      {
        name: 'bypass_detected',
        type: 'UInt8',
        description: 'Whether a guardrail bypass was detected (0 or 1)',
      },
      {
        name: 'bypass_technique',
        type: 'String',
        description: 'Description of the bypass technique used (empty if none)',
      },
      {
        name: 'severity',
        type: 'LowCardinality(String)',
        description: 'Severity of the guardrail violation',
        examples: ['low', 'medium', 'high', 'critical'],
      },
      {
        name: 'violation_categories',
        type: 'Array(String)',
        description: 'Categories of guardrail violations detected',
      },
      {
        name: 'flagged',
        type: 'UInt8',
        description: 'Whether the conversation was flagged for guardrail review (0 or 1)',
      },
      { name: 'flag_reasons', type: 'Array(String)', description: 'Reasons for flagging' },
      {
        name: 'confidence',
        type: 'Float64',
        description: 'Confidence score of the evaluation (0-1)',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for evaluation',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      { name: 'input_tokens', type: 'UInt32', description: 'Number of input tokens consumed' },
      { name: 'output_tokens', type: 'UInt32', description: 'Number of output tokens generated' },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(overall_score) FROM abl_platform.guardrail_evaluations WHERE tenant_id = ? AND project_id = ?',
      'SELECT count() FROM abl_platform.guardrail_evaluations WHERE tenant_id = ? AND project_id = ? AND bypass_detected = 1',
    ],
  },
  {
    table: 'abl_platform.context_evaluations',
    description:
      'Per-session context management evaluation with lost context and duplication detection',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      {
        name: 'agent_name',
        type: 'LowCardinality(String)',
        description: 'Name of the agent evaluated',
      },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the evaluation was processed',
      },
      {
        name: 'evaluation_type',
        type: 'LowCardinality(String)',
        description: 'Type of context evaluation',
      },
      {
        name: 'overall_score',
        type: 'Float64',
        description: 'Overall context management score (0-1, higher = better context handling)',
      },
      { name: 'context_score', type: 'Float64', description: 'Context retention score (0-1)' },
      {
        name: 'lost_context_items',
        type: 'Array(String)',
        description: 'Context items that were lost during the conversation',
      },
      {
        name: 'duplication_detected',
        type: 'UInt8',
        description: 'Whether context duplication was detected (0 or 1)',
      },
      {
        name: 'duplication_count',
        type: 'UInt16',
        description: 'Number of duplicated context items',
      },
      {
        name: 'handoff_count',
        type: 'UInt16',
        description: 'Number of agent handoffs during the conversation',
      },
      {
        name: 'flagged',
        type: 'UInt8',
        description: 'Whether the conversation was flagged for context issues (0 or 1)',
      },
      { name: 'flag_reasons', type: 'Array(String)', description: 'Reasons for flagging' },
      {
        name: 'confidence',
        type: 'Float64',
        description: 'Confidence score of the evaluation (0-1)',
      },
      {
        name: 'model_id',
        type: 'LowCardinality(String)',
        description: 'LLM model used for evaluation',
      },
      { name: 'config_version', type: 'UInt32', description: 'Pipeline configuration version' },
      { name: 'input_tokens', type: 'UInt32', description: 'Number of input tokens consumed' },
      { name: 'output_tokens', type: 'UInt32', description: 'Number of output tokens generated' },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(overall_score), avg(context_score) FROM abl_platform.context_evaluations WHERE tenant_id = ? AND project_id = ?',
    ],
  },

  // =========================================================================
  // Statistical analysis tables
  // =========================================================================
  {
    table: 'abl_platform.friction_detections',
    description: 'Per-session friction detection results measuring user frustration signals',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'session_started_at',
        type: 'DateTime64(3)',
        description: 'When the conversation started',
      },
      { name: 'agent_name', type: 'LowCardinality(String)', description: 'Name of the agent' },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the detection was processed',
      },
      {
        name: 'friction_score',
        type: 'Float64',
        description: 'Overall friction score (0-1, higher = more friction)',
      },
      {
        name: 'rephrase_count',
        type: 'UInt16',
        description: 'Number of times the user rephrased their question',
      },
      {
        name: 'message_length_trend',
        type: 'Float64',
        description: 'Trend of message lengths (positive = increasing, negative = decreasing)',
      },
      {
        name: 'turn_count_zscore',
        type: 'Float64',
        description: 'Z-score of conversation turn count relative to historical average',
      },
      {
        name: 'caps_count',
        type: 'UInt16',
        description: 'Number of messages with excessive capitalization',
      },
      {
        name: 'exclamation_count',
        type: 'UInt16',
        description: 'Number of messages with exclamation marks',
      },
      {
        name: 'flagged',
        type: 'UInt8',
        description: 'Whether the conversation was flagged for high friction (0 or 1)',
      },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(friction_score) FROM abl_platform.friction_detections WHERE tenant_id = ? AND project_id = ?',
      'SELECT count() FROM abl_platform.friction_detections WHERE tenant_id = ? AND project_id = ? AND flagged = 1',
    ],
  },
  {
    table: 'abl_platform.anomaly_detections',
    description: 'Per-session anomaly detection results with statistical analysis metrics',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the detection was processed',
      },
      {
        name: 'anomaly_flag',
        type: 'UInt8',
        description: 'Whether an anomaly was detected (0 or 1)',
      },
      {
        name: 'severity',
        type: 'LowCardinality(String)',
        description: 'Severity of the anomaly',
        examples: ['low', 'medium', 'high'],
      },
      { name: 'z_score', type: 'Float64', description: 'Z-score of the anomalous metric' },
      {
        name: 'metric_name',
        type: 'String',
        description: 'Name of the metric that triggered the anomaly',
      },
      {
        name: 'metric_value',
        type: 'Float64',
        description: 'Actual value of the anomalous metric',
      },
      {
        name: 'expected_range_low',
        type: 'Float64',
        description: 'Lower bound of the expected range',
      },
      {
        name: 'expected_range_high',
        type: 'Float64',
        description: 'Upper bound of the expected range',
      },
      {
        name: 'contributing_factors',
        type: 'Array(String)',
        description: 'Factors contributing to the anomaly',
      },
      {
        name: 'spc_out_of_control',
        type: 'UInt16',
        description: 'Number of SPC (Statistical Process Control) rule violations',
      },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT count() FROM abl_platform.anomaly_detections WHERE tenant_id = ? AND project_id = ? AND anomaly_flag = 1',
      'SELECT metric_name, count() AS cnt FROM abl_platform.anomaly_detections WHERE tenant_id = ? AND project_id = ? AND anomaly_flag = 1 GROUP BY metric_name ORDER BY cnt DESC',
    ],
  },
  {
    table: 'abl_platform.drift_detections',
    description: 'Per-session metric drift detection comparing current values to baseline',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'processed_at',
        type: 'DateTime64(3)',
        description: 'When the detection was processed',
      },
      {
        name: 'drift_score',
        type: 'Float64',
        description: 'Drift magnitude score (0-1, higher = more drift)',
      },
      {
        name: 'drift_type',
        type: 'LowCardinality(String)',
        description: 'Type of drift detected',
        examples: ['gradual', 'sudden', 'seasonal'],
      },
      { name: 'baseline_mean', type: 'Float64', description: 'Historical baseline mean value' },
      { name: 'current_mean', type: 'Float64', description: 'Current period mean value' },
      {
        name: 'trend_slope',
        type: 'Float64',
        description: 'Linear regression slope of the metric over time',
      },
      {
        name: 'flagged',
        type: 'UInt8',
        description: 'Whether significant drift was flagged (0 or 1)',
      },
      { name: 'processing_ms', type: 'UInt32', description: 'Processing time in milliseconds' },
    ],
    commonQueries: [
      'SELECT avg(drift_score) FROM abl_platform.drift_detections WHERE tenant_id = ? AND project_id = ?',
      'SELECT count() FROM abl_platform.drift_detections WHERE tenant_id = ? AND project_id = ? AND flagged = 1',
    ],
  },

  // =========================================================================
  // Experiments
  // =========================================================================
  {
    table: 'abl_platform.experiment_assignments',
    description: 'A/B experiment session assignments with control and experiment groups',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'experiment_id', type: 'String', description: 'Unique experiment identifier' },
      {
        name: 'session_id',
        type: 'String',
        description: 'Conversation session ID assigned to the experiment',
      },
      {
        name: 'experiment_group',
        type: "Enum8('control'=0, 'experiment'=1)",
        description: 'Which group the session was assigned to',
        examples: ['control', 'experiment'],
      },
      {
        name: 'assigned_at',
        type: 'DateTime',
        description: 'When the session was assigned to the experiment',
      },
    ],
    commonQueries: [
      'SELECT experiment_group, count() AS cnt FROM abl_platform.experiment_assignments WHERE tenant_id = ? AND project_id = ? AND experiment_id = ? GROUP BY experiment_group',
    ],
  },

  // =========================================================================
  // Phase 4: Predictive features, churn risk, mentions
  // =========================================================================
  {
    table: 'abl_platform.customer_predictive_features',
    description: 'Aggregated predictive features per customer for churn and risk analysis',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'customer_id', type: 'String', description: 'Unique customer identifier' },
      {
        name: 'avg_sentiment',
        type: 'Float64',
        description: 'Average sentiment score across all customer conversations (0-1)',
      },
      {
        name: 'escalation_rate',
        type: 'Float64',
        description: 'Rate of escalated conversations (0-1)',
      },
      {
        name: 'repeat_contact_count',
        type: 'UInt32',
        description: 'Number of repeat contacts by this customer',
      },
      {
        name: 'quality_trend',
        type: 'Float64',
        description: 'Trend of quality scores over time (positive = improving)',
      },
      {
        name: 'churn_risk_score',
        type: 'Float64',
        description: 'Predicted churn risk score (0-1, higher = more at risk)',
      },
      {
        name: 'risk_level',
        type: "Enum8('low'=0, 'medium'=1, 'high'=2)",
        description: 'Categorical risk level',
        examples: ['low', 'medium', 'high'],
      },
      {
        name: 'processed_at',
        type: 'DateTime',
        description: 'When the features were last computed',
      },
    ],
    commonQueries: [
      "SELECT count() FROM abl_platform.customer_predictive_features WHERE tenant_id = ? AND project_id = ? AND risk_level = 'high'",
      'SELECT avg(churn_risk_score) FROM abl_platform.customer_predictive_features WHERE tenant_id = ? AND project_id = ?',
    ],
  },
  {
    table: 'abl_platform.churn_risk_scores',
    description: 'Per-customer churn risk scores with contributing factors',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'customer_id', type: 'String', description: 'Unique customer identifier' },
      {
        name: 'risk_score',
        type: 'Float64',
        description: 'Churn risk score (0-1, higher = more at risk)',
      },
      {
        name: 'risk_level',
        type: "Enum8('low'=0, 'medium'=1, 'high'=2)",
        description: 'Categorical risk level',
        examples: ['low', 'medium', 'high'],
      },
      {
        name: 'contributing_factors',
        type: 'Array(String)',
        description: 'Factors contributing to the churn risk',
      },
      { name: 'computed_at', type: 'DateTime', description: 'When the risk score was computed' },
    ],
    commonQueries: [
      'SELECT risk_level, count() AS cnt FROM abl_platform.churn_risk_scores WHERE tenant_id = ? AND project_id = ? GROUP BY risk_level',
    ],
  },
  {
    table: 'abl_platform.conversation_mentions',
    description:
      'Detected mentions of competitors, feature requests, bug reports, and channel switches in conversations',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'session_id', type: 'String', description: 'Conversation session ID' },
      {
        name: 'mention_type',
        type: "Enum8('competitor'=0, 'feature_request'=1, 'bug_report'=2, 'channel_switch'=3)",
        description: 'Type of mention detected',
        examples: ['competitor', 'feature_request', 'bug_report', 'channel_switch'],
      },
      { name: 'mention_text', type: 'String', description: 'The extracted mention text' },
      {
        name: 'confidence',
        type: 'Float64',
        description: 'Confidence score of the detection (0-1)',
      },
      { name: 'processed_at', type: 'DateTime', description: 'When the mention was detected' },
    ],
    commonQueries: [
      'SELECT mention_type, count() AS cnt FROM abl_platform.conversation_mentions WHERE tenant_id = ? AND project_id = ? GROUP BY mention_type ORDER BY cnt DESC',
      "SELECT mention_text, count() AS cnt FROM abl_platform.conversation_mentions WHERE tenant_id = ? AND project_id = ? AND mention_type = 'competitor' GROUP BY mention_text ORDER BY cnt DESC",
    ],
  },

  // =========================================================================
  // Materialized Views (daily aggregations)
  // =========================================================================
  {
    table: 'abl_platform.mv_daily_sentiment',
    description:
      'Daily aggregated sentiment metrics per agent (materialized view over conversation_sentiment)',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'date', type: 'Date', description: 'Aggregation date' },
      { name: 'agent_name', type: 'LowCardinality(String)', description: 'Name of the agent' },
      {
        name: 'conversation_count',
        type: 'UInt64',
        description: 'Number of conversations on this date',
      },
      {
        name: 'total_sentiment',
        type: 'Float64',
        description: 'Sum of avg_sentiment values (divide by conversation_count for average)',
      },
      {
        name: 'declining_count',
        type: 'UInt64',
        description: 'Number of conversations with declining sentiment trajectory',
      },
      {
        name: 'frustrated_count',
        type: 'UInt64',
        description: 'Number of conversations with frustration detected',
      },
    ],
    commonQueries: [
      'SELECT date, total_sentiment / conversation_count AS avg_sentiment, conversation_count FROM abl_platform.mv_daily_sentiment WHERE tenant_id = ? AND project_id = ? ORDER BY date',
    ],
  },
  {
    table: 'abl_platform.mv_daily_intent_distribution',
    description: 'Daily intent distribution counts (materialized view over intent_classifications)',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'date', type: 'Date', description: 'Aggregation date' },
      { name: 'intent', type: 'LowCardinality(String)', description: 'Intent category' },
      {
        name: 'conversation_count',
        type: 'UInt64',
        description: 'Number of conversations classified with this intent on this date',
      },
      {
        name: 'total_confidence',
        type: 'Float64',
        description: 'Sum of confidence scores (divide by conversation_count for average)',
      },
    ],
    commonQueries: [
      'SELECT date, intent, conversation_count FROM abl_platform.mv_daily_intent_distribution WHERE tenant_id = ? AND project_id = ? ORDER BY date, conversation_count DESC',
    ],
  },
  {
    table: 'abl_platform.mv_daily_quality_scores',
    description:
      'Daily aggregated quality scores per agent and channel (materialized view over quality_evaluations)',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'date', type: 'Date', description: 'Aggregation date' },
      { name: 'agent_name', type: 'LowCardinality(String)', description: 'Name of the agent' },
      { name: 'channel', type: 'LowCardinality(String)', description: 'Communication channel' },
      {
        name: 'conversation_count',
        type: 'UInt64',
        description: 'Number of conversations evaluated on this date',
      },
      {
        name: 'total_score',
        type: 'Float64',
        description: 'Sum of overall_score values (divide by conversation_count for average)',
      },
      { name: 'total_helpfulness', type: 'Float64', description: 'Sum of helpfulness scores' },
      { name: 'total_accuracy', type: 'Float64', description: 'Sum of accuracy scores' },
      {
        name: 'total_professionalism',
        type: 'Float64',
        description: 'Sum of professionalism scores',
      },
      {
        name: 'flagged_count',
        type: 'UInt64',
        description: 'Number of flagged conversations on this date',
      },
    ],
    commonQueries: [
      'SELECT date, total_score / conversation_count AS avg_quality, conversation_count FROM abl_platform.mv_daily_quality_scores WHERE tenant_id = ? AND project_id = ? ORDER BY date',
    ],
  },
  {
    table: 'abl_platform.mv_daily_custom_events',
    description:
      'Daily custom event counts and unique sessions (materialized view over custom_events)',
    columns: [
      { name: 'tenant_id', type: 'String', description: 'Tenant identifier' },
      { name: 'project_id', type: 'String', description: 'Project identifier' },
      { name: 'event_name', type: 'String', description: 'Name of the custom event' },
      { name: 'day', type: 'Date', description: 'Aggregation date' },
      { name: 'event_count', type: 'UInt64', description: 'Number of events on this date' },
      {
        name: 'unique_sessions',
        type: 'UInt64',
        description: 'Number of unique sessions with this event on this date',
      },
    ],
    commonQueries: [
      'SELECT day, event_name, event_count FROM abl_platform.mv_daily_custom_events WHERE tenant_id = ? AND project_id = ? ORDER BY day',
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the semantic layer as a formatted string for LLM context.
 * Produces a Markdown document describing all tables and columns.
 */
export function getSemanticLayerPrompt(): string {
  const lines: string[] = ['# Available ClickHouse Analytics Tables\n'];

  for (const table of SEMANTIC_LAYER) {
    lines.push(`## ${table.table}`);
    lines.push(`${table.description}\n`);
    lines.push('| Column | Type | Description |');
    lines.push('|--------|------|-------------|');
    for (const col of table.columns) {
      const examples = col.examples ? ` (e.g. ${col.examples.join(', ')})` : '';
      lines.push(`| ${col.name} | ${col.type} | ${col.description}${examples} |`);
    }
    if (table.commonQueries && table.commonQueries.length > 0) {
      lines.push('');
      lines.push('**Example queries:**');
      for (const q of table.commonQueries) {
        lines.push(`- \`${q}\``);
      }
    }
    lines.push('');
  }

  log.debug('Semantic layer prompt generated', { tableCount: SEMANTIC_LAYER.length });

  return lines.join('\n');
}
