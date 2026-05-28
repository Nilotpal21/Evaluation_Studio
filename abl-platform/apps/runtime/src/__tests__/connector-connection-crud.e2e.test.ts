/**
 * Connector Connection CRUD E2E Tests (E2E-1 + E2E-6)
 *
 * Tests the full connection lifecycle via the HTTP API:
 * - E2E-1: CRUD lifecycle (create → list → get → update → test → delete)
 * - E2E-6: Tenant/project isolation and auth enforcement
 *
 * Connections are pure binding records (connectorName + authProfileId).
 * All credential storage is in auth profiles — connections never hold secrets.
 *
 * Uses real Express server with full middleware chain (auth, rate limiting,
 * tenant isolation, Zod validation). No mocks, no direct DB access.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createConnectorE2EBootstrap,
  type ConnectorE2EBootstrap,
} from './helpers/connector-e2e-bootstrap.js';
import {
  authHeaders,
  requestJson,
  uniqueEmail,
  uniqueSlug,
  devLogin,
  createTenant,
  createProject,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

const TIMEOUT = 90_000;

describe('Connector Connection CRUD E2E', () => {
  let bootstrap: ConnectorE2EBootstrap;

  beforeAll(async () => {
    bootstrap = await createConnectorE2EBootstrap();
  }, TIMEOUT);

  afterAll(async () => {
    await bootstrap?.close();
  }, TIMEOUT);

  // ─── E2E-1: Full CRUD Lifecycle ──────────────────────────────────────

  describe('E2E-1: Connection CRUD Lifecycle', () => {
    let connectionId: string;

    test('POST creates a connection binding record', async () => {
      const res = await bootstrap.createConnection({
        connectorName: 'test-connector',
        displayName: 'My Test Connection',
        authProfileId: 'ap-test-1',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.connectorName).toBe('test-connector');
      expect(res.body.data.displayName).toBe('My Test Connection');
      expect(res.body.data.authProfileId).toBe('ap-test-1');
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.scope).toBe('tenant');

      connectionId = res.body.data._id;
      expect(connectionId).toBeDefined();
    });

    test('GET / lists connections', async () => {
      const res = await bootstrap.listConnections();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);

      const conn = res.body.data.find((c: any) => c._id === connectionId);
      expect(conn).toBeDefined();
      expect(conn.connectorName).toBe('test-connector');
      expect(conn.authProfileId).toBe('ap-test-1');
    });

    test('GET /:id returns connection by ID', async () => {
      const res = await bootstrap.getConnection(connectionId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(connectionId);
      expect(res.body.data.connectorName).toBe('test-connector');
      expect(res.body.data.authProfileId).toBe('ap-test-1');
      expect(res.body.data.scope).toBe('tenant');
    });

    test('PUT /:id updates connection displayName', async () => {
      const res = await bootstrap.updateConnection(connectionId, {
        displayName: 'Updated Connection Name',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.displayName).toBe('Updated Connection Name');
      expect(res.body.data._id).toBe(connectionId);
    });

    test('PUT /:id updates connection status', async () => {
      const res = await bootstrap.updateConnection(connectionId, {
        status: 'expired',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('expired');
    });

    test('POST /:id/test returns error when no auth profile resolver', async () => {
      // No auth profile resolver configured in E2E bootstrap, so test
      // should return a failure (VALIDATION_ERROR mapped to 400)
      const res = await bootstrap.testConnection(connectionId);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('DELETE /:id removes the connection', async () => {
      const res = await bootstrap.deleteConnection(connectionId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('GET /:id after DELETE returns 404', async () => {
      const res = await bootstrap.getConnection(connectionId);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ─── Validation ──────────────────────────────────────────────────────

  describe('E2E-1: Input Validation', () => {
    test('POST with missing connectorName returns 400', async () => {
      const res = await bootstrap.post(`/api/projects/${bootstrap.primary.projectId}/connections`, {
        connectorName: '',
        displayName: 'Bad Connection',
        authProfileId: 'ap-test',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('POST with missing authProfileId returns 400', async () => {
      const res = await bootstrap.post(`/api/projects/${bootstrap.primary.projectId}/connections`, {
        connectorName: 'test-connector',
        displayName: 'Bad Connection',
        authProfileId: '',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('POST with missing displayName returns 400', async () => {
      const res = await bootstrap.post(`/api/projects/${bootstrap.primary.projectId}/connections`, {
        connectorName: 'test-connector',
        displayName: '',
        authProfileId: 'ap-test',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── E2E-6: Tenant and Project Isolation ─────────────────────────────

  describe('E2E-6: Tenant/Project Isolation', () => {
    let connectionId: string;
    let otherCtx: BootstrapProjectResult;

    beforeAll(async () => {
      // Create a connection under primary tenant
      const res = await bootstrap.createConnection({
        connectorName: 'test-connector',
        displayName: 'Isolation Test Connection',
        authProfileId: 'ap-isolation-1',
      });
      expect(res.status).toBe(201);
      connectionId = res.body.data._id;

      // Create a second tenant + project
      otherCtx = await bootstrap.createCrossTenantContext();
    }, TIMEOUT);

    test('Cross-tenant GET returns 404 (not 403)', async () => {
      const res = await requestJson(
        bootstrap.harness,
        `/api/projects/${otherCtx.projectId}/connections/${connectionId}`,
        {
          method: 'GET',
          headers: authHeaders(otherCtx.token),
        },
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Cross-tenant PUT returns 404', async () => {
      const res = await requestJson(
        bootstrap.harness,
        `/api/projects/${otherCtx.projectId}/connections/${connectionId}`,
        {
          method: 'PUT',
          headers: authHeaders(otherCtx.token),
          body: { displayName: 'Hacked Name' },
        },
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Cross-tenant DELETE returns 404', async () => {
      const res = await requestJson(
        bootstrap.harness,
        `/api/projects/${otherCtx.projectId}/connections/${connectionId}`,
        {
          method: 'DELETE',
          headers: authHeaders(otherCtx.token),
        },
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Cross-tenant list returns empty (not other tenant data)', async () => {
      const res = await requestJson(
        bootstrap.harness,
        `/api/projects/${otherCtx.projectId}/connections`,
        {
          method: 'GET',
          headers: authHeaders(otherCtx.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    test('No auth token returns 401', async () => {
      const res = await requestJson(
        bootstrap.harness,
        `/api/projects/${bootstrap.primary.projectId}/connections`,
        {
          method: 'GET',
          // No Authorization header
        },
      );

      expect(res.status).toBe(401);
    });
  });

  // ─── Multiple Connections ────────────────────────────────────────────

  describe('E2E-1: Multiple Connections', () => {
    test('can create multiple connections for different connectors', async () => {
      // Use scope: 'user' to avoid unique compound index collision with
      // connections created by prior test suites (same tenant/project/connectorName/scope)
      const res1 = await bootstrap.createConnection({
        connectorName: 'test-connector',
        displayName: 'API Key Connection (User Scope)',
        authProfileId: 'ap-multi-1',
        scope: 'user',
      });
      expect(res1.status).toBe(201);
      expect(res1.body.data.scope).toBe('user');
      expect(res1.body.data.authProfileId).toBe('ap-multi-1');

      const res2 = await bootstrap.createConnection({
        connectorName: 'test-connector-oauth',
        displayName: 'OAuth Connection',
        authProfileId: 'ap-multi-2',
      });
      expect(res2.status).toBe(201);
      expect(res2.body.data.scope).toBe('tenant');
      expect(res2.body.data.authProfileId).toBe('ap-multi-2');

      const list = await bootstrap.listConnections();
      expect(list.status).toBe(200);
      // At least these 2 plus any from prior tests
      expect(list.body.data.length).toBeGreaterThanOrEqual(2);

      const names = list.body.data.map((c: any) => c.connectorName);
      expect(names).toContain('test-connector');
      expect(names).toContain('test-connector-oauth');
    });
  });
});
