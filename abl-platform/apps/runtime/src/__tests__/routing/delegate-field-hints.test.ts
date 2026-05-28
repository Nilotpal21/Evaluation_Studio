/**
 * getDelegateFieldHints Tests
 *
 * Verifies that extraction hints are correctly derived from DELEGATE WHEN
 * conditions so the LLM has context for supplementary field extraction.
 */

import { describe, test, expect } from 'vitest';
import { getDelegateFieldHints } from '../../services/execution/reasoning-executor.js';
import type { AgentIR } from '@abl/compiler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      goal: '',
      persona: '',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDelegateFieldHints', () => {
  test('extracts comparison values from delegate WHEN conditions', () => {
    const ir = makeIR({
      coordination: {
        delegates: [
          {
            agent: 'fiber_agent',
            when: 'incident_category == "fiber_cut"',
            purpose: 'Handle fiber cuts',
            input: {},
            returns: {},
            use_result: 'result',
            on_failure: 'continue',
          },
          {
            agent: 'power_agent',
            when: 'incident_category == "power_outage"',
            purpose: 'Handle power issues',
            input: {},
            returns: {},
            use_result: 'result',
            on_failure: 'continue',
          },
        ],
        handoffs: [],
      },
    });
    const hints = getDelegateFieldHints(ir, 'incident_category');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain('fiber_cut');
    expect(hints[0]).toContain('power_outage');
  });

  test('returns empty hints for fields not used in delegate conditions', () => {
    const ir = makeIR({
      coordination: {
        delegates: [
          {
            agent: 'billing',
            when: 'needs_payment == true',
            purpose: 'Pay',
            input: {},
            returns: {},
            use_result: 'result',
            on_failure: 'continue',
          },
        ],
        handoffs: [],
      },
    });
    const hints = getDelegateFieldHints(ir, 'customer_name');
    expect(hints).toEqual([]);
  });

  test('includes delegate purpose in hints when delegates reference the field', () => {
    const ir = makeIR({
      coordination: {
        delegates: [
          {
            agent: 'fiber_agent',
            when: 'category == "fiber"',
            purpose: 'Fiber repairs',
            input: {},
            returns: {},
            use_result: 'result',
            on_failure: 'continue',
          },
        ],
        handoffs: [],
      },
    });
    const hints = getDelegateFieldHints(ir, 'category');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain('fiber');
    // Should also include purpose
    const purposeHint = hints.find((h) => h.includes('Fiber repairs'));
    expect(purposeHint).toBeDefined();
  });
});
