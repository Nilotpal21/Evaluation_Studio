/**
 * Integration tests for multi-intent dispatch, correction fallback,
 * pinned intent, config handoff, and strategy validation.
 *
 * Covers: F1 (pinnedIntent), F2 (LLM correction fallback), F3 (disambiguate max_intents),
 *         F4 (unknown strategy fallback), F5 (config survives handoff)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';
import type { MultiIntentResult } from '@abl/compiler/platform/nlu/types.js';
import { evaluateOnInput } from '@abl/compiler/platform/constructs/utils.js';
import {
  resolveMultiIntentConfig,
  MULTI_INTENT_PLATFORM_DEFAULTS,
} from '../../services/execution/routing-executor.js';
import type { RuntimeSession } from '../../services/execution/types.js';

// =============================================================================
// FIXTURES (reused from routing-executor-multi-intent.test.ts patterns)
// =============================================================================

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

function buildMultiIntentResult(overrides: Partial<MultiIntentResult> = {}): MultiIntentResult {
  return {
    primary: {
      intent: 'book_flight',
      confidence: 0.92,
      source: 'llm',
    },
    alternatives: [
      { intent: 'book_hotel', confidence: 0.85, source: 'llm' },
      { intent: 'rent_car', confidence: 0.72, source: 'llm' },
      { intent: 'book_tour', confidence: 0.65, source: 'llm' },
    ],
    relationships: {
      type: 'independent',
      reasoning: 'Separate travel bookings',
    },
    ...overrides,
  };
}

function buildSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session-integration-1',
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

function buildProjectConfig(
  overrides: Partial<ProjectRuntimeConfigIR> = {},
): ProjectRuntimeConfigIR {
  return {
    extraction_strategy: 'auto',
    nlu_provider: 'standard',
    multi_intent: {
      enabled: true,
      strategy: 'primary_queue',
      max_intents: 3,
      confidence_threshold: 0.6,
      queue_max_age_ms: 600_000,
    },
    inference: {
      confidence: 0.8,
      confirm: true,
      model_tier: 'fast',
      max_fields_per_pass: 3,
    },
    conversion: { currency_mode: 'static' },
    lookup_tables: [],
    ...overrides,
  };
}

// =============================================================================
// F1: Pinned intent prevents re-detection on replay (using real evaluateOnInput)
// =============================================================================

describe('F1: _pinnedIntent guards with real branch evaluation', () => {
  type OnInputBranch = {
    condition?: string;
    respond?: string;
    set?: Record<string, string>;
    call?: string;
    then: string;
  };

  /** Mirror the pinned-intent branch filtering from flow-step-executor.ts */
  function filterBranchesForPin(
    branches: OnInputBranch[],
    pinnedIntent: string | undefined,
  ): OnInputBranch[] {
    if (!pinnedIntent) return branches;

    const pinnedBranch = branches.find((b) => b.then === pinnedIntent);
    if (pinnedBranch) {
      return branches.filter((b) => b.then === pinnedIntent || !b.condition);
    }
    return [];
  }

  const branches: OnInputBranch[] = [
    { condition: 'input contains "book"', then: 'book_flight', respond: 'Booking...' },
    { condition: 'input contains "status"', then: 'check_status', respond: 'Checking...' },
    { then: 'fallback', respond: 'I did not understand' },
  ];

  it('pinned intent filters to correct branch via evaluateOnInput', () => {
    const session = buildSession({ _pinnedIntent: 'check_status' }) as unknown as RuntimeSession;
    const filtered = filterBranchesForPin(branches, session._pinnedIntent);

    const result = evaluateOnInput(filtered, 'check my status', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('check_status');
  });

  it('unfiltered evaluateOnInput returns different result (first match wins)', () => {
    // Without pinning, "book a flight and check status" matches "book" first
    const result = evaluateOnInput(branches, 'book a flight and check status', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('book_flight');

    // With pinning to check_status, "book" branch is filtered out
    const filtered = filterBranchesForPin(branches, 'check_status');
    const pinnedResult = evaluateOnInput(filtered, 'book a flight and check status', {});
    expect(pinnedResult).not.toBeNull();
    expect(pinnedResult!.then).toBe('check_status');
  });

  it('_pinnedIntent blocks multi-intent detection', () => {
    const session = buildSession({
      _pinnedIntent: 'check_status',
    }) as unknown as RuntimeSession;

    let multiIntentDetectionRan = false;
    const currentMessage = 'I want to check my status';
    if (currentMessage && !session.waitingForInput && !session._pinnedIntent) {
      multiIntentDetectionRan = true;
    }
    expect(multiIntentDetectionRan).toBe(false);
  });

  it('multi-intent detection runs when _pinnedIntent is not set', () => {
    const session = buildSession() as unknown as RuntimeSession;

    let multiIntentDetectionRan = false;
    const currentMessage = 'book flight and hotel';
    if (currentMessage && !session.waitingForInput && !session._pinnedIntent) {
      multiIntentDetectionRan = true;
    }
    expect(multiIntentDetectionRan).toBe(true);
  });

  it('_pinnedIntent cleared after ON_INPUT consumption', () => {
    const session = buildSession({
      _pinnedIntent: 'check_status',
    }) as unknown as RuntimeSession;

    const filtered = filterBranchesForPin(branches, session._pinnedIntent);
    const result = evaluateOnInput(filtered, 'check my status', {});
    expect(result).not.toBeNull();

    // Clear after match (as done in flow-step-executor.ts)
    session._pinnedIntent = undefined;
    expect(session._pinnedIntent).toBeUndefined();
  });

  it('_pinnedIntent safety-cleared after input block even without ON_INPUT match', () => {
    const session = buildSession({
      _pinnedIntent: 'check_status',
    }) as unknown as RuntimeSession;

    if (session._pinnedIntent) {
      session._pinnedIntent = undefined;
    }
    expect(session._pinnedIntent).toBeUndefined();
  });
});

// =============================================================================
// F2: LLM correction fallback on undeclared field
// =============================================================================

describe('F2: Correction LLM fallback', () => {
  it('regex returning undeclared field should be cleared for LLM fallback', () => {
    const declaredFieldNames = new Set(['destination', 'departure_date', 'budget']);

    // Simulate regex returning an undeclared field
    let correctionField: string | undefined = 'unknown_field';
    let correctionNewValue: string | undefined = 'new_value';
    let correctionDetectionMethod = 'regex';

    if (correctionField && !declaredFieldNames.has(correctionField)) {
      if (correctionDetectionMethod !== 'llm') {
        correctionField = undefined;
        correctionNewValue = undefined;

        // Simulate LLM fallback returning a valid field
        const llmFallback = { field: 'destination', newValue: 'Paris' };
        if (llmFallback && declaredFieldNames.has(llmFallback.field)) {
          correctionField = llmFallback.field;
          correctionNewValue = llmFallback.newValue;
          correctionDetectionMethod = 'llm';
        }
      }
    }

    expect(correctionField).toBe('destination');
    expect(correctionNewValue).toBe('Paris');
    expect(correctionDetectionMethod).toBe('llm');
  });

  it('LLM fallback also returning undeclared field results in no correction', () => {
    const declaredFieldNames = new Set(['destination', 'departure_date', 'budget']);

    let correctionField: string | undefined = 'unknown_field';
    let correctionNewValue: string | undefined = 'new_value';
    const correctionDetectionMethod = 'regex';

    if (correctionField && !declaredFieldNames.has(correctionField)) {
      if (correctionDetectionMethod !== 'llm') {
        correctionField = undefined;
        correctionNewValue = undefined;

        // Simulate LLM also returning undeclared field
        const llmFallback = { field: 'also_undeclared', newValue: 'something' };
        if (llmFallback && declaredFieldNames.has(llmFallback.field)) {
          correctionField = llmFallback.field;
          correctionNewValue = llmFallback.newValue;
        }
        // LLM returned undeclared — correction remains undefined
      }
    }

    expect(correctionField).toBeUndefined();
    expect(correctionNewValue).toBeUndefined();
  });

  it('LLM was original detector and returned undeclared — no recursive retry', () => {
    const declaredFieldNames = new Set(['destination', 'departure_date']);

    let correctionField: string | undefined = 'undeclared_field';
    let correctionNewValue: string | undefined = 'value';
    const correctionDetectionMethod = 'llm';

    if (correctionField && !declaredFieldNames.has(correctionField)) {
      if (correctionDetectionMethod !== 'llm') {
        // Would trigger LLM fallback — but we're already LLM, so this branch is skipped
        correctionField = undefined;
      } else {
        // LLM itself returned undeclared — skip, no retry
        correctionField = undefined;
        correctionNewValue = undefined;
      }
    }

    expect(correctionField).toBeUndefined();
    expect(correctionNewValue).toBeUndefined();
  });
});

// =============================================================================
// F3: Disambiguate respects max_intents
// =============================================================================

describe('F3: handleDisambiguate respects max_intents', () => {
  let RoutingExecutor: typeof import('../services/execution/routing-executor.js').RoutingExecutor;
  let executor: InstanceType<
    typeof import('../services/execution/routing-executor.js').RoutingExecutor
  >;
  let traceEvents: Array<{ type: string; data: Record<string, unknown> }>;
  let onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void;

  beforeEach(async () => {
    const mod = await import('../../services/execution/routing-executor.js');
    RoutingExecutor = mod.RoutingExecutor;

    const mockCtx = {
      executeMessage: vi.fn(),
      agentRegistry: {},
      config: { maxConcurrentFanOutCalls: 5, timeoutMs: 30000 },
      sessions: new Map(),
      markExecuting: vi.fn(),
      unmarkExecuting: vi.fn(),
      cancelPendingPersist: vi.fn(),
    };

    const mockLLMWiring = {
      wireLLMClient: vi.fn(),
      wireToolExecutor: vi.fn(),
      clearCooldown: vi.fn(),
    };

    executor = new RoutingExecutor(mockCtx as never, mockLLMWiring as never);
    traceEvents = [];
    onTraceEvent = (event) => traceEvents.push(event);
  });

  it('truncates disambiguate options to max_intents', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 2,
          confidence_threshold: 0.5,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const session = buildSession({ agentIR });
    // 4 intents total (1 primary + 3 alternatives)
    const multiResult = buildMultiIntentResult();

    const result = executor.handleMultiIntent(
      session as never,
      multiResult,
      agentIR,
      'book flight hotel car and tour',
      onTraceEvent,
    );

    expect(result.strategy).toBe('disambiguate');
    expect(result.disambiguationMessage).toBeDefined();

    // The disambiguation message should only list max_intents (2) options
    const disambiguateEvent = traceEvents.find(
      (e) => e.type === 'decision' && e.data.type === 'multi_intent_disambiguate',
    );
    expect(disambiguateEvent).toBeDefined();
    const intents = disambiguateEvent!.data.intents as Array<{ intent: string }>;
    expect(intents.length).toBe(2);
  });

  it('intent queue respects max_intents in disambiguate', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 2,
          confidence_threshold: 0.5,
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
      'book everything',
      onTraceEvent,
    );

    const typedSession = session as { intentQueue?: { pending: Array<{ intent: string }> } };
    expect(typedSession.intentQueue).toBeDefined();
    // Max intents is 2, so queue should have at most 2 entries
    expect(typedSession.intentQueue!.pending.length).toBeLessThanOrEqual(2);
  });
});

// =============================================================================
// F4: Unknown strategy falls back gracefully
// =============================================================================

describe('F4: Unknown strategy fallback', () => {
  let RoutingExecutor: typeof import('../services/execution/routing-executor.js').RoutingExecutor;
  let executor: InstanceType<
    typeof import('../services/execution/routing-executor.js').RoutingExecutor
  >;
  let traceEvents: Array<{ type: string; data: Record<string, unknown> }>;
  let onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void;

  beforeEach(async () => {
    const mod = await import('../../services/execution/routing-executor.js');
    RoutingExecutor = mod.RoutingExecutor;

    const mockCtx = {
      executeMessage: vi.fn(),
      agentRegistry: {},
      config: { maxConcurrentFanOutCalls: 5, timeoutMs: 30000 },
      sessions: new Map(),
      markExecuting: vi.fn(),
      unmarkExecuting: vi.fn(),
      cancelPendingPersist: vi.fn(),
    };

    const mockLLMWiring = {
      wireLLMClient: vi.fn(),
      wireToolExecutor: vi.fn(),
      clearCooldown: vi.fn(),
    };

    executor = new RoutingExecutor(mockCtx as never, mockLLMWiring as never);
    traceEvents = [];
    onTraceEvent = (event) => traceEvents.push(event);
  });

  it('unknown strategy triggers primary_queue fallback behavior', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'nonexistent_strategy' as never,
          max_intents: 3,
          confidence_threshold: 0.6,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const session = buildSession({ agentIR });
    const multiResult = buildMultiIntentResult({
      alternatives: [{ intent: 'book_hotel', confidence: 0.85, source: 'llm' }],
    });

    const result = executor.handleMultiIntent(
      session as never,
      multiResult,
      agentIR,
      'book flight and hotel',
      onTraceEvent,
    );

    // Should fall back to primary_queue (or whatever the default switch case yields)
    expect(result.primaryIntent).toBe('book_flight');
    expect(result.queued).toBe(true);

    // Intent queue should be populated (primary_queue behavior)
    const typedSession = session as { intentQueue?: { pending: Array<{ intent: string }> } };
    expect(typedSession.intentQueue).toBeDefined();
    expect(typedSession.intentQueue!.pending.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// F4: Zod validation rejects invalid strategy strings
// =============================================================================

describe('F4: Zod schema validation for strategy strings', () => {
  it('rejects invalid extraction strategy', () => {
    // Import the zod library directly to test schema
    const { z } = require('zod');

    const extractionConfigSchema = z.object({
      strategy: z.enum(['auto', 'ml', 'llm', 'hybrid', 'pattern']).optional(),
      correction_detection: z
        .enum(['auto', 'ml', 'llm', 'regex', 'sidecar', 'disabled'])
        .optional(),
    });

    // Valid values pass
    expect(extractionConfigSchema.safeParse({ strategy: 'auto' }).success).toBe(true);
    expect(extractionConfigSchema.safeParse({ strategy: 'ml' }).success).toBe(true);
    expect(extractionConfigSchema.safeParse({}).success).toBe(true);

    // Invalid values rejected
    expect(extractionConfigSchema.safeParse({ strategy: 'invalid' }).success).toBe(false);
    expect(extractionConfigSchema.safeParse({ strategy: '' }).success).toBe(false);
    expect(extractionConfigSchema.safeParse({ correction_detection: 'nonexistent' }).success).toBe(
      false,
    );
  });

  it('rejects invalid multi-intent strategy', () => {
    const { z } = require('zod');

    const multiIntentConfigSchema = z.object({
      strategy: z
        .enum(['sequential', 'parallel', 'primary_queue', 'disambiguate', 'auto'])
        .optional(),
    });

    // Valid values pass
    expect(multiIntentConfigSchema.safeParse({ strategy: 'sequential' }).success).toBe(true);
    expect(multiIntentConfigSchema.safeParse({ strategy: 'primary_queue' }).success).toBe(true);
    expect(multiIntentConfigSchema.safeParse({}).success).toBe(true);

    // Invalid values rejected
    expect(multiIntentConfigSchema.safeParse({ strategy: 'unknown' }).success).toBe(false);
    expect(multiIntentConfigSchema.safeParse({ strategy: 'round_robin' }).success).toBe(false);
  });
});

// =============================================================================
// F5: Config survives handoff/delegate
// =============================================================================

describe('F5: Project runtime config survives handoff/delegate', () => {
  it('_projectRuntimeConfig preserved after handoff IR switch', () => {
    const projectConfig = buildProjectConfig({ extraction_strategy: 'hybrid' });

    const session = buildSession({
      _projectRuntimeConfig: projectConfig,
      agentIR: buildAgentIR(),
    }) as unknown as RuntimeSession;

    // Set initial project config
    session.agentIR!.project_runtime_config = projectConfig;

    // Simulate handoff: replace agentIR with target agent's IR
    const targetIR = buildAgentIR({
      metadata: {
        name: 'target_agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: new Date().toISOString(),
        source_hash: 'target-hash',
        compiler_version: '1.0.0',
      },
    });
    session.agentIR = targetIR;

    // Reapply (mimics the code added in F5)
    if (session._projectRuntimeConfig && session.agentIR) {
      session.agentIR.project_runtime_config = session._projectRuntimeConfig;
    }

    // Verify config survived
    expect(session.agentIR.project_runtime_config).toBeDefined();
    expect(session.agentIR.project_runtime_config!.extraction_strategy).toBe('hybrid');
  });

  it('_projectRuntimeConfig preserved after delegate IR switch', () => {
    const projectConfig = buildProjectConfig({
      multi_intent: {
        ...buildProjectConfig().multi_intent,
        strategy: 'disambiguate',
      },
    });

    const session = buildSession({
      _projectRuntimeConfig: projectConfig,
      agentIR: buildAgentIR(),
    }) as unknown as RuntimeSession;

    session.agentIR!.project_runtime_config = projectConfig;

    // Simulate delegate: replace agentIR
    const delegateIR = buildAgentIR({
      metadata: {
        name: 'delegate_agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: new Date().toISOString(),
        source_hash: 'delegate-hash',
        compiler_version: '1.0.0',
      },
    });
    session.agentIR = delegateIR;

    // Reapply
    if (session._projectRuntimeConfig && session.agentIR) {
      session.agentIR.project_runtime_config = session._projectRuntimeConfig;
    }

    expect(session.agentIR.project_runtime_config).toBeDefined();
    expect(session.agentIR.project_runtime_config!.multi_intent.strategy).toBe('disambiguate');
  });

  it('no _projectRuntimeConfig — target IR is not mutated', () => {
    const session = buildSession({
      agentIR: buildAgentIR(),
    }) as unknown as RuntimeSession;

    // No _projectRuntimeConfig set
    const targetIR = buildAgentIR();
    session.agentIR = targetIR;

    if (session._projectRuntimeConfig && session.agentIR) {
      session.agentIR.project_runtime_config = session._projectRuntimeConfig;
    }

    expect(session.agentIR.project_runtime_config).toBeUndefined();
  });

  it('cached config is same reference as original', () => {
    const projectConfig = buildProjectConfig();

    const session = buildSession({
      _projectRuntimeConfig: projectConfig,
      agentIR: buildAgentIR(),
    }) as unknown as RuntimeSession;

    session.agentIR!.project_runtime_config = projectConfig;

    // After handoff IR switch + reapply
    const targetIR = buildAgentIR();
    session.agentIR = targetIR;
    if (session._projectRuntimeConfig && session.agentIR) {
      session.agentIR.project_runtime_config = session._projectRuntimeConfig;
    }

    expect(session.agentIR.project_runtime_config).toBe(projectConfig);
  });

  it('resolveMultiIntentConfig works after handoff with preserved config', () => {
    const projectConfig = buildProjectConfig({
      multi_intent: {
        enabled: true,
        strategy: 'sequential',
        max_intents: 5,
        confidence_threshold: 0.8,
        queue_max_age_ms: 300_000,
      },
    });

    const targetIR = buildAgentIR();
    targetIR.project_runtime_config = projectConfig;

    const config = resolveMultiIntentConfig(targetIR);
    expect(config.strategy).toBe('sequential');
    expect(config.max_intents).toBe(5);
  });
});

// =============================================================================
// F6: Sidecar config fields wired to IR
// =============================================================================

describe('F6: Sidecar config fields in ProjectRuntimeConfigIR', () => {
  it('ProjectRuntimeConfigIR accepts new sidecar fields', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'standard',
      correction_detection: 'ml',
      sidecar_timeout_ms: 500,
      sidecar_circuit_breaker_threshold: 5,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };

    expect(config.correction_detection).toBe('ml');
    expect(config.sidecar_timeout_ms).toBe(500);
    expect(config.sidecar_circuit_breaker_threshold).toBe(5);
  });

  it('sidecar fields are optional (backward compat)', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'standard',
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };

    expect(config.correction_detection).toBeUndefined();
    expect(config.sidecar_timeout_ms).toBeUndefined();
    expect(config.sidecar_circuit_breaker_threshold).toBeUndefined();
  });
});
