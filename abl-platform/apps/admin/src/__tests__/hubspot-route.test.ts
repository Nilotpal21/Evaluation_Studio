import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockBuildRuntimeHeaders = vi.fn();
const mockFetch = vi.fn();

vi.mock('../lib/with-admin-route', () => ({
  withAdminRoute:
    (_options: unknown, handler: (ctx: any) => Promise<Response>) =>
    async (request: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) =>
      handler({
        request,
        params: routeCtx?.params ? await routeCtx.params : {},
        token: 'admin-token',
        user: {
          userId: 'admin-user',
          email: 'admin@example.com',
          role: 'SUPER_ADMIN',
          ipAddress: '127.0.0.1',
          isSuperAdmin: true,
        },
      }),
}));

vi.mock('../lib/runtime-proxy', () => ({
  getRuntimeBaseUrl: () => 'http://localhost:3112',
  buildRuntimeHeaders: (...args: unknown[]) => mockBuildRuntimeHeaders(...args),
}));

function makeJsonRequest(url: string, method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

const createDealBody = {
  organizationId: 'org-123',
  name: 'Enterprise Renewal',
  status: 'active',
  scope: 'organization',
  aggregationMode: 'additive',
  overagePolicy: 'soft_cap',
};

const createLineItemBody = {
  periodLabel: 'January 2026',
  description: 'Base fee',
  quantity: 1,
  unitPrice: 100,
  totalAmount: 100,
  category: 'base',
};

type ValidationCase = {
  body: Record<string, unknown>;
  importPath: string;
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT';
  name: string;
  params?: Record<string, string>;
  url: string;
};

const validationCases: ValidationCase[] = [
  {
    name: 'HubSpot sync',
    importPath: '../app/api/hubspot/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/hubspot',
    body: {
      hubspotDealId: 'deal-123',
      unexpected: 'should-be-rejected',
    },
  },
  {
    name: 'tenant create',
    importPath: '../app/api/tenants/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/tenants',
    body: {
      name: 'Acme',
      slug: 'acme',
      planTier: 'TEAM',
      unexpected: true,
    },
  },
  {
    name: 'tenant status update',
    importPath: '../app/api/tenants/[tenantId]/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/tenants/tenant-123',
    params: { tenantId: 'tenant-123' },
    body: {
      status: 'active',
      unexpected: true,
    },
  },
  {
    name: 'tenant feature flags update',
    importPath: '../app/api/tenants/[tenantId]/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/tenants/tenant-123/features',
    params: { tenantId: 'tenant-123' },
    body: {
      codeToolsEnabled: true,
      unexpected: true,
    },
  },
  {
    name: 'tenant subscription update',
    importPath: '../app/api/tenants/[tenantId]/subscription/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/tenants/tenant-123/subscription',
    params: { tenantId: 'tenant-123' },
    body: {
      planTier: 'BUSINESS',
      unexpected: true,
    },
  },
  {
    name: 'tenant member add',
    importPath: '../app/api/tenants/[tenantId]/members/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/tenants/tenant-123/members',
    params: { tenantId: 'tenant-123' },
    body: {
      email: 'user@example.com',
      role: 'MEMBER',
      unexpected: true,
    },
  },
  {
    name: 'tenant member role update',
    importPath: '../app/api/tenants/[tenantId]/members/[userId]/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/tenants/tenant-123/members/user-123',
    params: { tenantId: 'tenant-123', userId: 'user-123' },
    body: {
      role: 'ADMIN',
      unexpected: true,
    },
  },
  {
    name: 'tenant project create',
    importPath: '../app/api/tenants/[tenantId]/projects/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/tenants/tenant-123/projects',
    params: { tenantId: 'tenant-123' },
    body: {
      name: 'Project Atlas',
      slug: 'project-atlas',
      unexpected: true,
    },
  },
  {
    name: 'tenant project delete',
    importPath: '../app/api/tenants/[tenantId]/projects/route.js',
    method: 'DELETE',
    url: 'http://localhost:3003/api/tenants/tenant-123/projects',
    params: { tenantId: 'tenant-123' },
    body: {
      projectId: 'project-123',
      unexpected: true,
    },
  },
  {
    name: 'deal create',
    importPath: '../app/api/deals/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/deals',
    body: {
      ...createDealBody,
      unexpected: true,
    },
  },
  {
    name: 'deal update',
    importPath: '../app/api/deals/[id]/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/deals/deal-123',
    params: { id: 'deal-123' },
    body: {
      name: 'Updated Deal',
      unexpected: true,
    },
  },
  {
    name: 'deal credit top-up',
    importPath: '../app/api/deals/[id]/credits/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/deals/deal-123/credits',
    params: { id: 'deal-123' },
    body: {
      feature: 'general',
      credits: 500,
      unexpected: true,
    },
  },
  {
    name: 'deal line item create',
    importPath: '../app/api/deals/[id]/line-items/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/deals/deal-123/line-items',
    params: { id: 'deal-123' },
    body: {
      ...createLineItemBody,
      unexpected: true,
    },
  },
  {
    name: 'deal line item update',
    importPath: '../app/api/deals/[id]/line-items/[lineItemId]/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/deals/deal-123/line-items/item-123',
    params: { id: 'deal-123', lineItemId: 'item-123' },
    body: {
      description: 'Updated fee',
      unexpected: true,
    },
  },
  {
    name: 'tenant feature override',
    importPath: '../app/api/features/[tenantId]/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/features/tenant-123',
    params: { tenantId: 'tenant-123' },
    body: {
      featureId: 'connectors',
      enabled: true,
      unexpected: true,
    },
  },
  {
    name: 'tenant feature override PATCH',
    importPath: '../app/api/features/[tenantId]/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/features/tenant-123',
    params: { tenantId: 'tenant-123' },
    body: {
      featureId: 'connectors',
      enabled: true,
      unexpected: true,
    },
  },
  {
    name: 'tenant config override PUT',
    importPath: '../app/api/tenant-config/[tenantId]/overrides/route.js',
    method: 'PUT',
    url: 'http://localhost:3003/api/tenant-config/tenant-123/overrides',
    params: { tenantId: 'tenant-123' },
    body: {
      maxConcurrentSessions: 20,
      unexpected: 1,
    },
  },
  {
    name: 'tenant config override POST',
    importPath: '../app/api/tenant-config/[tenantId]/overrides/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/tenant-config/tenant-123/overrides',
    params: { tenantId: 'tenant-123' },
    body: {
      maxConcurrentSessions: 20,
      unexpected: 1,
    },
  },
  {
    name: 'tenant config override DELETE',
    importPath: '../app/api/tenant-config/[tenantId]/overrides/route.js',
    method: 'DELETE',
    url: 'http://localhost:3003/api/tenant-config/tenant-123/overrides',
    params: { tenantId: 'tenant-123' },
    body: {
      keys: ['maxConcurrentSessions'],
      unexpected: true,
    },
  },
  {
    name: 'tenant model provision',
    importPath: '../app/api/tenant-models/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/tenant-models',
    body: {
      targetTenantId: 'tenant-123',
      displayName: 'Custom GPT',
      unexpected: true,
    },
  },
  {
    name: 'tenant model update',
    importPath: '../app/api/tenant-models/[id]/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/tenant-models/model-123',
    params: { id: 'model-123' },
    body: {
      displayName: 'Updated Custom GPT',
      unexpected: true,
    },
  },
  {
    name: 'tenant model connection create',
    importPath: '../app/api/tenant-models/[id]/connections/route.js',
    method: 'POST',
    url: 'http://localhost:3003/api/tenant-models/model-123/connections',
    params: { id: 'model-123' },
    body: {
      credentialName: 'Primary Key',
      apiKey: 'secret-key',
      unexpected: true,
    },
  },
  {
    name: 'tenant feature-toggle proxy',
    importPath: '../app/api/tenants/[tenantId]/feature-toggle/route.js',
    method: 'PATCH',
    url: 'http://localhost:3003/api/tenants/tenant-123/feature-toggle',
    params: { tenantId: 'tenant-123' },
    body: {
      codeToolsEnabled: true,
      unexpected: true,
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildRuntimeHeaders.mockReturnValue({
    Authorization: 'Bearer admin-token',
  });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Admin proxy route body validation', () => {
  test.each(validationCases)(
    '$name rejects unexpected request body fields instead of forwarding them to runtime',
    async ({ body, importPath, method, params, url }) => {
      const routeModule = (await import(importPath)) as Record<
        ValidationCase['method'],
        (
          request: NextRequest,
          routeCtx: { params: Promise<Record<string, string>> },
        ) => Promise<Response>
      >;

      const response = await routeModule[method](makeJsonRequest(url, method, body), {
        params: Promise.resolve(params ?? {}),
      });
      const responseBody = await response.json();

      expect(response.status).toBe(400);
      expect(responseBody).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
        },
      });
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );
});

describe('tenant feature override proxy', () => {
  test.each(['PATCH', 'POST'] as const)(
    '%s forwards catalog feature overrides to the feature entitlement runtime route',
    async (method) => {
      const routeModule = (await import('../app/api/features/[tenantId]/route.js')) as Record<
        typeof method,
        (
          request: NextRequest,
          routeCtx: { params: Promise<Record<string, string>> },
        ) => Promise<Response>
      >;
      const body = { featureId: 'governance', enabled: true };

      const response = await routeModule[method](
        makeJsonRequest('http://localhost:3003/api/features/tenant-123', method, body),
        {
          params: Promise.resolve({ tenantId: 'tenant-123' }),
        },
      );

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/platform/admin/features/tenants/tenant-123/features',
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer admin-token' },
          body: JSON.stringify(body),
        },
      );
    },
  );
});
