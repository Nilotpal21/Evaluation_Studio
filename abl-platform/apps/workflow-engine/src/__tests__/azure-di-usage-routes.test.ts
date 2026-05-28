/**
 * Azure DI usage routes — integration tests (LLD §3 Phase 3 Task 3.11).
 *
 * Mounts the real `createAzureDIUsageRouter` against a stub model + a
 * `requireTenantProject` shim that mirrors the production projectRouter chain.
 *
 * Verifies:
 *   - GET /usage returns 404 FEATURE_DISABLED when the flag is off
 *   - GET /usage returns the snapshot when the binding exists
 *   - GET /usage 404 CONNECTION_NOT_FOUND when the binding is absent
 *   - PATCH /usage-caps writes both soft + hard caps idempotently
 *   - PATCH /usage-caps with `usageHardCap: null` clears the cap
 *   - Cross-tenant: tenant B cannot read tenant A's snapshot
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAzureDIUsageRouter } from '../routes/azure-di-usage.js';

interface FakeAzureDIConnection {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  authProfileId: string;
  status: 'active' | 'expired' | 'revoked';
  usageCount?: number;
  usagePeriodStart?: Date;
  usageSoftCap?: number | null;
  usageHardCap?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

let connections = new Map<string, FakeAzureDIConnection>();

function keyOf(tenantId: string, projectId: string): string {
  return `${tenantId}::${projectId}::azure-document-intelligence`;
}

const connectorConnectionModel = {
  findOne: async (filter: Record<string, unknown>) => {
    return connections.get(keyOf(filter.tenantId as string, filter.projectId as string)) ?? null;
  },
  findOneAndUpdate: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const key = keyOf(filter.tenantId as string, filter.projectId as string);
    const existing = connections.get(key);
    if (!existing) return null;
    const set = (update.$set as Record<string, unknown>) ?? {};
    const next: FakeAzureDIConnection = {
      ...existing,
      ...(set.usageSoftCap !== undefined
        ? { usageSoftCap: set.usageSoftCap as number | null }
        : {}),
      ...(set.usageHardCap !== undefined
        ? { usageHardCap: set.usageHardCap as number | null }
        : {}),
      updatedAt: new Date(),
    };
    connections.set(key, next);
    return next;
  },
};

let server: http.Server;
let baseUrl: string;
let originalFlag: string | undefined;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  app.use(
    '/api/projects/:projectId/integrations',
    (req: Request, _res: Response, next: NextFunction) => {
      const overrideTenant = req.headers['x-test-tenant-id'];
      const tenantId = typeof overrideTenant === 'string' ? overrideTenant : 't-test';
      (req as unknown as { tenantContext: { tenantId: string } }).tenantContext = { tenantId };
      next();
    },
    createAzureDIUsageRouter({ connectorConnectionModel }),
  );

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  originalFlag = process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalFlag === undefined) {
    delete process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;
  } else {
    process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = originalFlag;
  }
});

beforeEach(() => {
  connections = new Map();
});

function setFlag(value: 'true' | 'false') {
  process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = value;
}

function seedBinding(opts: {
  tenantId?: string;
  projectId?: string;
  usageCount?: number;
  usageSoftCap?: number | null;
  usageHardCap?: number | null;
}): FakeAzureDIConnection {
  const tenantId = opts.tenantId ?? 't-test';
  const projectId = opts.projectId ?? 'p-1';
  const doc: FakeAzureDIConnection = {
    _id: `c-${connections.size + 1}`,
    tenantId,
    projectId,
    connectorName: 'azure-document-intelligence',
    displayName: 'Azure DI',
    scope: 'tenant',
    authProfileId: 'ap-1',
    status: 'active',
    ...(opts.usageCount !== undefined ? { usageCount: opts.usageCount } : {}),
    ...(opts.usageSoftCap !== undefined ? { usageSoftCap: opts.usageSoftCap } : {}),
    ...(opts.usageHardCap !== undefined ? { usageHardCap: opts.usageHardCap } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  connections.set(keyOf(tenantId, projectId), doc);
  return doc;
}

async function request(
  method: 'GET' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: resp.status, body: await resp.json() };
}

describe('Azure DI Usage Routes', () => {
  describe('GET /usage', () => {
    it('returns 404 FEATURE_DISABLED when the flag is off', async () => {
      setFlag('false');
      const r = await request(
        'GET',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage',
      );
      expect(r.status).toBe(404);
      expect((r.body as { error: { code: string } }).error.code).toBe('FEATURE_DISABLED');
    });

    it('returns 404 CONNECTION_NOT_FOUND when no binding exists', async () => {
      setFlag('true');
      const r = await request(
        'GET',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage',
      );
      expect(r.status).toBe(404);
      expect((r.body as { error: { code: string } }).error.code).toBe('CONNECTION_NOT_FOUND');
    });

    it('returns the usage snapshot when the binding exists', async () => {
      setFlag('true');
      const periodStart = new Date('2026-05-01T00:00:00.000Z');
      const seeded = seedBinding({
        usageCount: 17,
        usageSoftCap: 100,
        usageHardCap: 250,
      });
      seeded.usagePeriodStart = periodStart;
      const r = await request(
        'GET',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage',
      );
      expect(r.status).toBe(200);
      const data = (
        r.body as {
          data: { usageCount: number; usageSoftCap: number | null; usageHardCap: number | null };
        }
      ).data;
      expect(data.usageCount).toBe(17);
      expect(data.usageSoftCap).toBe(100);
      expect(data.usageHardCap).toBe(250);
    });

    it('isolates tenants — tenant B cannot read tenant A snapshot', async () => {
      setFlag('true');
      seedBinding({
        tenantId: 't-A',
        projectId: 'p-1',
        usageCount: 5,
        usageHardCap: 50,
      });
      const r = await request(
        'GET',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage',
        undefined,
        { 'x-test-tenant-id': 't-B' },
      );
      expect(r.status).toBe(404);
      expect((r.body as { error: { code: string } }).error.code).toBe('CONNECTION_NOT_FOUND');
    });
  });

  describe('PATCH /usage-caps', () => {
    it('returns 404 FEATURE_DISABLED when the flag is off', async () => {
      setFlag('false');
      const r = await request(
        'PATCH',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage-caps',
        { usageHardCap: 100 },
      );
      expect(r.status).toBe(404);
      expect((r.body as { error: { code: string } }).error.code).toBe('FEATURE_DISABLED');
    });

    it('updates soft + hard caps idempotently', async () => {
      setFlag('true');
      seedBinding({ usageCount: 0 });
      const r1 = await request(
        'PATCH',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage-caps',
        { usageSoftCap: 80, usageHardCap: 100 },
      );
      expect(r1.status).toBe(200);
      const data1 = (r1.body as { data: { usageSoftCap: number; usageHardCap: number } }).data;
      expect(data1.usageSoftCap).toBe(80);
      expect(data1.usageHardCap).toBe(100);

      // Idempotent re-apply.
      const r2 = await request(
        'PATCH',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage-caps',
        { usageSoftCap: 80, usageHardCap: 100 },
      );
      expect(r2.status).toBe(200);
      const data2 = (r2.body as { data: { usageSoftCap: number; usageHardCap: number } }).data;
      expect(data2.usageSoftCap).toBe(80);
      expect(data2.usageHardCap).toBe(100);
    });

    it('explicitly clears usageHardCap with null', async () => {
      setFlag('true');
      seedBinding({ usageHardCap: 200 });
      const r = await request(
        'PATCH',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage-caps',
        { usageHardCap: null },
      );
      expect(r.status).toBe(200);
      expect((r.body as { data: { usageHardCap: number | null } }).data.usageHardCap).toBe(null);
    });

    it('rejects an empty patch body', async () => {
      setFlag('true');
      seedBinding({});
      const r = await request(
        'PATCH',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage-caps',
        {},
      );
      expect(r.status).toBe(400);
      expect((r.body as { error: { code: string } }).error.code).toBe('INVALID_BODY');
    });

    it('rejects negative caps', async () => {
      setFlag('true');
      seedBinding({});
      const r = await request(
        'PATCH',
        '/api/projects/p-1/integrations/azure-document-intelligence/usage-caps',
        { usageSoftCap: -1 },
      );
      expect(r.status).toBe(400);
      expect((r.body as { error: { code: string } }).error.code).toBe('INVALID_BODY');
    });
  });
});
