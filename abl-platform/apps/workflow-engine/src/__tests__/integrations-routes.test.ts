/**
 * Project-scoped Docling toggle routes — integration tests
 * (LLD Phase 2 Task 2.8 + exit criteria).
 *
 * Mounts the real `createIntegrationsRouter` against a stub model and an
 * inline `requireTenantProject` shim that mirrors the production
 * `projectRouter` mount chain. Verifies:
 *
 *   - POST /docling/enable returns 404 FEATURE_DISABLED when the flag is off
 *   - POST /docling/enable upserts the binding and is idempotent
 *   - POST /docling/disable deletes the binding
 *   - GET /docling/quota returns the configured limit (regardless of flag)
 *   - Stable error envelope shape — `{ success: false, error: { code, message } }`
 *
 * No `vi.mock` of platform packages — the route's `connectorConnectionModel`
 * is injected via `createIntegrationsRouter(deps)`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createIntegrationsRouter } from '../routes/integrations.js';

interface FakeConnectorConnection {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  authProfileId: string;
  metadata: Record<string, unknown> | null;
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  updatedAt: Date;
}

let connections = new Map<string, FakeConnectorConnection>();

function keyOf(tenantId: string, projectId: string, connectorName: string): string {
  return `${tenantId}::${projectId}::${connectorName}`;
}

const connectorConnectionModel = {
  findOne: async (filter: Record<string, unknown>) => {
    const key = keyOf(
      filter.tenantId as string,
      filter.projectId as string,
      filter.connectorName as string,
    );
    return connections.get(key) ?? null;
  },
  findOneAndUpdate: async (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    const key = keyOf(
      filter.tenantId as string,
      filter.projectId as string,
      filter.connectorName as string,
    );
    const existing = connections.get(key);
    const set = (update.$set as Record<string, unknown>) ?? {};
    const next: FakeConnectorConnection = {
      _id: existing?._id ?? `conn-${connections.size + 1}`,
      tenantId: filter.tenantId as string,
      projectId: filter.projectId as string,
      connectorName: filter.connectorName as string,
      displayName: (set.displayName as string) ?? existing?.displayName ?? '',
      scope: (set.scope as 'tenant' | 'user') ?? existing?.scope ?? 'tenant',
      authProfileId: (set.authProfileId as string) ?? existing?.authProfileId ?? '',
      metadata: (set.metadata as Record<string, unknown> | null) ?? existing?.metadata ?? null,
      status: (set.status as 'active' | 'expired' | 'revoked') ?? existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    if (existing || options?.upsert) {
      connections.set(key, next);
      return next;
    }
    return null;
  },
  findOneAndDelete: async (filter: Record<string, unknown>) => {
    const key = keyOf(
      filter.tenantId as string,
      filter.projectId as string,
      filter.connectorName as string,
    );
    const existing = connections.get(key);
    if (existing) connections.delete(key);
    return existing ?? null;
  },
};

let server: http.Server;
let baseUrl: string;
let originalFlag: string | undefined;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Mimic the production auth chain: tenantContext is normally set by the
  // shared-auth middleware. For this test the shim attaches a fixed identity
  // so `requireTenantProject` short-circuits to ctx.tenantId / projectId.
  app.use(
    '/api/projects/:projectId/integrations',
    (req: Request, _res: Response, next: NextFunction) => {
      // Cross-tenant tests use an `x-test-tenant-id` header to override the
      // default tenant identity, mimicking the multi-tenant production
      // routing chain. Without the header the request runs as `t-test`.
      const overrideTenant = req.headers['x-test-tenant-id'];
      const tenantId = typeof overrideTenant === 'string' ? overrideTenant : 't-test';
      (req as unknown as { tenantContext: { tenantId: string } }).tenantContext = { tenantId };
      next();
    },
    createIntegrationsRouter({ connectorConnectionModel }),
  );

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  originalFlag = process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (originalFlag === undefined) delete process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;
  else process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = originalFlag;
});

beforeEach(() => {
  connections = new Map();
});

async function post(
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, { headers });
  return { status: r.status, json: await r.json() };
}

describe('integrations router — Docling toggle', () => {
  describe('POST /docling/enable', () => {
    it('returns 404 FEATURE_DISABLED when the flag is off', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'false';
      const resp = await post('/api/projects/p-1/integrations/docling/enable');
      expect(resp.status).toBe(404);
      expect(resp.json).toEqual({
        success: false,
        error: { code: 'FEATURE_DISABLED', message: 'Feature not available' },
      });
      expect(connections.size).toBe(0);
    });

    it('upserts a synthetic no-auth ConnectorConnection when the flag is on', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
      const resp = await post('/api/projects/p-2/integrations/docling/enable');
      expect(resp.status).toBe(200);
      const payload = resp.json as { success: boolean; data: FakeConnectorConnection };
      expect(payload.success).toBe(true);
      expect(payload.data.connectorName).toBe('docling');
      expect(payload.data.authProfileId).toBe('system-docling-none');
      expect(payload.data.metadata).toEqual({ authType: 'none', synthetic: true });
      expect(payload.data.scope).toBe('tenant');
      expect(payload.data.status).toBe('active');
    });

    it('is idempotent — second enable returns the same connection', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
      const first = await post('/api/projects/p-3/integrations/docling/enable');
      const second = await post('/api/projects/p-3/integrations/docling/enable');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(connections.size).toBe(1);
      const firstData = (first.json as { data: FakeConnectorConnection }).data;
      const secondData = (second.json as { data: FakeConnectorConnection }).data;
      expect(firstData._id).toBe(secondData._id);
    });
  });

  describe('POST /docling/disable', () => {
    it('deletes the existing binding and returns { deleted: true }', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
      await post('/api/projects/p-4/integrations/docling/enable');
      expect(connections.size).toBe(1);

      const resp = await post('/api/projects/p-4/integrations/docling/disable');
      expect(resp.status).toBe(200);
      expect(resp.json).toEqual({ success: true, data: { deleted: true } });
      expect(connections.size).toBe(0);
    });

    it('returns 200 even when no binding exists (idempotent delete)', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
      const resp = await post('/api/projects/p-5/integrations/docling/disable');
      expect(resp.status).toBe(200);
      expect(resp.json).toEqual({ success: true, data: { deleted: true } });
    });

    it('returns 404 FEATURE_DISABLED when the flag is off', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'false';
      const resp = await post('/api/projects/p-6/integrations/docling/disable');
      expect(resp.status).toBe(404);
    });
  });

  describe('GET /docling/quota', () => {
    it('returns the configured limit + workspace scope + binding=false (no binding)', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
      const resp = await get('/api/projects/p-7/integrations/docling/quota');
      expect(resp.status).toBe(200);
      const payload = resp.json as {
        success: boolean;
        data: {
          limitPerMinute: number;
          burst: number;
          scope: string;
          enabled: boolean;
          binding: boolean;
        };
      };
      expect(payload.success).toBe(true);
      expect(payload.data.scope).toBe('workspace');
      expect(payload.data.limitPerMinute).toBeGreaterThan(0);
      expect(payload.data.enabled).toBe(true);
      expect(payload.data.binding).toBe(false);
    });

    it('reports enabled=false when the feature flag is off', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'false';
      const resp = await get('/api/projects/p-8/integrations/docling/quota');
      expect(resp.status).toBe(200);
      const payload = resp.json as { data: { enabled: boolean } };
      expect(payload.data.enabled).toBe(false);
    });

    it('reports binding=true after enable, binding=false after disable', async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
      await post('/api/projects/p-9/integrations/docling/enable');
      const afterEnable = await get('/api/projects/p-9/integrations/docling/quota');
      expect((afterEnable.json as { data: { binding: boolean } }).data.binding).toBe(true);

      await post('/api/projects/p-9/integrations/docling/disable');
      const afterDisable = await get('/api/projects/p-9/integrations/docling/quota');
      expect((afterDisable.json as { data: { binding: boolean } }).data.binding).toBe(false);
    });

    it("tenant-isolated: tenant B sees binding=false for tenant A's project (cross-tenant scoping)", async () => {
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
      // Tenant A enables on its project — gets its own row.
      await post(
        '/api/projects/p-shared/integrations/docling/enable',
        {},
        { 'x-test-tenant-id': 't-A' },
      );
      // Tenant B querying the same projectId must see binding=false because
      // the model query is keyed by tenantId.
      const tenantBResp = await get('/api/projects/p-shared/integrations/docling/quota', {
        'x-test-tenant-id': 't-B',
      });
      expect((tenantBResp.json as { data: { binding: boolean } }).data.binding).toBe(false);

      // Tenant A still sees its own binding.
      const tenantAResp = await get('/api/projects/p-shared/integrations/docling/quota', {
        'x-test-tenant-id': 't-A',
      });
      expect((tenantAResp.json as { data: { binding: boolean } }).data.binding).toBe(true);

      // Only one row exists in this scenario — tenant A enabled their own
      // binding; tenant B never enabled. The cross-tenant assertion above
      // proves the per-tenant scoping; the row count just confirms B did
      // not silently create a phantom row when reading the quota.
      expect(connections.size).toBe(1);
    });
  });
});
