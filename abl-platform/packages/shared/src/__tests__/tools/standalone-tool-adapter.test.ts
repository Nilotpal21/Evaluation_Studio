import { describe, it, expect } from 'vitest';
import {
  convertStandaloneToolDSL,
  loadToolDSLsAsResolved,
} from '../../tools/standalone-tool-adapter.js';

describe('convertStandaloneToolDSL', () => {
  // ─── Sandbox Tools ────────────────────────────────────────────────────

  const sandboxDSL = `TOOL: product_search
VERSION: "1.0"
DESCRIPTION: "Search for products"
TYPE: sandbox
RUNTIME: javascript
TIMEOUT: 15000
MEMORY_MB: 128

PARAMETERS:
  queries:
    type: object[]
    description: "Array of search queries"
    required: true

CODE: |
  const url = env.SEARCH_URL || "https://example.com";
  return { success: true };
`;

  it('converts sandbox TOOL header to signature-first format', () => {
    const result = convertStandaloneToolDSL(sandboxDSL);
    expect(result).toMatch(/^product_search\(queries: object\[\]\) -> object$/m);
    expect(result).toContain('type: sandbox');
    expect(result).toContain('runtime: javascript');
    expect(result).toContain('timeout: 15000');
    expect(result).toContain('memory_mb: 128');
    expect(result).toContain('description: "Search for products"');
    expect(result).toContain('code: |');
    expect(result).toContain('const url = env.SEARCH_URL');
  });

  it('handles multiple parameters', () => {
    const dsl = `TOOL: multi_param
DESCRIPTION: "Multi param tool"
TYPE: sandbox
RUNTIME: javascript

PARAMETERS:
  query:
    type: string
    required: true
  limit:
    type: number
    required: false

CODE: |
  return { ok: true };
`;
    const result = convertStandaloneToolDSL(dsl);
    expect(result).toMatch(/^multi_param\(query: string, limit\?: number\) -> object$/m);
  });

  it('throws on missing TOOL header', () => {
    expect(() => convertStandaloneToolDSL('AGENT: foo\nGOAL: bar')).toThrow('Missing TOOL: header');
  });

  // ─── HTTP Tools ───────────────────────────────────────────────────────

  it('converts HTTP tool with endpoint, method, headers, body', () => {
    const httpDSL = `TOOL: policy_search
DESCRIPTION: "Search policy KB"
TYPE: http
METHOD: POST
ENDPOINT: "https://example.com/api/search"
AUTH: custom
TIMEOUT: 10000

HEADERS:
  Auth: "{{env.TOKEN}}"

PARAMETERS:
  query:
    type: string
    required: true

BODY: |
  {"query": "{{input.query}}", "answerSearch": false}
`;
    const result = convertStandaloneToolDSL(httpDSL);
    expect(result).toMatch(/^policy_search\(query: string\) -> object$/m);
    expect(result).toContain('type: http');
    expect(result).toContain('endpoint: https://example.com/api/search');
    expect(result).toContain('method: POST');
    expect(result).toContain('auth: custom');
    expect(result).toContain('timeout: 10000');
    expect(result).toContain('headers:');
    expect(result).toContain('Auth: {{env.TOKEN}}');
    expect(result).toContain('body: |');
    expect(result).toContain('"query": "{{input.query}}"');
  });

  it('converts HTTP tool with query_params', () => {
    const httpDSL = `TOOL: product_search
DESCRIPTION: "Search products"
TYPE: http
METHOD: POST
ENDPOINT: "https://example.com/api/search"

QUERY_PARAMS:
  compress: "true"

PARAMETERS:
  queries:
    type: object[]
    required: true

BODY: |
  {{input.queries}}
`;
    const result = convertStandaloneToolDSL(httpDSL);
    expect(result).toContain('query_params:');
    expect(result).toContain('compress: true');
    expect(result).toContain('body: |');
    expect(result).toContain('{{input.queries}}');
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('produces empty param list when no PARAMETERS block', () => {
      const dsl = `TOOL: simple_tool
DESCRIPTION: "A tool with no params"
TYPE: http
METHOD: GET
ENDPOINT: "https://example.com/api"
`;
      const result = convertStandaloneToolDSL(dsl);
      expect(result).toMatch(/^simple_tool\(\) -> object$/m);
      expect(result).toContain('type: http');
      expect(result).toContain('method: GET');
      expect(result).toContain('endpoint: https://example.com/api');
    });

    it('handles missing TYPE header (no type line in output)', () => {
      const dsl = `TOOL: default_type
DESCRIPTION: "No type specified"
RUNTIME: javascript

PARAMETERS:
  input:
    type: string
    required: true

CODE: |
  return { ok: true };
`;
      const result = convertStandaloneToolDSL(dsl);
      expect(result).toMatch(/^default_type\(input: string\) -> object$/m);
      // No TYPE header means no type line emitted
      expect(result).not.toMatch(/^\s+type:/m);
      expect(result).toContain('runtime: javascript');
    });

    it('handles HTTP tool missing ENDPOINT', () => {
      const dsl = `TOOL: no_endpoint
DESCRIPTION: "HTTP with no endpoint"
TYPE: http
METHOD: POST

PARAMETERS:
  query:
    type: string
    required: true
`;
      const result = convertStandaloneToolDSL(dsl);
      expect(result).toMatch(/^no_endpoint\(query: string\) -> object$/m);
      expect(result).toContain('type: http');
      expect(result).toContain('method: POST');
      expect(result).not.toContain('endpoint:');
    });

    it('extracts pipe block that ends with a non-empty line at lower indentation', () => {
      const dsl = `TOOL: block_end_tool
DESCRIPTION: "Block ending tool"
TYPE: sandbox
RUNTIME: javascript

PARAMETERS:
  input:
    type: string
    required: true

CODE: |
  const x = 1;
  return x;
TIMEOUT: 5000
`;
      const result = convertStandaloneToolDSL(dsl);
      expect(result).toContain('code: |');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('return x;');
    });

    it('defaults bare parameter to type string and required false', () => {
      const dsl = `TOOL: bare_param
DESCRIPTION: "Bare param"
TYPE: sandbox
RUNTIME: javascript

PARAMETERS:
  query:

CODE: |
  return {};
`;
      const result = convertStandaloneToolDSL(dsl);
      // query should be optional (default required: false) with type string
      expect(result).toMatch(/^bare_param\(query\?: string\) -> object$/m);
    });
  });
});

describe('loadToolDSLsAsResolved', () => {
  // ─── Sandbox Tool ─────────────────────────────────────────────────────

  const sandboxToolDSL = `TOOL: code_tool
DESCRIPTION: "Run code"
TYPE: sandbox
RUNTIME: javascript
TIMEOUT: 15000

PARAMETERS:
  input:
    type: string
    required: true

CODE: |
  return { success: true };
`;

  it('resolves sandbox tool with sandbox_binding', () => {
    const result = loadToolDSLsAsResolved([sandboxToolDSL]);
    expect(result.has('code_tool')).toBe(true);
    const tools = result.get('code_tool')!;
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_type).toBe('sandbox');
    expect(tools[0].sandbox_binding).toBeDefined();
    expect(tools[0].sandbox_binding!.code_content).toContain('return { success: true }');
    expect(tools[0].sandbox_binding!.runtime).toBe('javascript');
  });

  // ─── HTTP Tool ────────────────────────────────────────────────────────

  const httpToolDSL = `TOOL: product_search
DESCRIPTION: "Search products"
TYPE: http
METHOD: POST
ENDPOINT: "https://example.com/api/search"
TIMEOUT: 15000

PARAMETERS:
  queries:
    type: object[]
    required: true

BODY: |
  {{input.queries}}
`;

  it('resolves HTTP tool with http_binding', () => {
    const result = loadToolDSLsAsResolved([httpToolDSL]);
    expect(result.has('product_search')).toBe(true);
    const tools = result.get('product_search')!;
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_type).toBe('http');
    expect(tools[0].http_binding).toBeDefined();
    expect(tools[0].http_binding!.endpoint).toBe('https://example.com/api/search');
    expect(tools[0].http_binding!.method).toBe('POST');
    expect(tools[0].http_binding!.body_template).toContain('{{input.queries}}');
    expect(tools[0].sandbox_binding).toBeUndefined();
  });

  it('resolves HTTP tool with custom auth and headers', () => {
    const dsl = `TOOL: policy_search
DESCRIPTION: "Search policies"
TYPE: http
METHOD: POST
ENDPOINT: "https://example.com/api/search"
AUTH: custom

HEADERS:
  Auth: "{{env.TOKEN}}"

PARAMETERS:
  query:
    type: string
    required: true

BODY: |
  {"query": "{{input.query}}"}
`;
    const result = loadToolDSLsAsResolved([dsl]);
    const tools = result.get('policy_search')!;
    expect(tools[0].http_binding!.auth.type).toBe('custom');
    expect(tools[0].http_binding!.body_template).toContain('{{input.query}}');
  });

  // ─── Multiple Tools ───────────────────────────────────────────────────

  it('handles multiple tool DSLs of mixed types', () => {
    const result = loadToolDSLsAsResolved([sandboxToolDSL, httpToolDSL]);
    expect(result.has('code_tool')).toBe(true);
    expect(result.has('product_search')).toBe(true);
    expect(result.get('code_tool')![0].tool_type).toBe('sandbox');
    expect(result.get('product_search')![0].tool_type).toBe('http');
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────

  it('defaults to sandbox tool_type when TYPE header is missing', () => {
    const dsl = `TOOL: default_type
DESCRIPTION: "No type specified"
RUNTIME: javascript

PARAMETERS:
  input:
    type: string
    required: true

CODE: |
  return { ok: true };
`;
    const result = loadToolDSLsAsResolved([dsl]);
    const tools = result.get('default_type')!;
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_type).toBe('sandbox');
    expect(tools[0].sandbox_binding).toBeDefined();
    expect(tools[0].http_binding).toBeUndefined();
  });

  it('resolves HTTP tool with undefined endpoint when ENDPOINT is missing', () => {
    const dsl = `TOOL: no_endpoint
DESCRIPTION: "HTTP with no endpoint"
TYPE: http
METHOD: POST

PARAMETERS:
  query:
    type: string
    required: true
`;
    const result = loadToolDSLsAsResolved([dsl]);
    const tools = result.get('no_endpoint')!;
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_type).toBe('http');
    expect(tools[0].http_binding).toBeDefined();
    expect(tools[0].http_binding!.endpoint).toBeFalsy();
    expect(tools[0].sandbox_binding).toBeUndefined();
  });

  it('resolves tool with no PARAMETERS as empty parameter list', () => {
    const dsl = `TOOL: simple_tool
DESCRIPTION: "A tool with no params"
TYPE: http
METHOD: GET
ENDPOINT: "https://example.com/api"
`;
    const result = loadToolDSLsAsResolved([dsl]);
    const tools = result.get('simple_tool')!;
    expect(tools).toHaveLength(1);
    expect(tools[0].parameters).toEqual([]);
  });
});
