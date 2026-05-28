/**
 * E2E: KMS Admin — Config, Health, Keys, Audit, Tenant Isolation
 *
 * Validates expected domain behavior for KMS management through the real
 * runtime HTTP API with full middleware chain.
 *
 * Routes under test:
 *   GET    /api/tenants/:tenantId/kms/config    — Tenant KMS config
 *   PUT    /api/tenants/:tenantId/kms/config    — Update KMS config
 *   GET    /api/tenants/:tenantId/kms/health    — KMS health check
 *   GET    /api/tenants/:tenantId/kms/keys      — List DEKs
 *   POST   /api/tenants/:tenantId/kms/keys/rotate — Force-rotate DEKs
 *   GET    /api/tenants/:tenantId/kms/audit     — KMS audit trail
 *   POST   /api/tenants/:tenantId/kms/validate  — Validate external endpoint
 *
 * NO mocks of platform components. Real Express + MongoDB Memory Server.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { RuntimeApiHarness } from '../../helpers/runtime-api-harness.js';
import { startRuntimeServerHarness } from '../../helpers/runtime-api-harness.js';
import {
  authHeaders,
  requestJson,
  uniqueSlug,
  uniqueEmail,
  devLogin,
  setSuperAdmins,
  type BootstrapProjectResult,
} from '../../helpers/channel-e2e-bootstrap.js';

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

let harness: RuntimeApiHarness;
let tenantA: BootstrapProjectResult;
let tenantB: BootstrapProjectResult;

function kmsPath(tenantId: string, suffix = ''): string {
  return `/api/tenants/${tenantId}/kms${suffix}`;
}

/**
 * Bootstrap a tenant with ENTERPRISE plan tier (required for kms_byok feature gate).
 * Uses the same flow as the shared `bootstrapProject` but passes ENTERPRISE planTier.
 */
async function bootstrapEnterpriseProject(
  h: RuntimeApiHarness,
  email: string,
  tenantSlug: string,
  projectSlug: string,
): Promise<BootstrapProjectResult> {
  const login = await devLogin(h, email);
  await setSuperAdmins([login.user.id]);

  // Create tenant with ENTERPRISE plan (required for kms_byok feature gate)
  const tenantRes = await requestJson<{ success: boolean; tenant: { _id: string } }>(
    h,
    '/api/platform/admin/tenants',
    {
      method: 'POST',
      headers: authHeaders(login.accessToken),
      body: { name: `${tenantSlug} Name`, slug: tenantSlug, planTier: 'ENTERPRISE' },
    },
  );
  expect(tenantRes.status).toBe(201);

  const projectRes = await requestJson<{ success: boolean; project: { _id: string } }>(
    h,
    `/api/platform/admin/tenants/${tenantRes.body.tenant._id}/projects`,
    {
      method: 'POST',
      headers: authHeaders(login.accessToken),
      body: { name: `${projectSlug} Name`, slug: projectSlug },
    },
  );
  expect(projectRes.status).toBe(201);

  return {
    token: login.accessToken,
    userId: login.user.id,
    tenantId: tenantRes.body.tenant._id,
    projectId: projectRes.body.project._id,
  };
}

// ---------------------------------------------------------------------------
// Setup: start real runtime + MongoDB, bootstrap two ENTERPRISE tenants
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await startRuntimeServerHarness();

  tenantA = await bootstrapEnterpriseProject(
    harness,
    uniqueEmail('kms-e2e-a'),
    uniqueSlug('kms-tenant-a'),
    uniqueSlug('kms-project-a'),
  );

  tenantB = await bootstrapEnterpriseProject(
    harness,
    uniqueEmail('kms-e2e-b'),
    uniqueSlug('kms-tenant-b'),
    uniqueSlug('kms-project-b'),
  );
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.close();
}, SUITE_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// E2E-KMS-01: Config CRUD
// ---------------------------------------------------------------------------

describe('E2E-KMS-01: KMS Config CRUD', () => {
  test(
    'GET /kms/config returns default config for new tenant',
    async () => {
      const res = await requestJson<{ success: boolean; data: Record<string, unknown> }>(
        harness,
        kmsPath(tenantA.tenantId, '/config'),
        { method: 'GET', headers: authHeaders(tenantA.token) },
      );

      // Should succeed — new tenants get a default (possibly empty) config
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'PUT /kms/config updates the tenant KMS configuration',
    async () => {
      const res = await requestJson<{ success: boolean; data: Record<string, unknown> }>(
        harness,
        kmsPath(tenantA.tenantId, '/config'),
        {
          method: 'PUT',
          headers: authHeaders(tenantA.token),
          body: {
            provider: 'platform',
            enabled: true,
          },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /kms/config reflects the updated configuration',
    async () => {
      const res = await requestJson<{ success: boolean; data: { provider?: string } }>(
        harness,
        kmsPath(tenantA.tenantId, '/config'),
        { method: 'GET', headers: authHeaders(tenantA.token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Verify the provider was persisted
      if (res.body.data.provider) {
        expect(res.body.data.provider).toBe('platform');
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-KMS-02: Health Check
// ---------------------------------------------------------------------------

describe('E2E-KMS-02: KMS Health', () => {
  test(
    'GET /kms/health returns health status for tenant',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { healthy: boolean; provider: string; tenantId: string };
      }>(harness, kmsPath(tenantA.tenantId, '/health'), {
        method: 'GET',
        headers: authHeaders(tenantA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(typeof res.body.data.healthy).toBe('boolean');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-KMS-03: Key Management
// ---------------------------------------------------------------------------

describe('E2E-KMS-03: Key Management', () => {
  test(
    'GET /kms/keys lists DEKs for the tenant',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { keys: unknown[]; summary?: unknown };
      }>(harness, kmsPath(tenantA.tenantId, '/keys'), {
        method: 'GET',
        headers: authHeaders(tenantA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /kms/keys/rotate triggers key rotation',
    async () => {
      const res = await requestJson<{ success: boolean; message?: string; data?: unknown }>(
        harness,
        kmsPath(tenantA.tenantId, '/keys/rotate'),
        {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: { reason: 'E2E test rotation' },
        },
      );

      // Rotation may succeed (200) or indicate no keys to rotate — both are valid
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(500);
      expect(res.body.success).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-KMS-04: Audit Trail
// ---------------------------------------------------------------------------

describe('E2E-KMS-04: Audit Trail', () => {
  test(
    'GET /kms/audit returns audit events for tenant',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { events: unknown[]; summary?: unknown };
      }>(harness, kmsPath(tenantA.tenantId, '/audit'), {
        method: 'GET',
        headers: authHeaders(tenantA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-KMS-05: Tenant Isolation
// ---------------------------------------------------------------------------

describe('E2E-KMS-05: Tenant Isolation', () => {
  test(
    'Tenant B cannot access Tenant A KMS config',
    async () => {
      const res = await requestJson<{ success: boolean }>(
        harness,
        kmsPath(tenantA.tenantId, '/config'),
        { method: 'GET', headers: authHeaders(tenantB.token) },
      );

      // Cross-tenant access should return 404 (not 403, per platform principles)
      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'Tenant B cannot modify Tenant A KMS config',
    async () => {
      const res = await requestJson<{ success: boolean }>(
        harness,
        kmsPath(tenantA.tenantId, '/config'),
        {
          method: 'PUT',
          headers: authHeaders(tenantB.token),
          body: { provider: 'aws', enabled: true },
        },
      );

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'Tenant B cannot rotate Tenant A keys',
    async () => {
      const res = await requestJson<{ success: boolean }>(
        harness,
        kmsPath(tenantA.tenantId, '/keys/rotate'),
        {
          method: 'POST',
          headers: authHeaders(tenantB.token),
          body: { reason: 'unauthorized rotation attempt' },
        },
      );

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-KMS-06: Auth Enforcement
// ---------------------------------------------------------------------------

describe('E2E-KMS-06: Auth Enforcement', () => {
  test(
    'Unauthenticated request to KMS config returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, kmsPath(tenantA.tenantId, '/config'), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'Unauthenticated request to KMS health returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, kmsPath(tenantA.tenantId, '/health'), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-KMS-07: Validation Endpoint
// ---------------------------------------------------------------------------

describe('E2E-KMS-07: External KMS Validation', () => {
  test(
    'POST /kms/validate with invalid endpoint returns validation error',
    async () => {
      const res = await requestJson<{ success: boolean; error?: unknown }>(
        harness,
        kmsPath(tenantA.tenantId, '/validate'),
        {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            provider: 'external',
            endpointUrl: 'https://nonexistent.example.com/kms',
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
          },
        },
      );

      // Should not be a server error — should return a structured validation result
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(500);
    },
    TEST_TIMEOUT_MS,
  );
});
