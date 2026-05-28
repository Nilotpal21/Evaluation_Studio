/**
 * Runtime Executor Tests
 *
 * Tests for ON_INPUT condition evaluation and flow execution
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';
import { evaluateConditionDual } from '@abl/compiler';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import {
  assertSessionHistoryIntegrity,
  assertHistoryIntegrity,
  assertNoEmptyUserMessages,
  assertNoEmptyMessages,
} from '../helpers/history-validation';

type GuardrailPipelineResult =
  | Record<string, unknown>
  | ((content: string, kind: string) => Record<string, unknown> | Promise<Record<string, unknown>>);

async function loadRuntimeExecutorWithGuardrailResult(pipelineResult: GuardrailPipelineResult) {
  vi.resetModules();
  vi.doMock('../../services/guardrails/pipeline-factory.js', () => ({
    createGuardrailPipeline: vi.fn(() => ({
      execute: vi.fn().mockImplementation(async (_guardrails, content, kind) => {
        if (typeof pipelineResult === 'function') {
          return pipelineResult(String(content ?? ''), String(kind ?? ''));
        }
        return pipelineResult;
      }),
    })),
    createLLMEvalFromClient: vi.fn(() => undefined),
    ensureTenantProvidersLoaded: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../../services/execution/session-policy.js', () => ({
    getSessionPolicy: vi.fn().mockResolvedValue({
      additionalGuardrails: [{ name: 'policy-input-guardrail', kind: 'input' }],
    }),
    getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue('test-guardrail-scope'),
    getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
    toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
  }));
  vi.doMock('../../services/pii/session-pii-context.js', () => ({
    refreshSessionPIIContext: vi.fn().mockResolvedValue(undefined),
  }));

  return import('../../services/runtime-executor');
}

describe('RuntimeExecutor', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('Condition Evaluation', () => {
    describe('Equality Conditions', () => {
      test('should match exact input equality', () => {
        expect(evaluateConditionDual('input == "back"', { input: 'back' })).toBe(true);
        expect(evaluateConditionDual('input == "back"', { input: 'forward' })).toBe(false);
      });

      test('should match input inequality', () => {
        expect(evaluateConditionDual('input != "skip"', { input: 'continue' })).toBe(true);
        expect(evaluateConditionDual('input != "skip"', { input: 'skip' })).toBe(false);
      });
    });

    describe('Contains Conditions', () => {
      test('should match contains condition', () => {
        expect(
          evaluateConditionDual('input contains "help"', { input: 'i need help please' }),
        ).toBe(true);
        expect(evaluateConditionDual('input contains "help"', { input: 'assist me' })).toBe(false);
      });

      test('should match contains with operator syntax', () => {
        expect(
          evaluateConditionDual('input contains "change"', { input: 'i want to change' }),
        ).toBe(true);
      });
    });

    describe('StartsWith/EndsWith Conditions', () => {
      test('should match startsWith condition', () => {
        expect(evaluateConditionDual('input startsWith "hello"', { input: 'hello world' })).toBe(
          true,
        );
        expect(evaluateConditionDual('input startsWith "hello"', { input: 'world hello' })).toBe(
          false,
        );
      });

      test('should match endsWith condition', () => {
        expect(evaluateConditionDual('input endsWith "please"', { input: 'help me please' })).toBe(
          true,
        );
        expect(evaluateConditionDual('input endsWith "please"', { input: 'please help' })).toBe(
          false,
        );
      });
    });

    describe('Regex Conditions', () => {
      test('should match regex pattern', () => {
        expect(evaluateConditionDual('input matches /^\\d+$/', { input: '123' })).toBe(true);
        expect(evaluateConditionDual('input matches /^\\d+$/', { input: 'abc' })).toBe(false);
      });

      test('should match regex with flags', () => {
        expect(evaluateConditionDual('input matches /hello/i', { input: 'HELLO' })).toBe(true);
      });
    });

    describe('Variable Conditions', () => {
      test('should evaluate context variable equality', () => {
        expect(evaluateConditionDual('status == "active"', { status: 'active' })).toBe(true);
        expect(evaluateConditionDual('status == "inactive"', { status: 'active' })).toBe(false);
      });

      test('should evaluate numeric comparisons', () => {
        const context = { count: 5 };
        expect(evaluateConditionDual('count > 3', context)).toBe(true);
        expect(evaluateConditionDual('count < 3', context)).toBe(false);
        expect(evaluateConditionDual('count >= 5', context)).toBe(true);
        expect(evaluateConditionDual('count <= 5', context)).toBe(true);
      });

      test('should evaluate nested variable paths', () => {
        expect(evaluateConditionDual('user.tier == "gold"', { user: { tier: 'gold' } })).toBe(true);
      });

      test('should evaluate boolean context', () => {
        const context = { is_authenticated: true, is_admin: false };
        expect(evaluateConditionDual('is_authenticated', context)).toBe(true);
        expect(evaluateConditionDual('is_admin', context)).toBe(false);
      });
    });

    describe('Context Variable Truthy Checks', () => {
      test('should evaluate context variable as truthy', () => {
        expect(evaluateConditionDual('back', { back: true })).toBe(true);
        expect(evaluateConditionDual('back', { back: false })).toBe(false);
      });

      test('should evaluate undefined context variable as falsy', () => {
        expect(evaluateConditionDual('cancel', {})).toBe(false);
      });

      test('should use contains for keyword matching in input', () => {
        expect(evaluateConditionDual('input contains "back"', { input: 'go back' })).toBe(true);
        expect(evaluateConditionDual('input contains "help"', { input: 'i need help' })).toBe(true);
      });
    });
  });

  describe('Flow Session Execution', () => {
    test('should create flow session for scripted mode agent', () => {
      const dsl = `
AGENT: Test_Flow

GOAL: "Test flow"

FLOW:
  start -> end

  start:
    REASONING: false
    RESPOND: "Hello"
    THEN: end

  end:
    REASONING: false
    RESPOND: "Goodbye"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Test_Flow'),
      );
      expect(session.currentFlowStep).toBe('start');
      expect(session.data.values).toEqual(expect.objectContaining({}));
    });

    test('emits message.agent events for structured-only runtime results', () => {
      const dsl = `
AGENT: Structured_Only_Event_Agent

GOAL: "Emit structured-only output"
`;
      const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
      executor.setEventBus({
        emit: (event) =>
          emittedEvents.push(event as { type: string; payload: Record<string, unknown> }),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      });
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Structured_Only_Event_Agent'),
        { tenantId: 'tenant-1', projectId: 'project-1' },
      );
      const emitRenderableAgentMessage = (
        executor as unknown as {
          emitRenderableAgentMessage: (
            session: typeof session,
            result: {
              response: string;
              actions?: { elements: Array<{ type: string; id: string; label: string }> };
            },
          ) => void;
        }
      ).emitRenderableAgentMessage.bind(executor);

      emitRenderableAgentMessage(session, { response: '' });
      expect(emittedEvents).toEqual([]);

      emitRenderableAgentMessage(session, {
        response: '',
        actions: {
          elements: [{ type: 'button', id: 'pick_one', label: 'Pick one' }],
        },
      });

      const messageAgentEvent = emittedEvents.find(
        (event) =>
          event.type === 'message.agent' &&
          Boolean(
            (
              event.payload.structuredContent as
                | { actions?: { elements?: Array<{ id?: string }> } }
                | undefined
            )?.actions?.elements?.some((element) => element.id === 'pick_one'),
          ),
      );
      expect(messageAgentEvent?.payload).toMatchObject({
        content: '',
        structuredContent: {
          actions: {
            elements: [{ type: 'button', id: 'pick_one', label: 'Pick one' }],
          },
        },
        contentEnvelope: {
          version: 2,
          format: 'message_envelope',
          actions: {
            elements: [{ type: 'button', id: 'pick_one', label: 'Pick one' }],
          },
        },
      });
    });

    test('should not create flow session for reasoning mode agent', () => {
      const dsl = `
AGENT: Test_Reasoning

GOAL: "Test reasoning"

PERSONA: "Helpful assistant"
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Test_Reasoning'),
      );
      expect(session.currentFlowStep).toBeUndefined();
      // data.values is always defined (no longer undefined for reasoning mode)
    });

    test('deterministic non-flow handoff executes before the reasoning loop', async () => {
      const parentDsl = `
AGENT: Deterministic_Handoff_Agent

GOAL: "Route billing requests without entering the LLM loop"
PERSONA: "A deterministic handoff router"

HANDOFF:
  - TO: Billing_Specialist
    WHEN: input contains "billing"
    RETURN: false
`;

      const childDsl = `
AGENT: Billing_Specialist

GOAL: "Handle billing requests"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "Billing specialist here."
  THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([parentDsl, childDsl], 'Deterministic_Handoff_Agent'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const result = await executor.executeMessage(session.id, 'I need billing help', (chunk) =>
        chunks.push(chunk),
      );

      expect(result.response).toContain('Billing specialist here.');
      expect(chunks.join('')).toContain('Billing specialist here.');
      expect(session.agentName).toBe('Billing_Specialist');
    });

    test('seeds runtime user identity from callerContext when explicit userId is absent', () => {
      const dsl = `
AGENT: Contact_Scoped

GOAL: "Test caller-context identity seeding"
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Contact_Scoped'),
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          callerContext: {
            tenantId: 'tenant-1',
            channel: 'sdk_websocket',
            contactId: 'contact-runtime-1',
            anonymousId: 'sdk-session-1',
            identityTier: 2,
            verificationMethod: 'hmac',
          } as any,
        },
      );

      expect(session.userId).toBe('contact-runtime-1');
      expect(session.data.values.user_id).toBe('contact-runtime-1');
      expect((session.data.values.session as Record<string, unknown>).userId).toBe(
        'contact-runtime-1',
      );
    });

    test('should initialize flow and execute first step', async () => {
      const dsl = `
AGENT: Init_Test

GOAL: "Test initialization"

FLOW:
  welcome -> collect_name

  welcome:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: collect_name

  collect_name:
    REASONING: false
    GATHER:
      - name: required
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Init_Test'),
      );
      const chunks: string[] = [];

      const result = await executor.initializeSession(session.id, (c) => chunks.push(c));

      // Should show welcome message and then auto-prompt for GATHER fields
      expect(chunks.join('')).toContain('Welcome!');
      expect(chunks.join('')).toContain('name');
      expect(session.currentFlowStep).toBe('collect_name');
      expect(session.waitingForInput).toEqual(['name']);
    });

    test('should apply conversation behavior clarification and repair budgets to gather re-prompts', async () => {
      const dsl = `
AGENT: Clarification_Budget_Test

GOAL: "Collect age and email"

CONVERSATION:
  interaction:
    clarification:
      max_questions: 1
    repair:
      max_attempts: 1

FLOW:
  collect_contact -> done

  collect_contact:
    REASONING: false
    GATHER:
      - age: required
      - email: required
    THEN: done

  done:
    REASONING: false
    RESPOND: "Saved"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Clarification_Budget_Test'),
      );

      await executor.initializeSession(session.id);
      expect(session.waitingForInput).toEqual(['age', 'email']);

      const firstRetry = await executor.executeMessage(session.id, '42');
      expect(firstRetry.response).toContain('Please provide: age, email');
      expect(session.data.values._clarification_count).toBe(1);

      const secondRetry = await executor.executeMessage(session.id, '42');
      expect(secondRetry.response).toBe(
        'I still need age, email to continue. Please provide age, email so I can continue.',
      );
      expect(session.data.values._clarification_count).toBe(2);

      const thirdRetry = await executor.executeMessage(session.id, '42');
      expect(thirdRetry.response).toBe(
        "I still need age, email to continue. Share age, email when you're ready.",
      );
      expect(session.data.values._clarification_count).toBe(2);
    });

    test('rejects follow-up execution when merged session metadata exceeds the post-merge limit', async () => {
      const dsl = `
AGENT: Metadata_Flow

GOAL: "Test metadata validation"

FLOW:
  start:
    REASONING: false
    RESPOND: "Hello"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Metadata_Flow'),
      );
      session.data.values._metadata = {
        existingBlob: 'x'.repeat(262_000),
      };

      await expect(
        executor.executeMessage(session.id, 'hello', undefined, undefined, {
          sessionMetadata: {
            nextBlob: 'y'.repeat(1_000),
          },
        }),
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 413,
      });
    });

    test('should stream bullet-list ON_START responses before auto-running the entry flow step', async () => {
      const dsl = `
AGENT: Init_Bullet_OnStart

GOAL: "Reproduce list-style ON_START"

ON_START:
  - RESPOND: "Hi!"

FLOW:
  steps:
    - resolve_member

  resolve_member:
    REASONING: false
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Init_Bullet_OnStart'),
      );
      const chunks: string[] = [];

      const result = await executor.initializeSession(session.id, (chunk) => chunks.push(chunk));

      expect(session.agentIR?.on_start?.respond).toBe('Hi!');
      expect(chunks).toEqual(['Hi!\n\n']);
      expect(result?.action).toEqual({ type: 'flow', step: 'resolve_member' });
    });

    test('suppresses structured-only lazy ON_START results before processing the first user turn', async () => {
      const dsl = `
AGENT: Lazy_Structured_OnStart

GOAL: "Preserve structured first response"

FLOW:
  next:
    REASONING: false
    RESPOND: "Processed user message"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Lazy_Structured_OnStart'),
      );
      const richContent = { markdown: '**Welcome card**' };
      const actions = {
        elements: [{ type: 'button' as const, id: 'start', label: 'Start' }],
      };
      const voiceConfig = { plain_text: 'Welcome. Press start.' };

      session.initialized = false;
      session.currentFlowStep = 'next';
      (session as unknown as { llmClient: unknown }).llmClient = {};
      vi.spyOn(executor, 'initializeSession').mockResolvedValue({
        response: '',
        action: { type: 'continue' },
        richContent,
        actions,
        voiceConfig,
      });
      const flowStepSpy = vi
        .spyOn((executor as any).flowStep, 'executeFlowStep')
        .mockResolvedValue({
          response: 'Processed user message',
          action: { type: 'complete' },
        });

      const result = await executor.executeMessage(session.id, 'hello');

      expect(result).toMatchObject({
        response: 'Processed user message',
        action: { type: 'complete' },
      });
      expect(result.richContent).toBeUndefined();
      expect(result.actions).toBeUndefined();
      expect(result.voiceConfig).toBeUndefined();
      expect(flowStepSpy).toHaveBeenCalledOnce();
    });

    test('should process ON_INPUT and navigate to different step', async () => {
      const dsl = `
AGENT: Navigation_Test

GOAL: "Test ON_INPUT navigation"

FLOW:
  step1 -> step2 -> step3

  step1:
    REASONING: false
    RESPOND: "Step 1"
    THEN: step2

  step2:
    REASONING: false
    GATHER:
      - value: required
    ON_INPUT:
      - IF: input == "back"
        RESPOND: "Going back to step 1"
        THEN: step1
      - ELSE:
        THEN: step3

  step3:
    REASONING: false
    RESPOND: "Step 3 - you entered: {{value}}"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Navigation_Test'),
      );

      // Verify ON_INPUT was parsed correctly
      const step2Def = session.agentIR?.flow?.definitions['step2'];
      expect(step2Def?.on_input).toBeDefined();
      expect(step2Def?.on_input?.length).toBe(2);

      // Initialize flow
      await executor.initializeSession(session.id);
      expect(session.currentFlowStep).toBe('step2');
      expect(session.waitingForInput).toEqual(['value']);

      // Send "back" to trigger ON_INPUT navigation
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'back', (c) => chunks.push(c));

      // Should show: "Going back to step 1" (branch response), "Step 1" (step1), "Enter value..." (step2 prompt)
      const output = chunks.join('');
      expect(output).toContain('Going back to step 1');
      expect(output).toContain('Step 1');
      // Scripted auto-advancing flows produce consecutive assistant messages (RESPOND → PROMPT),
      // so check for empty messages only (the most critical API validation)
      assertNoEmptyUserMessages(
        session.conversationHistory,
        'ON_INPUT navigate conversationHistory',
      );
      assertNoEmptyMessages(session.conversationHistory, 'ON_INPUT navigate conversationHistory');
    });

    test('should extract entities and use in template interpolation', async () => {
      const dsl = `
AGENT: Entity_Test

GOAL: "Test entity extraction"

FLOW:
  get_name -> greet

  get_name:
    REASONING: false
    GATHER:
      - name: required
    THEN: greet

  greet:
    REASONING: false
    RESPOND: "Hello, {{name}}!"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Entity_Test'),
      );

      // Initialize flow
      await executor.initializeSession(session.id);

      // Send name
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Alice', (c) => chunks.push(c));

      // Should greet with the extracted name
      expect(chunks.join('')).toContain('Hello, Alice!');
      expect(session.isComplete).toBe(true);
      assertSessionHistoryIntegrity(session);
    });
  });

  describe('Supervisor Routing (unified AgentIR with routing config)', () => {
    test('should detect supervisor via routing rules and build routing config', () => {
      const dsl = `
SUPERVISOR: Test_Supervisor

GOAL: "Route user requests to appropriate specialists"

PERSONA: "Friendly routing assistant"

HANDOFF:
  - TO: Hotel_Agent
    WHEN: intent contains "hotel"
    CONTEXT:
      pass: [destination]
      summary: "User wants hotel help"
    RETURN: true

  - TO: Flight_Agent
    WHEN: intent contains "flight"
    CONTEXT:
      pass: [origin, destination]
      summary: "User wants flight help"
    RETURN: false

  - TO: Support_Agent
    WHEN: intent contains "help" OR intent contains "problem"
    CONTEXT:
      pass: []
      summary: "User needs support"
    RETURN: false

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Connected you with the right specialist."
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Test_Supervisor'),
      );

      // Verify it compiled to a valid AgentIR with routing config
      expect(session.agentIR).not.toBeNull();

      // Supervisor detection is now routing-based: ir.routing?.rules?.length > 0
      expect(session.agentIR?.routing?.rules?.length).toBeGreaterThan(0);

      // Verify routing rules are populated
      expect(session.agentIR?.routing?.rules).toBeDefined();
      expect(session.agentIR?.routing?.rules?.length).toBe(3);

      // Verify specific routing rules
      const rules = session.agentIR?.routing?.rules || [];
      expect(rules[0].to).toBe('Hotel_Agent');
      expect(rules[0].when).toContain('hotel');
      expect(rules[1].to).toBe('Flight_Agent');
      expect(rules[2].to).toBe('Support_Agent');

      // Verify available_agents is populated
      expect(session.agentIR?.available_agents).toContain('Hotel_Agent');
      expect(session.agentIR?.available_agents).toContain('Flight_Agent');
      expect(session.agentIR?.available_agents).toContain('Support_Agent');
    });

    test('should build handoff tool with correct targets for supervisor', () => {
      const dsl = `
SUPERVISOR: Routing_Test

GOAL: "Route requests"

HANDOFF:
  - TO: Agent_A
    WHEN: intent == "a"
    CONTEXT:
      summary: "Route to A"
    RETURN: true

  - TO: Agent_B
    WHEN: intent == "b"
    CONTEXT:
      summary: "Route to B"
    RETURN: false
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Routing_Test'),
      );

      // Supervisor detection is routing-based: ir.routing?.rules?.length > 0
      expect(session.agentIR?.routing?.rules?.length).toBeGreaterThan(0);

      // Verify return flags are captured in routing rules
      const rules = session.agentIR?.routing?.rules || [];
      expect(rules[0].to).toBe('Agent_A');
      expect(rules[1].to).toBe('Agent_B');
    });
  });

  describe('Scripted Flow Handoff-on-Complete', () => {
    test('should trigger handoff instead of completing when handoff condition matches', async () => {
      // Scripted agent that sets detected_intent via ON_INPUT, then transitions to COMPLETE
      // with a HANDOFF condition that should fire before completion
      const welcomeDsl = `
AGENT: Welcome_Agent

GOAL: "Welcome and route users"

FLOW:
  greet -> detect_intent

  greet:
    REASONING: false
    RESPOND: "Welcome! How can I help?"
    THEN: detect_intent

  detect_intent:
    REASONING: false
    GATHER:
      - user_request: required
    ON_INPUT:
      - IF: input contains "book"
        SET: detected_intent = "new_booking"
        RESPOND: "Let me connect you with our booking specialist."
        THEN: COMPLETE
      - ELSE:
        RESPOND: "I can help with that."
        THEN: COMPLETE

HANDOFF:
  - TO: Sales_Agent
    WHEN: detected_intent == "new_booking"
    CONTEXT:
      pass: [detected_intent, user_request]
      summary: "User wants to make a booking"
    RETURN: false
`;

      // Register the target agent so handoff can find it
      const salesDsl = `
AGENT: Sales_Agent

GOAL: "Handle bookings"

FLOW:
  start -> done

  start:
    REASONING: false
    RESPOND: "I can help you with your booking!"
    THEN: done

  done:
    REASONING: false
    GATHER:
      - details: required
    THEN: COMPLETE
`;

      executor.registerAgent('Sales_Agent', salesDsl);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([welcomeDsl], 'Welcome_Agent'),
      );

      // Initialize flow
      const initChunks: string[] = [];
      await executor.initializeSession(session.id, (c) => initChunks.push(c));
      expect(initChunks.join('')).toContain('Welcome!');

      // Send a booking request - should trigger ON_INPUT → SET detected_intent → THEN: COMPLETE → handoff
      const chunks: string[] = [];
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(
        session.id,
        'I want to book a hotel',
        (c) => chunks.push(c),
        (e) => traceEvents.push(e),
      );

      const output = chunks.join('');

      // Handoff transfer message is now voice-only; non-voice channels rely on
      // trace events for UX. Verify the child agent's response is present instead.
      expect(output).toContain('I can help you with your booking');

      // Should NOT be marked as complete (handoff took over)
      expect(session.isComplete).not.toBe(true);

      // Verify a handoff trace event was emitted
      const handoffEvent = traceEvents.find((e) => e.type === 'handoff');
      expect(handoffEvent).toBeDefined();
      expect(handoffEvent?.data.to).toBe('Sales_Agent');
      // Handoff to scripted child with auto-advancing RESPOND → GATHER produces consecutive
      // assistant messages, so check for empty messages only (the critical API validation)
      assertNoEmptyUserMessages(
        session.conversationHistory,
        'handoff-on-complete conversationHistory',
      );
      assertNoEmptyMessages(session.conversationHistory, 'handoff-on-complete conversationHistory');
    });

    test('should complete normally when no handoff conditions are defined', async () => {
      const dsl = `
AGENT: Simple_Agent

GOAL: "Simple flow"

FLOW:
  start -> done

  start:
    REASONING: false
    RESPOND: "Hello!"
    THEN: done

  done:
    REASONING: false
    GATHER:
      - value: required
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Simple_Agent'),
      );

      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'test value');

      expect(session.isComplete).toBe(true);
      // Scripted flow with auto-advancing RESPOND → GATHER produces consecutive
      // assistant messages, so check for empty messages only
      assertNoEmptyUserMessages(session.conversationHistory, 'no-handoff conversationHistory');
      assertNoEmptyMessages(session.conversationHistory, 'no-handoff conversationHistory');
    });

    test('should complete normally when handoff conditions do not match', async () => {
      const dsl = `
AGENT: Conditional_Agent

GOAL: "Conditional handoff"

FLOW:
  start -> done

  start:
    REASONING: false
    RESPOND: "Hello!"
    THEN: done

  done:
    REASONING: false
    GATHER:
      - user_input: required
    ON_INPUT:
      - IF: input contains "book"
        SET: detected_intent = "new_booking"
        THEN: COMPLETE
      - ELSE:
        SET: detected_intent = "general"
        THEN: COMPLETE

HANDOFF:
  - TO: Booking_Agent
    WHEN: detected_intent == "new_booking"
    CONTEXT:
      pass: [detected_intent]
      summary: "Booking request"
    RETURN: false
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Conditional_Agent'),
      );

      await executor.initializeSession(session.id);

      // Send something that does NOT match the handoff condition
      await executor.executeMessage(session.id, 'just a question');

      // detected_intent is "general", not "new_booking" → handoff condition doesn't match → completes
      expect(session.isComplete).toBe(true);
      // Scripted flow with auto-advancing RESPOND → GATHER produces consecutive
      // assistant messages, so check for empty messages only
      assertNoEmptyUserMessages(
        session.conversationHistory,
        'no-match-handoff conversationHistory',
      );
      assertNoEmptyMessages(session.conversationHistory, 'no-match-handoff conversationHistory');
    });
  });

  describe('Input Guardrail History Persistence', () => {
    test('persists the sanitized user message for blocked reasoning turns', async () => {
      const { RuntimeExecutor: GuardrailedExecutor, compileToResolvedAgent: compileAgent } =
        await loadRuntimeExecutorWithGuardrailResult({
          passed: false,
          modifiedContent: 'contact me at [REDACTED_EMAIL]',
          primaryViolation: {
            name: 'policy-input-guardrail',
            action: 'block',
            message: 'Input blocked',
          },
        });

      const executor = new GuardrailedExecutor();
      const dsl = `
AGENT: Guardrailed_Reasoning

GOAL: "Test blocked reasoning history"

PERSONA: "Helpful assistant"
`;

      const session = executor.createSessionFromResolved(
        compileAgent([dsl], 'Guardrailed_Reasoning'),
      );

      const result = await executor.executeMessage(session.id, 'contact me at user@example.com');
      const updatedSession = executor.getSession(session.id) ?? session;
      const userEntries = updatedSession.conversationHistory.filter(
        (entry) => entry.role === 'user',
      );

      expect(result.response).toBe('Input blocked');
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0].content).toBe('contact me at [REDACTED_EMAIL]');
      expect(userEntries[0].content).not.toContain('user@example.com');
      expect(updatedSession.conversationHistory.at(-1)?.content).toBe('Input blocked');
    });

    test('stamps sanitized input and raw input before reasoning execution begins', async () => {
      const { RuntimeExecutor: GuardrailedExecutor, compileToResolvedAgent: compileAgent } =
        await loadRuntimeExecutorWithGuardrailResult({
          passed: true,
          modifiedContent: 'contact me at [REDACTED_EMAIL]',
          primaryViolation: undefined,
        });

      const executor = new GuardrailedExecutor();
      const dsl = `
AGENT: Sanitized_Reasoning

GOAL: "Verify reasoning turn input context"

PERSONA: "Reasoning input contract verifier"

CONSTRAINTS:
  - REQUIRE input contains "[REDACTED_EMAIL]"
    ON_FAIL: RESPOND "Sanitized input missing."
`;

      const session = executor.createSessionFromResolved(
        compileAgent([dsl], 'Sanitized_Reasoning'),
      );
      session.initialized = true;
      session.llmClient = {} as any;

      const reasoningExecute = vi.fn(async (runtimeSession: any) => {
        expect(runtimeSession.data.values.input).toBe('contact me at [REDACTED_EMAIL]');
        expect(runtimeSession.data.values._raw_input).toBe('contact me at user@example.com');
        expect(runtimeSession.conversationHistory.at(-1)?.content).toBe(
          'contact me at [REDACTED_EMAIL]',
        );

        return {
          response: 'Reasoning saw sanitized input.',
          action: { type: 'respond' },
        };
      });
      (executor as any).reasoning.execute = reasoningExecute;

      const result = await executor.executeMessage(session.id, 'contact me at user@example.com');
      const updatedSession = executor.getSession(session.id) ?? session;
      const userEntries = updatedSession.conversationHistory.filter(
        (entry) => entry.role === 'user',
      );

      expect(result.response).toBe('Reasoning saw sanitized input.');
      expect(reasoningExecute).toHaveBeenCalledOnce();
      expect(updatedSession.data.values.input).toBe('contact me at [REDACTED_EMAIL]');
      expect(updatedSession.data.values._raw_input).toBe('contact me at user@example.com');
      expect(userEntries.at(-1)?.content).toBe('contact me at [REDACTED_EMAIL]');
    });

    test('keeps replay-time sanitization transient while stamping sanitized replay context', async () => {
      const originalIntent = 'check my balance for user@example.com';
      const sanitizedIntent = 'check my balance for [REDACTED_EMAIL]';
      const { RuntimeExecutor: GuardrailedExecutor, compileToResolvedAgent: compileAgent } =
        await loadRuntimeExecutorWithGuardrailResult((content) => {
          if (content === originalIntent) {
            return {
              passed: true,
              modifiedContent: sanitizedIntent,
              primaryViolation: undefined,
            };
          }
          return {
            passed: true,
            modifiedContent: undefined,
            primaryViolation: undefined,
          };
        });

      const executor = new GuardrailedExecutor();
      (executor as any).llmWiring.wireLLMClient = async (runtimeSession: any) => {
        runtimeSession.llmClient = {} as any;
      };
      (executor as any).llmWiring.ensureSessionLLMClient = async (runtimeSession: any) => {
        if (!runtimeSession.llmClient) {
          runtimeSession.llmClient = {} as any;
        }
      };

      const parentDsl = `
AGENT: Replay_Parent

GOAL: "Verify replay sanitization stays transient to execution context"

PERSONA: "Replay guardrail contract verifier"

HANDOFF:
  - TO: VerifyChild
    WHEN: input contains "balance"
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
`;

      const childDsl = `
AGENT: VerifyChild

GOAL: "Verify the customer before resuming the parent"

PERSONA: "Verification specialist"

COMPLETE:
  - WHEN: authenticated == "yes"
    RESPOND: "Verified."
`;

      executor.registerAgent('VerifyChild', childDsl);
      const session = executor.createSessionFromResolved(
        compileAgent([parentDsl], 'Replay_Parent'),
      );
      session.initialized = true;
      session.handoffReturnInfo = { VerifyChild: true };
      session.conversationHistory.push({ role: 'user', content: originalIntent });

      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      const reasoningExecute = vi.fn(async (runtimeSession: any) => {
        if (runtimeSession.agentName === 'VerifyChild') {
          if (runtimeSession.data.values.input === 'yes verified') {
            runtimeSession.data.values.authenticated = 'yes';
            return {
              response: 'Verified.',
              action: { type: 'respond' },
            };
          }

          return {
            response: 'Please verify your identity.',
            action: { type: 'respond' },
          };
        }

        expect(runtimeSession.agentName).toBe('Replay_Parent');
        expect(runtimeSession.data.values.input).toBe(sanitizedIntent);
        expect(runtimeSession.data.values._raw_input).toBe(originalIntent);
        expect(
          runtimeSession.conversationHistory
            .filter((entry: { role: string }) => entry.role === 'user')
            .map((entry: { content: unknown }) => entry.content),
        ).toEqual([originalIntent]);

        return {
          response: 'Sanitized replay observed.',
          action: { type: 'respond' },
        };
      });
      (executor as any).reasoning.execute = reasoningExecute;

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const initialResult = await handleHandoff(
        session,
        { target: 'VerifyChild', message: originalIntent },
        undefined,
        (event: { type: string; data: Record<string, unknown> }) => traces.push(event),
      );

      expect(initialResult.success).toBe(true);
      expect(session.agentName).toBe('VerifyChild');

      const result = await executor.executeMessage(session.id, 'yes verified', undefined, (event) =>
        traces.push(event),
      );
      const updatedSession = executor.getSession(session.id) ?? session;
      const parentUserEntries = updatedSession.threads[0]?.conversationHistory.filter(
        (entry) => entry.role === 'user',
      );

      expect(result.response).toBe('Sanitized replay observed.');
      expect(reasoningExecute).toHaveBeenCalledTimes(3);
      expect(updatedSession.data.values.input).toBe(sanitizedIntent);
      expect(updatedSession.data.values._raw_input).toBe(originalIntent);
      expect(parentUserEntries?.map((entry) => entry.content)).toEqual([originalIntent]);
      expect(
        traces.filter((event) => event.type === 'user_message').map((event) => event.data.message),
      ).toEqual(['yes verified']);
      expect(
        traces.filter((event) => event.type === 'user_message').map((event) => event.data.message),
      ).not.toContain(sanitizedIntent);
      expect(
        traces.filter((event) => event.type === 'user_message').map((event) => event.data.message),
      ).not.toContain(originalIntent);
    });

    test('rewrites the pre-appended flow user message after input guardrail sanitization', async () => {
      const executor = new RuntimeExecutor();
      const dsl = `
AGENT: Guardrailed_Flow

GOAL: "Test flow history rewrite"

FLOW:
  collect_note -> done

  collect_note:
    REASONING: false
    GATHER:
      - note: required
    THEN: done

  done:
    REASONING: false
    RESPOND: "Saved {{note}}"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Guardrailed_Flow'),
      );
      session.initialized = true;
      (executor as any).flowStep.executeFlowStep = vi.fn(async (flowSession: any) => {
        flowSession.data.values['input'] = 'contact me at [REDACTED_EMAIL]';
        flowSession.data.values['_raw_input'] = 'contact me at user@example.com';
        return {
          response: 'Saved contact me at [REDACTED_EMAIL]',
          action: { type: 'respond' },
        };
      });

      await executor.executeMessage(session.id, 'contact me at user@example.com');

      const updatedSession = executor.getSession(session.id) ?? session;
      const userEntries = updatedSession.conversationHistory.filter(
        (entry) => entry.role === 'user',
      );
      expect(userEntries, JSON.stringify(updatedSession.conversationHistory)).toHaveLength(1);
      expect(userEntries[0].content).toBe('contact me at [REDACTED_EMAIL]');
      expect(userEntries[0].content).not.toContain('user@example.com');
    });

    test('rewrites the pre-appended flow user message when input guardrails block with modified content', async () => {
      const { RuntimeExecutor: GuardrailedExecutor, compileToResolvedAgent: compileAgent } =
        await loadRuntimeExecutorWithGuardrailResult({
          passed: false,
          modifiedContent: 'contact me at [REDACTED_EMAIL]',
          primaryViolation: {
            name: 'policy-input-guardrail',
            action: 'block',
            message: 'Input blocked',
          },
        });

      const executor = new GuardrailedExecutor();
      const dsl = `
AGENT: Guardrailed_Flow_Block

GOAL: "Test blocked flow history rewrite"

FLOW:
  collect_note -> done

  collect_note:
    REASONING: false
    GATHER:
      - note: required
    THEN: done

  done:
    REASONING: false
    RESPOND: "Saved {{note}}"
    THEN: COMPLETE
`;

      const session = executor.createSessionFromResolved(
        compileAgent([dsl], 'Guardrailed_Flow_Block'),
      );
      session.initialized = true;

      const result = await executor.executeMessage(session.id, 'contact me at user@example.com');
      const updatedSession = executor.getSession(session.id) ?? session;
      const userEntries = updatedSession.conversationHistory.filter(
        (entry) => entry.role === 'user',
      );

      expect(result.response).toBe('Input blocked');
      expect(userEntries, JSON.stringify(updatedSession.conversationHistory)).toHaveLength(1);
      expect(userEntries[0].content).toBe('contact me at [REDACTED_EMAIL]');
      expect(userEntries[0].content).not.toContain('user@example.com');
      expect(updatedSession.conversationHistory.at(-1)?.content).toBe('Input blocked');
    });

    test('protects non-flow input guardrail block messages before streaming and history', async () => {
      const rawBlockContractId = '5a9b62f0-c899-43a4-a5a7-55ad6673b061';
      const { RuntimeExecutor: GuardrailedExecutor, compileToResolvedAgent: compileAgent } =
        await loadRuntimeExecutorWithGuardrailResult({
          passed: false,
          primaryViolation: {
            name: 'policy-input-guardrail',
            action: 'block',
            message: `Blocked contract ${rawBlockContractId}`,
          },
        });

      const executor = new GuardrailedExecutor();
      const dsl = `
AGENT: Guardrailed_Reasoning_Block

GOAL: "Test protected non-flow guardrail block"
`;

      const session = executor.createSessionFromResolved(
        compileAgent([dsl], 'Guardrailed_Reasoning_Block'),
      );
      const registry = new PIIRecognizerRegistry();
      registry.register(
        new RegexPIIRecognizer(
          'custom-contract-id',
          ['ContractID'],
          /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
          'ContractID',
          undefined,
          'custom',
        ),
      );
      session.initialized = true;
      session.piiRedactionConfig = { enabled: true, redactInput: true, redactOutput: true };
      session.piiRecognizerRegistry = registry;
      session.piiPatternConfigs = [
        {
          patternName: 'ContractID',
          defaultRenderMode: 'redacted',
          consumerAccess: [],
        },
      ];
      session.piiVault = new PIIVault({ recognizerRegistry: registry });
      const chunks: string[] = [];

      const result = await executor.executeMessage(session.id, 'blocked input', (chunk) => {
        chunks.push(chunk);
      });
      const updatedSession = executor.getSession(session.id) ?? session;
      const assistantEntry = updatedSession.conversationHistory.find(
        (entry) => entry.role === 'assistant',
      );

      expect(result.response).toBe('Blocked contract [REDACTED_CONTRACT_ID]');
      expect(result.response).not.toContain(rawBlockContractId);
      expect(chunks.join('')).toBe('Blocked contract [REDACTED_CONTRACT_ID]');
      expect(chunks.join('')).not.toContain(rawBlockContractId);
      expect(String(assistantEntry?.content)).toContain('{{PII:ContractID:');
      expect(String(assistantEntry?.content)).not.toContain(rawBlockContractId);
    });
  });
});
