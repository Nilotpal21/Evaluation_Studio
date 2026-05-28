import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockRequireAdminRole = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  requireAdminRole: (...args: unknown[]) => mockRequireAdminRole(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: vi.fn(() => 'http://runtime.example'),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { POST as GuardrailProvidersPOST } from '@/app/api/admin/guardrail-providers/route';

describe('POST /api/admin/guardrail-providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['credential:write'],
    });
    mockRequireAdminRole.mockResolvedValue(null);
    mockFetch.mockResolvedValue({
      status: 201,
      json: async () => ({
        success: true,
        data: {
          _id: 'provider-1',
          adapterType: 'openai_moderation',
        },
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts openai_moderation and proxies it to runtime', async () => {
    const response = await GuardrailProvidersPOST(
      new NextRequest('http://localhost:3000/api/admin/guardrail-providers', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'openai-mod',
          displayName: 'OpenAI Moderation',
          adapterType: 'openai_moderation',
          endpoint: 'https://api.openai.com/v1/moderations',
          model: 'omni-moderation-latest',
          hosting: 'cloud_api',
          defaultCategory: 'safety',
          defaultThreshold: 0.7,
          circuitBreaker: { maxFailures: 5, resetTimeout: 30000 },
          retry: { maxRetries: 3, backoff: 'exponential' },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://runtime.example/api/tenants/tenant-1/guardrail-providers',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({
        adapterType: 'openai_moderation',
        circuitBreaker: {
          failureThreshold: 5,
          resetTimeoutMs: 30000,
        },
        retry: {
          maxRetries: 3,
          backoffBaseMs: 1000,
        },
      }),
    );
  });

  it('rejects unsupported adapter types before proxying', async () => {
    const response = await GuardrailProvidersPOST(
      new NextRequest('http://localhost:3000/api/admin/guardrail-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'planned-provider',
          displayName: 'Planned Provider',
          adapterType: 'openai_compatible',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'ADAPTER_NOT_IMPLEMENTED',
        }),
      }),
    );
  });

  it('rejects raw API keys instead of forwarding secrets that runtime cannot persist', async () => {
    const response = await GuardrailProvidersPOST(
      new NextRequest('http://localhost:3000/api/admin/guardrail-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'openai-mod',
          displayName: 'OpenAI Moderation',
          adapterType: 'openai_moderation',
          endpoint: 'https://api.openai.com/v1/moderations',
          model: 'omni-moderation-latest',
          hosting: 'cloud_api',
          defaultCategory: 'safety',
          defaultThreshold: 0.7,
          circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
          retry: { maxRetries: 3, backoffBaseMs: 1000 },
          apiKey: 'sk-raw-secret',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      }),
    );
  });

  it('rejects builtin_pii because it is auto-registered, not tenant-configurable', async () => {
    const response = await GuardrailProvidersPOST(
      new NextRequest('http://localhost:3000/api/admin/guardrail-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'builtin-pii-config',
          displayName: 'Built-in PII',
          adapterType: 'builtin_pii',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'ADAPTER_NOT_IMPLEMENTED',
        }),
      }),
    );
  });
});
