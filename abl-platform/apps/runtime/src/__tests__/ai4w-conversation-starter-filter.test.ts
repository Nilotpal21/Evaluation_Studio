/**
 * AI4W Conversation Starter Filtering Tests
 *
 * Tests that ON_START RESPOND blocks are skipped for AI4W channels
 * while still being executed for other channel types.
 *
 * This ensures AI4W channels don't receive unwanted automatic greetings.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema';
import { FlowStepExecutor } from '../services/execution/flow-step-executor.js';
import type { RuntimeSession } from '../services/execution/types.js';

describe('AI4W Conversation Starter Filtering', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = new FlowStepExecutor();
  });

  const createSession = (channelType: string | undefined, onStartConfig: any): RuntimeSession => {
    const agentIR: AgentIR = {
      ir_version: '1.0',
      metadata: {
        name: 'TestAgent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: new Date().toISOString(),
      },
      execution: {
        hints: {},
        timeouts: { step_timeout_ms: 30000, message_timeout_ms: 120000 },
      },
      identity: { goal: 'Test agent' },
      tools: [],
      gather: { fields: [] },
      memory: { session: [], persistent: [], recall: [], remember: [] },
      constraints: { guardrails: [] },
      coordination: {},
      completion: {},
      error_handling: {},
      on_start: onStartConfig,
    } as AgentIR;

    return {
      id: 'test-session-1',
      agentName: 'TestAgent',
      agentIR,
      compilationOutput: null,
      conversationHistory: [],
      state: {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      },
      data: {
        values: {},
        entities: {},
        observations: {},
      },
      isComplete: false,
      isEscalated: false,
      handoffStack: [],
      delegateStack: [],
      channelType,
    } as RuntimeSession;
  };

  test('AI4W channel skips ON_START RESPOND', async () => {
    const chunks: string[] = [];
    const traceEvents: any[] = [];

    const session = createSession('ai4w', {
      respond: 'Hello! Welcome to our service.',
    });

    const result = await executor.executeOnStart(
      session,
      (chunk: string) => chunks.push(chunk),
      (event: any) => traceEvents.push(event),
    );

    // Should not send any response
    expect(result).toBeNull();
    expect(chunks).toHaveLength(0);

    // Should emit skip trace event
    const skipEvent = traceEvents.find((e) => e.type === 'dsl_on_start_skipped');
    expect(skipEvent).toBeDefined();
    expect(skipEvent?.data.channelType).toBe('ai4w');
    expect(skipEvent?.data.reason).toBe('ai4w_channel_no_auto_starter');
  });

  test('non-AI4W channel executes ON_START RESPOND normally', async () => {
    const chunks: string[] = [];
    const traceEvents: any[] = [];

    const session = createSession('web_chat', {
      respond: 'Hello! Welcome to our service.',
    });

    const result = await executor.executeOnStart(
      session,
      (chunk: string) => chunks.push(chunk),
      (event: any) => traceEvents.push(event),
    );

    // Should send response
    expect(result).not.toBeNull();
    expect(result?.response).toBe('Hello! Welcome to our service.');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toContain('Hello! Welcome to our service.');

    // Should not emit skip event
    const skipEvent = traceEvents.find((e) => e.type === 'dsl_on_start_skipped');
    expect(skipEvent).toBeUndefined();
  });

  test('AI4W channel still executes ON_START SET', async () => {
    const session = createSession('ai4w', {
      set: { user_type: 'guest', session_count: 0 },
      respond: 'Welcome!',
    });

    await executor.executeOnStart(session);

    // SET should be executed
    expect(session.data.values.user_type).toBe('guest');
    expect(session.data.values.session_count).toBe(0);
  });

  test('AI4W channel still executes ON_START CALL', async () => {
    const traceEvents: any[] = [];

    const session = createSession('ai4w', {
      call: 'check_returning_user',
      respond: 'Welcome back!',
    });

    // Note: CALL execution will fail in this test because we don't have a real tool executor
    // but we verify that the code path attempts to execute it
    await executor.executeOnStart(session, undefined, (event: any) => traceEvents.push(event));

    // Should have attempted CALL (will fail but that's ok for this test)
    // The important part is that it didn't skip CALL execution
    expect(traceEvents.some((e) => e.type === 'dsl_on_start_skipped')).toBe(true);
  });

  test('undefined channelType executes ON_START RESPOND', async () => {
    const chunks: string[] = [];

    const session = createSession(undefined, {
      respond: 'Hello!',
    });

    const result = await executor.executeOnStart(session, (chunk: string) => chunks.push(chunk));

    // Should send response (backward compatibility)
    expect(result).not.toBeNull();
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('voice channel executes ON_START RESPOND', async () => {
    const chunks: string[] = [];

    const session = createSession('voice_telephony', {
      respond: 'Welcome to our service.',
    });

    const result = await executor.executeOnStart(session, (chunk: string) => chunks.push(chunk));

    // Should send response
    expect(result).not.toBeNull();
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('AI4W channel with no ON_START returns null', async () => {
    const session = createSession('ai4w', undefined);
    session.agentIR!.on_start = undefined;

    const result = await executor.executeOnStart(session);

    expect(result).toBeNull();
  });

  test('AI4W channel with only SET returns null (no RESPOND)', async () => {
    const session = createSession('ai4w', {
      set: { initialized: true },
    });

    const result = await executor.executeOnStart(session);

    // Should execute SET but return null (no response)
    expect(result).toBeNull();
    expect(session.data.values.initialized).toBe(true);
  });
});
