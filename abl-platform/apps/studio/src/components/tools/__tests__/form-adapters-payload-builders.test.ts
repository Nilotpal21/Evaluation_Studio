/**
 * Form Adapter Payload Builder Tests
 *
 * Tests for buildHttpCreatePayload, buildSandboxCreatePayload,
 * buildMcpCreatePayload, and buildWorkflowCreatePayload — the shared
 * functions that flatten UI config into the API-expected payload shape.
 */

import { describe, test, expect } from 'vitest';
import {
  buildHttpCreatePayload,
  buildSandboxCreatePayload,
  buildMcpCreatePayload,
  buildWorkflowCreatePayload,
} from '../form-adapters';
import type { HttpConfig, SandboxConfig, McpConfig, WorkflowConfig } from '../shared-types';

// =============================================================================
// HTTP PAYLOAD BUILDER
// =============================================================================

describe('buildHttpCreatePayload', () => {
  test('builds minimal valid HTTP payload', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com/v1/data',
      method: 'GET',
      authType: 'none',
    };
    const payload = buildHttpCreatePayload('fetch_data', 'Fetches data', cfg);

    expect(payload.name).toBe('fetch_data');
    expect(payload.toolType).toBe('http');
    expect(payload.description).toBe('Fetches data');
    expect(payload.endpoint).toBe('https://api.example.com/v1/data');
    expect(payload.method).toBe('GET');
    expect(payload.auth).toBe('none');
    expect(payload.returnType).toBe('object');
  });

  test('includes authConfig when present', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: '{{secrets.MY_KEY}}',
      },
    };
    const payload = buildHttpCreatePayload('secured_api', '', cfg);

    expect(payload.auth).toBe('api_key');
    expect(payload.authConfig).toEqual({
      headerName: 'X-API-Key',
      apiKey: '{{secrets.MY_KEY}}',
    });
  });

  test('includes customHeaders as object in authConfig', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'custom',
      authConfig: {
        customHeaders: {
          'X-Auth': '{{secrets.TOKEN}}',
          'X-Tenant': 'tenant-123',
        },
      },
    };
    const payload = buildHttpCreatePayload('custom_auth_tool', '', cfg);

    expect(payload.authConfig).toEqual({
      customHeaders: {
        'X-Auth': '{{secrets.TOKEN}}',
        'X-Tenant': 'tenant-123',
      },
    });
  });

  test('filters out empty-key headers', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: '', value: 'orphan-value' },
        { key: '  ', value: 'whitespace-key' },
      ],
    };
    const payload = buildHttpCreatePayload('with_headers', '', cfg);

    expect(payload.headers).toHaveLength(1);
    expect(payload.headers![0].key).toBe('Content-Type');
  });

  test('filters out empty-key query params', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      queryParams: [
        { key: 'page', value: '1' },
        { key: '', value: 'orphan' },
      ],
    };
    const payload = buildHttpCreatePayload('with_params', '', cfg);

    expect(payload.queryParams).toHaveLength(1);
    expect(payload.queryParams![0].key).toBe('page');
  });

  test('omits default timeout (30000)', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      timeoutMs: 30000,
    };
    const payload = buildHttpCreatePayload('default_timeout', '', cfg);

    expect(payload.timeout).toBeUndefined();
  });

  test('includes non-default timeout', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      timeoutMs: 60000,
    };
    const payload = buildHttpCreatePayload('custom_timeout', '', cfg);

    expect(payload.timeout).toBe(60000);
  });

  test('includes config template timeout', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      timeoutMs: '{{config.HTTP_TIMEOUT_MS}}',
    };
    const payload = buildHttpCreatePayload('template_timeout', '', cfg);

    expect(payload.timeout).toBe('{{config.HTTP_TIMEOUT_MS}}');
  });

  test('omits retry when zero', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryCount: 0,
    };
    const payload = buildHttpCreatePayload('no_retry', '', cfg);

    expect(payload.retry).toBeUndefined();
  });

  test('includes positive retry count', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryCount: 3,
    };
    const payload = buildHttpCreatePayload('with_retry', '', cfg);

    expect(payload.retry).toBe(3);
  });

  test('omits default retryDelay (1000)', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      retryDelayMs: 1000,
    };
    const payload = buildHttpCreatePayload('default_delay', '', cfg);

    expect(payload.retryDelay).toBeUndefined();
  });

  test('includes circuit breaker when configured', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      circuitBreaker: { threshold: 5, resetMs: 30000 },
    };
    const payload = buildHttpCreatePayload('with_cb', '', cfg);

    expect(payload.circuitBreaker).toEqual({ threshold: 5, resetMs: 30000 });
  });

  test('includes parameters with full metadata', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      parameters: [
        {
          name: 'user_id',
          type: 'string',
          description: 'The user ID',
          required: true,
        },
        {
          name: 'status',
          type: 'enum',
          description: 'Filter status',
          required: false,
          enumValues: ['active', 'inactive'],
          defaultValue: 'active',
        },
        {
          name: 'metadata',
          type: 'object',
          description: 'Extra metadata',
          required: false,
          objectSchema: '{"type":"object","properties":{"key":{"type":"string"}}}',
        },
      ],
    };
    const payload = buildHttpCreatePayload('with_params', '', cfg);

    expect(payload.parameters).toHaveLength(3);
    expect(payload.parameters![0]).toEqual({
      name: 'user_id',
      type: 'string',
      description: 'The user ID',
      required: true,
    });
    expect(payload.parameters![1]).toEqual({
      name: 'status',
      type: 'enum',
      description: 'Filter status',
      required: false,
      enumValues: ['active', 'inactive'],
      defaultValue: 'active',
    });
    expect(payload.parameters![2].objectSchema).toBeDefined();
  });

  test('omits parameters when empty', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      parameters: [],
    };
    const payload = buildHttpCreatePayload('no_params', '', cfg);

    expect(payload.parameters).toBeUndefined();
  });

  test('includes body, bodyType, bodySchema, useBodySchema', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'none',
      body: '{"name": "{{input.name}}"}',
      bodyType: 'json',
      bodySchema: '{"type":"object","properties":{"name":{"type":"string"}}}',
      useBodySchema: true,
    };
    const payload = buildHttpCreatePayload('with_body', '', cfg);

    expect(payload.body).toBe('{"name": "{{input.name}}"}');
    expect(payload.bodyType).toBe('json');
    expect(payload.bodySchema).toBe('{"type":"object","properties":{"name":{"type":"string"}}}');
    expect(payload.useBodySchema).toBe(true);
  });

  test('includes authProfileRef and related fields', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'oauth2_client',
      authProfileRef: 'profile-123',
      authJit: true,
      consentMode: 'preflight',
      connectionMode: 'per_user',
    };
    const payload = buildHttpCreatePayload('with_profile', '', cfg);

    expect(payload.authProfileRef).toBe('profile-123');
    expect(payload.authJit).toBe(true);
    expect(payload.consentMode).toBe('preflight');
    expect(payload.connectionMode).toBe('per_user');
  });

  test('sets description to undefined when empty string', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
    };
    const payload = buildHttpCreatePayload('no_desc', '', cfg);

    expect(payload.description).toBeUndefined();
  });

  test('includes rateLimit', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      rateLimitPerMinute: 100,
    };
    const payload = buildHttpCreatePayload('rate_limited', '', cfg);

    expect(payload.rateLimit).toBe(100);
  });

  test('omits authConfig when authType is none even if stale authConfig present', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'none',
      // Stale authConfig from switching custom → none without clearing
      authConfig: {
        customHeaders: { 'X-Auth': 'stale-token' },
      },
    };
    const payload = buildHttpCreatePayload('stale_auth', '', cfg);

    expect(payload.auth).toBe('none');
    expect(payload.authConfig).toBeUndefined();
  });

  test('includes authConfig when authType is not none', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: { token: '{{secrets.TOKEN}}' },
    };
    const payload = buildHttpCreatePayload('bearer_tool', '', cfg);

    expect(payload.auth).toBe('bearer');
    expect(payload.authConfig).toEqual({ token: '{{secrets.TOKEN}}' });
  });

  test('prunes stale authConfig keys that do not match selected authType', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'bearer',
      authConfig: {
        token: '{{secrets.TOKEN}}',
        apiKey: '{{secrets.STALE}}',
        headerName: 'X-API-Key',
      },
    };
    const payload = buildHttpCreatePayload('bearer_tool', '', cfg);

    expect(payload.authConfig).toEqual({ token: '{{secrets.TOKEN}}' });
  });

  test('omits auth-profile runtime flags when authProfileRef is missing', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'GET',
      authType: 'oauth2_client',
      authJit: true,
      consentMode: 'preflight',
      connectionMode: 'per_user',
      authConfig: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tokenUrl: 'https://auth.example.com/token',
      },
    };
    const payload = buildHttpCreatePayload('oauth_tool', '', cfg);

    expect(payload.authJit).toBeUndefined();
    expect(payload.consentMode).toBeUndefined();
    expect(payload.connectionMode).toBeUndefined();
  });

  test('keeps only requested scopes when auth profile is selected', () => {
    const cfg: HttpConfig = {
      endpoint: 'https://api.example.com',
      method: 'POST',
      authType: 'oauth2_client',
      authProfileRef: 'billing_api_auth',
      authConfig: {
        scopes: 'invoices.read invoices.write',
        clientId: 'stale-client-id',
        clientSecret: 'stale-secret',
        tokenUrl: 'https://stale.example.com/token',
      },
    };
    const payload = buildHttpCreatePayload('oauth_tool', '', cfg);

    expect(payload.authProfileRef).toBe('billing_api_auth');
    expect(payload.authConfig).toEqual({ scopes: 'invoices.read invoices.write' });
  });
});

// =============================================================================
// SANDBOX PAYLOAD BUILDER
// =============================================================================

describe('buildSandboxCreatePayload', () => {
  test('builds minimal valid sandbox payload', () => {
    const cfg: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'return input.x + input.y;',
    };
    const payload = buildSandboxCreatePayload('add_numbers', 'Adds two numbers', cfg);

    expect(payload.name).toBe('add_numbers');
    expect(payload.toolType).toBe('sandbox');
    expect(payload.description).toBe('Adds two numbers');
    expect(payload.runtime).toBe('javascript');
    expect(payload.code).toBe('return input.x + input.y;');
    expect(payload.returnType).toBe('object');
  });

  test('includes memoryMb when set', () => {
    const cfg: SandboxConfig = {
      runtime: 'python',
      codeContent: 'print("hello")',
      memoryMb: 256,
    };
    const payload = buildSandboxCreatePayload('py_tool', '', cfg);

    expect(payload.memoryMb).toBe(256);
  });

  test('omits default timeout (5000)', () => {
    const cfg: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'return 1;',
      timeoutMs: 5000,
    };
    const payload = buildSandboxCreatePayload('default_timeout', '', cfg);

    expect(payload.timeout).toBeUndefined();
  });

  test('includes non-default timeout', () => {
    const cfg: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'return 1;',
      timeoutMs: 15000,
    };
    const payload = buildSandboxCreatePayload('custom_timeout', '', cfg);

    expect(payload.timeout).toBe(15000);
  });

  test('includes parameters', () => {
    const cfg: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'return input.x;',
      parameters: [{ name: 'x', type: 'number', description: 'Input number', required: true }],
    };
    const payload = buildSandboxCreatePayload('with_params', '', cfg);

    expect(payload.parameters).toHaveLength(1);
    expect(payload.parameters![0].name).toBe('x');
  });
});

// =============================================================================
// MCP PAYLOAD BUILDER
// =============================================================================

describe('buildMcpCreatePayload', () => {
  test('builds minimal valid MCP payload', () => {
    const cfg: McpConfig = {
      serverUrl: 'https://mcp.example.com/sse',
      transportType: 'sse',
      headers: [],
      serverToolName: 'search',
    };
    const payload = buildMcpCreatePayload('mcp_search', 'Search via MCP', cfg);

    expect(payload.name).toBe('mcp_search');
    expect(payload.toolType).toBe('mcp');
    expect(payload.description).toBe('Search via MCP');
    expect(payload.server).toBe('https://mcp.example.com/sse');
    expect(payload.serverTool).toBe('search');
  });

  test('omits transportType when SSE (default)', () => {
    const cfg: McpConfig = {
      serverUrl: 'https://mcp.example.com/sse',
      transportType: 'sse',
      headers: [],
      serverToolName: 'tool',
    };
    const payload = buildMcpCreatePayload('mcp_tool', '', cfg);

    expect(payload.transportType).toBeUndefined();
  });

  test('includes transportType when HTTP', () => {
    const cfg: McpConfig = {
      serverUrl: 'https://mcp.example.com/http',
      transportType: 'http',
      headers: [],
      serverToolName: 'tool',
    };
    const payload = buildMcpCreatePayload('mcp_http', '', cfg);

    expect(payload.transportType).toBe('http');
  });

  test('includes headers and filters empty keys', () => {
    const cfg: McpConfig = {
      serverUrl: 'https://mcp.example.com',
      transportType: 'sse',
      headers: [
        { key: 'Authorization', value: 'Bearer token' },
        { key: '', value: 'orphan' },
      ],
      serverToolName: 'tool',
    };
    const payload = buildMcpCreatePayload('mcp_headers', '', cfg);

    expect(payload.headers).toHaveLength(1);
    expect(payload.headers![0].key).toBe('Authorization');
  });
});

// =============================================================================
// WORKFLOW PAYLOAD BUILDER
// =============================================================================

describe('buildWorkflowCreatePayload', () => {
  test('builds minimal valid workflow payload', () => {
    const cfg: WorkflowConfig = {
      workflowId: 'wf-123',
      triggerId: 'trigger-abc',
      mode: 'sync',
    };
    const payload = buildWorkflowCreatePayload('wf_tool', 'Runs a workflow', cfg);

    expect(payload.name).toBe('wf_tool');
    expect(payload.toolType).toBe('workflow');
    expect(payload.description).toBe('Runs a workflow');
    expect(payload.workflowId).toBe('wf-123');
    expect(payload.triggerId).toBe('trigger-abc');
    expect(payload.mode).toBe('sync');
  });

  test('includes workflowVersion when set', () => {
    const cfg: WorkflowConfig = {
      workflowId: 'wf-123',
      workflowVersion: 'v0.2.0',
      triggerId: 'trigger-abc',
      mode: 'sync',
    };
    const payload = buildWorkflowCreatePayload('wf_versioned', '', cfg);

    expect(payload.workflowVersion).toBe('v0.2.0');
  });

  test('includes timeoutMs', () => {
    const cfg: WorkflowConfig = {
      workflowId: 'wf-123',
      triggerId: 'trigger-abc',
      mode: 'async',
      timeoutMs: 120000,
    };
    const payload = buildWorkflowCreatePayload('wf_async', '', cfg);

    expect(payload.timeoutMs).toBe(120000);
    expect(payload.mode).toBe('async');
  });

  test('includes paramMapping', () => {
    const cfg: WorkflowConfig = {
      workflowId: 'wf-123',
      triggerId: 'trigger-abc',
      mode: 'sync',
      paramMapping: { input_name: 'workflow_name', input_email: 'workflow_email' },
    };
    const payload = buildWorkflowCreatePayload('wf_mapped', '', cfg);

    expect(payload.paramMapping).toEqual({
      input_name: 'workflow_name',
      input_email: 'workflow_email',
    });
  });

  test('includes parameters when non-empty', () => {
    const cfg: WorkflowConfig = {
      workflowId: 'wf-123',
      triggerId: 'trigger-abc',
      mode: 'sync',
      parameters: [{ name: 'customer_name', type: 'string', description: 'Name', required: true }],
    };
    const payload = buildWorkflowCreatePayload('wf_params', '', cfg);

    expect(payload.parameters).toHaveLength(1);
    expect(payload.parameters![0].name).toBe('customer_name');
  });

  test('omits parameters when empty', () => {
    const cfg: WorkflowConfig = {
      workflowId: 'wf-123',
      triggerId: 'trigger-abc',
      mode: 'sync',
      parameters: [],
    };
    const payload = buildWorkflowCreatePayload('wf_no_params', '', cfg);

    expect(payload.parameters).toBeUndefined();
  });
});
