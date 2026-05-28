/**
 * Handoff Guardrail Tests
 *
 * Tests that the guardrail pipeline is wired into the routing executor's
 * handoff flow for `handoff` guardrails.
 *
 * Scenarios:
 * 1. Pipeline blocks handoff when PII detected in handoff context
 * 2. Pipeline allows handoff when context is clean
 * 3. Pipeline error -> fail-open, handoff proceeds normally
 *
 * Approach: Call handleHandoff() directly (same pattern as reasoning-gather-handoff.test.ts)
 * with handoff guardrails injected into the supervisor's agentIR.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../../services/runtime-executor';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

class MockLLMClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
    usage?: { input_tokens: number; output_tokens: number };
    resolvedModel?: { modelId: string; provider: string; source: string };
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

// =============================================================================
// TRACE HELPERS
// =============================================================================

interface CapturedTrace {
  type: string;
  data: Record<string, unknown>;
}

function createTraceCollector(): {
  traces: CapturedTrace[];
  callback: (event: { type: string; data: Record<string, unknown> }) => void;
} {
  const traces: CapturedTrace[] = [];
  return {
    traces,
    callback: (event) => traces.push({ type: event.type, data: event.data }),
  };
}

function filterTraces(traces: CapturedTrace[], type: string): CapturedTrace[] {
  return traces.filter((t) => t.type === type);
}

// =============================================================================
// ABL FIXTURES
// =============================================================================

/**
 * Supervisor agent with HANDOFF config.
 * Uses SUPERVISOR: keyword and proper HANDOFF syntax with TO:/WHEN:/CONTEXT:.
 */
const SUPERVISOR_DSL = `
SUPERVISOR: Supervisor

GOAL: "Route conversations to child agents"

PERSONA: "Routing supervisor"

HANDOFF:
  - TO: ChildAgent
    WHEN: intent.category == "child_task"
    CONTEXT:
      pass: []
      summary: "Handing off to child agent"
    RETURN: false
`;

const CHILD_AGENT_DSL = `
AGENT: ChildAgent

GOAL: "Handle child tasks"

PERSONA: "Child agent"
`;

// =============================================================================
// GUARDRAIL INJECTION HELPER
// =============================================================================

/**
 * Inject handoff guardrails into the supervisor agent's IR after session creation.
 * This tests the routing executor's handoff guardrail integration directly.
 */
function injectHandoffGuardrails(
  session: RuntimeSession,
  guardrails: Array<{
    name: string;
    description: string;
    kind: 'handoff';
    priority: number;
    tier: 'local';
    check: string;
    action: { type: string; message: string };
  }>,
): void {
  if (!session.agentIR) return;
  if (!session.agentIR.constraints) {
    session.agentIR.constraints = { constraints: [], guardrails: [] };
  }
  session.agentIR.constraints.guardrails = [
    ...(session.agentIR.constraints.guardrails || []),
    ...guardrails,
  ] as any;
}

// =============================================================================
// TESTS — Call handleHandoff() directly for precise guardrail testing
// =============================================================================

describe('Handoff Guardrails', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 1. Pipeline blocks handoff when PII detected in handoff context
  // ===========================================================================

  test('should block handoff when guardrail detects PII in handoff context', async () => {
    // Set up multi-agent session: Supervisor as entry agent
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL, CHILD_AGENT_DSL], 'Supervisor'),
    );

    // Set up handoff info manually (as buildTools would do)
    session.handoffReturnInfo = { ChildAgent: false };

    // Seed conversation history (handleHandoff uses last user message)
    session.conversationHistory.push({
      role: 'user',
      content: 'Transfer me to child agent, my SSN is 123-45-6789',
    });

    // Inject handoff guardrail — PII check on handoff content
    injectHandoffGuardrails(session, [
      {
        name: 'pii_handoff_check',
        description: 'Block PII in handoff context',
        kind: 'handoff',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(handoff)',
        action: { type: 'block', message: 'Handoff blocked: PII detected in context' },
      },
    ]);

    // Mock child agent LLM (won't be reached if guardrail blocks)
    mockClient.setResponseHandler(() => ({
      text: 'Hello from child agent.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Hello from child agent.' }],
    }));

    const traceCollector = createTraceCollector();
    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    const result = await handleHandoff(
      session,
      {
        target: 'ChildAgent',
        context: JSON.stringify({
          customer_ssn: '123-45-6789',
          customer_name: 'John Doe',
          issue: 'billing question',
        }),
      },
      undefined,
      traceCollector.callback,
    );

    // Guardrail should have blocked the handoff
    expect(result.success).toBe(false);
    expect(result.error).toContain('PII');

    // Should have a guardrail_handoff_blocked trace event
    const blockedTraces = filterTraces(traceCollector.traces, 'guardrail_handoff_blocked');
    expect(blockedTraces.length).toBeGreaterThanOrEqual(1);
    expect(blockedTraces[0].data.fromAgent).toBe('Supervisor');
    expect(blockedTraces[0].data.toAgent).toBe('ChildAgent');
    expect(blockedTraces[0].data.guardrailName).toBe('pii_handoff_check');

    // Session should still be on the supervisor (handoff was blocked)
    expect(session.agentName).toBe('Supervisor');
  });

  // ===========================================================================
  // 2. Pipeline allows handoff when context is clean
  // ===========================================================================

  test('should allow handoff when context is clean', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL, CHILD_AGENT_DSL], 'Supervisor'),
    );

    session.handoffReturnInfo = { ChildAgent: false };
    session.conversationHistory.push({
      role: 'user',
      content: 'Transfer me to child agent for a billing question',
    });

    // Inject handoff guardrail — PII check that will PASS for clean context
    injectHandoffGuardrails(session, [
      {
        name: 'pii_handoff_check',
        description: 'Block PII in handoff context',
        kind: 'handoff',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(handoff)',
        action: { type: 'block', message: 'Handoff blocked: PII detected in context' },
      },
    ]);

    // Child agent LLM response
    mockClient.setResponseHandler(() => ({
      text: 'Hello, I am the child agent. How can I help?',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Hello, I am the child agent. How can I help?' }],
    }));

    const traceCollector = createTraceCollector();
    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    const result = await handleHandoff(
      session,
      {
        target: 'ChildAgent',
        context: JSON.stringify({
          issue: 'billing question',
          priority: 'low',
        }),
      },
      undefined,
      traceCollector.callback,
    );

    // Handoff should succeed (clean context, no PII)
    expect(result.success).toBe(true);

    // Should NOT have guardrail_handoff_blocked traces
    const blockedTraces = filterTraces(traceCollector.traces, 'guardrail_handoff_blocked');
    expect(blockedTraces).toHaveLength(0);

    // Session should be on ChildAgent after successful handoff
    expect(session.agentName).toBe('ChildAgent');

    // Should have a normal handoff trace
    const handoffTraces = filterTraces(traceCollector.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
    expect(handoffTraces[0].data.from).toBe('Supervisor');
    expect(handoffTraces[0].data.to).toBe('ChildAgent');
  });

  // ===========================================================================
  // 3. Pipeline error -> fail-open, handoff proceeds normally
  // ===========================================================================

  test('should fail-open when handoff guardrail pipeline throws', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL, CHILD_AGENT_DSL], 'Supervisor'),
    );

    session.handoffReturnInfo = { ChildAgent: false };
    session.conversationHistory.push({
      role: 'user',
      content: 'Transfer to child agent',
    });

    // Inject handoff guardrail so the kind check passes
    injectHandoffGuardrails(session, [
      {
        name: 'crashing_handoff_guardrail',
        description: 'Guardrail that will cause pipeline to throw',
        kind: 'handoff',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(handoff)',
        action: { type: 'block', message: 'Should not reach here' },
      },
    ]);

    // Monkey-patch the guardrail pipeline to throw on handoff evaluation
    const { GuardrailPipelineImpl } = await import('@abl/compiler');
    const originalExecute = GuardrailPipelineImpl.prototype.execute;
    GuardrailPipelineImpl.prototype.execute = async function (
      guardrails: any[],
      _content: string,
      kind: string,
    ) {
      if (kind === 'handoff') {
        throw new Error('Simulated pipeline crash for handoff');
      }
      return originalExecute.call(this, guardrails, _content, kind, {}, undefined);
    };

    // Child agent LLM response
    mockClient.setResponseHandler(() => ({
      text: 'I am the child agent.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I am the child agent.' }],
    }));

    const traceCollector = createTraceCollector();
    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

    try {
      const result = await handleHandoff(
        session,
        {
          target: 'ChildAgent',
          context: JSON.stringify({ issue: 'billing question' }),
        },
        undefined,
        traceCollector.callback,
      );

      // Handoff should succeed despite pipeline error — fail-open
      expect(result.success).toBe(true);
      expect(session.agentName).toBe('ChildAgent');

      // Should have a pipeline error trace event
      const pipelineErrors = filterTraces(traceCollector.traces, 'guardrail_pipeline_error');
      expect(pipelineErrors.length).toBeGreaterThanOrEqual(1);
      expect(pipelineErrors[0].data.kind).toBe('handoff');
      expect(pipelineErrors[0].data.agent).toBe('Supervisor');
    } finally {
      // Restore original method
      GuardrailPipelineImpl.prototype.execute = originalExecute;
    }
  });
});
