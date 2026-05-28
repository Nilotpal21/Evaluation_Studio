import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHttpRequest, type HttpStep } from '../executors/http-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const mockSafeFetch = vi.hoisted(() => vi.fn());

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  safeFetch: mockSafeFetch,
}));

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-123', apiKey: 'sk-test-123' },
  },
  workflow: { id: 'wf-1', name: 'test', executionId: 'exec-1' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {
    'auth-step': {
      output: { token: 'bearer-abc' },
      status: 'completed',
    },
  },
  vars: {},
};

describe('executeHttpRequest', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves URL expressions and makes GET request', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ order: { id: 'ORD-123', status: 'shipped' } })),
      headers: new Headers({ 'content-type': 'application/json' }),
    };
    mockSafeFetch.mockResolvedValue(mockResponse);

    const step: HttpStep = {
      id: 'step-1',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/orders/{{trigger.payload.orderId}}',
    };

    const result = await executeHttpRequest(step, ctx);

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ order: { id: 'ORD-123', status: 'shipped' } });
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://api.example.com/orders/ORD-123',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('resolves header expressions', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{}'),
      headers: new Headers(),
    };
    mockSafeFetch.mockResolvedValue(mockResponse);

    const step: HttpStep = {
      id: 'step-2',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/data',
      headers: {
        Authorization: 'Bearer {{steps.auth-step.output.token}}',
        'X-API-Key': '{{trigger.payload.apiKey}}',
      },
    };

    await executeHttpRequest(step, ctx);

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer bearer-abc',
          'X-API-Key': 'sk-test-123',
        }),
      }),
    );
  });

  it('resolves body expressions for POST', async () => {
    const mockResponse = {
      ok: true,
      status: 201,
      text: vi.fn().mockResolvedValue(JSON.stringify({ id: 'new-1' })),
      headers: new Headers(),
    };
    mockSafeFetch.mockResolvedValue(mockResponse);

    const step: HttpStep = {
      id: 'step-3',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/orders',
      body: '{{trigger.payload.orderId}}',
    };

    const result = await executeHttpRequest(step, ctx);

    expect(result.statusCode).toBe(201);
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://api.example.com/orders',
      expect.objectContaining({
        method: 'POST',
        body: 'ORD-123',
      }),
    );
  });

  it('rejects SSRF-unsafe URLs (private IP)', async () => {
    const step: HttpStep = {
      id: 'step-4',
      type: 'http',
      method: 'GET',
      url: 'http://169.254.169.254/latest/meta-data/',
    };

    mockSafeFetch.mockRejectedValueOnce(new Error('Blocked by SSRF policy'));

    await expect(executeHttpRequest(step, ctx)).rejects.toThrow('Blocked by SSRF policy');
  });

  it('rejects SSRF-unsafe URLs (localhost)', async () => {
    const step: HttpStep = {
      id: 'step-5',
      type: 'http',
      method: 'GET',
      url: 'http://127.0.0.1:8080/admin',
    };

    mockSafeFetch.mockRejectedValueOnce(new Error('Blocked by SSRF policy'));

    await expect(executeHttpRequest(step, ctx)).rejects.toThrow('Blocked by SSRF policy');
  });

  it('handles non-JSON response gracefully', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error('not json')),
      text: vi.fn().mockResolvedValue('plain text response'),
      headers: new Headers(),
    };
    mockSafeFetch.mockResolvedValue(mockResponse);

    const step: HttpStep = {
      id: 'step-6',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/text',
    };

    const result = await executeHttpRequest(step, ctx);

    expect(result.body).toBe('plain text response');
  });

  it('returns response headers', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{}'),
      headers: new Headers({
        'content-type': 'application/json',
        'x-request-id': 'req-abc',
      }),
    };
    mockSafeFetch.mockResolvedValue(mockResponse);

    const step: HttpStep = {
      id: 'step-7',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/data',
    };

    const result = await executeHttpRequest(step, ctx);

    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['x-request-id']).toBe('req-abc');
  });

  it('throws on HTTP error responses (non-2xx)', async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'not found' })),
      headers: new Headers(),
    };
    mockSafeFetch.mockResolvedValue(mockResponse);

    const step: HttpStep = {
      id: 'step-err',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/missing',
    };

    await expect(executeHttpRequest(step, ctx)).rejects.toThrow('HTTP 404');
  });

  it('throws on empty URL', async () => {
    const step: HttpStep = {
      id: 'step-empty',
      type: 'http',
      method: 'GET',
      url: '',
    };

    await expect(executeHttpRequest(step, ctx)).rejects.toThrow('no URL configured');
  });

  it('throws on HTTP error responses (non-2xx)', async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'not found' })),
      headers: new Headers(),
    };
    mockSafeFetch.mockResolvedValue(mockResponse);

    const step: HttpStep = {
      id: 'step-err',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/missing',
    };

    await expect(executeHttpRequest(step, ctx)).rejects.toThrow('HTTP 404');
  });

  it('throws on empty URL', async () => {
    const step: HttpStep = {
      id: 'step-empty',
      type: 'http',
      method: 'GET',
      url: '',
    };

    await expect(executeHttpRequest(step, ctx)).rejects.toThrow('no URL configured');
  });
});
