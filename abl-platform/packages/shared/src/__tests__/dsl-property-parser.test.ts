import { describe, it, expect } from 'vitest';
import {
  parseSignatureLine,
  parseDslProperties,
  extractPipeBlock,
  parseReturnTypeString,
  parseDslParamMetadata,
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildMcpBindingFromProps,
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
} from '../tools/dsl-property-parser.js';

// =============================================================================
// parseSignatureLine()
// =============================================================================

describe('parseSignatureLine', () => {
  it('parses simple signature with one required param', () => {
    const result = parseSignatureLine('charge_card(amount: number) -> object');
    expect(result.parameters).toEqual([{ name: 'amount', type: 'number', required: true }]);
    expect(result.returnType).toBe('object');
  });

  it('parses complex return type with braces', () => {
    const result = parseSignatureLine('calc(data: object) -> {score: number, factors: string[]}');
    expect(result.returnType).toBe('{score: number, factors: string[]}');
  });

  it('parses optional parameters', () => {
    const result = parseSignatureLine('search(query: string, limit?: number) -> object');
    expect(result.parameters).toEqual([
      { name: 'query', type: 'string', required: true },
      { name: 'limit', type: 'number', required: false },
    ]);
  });

  it('parses no parameters', () => {
    const result = parseSignatureLine('ping() -> string');
    expect(result.parameters).toEqual([]);
    expect(result.returnType).toBe('string');
  });

  it('parses multiple required parameters', () => {
    const result = parseSignatureLine(
      'create_user(name: string, email: string, age: number) -> {id: string}',
    );
    expect(result.parameters).toHaveLength(3);
    expect(result.parameters[0]).toEqual({ name: 'name', type: 'string', required: true });
    expect(result.parameters[1]).toEqual({ name: 'email', type: 'string', required: true });
    expect(result.parameters[2]).toEqual({ name: 'age', type: 'number', required: true });
  });

  it('defaults return type to object when missing', () => {
    const result = parseSignatureLine('my_tool(x: string)');
    expect(result.returnType).toBe('object');
  });

  it('handles DSL content with multiple lines', () => {
    const dsl = `fetch_data(url: string) -> object
  type: http
  endpoint: https://api.example.com`;
    const result = parseSignatureLine(dsl);
    expect(result.parameters).toEqual([{ name: 'url', type: 'string', required: true }]);
    expect(result.returnType).toBe('object');
  });

  it('handles empty string', () => {
    const result = parseSignatureLine('');
    expect(result.parameters).toEqual([]);
    expect(result.returnType).toBe('object');
  });
});

// =============================================================================
// parseDslProperties()
// =============================================================================

describe('parseDslProperties', () => {
  it('parses key-value properties from DSL content', () => {
    const dsl = `my_tool(x: string) -> object
  type: http
  endpoint: https://api.example.com
  method: POST
  auth: bearer`;
    const props = parseDslProperties(dsl);
    expect(props.type).toBe('http');
    expect(props.endpoint).toBe('https://api.example.com');
    expect(props.method).toBe('POST');
    expect(props.auth).toBe('bearer');
  });

  it('strips quotes from values', () => {
    const dsl = `my_tool() -> object
  endpoint: "https://api.example.com"
  description: 'A test tool'`;
    const props = parseDslProperties(dsl);
    expect(props.endpoint).toBe('https://api.example.com');
    expect(props.description).toBe('A test tool');
  });

  it('skips comment lines', () => {
    const dsl = `my_tool() -> object
  type: http
  # This is a comment
  endpoint: https://api.example.com`;
    const props = parseDslProperties(dsl);
    expect(props.type).toBe('http');
    expect(props.endpoint).toBe('https://api.example.com');
  });

  it('skips empty lines', () => {
    const dsl = `my_tool() -> object
  type: http

  endpoint: https://api.example.com`;
    const props = parseDslProperties(dsl);
    expect(props.type).toBe('http');
    expect(props.endpoint).toBe('https://api.example.com');
  });
});

// =============================================================================
// extractPipeBlock()
// =============================================================================

describe('extractPipeBlock', () => {
  it('extracts a code block', () => {
    const dsl = `calc(x: number) -> number
  type: sandbox
  runtime: javascript
  code: |
    function main(x) {
      return x * 2;
    }
    return main($x);`;
    const code = extractPipeBlock(dsl, 'code');
    expect(code).toContain('function main(x)');
    expect(code).toContain('return x * 2;');
    expect(code).toContain('return main($x);');
  });

  it('returns null when block not found', () => {
    const dsl = `my_tool() -> object
  type: http
  endpoint: https://api.example.com`;
    const result = extractPipeBlock(dsl, 'code');
    expect(result).toBeNull();
  });
});

// =============================================================================
// parseReturnTypeString()
// =============================================================================

describe('parseReturnTypeString', () => {
  it('parses a simple type', () => {
    expect(parseReturnTypeString('string')).toEqual({ type: 'string' });
  });

  it('parses a simple number type', () => {
    expect(parseReturnTypeString('number')).toEqual({ type: 'number' });
  });

  it('parses an array type', () => {
    expect(parseReturnTypeString('string[]')).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('parses an object type with fields', () => {
    expect(parseReturnTypeString('{name: string, email: string}')).toEqual({
      type: 'object',
      fields: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
    });
  });

  it('parses optional fields in object type', () => {
    expect(parseReturnTypeString('{name: string, age?: number}')).toEqual({
      type: 'object',
      fields: {
        name: { type: 'string' },
        age: { type: 'number', optional: true },
      },
    });
  });

  it('handles whitespace', () => {
    expect(parseReturnTypeString('  object  ')).toEqual({ type: 'object' });
  });

  it('falls back to raw type for unrecognized patterns', () => {
    expect(parseReturnTypeString('Map<string, number>')).toEqual({ type: 'Map<string, number>' });
  });
});

// =============================================================================
// buildHttpBindingFromProps()
// =============================================================================

describe('buildHttpBindingFromProps', () => {
  it('builds a basic HTTP binding', () => {
    const props = {
      endpoint: 'https://api.example.com/data',
      method: 'GET',
      auth: 'none',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.endpoint).toBe('https://api.example.com/data');
    expect(binding.method).toBe('GET');
    expect(binding.auth.type).toBe('none');
  });

  it('builds binding with bearer auth', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'bearer',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.auth.type).toBe('bearer');
    expect(binding.auth.config?.headerName).toBe('Authorization');
    expect(binding.auth.config?.headerPrefix).toBe('Bearer');
  });

  it('builds binding with api_key auth', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'api_key',
      header_name: 'X-Custom-Key',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.auth.type).toBe('api_key');
    expect(binding.auth.config?.headerName).toBe('X-Custom-Key');
  });

  it('builds binding with oauth2_client auth', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'oauth2_client',
      token_url: 'https://auth.example.com/token',
      client_id: 'my-client',
      scopes: 'read,write',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.auth.type).toBe('oauth2_client');
    const oauth = binding.auth.config?.oauth as {
      tokenUrl: string;
      clientId: string;
      scopes: string[];
    };
    expect(oauth.tokenUrl).toBe('https://auth.example.com/token');
    expect(oauth.clientId).toBe('my-client');
    expect(oauth.scopes).toEqual(['read', 'write']);
  });

  it('builds binding with oauth2_user auth', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'oauth2_user',
      provider: 'github',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.auth.type).toBe('oauth2_user');
    expect(binding.auth.config?.provider).toBe('github');
  });

  it('parses timeout and retry', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      timeout: '5000',
      retry: '3',
      retry_delay: '2000',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.timeout_ms).toBe(5000);
    expect(binding.retry).toEqual({ count: 3, delay_ms: 2000 });
  });

  it('parses rate limit', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      rate_limit: '60',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.rate_limit_per_minute).toBe(60);
  });

  it('preserves non-json body_type for HTTP binding IR', () => {
    const props = {
      endpoint: 'https://api.example.com/token',
      method: 'POST',
      auth: 'none',
      body_type: 'form',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.body_type).toBe('form');
  });

  it('defaults method to GET and auth to none', () => {
    const binding = buildHttpBindingFromProps({});
    expect(binding.method).toBe('GET');
    expect(binding.auth.type).toBe('none');
    expect(binding.endpoint).toBe('');
  });

  it('extracts headers from nested block', () => {
    const dsl = `fetch_data(url: string) -> object
  type: http
  endpoint: "https://api.example.com/data"
  method: POST
  auth: none
  headers:
    Content-Type: "application/json"
    X-Api-Key: "{{secrets.KEY}}"`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Api-Key': '{{secrets.KEY}}',
    });
  });

  it('extracts circuit_breaker from nested block', () => {
    const dsl = `fetch_data(url: string) -> object
  type: http
  endpoint: "https://api.example.com/data"
  method: GET
  auth: none
  circuit_breaker:
    threshold: 10
    reset_ms: 60000`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.circuit_breaker).toEqual({
      threshold: 10,
      reset_ms: 60000,
    });
  });

  it('backward compat — no dslContent leaves headers and circuit_breaker undefined', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.headers).toBeUndefined();
    expect(binding.circuit_breaker).toBeUndefined();
  });

  it('extracts query_params from nested block', () => {
    const dsl = `fetch_data(url: string) -> object
  type: http
  endpoint: "https://api.example.com/data"
  method: GET
  auth: api_key
  query_params:
    api_key: "{{secrets.API_KEY}}"
    format: json`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.query_params).toEqual({
      api_key: '{{secrets.API_KEY}}',
      format: 'json',
    });
  });

  it('extracts query_params with input placeholders', () => {
    const dsl = `search_api(q: string, limit?: number) -> object
  type: http
  endpoint: "https://api.example.com/search"
  method: GET
  auth: none
  query_params:
    q: "{{input.q}}"
    limit: "10"`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.query_params).toEqual({
      q: '{{input.q}}',
      limit: '10',
    });
  });

  it('extracts body from pipe block', () => {
    const dsl = `create_user(name: string, email: string) -> object
  type: http
  endpoint: "https://api.example.com/users"
  method: POST
  auth: bearer
  body: |
    {
      "name": "{{input.name}}",
      "email": "{{input.email}}",
      "api_key": "{{secrets.API_KEY}}"
    }`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.body_template).toContain('{{input.name}}');
    expect(binding.body_template).toContain('{{input.email}}');
    expect(binding.body_template).toContain('{{secrets.API_KEY}}');
  });

  it('no dslContent leaves query_params and body_template undefined', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'none',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.query_params).toBeUndefined();
    expect(binding.body_template).toBeUndefined();
  });
});

// =============================================================================
// buildSandboxBindingFromProps()
// =============================================================================

describe('buildSandboxBindingFromProps', () => {
  it('builds sandbox binding with code block', () => {
    const dsl = `calc(x: number) -> number
  type: sandbox
  runtime: python
  timeout: 10000
  memory_mb: 256
  code: |
    def main(x):
        return x * 2
    main($x)`;
    const props = parseDslProperties(dsl);
    const binding = buildSandboxBindingFromProps(props, dsl);
    expect(binding.runtime).toBe('python');
    expect(binding.timeout_ms).toBe(10000);
    expect(binding.memory_mb).toBe(256);
    expect(binding.code_content).toContain('def main(x)');
  });

  it('defaults runtime to javascript', () => {
    const binding = buildSandboxBindingFromProps({}, 'tool() -> object');
    expect(binding.runtime).toBe('javascript');
    expect(binding.code_content).toBe('');
  });
});

// =============================================================================
// buildMcpBindingFromProps()
// =============================================================================

describe('buildMcpBindingFromProps', () => {
  it('builds MCP binding with server and tool', () => {
    const props = {
      server: 'my-server',
      server_tool: 'remote_tool',
    };
    const binding = buildMcpBindingFromProps(props, 'my_tool');
    expect(binding.server).toBe('my-server');
    expect(binding.tool).toBe('remote_tool');
  });

  it('defaults tool to the tool name', () => {
    const props = { server: 'my-server' };
    const binding = buildMcpBindingFromProps(props, 'my_tool');
    expect(binding.tool).toBe('my_tool');
  });

  it('bakes server config from config map', () => {
    const props = { server: 'my-server' };
    const configMap = new Map([
      [
        'my-server',
        {
          name: 'my-server',
          transport: 'sse' as const,
          url: 'https://mcp.example.com/sse',
          encryptedEnv: null,
          connectionTimeoutMs: 5000,
          requestTimeoutMs: 30000,
          encryptedAuthConfig: null,
          authType: 'none' as const,
        } as any,
      ],
    ]);
    const binding = buildMcpBindingFromProps(props, 'my_tool', { mcpConfigMap: configMap });
    expect(binding.server_config).toBeDefined();
    expect(binding.server_config?.name).toBe('my-server');
    expect(binding.server_config?.transport).toBe('sse');
    expect(binding.server_config?.url).toBe('https://mcp.example.com/sse');
  });

  it('omits server_config when not in config map', () => {
    const props = { server: 'unknown-server' };
    const configMap = new Map();
    const binding = buildMcpBindingFromProps(props, 'my_tool', { mcpConfigMap: configMap });
    expect(binding.server_config).toBeUndefined();
  });

  it('parses headers from DSL nested block', () => {
    const dsl = `query_data(q: string) -> object
  type: mcp
  server: my-server
  server_tool: search
  headers:
    Authorization: "Bearer {{secrets.MCP_TOKEN}}"
    X-Custom: my-value`;
    const props = parseDslProperties(dsl);
    const binding = buildMcpBindingFromProps(props, 'query_data', { dslContent: dsl });
    expect(binding.headers).toEqual({
      Authorization: 'Bearer {{secrets.MCP_TOKEN}}',
      'X-Custom': 'my-value',
    });
  });

  it('omits headers when DSL has no headers block', () => {
    const dsl = `query_data(q: string) -> object
  type: mcp
  server: my-server`;
    const props = parseDslProperties(dsl);
    const binding = buildMcpBindingFromProps(props, 'query_data', { dslContent: dsl });
    expect(binding.headers).toBeUndefined();
  });
});

// =============================================================================
// HTTP auth_config → IR pipeline
// =============================================================================

describe('buildHttpBindingFromProps — auth_config fields', () => {
  it('parses bearer token from auth_config block', () => {
    const dsl = `get_data() -> object
  type: http
  endpoint: "https://api.example.com"
  method: GET
  auth: bearer
  auth_config:
    token: "{{secrets.MY_BEARER_TOKEN}}"`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.auth.type).toBe('bearer');
    expect(binding.auth.config?.token).toBe('{{secrets.MY_BEARER_TOKEN}}');
  });

  it('parses api_key from auth_config block', () => {
    const dsl = `get_data() -> object
  type: http
  endpoint: "https://api.example.com"
  method: GET
  auth: api_key
  auth_config:
    api_key: "{{secrets.MY_API_KEY}}"
    header_name: X-API-Key`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.auth.type).toBe('api_key');
    expect(binding.auth.config?.apiKey).toBe('{{secrets.MY_API_KEY}}');
    expect(binding.auth.config?.headerName).toBe('X-API-Key');
  });

  it('ignores stale bearer fields when building api_key auth config', () => {
    const dsl = `get_data() -> object
  type: http
  endpoint: "https://api.example.com"
  method: GET
  auth: api_key
  auth_config:
    api_key: "{{secrets.MY_API_KEY}}"
    header_name: X-API-Key
    token: "{{secrets.STALE_BEARER_TOKEN}}"`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);

    expect(binding.auth.type).toBe('api_key');
    expect(binding.auth.config?.apiKey).toBe('{{secrets.MY_API_KEY}}');
    expect(binding.auth.config?.headerName).toBe('X-API-Key');
    expect(binding.auth.config?.token).toBeUndefined();
  });

  it('parses oauth2_client config from auth_config block', () => {
    const dsl = `get_data() -> object
  type: http
  endpoint: "https://api.example.com"
  method: GET
  auth: oauth2_client
  auth_config:
    token_url: "https://auth.example.com/token"
    client_id: my-client
    client_secret: "{{secrets.CLIENT_SECRET}}"
    scopes: "read,write"`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.auth.type).toBe('oauth2_client');
    expect(binding.auth.config?.clientSecret).toBe('{{secrets.CLIENT_SECRET}}');
    expect(binding.auth.config?.oauth).toEqual({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'my-client',
      scopes: ['read', 'write'],
    });
  });

  it('parses oauth2_user provider from auth_config block', () => {
    const dsl = `get_data() -> object
  type: http
  endpoint: "https://api.example.com"
  method: GET
  auth: oauth2_user
  auth_config:
    provider: google`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.auth.type).toBe('oauth2_user');
    expect(binding.auth.config?.provider).toBe('google');
  });

  it('parses custom headers from auth_config block', () => {
    const dsl = `get_data() -> object
  type: http
  endpoint: "https://api.example.com"
  method: GET
  auth: custom
  auth_config:
    custom_headers:
      X-Token: "{{secrets.CUSTOM_TOKEN}}"
      X-Org-Id: my-org`;
    const props = parseDslProperties(dsl);
    const binding = buildHttpBindingFromProps(props, dsl);
    expect(binding.auth.type).toBe('custom');
    expect(binding.auth.config?.customHeaders).toEqual({
      'X-Token': '{{secrets.CUSTOM_TOKEN}}',
      'X-Org-Id': 'my-org',
    });
  });

  it('falls back to flat props for oauth2_client without auth_config block', () => {
    const props = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'oauth2_client',
      token_url: 'https://auth.example.com/token',
      client_id: 'my-client',
      scopes: 'read write',
    };
    const binding = buildHttpBindingFromProps(props);
    expect(binding.auth.config?.oauth).toEqual({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'my-client',
      scopes: ['read', 'write'],
    });
  });
});

// =============================================================================
// parseDslParamMetadata()
// =============================================================================

describe('parseDslParamMetadata', () => {
  it('parses schema metadata key for a parameter', () => {
    const dsl = `my_tool(data: object) -> object
  type: http
  params:
    data:
      description: "Input data"
      schema: {"name": {"type": "string"}}`;
    const meta = parseDslParamMetadata(dsl);
    expect(meta.has('data')).toBe(true);
    expect(meta.get('data')?.schema).toBe('{"name": {"type": "string"}}');
    expect(meta.get('data')?.description).toBe('Input data');
  });

  it('parses enum metadata key for a parameter', () => {
    const dsl = `my_tool(unit: string) -> object
  type: http
  params:
    unit:
      description: "Unit of measurement"
      enum: metric, imperial
      default: metric`;
    const meta = parseDslParamMetadata(dsl);
    expect(meta.get('unit')?.enum).toEqual(['metric', 'imperial']);
    expect(meta.get('unit')?.default).toBe('metric');
  });
});

// =============================================================================
// buildSearchAIBindingFromProps()
// =============================================================================

describe('buildSearchAIBindingFromProps', () => {
  it('builds a SearchAI binding with all fields', () => {
    const binding = buildSearchAIBindingFromProps({
      tenant_id: 'tenant_123',
      index_id: 'idx_products',
      kb_name: 'Product Docs',
    });
    expect(binding.tenantId).toBe('tenant_123');
    expect(binding.indexId).toBe('idx_products');
    expect(binding.kbName).toBe('Product Docs');
  });

  it('returns undefined kbName when kb_name is empty', () => {
    const binding = buildSearchAIBindingFromProps({
      tenant_id: 'tenant_123',
      index_id: 'idx_products',
      kb_name: '',
    });
    expect(binding.kbName).toBeUndefined();
  });

  it('returns undefined kbName when kb_name is missing', () => {
    const binding = buildSearchAIBindingFromProps({
      tenant_id: 'tenant_123',
      index_id: 'idx_products',
    });
    expect(binding.kbName).toBeUndefined();
  });

  it('defaults tenantId and indexId to empty string when missing', () => {
    const binding = buildSearchAIBindingFromProps({});
    expect(binding.tenantId).toBe('');
    expect(binding.indexId).toBe('');
  });
});

// =============================================================================
// buildWorkflowBindingFromProps()
// =============================================================================

describe('buildWorkflowBindingFromProps', () => {
  it('roundtrip: parses a valid workflow DSL into WorkflowBindingLocal', () => {
    const dsl = `run_approval(payload: object) -> object
  type: workflow
  workflow_id: "wf_abc123"
  workflow_version_id: "wfv_abc123"
  trigger_id: "tr_xyz789"
  mode: sync
  timeout_ms: 30000
  param_mapping: {"order_id": "$.payload.orderId"}`;
    const props = parseDslProperties(dsl);
    const binding = buildWorkflowBindingFromProps(props);
    expect(binding.workflowId).toBe('wf_abc123');
    expect(binding.workflowVersionId).toBe('wfv_abc123');
    expect(binding.triggerId).toBe('tr_xyz789');
    expect(binding.mode).toBe('sync');
    expect(binding.timeoutMs).toBe(30000);
    expect(binding.paramMapping).toEqual({ order_id: '$.payload.orderId' });
  });

  it('applies defaults: mode defaults to sync, optional fields omitted', () => {
    const props = {
      workflow_id: 'wf_minimal',
      trigger_id: 'tr_minimal',
    };
    const binding = buildWorkflowBindingFromProps(props);
    expect(binding.workflowId).toBe('wf_minimal');
    expect(binding.triggerId).toBe('tr_minimal');
    expect(binding.mode).toBe('sync');
    expect(binding.timeoutMs).toBeUndefined();
    expect(binding.paramMapping).toBeUndefined();
  });

  it('throws structured error on invalid JSON in param_mapping', () => {
    const props = {
      workflow_id: 'wf_test',
      trigger_id: 'tr_test',
      param_mapping: '{not valid json',
    };
    expect(() => buildWorkflowBindingFromProps(props)).toThrow(
      /Invalid param_mapping JSON in workflow binding/,
    );
  });

  it('throws when workflow_id is missing', () => {
    const props = { trigger_id: 'tr_test' };
    expect(() => buildWorkflowBindingFromProps(props)).toThrow(
      'Workflow binding requires workflow_id property',
    );
  });

  it('throws when trigger_id is missing', () => {
    const props = { workflow_id: 'wf_test' };
    expect(() => buildWorkflowBindingFromProps(props)).toThrow(
      'Workflow binding requires trigger_id property',
    );
  });

  it('supports async mode', () => {
    const props = {
      workflow_id: 'wf_async',
      trigger_id: 'tr_async',
      mode: 'async',
    };
    const binding = buildWorkflowBindingFromProps(props);
    expect(binding.mode).toBe('async');
  });
});
