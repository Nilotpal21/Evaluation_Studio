/**
 * E2E Test Fixtures: Sessions with Trace Events
 *
 * Provides realistic session + trace event fixtures for E2E tests.
 * Fixtures use correct schema (data.usage.inputTokens) and include
 * multiple event types (user_message, llm_call, tool_call, agent_response).
 */

import type { ExtendedTraceEvent } from '@agent-platform/observatory';

/**
 * Generate a session ID for testing
 */
export function generateTestSessionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a test session with interactions (10+ trace events)
 */
export function testSessionWithInteractions(overrides?: {
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
}): { sessionId: string; tenantId: string; projectId: string; events: ExtendedTraceEvent[] } {
  const tenantId = overrides?.tenantId || 'tenant-e2e-interactions';
  const projectId = overrides?.projectId || 'project-e2e-interactions';
  const sessionId = overrides?.sessionId || generateTestSessionId('e2e-test');
  const baseTimestamp = new Date('2024-01-01T00:00:00Z');

  const events: ExtendedTraceEvent[] = [
    // Interaction 1: Simple query
    {
      id: `${sessionId}-evt-1`,
      type: 'user_message',
      timestamp: new Date(baseTimestamp.getTime()),
      traceId: `trace-${sessionId}`,
      spanId: `span-1`,
      sessionId,
      agentName: 'test-agent',
      data: { role: 'user', content: 'What is the weather today?' },
    },
    {
      id: `${sessionId}-evt-2`,
      type: 'llm_call',
      timestamp: new Date(baseTimestamp.getTime() + 1000),
      traceId: `trace-${sessionId}`,
      spanId: `span-2`,
      sessionId,
      agentName: 'test-agent',
      data: {
        model: 'gpt-4',
        usage: { inputTokens: 150, outputTokens: 75, contextWindowSize: 8000 },
        tokensIn: 150,
        promptTokens: 150,
        tokensOut: 75,
        completionTokens: 75,
        cost: 0.005,
      },
    },
    {
      id: `${sessionId}-evt-3`,
      type: 'tool_call',
      timestamp: new Date(baseTimestamp.getTime() + 2000),
      traceId: `trace-${sessionId}`,
      spanId: `span-3`,
      sessionId,
      agentName: 'test-agent',
      data: {
        tool: 'weather-api',
        toolName: 'weather-api',
        input: { location: 'San Francisco' },
        result: { temp: 72, conditions: 'sunny' },
        success: true,
        latencyMs: 250,
      },
    },
    {
      id: `${sessionId}-evt-4`,
      type: 'agent_response',
      timestamp: new Date(baseTimestamp.getTime() + 3000),
      traceId: `trace-${sessionId}`,
      spanId: `span-4`,
      sessionId,
      agentName: 'test-agent',
      data: {
        role: 'assistant',
        content: 'The weather in San Francisco is 72°F and sunny.',
        contentLength: 51,
      },
    },

    // Interaction 2: Multi-step with guardrail check
    {
      id: `${sessionId}-evt-5`,
      type: 'user_message',
      timestamp: new Date(baseTimestamp.getTime() + 60000),
      traceId: `trace-${sessionId}`,
      spanId: `span-5`,
      sessionId,
      agentName: 'test-agent',
      data: { role: 'user', content: 'Book a flight to Tokyo' },
    },
    {
      id: `${sessionId}-evt-6`,
      type: 'guardrail_check',
      timestamp: new Date(baseTimestamp.getTime() + 61000),
      traceId: `trace-${sessionId}`,
      spanId: `span-6`,
      sessionId,
      agentName: 'test-agent',
      data: {
        checkType: 'budget',
        status: 'pass',
        confidence: 0.95,
        findings: [],
        passed: true,
      },
    },
    {
      id: `${sessionId}-evt-7`,
      type: 'llm_call',
      timestamp: new Date(baseTimestamp.getTime() + 62000),
      traceId: `trace-${sessionId}`,
      spanId: `span-7`,
      sessionId,
      agentName: 'test-agent',
      data: {
        model: 'gpt-4',
        usage: { inputTokens: 200, outputTokens: 100, contextWindowSize: 8000 },
        tokensIn: 200,
        promptTokens: 200,
        tokensOut: 100,
        completionTokens: 100,
        cost: 0.007,
      },
    },
    {
      id: `${sessionId}-evt-8`,
      type: 'tool_call',
      timestamp: new Date(baseTimestamp.getTime() + 63000),
      traceId: `trace-${sessionId}`,
      spanId: `span-8`,
      sessionId,
      agentName: 'test-agent',
      data: {
        tool: 'flight-booking',
        toolName: 'flight-booking',
        input: { destination: 'Tokyo', departure: 'SFO' },
        result: { confirmationCode: 'ABC123', price: 850 },
        success: true,
        latencyMs: 1500,
      },
    },
    {
      id: `${sessionId}-evt-9`,
      type: 'llm_call',
      timestamp: new Date(baseTimestamp.getTime() + 64000),
      traceId: `trace-${sessionId}`,
      spanId: `span-9`,
      sessionId,
      agentName: 'test-agent',
      data: {
        model: 'gpt-4',
        usage: { inputTokens: 180, outputTokens: 90, contextWindowSize: 8000 },
        tokensIn: 180,
        promptTokens: 180,
        tokensOut: 90,
        completionTokens: 90,
        cost: 0.006,
      },
    },
    {
      id: `${sessionId}-evt-10`,
      type: 'agent_response',
      timestamp: new Date(baseTimestamp.getTime() + 65000),
      traceId: `trace-${sessionId}`,
      spanId: `span-10`,
      sessionId,
      agentName: 'test-agent',
      data: {
        role: 'assistant',
        content: 'I have booked your flight to Tokyo. Confirmation: ABC123. Price: $850.',
        contentLength: 74,
      },
    },

    // Interaction 3: Error case
    {
      id: `${sessionId}-evt-11`,
      type: 'user_message',
      timestamp: new Date(baseTimestamp.getTime() + 120000),
      traceId: `trace-${sessionId}`,
      spanId: `span-11`,
      sessionId,
      agentName: 'test-agent',
      data: { role: 'user', content: 'Check my flight status' },
    },
    {
      id: `${sessionId}-evt-12`,
      type: 'llm_call',
      timestamp: new Date(baseTimestamp.getTime() + 121000),
      traceId: `trace-${sessionId}`,
      spanId: `span-12`,
      sessionId,
      agentName: 'test-agent',
      data: {
        model: 'gpt-4',
        usage: { inputTokens: 120, outputTokens: 60, contextWindowSize: 8000 },
        tokensIn: 120,
        promptTokens: 120,
        tokensOut: 60,
        completionTokens: 60,
        cost: 0.004,
      },
    },
    {
      id: `${sessionId}-evt-13`,
      type: 'tool_call',
      timestamp: new Date(baseTimestamp.getTime() + 122000),
      traceId: `trace-${sessionId}`,
      spanId: `span-13`,
      sessionId,
      agentName: 'test-agent',
      data: {
        tool: 'flight-status',
        toolName: 'flight-status',
        input: { confirmationCode: 'ABC123' },
        result: null,
        error: 'Flight not found',
        success: false,
        latencyMs: 300,
      },
    },
    {
      id: `${sessionId}-evt-14`,
      type: 'agent_response',
      timestamp: new Date(baseTimestamp.getTime() + 123000),
      traceId: `trace-${sessionId}`,
      spanId: `span-14`,
      sessionId,
      agentName: 'test-agent',
      data: {
        role: 'assistant',
        content: 'Sorry, I could not retrieve your flight status. Please try again later.',
        contentLength: 76,
      },
    },
  ];

  return { sessionId, tenantId, projectId, events };
}

/**
 * Create a session from a different tenant (for SEC-1 cross-tenant isolation test)
 */
export function crossTenantSession(baseTenantId: string): {
  sessionId: string;
  tenantId: string;
  projectId: string;
  events: ExtendedTraceEvent[];
} {
  const differentTenantId = `${baseTenantId}-different`;
  return testSessionWithInteractions({
    tenantId: differentTenantId,
    projectId: 'project-cross-tenant',
  });
}

/**
 * Create a session from a different project (for SEC-2 cross-project isolation test)
 */
export function crossProjectSession(
  baseTenantId: string,
  baseProjectId: string,
): { sessionId: string; tenantId: string; projectId: string; events: ExtendedTraceEvent[] } {
  const differentProjectId = `${baseProjectId}-different`;
  return testSessionWithInteractions({
    tenantId: baseTenantId,
    projectId: differentProjectId,
  });
}
