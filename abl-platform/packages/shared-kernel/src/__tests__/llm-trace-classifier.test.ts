import { describe, it, expect } from 'vitest';
import {
  classifyLlmTraceForCostAttribution,
  rollupAgentTokenCost,
} from '../llm-trace-classifier.js';
import type { TraceEventForCostRollup } from '../llm-trace-classifier.js';
import { classifyLlmTraceVisibility } from '../response-provenance.js';

// The disclosure classifier (narrow, drives AI-disclosure metadata) and the
// cost-attribution classifier (wider, drives cost rollup) must NOT have
// drifted into the same taxonomy. These tests pin the divergence.
describe('classifier separation: disclosure vs cost-attribution', () => {
  // Purposes that ONLY the cost-attribution classifier treats as internal.
  // The disclosure classifier must continue to mark these customer_visible
  // so AI-disclosure metadata is not silently suppressed.
  const COST_ONLY_INTERNAL_PURPOSES = [
    'guardrail_check',
    'guardrail_reask',
    'guardrail_fix',
    'engine_decision',
    'routing',
    'eval_judge',
    'eval_persona',
    'classification',
    'completion_check',
    'intent_classification',
    'scoring',
    'handoff_condition_check',
    'kb_search',
    'gather_extraction',
    'extraction_attempt',
    'extraction_fallback',
    'extraction_strategy_resolved',
  ] as const;

  const COST_ONLY_INTERNAL_OPERATION_TYPES = [
    'validation',
    'tool_selection',
    'summarization',
    'coordination',
  ] as const;

  it.each(COST_ONLY_INTERNAL_PURPOSES)(
    'cost-attribution treats purpose=%s as internal_only',
    (purpose) => {
      expect(classifyLlmTraceForCostAttribution({ purpose })).toBe('internal_only');
    },
  );

  it.each(COST_ONLY_INTERNAL_PURPOSES)(
    'disclosure treats purpose=%s as customer_visible (must not regress)',
    (purpose) => {
      expect(classifyLlmTraceVisibility({ purpose })).toBe('customer_visible');
    },
  );

  it.each(COST_ONLY_INTERNAL_OPERATION_TYPES)(
    'cost-attribution treats operationType=%s as internal_only',
    (operationType) => {
      expect(classifyLlmTraceForCostAttribution({ operationType })).toBe('internal_only');
    },
  );

  it.each(COST_ONLY_INTERNAL_OPERATION_TYPES)(
    'disclosure treats operationType=%s as customer_visible (must not regress)',
    (operationType) => {
      expect(classifyLlmTraceVisibility({ operationType })).toBe('customer_visible');
    },
  );

  // Backwards-compatible purposes/operationTypes — both classifiers agree.
  it('both classifiers agree on entity_extraction → internal_only', () => {
    expect(classifyLlmTraceForCostAttribution({ purpose: 'entity_extraction' })).toBe(
      'internal_only',
    );
    expect(classifyLlmTraceVisibility({ purpose: 'entity_extraction' })).toBe('internal_only');
  });

  it('both classifiers agree on operationType extraction → internal_only', () => {
    expect(classifyLlmTraceForCostAttribution({ operationType: 'extraction' })).toBe(
      'internal_only',
    );
    expect(classifyLlmTraceVisibility({ operationType: 'extraction' })).toBe('internal_only');
  });

  it('both classifiers ignore simulated calls', () => {
    expect(classifyLlmTraceForCostAttribution({ simulated: true })).toBe('ignored');
    expect(classifyLlmTraceVisibility({ simulated: true })).toBe('ignored');
  });

  it('both classifiers ignore fallback model calls', () => {
    expect(classifyLlmTraceForCostAttribution({ model: 'fallback (no API key)' })).toBe('ignored');
    expect(classifyLlmTraceVisibility({ model: 'fallback (no API key)' })).toBe('ignored');
  });

  it('cost-attribution honors context fallback; disclosure does not', () => {
    expect(classifyLlmTraceForCostAttribution({ context: 'guardrail_check' })).toBe(
      'internal_only',
    );
    expect(classifyLlmTraceVisibility({ context: 'guardrail_check' })).toBe('customer_visible');
  });

  it('plain event data with no overrides defaults to customer_visible in both', () => {
    expect(classifyLlmTraceForCostAttribution({ model: 'gpt-4o' })).toBe('customer_visible');
    expect(classifyLlmTraceVisibility({ model: 'gpt-4o' })).toBe('customer_visible');
  });
});

describe('rollupAgentTokenCost', () => {
  it('returns zeros for empty trace events', () => {
    const result = rollupAgentTokenCost([]);
    expect(result).toEqual({
      totalCost: 0,
      customerVisibleCost: 0,
      costByModel: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  });

  it('ignores non-llm_call events', () => {
    const events: TraceEventForCostRollup[] = [
      { type: 'tool_call', data: { toolName: 'search', model: 'gpt-4o', inputTokens: 100 } },
      { type: 'decision', data: { model: 'gpt-4o', inputTokens: 200 } },
      { type: 'error', data: { errorType: 'timeout' } },
    ];
    const result = rollupAgentTokenCost(events);
    expect(result.totalCost).toBe(0);
    expect(result.totalInputTokens).toBe(0);
  });

  it('computes cost for a single model correctly', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          inputTokens: 1000,
          outputTokens: 500,
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    // gpt-4o: input $2.5/1M, output $10/1M
    // cost = (1000/1_000_000)*2.5 + (500/1_000_000)*10 = 0.0025 + 0.005 = 0.0075
    expect(result.totalCost).toBeCloseTo(0.0075, 6);
    expect(result.customerVisibleCost).toBeCloseTo(0.0075, 6);
    expect(result.costByModel).toEqual({ 'gpt-4o': expect.closeTo(0.0075, 6) });
    expect(result.totalInputTokens).toBe(1000);
    expect(result.totalOutputTokens).toBe(500);
  });

  it('computes cost for multiple models and aggregates per model', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: { model: 'claude-sonnet-4', inputTokens: 2000, outputTokens: 1000 },
      },
      {
        type: 'llm_call',
        data: { model: 'gpt-4o-mini', inputTokens: 500, outputTokens: 200 },
      },
      {
        type: 'llm_call',
        data: { model: 'claude-sonnet-4', inputTokens: 1000, outputTokens: 500 },
      },
    ];
    const result = rollupAgentTokenCost(events);

    // claude-sonnet-4: input $3/1M, output $15/1M
    // Call 1: (2000/1M)*3 + (1000/1M)*15 = 0.006 + 0.015 = 0.021
    // Call 3: (1000/1M)*3 + (500/1M)*15 = 0.003 + 0.0075 = 0.0105
    // Total sonnet: 0.0315

    // gpt-4o-mini: input $0.15/1M, output $0.6/1M
    // Call 2: (500/1M)*0.15 + (200/1M)*0.6 = 0.000075 + 0.00012 = 0.000195

    expect(result.costByModel['claude-sonnet-4']).toBeCloseTo(0.0315, 6);
    expect(result.costByModel['gpt-4o-mini']).toBeCloseTo(0.000195, 6);
    expect(result.totalCost).toBeCloseTo(0.0315 + 0.000195, 6);
    expect(result.totalInputTokens).toBe(3500);
    expect(result.totalOutputTokens).toBe(1700);
  });

  it('separates customer_visible from internal_only costs', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          purpose: 'generate_response',
        },
      },
      {
        type: 'llm_call',
        data: {
          model: 'claude-sonnet-4',
          inputTokens: 1000,
          outputTokens: 500,
          purpose: 'entity_extraction',
        },
      },
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o-mini',
          inputTokens: 200,
          outputTokens: 100,
          context: 'guardrail_check',
        },
      },
    ];
    const result = rollupAgentTokenCost(events);

    // claude-sonnet-4: (1000/1M)*3 + (500/1M)*15 = 0.0105 per call
    // gpt-4o-mini: (200/1M)*0.15 + (100/1M)*0.6 = 0.00009
    const sonnetCost = 0.0105;
    const miniCost = 0.00009;

    // Total cost = 2*sonnetCost + miniCost
    expect(result.totalCost).toBeCloseTo(2 * sonnetCost + miniCost, 6);

    // Customer visible = only the first call (generate_response)
    expect(result.customerVisibleCost).toBeCloseTo(sonnetCost, 6);
  });

  it('handles events with missing token counts gracefully', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: { model: 'gpt-4o' },
      },
      {
        type: 'llm_call',
        data: { model: 'gpt-4o', inputTokens: 0, outputTokens: 0 },
      },
      {
        type: 'llm_call',
        data: { model: 'gpt-4o', inputTokens: 'not-a-number', outputTokens: null },
      },
    ];
    const result = rollupAgentTokenCost(events);
    expect(result.totalCost).toBe(0);
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
  });

  it('uses default pricing for unknown models', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: { model: 'custom-model-xyz', inputTokens: 1000000, outputTokens: 500000 },
      },
    ];
    const result = rollupAgentTokenCost(events);
    // Default pricing: input $3/1M, output $15/1M
    // (1M/1M)*3 + (500K/1M)*15 = 3 + 7.5 = 10.5
    expect(result.totalCost).toBeCloseTo(10.5, 4);
    expect(result.costByModel['custom-model-xyz']).toBeCloseTo(10.5, 4);
  });

  it('handles missing model string — uses "unknown" key', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: { inputTokens: 1000, outputTokens: 500 },
      },
    ];
    const result = rollupAgentTokenCost(events);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.costByModel['unknown']).toBeGreaterThan(0);
  });

  it('uses context field as fallback when purpose is absent', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          inputTokens: 1000,
          outputTokens: 500,
          context: 'scoring',
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    // scoring is internal_only, so customerVisibleCost should be 0
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.customerVisibleCost).toBe(0);
  });

  it('reads tokensIn/tokensOut fields (runtime reasoning-executor format)', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          operationType: 'response_gen',
          tokensIn: 1000,
          tokensOut: 500,
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    // gpt-4o: input $2.5/1M, output $10/1M
    expect(result.totalCost).toBeCloseTo(0.0075, 6);
    expect(result.totalInputTokens).toBe(1000);
    expect(result.totalOutputTokens).toBe(500);
    // response_gen is customer_visible
    expect(result.customerVisibleCost).toBeCloseTo(0.0075, 6);
  });

  it('reads tokenUsage.input/output fields (trace-manager-adapter format)', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          purpose: 'generate_response',
          tokenUsage: { input: 1000, output: 500 },
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    expect(result.totalCost).toBeCloseTo(0.0075, 6);
    expect(result.totalInputTokens).toBe(1000);
    expect(result.totalOutputTokens).toBe(500);
  });

  it('reads usage.inputTokens/outputTokens fields (flow-step-executor format)', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          purpose: 'entity_extraction',
          tokensIn: 800,
          tokensOut: 200,
          usage: { inputTokens: 800, outputTokens: 200 },
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    // tokensIn takes priority over usage.inputTokens
    expect(result.totalInputTokens).toBe(800);
    expect(result.totalOutputTokens).toBe(200);
    // entity_extraction is internal_only
    expect(result.customerVisibleCost).toBe(0);
  });

  it('classifies operationType for visibility (extraction = internal)', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          operationType: 'extraction',
          tokensIn: 1000,
          tokensOut: 500,
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.customerVisibleCost).toBe(0);
  });

  it('classifies operationType for visibility (validation = internal)', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          operationType: 'validation',
          tokensIn: 500,
          tokensOut: 100,
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    expect(result.customerVisibleCost).toBe(0);
  });

  it('classifies operationType response_gen as customer_visible', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'claude-sonnet-4',
          operationType: 'response_gen',
          tokensIn: 2000,
          tokensOut: 1000,
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    expect(result.customerVisibleCost).toBe(result.totalCost);
  });

  it('prefers purpose over operationType for visibility classification', () => {
    const events: TraceEventForCostRollup[] = [
      {
        type: 'llm_call',
        data: {
          model: 'gpt-4o',
          // purpose says entity_extraction (internal), operationType says response_gen (customer)
          purpose: 'entity_extraction',
          operationType: 'response_gen',
          tokensIn: 1000,
          tokensOut: 500,
        },
      },
    ];
    const result = rollupAgentTokenCost(events);
    // purpose takes priority, so internal_only
    expect(result.customerVisibleCost).toBe(0);
  });
});
