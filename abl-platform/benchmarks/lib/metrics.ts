/**
 * Custom k6 metrics for ABL Platform benchmarks.
 *
 * Extends built-in k6 metrics with platform-specific measurements.
 */
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';

// =============================================================================
// LLM & Agent Metrics
// =============================================================================

/** Time to first token from LLM (streaming) */
export const ttft = new Trend('abl_ttft_ms', true);

/** Total LLM response latency */
export const llmLatency = new Trend('abl_llm_latency_ms', true);

/** Agent turn latency (user message → full response) */
export const agentTurnLatency = new Trend('abl_agent_turn_latency_ms', true);

/** Tool call resolution time */
export const toolCallLatency = new Trend('abl_tool_call_latency_ms', true);

/** Multi-agent delegation overhead */
export const delegationOverhead = new Trend('abl_delegation_overhead_ms', true);

// =============================================================================
// Search & Embedding Metrics
// =============================================================================

/** Embedding throughput (documents per second) */
export const embeddingThroughput = new Gauge('abl_embedding_docs_per_sec');

/** Vector search latency */
export const vectorSearchLatency = new Trend('abl_vector_search_latency_ms', true);

/** Document ingestion rate (docs per hour) */
export const ingestionRate = new Gauge('abl_ingestion_docs_per_hour');

// =============================================================================
// Workflow Metrics
// =============================================================================

/** Workflow step execution time */
export const workflowStepLatency = new Trend('abl_workflow_step_latency_ms', true);

/** End-to-end workflow duration */
export const workflowTotalDuration = new Trend('abl_workflow_total_duration_ms', true);

/** Workflow failure recovery time */
export const workflowRecoveryTime = new Trend('abl_workflow_recovery_time_ms', true);

// =============================================================================
// Queue Metrics
// =============================================================================

/** Queue-to-processing latency (time spent waiting in queue) */
export const queueWaitTime = new Trend('abl_queue_wait_time_ms', true);

/** Queue depth (current items waiting) */
export const queueDepth = new Gauge('abl_queue_depth');

/** Queue drain rate (items/sec) */
export const queueDrainRate = new Gauge('abl_queue_drain_rate');

// =============================================================================
// Data Store Metrics
// =============================================================================

/** Database query latency */
export const dbQueryLatency = new Trend('abl_db_query_latency_ms', true);

/** Database write latency */
export const dbWriteLatency = new Trend('abl_db_write_latency_ms', true);

/** Connection pool utilization (0-1) */
export const connectionPoolUtil = new Gauge('abl_connection_pool_utilization');

// =============================================================================
// Error Tracking
// =============================================================================

/** Rate of successful operations */
export const successRate = new Rate('abl_success_rate');

/** Count of errors by type */
export const errorCount = new Counter('abl_errors_total');

/** Rate limit hits */
export const rateLimitHits = new Counter('abl_rate_limit_hits');
