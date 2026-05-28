import { describe, it, expect } from 'vitest';
import {
  parseDslToToolForm,
  parseDslNestedBlock,
  parseDslDeepNestedBlock,
} from '../tools/parse-dsl-to-tool-form.js';
import { serializeToolFormToDsl } from '../tools/serialize-tool-form-to-dsl.js';
import type {
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  SearchAIToolFormData,
  WorkflowToolFormData,
} from '../types/project-tool-form.js';

// =============================================================================
// parseDslNestedBlock()
// =============================================================================

describe('parseDslNestedBlock', () => {
  it('extracts key-value entries from a nested block', () => {
    const dsl = `my_tool() -> object
  type: http
  auth_config:
    token_url: https://auth.example.com/token
    client_id: my-client`;

    const entries = parseDslNestedBlock(dsl, 'auth_config');
    expect(entries).toEqual([
      { key: 'token_url', value: 'https://auth.example.com/token' },
      { key: 'client_id', value: 'my-client' },
    ]);
  });

  it('handles mixed-case keys (e.g., Content-Type)', () => {
    const dsl = `my_tool() -> object
  type: http
  headers:
    Content-Type: application/json
    X-Custom-Header: some-value`;

    const entries = parseDslNestedBlock(dsl, 'headers');
    expect(entries).toEqual([
      { key: 'Content-Type', value: 'application/json' },
      { key: 'X-Custom-Header', value: 'some-value' },
    ]);
  });

  it('returns empty array for missing block', () => {
    const dsl = `my_tool() -> object
  type: http`;

    expect(parseDslNestedBlock(dsl, 'headers')).toEqual([]);
  });

  it('strips surrounding quotes from values', () => {
    const dsl = `my_tool() -> object
  type: http
  headers:
    Accept: "application/json"`;

    const entries = parseDslNestedBlock(dsl, 'headers');
    expect(entries).toEqual([{ key: 'Accept', value: 'application/json' }]);
  });
});

// =============================================================================
// parseDslToToolForm() — HTTP
// =============================================================================

describe('parseDslToToolForm — HTTP', () => {
  it('roundtrips a minimal HTTP tool (endpoint + method only)', () => {
    const form: HttpToolFormData = {
      name: 'simple_api',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http');

    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('simple_api');
    expect(parsed!.toolType).toBe('http');
    const http = parsed as HttpToolFormData;
    expect(http.endpoint).toBe('https://api.example.com/data');
    expect(http.method).toBe('GET');
    expect(http.auth).toBe('none');
  });

  it('roundtrips HTTP with description and parameters', () => {
    const form: HttpToolFormData = {
      name: 'weather_api',
      toolType: 'http',
      description: 'Fetches weather data',
      parameters: [
        { name: 'city', type: 'string', required: true },
        { name: 'units', type: 'string', required: false },
      ],
      returnType: 'object',
      endpoint: 'https://api.weather.com/v1',
      method: 'GET',
      auth: 'api_key',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.description).toBe('Fetches weather data');
    expect(parsed.parameters).toEqual([
      { name: 'city', type: 'string', required: true, description: '' },
      { name: 'units', type: 'string', required: false, description: '' },
    ]);
    expect(parsed.auth).toBe('api_key');
  });

  it('roundtrips HTTP auth profile fields and top-level scopes', () => {
    const form: HttpToolFormData = {
      name: 'crm_api',
      toolType: 'http',
      description: 'CRM integration',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/crm',
      method: 'GET',
      auth: 'none',
      authProfileRef: 'crm_shared_auth',
      authJit: true,
      consentMode: 'inline',
      connectionMode: 'shared',
      authConfig: {
        scopes: 'contacts:read deals:read',
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed.auth).toBe('none');
    expect(parsed.authProfileRef).toBe('crm_shared_auth');
    expect(parsed.authJit).toBe(true);
    expect(parsed.consentMode).toBe('inline');
    expect(parsed.connectionMode).toBe('shared');
    expect(parsed.authConfig?.scopes).toBe('contacts:read deals:read');
  });

  it('roundtrips HTTP with full oauth2_client auth_config', () => {
    const form: HttpToolFormData = {
      name: 'payment_api',
      toolType: 'http',
      description: 'Process payments',
      parameters: [{ name: 'amount', type: 'number', required: true }],
      returnType: '{txnId: string}',
      endpoint: 'https://payments.example.com/charge',
      method: 'POST',
      auth: 'oauth2_client',
      authConfig: {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        scopes: 'payments:write',
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.auth).toBe('oauth2_client');
    expect(parsed.authConfig).toBeDefined();
    expect(parsed.authConfig!.tokenUrl).toBe('https://auth.example.com/token');
    expect(parsed.authConfig!.clientId).toBe('client-123');
    expect(parsed.authConfig!.clientSecret).toBe('secret-456');
    expect(parsed.authConfig!.scopes).toBe('payments:write');
  });

  it('roundtrips HTTP with documented oauth2_user auth_config fields', () => {
    const form: HttpToolFormData = {
      name: 'user_oauth_api',
      toolType: 'http',
      description: 'User OAuth API',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/user',
      method: 'GET',
      auth: 'oauth2_user',
      authConfig: {
        provider: 'google',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'client-123',
        clientSecret: '{{secrets.CLIENT_SECRET}}',
        scopes: 'profile email',
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.auth).toBe('oauth2_user');
    expect(parsed.authConfig).toEqual({
      provider: 'google',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'client-123',
      clientSecret: '{{secrets.CLIENT_SECRET}}',
      scopes: 'profile email',
    });
  });

  it('roundtrips HTTP with bearer auth token', () => {
    const form: HttpToolFormData = {
      name: 'bearer_api',
      toolType: 'http',
      description: 'API with bearer token',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
      auth: 'bearer',
      authConfig: {
        token: '{{secrets.API_TOKEN}}',
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.auth).toBe('bearer');
    expect(parsed.authConfig).toBeDefined();
    expect(parsed.authConfig!.token).toBe('{{secrets.API_TOKEN}}');
  });

  it('roundtrips HTTP with api_key auth', () => {
    const form: HttpToolFormData = {
      name: 'apikey_api',
      toolType: 'http',
      description: 'API with api key',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
      auth: 'api_key',
      authConfig: {
        apiKey: '{{secrets.MY_API_KEY}}',
        headerName: 'X-API-Key',
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.auth).toBe('api_key');
    expect(parsed.authConfig).toBeDefined();
    expect(parsed.authConfig!.apiKey).toBe('{{secrets.MY_API_KEY}}');
    expect(parsed.authConfig!.headerName).toBe('X-API-Key');
  });

  it('roundtrips HTTP with headers (mixed-case keys)', () => {
    const form: HttpToolFormData = {
      name: 'api_with_headers',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'none',
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'X-Request-ID', value: '{{context.requestId}}' },
      ],
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.headers).toHaveLength(2);
    expect(parsed.headers![0]).toEqual({ key: 'Content-Type', value: 'application/json' });
    expect(parsed.headers![1]).toEqual({ key: 'X-Request-ID', value: '{{context.requestId}}' });
  });

  it('roundtrips HTTP with query_params', () => {
    const form: HttpToolFormData = {
      name: 'search_api',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/search',
      method: 'GET',
      auth: 'none',
      queryParams: [
        { key: 'api_key', value: '{{secrets.API_KEY}}' },
        { key: 'format', value: 'json' },
      ],
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.queryParams).toHaveLength(2);
    expect(parsed.queryParams![0]).toEqual({ key: 'api_key', value: '{{secrets.API_KEY}}' });
    expect(parsed.queryParams![1]).toEqual({ key: 'format', value: 'json' });
  });

  it('roundtrips HTTP with circuit_breaker', () => {
    const form: HttpToolFormData = {
      name: 'resilient_api',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      circuitBreaker: { threshold: 5, resetMs: 60000 },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.circuitBreaker).toEqual({ threshold: 5, resetMs: 60000 });
  });

  it('roundtrips HTTP with timeout/retry/rate_limit', () => {
    const form: HttpToolFormData = {
      name: 'configured_api',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'none',
      timeout: 5000,
      retry: 3,
      retryDelay: 2000,
      rateLimit: 60,
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.timeout).toBe(5000);
    expect(parsed.retry).toBe(3);
    expect(parsed.retryDelay).toBe(2000);
    expect(parsed.rateLimit).toBe(60);
  });

  it('roundtrips HTTP runtime numeric fields backed by config placeholders', () => {
    const dsl = `configured_api() -> object
  description: "Configured API"
  type: http
  endpoint: "https://api.example.com"
  method: POST
  timeout: {{config.HTTP_TIMEOUT_MS}}
  retry: {{config.HTTP_RETRY_COUNT}}
  retry_delay: {{config.HTTP_RETRY_DELAY_MS}}
  rate_limit: {{config.HTTP_RATE_LIMIT}}
  circuit_breaker:
    threshold: {{config.HTTP_CB_THRESHOLD}}
    reset_ms: {{config.HTTP_CB_RESET_MS}}`;

    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed.timeout).toBe('{{config.HTTP_TIMEOUT_MS}}');
    expect(parsed.retry).toBe('{{config.HTTP_RETRY_COUNT}}');
    expect(parsed.retryDelay).toBe('{{config.HTTP_RETRY_DELAY_MS}}');
    expect(parsed.rateLimit).toBe('{{config.HTTP_RATE_LIMIT}}');
    expect(parsed.circuitBreaker).toEqual({
      threshold: '{{config.HTTP_CB_THRESHOLD}}',
      resetMs: '{{config.HTTP_CB_RESET_MS}}',
    });
    expect(serializeToolFormToDsl(parsed)).toContain('timeout: {{config.HTTP_TIMEOUT_MS}}');
  });

  it('roundtrips HTTP with body template', () => {
    const form: HttpToolFormData = {
      name: 'create_user',
      toolType: 'http',
      description: 'Create a user',
      parameters: [
        { name: 'name', type: 'string', required: true, description: 'User name' },
        { name: 'email', type: 'string', required: true, description: 'User email' },
      ],
      returnType: 'object',
      endpoint: 'https://api.example.com/users',
      method: 'POST',
      auth: 'bearer',
      body: '{\n  "name": "{{input.name}}",\n  "email": "{{input.email}}"\n}',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.body).toContain('{{input.name}}');
    expect(parsed.body).toContain('{{input.email}}');
  });

  it('roundtrips HTTP with bodySchema and useBodySchema', () => {
    const schema =
      '{\n  "type": "object",\n  "properties": {\n    "email": { "type": "string" }\n  }\n}';
    const form: HttpToolFormData = {
      name: 'schema_api',
      toolType: 'http',
      description: 'API with body schema',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/users',
      method: 'POST',
      auth: 'none',
      body: '{\n  "email": "{{input.email}}"\n}',
      bodySchema: schema,
      useBodySchema: true,
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    // bodyType 'json' is the default and not serialized, so it won't appear on reload
    expect(parsed.useBodySchema).toBe(true);
    expect(parsed.bodySchema).toContain('"type": "object"');
    expect(parsed.bodySchema).toContain('"email"');
    expect(parsed.body).toContain('{{input.email}}');
  });

  it('roundtrips HTTP with non-json bodyType', () => {
    const form: HttpToolFormData = {
      name: 'xml_api',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'none',
      body: '<request><name>{{input.name}}</name></request>',
      bodyType: 'xml',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.bodyType).toBe('xml');
    expect(parsed.body).toContain('{{input.name}}');
  });
});

// =============================================================================
// parseDslToToolForm() — Sandbox
// =============================================================================

describe('parseDslToToolForm — Sandbox', () => {
  it('roundtrips a sandbox tool with code pipe block', () => {
    const form: SandboxToolFormData = {
      name: 'calculate',
      toolType: 'sandbox',
      description: 'Calculate metrics',
      parameters: [{ name: 'data', type: 'object', required: true }],
      returnType: 'object',
      runtime: 'javascript',
      code: 'function main(data) {\n  return { result: data };\n}\nreturn main($data);',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'sandbox') as SandboxToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.name).toBe('calculate');
    expect(parsed.toolType).toBe('sandbox');
    expect(parsed.runtime).toBe('javascript');
    expect(parsed.code).toContain('function main(data)');
    expect(parsed.code).toContain('return main($data);');
  });

  it('roundtrips sandbox with memory_mb and timeout', () => {
    const form: SandboxToolFormData = {
      name: 'heavy_compute',
      toolType: 'sandbox',
      description: null,
      parameters: [],
      returnType: 'object',
      runtime: 'python',
      code: 'print("hello")',
      memoryMb: 512,
      timeout: 15000,
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'sandbox') as SandboxToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.runtime).toBe('python');
    expect(parsed.memoryMb).toBe(512);
    expect(parsed.timeout).toBe(15000);
  });

  it('roundtrips sandbox runtime numeric fields backed by config placeholders', () => {
    const dsl = `heavy_compute() -> object
  type: sandbox
  runtime: python
  memory_mb: {{config.SANDBOX_MEMORY_MB}}
  timeout: {{config.SANDBOX_TIMEOUT_MS}}
  code: |
    print("hello")`;

    const parsed = parseDslToToolForm(dsl, 'sandbox') as SandboxToolFormData;

    expect(parsed.memoryMb).toBe('{{config.SANDBOX_MEMORY_MB}}');
    expect(parsed.timeout).toBe('{{config.SANDBOX_TIMEOUT_MS}}');
    expect(serializeToolFormToDsl(parsed)).toContain('memory_mb: {{config.SANDBOX_MEMORY_MB}}');
  });

  it('preserves Python code through roundtrip', () => {
    const form: SandboxToolFormData = {
      name: 'py_tool',
      toolType: 'sandbox',
      description: null,
      parameters: [{ name: 'name', type: 'string', required: true }],
      returnType: 'string',
      runtime: 'python',
      code: 'def main(name):\n    return f"Hello, {name}!"\n\nmain($name)',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'sandbox') as SandboxToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.code).toContain('def main(name):');
    expect(parsed.code).toContain('main($name)');
  });
});

// =============================================================================
// parseDslToToolForm() — MCP
// =============================================================================

describe('parseDslToToolForm — MCP', () => {
  it('roundtrips MCP with server + server_tool', () => {
    const form: McpToolFormData = {
      name: 'search_docs',
      toolType: 'mcp',
      description: 'Search documents via MCP',
      parameters: [{ name: 'query', type: 'string', required: true }],
      returnType: 'object',
      server: 'doc-search-server',
      serverTool: 'search',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'mcp') as McpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.name).toBe('search_docs');
    expect(parsed.toolType).toBe('mcp');
    expect(parsed.server).toBe('doc-search-server');
    expect(parsed.serverTool).toBe('search');
  });

  it('roundtrips MCP minimal (server only)', () => {
    const form: McpToolFormData = {
      name: 'simple_mcp',
      toolType: 'mcp',
      description: null,
      parameters: [],
      returnType: 'object',
      server: 'my-mcp-server',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'mcp') as McpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.server).toBe('my-mcp-server');
    expect(parsed.serverTool).toBeUndefined();
  });

  it('roundtrips MCP with headers', () => {
    const form: McpToolFormData = {
      name: 'mcp_with_headers',
      toolType: 'mcp',
      description: 'MCP tool with auth headers',
      parameters: [],
      returnType: 'object',
      server: 'my-server',
      headers: [
        { key: 'Authorization', value: 'Bearer {{secrets.token}}' },
        { key: 'X-Custom', value: 'value' },
      ],
    };
    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'mcp') as McpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.headers).toHaveLength(2);
    expect(parsed.headers![0]).toEqual({ key: 'Authorization', value: 'Bearer {{secrets.token}}' });
    expect(parsed.headers![1]).toEqual({ key: 'X-Custom', value: 'value' });
  });
});

// =============================================================================
// parseDslToToolForm() — SearchAI
// =============================================================================

describe('parseDslToToolForm — SearchAI', () => {
  it('roundtrips SearchAI binding fields into typed form data', () => {
    const dsl = `search_docs(query: string) -> object
  description: "Search docs"
  type: searchai
  index_id: "idx_docs"
  tenant_id: "tenant_1"
  kb_name: "Docs"`;

    const parsed = parseDslToToolForm(dsl, 'searchai') as SearchAIToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.name).toBe('search_docs');
    expect(parsed.toolType).toBe('searchai');
    expect(parsed.indexId).toBe('idx_docs');
    expect(parsed.tenantId).toBe('tenant_1');
    expect(parsed.kbName).toBe('Docs');
  });
});

// =============================================================================
// parseDslToToolForm() — Workflow
// =============================================================================

describe('parseDslToToolForm — Workflow', () => {
  it('roundtrips workflow binding fields into typed form data', () => {
    const dsl = `run_flow(payload: object) -> object
  description: "Run flow"
  type: workflow
  workflow_id: "wf-1"
  workflow_version: "v1.2.3"
  trigger_id: "tr-1"
  mode: async
  timeout_ms: 15000
  param_mapping: {"payload":"$.payload"}`;

    const parsed = parseDslToToolForm(dsl, 'workflow') as WorkflowToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.name).toBe('run_flow');
    expect(parsed.toolType).toBe('workflow');
    expect(parsed.workflowId).toBe('wf-1');
    expect(parsed.workflowVersion).toBe('v1.2.3');
    expect(parsed.triggerId).toBe('tr-1');
    expect(parsed.mode).toBe('async');
    expect(parsed.timeoutMs).toBe(15000);
    expect(parsed.paramMapping).toEqual({ payload: '$.payload' });
  });

  it('roundtrips workflow timeout backed by a config placeholder', () => {
    const dsl = `run_flow(payload: object) -> object
  type: workflow
  workflow_id: "wf-1"
  trigger_id: "tr-1"
  timeout_ms: {{config.WORKFLOW_TIMEOUT_MS}}`;

    const parsed = parseDslToToolForm(dsl, 'workflow') as WorkflowToolFormData;

    expect(parsed.timeoutMs).toBe('{{config.WORKFLOW_TIMEOUT_MS}}');
    expect(serializeToolFormToDsl(parsed)).toContain('timeout_ms: {{config.WORKFLOW_TIMEOUT_MS}}');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('parseDslToToolForm — Edge cases', () => {
  it('returns null for empty DSL', () => {
    expect(parseDslToToolForm('', 'http')).toBeNull();
    expect(parseDslToToolForm('  ', 'http')).toBeNull();
  });

  it('returns null for invalid DSL (no signature)', () => {
    expect(parseDslToToolForm('just some random text', 'http')).toBeNull();
  });

  it('handles empty description', () => {
    const form: HttpToolFormData = {
      name: 'no_desc',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;
    expect(parsed.description).toBe('');
  });

  it('handles complex return types', () => {
    const form: HttpToolFormData = {
      name: 'complex_return',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: '{items: string[], total: number}',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;
    expect(parsed.returnType).toBe('{items: string[], total: number}');
  });

  it('handles optional parameters', () => {
    const form: HttpToolFormData = {
      name: 'opt_params',
      toolType: 'http',
      description: null,
      parameters: [
        { name: 'required_param', type: 'string', required: true },
        { name: 'optional_param', type: 'number', required: false },
      ],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;
    expect(parsed.parameters).toEqual([
      { name: 'required_param', type: 'string', required: true, description: '' },
      { name: 'optional_param', type: 'number', required: false, description: '' },
    ]);
  });

  it('roundtrips HTTP with oauth2_user provider field', () => {
    const form: HttpToolFormData = {
      name: 'oauth_user_api',
      toolType: 'http',
      description: 'OAuth user API',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'oauth2_user',
      authConfig: {
        provider: 'github',
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.auth).toBe('oauth2_user');
    expect(parsed.authConfig).toBeDefined();
    expect(parsed.authConfig!.provider).toBe('github');
  });

  it('normalizes stale auth_config fields when parsing HTTP auth mode', () => {
    const dsl = `weather_api() -> object
  type: http
  endpoint: https://api.example.com/weather
  method: GET
  auth: api_key
  auth_config:
    header_name: X-API-Key
    api_key: "{{secrets.WEATHER_API_KEY}}"
    token: "{{secrets.STALE_BEARER_TOKEN}}"`;

    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed.auth).toBe('api_key');
    expect(parsed.authConfig).toEqual({
      headerName: 'X-API-Key',
      apiKey: '{{secrets.WEATHER_API_KEY}}',
    });
  });

  it('parseDslDeepNestedBlock handles child block ending by lower indent', () => {
    const dsl = `my_tool() -> object
  type: http
  auth_config:
    custom_headers:
      X-Token: secret-value
  headers:
    Content-Type: application/json`;

    const entries = parseDslDeepNestedBlock(dsl, 'auth_config', 'custom_headers');
    expect(entries).toEqual([{ key: 'X-Token', value: 'secret-value' }]);
  });

  it('parseDslDeepNestedBlock handles parent block ending by lower indent', () => {
    const dsl = `my_tool() -> object
  type: http
  auth_config:
    token: abc
  endpoint: https://api.example.com`;

    // No custom_headers child in auth_config, but parent ends
    const entries = parseDslDeepNestedBlock(dsl, 'auth_config', 'custom_headers');
    expect(entries).toEqual([]);
  });

  it('returns null for unsupported toolType (default case)', () => {
    const dsl = `my_tool() -> object
  type: http
  endpoint: https://api.example.com
  method: GET`;
    // Pass an invalid toolType to trigger the default: return null
    const parsed = parseDslToToolForm(dsl, 'unknown' as any);
    expect(parsed).toBeNull();
  });

  it('roundtrips HTTP with custom auth and custom_headers block', () => {
    const form: HttpToolFormData = {
      name: 'custom_auth_api',
      toolType: 'http',
      description: 'Custom auth API',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'custom',
      authConfig: {
        customHeaders: {
          'X-Token': '{{secrets.CUSTOM_TOKEN}}',
          'X-Org-Id': 'my-org',
        },
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http') as HttpToolFormData;

    expect(parsed).not.toBeNull();
    expect(parsed.auth).toBe('custom');
    expect(parsed.authConfig).toBeDefined();
    expect(parsed.authConfig!.customHeaders).toEqual({
      'X-Token': '{{secrets.CUSTOM_TOKEN}}',
      'X-Org-Id': 'my-org',
    });
  });
});
