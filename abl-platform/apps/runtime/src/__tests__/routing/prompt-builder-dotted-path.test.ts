/**
 * Tests for dotted-path WHEN condition evaluation in buildPerAgentTools.
 *
 * Verifies that WHEN conditions like `intent.category == "store_policy"`
 * correctly resolve nested session values (e.g., session.data.values.intent.category).
 *
 * The fix checks the root identifier ('intent') rather than the full dotted path
 * ('intent.category') when determining if variables are present in session state.
 * CEL handles nested property access natively once the root object exists.
 */

import { describe, it, expect } from 'vitest';
import { buildTools } from '../../services/execution/prompt-builder.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { AgentIR } from '@abl/compiler';

// =============================================================================
// HELPERS
// =============================================================================

function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'test-session',
    agentName: 'test_agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  } as RuntimeSession;
}

function makeIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 1800000,
      },
    },
    identity: {
      goal: 'Help users',
      persona: 'Helpful assistant',
      limitations: [],
      system_prompt: { template: '', sections: {} },
    },
    tools: [],
    gather: { fields: [], strategy: 'llm' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [], escalation: undefined },
    completion: { conditions: [] },
    error_handling: {
      handlers: [],
      default_handler: { type: 'default', then: 'continue' },
    },
    ...overrides,
  } as AgentIR;
}

// =============================================================================
// TESTS — Dotted-path WHEN condition evaluation
// =============================================================================

describe('buildTools — dotted-path WHEN condition evaluation', () => {
  it('TC-PB-01: flat variable reference works as before', () => {
    const ir = makeIR({
      routing: {
        rules: [
          {
            to: 'VIP_Agent',
            when: 'user_type == "vip"',
            description: 'Route VIPs',
            priority: 1,
          },
        ],
        default_agent: 'Fallback',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: { user_type: 'vip' }, gatheredKeys: new Set() },
    });
    const tools = buildTools(session);
    const handoff = tools.find((t) => t.name === 'handoff_to_VIP_Agent');
    expect(handoff).toBeDefined();
  });

  it('TC-PB-02: flat variable missing → skip evaluation, tool included (fail-open)', () => {
    const ir = makeIR({
      routing: {
        rules: [
          {
            to: 'VIP_Agent',
            when: 'user_type == "vip"',
            description: 'Route VIPs',
            priority: 1,
          },
        ],
        default_agent: 'Fallback',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: {}, gatheredKeys: new Set() },
    });
    const tools = buildTools(session);
    // Variable not present → WHEN not evaluated → tool included (fail-open)
    const handoff = tools.find((t) => t.name === 'handoff_to_VIP_Agent');
    expect(handoff).toBeDefined();
  });

  it('TC-PB-03: dotted-path variable present → root identifier found, CEL evaluates true', () => {
    const ir = makeIR({
      routing: {
        rules: [
          {
            to: 'Advisor_Agent',
            when: 'intent.category == "product_search"',
            description: 'Route product queries',
            priority: 1,
          },
        ],
        default_agent: 'Fallback',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { intent: { category: 'product_search', confidence: 0.8 } },
        gatheredKeys: new Set(),
      },
    });
    const tools = buildTools(session);
    const handoff = tools.find((t) => t.name === 'handoff_to_Advisor_Agent');
    expect(handoff).toBeDefined();
  });

  it('TC-PB-04: dotted-path variable present but condition false → tool excluded', () => {
    const ir = makeIR({
      routing: {
        rules: [
          {
            to: 'Store_Policy_Agent',
            when: 'intent.category == "store_policy"',
            description: 'Route policy queries',
            priority: 1,
          },
        ],
        default_agent: 'Fallback',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { intent: { category: 'product_search', confidence: 0.8 } },
        gatheredKeys: new Set(),
      },
    });
    const tools = buildTools(session);
    const handoff = tools.find((t) => t.name === 'handoff_to_Store_Policy_Agent');
    // Condition is false → tool should be excluded
    expect(handoff).toBeUndefined();
  });

  it('TC-PB-05: dotted-path root missing → skip evaluation, tool included (fail-open)', () => {
    const ir = makeIR({
      routing: {
        rules: [
          {
            to: 'Store_Policy_Agent',
            when: 'intent.category == "store_policy"',
            description: 'Route policy queries',
            priority: 1,
          },
        ],
        default_agent: 'Fallback',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: {}, gatheredKeys: new Set() },
    });
    const tools = buildTools(session);
    // 'intent' root not present → WHEN not evaluated → tool included (fail-open)
    const handoff = tools.find((t) => t.name === 'handoff_to_Store_Policy_Agent');
    expect(handoff).toBeDefined();
  });

  it('TC-PB-06: mixed flat + dotted variables — both present, condition true', () => {
    const ir = makeIR({
      routing: {
        rules: [
          {
            to: 'VIP_Advisor',
            when: 'intent.category == "offers" && tier == "premium"',
            description: 'Route VIP offers',
            priority: 1,
          },
        ],
        default_agent: 'Fallback',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { intent: { category: 'offers' }, tier: 'premium' },
        gatheredKeys: new Set(),
      },
    });
    const tools = buildTools(session);
    const handoff = tools.find((t) => t.name === 'handoff_to_VIP_Advisor');
    expect(handoff).toBeDefined();
  });

  it('TC-PB-07: handoff WHEN evaluation uses same dotted-path fix', () => {
    const ir = makeIR({
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'Store_Policy_Agent',
            when: 'intent.category == "store_policy"',
            context: { pass: [], summary: 'Policy queries' },
            return: false,
          },
        ],
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { intent: { category: 'product_search', confidence: 0.8 } },
        gatheredKeys: new Set(),
      },
    });
    const tools = buildTools(session);
    const handoff = tools.find((t) => t.name === 'handoff_to_Store_Policy_Agent');
    // Condition is false → handoff tool should be excluded
    expect(handoff).toBeUndefined();
  });
});
