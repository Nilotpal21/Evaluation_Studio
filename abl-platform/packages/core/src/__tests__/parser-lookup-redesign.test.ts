/**
 * Lookup Table Redesign — Parser Tests
 *
 * Tests for:
 * - New source types: collection, api
 * - Backward compatibility: mongodb -> collection, http -> api
 * - Legacy collection: keyword mapping to tableName
 * - Compile-time validation: table names, field names, URLs, fuzzy+large warnings
 * - timeout_ms parsing
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

const MINIMAL_AGENT = `AGENT: test_agent
GOAL: "Handle agent tasks"`;

const FLOW_SECTION = `
FLOW:
  start:
    REASONING: false
    SAY: "Hello"`;

describe('Lookup Table Redesign', () => {
  describe('source: collection', () => {
    it('parses correctly with table_name', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  airports:
    source: collection
    table_name: lookup_airports
    field: code
    fuzzy_match: true
    fuzzy_threshold: 0.9
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const table = result.document!.lookupTables!['airports'];
      expect(table).toBeDefined();
      expect(table.source).toBe('collection');
      expect(table.tableName).toBe('lookup_airports');
      expect(table.field).toBe('code');
      expect(table.fuzzyMatch).toBe(true);
      expect(table.fuzzyThreshold).toBe(0.9);
    });
  });

  describe('source: api', () => {
    it('parses correctly with endpoint and timeout_ms', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  products:
    source: api
    endpoint: https://api.example.com/lookup/products
    field: sku
    timeout_ms: 3000
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const table = result.document!.lookupTables!['products'];
      expect(table).toBeDefined();
      expect(table.source).toBe('api');
      expect(table.endpoint).toBe('https://api.example.com/lookup/products');
      expect(table.field).toBe('sku');
      expect(table.timeoutMs).toBe(3000);
    });
  });

  describe('backward compatibility', () => {
    it('maps source: mongodb to collection', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  hotels:
    source: mongodb
    table_name: lookup_hotels
    field: name
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const table = result.document!.lookupTables!['hotels'];
      expect(table).toBeDefined();
      expect(table.source).toBe('collection');
      expect(table.tableName).toBe('lookup_hotels');
    });

    it('maps source: http to api', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  products:
    source: http
    endpoint: https://api.example.com/products
    field: name
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const table = result.document!.lookupTables!['products'];
      expect(table).toBeDefined();
      expect(table.source).toBe('api');
      expect(table.endpoint).toBe('https://api.example.com/products');
    });

    it('maps collection: keyword (old DSL) to tableName', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  cities:
    source: collection
    collection: lookup_cities
    field: city_name
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const table = result.document!.lookupTables!['cities'];
      expect(table).toBeDefined();
      expect(table.tableName).toBe('lookup_cities');
    });
  });

  describe('compile-time validation', () => {
    it('rejects invalid table name with uppercase/special chars', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  MyTable:
    source: inline
    values: [a, b, c]
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const nameErrors = result.errors.filter((e) =>
        e.message.includes('Invalid lookup table name'),
      );
      expect(nameErrors.length).toBeGreaterThan(0);
      expect(nameErrors[0].message).toContain("'MyTable'");
      expect(nameErrors[0].message).toContain('must be lowercase alphanumeric');
    });

    it('rejects field name starting with $ (NoSQL injection prevention)', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  hotels:
    source: collection
    table_name: lookup_hotels
    field: $where
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const fieldErrors = result.errors.filter((e) => e.message.includes('Invalid field name'));
      expect(fieldErrors.length).toBeGreaterThan(0);
      expect(fieldErrors[0].message).toContain("'$where'");
      expect(fieldErrors[0].message).toContain('must be alphanumeric with underscores/dots');
    });

    it('rejects invalid endpoint URL for api source', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  products:
    source: api
    endpoint: not-a-valid-url
    field: sku
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const urlErrors = result.errors.filter((e) => e.message.includes('Invalid endpoint URL'));
      expect(urlErrors.length).toBeGreaterThan(0);
      expect(urlErrors[0].message).toContain("'not-a-valid-url'");
      expect(urlErrors[0].message).toContain('must be a valid URL');
    });

    it('emits warning for fuzzy_match with >1000 inline values', () => {
      // Generate 1001 values
      const values = Array.from({ length: 1001 }, (_, i) => `val_${i}`);
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  large_table:
    source: inline
    values: [${values.join(', ')}]
    fuzzy_match: true
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      // Table should still parse (validation produces warning, not error)
      expect(result.document).not.toBeNull();
      expect(result.document!.lookupTables!['large_table']).toBeDefined();

      const fuzzyWarnings = result.warnings.filter((w) =>
        w.message.includes('fuzzy matching enabled'),
      );
      expect(fuzzyWarnings.length).toBeGreaterThan(0);
      expect(fuzzyWarnings[0].message).toContain('1001 values');
      expect(fuzzyWarnings[0].message).toContain('Consider using a collection source');
    });

    it('passes validation for valid table name', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  valid_table_123:
    source: inline
    values: [x, y, z]
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document!.lookupTables!['valid_table_123']).toBeDefined();
    });

    it('passes validation for underscore-prefixed table name', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  _internal:
    source: inline
    values: [a, b]
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.lookupTables!['_internal']).toBeDefined();
    });
  });

  describe('timeout_ms parsing', () => {
    it('parses timeout_ms as a number', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  external_data:
    source: api
    endpoint: https://api.example.com/data
    timeout_ms: 7500
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const table = result.document!.lookupTables!['external_data'];
      expect(table.timeoutMs).toBe(7500);
      expect(typeof table.timeoutMs).toBe('number');
    });
  });

  describe('validation on multi-table DSL', () => {
    it('validates each table independently', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  valid_table:
    source: inline
    values: [a, b, c]
  InvalidName:
    source: api
    endpoint: not-valid
    field: $injection
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);

      // First table (valid_table) should pass, second (InvalidName) should fail
      const nameErrors = result.errors.filter((e) =>
        e.message.includes('Invalid lookup table name'),
      );
      expect(nameErrors.length).toBe(1);
      expect(nameErrors[0].message).toContain("'InvalidName'");

      const fieldErrors = result.errors.filter((e) => e.message.includes('Invalid field name'));
      expect(fieldErrors.length).toBe(1);
      expect(fieldErrors[0].message).toContain("'$injection'");

      const urlErrors = result.errors.filter((e) => e.message.includes('Invalid endpoint URL'));
      expect(urlErrors.length).toBe(1);
      expect(urlErrors[0].message).toContain("'not-valid'");
    });
  });

  describe('source-required field validation', () => {
    it('errors when collection source has no table_name', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  airports:
    source: collection
    field: code
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const errors = result.errors.filter((e) =>
        e.message.includes("source 'collection' but no table_name"),
      );
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain("'airports'");
    });

    it('errors when api source has no endpoint', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  products:
    source: api
    field: sku
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const errors = result.errors.filter((e) =>
        e.message.includes("source 'api' but no endpoint"),
      );
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain("'products'");
    });
  });

  describe('timeout_ms validation', () => {
    it('errors on invalid timeout_ms (NaN)', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  external_data:
    source: api
    endpoint: https://api.example.com/data
    timeout_ms: abc
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const errors = result.errors.filter((e) => e.message.includes('Invalid timeout_ms'));
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('must be a positive number');
    });
  });

  describe('table_name pattern validation', () => {
    it('errors on invalid table_name with path traversal chars', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  airports:
    source: collection
    table_name: ../admin
    field: code
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const errors = result.errors.filter((e) =>
        e.message.includes("Invalid table_name '../admin'"),
      );
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('must be lowercase alphanumeric with underscores');
    });
  });

  describe('unknown source validation', () => {
    it('errors on unknown source type', () => {
      const dsl = `${MINIMAL_AGENT}

LOOKUP_TABLES:
  data_table:
    source: postgres
    field: id
${FLOW_SECTION}
`;
      const result = parseAgentBasedABL(dsl);
      const errors = result.errors.filter((e) => e.message.includes("Unknown source 'postgres'"));
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('must be one of inline, collection, api');
    });
  });
});
