/**
 * Document-extraction rollback drill — Phase 4 task 4.8 / LLD §1 D-15.
 *
 * The full operational drill (in-flight + pending + restart) is a manual
 * staging exercise documented in `docs/sdlc-logs/document-extraction-integrations/dashboard.md`.
 * THIS test asserts the rollback invariants that are unit-/integration-testable
 * inside the engine codebase:
 *
 *   1. Flag OFF → `azure-di-usage` PATCH/GET return 404 FEATURE_DISABLED (route gate).
 *   2. Flag OFF → connector loader skips Azure DI + workflow-docling registration
 *      (loader gate at `packages/connectors/src/loader.ts:50-117`).
 *   3. Flag OFF → the workflow-callback route still resolves in-flight callbacks
 *      with valid HMAC (the route does NOT gate on the flag — in-flight steps
 *      must complete during rollback).
 *
 * The connector loader assertion uses `process.env` mutation and a fresh import
 * via `vi.resetModules()` so the gate is evaluated against the test's env.
 * No platform mocks — only env-driven gates and live route execution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAzureDIUsageRouter } from '../routes/azure-di-usage.js';
import { createCallbackRouter } from '../routes/workflow-callbacks.js';
import { buildSignatureHeaders } from '@agent-platform/shared-kernel/security';

interface FakeConnection {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  status: 'active' | 'revoked';
  usageCount?: number;
  usageSoftCap?: number | null;
  usageHardCap?: number | null;
}

let connections: Map<string, FakeConnection> = new Map();
function matchesFilter(c: FakeConnection, filter: Record<string, unknown>): boolean {
  if (filter._id !== undefined && c._id !== filter._id) return false;
  if (filter.tenantId !== undefined && c.tenantId !== filter.tenantId) return false;
  if (filter.projectId !== undefined && c.projectId !== filter.projectId) return false;
  if (filter.connectorName !== undefined && c.connectorName !== filter.connectorName) return false;
  return true;
}
const connectorConnectionModel = {
  findOne: (filter: Record<string, unknown>): Promise<FakeConnection | null> => {
    for (const c of connections.values()) {
      if (matchesFilter(c, filter)) return Promise.resolve(c);
    }
    return Promise.resolve(null);
  },
  findOneAndUpdate: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<FakeConnection | null> => {
    const conn = Array.from(connections.values()).find((c) => matchesFilter(c, filter));
    if (!conn) return Promise.resolve(null);
    const set = (update.$set ?? {}) as Partial<FakeConnection>;
    Object.assign(conn, set);
    return Promise.resolve(conn);
  },
} as unknown as Parameters<typeof createAzureDIUsageRouter>[0]['connectorConnectionModel'];

const SHIM_TENANT = 'tenant-rollback';
const SHIM_PROJECT = 'project-rollback';

function tenantProjectShim(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { tenantContext?: unknown }).tenantContext = {
    tenantId: SHIM_TENANT,
  };
  next();
}

describe('document-extraction rollback drill (Phase 4 task 4.8)', () => {
  beforeEach(() => {
    connections = new Map();
    connections.set('conn-1', {
      _id: 'conn-1',
      tenantId: SHIM_TENANT,
      projectId: SHIM_PROJECT,
      connectorName: 'azure-document-intelligence',
      status: 'active',
      usageCount: 0,
      usageHardCap: null,
      usageSoftCap: null,
    });
  });

  afterEach(() => {
    delete process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;
    vi.resetModules();
  });

  it('flag OFF — azure-di-usage GET returns 404 FEATURE_DISABLED', async () => {
    delete process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;

    const app = express();
    app.use(express.json());
    app.use(tenantProjectShim);
    app.use(
      `/api/projects/:projectId/integrations`,
      createAzureDIUsageRouter({ connectorConnectionModel }),
    );

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(
        `http://localhost:${port}/api/projects/${SHIM_PROJECT}/integrations/azure-document-intelligence/usage`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FEATURE_DISABLED');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('flag OFF — azure-di-usage PATCH (raising hard cap) returns 404 FEATURE_DISABLED', async () => {
    delete process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;

    const app = express();
    app.use(express.json());
    app.use(tenantProjectShim);
    app.use(
      `/api/projects/:projectId/integrations`,
      createAzureDIUsageRouter({ connectorConnectionModel }),
    );

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(
        `http://localhost:${port}/api/projects/${SHIM_PROJECT}/integrations/azure-document-intelligence/usage-caps`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usageHardCap: 1000 }),
        },
      );
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('flag ON — azure-di-usage GET returns binding for an active connection', async () => {
    process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';

    const app = express();
    app.use(express.json());
    app.use(tenantProjectShim);
    app.use(
      `/api/projects/:projectId/integrations`,
      createAzureDIUsageRouter({ connectorConnectionModel }),
    );

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(
        `http://localhost:${port}/api/projects/${SHIM_PROJECT}/integrations/azure-document-intelligence/usage`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { usageCount: number } };
      expect(body.success).toBe(true);
      expect(body.data.usageCount).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('flag OFF — in-flight callbacks still resolve with valid HMAC (no gating on the callback route)', async () => {
    // This is the rollback invariant: existing waiting_callback steps must
    // be able to complete during/after rollback. The flag gates registration
    // and route exposure, NOT the callback route. The callback route is
    // mounted in the unauthenticated section so workers can post regardless.
    delete process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;

    const SECRET = 'whsec_rollback_in_flight_test_secret';
    const EXECUTION_ID = 'exec-rollback-1';
    const STEP_ID = 'step-extract';

    const executionModel = {
      findOne: (filter: Record<string, unknown>) => {
        if (filter._id !== EXECUTION_ID) return Promise.resolve(null);
        return Promise.resolve({
          _id: EXECUTION_ID,
          tenantId: SHIM_TENANT,
          context: {
            steps: {
              [STEP_ID]: {
                status: 'waiting_callback',
                stepId: STEP_ID,
                callbackSecret: 'enc::' + SECRET,
              },
            },
          },
        });
      },
    } as unknown as Parameters<typeof createCallbackRouter>[0]['executionModel'];

    const resolveCalls: Array<{ executionId: string; stepId: string }> = [];
    const restateClient = {
      resolveCallback: async (executionId: string, stepId: string, _payload: unknown) => {
        resolveCalls.push({ executionId, stepId });
      },
    } as unknown as Parameters<typeof createCallbackRouter>[0]['restateClient'];

    const decryptSecret = async (encrypted: string, _t: string): Promise<string> =>
      encrypted.startsWith('enc::') ? encrypted.slice(5) : encrypted;

    const app = express();
    // Capture rawBody BEFORE the router — workflow-callbacks reads req.rawBody
    // for HMAC verification.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        (req as unknown as { rawBody: Buffer }).rawBody = raw;
        try {
          req.body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          req.body = {};
        }
        next();
      });
    });
    const router = createCallbackRouter({ executionModel, restateClient, decryptSecret });
    app.use(router);

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ status: 'success', envelope: { content: 'OK' } });
      const headers = buildSignatureHeaders(SECRET, body);

      const res = await fetch(`http://localhost:${port}/${EXECUTION_ID}/${STEP_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
      expect(resolveCalls).toHaveLength(1);
      expect(resolveCalls[0]).toEqual({ executionId: EXECUTION_ID, stepId: STEP_ID });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('flag OFF — connector loader still registers Azure DI / Docling (env-flag gate removed)', async () => {
    // The env-flag gate on connector registration was removed in 8633842af — Docling and ADI
    // are now always registered regardless of WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED.
    // The flag still gates the BullMQ queue wiring and route mounting in workflow-engine/index.ts.
    delete process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED;
    vi.resetModules();
    const { loadConnectors, ConnectorRegistry } = await import('@agent-platform/connectors');
    const registry = new ConnectorRegistry();
    await loadConnectors(registry);
    expect(registry.has('azure-document-intelligence')).toBe(true);
    expect(registry.has('docling')).toBe(true);
    expect(registry.has('http')).toBe(true);
  });

  it('flag ON — connector loader DOES register Azure DI + Docling', async () => {
    process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = 'true';
    vi.resetModules();
    const { loadConnectors, ConnectorRegistry } = await import('@agent-platform/connectors');
    const registry = new ConnectorRegistry();
    await loadConnectors(registry);
    expect(registry.has('azure-document-intelligence')).toBe(true);
    expect(registry.has('docling')).toBe(true);
    expect(registry.has('http')).toBe(true);
  });
});
