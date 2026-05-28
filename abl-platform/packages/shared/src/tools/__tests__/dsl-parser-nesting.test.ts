/**
 * DSL Parser Nesting Isolation Tests
 *
 * Verifies that the DSL validator's parseDslContent correctly isolates
 * top-level properties (2-space indent) from nested block entries (4+ space).
 *
 * Root cause this tests against: nested key-value entries (e.g. a header
 * named "auth" or a query param named "type") were being promoted to
 * top-level properties, shadowing real DSL keywords and causing spurious
 * validation failures.
 */

import { describe, expect, it } from 'vitest';
import { validateToolDsl } from '../project-tool-validator.js';
import { serializeToolFormToDsl } from '../serialize-tool-form-to-dsl.js';
import type { HttpToolFormData, McpToolFormData } from '../../types/project-tool-form.js';

const ctx = { tenantId: 'tenant-1', projectId: 'project-1' };

// Helper: build a minimal valid HTTP DSL and append extra lines
function httpDsl(extraLines: string[]): string {
  return [
    'my_tool() -> object',
    '  description: "test tool"',
    '  type: http',
    '  endpoint: "https://api.example.com"',
    '  method: GET',
    ...extraLines,
  ].join('\n');
}

// =============================================================================
// HEADERS WITH DSL-KEYWORD NAMES
// =============================================================================

describe('headers with names that collide with DSL keywords', () => {
  it('header named "auth" does not shadow top-level auth property', () => {
    const dsl = httpDsl(['  headers:', '    auth: my-token']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
    // If nesting was broken, properties.auth would be "my-token" → invalid auth type error
  });

  it('header named "type" does not shadow tool type', () => {
    const dsl = httpDsl(['  headers:', '    type: application/json']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('header named "method" does not shadow HTTP method', () => {
    const dsl = httpDsl(['  headers:', '    method: override-value']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('header named "endpoint" does not shadow endpoint URL', () => {
    const dsl = httpDsl(['  headers:', '    endpoint: https://evil.com']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
    // The real endpoint should remain https://api.example.com
  });

  it('header named "description" does not shadow tool description', () => {
    const dsl = httpDsl(['  headers:', '    description: overridden']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('header named "timeout" does not shadow timeout setting', () => {
    const dsl = httpDsl(['  headers:', '    timeout: 999999']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('header named "retry" does not shadow retry count', () => {
    const dsl = httpDsl(['  headers:', '    retry: abc']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('header named "protocol" does not shadow SOAP protocol', () => {
    const dsl = httpDsl(['  headers:', '    protocol: grpc']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('multiple headers with DSL-keyword names all ignored correctly', () => {
    const dsl = httpDsl([
      '  headers:',
      '    auth: bearer-token',
      '    type: text/html',
      '    method: PATCH',
      '    endpoint: https://wrong.com',
      '    description: wrong-desc',
    ]);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// QUERY PARAMS WITH DSL-KEYWORD NAMES
// =============================================================================

describe('query params with names that collide with DSL keywords', () => {
  it('query param named "auth" does not shadow auth type', () => {
    const dsl = httpDsl(['  query_params:', '    auth: my-api-key']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('query param named "type" does not shadow tool type', () => {
    const dsl = httpDsl(['  query_params:', '    type: json']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('query param named "method" does not shadow HTTP method', () => {
    const dsl = httpDsl(['  query_params:', '    method: DELETE']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// AUTH CONFIG ENTRIES WITH DSL-KEYWORD NAMES
// =============================================================================

describe('auth_config entries with names that collide with DSL keywords', () => {
  it('auth_config with "type" key does not shadow tool type', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      '  auth: api_key',
      '  auth_config:',
      '    api_key: sk-123',
      '    header_name: X-Key',
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// CUSTOM HEADERS (6-SPACE INDENT) WITH DSL-KEYWORD NAMES
// =============================================================================

describe('custom_headers entries at 6-space indent', () => {
  it('custom header named "auth" at deep nesting does not leak', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: POST',
      '  auth: custom',
      '  auth_config:',
      '    custom_headers:',
      '      auth: Bearer secret-token',
      '      type: application/json',
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// CIRCUIT BREAKER ENTRIES
// =============================================================================

describe('circuit_breaker entries do not leak to top-level', () => {
  it('circuit_breaker threshold/reset_ms stay nested', () => {
    const dsl = httpDsl(['  circuit_breaker:', '    threshold: 5', '    reset_ms: 30000']);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// PARAMS BLOCK WITH DSL-KEYWORD NAMES
// =============================================================================

describe('parameter metadata entries do not leak', () => {
  it('param named "type" with description does not shadow tool type', () => {
    const dsl = [
      'my_tool(type: string) -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      '  params:',
      '    type:',
      '      description: "The content type"',
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('param named "auth" with description does not shadow auth type', () => {
    const dsl = [
      'my_tool(auth: string) -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      '  params:',
      '    auth:',
      '      description: "Auth mode parameter"',
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// REAL TOP-LEVEL PROPERTIES STILL WORK
// =============================================================================

describe('real top-level properties are correctly parsed', () => {
  it('valid auth type at top level is accepted', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: POST',
      '  auth: bearer',
      '  auth_config:',
      '    token: "sk-123"',
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('invalid auth type at top level is still caught', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      '  auth: completely_bogus',
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'E735',
          message: expect.stringContaining('completely_bogus'),
        }),
      ]),
    );
  });

  it('all standard top-level HTTP properties are parsed', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "full config"',
      '  type: http',
      '  endpoint: "https://api.example.com/v1"',
      '  method: POST',
      '  auth: api_key',
      '  auth_config:',
      '    api_key: sk-123',
      '    header_name: X-Key',
      '  body_type: json',
      '  timeout: 5000',
      '  retry: 3',
      '  retry_delay: 500',
      '  rate_limit: 60',
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// TABS VS SPACES EDGE CASES
// =============================================================================

describe('indentation edge cases', () => {
  it('tab-indented lines are not treated as top-level properties', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      '\tauth: bearer', // tab indent
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    // Tab indent ≠ 2 spaces, so auth: bearer is ignored
    expect(result.valid).toBe(true);
  });

  it('3-space indent is not treated as top-level', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      '   auth: invalid_type', // 3 spaces
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('1-space indent is not treated as top-level', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      ' auth: invalid_type', // 1 space
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('0-indent (no spaces) line is not treated as top-level property', () => {
    const dsl = [
      'my_tool() -> object',
      '  description: "test"',
      '  type: http',
      '  endpoint: "https://api.example.com"',
      '  method: GET',
      'auth: invalid_type', // 0 spaces
    ].join('\n');
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// SERIALIZER → VALIDATOR INTEGRATION (FULL ROUND-TRIP)
// =============================================================================

describe('serializer → validator round-trip with adversarial inputs', () => {
  it('tool with header named "auth" passes validation after serialization', () => {
    const form: HttpToolFormData = {
      name: 'weather_api',
      toolType: 'http',
      description: 'Gets weather',
      parameters: [{ name: 'city', type: 'string', description: 'city', required: true }],
      returnType: 'object',
      endpoint: 'https://wttr.in/{{input.city}}',
      method: 'GET',
      auth: 'none',
      headers: [{ key: 'auth', value: 'test-token' }],
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('tool with header named "type" passes validation', () => {
    const form: HttpToolFormData = {
      name: 'typed_api',
      toolType: 'http',
      description: 'API with type header',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'none',
      headers: [
        { key: 'type', value: 'application/json' },
        { key: 'method', value: 'override' },
      ],
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('tool with query param named "type" passes validation', () => {
    const form: HttpToolFormData = {
      name: 'search_api',
      toolType: 'http',
      description: 'Search',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/search',
      method: 'GET',
      auth: 'none',
      queryParams: [
        { key: 'type', value: 'document' },
        { key: 'auth', value: 'public' },
      ],
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('tool with custom auth headers with DSL-keyword names passes', () => {
    const form: HttpToolFormData = {
      name: 'custom_auth_api',
      toolType: 'http',
      description: 'Custom auth',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'custom',
      authConfig: {
        customHeaders: {
          type: 'bearer',
          method: 'custom-method',
          endpoint: 'https://override.com',
          description: 'overridden',
        },
      },
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('tool with circuit breaker does not leak threshold/reset_ms', () => {
    const form: HttpToolFormData = {
      name: 'resilient_api',
      toolType: 'http',
      description: 'Resilient API',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      circuitBreaker: { threshold: 5, resetMs: 30000 },
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('tool with api_key auth AND header named "auth" passes', () => {
    const form: HttpToolFormData = {
      name: 'dual_auth_api',
      toolType: 'http',
      description: 'API key auth with auth header',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: 'sk-123',
      },
      headers: [{ key: 'auth', value: 'extra-token' }],
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    // auth should remain api_key from top-level, not "extra-token" from header
    expect(result.valid).toBe(true);
  });

  it('MCP tool with header named "server" passes validation', () => {
    const form: McpToolFormData = {
      name: 'mcp_with_server_header',
      toolType: 'mcp',
      description: 'MCP with server header',
      parameters: [],
      returnType: 'object',
      server: 'https://mcp.example.com/sse',
      headers: [{ key: 'server', value: 'override-server' }],
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });

  it('tool with all nested blocks containing collision-prone names passes', () => {
    const form: HttpToolFormData = {
      name: 'max_collision_test',
      toolType: 'http',
      description: 'Every nested block has colliding names',
      parameters: [
        { name: 'type', type: 'string', description: 'type param', required: true },
        { name: 'auth', type: 'string', description: 'auth param', required: false },
      ],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'custom',
      authConfig: {
        customHeaders: {
          type: 'bearer',
          method: 'custom',
        },
      },
      headers: [
        { key: 'auth', value: 'header-auth' },
        { key: 'type', value: 'header-type' },
        { key: 'method', value: 'header-method' },
        { key: 'endpoint', value: 'header-endpoint' },
        { key: 'description', value: 'header-desc' },
      ],
      queryParams: [
        { key: 'type', value: 'qp-type' },
        { key: 'auth', value: 'qp-auth' },
      ],
    };
    const dsl = serializeToolFormToDsl(form);
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
  });
});
