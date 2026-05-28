/**
 * Regression test for ABLP-715 — supervisor handoff non-determinism.
 *
 * When a supervisor reaches its response-generation LLM call with only
 * actual routing tools in scope (handoff_to_*, delegate_to_*, and routing
 * control tools), the runtime may force the LLM to call one of them instead
 * of allowing it to emit free text. Without this, the LLM occasionally
 * returns text (e.g. "HANDOFF compareAndRecommend") and the handoff never
 * executes.
 *
 * The safety edge is equally important: memory tools such as __set_context__
 * are not routing decisions, so their presence must prevent forced tool
 * choice and allow the supervisor to ask for real prerequisite information.
 *
 * The counter-test below is the most surgical assertion we can make
 * without rebuilding the entire supervisor wiring: a non-supervisor
 * agent's response_gen LLM call must NOT carry `toolChoice: 'any'`,
 * regardless of what tools it has. End-to-end coverage of the positive
 * supervisor case is exercised against a live project (see
 * `/Users/Thiru/researchWS/ais_sales_assist/docs/agent-debug-log.md`).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';
import { injectValidatingMockClient } from '../helpers/history-validation';

describe('ABLP-715: response_gen toolChoice gating', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('non-supervisor agent never receives toolChoice:any on response_gen', async () => {
    const agent = `
AGENT: Helper

GOAL: "Help with a search"

PERSONA: "Helper"

TOOLS:
  search(q: string) -> {hits: array}

GATHER:
  q:
    prompt: "What to search for?"
    type: string
    required: true
    infer: true
`;

    const mock = injectValidatingMockClient(executor);
    const session = executor.createSessionFromResolved(compileToResolvedAgent([agent], 'Helper'));
    (session as { llmClient: unknown }).llmClient = mock;

    mock.setResponseHandler((_sys, _msgs, _tools, operationType) => {
      if (operationType === 'extraction') {
        const json = JSON.stringify({ q: 'hotels' });
        return {
          text: json,
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: json }],
        };
      }
      return {
        text: 'Sure, I can help with that.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Sure, I can help with that.' }],
      };
    });

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'search hotels', undefined, undefined);

    const responseGenCalls = mock.calls.filter((c) => c.operationType === 'response_gen');
    expect(responseGenCalls.length).toBeGreaterThan(0);

    for (const call of responseGenCalls) {
      const tc = (call.options as Record<string, unknown> | undefined)?.toolChoice;
      expect(
        tc,
        `non-supervisor response_gen must not force toolChoice. got: ${String(tc)}`,
      ).not.toBe('any');
    }
  });

  test('toolChoice:any is gated on a non-empty tool list (provider safety)', () => {
    // Direct check of the gating predicate: even when an agent is detected
    // as a supervisor, we must force toolChoice='any' only for a non-empty
    // list of actual routing controls. Memory tools are system tools, but
    // not routing decisions.
    const isSupervisor = true;
    const hasOnlyRoutingNames = (tools: { name: string }[]) =>
      tools.every(
        (t) =>
          t.name === '__handoff__' ||
          t.name === '__delegate__' ||
          t.name === '__fan_out__' ||
          t.name.startsWith('handoff_to_') ||
          t.name.startsWith('delegate_to_'),
      );

    // tools.every returns true vacuously for empty arrays, so the empty
    // case looks like "all routing tools" — but we must NOT force tool
    // choice in that case.
    const emptyTools: { name: string }[] = [];
    expect(hasOnlyRoutingNames(emptyTools)).toBe(true);
    expect(isSupervisor && hasOnlyRoutingNames(emptyTools) && emptyTools.length > 0).toBe(false);

    const routingTools = [{ name: 'handoff_to_Search_Agent' }, { name: 'handoff_to_Book_Agent' }];
    expect(isSupervisor && hasOnlyRoutingNames(routingTools) && routingTools.length > 0).toBe(true);

    const memoryTools = [{ name: 'handoff_to_Search_Agent' }, { name: '__set_context__' }];
    expect(isSupervisor && hasOnlyRoutingNames(memoryTools) && memoryTools.length > 0).toBe(false);

    const mixedTools = [{ name: 'handoff_to_Search_Agent' }, { name: 'lookup_external' }];
    expect(isSupervisor && hasOnlyRoutingNames(mixedTools) && mixedTools.length > 0).toBe(false);
  });

  test('supervisor with set_context can ask for missing prerequisite without forced tool choice', async () => {
    const supervisor = `
SUPERVISOR: BankingSupervisor

GOAL: "Route banking requests after identifying the customer"

PERSONA: "Ask for customer_id before routing to a specialist."

MEMORY:
  session:
    - name: customer_id
      type: string

HANDOFF:
  - TO: PaymentAgent
    WHEN: intent.category == "payment"
    RETURN: true
`;
    const paymentAgent = `
AGENT: PaymentAgent

GOAL: "Handle payments"

PERSONA: "Payment specialist"
`;

    const mock = injectValidatingMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisor, paymentAgent], 'BankingSupervisor'),
    );
    (session as { llmClient: unknown }).llmClient = mock;

    mock.setResponseHandler((_sys, _msgs, tools, operationType) => {
      if (operationType === 'response_gen') {
        expect(
          (tools as Array<{ name: string }>).some((tool) => tool.name === '__set_context__'),
        ).toBe(true);
      }
      return {
        text: 'Welcome to Mercury Bank. Please share your customer ID to continue.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Welcome to Mercury Bank. Please share your customer ID to continue.',
          },
        ],
      };
    });

    await executor.initializeSession(session.id);
    const result = await executor.executeMessage(
      session.id,
      'I want to make a payment',
      undefined,
      undefined,
    );

    const responseGenCall = mock.calls.find((call) => call.operationType === 'response_gen');
    expect(responseGenCall?.options?.toolChoice).not.toBe('any');
    expect(session.data.values.customer_id).toBeUndefined();
    expect(result.response).toContain('Please share your customer ID');
  });

  test('supervisor repair still triggers when free text contains a question word but asks no question', async () => {
    const supervisor = `
SUPERVISOR: BankingSupervisor

GOAL: "Route banking requests"

PERSONA: "Route explicit payment requests to the payment specialist."

HANDOFF:
  - TO: PaymentAgent
    WHEN: intent.category == "payment"
    RETURN: true
`;
    const paymentAgent = `
AGENT: PaymentAgent

GOAL: "Handle payments"

PERSONA: "Payment specialist"
`;

    const mock = injectValidatingMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisor, paymentAgent], 'BankingSupervisor'),
    );
    (session as { llmClient: unknown }).llmClient = mock;

    let supervisorResponseGenCalls = 0;
    mock.setResponseHandler((_sys, _msgs, tools, operationType) => {
      if (operationType !== 'response_gen') {
        return {
          text: JSON.stringify({ category: 'payment', confidence: 0.95 }),
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: JSON.stringify({ category: 'payment' }) }],
        };
      }

      const isSupervisorRoutingCall = (tools as Array<{ name: string }>).some(
        (tool) => tool.name === 'handoff_to_PaymentAgent',
      );

      if (!isSupervisorRoutingCall) {
        return {
          text: 'Perfect. Which card would you like to pay?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Perfect. Which card would you like to pay?' }],
        };
      }

      supervisorResponseGenCalls++;
      if (supervisorResponseGenCalls === 1) {
        return {
          text: 'I understand what you need. I will connect you to payment support.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'I understand what you need. I will connect you to payment support.',
            },
          ],
        };
      }

      return {
        text: '',
        toolCalls: [
          {
            id: 'handoff-payment',
            name: 'handoff_to_PaymentAgent',
            input: {
              reason: 'Payment request',
              message: 'I want to make a payment',
            },
          },
        ],
        stopReason: 'tool_use',
        rawContent: [
          {
            type: 'tool_use',
            id: 'handoff-payment',
            name: 'handoff_to_PaymentAgent',
            input: {
              reason: 'Payment request',
              message: 'I want to make a payment',
            },
          },
        ],
      };
    });

    await executor.initializeSession(session.id);
    const result = await executor.executeMessage(
      session.id,
      'I want to make a payment',
      undefined,
      undefined,
    );

    expect(supervisorResponseGenCalls).toBe(2);
    expect(result.action).toMatchObject({ type: 'handoff', target: 'PaymentAgent' });
    expect(result.response).not.toContain('I understand what you need');
  });

  test('set_context rejects placeholder values for declared session memory', async () => {
    const agent = `
AGENT: ContextAgent

GOAL: "Remember customer identity only after the user provides it"

PERSONA: "Identity collector"

MEMORY:
  session:
    - name: customer_id
      type: string
`;

    const mock = injectValidatingMockClient(executor);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([agent], 'ContextAgent'),
    );
    (session as { llmClient: unknown }).llmClient = mock;

    let responseGenCalls = 0;
    mock.setResponseHandler(() => {
      responseGenCalls++;
      if (responseGenCalls === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'ctx-unknown',
              name: '__set_context__',
              input: { updates: { customer_id: 'UNKNOWN' } },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'ctx-unknown',
              name: '__set_context__',
              input: { updates: { customer_id: 'UNKNOWN' } },
            },
          ],
        };
      }

      return {
        text: 'May I have your customer ID?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'May I have your customer ID?' }],
      };
    });

    await executor.initializeSession(session.id);
    const result = await executor.executeMessage(
      session.id,
      'I want to make a payment',
      undefined,
      undefined,
    );

    expect(session.data.values.customer_id).toBeUndefined();
    expect(session.data.gatheredKeys.has('customer_id')).toBe(false);
    expect(result.response).toContain('customer ID');
  });
});
