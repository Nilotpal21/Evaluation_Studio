/**
 * Gather Field Semantics Tests
 *
 * Verifies that GatherFieldSemantics works correctly on GatherField
 * and FlowGatherField, and that Kore entity type mapping produces
 * the expected type + semantics pairs.
 */

import { describe, test, expect } from 'vitest';
import type {
  GatherField,
  FlowGatherField,
  GatherFieldSemantics,
  AgentIR,
  FlowStep,
} from '../platform/ir/schema.js';
import { resolveKoreEntity } from '../platform/utils/kore-entity-map.js';

// ---------------------------------------------------------------------------
// Helper: minimal AgentIR with gather fields
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
    // mode is deprecated — execution style derived from flow presence
    execution: { hints: {} as any, timeouts: {} as any },
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
// GatherField + semantics
// ---------------------------------------------------------------------------

describe('GatherField with GatherFieldSemantics', () => {
  test('address semantics with components creates valid GatherField', () => {
    const semantics: GatherFieldSemantics = {
      format: 'address',
      components: ['street', 'city', 'state', 'zip', 'country'],
    };
    const field: GatherField = {
      name: 'shipping_address',
      prompt: 'What is your shipping address?',
      type: 'string',
      required: true,
      extraction_hints: ['full mailing address'],
      semantics,
    };

    expect(field.semantics).toBeDefined();
    expect(field.semantics!.format).toBe('address');
    expect(field.semantics!.components).toEqual(['street', 'city', 'state', 'zip', 'country']);
  });

  test('currency semantics with unit creates valid GatherField', () => {
    const semantics: GatherFieldSemantics = {
      unit: 'currency',
      format: 'USD',
    };
    const field: GatherField = {
      name: 'budget',
      prompt: 'What is your budget?',
      type: 'number',
      required: true,
      semantics,
    };

    expect(field.semantics).toBeDefined();
    expect(field.semantics!.unit).toBe('currency');
    expect(field.semantics!.format).toBe('USD');
  });

  test('airport code semantics with lookup creates valid GatherField', () => {
    const semantics: GatherFieldSemantics = {
      format: 'airport_code',
      lookup: 'iata_codes',
    };
    const field: GatherField = {
      name: 'departure_airport',
      prompt: 'Which airport are you departing from?',
      type: 'string',
      required: true,
      semantics,
    };

    expect(field.semantics).toBeDefined();
    expect(field.semantics!.format).toBe('airport_code');
    expect(field.semantics!.lookup).toBe('iata_codes');
  });

  test('GatherField with semantics compiles into AgentIR gather config', () => {
    const agent = makeAgent({
      gatherFields: [
        {
          name: 'destination',
          prompt: 'Where to?',
          type: 'string',
          required: true,
          semantics: { format: 'airport_code', lookup: 'iata_codes' },
        },
      ],
    });

    expect(agent.gather.fields).toHaveLength(1);
    expect(agent.gather.fields[0].semantics).toEqual({
      format: 'airport_code',
      lookup: 'iata_codes',
    });
  });
});

// ---------------------------------------------------------------------------
// FlowGatherField + semantics
// ---------------------------------------------------------------------------

describe('FlowGatherField with GatherFieldSemantics', () => {
  test('FlowGatherField with address semantics creates valid object', () => {
    const field: FlowGatherField = {
      name: 'home_address',
      type: 'string',
      required: true,
      prompt: 'What is your home address?',
      semantics: {
        format: 'address',
        components: ['street', 'city', 'state', 'zip', 'country'],
      },
    };

    expect(field.semantics).toBeDefined();
    expect(field.semantics!.format).toBe('address');
    expect(field.semantics!.components).toEqual(['street', 'city', 'state', 'zip', 'country']);
  });

  test('FlowGatherField with currency semantics creates valid object', () => {
    const field: FlowGatherField = {
      name: 'price_range',
      type: 'number',
      required: true,
      semantics: { unit: 'currency', format: 'USD' },
    };

    expect(field.semantics!.unit).toBe('currency');
    expect(field.semantics!.format).toBe('USD');
  });

  test('FlowGatherField with semantics compiles into flow step gather config', () => {
    const agent = makeAgent({
      steps: {
        collect_info: {
          gather: {
            fields: [
              {
                name: 'airport',
                type: 'string',
                required: true,
                semantics: { format: 'airport_code', lookup: 'iata_codes' },
              } as FlowGatherField,
            ],
            strategy: 'hybrid',
          },
          then: 'next_step',
        },
        next_step: {
          respond: 'Done',
        },
      },
    });

    const stepDef = agent.flow!.definitions['collect_info'];
    expect(stepDef.gather).toBeDefined();
    expect(stepDef.gather!.fields[0].semantics).toEqual({
      format: 'airport_code',
      lookup: 'iata_codes',
    });
  });
});

// ---------------------------------------------------------------------------
// Kore entity type mapping
// ---------------------------------------------------------------------------

describe('Kore entity type mapping (resolveKoreEntity)', () => {
  test('LOC_AIRPORT maps to string type with airport_code semantics', () => {
    const mapping = resolveKoreEntity('LOC_AIRPORT');

    expect(mapping).toBeDefined();
    expect(mapping!.type).toBe('string');
    expect(mapping!.semantics.format).toBe('airport_code');
    expect(mapping!.semantics.lookup).toBe('iata_codes');
    expect(mapping!.semantics.kore_entity_type).toBe('LOC_AIRPORT');
  });

  test('CURRENCY maps to number type with currency semantics', () => {
    const mapping = resolveKoreEntity('CURRENCY');

    expect(mapping).toBeDefined();
    expect(mapping!.type).toBe('number');
    expect(mapping!.semantics.unit).toBe('currency');
    expect(mapping!.semantics.format).toBe('currency_amount');
    expect(mapping!.semantics.kore_entity_type).toBe('CURRENCY');
  });

  test('unknown entity type returns undefined', () => {
    const mapping = resolveKoreEntity('NONEXISTENT_ENTITY');

    expect(mapping).toBeUndefined();
  });

  test('LOC_ADDRESS maps to string type with address semantics and components', () => {
    const mapping = resolveKoreEntity('LOC_ADDRESS');

    expect(mapping).toBeDefined();
    expect(mapping!.type).toBe('string');
    expect(mapping!.semantics.format).toBe('address');
    expect(mapping!.semantics.components).toEqual(['street', 'city', 'state', 'zip', 'country']);
    expect(mapping!.semantics.kore_entity_type).toBe('LOC_ADDRESS');
  });
});
