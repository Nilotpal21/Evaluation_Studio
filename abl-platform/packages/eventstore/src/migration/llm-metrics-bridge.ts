/**
 * LLM Metrics Bridge - converts existing llm_metrics rows to platform events.
 *
 * Maps llm_metrics table columns to llm.call.completed event.
 */

import { ulid } from 'ulid';
import type { IEventEmitter } from '../interfaces/event-emitter.js';
import type { PlatformEvent } from '../schema/platform-event.js';

export interface LLMMetricsRow {
  tenant_id: string;
  timestamp: Date;
  model_id: string;
  provider: string;
  session_id: string;
  project_id: string;
  agent_name?: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  latency_ms: number;
  streaming_used: boolean;
  tool_call_count: number;
  success: boolean;
  error_type?: string;
}

/**
 * Map LLM metrics row to platform event.
 */
export function mapLLMMetricsToPlatformEvent(metricsRow: LLMMetricsRow): PlatformEvent {
  const eventType = metricsRow.success ? 'llm.call.completed' : 'llm.call.failed';

  const data: Record<string, unknown> = {
    model: metricsRow.model_id,
    provider: metricsRow.provider,
    input_tokens: metricsRow.input_tokens,
    output_tokens: metricsRow.output_tokens,
    total_tokens: metricsRow.total_tokens,
    estimated_cost: metricsRow.estimated_cost,
    latency_ms: metricsRow.latency_ms,
    streaming_used: metricsRow.streaming_used,
    tool_call_count: metricsRow.tool_call_count,
  };

  if (!metricsRow.success && metricsRow.error_type) {
    data.error_type = metricsRow.error_type;
    data.error_message = 'LLM call failed'; // Metrics table doesn't store message
  }

  const platformEvent: PlatformEvent = {
    event_id: ulid(),
    event_type: eventType,
    category: 'llm',
    tenant_id: metricsRow.tenant_id,
    project_id: metricsRow.project_id,
    session_id: metricsRow.session_id,
    agent_name: metricsRow.agent_name,
    timestamp: metricsRow.timestamp,
    duration_ms: metricsRow.latency_ms,
    has_error: !metricsRow.success,
    data,
  };

  return platformEvent;
}

/**
 * Emit LLM metrics row as platform event.
 */
export async function emitLLMMetricsAsAnalytics(
  emitter: IEventEmitter,
  metricsRow: LLMMetricsRow,
): Promise<void> {
  const platformEvent = mapLLMMetricsToPlatformEvent(metricsRow);
  emitter.emit(platformEvent);
}
