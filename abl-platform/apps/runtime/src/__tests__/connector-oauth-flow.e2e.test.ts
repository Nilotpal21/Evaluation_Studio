/**
 * Connector Auth Profile Binding E2E Tests (E2E-4)
 *
 * Tests connection binding lifecycle with auth profile references via the HTTP API:
 * - Create a connection bound to an OAuth auth profile ID
 * - Verify the binding record has correct fields
 * - Test connection (fails gracefully — no auth profile resolver in E2E bootstrap)
 * - List and verify the connection appears correctly
 *
 * Connections are pure binding records (connectorName + authProfileId).
 * All credential storage and OAuth token management is in auth profiles,
 * not in connections. This test validates the binding model works correctly.
 *
 * Uses real Express server with full middleware chain. No mocks, no direct DB access.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createConnectorE2EBootstrap,
  type ConnectorE2EBootstrap,
} from './helpers/connector-e2e-bootstrap.js';

const TIMEOUT = 90_000;

describe('Connector Auth Profile Binding E2E', () => {
  let bootstrap: ConnectorE2EBootstrap;

  beforeAll(async () => {
    bootstrap = await createConnectorE2EBootstrap();
  }, TIMEOUT);

  afterAll(async () => {
    await bootstrap?.close();
  }, TIMEOUT);

  // ─── E2E-4: Auth Profile Binding Lifecycle ────────────────────────────

  describe('E2E-4: OAuth Auth Profile Binding Lifecycle', () => {
    let connectionId: string;

    test('POST creates a connection bound to an OAuth auth profile', async () => {
      const res = await bootstrap.createConnection({
        connectorName: 'test-connector-oauth',
        displayName: 'OAuth Bound Connection',
        authProfileId: 'ap-oauth-test-1',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.connectorName).toBe('test-connector-oauth');
      expect(res.body.data.displayName).toBe('OAuth Bound Connection');
      expect(res.body.data.authProfileId).toBe('ap-oauth-test-1');
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.scope).toBe('tenant');
      connectionId = res.body.data._id;
    });

    test('GET /:id returns binding with auth profile reference', async () => {
      const res = await bootstrap.getConnection(connectionId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(connectionId);
      expect(res.body.data.connectorName).toBe('test-connector-oauth');
      expect(res.body.data.authProfileId).toBe('ap-oauth-test-1');
      expect(res.body.data.status).toBe('active');
    });

    test('POST /:id/test fails gracefully without auth profile resolver', async () => {
      // No auth profile resolver configured in E2E bootstrap —
      // the service returns VALIDATION_ERROR when resolver is missing
      const res = await bootstrap.testConnection(connectionId);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('GET / lists the OAuth-bound connection', async () => {
      const res = await bootstrap.listConnections();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const oauthConn = res.body.data.find((c: any) => c._id === connectionId);
      expect(oauthConn).toBeDefined();
      expect(oauthConn.connectorName).toBe('test-connector-oauth');
      expect(oauthConn.authProfileId).toBe('ap-oauth-test-1');
    });
  });

  // ─── User-Scoped OAuth Binding ───────────────────────────────────────

  describe('E2E-4: User-scoped OAuth binding', () => {
    test('can create a user-scoped connection bound to OAuth auth profile', async () => {
      const res = await bootstrap.createConnection({
        connectorName: 'test-connector-oauth',
        displayName: 'User OAuth Binding',
        authProfileId: 'ap-oauth-user-1',
        scope: 'user',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.scope).toBe('user');
      expect(res.body.data.authProfileId).toBe('ap-oauth-user-1');
      expect(res.body.data.connectorName).toBe('test-connector-oauth');
    });
  });

  // ─── Status Update & Revoke ──────────────────────────────────────────

  describe('E2E-4: Status update & revoke', () => {
    let connectionId: string;

    test('can update connection displayName', async () => {
      const create = await bootstrap.createConnection({
        connectorName: 'test-connector',
        displayName: 'Status Update Test',
        authProfileId: 'ap-status-test-1',
      });
      expect(create.status).toBe(201);
      connectionId = create.body.data._id;

      const update = await bootstrap.updateConnection(connectionId, {
        displayName: 'Renamed Connection',
      });

      expect(update.status).toBe(200);
      expect(update.body.data.displayName).toBe('Renamed Connection');
    });

    test('can revoke connection', async () => {
      const update = await bootstrap.updateConnection(connectionId, {
        status: 'revoked',
      });

      expect(update.status).toBe(200);
      expect(update.body.data.status).toBe('revoked');
    });

    test('revoked connection shows correct status in GET', async () => {
      const res = await bootstrap.getConnection(connectionId);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('revoked');
      expect(res.body.data.authProfileId).toBe('ap-status-test-1');
    });
  });
});
