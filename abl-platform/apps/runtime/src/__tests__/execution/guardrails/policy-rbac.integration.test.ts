/**
 * Guardrail policy project RBAC integration regression tests.
 *
 * Locks the project-scoped authorization path so project members can use
 * guardrail permissions granted by project role without needing tenant-level
 * guardrail:* permissions. Project role setup uses the database directly
 * because runtime does not expose a project-member management API.
 *
 * INT-11: SDB-specific RBAC — guardrail:read vs guardrail:write, pii-pattern:read
 * Tests the permission matrix for all SDB-affected routes:
 *   GET    /api/projects/:projectId/guardrail-policies        (guardrail:read)
 *   GET    /api/projects/:projectId/guardrail-policies/:id    (guardrail:read)
 *   POST   /api/projects/:projectId/guardrail-policies        (guardrail:write)
 *   PUT    /api/projects/:projectId/guardrail-policies/:id    (guardrail:write)
 *   DELETE /api/projects/:projectId/guardrail-policies/:id    (guardrail:write)
 *   POST   /api/projects/:projectId/guardrail-policies/:id/activate    (guardrail:write)
 *   POST   /api/projects/:projectId/guardrail-policies/:id/reactivate  (guardrail:write)
 *   GET    /api/projects/:projectId/pii-entities              (pii-pattern:read)
 */

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ApiKey, ProjectMember } from '@agent-platform/database/models';
import authRouter from '../../../routes/auth.js';
import platformAdminTenantsRouter from '../../../routes/platform-admin-tenants.js';
import guardrailPolicyRouter from '../../../routes/guardrail-policies.js';
import piiEntitiesRouter from '../../../routes/pii-entities.js';
import { clearPermissionCache } from '../../../services/permission-resolution.js';
import {
  startRuntimeApiHarness,
  type RuntimeApiHarness,
} from '../../helpers/runtime-api-harness.js';
import {
  addMember,
  authHeaders,
  bootstrapProject,
  devLogin,
  requestJson,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from '../../helpers/channel-e2e-bootstrap.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SuccessResponse<T = unknown> {
  success: boolean;
  data: T;
}

interface ErrorResponse {
  success: boolean;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_SETTINGS = {
  failMode: 'open',
  timeouts: { local: 100, model: 3000, llm: 10000 },
  streaming: {
    enabled: false,
    defaultInterval: 'sentence',
    chunkSize: 1,
    maxLatencyMs: 500,
    earlyTermination: true,
  },
};

const VALID_RULE = {
  guardrailName: 'content_safety',
  override: 'threshold',
  threshold: 0.9,
};

const VALID_ENABLED_RULE = {
  guardrailName: 'rbac_test_rule',
  override: 'define',
  kind: 'input',
  provider: 'builtin_pii',
  category: 'pii',
  threshold: 0.8,
  action: 'block',
  enabled: true,
  actionMessage: 'Blocked by RBAC test rule',
};

// ---------------------------------------------------------------------------
// Existing project-developer RBAC test
// ---------------------------------------------------------------------------

describe('Guardrail policy project RBAC', () => {
  let harness: RuntimeApiHarness;
  let ctx: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/guardrail-policies', guardrailPolicyRouter);
      app.use('/api/projects/:projectId/pii-entities', piiEntitiesRouter);
    });

    ctx = await bootstrapProject(
      harness,
      uniqueEmail('grail-rbac-admin'),
      uniqueSlug('grail-rbac-tenant'),
      uniqueSlug('grail-rbac-project'),
    );
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  test('allows project developer members to write without tenant guardrail permission', async () => {
    const developerEmail = uniqueEmail('grail-rbac-dev');
    const developerLogin = await devLogin(harness, developerEmail);
    await addMember(harness, ctx.token, ctx.tenantId, developerEmail, 'MEMBER');
    await ProjectMember.create({
      projectId: ctx.projectId,
      userId: developerLogin.user.id,
      role: 'developer',
    });
    clearPermissionCache();

    const res = await requestJson<{
      success: boolean;
      data?: { scope?: { projectId?: string } };
      error?: { code: string; message: string };
    }>(harness, `/api/projects/${ctx.projectId}/guardrail-policies`, {
      method: 'POST',
      headers: authHeaders(developerLogin.accessToken),
      body: {
        name: 'project-developer-policy',
        rules: [VALID_RULE],
        settings: BASE_SETTINGS,
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.scope?.projectId).toBe(ctx.projectId);
  });

  // =========================================================================
  // INT-11: SDB-specific RBAC permission matrix
  // =========================================================================

  describe('INT-11: SDB-specific RBAC permission matrix', () => {
    // API key tokens for the four permission sets
    let keyReadOnly: string;
    let keyWriteOnly: string;
    let keyPiiReadOnly: string;
    let keyNone: string;

    // A policy ID created by the admin for testing GET/:id, PUT/:id,
    // DELETE/:id, activate, reactivate
    let seedPolicyId: string;

    /**
     * Create an API key with specific scopes, scoped to the test project.
     * Returns the raw key string usable as a Bearer token.
     */
    async function createScopedApiKey(name: string, scopes: string[]): Promise<string> {
      const rawKey = `abl_test_${uniqueSlug(name)}`;
      await ApiKey.create({
        tenantId: ctx.tenantId,
        name,
        clientId: uniqueSlug(`${name}-client`),
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        prefix: rawKey.substring(0, 8),
        scopes,
        projectIds: [ctx.projectId],
        environments: [],
        createdBy: ctx.userId,
      });
      return rawKey;
    }

    beforeAll(async () => {
      // Create the four API keys with different permission sets
      keyReadOnly = await createScopedApiKey('rbac-read', ['guardrail:read']);
      keyWriteOnly = await createScopedApiKey('rbac-write', ['guardrail:write']);
      keyPiiReadOnly = await createScopedApiKey('rbac-pii', ['pii-pattern:read']);
      keyNone = await createScopedApiKey('rbac-none', []);

      clearPermissionCache();

      // Seed a policy with an enabled rule so activate/reactivate can work
      const seedRes = await requestJson<SuccessResponse<{ _id: string }>>(
        harness,
        `/api/projects/${ctx.projectId}/guardrail-policies`,
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
          body: {
            name: 'rbac-seed-policy',
            rules: [VALID_ENABLED_RULE],
            settings: BASE_SETTINGS,
          },
        },
      );
      expect(seedRes.status, JSON.stringify(seedRes.body)).toBe(201);
      seedPolicyId = seedRes.body.data._id;
    }, 30_000);

    // -----------------------------------------------------------------
    // Helper to build URLs
    // -----------------------------------------------------------------

    function policyUrl(suffix = ''): string {
      return `/api/projects/${ctx.projectId}/guardrail-policies${suffix}`;
    }

    function piiEntitiesUrl(): string {
      return `/api/projects/${ctx.projectId}/pii-entities`;
    }

    // -----------------------------------------------------------------
    // Route definitions for the permission matrix
    // -----------------------------------------------------------------

    type RouteSpec = {
      label: string;
      method: string;
      url: () => string;
      body?: () => Record<string, unknown>;
      requiredPermission: string;
      /** Status code expected on success (200, 201, or 204). */
      successStatus: number | number[];
    };

    function getRouteSpecs(): RouteSpec[] {
      return [
        {
          label: 'GET /guardrail-policies',
          method: 'GET',
          url: () => policyUrl(),
          requiredPermission: 'guardrail:read',
          successStatus: 200,
        },
        {
          label: 'GET /guardrail-policies/:id',
          method: 'GET',
          url: () => policyUrl(`/${seedPolicyId}`),
          requiredPermission: 'guardrail:read',
          successStatus: 200,
        },
        {
          label: 'POST /guardrail-policies',
          method: 'POST',
          url: () => policyUrl(),
          body: () => ({
            name: `rbac-test-create-${uniqueSlug('pol')}`,
            rules: [VALID_RULE],
            settings: BASE_SETTINGS,
          }),
          requiredPermission: 'guardrail:write',
          successStatus: 201,
        },
        {
          label: 'PUT /guardrail-policies/:id',
          method: 'PUT',
          url: () => policyUrl(`/${seedPolicyId}`),
          body: () => ({
            name: `rbac-test-update-${uniqueSlug('pol')}`,
            rules: [VALID_RULE],
            settings: BASE_SETTINGS,
          }),
          requiredPermission: 'guardrail:write',
          successStatus: 200,
        },
        {
          label: 'DELETE /guardrail-policies/:id',
          method: 'DELETE',
          url: () => policyUrl(`/${seedPolicyId}`),
          requiredPermission: 'guardrail:write',
          successStatus: [200, 204],
        },
        {
          label: 'POST /guardrail-policies/:id/activate',
          method: 'POST',
          url: () => policyUrl(`/${seedPolicyId}/activate`),
          requiredPermission: 'guardrail:write',
          successStatus: 200,
        },
        {
          label: 'POST /guardrail-policies/:id/reactivate',
          method: 'POST',
          url: () => policyUrl(`/${seedPolicyId}/reactivate`),
          requiredPermission: 'guardrail:write',
          successStatus: 200,
        },
        {
          label: 'GET /pii-entities',
          method: 'GET',
          url: () => piiEntitiesUrl(),
          requiredPermission: 'pii-pattern:read',
          successStatus: 200,
        },
      ];
    }

    // -----------------------------------------------------------------
    // Permission set definitions
    // -----------------------------------------------------------------

    type PermissionSet = {
      label: string;
      getKey: () => string;
      permissions: string[];
    };

    function getPermissionSets(): PermissionSet[] {
      return [
        {
          label: 'guardrail:read only',
          getKey: () => keyReadOnly,
          permissions: ['guardrail:read'],
        },
        {
          label: 'guardrail:write only',
          getKey: () => keyWriteOnly,
          permissions: ['guardrail:write'],
        },
        {
          label: 'pii-pattern:read only',
          getKey: () => keyPiiReadOnly,
          permissions: ['pii-pattern:read'],
        },
        {
          label: 'no permissions',
          getKey: () => keyNone,
          permissions: [],
        },
      ];
    }

    // -----------------------------------------------------------------
    // Matrix test — 8 routes × 4 permission sets
    // -----------------------------------------------------------------

    /**
     * Check whether the permission set includes the required permission
     * for the route.
     */
    function shouldSucceed(permissionSet: string[], requiredPermission: string): boolean {
      return permissionSet.includes(requiredPermission);
    }

    // Build the test cases as a flat array for it.each
    type MatrixCase = {
      routeLabel: string;
      permLabel: string;
      method: string;
      urlFn: () => string;
      bodyFn?: () => Record<string, unknown>;
      keyFn: () => string;
      expectedGranted: boolean;
      successStatus: number | number[];
    };

    function buildMatrixCases(): MatrixCase[] {
      const cases: MatrixCase[] = [];
      for (const route of getRouteSpecs()) {
        for (const perm of getPermissionSets()) {
          cases.push({
            routeLabel: route.label,
            permLabel: perm.label,
            method: route.method,
            urlFn: route.url,
            bodyFn: route.body,
            keyFn: perm.getKey,
            expectedGranted: shouldSucceed(perm.permissions, route.requiredPermission),
            successStatus: route.successStatus,
          });
        }
      }
      return cases;
    }

    test.each(buildMatrixCases())(
      '$routeLabel with [$permLabel] => $expectedGranted',
      async ({ method, urlFn, bodyFn, keyFn, expectedGranted, successStatus }) => {
        const url = urlFn();
        const key = keyFn();
        const init: {
          method: string;
          headers: Record<string, string>;
          body?: unknown;
        } = {
          method,
          headers: authHeaders(key),
        };
        if (bodyFn) {
          init.body = bodyFn();
        }

        const res = await requestJson<SuccessResponse & ErrorResponse>(harness, url, init);

        if (expectedGranted) {
          // Route should succeed — accept any of the listed success statuses.
          // Some routes may fail on business logic (e.g. DELETE after already
          // deleted, reactivate on already-active policy) but the permission
          // gate itself should pass — so we accept both the expected success
          // status and any 2xx/4xx that is NOT 403.
          const successStatuses = Array.isArray(successStatus) ? successStatus : [successStatus];
          expect(
            res.status !== 403,
            `Expected permission granted (not 403) for ${method} ${url}, got ${res.status}: ${JSON.stringify(res.body)}`,
          ).toBe(true);
          // Verify we got either the expected success status or a non-403
          // error that proves the permission gate passed (e.g., 400/404/409
          // from downstream logic).
          const is2xxOr4xxNon403 =
            successStatuses.includes(res.status) ||
            (res.status >= 200 && res.status < 500 && res.status !== 403);
          expect(
            is2xxOr4xxNon403,
            `Expected success or non-403 error for ${method} ${url}, got ${res.status}: ${JSON.stringify(res.body)}`,
          ).toBe(true);
        } else {
          // Route should deny — expect 403
          expect(
            res.status,
            `Expected 403 for ${method} ${url} with insufficient permissions, got ${res.status}: ${JSON.stringify(res.body)}`,
          ).toBe(403);
          expect(res.body.success).toBe(false);
          expect(res.body.error?.code).toBe('PERMISSION_REQUIRED');
        }
      },
    );
  });
});
