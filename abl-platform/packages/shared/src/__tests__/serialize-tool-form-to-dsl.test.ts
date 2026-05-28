import { describe, it, expect } from 'vitest';
import { serializeToolFormToDsl } from '../tools/serialize-tool-form-to-dsl.js';
import { parseDslToToolForm } from '../tools/parse-dsl-to-tool-form.js';
import { parseDslProperties, buildWorkflowBindingFromProps } from '../tools/dsl-property-parser.js';
import type {
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  WorkflowToolFormData,
  SearchAIToolFormData,
} from '../types/project-tool-form.js';

// =============================================================================
// HTTP — custom_headers serialization
// =============================================================================

describe('serializeToolFormToDsl — HTTP custom_headers', () => {
  it('serializes custom auth with custom_headers block', () => {
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
          'X-Token': '{{secrets.TOKEN}}',
          'X-Org': 'my-org',
        },
      },
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).toContain('auth: custom');
    expect(dsl).toContain('auth_config:');
    expect(dsl).toContain('custom_headers:');
    expect(dsl).toContain('X-Token:');
    expect(dsl).toContain('X-Org:');
  });

  it('does not emit custom_headers block when customHeaders is empty', () => {
    const form: HttpToolFormData = {
      name: 'custom_empty',
      toolType: 'http',
      description: null,
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'POST',
      auth: 'custom',
      authConfig: {
        customHeaders: {},
      },
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).not.toContain('custom_headers:');
  });
});

describe('serializeToolFormToDsl — HTTP auth profiles', () => {
  it('serializes only fields that belong to the selected HTTP auth mode', () => {
    const form: HttpToolFormData = {
      name: 'weather_api',
      toolType: 'http',
      description: 'Weather API',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/weather',
      method: 'GET',
      auth: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: '{{secrets.WEATHER_API_KEY}}',
        token: '{{secrets.STALE_BEARER_TOKEN}}',
        tokenUrl: 'https://auth.example.com/token',
      },
    };

    const dsl = serializeToolFormToDsl(form);

    expect(dsl).toContain('auth: api_key');
    expect(dsl).toContain('api_key: "{{secrets.WEATHER_API_KEY}}"');
    expect(dsl).toContain('header_name: X-API-Key');
    expect(dsl).not.toContain('STALE_BEARER_TOKEN');
    expect(dsl).not.toContain('token_url:');
  });

  it('serializes auth profile metadata and top-level scopes for HTTP tools', () => {
    const form: HttpToolFormData = {
      name: 'billing_api',
      toolType: 'http',
      description: 'Charge a customer',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/billing',
      method: 'POST',
      auth: 'none',
      authProfileRef: '{{config.BILLING_AUTH_PROFILE}}',
      authJit: true,
      consentMode: 'preflight',
      connectionMode: 'per_user',
      authConfig: {
        scopes: 'billing:write billing:read',
      },
    };

    const dsl = serializeToolFormToDsl(form);

    expect(dsl).toContain('auth_profile: "{{config.BILLING_AUTH_PROFILE}}"');
    expect(dsl).toContain('auth_jit: true');
    expect(dsl).toContain('consent: preflight');
    expect(dsl).toContain('connection: per_user');
    expect(dsl).toContain('scopes: "billing:write billing:read"');
    expect(dsl).not.toContain('auth_config:');
  });

  it('preserves documented oauth2_user auth_config fields when serializing', () => {
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
        token: '{{secrets.STALE_BEARER}}',
        apiKey: '{{secrets.STALE_API_KEY}}',
        headerName: 'X-Stale-Key',
        customHeaders: { 'X-Stale': 'stale' },
      },
    };

    const dsl = serializeToolFormToDsl(form);

    expect(dsl).toContain('auth: oauth2_user');
    expect(dsl).toContain('provider: google');
    expect(dsl).toContain('token_url: "https://auth.example.com/token"');
    expect(dsl).toContain('client_id: client-123');
    expect(dsl).toContain('client_secret: "{{secrets.CLIENT_SECRET}}"');
    expect(dsl).toContain('scopes: "profile email"');
    expect(dsl).not.toContain('STALE_BEARER');
    expect(dsl).not.toContain('STALE_API_KEY');
    expect(dsl).not.toContain('X-Stale');
  });
});

// =============================================================================
// MCP — transport_type serialization
// =============================================================================

describe('serializeToolFormToDsl — MCP transport_type', () => {
  it('serializes transport_type when not default (sse)', () => {
    const form: McpToolFormData = {
      name: 'mcp_http',
      toolType: 'mcp',
      description: null,
      parameters: [],
      returnType: 'object',
      server: 'my-server',
      transportType: 'http',
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).toContain('transport_type: http');
  });

  it('omits transport_type when default (sse)', () => {
    const form: McpToolFormData = {
      name: 'mcp_sse',
      toolType: 'mcp',
      description: null,
      parameters: [],
      returnType: 'object',
      server: 'my-server',
      transportType: 'sse',
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).not.toContain('transport_type');
  });

  it('roundtrips MCP with transport_type through parse', () => {
    const form: McpToolFormData = {
      name: 'mcp_http_rt',
      toolType: 'mcp',
      description: null,
      parameters: [],
      returnType: 'object',
      server: 'my-server',
      transportType: 'http',
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'mcp') as McpToolFormData;
    expect(parsed.transportType).toBe('http');
  });
});

// =============================================================================
// Parameter metadata — enum and default serialization
// =============================================================================

describe('serializeToolFormToDsl — parameter metadata (enum, default)', () => {
  it('serializes enum values in params block', () => {
    const form: HttpToolFormData = {
      name: 'weather_api',
      toolType: 'http',
      description: 'Get weather',
      parameters: [
        {
          name: 'units',
          type: 'string',
          required: false,
          description: 'Unit of measure',
          enumValues: ['metric', 'imperial'],
          defaultValue: 'metric',
        },
      ],
      returnType: 'object',
      endpoint: 'https://api.weather.com/v1',
      method: 'GET',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).toContain('params:');
    expect(dsl).toContain('units:');
    expect(dsl).toContain('enum: metric, imperial');
    expect(dsl).toContain('default: metric');
  });

  it('serializes objectSchema in params block', () => {
    const form: HttpToolFormData = {
      name: 'create_user_api',
      toolType: 'http',
      description: 'Create user',
      parameters: [
        {
          name: 'data',
          type: 'object',
          required: true,
          objectSchema: '{"name": {"type": "string"}}',
        },
      ],
      returnType: 'object',
      endpoint: 'https://api.example.com/users',
      method: 'POST',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).toContain('params:');
    expect(dsl).toContain('data:');
    expect(dsl).toContain('schema:');
  });

  it('does not emit params block when no parameter has metadata', () => {
    const form: HttpToolFormData = {
      name: 'bare_api',
      toolType: 'http',
      description: null,
      parameters: [{ name: 'input', type: 'string', required: true }],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
    };

    const dsl = serializeToolFormToDsl(form);
    expect(dsl).not.toContain('params:');
  });
});

describe('serializeToolFormToDsl — workflow_version semver pins', () => {
  it('serializes workflow_version and preserves it through workflow binding parse', () => {
    const form: WorkflowToolFormData = {
      name: 'run_orders',
      toolType: 'workflow',
      description: 'Run orders workflow',
      parameters: [],
      returnType: 'object',
      workflowId: 'wf-1',
      workflowVersion: 'v1.2.3',
      triggerId: 'tr-webhook',
      mode: 'sync',
    };

    const dsl = serializeToolFormToDsl(form);
    const binding = buildWorkflowBindingFromProps(parseDslProperties(dsl));

    expect(dsl).toContain('workflow_version: v1.2.3');
    expect(binding.workflowVersion).toBe('v1.2.3');
    expect(binding.workflowVersionId).toBeUndefined();
  });
});

describe('serializeToolFormToDsl — SearchAI', () => {
  it('serializes SearchAI typed form data with server-derived tenant binding', () => {
    const form: SearchAIToolFormData = {
      name: 'search_docs',
      toolType: 'searchai',
      description: 'Search documentation',
      parameters: [{ name: 'query', type: 'string', description: 'Query', required: true }],
      returnType: 'object',
      indexId: 'idx_docs',
      tenantId: 'tenant_1',
      kbName: 'Docs',
    };

    const dsl = serializeToolFormToDsl(form);

    expect(dsl).toContain('type: searchai');
    expect(dsl).toContain('index_id: idx_docs');
    expect(dsl).toContain('tenant_id: tenant_1');
    expect(dsl).toContain('kb_name: Docs');
  });
});
