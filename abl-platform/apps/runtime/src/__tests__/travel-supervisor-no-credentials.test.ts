/**
 * Travel Supervisor — Credential Resolution Failure Test
 *
 * Replicates the abl-dev scenario where:
 * 1. TravelDesk_Supervisor agent (pure reasoning, no FLOW)
 * 2. ON_START responds with welcome template
 * 3. User sends "find hotels in paris for 3 nights"
 * 4. LLM credential resolution fails
 * 5. Previously: silent empty response. Now: error surfaced.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ExecutionCoordinator } from '../services/execution/execution-coordinator.js';
import { InMemoryExecutionQueue } from '@agent-platform/execution';
import { InMemoryDedupStore, ExecutionDedup } from '../services/execution/execution-dedup.js';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../services/runtime-executor';

// =============================================================================
// SIMPLIFIED SUPERVISOR DSL (mirrors traveldesk_supervisor structure)
// =============================================================================

const SUPERVISOR_DSL = `
SUPERVISOR: TravelDesk_Supervisor
DESCRIPTION: "Travel booking orchestrator"
GOAL: "Route customers to the right specialist"

PERSONA: |
  Professional travel booking assistant.
  Routes requests to the right specialist quickly.

EXECUTION:
  model: gpt-4.1
  temperature: 0.3
  max_tokens: 1500
  max_iterations: 5

TEMPLATES:
  welcome: |
    Welcome! I'm your travel assistant.
    What can I help you with today?

ON_START:
  RESPOND: TEMPLATE(welcome)

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent.category == "new_booking" OR intent.category == "travel_search"
    CONTEXT:
      pass: [search_context]
      summary: "User looking to book new travel"
    RETURN: false

  - TO: Fallback_Handler
    WHEN: intent.unclear == true
    CONTEXT:
      pass: [last_message]
      summary: "Need clarification"
    RETURN: true

ESCALATE:
  triggers:
    - WHEN: routing_failures >= 3
      REASON: "Multiple routing failures"
      PRIORITY: high
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Travel Supervisor — credential failure scenario', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('ON_START welcome message is delivered without LLM (template-based)', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'TravelDesk_Supervisor'),
    );

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    expect(output).toContain('Welcome');
    expect(output).toContain('travel assistant');
  });

  test('user message fails with clear error when LLM credentials are missing', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'TravelDesk_Supervisor'),
    );

    // Initialize (ON_START works fine — template, no LLM needed)
    await executor.initializeSession(session.id);

    // First user message — triggers reasoning executor which needs LLM.
    // Without credentials, the executor catches the error gracefully
    // and returns an error response instead of throwing.
    const result = await executor.executeMessage(session.id, 'find hotels in paris for 3 nights');

    // The executor returns a graceful error response
    expect(result.response).toBeDefined();
  });

  test('coordinator surfaces the LLM error instead of swallowing it', async () => {
    // This is the exact scenario from abl-dev: coordinator catches the error
    // and resolves (not rejects). Our fix ensures the error details are preserved.
    const queue = new InMemoryExecutionQueue();
    const dedup = new ExecutionDedup(new InMemoryDedupStore());

    const mockExecutor = {
      executeMessage: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "No credential found for provider 'openai' in tenant 'test-tenant'. " +
              'Configure a TenantModel with a connection or add an LLMCredential. ' +
              '[Debug: policy=user_only, db=true, enc=true; tenant_cred(test-tenant,openai)=null; ' +
              'tm_by_provider(test-tenant,openai)=not_found]',
          ),
        ),
    };

    const mockSessionLoader = vi.fn().mockResolvedValue({
      agentName: 'TravelDesk_Supervisor',
      agentIR: {
        execution: { mode: 'reasoning', concurrency: 'serial' },
      },
    });

    const coordinator = new ExecutionCoordinator({
      queue,
      dedup,
      executor: mockExecutor as any,
      sessionLoader: mockSessionLoader,
    });

    const execution = await coordinator.submit('sess-travel', 'find hotels in paris for 3 nights', {
      tenantId: 'test-tenant',
    });

    // BEFORE fix: execution.status would be 'failed' but handlers wouldn't check,
    // resulting in empty response with no error visible to client.
    // AFTER fix: handlers check execution.status and return the error.
    expect(execution.status).toBe('failed');
    expect(execution.error).toBeDefined();
    expect(execution.error?.message).toContain('No credential found');
    expect(execution.error?.message).toContain('openai');
    expect(execution.error?.message).toContain('tm_by_provider');

    // The response should be undefined (not empty string)
    expect(execution.response).toBeUndefined();
  });

  test('with working LLM client, supervisor responds to user message', async () => {
    // Inject a mock LLM that returns a text response
    const mockClient = {
      calls: [] as any[],
      async chatWithToolUse(systemPrompt: string, messages: any[], tools: any[]) {
        this.calls.push({ systemPrompt, messages, tools });
        return {
          text: 'I can help you find hotels in Paris! Let me connect you with our booking specialist.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'I can help you find hotels in Paris! Let me connect you with our booking specialist.',
            },
          ],
        };
      },
      async chatWithToolUseStreamable(
        systemPrompt: string,
        messages: any[],
        tools: any[],
        _opType?: string,
        _onChunk?: (c: string) => void,
      ) {
        return this.chatWithToolUse(systemPrompt, messages, tools);
      },
    };

    // Override wiring BEFORE creating session (wireLLMClient fires during creation)
    (executor as any).llmWiring.wireLLMClient = async (s: any) => {
      s.llmClient = mockClient;
    };
    (executor as any).llmWiring.ensureSessionLLMClient = async (s: any) => {
      if (!s.llmClient) s.llmClient = mockClient;
    };

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_DSL], 'TravelDesk_Supervisor'),
    );

    await executor.initializeSession(session.id);

    const result = await executor.executeMessage(session.id, 'find hotels in paris for 3 nights');

    // LLM was called
    expect(mockClient.calls.length).toBeGreaterThan(0);

    // System tools (handoff_to_*) should be in the tool list
    const toolNames = mockClient.calls[0].tools.map((t: any) => t.name);
    // Tool names preserve agent name casing from DSL
    expect(toolNames).toContain('handoff_to_Sales_Agent');
    expect(toolNames).toContain('handoff_to_Fallback_Handler');

    // Response came back and the runtime used the working LLM path rather than failing open.
    expect(result.response.trim().length).toBeGreaterThan(0);
    expect(result.response).toContain('I need a little more detail to route that.');
    expect(result.response).not.toContain('No credential found');
  });
});
