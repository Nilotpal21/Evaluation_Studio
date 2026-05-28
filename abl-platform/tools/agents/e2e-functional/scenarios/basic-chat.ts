/**
 * Direct-fetch scenarios: Basic Chat (1), Session Resumption (2),
 * Streaming (3), Conversation History (10).
 */

import { registerScenario, fetchJson, readSSEEvents } from './index.js';
import type { ScenarioContext, ScenarioResult } from '../types.js';

// Shared state between scenarios 1 and 2
let savedSessionId: string | undefined;

// ─── Scenario 1: Basic Chat ────────────────────────────────────────────────

registerScenario(1, 'Basic Chat', async (ctx: ScenarioContext): Promise<ScenarioResult> => {
  const start = Date.now();
  const { sandbox, runtimeUrl, mockLlm } = ctx;

  mockLlm.reset();
  mockLlm.register('hello', { content: 'Hi there! How can I help you today?' });

  const { status, data } = await fetchJson<{
    sessionId?: string;
    response?: string;
    action?: string;
  }>(`${runtimeUrl}/api/v1/chat/agent`, {
    method: 'POST',
    body: { projectId: sandbox.projectId, message: 'Say hello' },
    token: sandbox.authToken,
  });

  const errors: string[] = [];

  if (status !== 200) errors.push(`Expected status 200, got ${status}`);
  if (!data.response || typeof data.response !== 'string' || data.response.length === 0) {
    errors.push(`Expected non-empty response string, got: ${JSON.stringify(data.response)}`);
  }
  if (!data.sessionId) {
    errors.push(`Expected sessionId in response, got: ${JSON.stringify(data)}`);
  } else {
    savedSessionId = data.sessionId;
  }

  return {
    id: 1,
    name: 'Basic Chat',
    passed: errors.length === 0,
    durationMs: Date.now() - start,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    details: errors.length === 0 ? `sessionId=${savedSessionId}` : undefined,
  };
});

// ─── Scenario 2: Session Resumption ────────────────────────────────────────

registerScenario(2, 'Session Resumption', async (ctx: ScenarioContext): Promise<ScenarioResult> => {
  const start = Date.now();
  const { sandbox, runtimeUrl, mockLlm } = ctx;

  if (!savedSessionId) {
    return {
      id: 2,
      name: 'Session Resumption',
      passed: false,
      durationMs: Date.now() - start,
      error: 'No sessionId from scenario 1 — skipped',
    };
  }

  mockLlm.reset();
  mockLlm.register('say', { content: 'You just said "Say hello".' });

  const { status, data } = await fetchJson<{
    sessionId?: string;
    response?: string;
  }>(`${runtimeUrl}/api/v1/chat/agent`, {
    method: 'POST',
    body: {
      projectId: sandbox.projectId,
      sessionId: savedSessionId,
      message: 'What did I just say?',
    },
    token: sandbox.authToken,
  });

  const errors: string[] = [];

  if (status !== 200) errors.push(`Expected status 200, got ${status}`);
  if (data.sessionId !== savedSessionId) {
    errors.push(`Expected sessionId ${savedSessionId}, got ${data.sessionId}`);
  }

  // Verify mock LLM received conversation history.
  // Use getAllRequests() instead of getLastRequest() because a pipeline filler
  // may fire a separate single-message LLM call that overwrites lastRequest.
  // The main reasoning call is the one with the most messages.
  const allRequests = mockLlm.getAllRequests();
  const mainReq =
    allRequests.length > 0
      ? allRequests.reduce((a, b) => (a.messages.length >= b.messages.length ? a : b))
      : undefined;

  if (!mainReq) {
    errors.push('Mock LLM received no request');
  } else if (mainReq.messages.length < 3) {
    // Should have: system + user(Say hello) + assistant(Hi there) + user(What did I just say?)
    errors.push(
      `Expected messages array with prior context, got ${mainReq.messages.length} messages`,
    );
  }

  return {
    id: 2,
    name: 'Session Resumption',
    passed: errors.length === 0,
    durationMs: Date.now() - start,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    details: mainReq
      ? `LLM received ${allRequests.length} requests; main had ${mainReq.messages.length} messages`
      : undefined,
  };
});

// ─── Scenario 3: Streaming ─────────────────────────────────────────────────

registerScenario(3, 'Streaming', async (ctx: ScenarioContext): Promise<ScenarioResult> => {
  const start = Date.now();
  const { sandbox, runtimeUrl, mockLlm } = ctx;

  mockLlm.reset();
  mockLlm.register('count', { content: 'One, two, three.' });

  const { status, contentType, events } = await readSSEEvents(`${runtimeUrl}/api/v1/chat/stream`, {
    body: {
      projectId: sandbox.projectId,
      messages: [{ role: 'user', content: 'Count to 3' }],
    },
    token: sandbox.authToken,
  });

  const errors: string[] = [];

  if (status !== 200) errors.push(`Expected status 200, got ${status}`);
  if (!contentType.includes('text/event-stream')) {
    errors.push(`Expected text/event-stream content-type, got: ${contentType}`);
  }

  const eventTypes = events.map((e) => e.event);
  if (!eventTypes.includes('complete')) {
    errors.push(`Expected 'complete' event, got events: ${eventTypes.join(', ')}`);
  }

  // Check complete event has totalTokens
  const completeEvent = events.find((e) => e.event === 'complete');
  if (completeEvent) {
    const completeData = completeEvent.data as Record<string, unknown>;
    if (typeof completeData?.totalTokens !== 'number' || completeData.totalTokens <= 0) {
      errors.push(
        `Expected totalTokens > 0 in complete event, got: ${JSON.stringify(completeData)}`,
      );
    }
  }

  return {
    id: 3,
    name: 'Streaming',
    passed: errors.length === 0,
    durationMs: Date.now() - start,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    details: `Received ${events.length} SSE events: ${eventTypes.join(', ')}`,
  };
});

// ─── Scenario 10: Conversation History ─────────────────────────────────────

registerScenario(
  10,
  'Conversation History',
  async (ctx: ScenarioContext): Promise<ScenarioResult> => {
    const start = Date.now();
    const { sandbox, runtimeUrl } = ctx;

    if (!savedSessionId) {
      return {
        id: 10,
        name: 'Conversation History',
        passed: false,
        durationMs: Date.now() - start,
        error: 'No sessionId from scenario 1 — skipped',
      };
    }

    const { status, data } = await fetchJson<{
      success?: boolean;
      messages?: Array<{ role?: string; content?: string }>;
      hasMore?: boolean;
    }>(
      `${runtimeUrl}/api/projects/${sandbox.projectId}/sessions/${savedSessionId}/messages?direction=asc&limit=50`,
      { token: sandbox.authToken },
    );

    const errors: string[] = [];

    if (status !== 200) errors.push(`Expected status 200, got ${status}`);
    if (data.success !== true) errors.push(`Expected success: true, got: ${data.success}`);
    if (!Array.isArray(data.messages)) {
      errors.push(`Expected messages array, got: ${typeof data.messages}`);
    } else {
      if (data.messages.length < 2) {
        errors.push(`Expected at least 2 messages (user+assistant), got ${data.messages.length}`);
      }
      // Check messages have role and content
      for (const msg of data.messages) {
        if (!msg.role) errors.push(`Message missing role: ${JSON.stringify(msg)}`);
      }
    }

    if (typeof data.hasMore !== 'boolean') {
      errors.push(`Expected hasMore boolean, got: ${typeof data.hasMore}`);
    }

    return {
      id: 10,
      name: 'Conversation History',
      passed: errors.length === 0,
      durationMs: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      details: `Found ${data.messages?.length ?? 0} messages`,
    };
  },
);
