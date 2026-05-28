/**
 * Parser Lookup Table Headers Tests (GAP-4)
 *
 * Verifies that the parser correctly parses the `headers` sub-block
 * on lookup table definitions for API source auth header forwarding.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('LOOKUP_TABLES headers parsing', () => {
  test('parses headers sub-block on API source', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
LOOKUP_TABLES:
  products:
    source: api
    endpoint: https://api.example.com/products/lookup
    timeout_ms: 3000
    headers:
      Authorization: Bearer my-token-123
      X-API-Key: secret-key
    case_sensitive: false
    fuzzy_match: false
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const table = result.document!.lookupTables!['products'];
    expect(table).toBeDefined();
    expect(table.headers).toEqual({
      Authorization: 'Bearer my-token-123',
      'X-API-Key': 'secret-key',
    });
  });

  test('headers is undefined when not specified', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
LOOKUP_TABLES:
  cities:
    source: inline
    values: NYC, LAX, CDG
    case_sensitive: false
    fuzzy_match: false
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const table = result.document!.lookupTables!['cities'];
    expect(table.headers).toBeUndefined();
  });

  test('headers with single entry', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
LOOKUP_TABLES:
  products:
    source: api
    endpoint: https://api.example.com/lookup
    headers:
      Authorization: Bearer token
    case_sensitive: false
    fuzzy_match: false
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const table = result.document!.lookupTables!['products'];
    expect(table.headers).toEqual({
      Authorization: 'Bearer token',
    });
  });

  test('headers coexist with other table properties', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
LOOKUP_TABLES:
  products:
    source: api
    endpoint: https://api.example.com/lookup
    timeout_ms: 5000
    field: name
    headers:
      Authorization: Bearer token
    case_sensitive: false
    fuzzy_match: true
    fuzzy_threshold: 0.9
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const table = result.document!.lookupTables!['products'];
    expect(table.source).toBe('api');
    expect(table.endpoint).toBe('https://api.example.com/lookup');
    expect(table.timeoutMs).toBe(5000);
    expect(table.field).toBe('name');
    expect(table.headers).toEqual({ Authorization: 'Bearer token' });
    expect(table.fuzzyMatch).toBe(true);
    expect(table.fuzzyThreshold).toBe(0.9);
  });
});
