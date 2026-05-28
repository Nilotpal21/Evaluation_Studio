/**
 * Phase 3 DSL Parser Feature Tests
 *
 * Tests for:
 * - LOOKUP_TABLES section parsing (inline, collection, api sources)
 * - GATHER field infer_confidence and infer_confirm properties
 * - GATHER field semantics.convert_to property
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

// =============================================================================
// LOOKUP_TABLES Section
// =============================================================================

describe('Phase 3 DSL parser features', () => {
  describe('LOOKUP_TABLES section', () => {
    it('parses inline lookup table', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

LOOKUP_TABLES:
  iata_codes:
    source: inline
    values: [LAX, JFK, CDG, LHR, NRT]
    case_sensitive: false
    fuzzy_match: false

FLOW:
  start:
    REASONING: false
    SAY: "Hello"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document!.lookupTables).toBeDefined();
      expect(result.document!.lookupTables!['iata_codes']).toBeDefined();

      const table = result.document!.lookupTables!['iata_codes'];
      expect(table.source).toBe('inline');
      expect(table.values).toEqual(['LAX', 'JFK', 'CDG', 'LHR', 'NRT']);
      expect(table.caseSensitive).toBe(false);
      expect(table.fuzzyMatch).toBe(false);
    });

    it('parses collection lookup table', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

LOOKUP_TABLES:
  hotels:
    source: collection
    table_name: lookup_hotels
    field: name
    fuzzy_match: true
    fuzzy_threshold: 0.85

FLOW:
  start:
    REASONING: false
    SAY: "Hello"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const table = result.document!.lookupTables!['hotels'];
      expect(table.source).toBe('collection');
      expect(table.tableName).toBe('lookup_hotels');
      expect(table.field).toBe('name');
      expect(table.fuzzyMatch).toBe(true);
      expect(table.fuzzyThreshold).toBe(0.85);
    });

    it('parses api lookup table', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

LOOKUP_TABLES:
  products:
    source: api
    endpoint: https://api.example.com/lookup
    field: sku

FLOW:
  start:
    REASONING: false
    SAY: "Hello"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const table = result.document!.lookupTables!['products'];
      expect(table.source).toBe('api');
      expect(table.endpoint).toBe('https://api.example.com/lookup');
      expect(table.field).toBe('sku');
    });

    it('parses multiple lookup tables', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

LOOKUP_TABLES:
  airports:
    source: inline
    values: [LAX, JFK, CDG]
  hotel_chains:
    source: collection
    table_name: lookup_hotel_chains
    field: chain_name

FLOW:
  start:
    REASONING: false
    SAY: "Hello"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      expect(result.document!.lookupTables).toBeDefined();
      expect(result.document!.lookupTables!['airports']).toBeDefined();
      expect(result.document!.lookupTables!['hotel_chains']).toBeDefined();

      expect(result.document!.lookupTables!['airports'].source).toBe('inline');
      expect(result.document!.lookupTables!['hotel_chains'].source).toBe('collection');
    });

    it('defaults fuzzy_match and case_sensitive when not specified', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

LOOKUP_TABLES:
  codes:
    source: inline
    values: [A, B, C]

FLOW:
  start:
    REASONING: false
    SAY: "Hello"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const table = result.document!.lookupTables!['codes'];
      expect(table.source).toBe('inline');
      expect(table.values).toEqual(['A', 'B', 'C']);
      // Defaults should be false
      expect(table.caseSensitive).toBe(false);
      expect(table.fuzzyMatch).toBe(false);
    });
  });

  // =============================================================================
  // GATHER field infer properties
  // =============================================================================

  describe('GATHER field infer properties', () => {
    it('parses infer_confidence and infer_confirm on top-level gather field', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

GATHER:
  hotel_class:
    PROMPT: "What class?"
    TYPE: string
    INFER: true
    INFER_CONFIDENCE: 0.85
    INFER_CONFIRM: true
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const field = result.document!.gather[0];
      expect(field).toBeDefined();
      expect(field.name).toBe('hotel_class');
      expect(field.infer).toBe(true);
      expect(field.inferConfidence).toBe(0.85);
      expect(field.inferConfirm).toBe(true);
    });

    it('parses infer_confidence and infer_confirm on flow gather field', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

FLOW:
  start:
    REASONING: false
    GATHER:
      - hotel_class:
        TYPE: string
        PROMPT: "What class?"
        INFER: true
        INFER_CONFIDENCE: 0.9
        INFER_CONFIRM: false
    THEN: done
  done:
    REASONING: false
    SAY: "Done"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const step = result.document!.flow!.definitions['start'];
      expect(step).toBeDefined();
      expect(step.gather).toBeDefined();
      expect(step.gather!.fields).toHaveLength(1);

      const field = step.gather!.fields[0];
      expect(field.name).toBe('hotel_class');
      expect(field.infer).toBe(true);
      expect(field.inferConfidence).toBe(0.9);
      expect(field.inferConfirm).toBe(false);
    });
  });

  // =============================================================================
  // GATHER field semantics.convert_to
  // =============================================================================

  describe('GATHER field convert_to property', () => {
    it('parses semantics.convert_to on top-level gather field', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

GATHER:
  temperature:
    PROMPT: "Temperature?"
    TYPE: number
    SEMANTICS:
      UNIT: fahrenheit
      CONVERT_TO: celsius
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const field = result.document!.gather[0];
      expect(field).toBeDefined();
      expect(field.name).toBe('temperature');
      expect(field.semantics).toBeDefined();
      expect(field.semantics!.unit).toBe('fahrenheit');
      expect(field.semantics!.convertTo).toBe('celsius');
    });

    it('parses semantics.convert_to on flow gather field', () => {
      const dsl = `AGENT: test_agent

GOAL: "Test"

FLOW:
  start:
    REASONING: false
    GATHER:
      - weight:
        TYPE: number
        PROMPT: "Weight?"
        SEMANTICS:
          UNIT: pounds
          CONVERT_TO: kilograms
    THEN: done
  done:
    REASONING: false
    SAY: "Done"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const step = result.document!.flow!.definitions['start'];
      const field = step.gather!.fields[0];
      expect(field.semantics).toBeDefined();
      // The parser maps snake_case semantics keys to camelCase
      expect((field.semantics as any).unit).toBe('pounds');
      expect((field.semantics as any).convertTo).toBe('kilograms');
    });
  });
});
