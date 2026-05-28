/**
 * Extraction Lookup Value Injection Tests (GAP-3 + GAP-8)
 *
 * Verifies that:
 * - buildExtractionTool injects inline lookup values as JSON Schema enum
 * - Large lookup tables get description-only hints (token budget guard)
 * - API/collection sources are not injected (dynamic)
 * - Enum validation takes precedence over lookup injection
 */

import { describe, test, expect } from 'vitest';
import { FlowStepExecutor } from '../../services/execution/flow-step-executor.js';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';

function makeInlineLookup(
  name: string,
  values: string[],
  overrides?: Partial<LookupTableIR>,
): LookupTableIR {
  return {
    name,
    source: 'inline',
    values,
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
    ...overrides,
  };
}

describe('buildExtractionTool — lookup value injection', () => {
  test('injects inline lookup values as JSON Schema enum', () => {
    const lookupTables: Record<string, LookupTableIR> = {
      cabin_classes: makeInlineLookup('cabin_classes', ['economy', 'business', 'first']),
    };

    const tool = FlowStepExecutor.buildExtractionTool(
      [
        {
          name: 'cabin_class',
          type: 'string',
          prompt: 'What cabin class?',
          semantics: { lookup: 'cabin_classes' },
        },
      ],
      lookupTables,
    );

    expect(tool.input_schema.properties.cabin_class.enum).toEqual(['economy', 'business', 'first']);
  });

  test('does not inject when field already has enum validation', () => {
    const lookupTables: Record<string, LookupTableIR> = {
      cabin_classes: makeInlineLookup('cabin_classes', ['economy', 'business', 'first']),
    };

    const tool = FlowStepExecutor.buildExtractionTool(
      [
        {
          name: 'cabin_class',
          type: 'string',
          prompt: 'What cabin class?',
          validation: { type: 'enum', rule: 'economy|business|first' },
          semantics: { lookup: 'cabin_classes' },
        },
      ],
      lookupTables,
    );

    // Enum comes from validation, not lookup injection
    expect(tool.input_schema.properties.cabin_class.enum).toEqual(['economy', 'business', 'first']);
  });

  test('does not inject for collection source (dynamic)', () => {
    const lookupTables: Record<string, LookupTableIR> = {
      cities: {
        name: 'cities',
        source: 'collection',
        table_name: 'cities',
        case_sensitive: false,
        fuzzy_match: true,
        fuzzy_threshold: 0.85,
      },
    };

    const tool = FlowStepExecutor.buildExtractionTool(
      [
        {
          name: 'city',
          type: 'string',
          prompt: 'Which city?',
          semantics: { lookup: 'cities' },
        },
      ],
      lookupTables,
    );

    expect(tool.input_schema.properties.city.enum).toBeUndefined();
  });

  test('does not inject for api source (dynamic)', () => {
    const lookupTables: Record<string, LookupTableIR> = {
      products: {
        name: 'products',
        source: 'api',
        endpoint: 'https://api.example.com/products',
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      },
    };

    const tool = FlowStepExecutor.buildExtractionTool(
      [
        {
          name: 'product',
          type: 'string',
          prompt: 'Which product?',
          semantics: { lookup: 'products' },
        },
      ],
      lookupTables,
    );

    expect(tool.input_schema.properties.product.enum).toBeUndefined();
  });

  test('uses description hint when lookup has >100 values (token budget)', () => {
    const manyValues = Array.from({ length: 150 }, (_, i) => `value_${i}`);
    const lookupTables: Record<string, LookupTableIR> = {
      big_table: makeInlineLookup('big_table', manyValues),
    };

    const tool = FlowStepExecutor.buildExtractionTool(
      [
        {
          name: 'item',
          type: 'string',
          prompt: 'Pick an item',
          semantics: { lookup: 'big_table' },
        },
      ],
      lookupTables,
    );

    // Should NOT inject as enum (too large)
    expect(tool.input_schema.properties.item.enum).toBeUndefined();
    // Should add description hint with sample
    expect(tool.input_schema.properties.item.description).toContain('valid values include');
    expect(tool.input_schema.properties.item.description).toContain('150 total');
    expect(tool.input_schema.properties.item.description).toContain('value_0');
  });

  test('injects values at exactly 100 entries as enum (boundary)', () => {
    const values = Array.from({ length: 100 }, (_, i) => `opt_${i}`);
    const lookupTables: Record<string, LookupTableIR> = {
      boundary_table: makeInlineLookup('boundary_table', values),
    };

    const tool = FlowStepExecutor.buildExtractionTool(
      [
        {
          name: 'choice',
          type: 'string',
          prompt: 'Choose',
          semantics: { lookup: 'boundary_table' },
        },
      ],
      lookupTables,
    );

    expect(tool.input_schema.properties.choice.enum).toHaveLength(100);
  });

  test('handles missing lookup table gracefully', () => {
    const tool = FlowStepExecutor.buildExtractionTool(
      [
        {
          name: 'item',
          type: 'string',
          prompt: 'Pick',
          semantics: { lookup: 'nonexistent_table' },
        },
      ],
      {},
    );

    expect(tool.input_schema.properties.item.enum).toBeUndefined();
  });

  test('handles no lookup tables param gracefully', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      {
        name: 'item',
        type: 'string',
        prompt: 'Pick',
        semantics: { lookup: 'some_table' },
      },
    ]);

    expect(tool.input_schema.properties.item.enum).toBeUndefined();
  });

  test('field without semantics.lookup is not affected', () => {
    const lookupTables: Record<string, LookupTableIR> = {
      cabin_classes: makeInlineLookup('cabin_classes', ['economy', 'business', 'first']),
    };

    const tool = FlowStepExecutor.buildExtractionTool(
      [{ name: 'destination', type: 'string', prompt: 'Where to?' }],
      lookupTables,
    );

    expect(tool.input_schema.properties.destination.enum).toBeUndefined();
  });
});
