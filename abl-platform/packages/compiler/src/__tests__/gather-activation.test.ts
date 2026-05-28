/**
 * GatherActivation and depends_on Tests
 *
 * Validates GatherActivation modes (required, optional, progressive, data-driven)
 * and the depends_on field on GatherField / FlowGatherField.
 * Includes tests that should FAIL initially (depends_on validation not yet implemented).
 */

import { describe, test, expect } from 'vitest';
import { validateFieldReferences } from '../platform/ir/validate-field-refs.js';
import type {
  GatherField,
  GatherActivation,
  FlowGatherField,
  AgentIR,
  FlowStep,
} from '../platform/ir/schema.js';

// ---------------------------------------------------------------------------
// Helper: create a minimal AgentIR for validation tests
// ---------------------------------------------------------------------------

function makeAgent(overrides?: {
  gatherFields?: GatherField[];
  steps?: Record<string, Partial<FlowStep>>;
}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { hints: {} as any, timeouts: {} as any }, // mode deprecated — derived from flow presence
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: {
      fields: overrides?.gatherFields ?? [],
      strategy: 'hybrid',
    },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: overrides?.steps
      ? {
          steps: Object.keys(overrides.steps),
          entry_point: Object.keys(overrides.steps)[0],
          definitions: Object.fromEntries(
            Object.entries(overrides.steps).map(([name, s]) => [name, { name, ...s } as FlowStep]),
          ),
        }
      : undefined,
  } as AgentIR;
}

// ---------------------------------------------------------------------------
// GatherActivation type-level tests
// ---------------------------------------------------------------------------

describe('GatherActivation on GatherField', () => {
  test('activation="optional" creates a valid GatherField', () => {
    const field: GatherField = {
      name: 'loyalty_number',
      prompt: 'Do you have a loyalty number?',
      type: 'string',
      required: false,
      extraction_hints: [],
      activation: 'optional',
    };

    expect(field.activation).toBe('optional');
    expect(field.name).toBe('loyalty_number');
  });

  test('activation="progressive" with depends_on creates a valid GatherField', () => {
    const field: GatherField = {
      name: 'room_type',
      prompt: 'What type of room would you like?',
      type: 'string',
      required: true,
      extraction_hints: [],
      activation: 'progressive',
      depends_on: ['destination', 'travel_dates'],
    };

    expect(field.activation).toBe('progressive');
    expect(field.depends_on).toEqual(['destination', 'travel_dates']);
  });

  test('activation={ when: "..." } (data-driven) creates a valid GatherField', () => {
    const activation: GatherActivation = { when: "search_results contains 'Hale Koa'" };
    const field: GatherField = {
      name: 'military_id',
      prompt: 'Please provide your military ID for Hale Koa eligibility.',
      type: 'string',
      required: true,
      extraction_hints: [],
      activation,
    };

    expect(field.activation).toEqual({ when: "search_results contains 'Hale Koa'" });
    expect(typeof (field.activation as { when: string }).when).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// FlowGatherField with activation + depends_on
// ---------------------------------------------------------------------------

describe('FlowGatherField with activation and depends_on', () => {
  test('FlowGatherField with activation="progressive" and depends_on is valid', () => {
    const field: FlowGatherField = {
      name: 'room_preference',
      type: 'string',
      required: true,
      prompt: 'Any room preferences?',
      activation: 'progressive',
      depends_on: ['destination', 'check_in_date'],
    };

    expect(field.activation).toBe('progressive');
    expect(field.depends_on).toEqual(['destination', 'check_in_date']);
    expect(field.required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation: depends_on references must point to declared fields
// NOTE: These tests should FAIL initially since validateFieldReferences
//       does not yet check depends_on references.
// ---------------------------------------------------------------------------

describe('depends_on reference validation', () => {
  test('depends_on referencing a nonexistent field should produce a diagnostic', () => {
    const agent = makeAgent({
      gatherFields: [
        {
          name: 'destination',
          prompt: 'Where are you going?',
          type: 'string',
          required: true,
          extraction_hints: [],
        },
        {
          name: 'room_type',
          prompt: 'What room type?',
          type: 'string',
          required: true,
          extraction_hints: [],
          activation: 'progressive',
          depends_on: ['nonexistent'],
        },
      ],
    });

    const diags = validateFieldReferences(agent);
    // Should have at least one diagnostic about the invalid depends_on reference.
    // This test is expected to FAIL until the validator is updated to check depends_on.
    expect(diags.length).toBeGreaterThanOrEqual(1);
    const dependsDiag = diags.find((d) => d.message.includes('nonexistent'));
    expect(dependsDiag).toBeDefined();
  });

  test('circular depends_on (A depends_on B, B depends_on A) should produce an error', () => {
    const agent = makeAgent({
      gatherFields: [
        {
          name: 'field_a',
          prompt: 'Field A?',
          type: 'string',
          required: true,
          extraction_hints: [],
          activation: 'progressive',
          depends_on: ['field_b'],
        },
        {
          name: 'field_b',
          prompt: 'Field B?',
          type: 'string',
          required: true,
          extraction_hints: [],
          activation: 'progressive',
          depends_on: ['field_a'],
        },
      ],
    });

    const diags = validateFieldReferences(agent);
    // Should detect the circular dependency and produce a diagnostic.
    // This test is expected to FAIL until the validator is updated.
    expect(diags.length).toBeGreaterThanOrEqual(1);
    const circularDiag = diags.find(
      (d) => d.message.includes('circular') || d.message.includes('cycle'),
    );
    expect(circularDiag).toBeDefined();
  });
});
