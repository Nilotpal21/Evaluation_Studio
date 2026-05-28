/**
 * Shared test helpers for eventstore tests.
 */

import type { PlatformEvent } from '../schema/platform-event.js';
import type { EventCategory } from '../interfaces/types.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

export { TENANT_A, TENANT_B, PROJECT_A, PROJECT_B };

let eventCounter = 0;

export function createTestEvent(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  eventCounter++;
  return {
    event_id: `evt-${eventCounter}`,
    event_type: 'session.started',
    category: 'session' as EventCategory,
    tenant_id: TENANT_A,
    project_id: PROJECT_A,
    session_id: `sess-${eventCounter}`,
    agent_name: 'test-agent',
    timestamp: new Date('2026-02-27T12:00:00Z'),
    data: {
      channel: 'web',
      agent_name: 'test-agent',
      deployment_id: 'deploy-1',
      resolution_method: 'new',
      caller_identity_tier: 'anonymous',
    },
    ...overrides,
  };
}

export function createSessionEndedEvent(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  eventCounter++;
  return {
    event_id: `evt-${eventCounter}`,
    event_type: 'session.ended',
    category: 'session' as EventCategory,
    tenant_id: TENANT_A,
    project_id: PROJECT_A,
    session_id: `sess-${eventCounter}`,
    agent_name: 'test-agent',
    timestamp: new Date('2026-02-27T12:05:00Z'),
    duration_ms: 30000,
    data: {
      reason: 'completed',
      total_duration_ms: 30000,
      total_turns: 5,
      total_llm_calls: 3,
      total_tool_calls: 2,
      total_tokens: 1500,
      estimated_cost: 0.005,
    },
    ...overrides,
  };
}

export function createLLMCallEvent(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  eventCounter++;
  return {
    event_id: `evt-${eventCounter}`,
    event_type: 'llm.call.completed',
    category: 'llm' as EventCategory,
    tenant_id: TENANT_A,
    project_id: PROJECT_A,
    session_id: `sess-${eventCounter}`,
    agent_name: 'test-agent',
    timestamp: new Date('2026-02-27T12:01:00Z'),
    duration_ms: 1200,
    data: {
      model: 'gpt-4o',
      provider: 'openai',
      input_tokens: 500,
      output_tokens: 200,
      total_tokens: 700,
      estimated_cost: 0.002,
      latency_ms: 1200,
      streaming_used: false,
      tool_call_count: 0,
    },
    ...overrides,
  };
}

export function createErrorEvent(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  eventCounter++;
  return {
    event_id: `evt-${eventCounter}`,
    event_type: 'llm.call.failed',
    category: 'llm' as EventCategory,
    tenant_id: TENANT_A,
    project_id: PROJECT_A,
    session_id: `sess-${eventCounter}`,
    agent_name: 'test-agent',
    timestamp: new Date('2026-02-27T12:02:00Z'),
    has_error: true,
    error_message: 'Rate limit exceeded',
    error_type: 'rate_limit',
    data: {
      model: 'gpt-4o',
      provider: 'openai',
      error_type: 'rate_limit',
      error_message: 'Rate limit exceeded',
      latency_ms: 500,
      retry_attempt: 1,
    },
    ...overrides,
  };
}

/**
 * Create events with actor info (for PII / GDPR tests).
 */
export function createPIIEvent(
  actorId: string,
  overrides: Partial<PlatformEvent> = {},
): PlatformEvent {
  eventCounter++;
  return {
    event_id: `evt-${eventCounter}`,
    event_type: 'channel.message.received',
    category: 'channel' as EventCategory,
    tenant_id: TENANT_A,
    project_id: PROJECT_A,
    session_id: `sess-${eventCounter}`,
    actor_id: actorId,
    actor_type: 'contact',
    timestamp: new Date('2026-02-27T12:00:00Z'),
    data: {
      channel_type: 'web',
      connection_id: 'conn-1',
      deduped: false,
      processing_duration_ms: 50,
      status: 'processed',
    },
    ...overrides,
  };
}

export function resetEventCounter(): void {
  eventCounter = 0;
}
