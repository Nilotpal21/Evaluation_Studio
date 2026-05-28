import { describe, it, expect, beforeEach } from 'vitest';
import { resolveStrategy } from '../../services/execution/multi-intent-strategy.js';
import type { AgentExecutionType } from '../../services/execution/multi-intent-strategy.js';
import {
  createIntentQueue,
  enqueueIntents,
  dequeueNext,
  peekNext,
  pruneExpired,
} from '../../services/execution/intent-queue.js';
import type { IntentQueue } from '../../services/execution/intent-queue.js';
import {
  resolveMultiIntentConfig,
  resolveAgentExecutionType,
  MULTI_INTENT_PLATFORM_DEFAULTS,
} from '../../services/execution/routing-executor.js';
import type { MultiIntentResult } from '@abl/compiler/platform/nlu/types.js';
import type {
  AgentIR,
  MultiIntentStrategy,
  IntentRelationshipType,
} from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// HELPERS — minimal AgentIR factories for testing
// =============================================================================

/** Build a minimal AgentIR with overrides for multi-intent testing. */
function makeAgentIR(overrides: {
  type?: 'agent' | 'supervisor';
  mode?: 'scripted' | 'reasoning';
  intent_handling?: AgentIR['intent_handling'];
  project_runtime_config?: AgentIR['project_runtime_config'];
}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: overrides.type ?? 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: overrides.mode ?? 'reasoning',
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30_000,
        llm_timeout_ms: 60_000,
        session_timeout_ms: 600_000,
      },
    },
    identity: {
      goal: 'Test agent',
      persona: 'Helpful assistant',
      limitations: [],
      system_prompt: { template: '', sections: {} },
    },
    tools: [],
    gather: { fields: [], strategy: 'progressive' as const },
    memory: { max_messages: 50 },
    constraints: { rules: [], enforcement: 'strict' as const },
    coordination: { handoffs: [], delegates: [] },
    completion: { conditions: [] },
    error_handling: { fallback_message: 'Something went wrong' },
    intent_handling: overrides.intent_handling,
    project_runtime_config: overrides.project_runtime_config,
  } as unknown as AgentIR;
}

/** Build a MultiIntentResult for testing. */
function makeMultiIntentResult(
  primaryIntent: string,
  primaryConfidence: number,
  alternatives: Array<{ intent: string; confidence: number }>,
  relationship: IntentRelationshipType,
): MultiIntentResult {
  return {
    primary: {
      intent: primaryIntent,
      confidence: primaryConfidence,
      source: 'balanced',
    },
    alternatives: alternatives.map((a) => ({
      intent: a.intent,
      confidence: a.confidence,
      source: 'balanced' as const,
    })),
    relationships: {
      type: relationship,
      reasoning: `Intents are ${relationship}`,
    },
  };
}

// =============================================================================
// SUITE 1: End-to-end detection → strategy → queue lifecycle
// =============================================================================

describe('End-to-end: detection → strategy → queue lifecycle', () => {
  it('primary_queue: primary routed, alternatives queued and dequeued in order', () => {
    const queue = createIntentQueue();
    const multiResult = makeMultiIntentResult(
      'book_flight',
      0.95,
      [
        { intent: 'check_weather', confidence: 0.85 },
        { intent: 'reserve_hotel', confidence: 0.8 },
      ],
      'independent',
    );

    // Simulate what handlePrimaryQueue does: enqueue alternatives
    const alternatives = multiResult.alternatives
      .filter((a) => a.intent !== null)
      .map((a) => ({
        intent: a.intent!,
        confidence: a.confidence,
        original_message: 'I want to book a flight, check weather, and reserve a hotel',
      }));
    enqueueIntents(queue, alternatives);

    // Queue should have 2 entries sorted by confidence desc
    expect(queue.pending).toHaveLength(2);
    expect(queue.pending[0].intent).toBe('check_weather');
    expect(queue.pending[1].intent).toBe('reserve_hotel');

    // Dequeue in order (highest confidence first)
    const first = dequeueNext(queue);
    expect(first).not.toBeNull();
    expect(first!.intent).toBe('check_weather');
    expect(first!.confidence).toBe(0.85);

    const second = dequeueNext(queue);
    expect(second).not.toBeNull();
    expect(second!.intent).toBe('reserve_hotel');
    expect(second!.confidence).toBe(0.8);

    // Queue is now empty
    expect(dequeueNext(queue)).toBeNull();
  });

  it('auto + supervisor + independent → parallel', () => {
    const strategy = resolveStrategy('auto', 'supervisor', 'independent');
    expect(strategy).toBe('parallel');
  });

  it('auto + scripted + independent → sequential (downgraded from parallel)', () => {
    const strategy = resolveStrategy('auto', 'scripted', 'independent');
    expect(strategy).toBe('sequential');
  });

  it('queue expires old intents', () => {
    const queue = createIntentQueue();

    // Manually insert an old entry and a fresh one
    const oldTimestamp = new Date(Date.now() - 700_000).toISOString();
    const freshTimestamp = new Date().toISOString();

    queue.pending = [
      {
        intent: 'old_intent',
        confidence: 0.9,
        original_message: 'old message',
        detected_at: oldTimestamp,
      },
      {
        intent: 'fresh_intent',
        confidence: 0.8,
        original_message: 'fresh message',
        detected_at: freshTimestamp,
      },
    ];

    // Prune with 10-minute window (600_000 ms)
    pruneExpired(queue, 600_000);

    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].intent).toBe('fresh_intent');
  });

  it('single intent: no alternatives, no queue needed', () => {
    const multiResult = makeMultiIntentResult('book_flight', 0.95, [], 'independent');

    // With no alternatives, there is nothing to queue
    expect(multiResult.alternatives).toHaveLength(0);

    // Strategy resolution still works (any strategy is fine for single intent)
    const strategy = resolveStrategy('auto', 'scripted', 'independent');
    expect(strategy).toBe('sequential');

    const queue = createIntentQueue();
    // Enqueue empty array is safe
    enqueueIntents(queue, []);
    expect(queue.pending).toHaveLength(0);
    expect(dequeueNext(queue)).toBeNull();
  });

  it('full cycle: detect → resolve strategy → queue → dequeue → complete', () => {
    // 1. Detection produces a multi-intent result
    const multiResult = makeMultiIntentResult(
      'pay_bill',
      0.92,
      [
        { intent: 'check_balance', confidence: 0.88 },
        { intent: 'set_autopay', confidence: 0.75 },
      ],
      'dependent',
    );

    // 2. Strategy resolves for dependent intents
    const agentIR = makeAgentIR({ mode: 'scripted', type: 'agent' });
    const agentType = resolveAgentExecutionType(agentIR);
    expect(agentType).toBe('scripted');

    const strategy = resolveStrategy('auto', agentType, multiResult.relationships.type);
    expect(strategy).toBe('sequential');

    // 3. Alternatives enqueued for sequential processing
    const queue = createIntentQueue();
    enqueueIntents(
      queue,
      multiResult.alternatives.map((a) => ({
        intent: a.intent!,
        confidence: a.confidence,
        original_message: 'pay bill and check balance and set autopay',
      })),
    );

    // 4. Primary is handled (simulated), then dequeue next
    expect(queue.pending).toHaveLength(2);

    const next1 = dequeueNext(queue);
    expect(next1!.intent).toBe('check_balance');

    const next2 = dequeueNext(queue);
    expect(next2!.intent).toBe('set_autopay');

    // 5. Queue drained
    expect(dequeueNext(queue)).toBeNull();
  });
});

// =============================================================================
// SUITE 2: Strategy restriction enforcement
// =============================================================================

describe('Strategy restriction enforcement', () => {
  it('parallel blocked for scripted agents → sequential', () => {
    expect(resolveStrategy('parallel', 'scripted', 'independent')).toBe('sequential');
  });

  it('parallel blocked for reasoning agents → sequential', () => {
    expect(resolveStrategy('parallel', 'reasoning', 'independent')).toBe('sequential');
  });

  it('parallel allowed for supervisor agents', () => {
    expect(resolveStrategy('parallel', 'supervisor', 'independent')).toBe('parallel');
  });

  describe('all strategies allowed for all agent types except parallel', () => {
    const agentTypes: AgentExecutionType[] = ['supervisor', 'scripted', 'reasoning'];
    const safeStrategies: MultiIntentStrategy[] = ['sequential', 'primary_queue', 'disambiguate'];
    const relationships: IntentRelationshipType[] = ['independent', 'dependent', 'ambiguous'];

    for (const strategy of safeStrategies) {
      for (const agentType of agentTypes) {
        it(`${strategy} allowed for ${agentType}`, () => {
          // Safe strategies pass through unchanged regardless of agent type
          const result = resolveStrategy(strategy, agentType, 'independent');
          expect(result).toBe(strategy);
        });
      }
    }

    it('parallel is only allowed for supervisor', () => {
      for (const agentType of agentTypes) {
        const result = resolveStrategy('parallel', agentType, 'independent');
        if (agentType === 'supervisor') {
          expect(result).toBe('parallel');
        } else {
          expect(result).toBe('sequential');
        }
      }
    });
  });

  describe('auto mode resolves based on relationship and agent type', () => {
    it('auto + independent + supervisor → parallel', () => {
      expect(resolveStrategy('auto', 'supervisor', 'independent')).toBe('parallel');
    });

    it('auto + independent + scripted → sequential', () => {
      expect(resolveStrategy('auto', 'scripted', 'independent')).toBe('sequential');
    });

    it('auto + independent + reasoning → sequential', () => {
      expect(resolveStrategy('auto', 'reasoning', 'independent')).toBe('sequential');
    });

    it('auto + dependent → sequential (for any agent type)', () => {
      expect(resolveStrategy('auto', 'supervisor', 'dependent')).toBe('sequential');
      expect(resolveStrategy('auto', 'scripted', 'dependent')).toBe('sequential');
      expect(resolveStrategy('auto', 'reasoning', 'dependent')).toBe('sequential');
    });

    it('auto + ambiguous → disambiguate (for any agent type)', () => {
      expect(resolveStrategy('auto', 'supervisor', 'ambiguous')).toBe('disambiguate');
      expect(resolveStrategy('auto', 'scripted', 'ambiguous')).toBe('disambiguate');
      expect(resolveStrategy('auto', 'reasoning', 'ambiguous')).toBe('disambiguate');
    });
  });
});

// =============================================================================
// SUITE 3: Config resolution order
// =============================================================================

describe('Config resolution order', () => {
  it('agent-level config takes priority over everything', () => {
    const agentIR = makeAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 5,
          confidence_threshold: 0.8,
          queue_max_age_ms: 300_000,
        },
      },
      project_runtime_config: {
        extraction_strategy: 'auto',
        multi_intent: {
          enabled: true,
          strategy: 'sequential',
          max_intents: 2,
          confidence_threshold: 0.5,
          queue_max_age_ms: 900_000,
        },
        inference: {
          confidence: 0.7,
          confirm: false,
          model_tier: 'balanced',
          max_fields_per_pass: 5,
        },
        conversion: { currency_mode: 'static' },
        lookup_tables: [],
      },
    });

    const config = resolveMultiIntentConfig(agentIR);

    // Agent-level values should win
    expect(config.strategy).toBe('disambiguate');
    expect(config.max_intents).toBe(5);
    expect(config.confidence_threshold).toBe(0.8);
    expect(config.queue_max_age_ms).toBe(300_000);
  });

  it('falls back to project-level when no agent-level config', () => {
    const agentIR = makeAgentIR({
      project_runtime_config: {
        extraction_strategy: 'auto',
        multi_intent: {
          enabled: false,
          strategy: 'sequential',
          max_intents: 4,
          confidence_threshold: 0.7,
          queue_max_age_ms: 120_000,
        },
        inference: {
          confidence: 0.7,
          confirm: false,
          model_tier: 'balanced',
          max_fields_per_pass: 5,
        },
        conversion: { currency_mode: 'static' },
        lookup_tables: [],
      },
    });

    const config = resolveMultiIntentConfig(agentIR);

    expect(config.enabled).toBe(false);
    expect(config.strategy).toBe('sequential');
    expect(config.max_intents).toBe(4);
    expect(config.confidence_threshold).toBe(0.7);
    expect(config.queue_max_age_ms).toBe(120_000);
  });

  it('falls back to platform defaults when no agent or project config', () => {
    const agentIR = makeAgentIR({});

    const config = resolveMultiIntentConfig(agentIR);

    expect(config.enabled).toBe(MULTI_INTENT_PLATFORM_DEFAULTS.enabled);
    expect(config.strategy).toBe(MULTI_INTENT_PLATFORM_DEFAULTS.strategy);
    expect(config.max_intents).toBe(MULTI_INTENT_PLATFORM_DEFAULTS.max_intents);
    expect(config.confidence_threshold).toBe(MULTI_INTENT_PLATFORM_DEFAULTS.confidence_threshold);
    expect(config.queue_max_age_ms).toBe(MULTI_INTENT_PLATFORM_DEFAULTS.queue_max_age_ms);
  });

  it('platform defaults have expected values', () => {
    expect(MULTI_INTENT_PLATFORM_DEFAULTS.enabled).toBe(true);
    expect(MULTI_INTENT_PLATFORM_DEFAULTS.strategy).toBe('primary_queue');
    expect(MULTI_INTENT_PLATFORM_DEFAULTS.max_intents).toBe(3);
    expect(MULTI_INTENT_PLATFORM_DEFAULTS.confidence_threshold).toBe(0.6);
    expect(MULTI_INTENT_PLATFORM_DEFAULTS.queue_max_age_ms).toBe(600_000);
  });

  it('agent-level partially overrides project-level (merge semantics)', () => {
    const agentIR = makeAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'parallel',
          max_intents: 6,
          confidence_threshold: 0.9,
          queue_max_age_ms: 500_000,
        },
      },
      project_runtime_config: {
        extraction_strategy: 'auto',
        multi_intent: {
          enabled: false,
          strategy: 'sequential',
          max_intents: 2,
          confidence_threshold: 0.5,
          queue_max_age_ms: 100_000,
        },
        inference: {
          confidence: 0.7,
          confirm: false,
          model_tier: 'balanced',
          max_fields_per_pass: 5,
        },
        conversion: { currency_mode: 'static' },
        lookup_tables: [],
      },
    });

    const config = resolveMultiIntentConfig(agentIR);

    // Agent-level overrides all project-level fields due to full spread
    expect(config.enabled).toBe(true);
    expect(config.strategy).toBe('parallel');
    expect(config.max_intents).toBe(6);
    expect(config.confidence_threshold).toBe(0.9);
    expect(config.queue_max_age_ms).toBe(500_000);
  });
});

// =============================================================================
// SUITE 4: resolveAgentExecutionType
// =============================================================================

describe('resolveAgentExecutionType', () => {
  it('supervisor type → supervisor', () => {
    const ir = makeAgentIR({ type: 'supervisor' });
    expect(resolveAgentExecutionType(ir)).toBe('supervisor');
  });

  it('agent with flow section → scripted', () => {
    const ir = makeAgentIR({ type: 'agent', mode: 'scripted' });
    // Add a flow section — the primary signal for scripted execution
    (ir as Record<string, unknown>).flow = {
      steps: ['greeting'],
      definitions: {},
    };
    expect(resolveAgentExecutionType(ir)).toBe('scripted');
  });

  it('agent type + scripted mode (no flow, backward compat) → scripted', () => {
    const ir = makeAgentIR({ type: 'agent', mode: 'scripted' });
    expect(resolveAgentExecutionType(ir)).toBe('scripted');
  });

  it('agent type + reasoning mode → reasoning', () => {
    const ir = makeAgentIR({ type: 'agent', mode: 'reasoning' });
    expect(resolveAgentExecutionType(ir)).toBe('reasoning');
  });

  it('supervisor type ignores execution mode', () => {
    const ir = makeAgentIR({ type: 'supervisor', mode: 'scripted' });
    // Supervisor type takes precedence over execution mode
    expect(resolveAgentExecutionType(ir)).toBe('supervisor');
  });
});

// =============================================================================
// SUITE 5: Queue lifecycle edge cases
// =============================================================================

describe('Queue lifecycle edge cases', () => {
  let queue: IntentQueue;

  beforeEach(() => {
    queue = createIntentQueue();
  });

  it('multiple rounds of enqueue + dequeue', () => {
    // Round 1
    enqueueIntents(queue, [
      { intent: 'intent_a', confidence: 0.9, original_message: 'msg1' },
      { intent: 'intent_b', confidence: 0.7, original_message: 'msg1' },
    ]);
    expect(queue.pending).toHaveLength(2);

    const first = dequeueNext(queue);
    expect(first!.intent).toBe('intent_a');
    expect(queue.pending).toHaveLength(1);

    // Round 2 — add more while queue still has entries
    enqueueIntents(queue, [
      { intent: 'intent_c', confidence: 0.95, original_message: 'msg2' },
      { intent: 'intent_d', confidence: 0.6, original_message: 'msg2' },
    ]);
    expect(queue.pending).toHaveLength(3);

    // Should be sorted: intent_c (0.95), intent_b (0.7), intent_d (0.6)
    expect(queue.pending[0].intent).toBe('intent_c');
    expect(queue.pending[1].intent).toBe('intent_b');
    expect(queue.pending[2].intent).toBe('intent_d');

    // Dequeue all
    expect(dequeueNext(queue)!.intent).toBe('intent_c');
    expect(dequeueNext(queue)!.intent).toBe('intent_b');
    expect(dequeueNext(queue)!.intent).toBe('intent_d');
    expect(dequeueNext(queue)).toBeNull();
  });

  it('duplicate intent merge: higher confidence wins', () => {
    enqueueIntents(queue, [
      { intent: 'book_flight', confidence: 0.7, original_message: 'first message' },
    ]);
    expect(queue.pending[0].confidence).toBe(0.7);

    // Re-enqueue same intent with higher confidence
    enqueueIntents(queue, [
      { intent: 'book_flight', confidence: 0.95, original_message: 'second message' },
    ]);

    // Should still be one entry, with updated confidence and message
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].confidence).toBe(0.95);
    expect(queue.pending[0].original_message).toBe('second message');
  });

  it('duplicate intent merge: lower confidence does not downgrade', () => {
    enqueueIntents(queue, [
      { intent: 'book_flight', confidence: 0.95, original_message: 'first message' },
    ]);

    // Re-enqueue same intent with LOWER confidence
    enqueueIntents(queue, [
      { intent: 'book_flight', confidence: 0.6, original_message: 'second message' },
    ]);

    // Confidence should stay at the higher value
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].confidence).toBe(0.95);
    // Message is still updated (latest message is kept)
    expect(queue.pending[0].original_message).toBe('second message');
  });

  it('queue fully drained returns null', () => {
    enqueueIntents(queue, [{ intent: 'a', confidence: 0.9, original_message: 'msg' }]);

    dequeueNext(queue);
    expect(dequeueNext(queue)).toBeNull();
    expect(peekNext(queue)).toBeNull();
  });

  it('enqueue empty array is a no-op', () => {
    enqueueIntents(queue, []);
    expect(queue.pending).toHaveLength(0);
    expect(dequeueNext(queue)).toBeNull();
  });

  it('peek returns highest confidence without removal', () => {
    enqueueIntents(queue, [
      { intent: 'low', confidence: 0.5, original_message: 'msg' },
      { intent: 'high', confidence: 0.9, original_message: 'msg' },
    ]);

    const peeked = peekNext(queue);
    expect(peeked!.intent).toBe('high');
    expect(queue.pending).toHaveLength(2);

    // Peek again — same result, no side effects
    const peeked2 = peekNext(queue);
    expect(peeked2!.intent).toBe('high');
    expect(queue.pending).toHaveLength(2);
  });

  it('pruneExpired with all entries fresh removes nothing', () => {
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.9, original_message: 'msg' },
      { intent: 'b', confidence: 0.8, original_message: 'msg' },
    ]);

    pruneExpired(queue, 600_000);
    expect(queue.pending).toHaveLength(2);
  });

  it('pruneExpired with all entries expired removes everything', () => {
    queue.pending = [
      {
        intent: 'old_a',
        confidence: 0.9,
        original_message: 'msg',
        detected_at: new Date(Date.now() - 700_000).toISOString(),
      },
      {
        intent: 'old_b',
        confidence: 0.8,
        original_message: 'msg',
        detected_at: new Date(Date.now() - 800_000).toISOString(),
      },
    ];

    pruneExpired(queue, 600_000);
    expect(queue.pending).toHaveLength(0);
  });

  it('multiple duplicates in single enqueue call are merged', () => {
    enqueueIntents(queue, [
      { intent: 'x', confidence: 0.7, original_message: 'msg1' },
      { intent: 'x', confidence: 0.9, original_message: 'msg2' },
    ]);

    // The second occurrence has higher confidence, so it should win
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].confidence).toBe(0.9);
    expect(queue.pending[0].original_message).toBe('msg2');
  });

  it('interleaved enqueue-dequeue-prune cycle', () => {
    // Enqueue 3
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.9, original_message: 'msg' },
      { intent: 'b', confidence: 0.8, original_message: 'msg' },
      { intent: 'c', confidence: 0.7, original_message: 'msg' },
    ]);
    expect(queue.pending).toHaveLength(3);

    // Dequeue 1
    const first = dequeueNext(queue);
    expect(first!.intent).toBe('a');
    expect(queue.pending).toHaveLength(2);

    // Prune (nothing expired since they were just added)
    pruneExpired(queue, 600_000);
    expect(queue.pending).toHaveLength(2);

    // Enqueue 1 more
    enqueueIntents(queue, [{ intent: 'd', confidence: 0.95, original_message: 'msg2' }]);
    expect(queue.pending).toHaveLength(3);

    // d (0.95) should now be first
    expect(peekNext(queue)!.intent).toBe('d');

    // Dequeue all remaining
    expect(dequeueNext(queue)!.intent).toBe('d');
    expect(dequeueNext(queue)!.intent).toBe('b');
    expect(dequeueNext(queue)!.intent).toBe('c');
    expect(dequeueNext(queue)).toBeNull();
  });
});
