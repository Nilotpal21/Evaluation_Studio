/**
 * E2E-6: REST API — Lookup Data CRUD with Auth and Project Isolation
 *
 * Exercises the real runtime server through its HTTP API:
 * - POST /:tableName/entries — bulk upsert
 * - GET /:tableName/entries — paginated list
 * - POST /:tableName/upload — CSV/JSON upload
 * - DELETE /:tableName/entries — delete all
 *
 * Real components (NO mocks):
 * - Express server with full middleware chain (auth, RBAC, validation)
 * - MongoDB Memory Server for data persistence
 * - JWT-based auth via dev-login bootstrap
 *
 * Requires: mongodb-memory-server binary (downloaded on first run)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import { startRuntimeServerHarness } from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  authHeaders,
  requestJson,
  uniqueSlug,
  uniqueEmail,
  type BootstrapProjectResult,
} from '../helpers/channel-e2e-bootstrap.js';

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

let harness: RuntimeApiHarness;
let projectA: BootstrapProjectResult;
let projectB: BootstrapProjectResult;

// ---------------------------------------------------------------------------
// Setup: start real runtime + MongoDB, bootstrap two projects for isolation
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await startRuntimeServerHarness();

  projectA = await bootstrapProject(
    harness,
    uniqueEmail('lookup-e2e-a'),
    uniqueSlug('tenant-a'),
    uniqueSlug('project-a'),
  );

  projectB = await bootstrapProject(
    harness,
    uniqueEmail('lookup-e2e-b'),
    uniqueSlug('tenant-b'),
    uniqueSlug('project-b'),
  );
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.close();
}, SUITE_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lookupPath(projectId: string, tableName: string, suffix: string): string {
  return `/api/projects/${projectId}/lookup-tables/${tableName}/${suffix}`;
}

// ---------------------------------------------------------------------------
// E2E-6: Full CRUD lifecycle
// ---------------------------------------------------------------------------

describe('E2E-6: Lookup Data CRUD', () => {
  const TABLE_NAME = 'colors';

  test(
    'bulk upsert creates entries',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { total: number; upserted: number };
      }>(harness, lookupPath(projectA.projectId, TABLE_NAME, 'entries'), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          entries: [{ value: 'red' }, { value: 'green' }, { value: 'blue' }],
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'list entries returns upserted values',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { entries: Array<{ value: string }>; total: number };
      }>(harness, lookupPath(projectA.projectId, TABLE_NAME, 'entries'), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBe(3);

      const values = res.body.data.entries.map((e) => e.value).sort();
      expect(values).toEqual(['blue', 'green', 'red']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'JSON upload adds more entries',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { total: number; stored: number };
      }>(harness, lookupPath(projectA.projectId, TABLE_NAME, 'upload'), {
        method: 'POST',
        headers: {
          ...authHeaders(projectA.token),
          'Content-Type': 'application/json',
        },
        body: ['yellow', 'purple'],
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'list after upload shows increased count',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { entries: Array<{ value: string }>; total: number };
      }>(harness, lookupPath(projectA.projectId, TABLE_NAME, 'entries'), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'delete all removes entries',
    async () => {
      const delRes = await requestJson<{
        success: boolean;
        data: { deleted: number };
      }>(harness, lookupPath(projectA.projectId, TABLE_NAME, 'entries'), {
        method: 'DELETE',
        headers: authHeaders(projectA.token),
      });

      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);
      expect(delRes.body.data.deleted).toBe(5);

      // Verify empty
      const listRes = await requestJson<{
        success: boolean;
        data: { total: number };
      }>(harness, lookupPath(projectA.projectId, TABLE_NAME, 'entries'), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.total).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Project isolation: projectB cannot see projectA's data
// ---------------------------------------------------------------------------

describe('E2E-6: Project isolation', () => {
  const TABLE_NAME = 'isolation_test';

  test(
    'data in projectA is invisible to projectB',
    async () => {
      // Seed data in projectA
      await requestJson(harness, lookupPath(projectA.projectId, TABLE_NAME, 'entries'), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { entries: [{ value: 'secret' }] },
      });

      // projectB lists same table name — should see 0 entries
      const res = await requestJson<{
        success: boolean;
        data: { total: number };
      }>(harness, lookupPath(projectB.projectId, TABLE_NAME, 'entries'), {
        method: 'GET',
        headers: authHeaders(projectB.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Auth enforcement
// ---------------------------------------------------------------------------

describe('E2E-6: Auth enforcement', () => {
  test(
    'request without auth token returns 401',
    async () => {
      const res = await requestJson(harness, lookupPath(projectA.projectId, 'colors', 'entries'), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'invalid table name returns 400',
    async () => {
      const res = await requestJson(
        harness,
        lookupPath(projectA.projectId, 'INVALID-NAME', 'entries'),
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(400);
    },
    TEST_TIMEOUT_MS,
  );
});
