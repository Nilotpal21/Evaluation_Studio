/**
 * Tests for multi-intent dispatch in the RoutingExecutor.
 *
 * Covers:
 * - handleMultiIntent() strategy dispatch
 * - handlePrimaryQueue: primary routes normally, alternatives queued
 * - handleSequentialIntents: correct ordering in queue
 * - handleDisambiguate: disambiguation message generated
 * - Strategy resolution called with correct params
 * - Trace event emission for observability
 * - resolveMultiIntentConfig: config precedence chain
 * - resolveAgentExecutionType: correct type derivation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MultiIntentResult } from '@abl/compiler/platform/nlu/types.js';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import {
  resolveMultiIntentConfig,
  resolveAgentExecutionType,
  MULTI_INTENT_PLATFORM_DEFAULTS,
} from '../../services/execution/routing-executor.js';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';

// =============================================================================
// FIXTURES
// =============================================================================

/**
 * Build a minimal AgentIR fixture with sensible defaults.
 * Overrides can be passed in to customize the IR for specific tests.
 */
function buildAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'test-hash',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      max_turns: 10,
      max_tool_iterations: 5,
    },
    identity: {
      name: 'Test Agent',
      goal: 'Help users',
      persona: '',
    },
    tools: [],
    gather: { fields: [], mode: 'conversational', strategy: 'progressive' },
    memory: { enabled: false },
    constraints: { rules: [] },
    coordination: { handoffs: [], delegates: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_action: 'respond' },
    ...overrides,
  } as AgentIR;
}

/**
 * Build a MultiIntentResult fixture.
 */
function buildMultiIntentResult(overrides: Partial<MultiIntentResult> = {}): MultiIntentResult {
  return {
    primary: {
      intent: 'book_flight',
      confidence: 0.92,
      source: 'llm',
    },
    alternatives: [
      {
        intent: 'book_hotel',
        confidence: 0.85,
        source: 'llm',
      },
      {
        intent: 'rent_car',
        confidence: 0.72,
        source: 'llm',
      },
    ],
    relationships: {
      type: 'independent',
      reasoning: 'These are separate travel bookings',
    },
    ...overrides,
  };
}

/**
 * Build a minimal mock RuntimeSession.
 */
function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-123',
    agentName: 'test_agent',
    agentIR: buildAgentIR(),
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: true,
    threads: [
      {
        agentName: 'test_agent',
        agentIR: null,
        status: 'active',
        conversationHistory: [],
        data: { values: {}, gatheredKeys: new Set<string>() },
        state: {},
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  };
}

// =============================================================================
// resolveMultiIntentConfig
// =============================================================================

describe('resolveMultiIntentConfig', () => {
  it('returns platform defaults when no agent or project config exists', () => {
    const ir = buildAgentIR();
    const config = resolveMultiIntentConfig(ir);
    expect(config).toEqual(MULTI_INTENT_PLATFORM_DEFAULTS);
  });

  it('project-level config overrides platform defaults', () => {
    const ir = buildAgentIR({
      project_runtime_config: {
        extraction_strategy: 'auto',
        multi_intent: {
          enabled: false,
          strategy: 'sequential',
          max_intents: 5,
          confidence_threshold: 0.8,
          queue_max_age_ms: 300_000,
        },
        inference: {
          confidence: 0.8,
          confirm: true,
          model_tier: 'fast',
          max_fields_per_pass: 3,
        },
        conversion: { currency_mode: 'static' },
        lookup_tables: [],
      },
    });
    const config = resolveMultiIntentConfig(ir);
    expect(config.enabled).toBe(false);
    expect(config.strategy).toBe('sequential');
    expect(config.max_intents).toBe(5);
    expect(config.confidence_threshold).toBe(0.8);
    expect(config.queue_max_age_ms).toBe(300_000);
  });

  it('agent-level config overrides project-level and platform defaults', () => {
    const ir = buildAgentIR({
      project_runtime_config: {
        extraction_strategy: 'auto',
        multi_intent: {
          enabled: true,
          strategy: 'sequential',
          max_intents: 5,
          confidence_threshold: 0.7,
          queue_max_age_ms: 300_000,
        },
        inference: {
          confidence: 0.8,
          confirm: true,
          model_tier: 'fast',
          max_fields_per_pass: 3,
        },
        conversion: { currency_mode: 'static' },
        lookup_tables: [],
      },
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 2,
          confidence_threshold: 0.9,
          queue_max_age_ms: 120_000,
        },
      },
    });
    const config = resolveMultiIntentConfig(ir);
    // Agent-level wins
    expect(config.strategy).toBe('disambiguate');
    expect(config.max_intents).toBe(2);
    expect(config.confidence_threshold).toBe(0.9);
    expect(config.queue_max_age_ms).toBe(120_000);
  });

  it('partial agent-level config merges with project and platform defaults', () => {
    const ir = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'parallel',
          max_intents: 4,
          confidence_threshold: 0.5,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const config = resolveMultiIntentConfig(ir);
    expect(config.strategy).toBe('parallel');
    expect(config.max_intents).toBe(4);
    // Remaining fields from platform defaults
    expect(config.queue_max_age_ms).toBe(600_000);
  });
});

// =============================================================================
// resolveAgentExecutionType
// =============================================================================

describe('resolveAgentExecutionType', () => {
  it('returns supervisor for supervisor agents', () => {
    const ir = buildAgentIR({
      metadata: {
        name: 'supervisor_agent',
        version: '1.0.0',
        type: 'supervisor',
        compiled_at: new Date().toISOString(),
        source_hash: 'test-hash',
        compiler_version: '1.0.0',
      },
    });
    expect(resolveAgentExecutionType(ir)).toBe('supervisor');
  });

  it('returns scripted when flow section is present', () => {
    const ir = buildAgentIR({
      flow: {
        steps: ['greeting', 'collect_info'],
        definitions: {},
      },
    });
    expect(resolveAgentExecutionType(ir)).toBe('scripted');
  });

  it('returns scripted via backward-compat mode when no flow', () => {
    const ir = buildAgentIR({
      execution: { mode: 'scripted', max_turns: 10, max_tool_iterations: 5 },
    });
    expect(resolveAgentExecutionType(ir)).toBe('scripted');
  });

  it('returns reasoning for reasoning agents', () => {
    const ir = buildAgentIR({
      execution: { mode: 'reasoning', max_turns: 10, max_tool_iterations: 5 },
    });
    expect(resolveAgentExecutionType(ir)).toBe('reasoning');
  });

  it('returns reasoning when execution mode is undefined and no flow', () => {
    const ir = buildAgentIR();
    delete (ir.execution as Record<string, unknown>).mode;
    expect(resolveAgentExecutionType(ir)).toBe('reasoning');
  });

  it('flow presence takes precedence over execution.mode reasoning', () => {
    const ir = buildAgentIR({
      execution: { mode: 'reasoning', max_turns: 10, max_tool_iterations: 5 },
      flow: {
        steps: ['step_one'],
        definitions: {},
      },
    });
    expect(resolveAgentExecutionType(ir)).toBe('scripted');
  });
});

// =============================================================================
// RoutingExecutor.handleMultiIntent — via integration-style tests
// =============================================================================

/**
 * Since RoutingExecutor requires complex dependencies (ExecutorContext, LLMWiringService),
 * we test the handleMultiIntent method by constructing a minimal mock instance.
 * The method itself is pure enough to test with mocked dependencies.
 */
describe('RoutingExecutor.handleMultiIntent', () => {
  // We import the RoutingExecutor class and create a minimal instance with mocked deps
  let RoutingExecutor: typeof import('../services/execution/routing-executor.js').RoutingExecutor;
  let executor: InstanceType<
    typeof import('../services/execution/routing-executor.js').RoutingExecutor
  >;
  let traceEvents: Array<{ type: string; data: Record<string, unknown> }>;
  let onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void;

  beforeEach(async () => {
    const mod = await import('../../services/execution/routing-executor.js');
    RoutingExecutor = mod.RoutingExecutor;

    // Minimal ExecutorContext mock
    const mockCtx = {
      executeMessage: vi.fn(),
      agentRegistry: {},
      config: { maxConcurrentFanOutCalls: 5, timeoutMs: 30000 },
      sessions: new Map(),
      markExecuting: vi.fn(),
      unmarkExecuting: vi.fn(),
      cancelPendingPersist: vi.fn(),
    };

    // Minimal LLMWiringService mock
    const mockLLMWiring = {
      wireLLMClient: vi.fn(),
      wireToolExecutor: vi.fn(),
      clearCooldown: vi.fn(),
    };

    executor = new RoutingExecutor(mockCtx as never, mockLLMWiring as never);

    traceEvents = [];
    onTraceEvent = (event) => traceEvents.push(event);
  });

  // ---------------------------------------------------------------------------
  // Strategy resolution
  // ---------------------------------------------------------------------------

  describe('strategy resolution', () => {
    it('resolves strategy with correct params and emits decision trace event', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'I want to book a flight and a hotel',
        onTraceEvent,
      );

      // Platform default strategy is primary_queue, reasoning agent, independent relationship
      // resolveStrategy('primary_queue', 'reasoning', 'independent') → 'primary_queue'
      expect(result.strategy).toBe('primary_queue');

      // Check trace events were emitted
      const decisionEvent = traceEvents.find(
        (e) => e.type === 'decision' && e.data.type === 'multi_intent_dispatch',
      );
      expect(decisionEvent).toBeDefined();
      expect(decisionEvent!.data.declaredStrategy).toBe('primary_queue');
      expect(decisionEvent!.data.effectiveStrategy).toBe('primary_queue');
      expect(decisionEvent!.data.agentType).toBe('reasoning');
      expect(decisionEvent!.data.relationship).toBe('independent');
      expect(decisionEvent!.data.primaryIntent).toBe('book_flight');
      expect(decisionEvent!.data.alternativeCount).toBe(2);
    });

    it('uses auto strategy that resolves to parallel for supervisor with independent intents', () => {
      const agentIR = buildAgentIR({
        metadata: {
          name: 'supervisor_agent',
          version: '1.0.0',
          type: 'supervisor',
          compiled_at: new Date().toISOString(),
          source_hash: 'test-hash',
          compiler_version: '1.0.0',
        },
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'auto',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test message',
        onTraceEvent,
      );

      expect(result.strategy).toBe('parallel');
    });

    it('uses auto strategy that resolves to disambiguate for ambiguous relationship', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'auto',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult({
        relationships: {
          type: 'ambiguous',
          reasoning: 'Unclear if related or separate',
        },
      });

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test message',
        onTraceEvent,
      );

      expect(result.strategy).toBe('disambiguate');
    });
  });

  // ---------------------------------------------------------------------------
  // handlePrimaryQueue
  // ---------------------------------------------------------------------------

  describe('handlePrimaryQueue', () => {
    it('routes primary intent and queues alternatives', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'I want to book a flight and a hotel',
        onTraceEvent,
      );

      expect(result.strategy).toBe('primary_queue');
      expect(result.primaryIntent).toBe('book_flight');
      expect(result.queued).toBe(true);

      // Verify intent queue was created and populated
      const typedSession = session as { intentQueue?: { pending: Array<{ intent: string }> } };
      expect(typedSession.intentQueue).toBeDefined();
      expect(typedSession.intentQueue!.pending.length).toBe(2);
      expect(typedSession.intentQueue!.pending[0].intent).toBe('book_hotel');
      expect(typedSession.intentQueue!.pending[1].intent).toBe('rent_car');
    });

    it('does not queue when no alternatives exist', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult({ alternatives: [] });

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'I want to book a flight',
        onTraceEvent,
      );

      expect(result.strategy).toBe('primary_queue');
      expect(result.queued).toBe(false);
    });

    it('emits multi_intent_queued trace event', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'book flight and hotel',
        onTraceEvent,
      );

      const queueEvent = traceEvents.find(
        (e) => e.type === 'decision' && e.data.type === 'multi_intent_queued',
      );
      expect(queueEvent).toBeDefined();
      expect(queueEvent!.data.primaryIntent).toBe('book_flight');
      expect(queueEvent!.data.queuedIntents).toEqual(['book_hotel', 'rent_car']);
      expect(queueEvent!.data.queueSize).toBe(2);
    });

    it('preserves existing intent queue entries when adding new ones', () => {
      const session = buildSession({
        intentQueue: {
          pending: [
            {
              intent: 'existing_intent',
              confidence: 0.95,
              original_message: 'old message',
              detected_at: new Date().toISOString(),
            },
          ],
        },
      });
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'I want to book a flight and a hotel',
        onTraceEvent,
      );

      const typedSession = session as { intentQueue?: { pending: Array<{ intent: string }> } };
      // existing_intent has higher confidence (0.95) so it stays first
      expect(typedSession.intentQueue!.pending.length).toBe(3);
      expect(typedSession.intentQueue!.pending[0].intent).toBe('existing_intent');
    });

    it('filters out alternatives with null intents', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult({
        alternatives: [
          { intent: 'book_hotel', confidence: 0.85, source: 'llm' },
          { intent: null, confidence: 0.4, source: 'llm' },
        ],
      });

      executor.handleMultiIntent(session as never, multiResult, agentIR, 'test', onTraceEvent);

      const typedSession = session as { intentQueue?: { pending: Array<{ intent: string }> } };
      expect(typedSession.intentQueue!.pending.length).toBe(1);
      expect(typedSession.intentQueue!.pending[0].intent).toBe('book_hotel');
    });
  });

  // ---------------------------------------------------------------------------
  // handleSequentialIntents
  // ---------------------------------------------------------------------------

  describe('handleSequentialIntents', () => {
    it('stores alternatives as ordered execution plan', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'sequential',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'book flight, hotel, and car',
        onTraceEvent,
      );

      expect(result.strategy).toBe('sequential');
      expect(result.primaryIntent).toBe('book_flight');
      expect(result.queued).toBe(true);
      expect(result.executionPlan).toEqual([
        { intent: 'book_hotel', confidence: 0.85 },
        { intent: 'rent_car', confidence: 0.72 },
      ]);
    });

    it('enqueues alternatives in the intent queue for sequential processing', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'sequential',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'book flight and hotel',
        onTraceEvent,
      );

      const typedSession = session as { intentQueue?: { pending: Array<{ intent: string }> } };
      expect(typedSession.intentQueue).toBeDefined();
      expect(typedSession.intentQueue!.pending.length).toBe(2);
    });

    it('emits multi_intent_sequential trace event', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'sequential',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(session as never, multiResult, agentIR, 'test', onTraceEvent);

      const seqEvent = traceEvents.find(
        (e) => e.type === 'decision' && e.data.type === 'multi_intent_sequential',
      );
      expect(seqEvent).toBeDefined();
      expect(seqEvent!.data.executionPlan).toEqual([
        { intent: 'book_hotel', confidence: 0.85 },
        { intent: 'rent_car', confidence: 0.72 },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // handleParallelIntents (supervisor only)
  // ---------------------------------------------------------------------------

  describe('handleParallelIntents', () => {
    it('builds fan-out tasks from all intents for supervisor agents', () => {
      const agentIR = buildAgentIR({
        metadata: {
          name: 'supervisor_agent',
          version: '1.0.0',
          type: 'supervisor',
          compiled_at: new Date().toISOString(),
          source_hash: 'test-hash',
          compiler_version: '1.0.0',
        },
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'parallel',
            max_intents: 5,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'book flight and hotel',
        onTraceEvent,
      );

      expect(result.strategy).toBe('parallel');
      expect(result.queued).toBe(false);
      expect(result.fanOutTasks).toBeDefined();
      expect(result.fanOutTasks!.length).toBe(3); // primary + 2 alternatives
      expect(result.fanOutTasks!.map((t) => t.target)).toEqual([
        'book_flight',
        'book_hotel',
        'rent_car',
      ]);
    });

    it('emits multi_intent_parallel trace event', () => {
      const agentIR = buildAgentIR({
        metadata: {
          name: 'supervisor_agent',
          version: '1.0.0',
          type: 'supervisor',
          compiled_at: new Date().toISOString(),
          source_hash: 'test-hash',
          compiler_version: '1.0.0',
        },
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'parallel',
            max_intents: 5,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(session as never, multiResult, agentIR, 'test', onTraceEvent);

      const parEvent = traceEvents.find(
        (e) => e.type === 'decision' && e.data.type === 'multi_intent_parallel',
      );
      expect(parEvent).toBeDefined();
      expect(parEvent!.data.taskCount).toBe(3);
    });

    it('downgrades to sequential for non-supervisor agents', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'parallel',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test',
        onTraceEvent,
      );

      // parallel for reasoning agent gets downgraded to sequential
      expect(result.strategy).toBe('sequential');
    });
  });

  // ---------------------------------------------------------------------------
  // handleDisambiguate
  // ---------------------------------------------------------------------------

  describe('handleDisambiguate', () => {
    it('generates disambiguation message listing detected intents', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'disambiguate',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'I need help with travel',
        onTraceEvent,
      );

      expect(result.strategy).toBe('disambiguate');
      expect(result.disambiguationMessage).toBeDefined();
      expect(result.disambiguationMessage).toContain('book_flight');
      expect(result.disambiguationMessage).toContain('book_hotel');
      expect(result.disambiguationMessage).toContain('rent_car');
      expect(result.queued).toBe(false);
    });

    it('sets session waitingForInput to disambiguation marker', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'disambiguate',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'I need help',
        onTraceEvent,
      );

      expect(session.waitingForInput).toEqual(['_disambiguation_choice']);
    });

    it('emits multi_intent_disambiguate trace event', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'disambiguate',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(session as never, multiResult, agentIR, 'test', onTraceEvent);

      const disambigEvent = traceEvents.find(
        (e) => e.type === 'decision' && e.data.type === 'multi_intent_disambiguate',
      );
      expect(disambigEvent).toBeDefined();
      expect(disambigEvent!.data.message).toBeDefined();
      expect((disambigEvent!.data.intents as Array<{ intent: string }>).length).toBe(3);
    });

    it('uses custom agent messages when available', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'disambiguate',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
        messages: {
          multi_intent_disambiguate_header: 'Which would you like first?',
        } as Record<string, string>,
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult();

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test',
        onTraceEvent,
      );

      expect(result.disambiguationMessage).toContain('Which would you like first?');
    });

    it('uses locale catalog messages for disambiguation copy when present on the session', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'disambiguate',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      session.data.values._locale = 'fr-FR';
      storeSessionLocalizationCatalog(
        session.data,
        buildSessionLocalizationCatalog({
          'locale:fr/test_agent.json': JSON.stringify({
            multi_intent_disambiguate_header: 'Quelle demande dois-je traiter en premier ?',
            multi_intent_disambiguate_option: '{{index}}. {{intent}} ({{confidence}} %)',
          }),
        }),
      );
      const multiResult = buildMultiIntentResult({
        relationships: {
          type: 'ambiguous',
          reasoning: 'User needs to choose the next request',
        },
      });

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test',
        onTraceEvent,
      );

      expect(result.disambiguationMessage).toContain('Quelle demande dois-je traiter en premier ?');
      expect(result.disambiguationMessage).toContain('1. book_flight (92 %)');
    });
  });

  // ---------------------------------------------------------------------------
  // Trace event emission
  // ---------------------------------------------------------------------------

  describe('trace event emission', () => {
    it('emits multi_intent_dispatch decision event for all strategies', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(session as never, multiResult, agentIR, 'test', onTraceEvent);

      const dispatchEvent = traceEvents.find(
        (e) => e.type === 'decision' && e.data.type === 'multi_intent_dispatch',
      );
      expect(dispatchEvent).toBeDefined();
      expect(dispatchEvent!.data.agentName).toBe('test_agent');
    });

    it('does not emit trace events when onTraceEvent is undefined', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult();

      // Should not throw when no trace callback provided
      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test',
        undefined,
      );

      expect(result.strategy).toBe('primary_queue');
    });

    it('includes alternative intents in dispatch trace event', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult();

      executor.handleMultiIntent(session as never, multiResult, agentIR, 'test', onTraceEvent);

      const dispatchEvent = traceEvents.find(
        (e) => e.type === 'decision' && e.data.type === 'multi_intent_dispatch',
      );
      const alternatives = dispatchEvent!.data.alternatives as Array<{
        intent: string;
        confidence: number;
      }>;
      expect(alternatives).toEqual([
        { intent: 'book_hotel', confidence: 0.85 },
        { intent: 'rent_car', confidence: 0.72 },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles multiResult with no alternatives gracefully', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult({ alternatives: [] });

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test',
        onTraceEvent,
      );

      expect(result.strategy).toBe('primary_queue');
      expect(result.queued).toBe(false);
    });

    it('handles primary intent with null intent field', () => {
      const session = buildSession();
      const agentIR = buildAgentIR();
      const multiResult = buildMultiIntentResult({
        primary: { intent: null, confidence: 0.5, source: 'llm' },
      });

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test',
        onTraceEvent,
      );

      expect(result.primaryIntent).toBe('');
    });

    it('handles dependent relationship with sequential strategy', () => {
      const agentIR = buildAgentIR({
        intent_handling: {
          multi_intent: {
            enabled: true,
            strategy: 'auto',
            max_intents: 3,
            confidence_threshold: 0.6,
            queue_max_age_ms: 600_000,
          },
        },
      });
      const session = buildSession({ agentIR });
      const multiResult = buildMultiIntentResult({
        relationships: {
          type: 'dependent',
          reasoning: 'Hotel booking depends on flight dates',
        },
      });

      const result = executor.handleMultiIntent(
        session as never,
        multiResult,
        agentIR,
        'test',
        onTraceEvent,
      );

      // auto + dependent → sequential
      expect(result.strategy).toBe('sequential');
    });
  });
});
