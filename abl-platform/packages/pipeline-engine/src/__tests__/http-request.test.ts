/**
 * Unit tests for the HttpRequest Restate activity service.
 *
 * Access pattern: Restate wraps service definitions so that the raw handler
 * functions are exposed at `serviceDefinition.service.execute`, NOT at
 * `serviceDefinition.handlers.execute`.
 *
 * We mock global fetch and restate.Context with ctx.run(label, fn) → calls fn() directly.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the service logic by importing the raw handler
// Since it's a Restate service, we test the core logic patterns

describe('HttpRequestService', () => {
  test('module exports a Restate service', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    expect(httpRequestService).toBeDefined();
  });

  test('template substitution in URL works', async () => {
    const { substituteTemplates } = await import('../pipeline/template-engine.js');
    const url = substituteTemplates('https://api.example.com/{{input.tenantId}}/data', {
      input: { tenantId: 'tenant-123' },
    });
    expect(url).toBe('https://api.example.com/tenant-123/data');
  });

  test('template substitution in headers works', async () => {
    const { substituteTemplates } = await import('../pipeline/template-engine.js');
    const authHeader = substituteTemplates('Bearer {{input.token}}', {
      input: { token: 'abc123' },
    });
    expect(authHeader).toBe('Bearer abc123');
  });

  test('template substitution in body works', async () => {
    const { substituteTemplates } = await import('../pipeline/template-engine.js');
    const body = substituteTemplates('{"score": "{{steps.eval.output.score}}"}', {
      steps: { eval: { output: { score: 0.95 } } },
    });
    expect(body).toBe('{"score": "0.95"}');
  });
});

describe('HttpRequestService handler', () => {
  const mockFetch = vi.fn();

  /** Minimal restate.Context mock: ctx.run executes fn() directly. */
  function createMockContext(): any {
    return {
      run: async (_label: string, fn: () => any) => fn(),
      console: { log: () => {} },
    };
  }

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function getExecute(svc: any): (ctx: any, input: any) => Promise<any> {
    return (svc as any).service.execute;
  }

  test('successful GET request returns status code and parsed JSON body', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"result": "ok"}',
      headers: new Map([['content-type', 'application/json']]),
    });

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: {
        url: 'https://api.example.com/data',
        method: 'GET',
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'test-tenant' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.statusCode).toBe(200);
    expect(result.data.body).toEqual({ result: 'ok' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('POST request sends body', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      statusText: 'Created',
      text: async () => '{"id": "new-123"}',
      headers: new Map([['content-type', 'application/json']]),
    });

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: {
        url: 'https://api.example.com/items',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name": "test-item"}',
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'test-tenant' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.statusCode).toBe(201);
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].body).toBe('{"name": "test-item"}');
  });

  test('non-2xx response returns fail with status code', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '{"error": "not found"}',
      headers: new Map(),
    });

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: {
        url: 'https://api.example.com/missing',
        method: 'GET',
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'test-tenant' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.statusCode).toBe(404);
    expect(result.data.error).toContain('404');
  });

  test('network error returns fail with error message', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: {
        url: 'https://api.example.com/down',
        method: 'GET',
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'test-tenant' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('ECONNREFUSED');
  });

  test('template substitution in URL, headers, and body', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '"ok"',
      headers: new Map(),
    });

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: {
        url: 'https://api.example.com/{{input.tenantId}}/results',
        method: 'POST',
        headers: { Authorization: 'Bearer {{input.token}}' },
        body: '{"score": "{{steps.eval.output.score}}"}',
      },
      previousSteps: {
        eval: { status: 'success', data: { score: 0.95 } },
      },
      pipelineInput: { tenantId: 'tenant-abc', token: 'secret-tok' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.example.com/tenant-abc/results');
    expect(fetchCall[1].headers.Authorization).toBe('Bearer [REDACTED]');
    expect(fetchCall[1].body).toBe('{"score": "0.95"}');
  });

  test('redacts tokenized PII from action template output', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '"ok"',
      headers: new Map(),
    });

    const tokenized = '{{PII:email:00000000-0000-0000-0000-000000000000}}';
    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      projectId: 'project-1',
      config: {
        url: 'https://api.example.com/results',
        method: 'POST',
        body: '{"email": "{{steps.read.output.email}}"}',
      },
      previousSteps: {
        read: { status: 'success', data: { email: tokenized } },
      },
      pipelineInput: { tenantId: 'tenant-abc', projectId: 'project-1' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].body).toBe('{"email": "[REDACTED_EMAIL]"}');
  });

  test('defaults to GET method when not specified', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '"ok"',
      headers: new Map(),
    });

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: { url: 'https://api.example.com/health' },
      previousSteps: {},
      pipelineInput: {},
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].method).toBe('GET');
    // GET should not send body
    expect(fetchCall[1].body).toBeUndefined();
  });

  test('non-JSON response text is returned as-is', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'plain text response',
      headers: new Map(),
    });

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: { url: 'https://api.example.com/text' },
      previousSteps: {},
      pipelineInput: {},
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.body).toBe('plain text response');
  });

  test('object body is JSON.stringified before template substitution', async () => {
    const { httpRequestService } = await import('../pipeline/services/http-request.service.js');
    const execute = getExecute(httpRequestService);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '"ok"',
      headers: new Map(),
    });

    const ctx = createMockContext();
    const input = {
      tenantId: 'test-tenant',
      config: {
        url: 'https://api.example.com/webhook',
        method: 'POST',
        body: { key: '{{input.value}}' },
      },
      previousSteps: {},
      pipelineInput: { value: 'resolved-val' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const fetchCall = mockFetch.mock.calls[0];
    // Object body is stringified then templates resolved
    const sentBody = fetchCall[1].body;
    expect(sentBody).toContain('resolved-val');
  });
});
