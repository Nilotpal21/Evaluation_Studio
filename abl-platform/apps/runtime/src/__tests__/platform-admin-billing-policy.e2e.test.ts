import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminBillingPolicyRouter from '../routes/platform-admin-billing-policy.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  devLogin,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';

describe('Platform Admin Billing Policy E2E', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/platform/admin/billing-policy', platformAdminBillingPolicyRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  test('rejects non-platform-admin callers', async () => {
    const login = await devLogin(harness, uniqueEmail('billing-policy-non-admin'));

    const response = await requestJson<{ success: boolean; error?: string }>(
      harness,
      '/api/platform/admin/billing-policy/plans',
      {
        method: 'GET',
        headers: authHeaders(login.accessToken),
      },
    );

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
  });

  test('reads, updates, and clears tenant billing unit policy overrides via HTTP only', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('billing-policy-admin'),
      uniqueSlug('billing-policy-tenant'),
      uniqueSlug('billing-policy-project'),
    );

    const initial = await requestJson<{
      success: boolean;
      tenantId: string;
      planTier: string;
      overrides: Record<string, unknown> | null;
      policy: {
        intervalMinutes: number;
        excludedChannels: string[];
        materialization: {
          basis: string;
          timeWindowMinutes: number | null;
          completedSessionsCount: number | null;
        };
      };
    }>(harness, `/api/platform/admin/billing-policy/${admin.tenantId}`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(initial.status).toBe(200);
    expect(initial.body.success).toBe(true);
    expect(initial.body.tenantId).toBe(admin.tenantId);
    expect(initial.body.planTier).toBe('TEAM');
    expect(initial.body.overrides).toBeNull();
    expect(initial.body.policy.intervalMinutes).toBe(15);
    expect(initial.body.policy.excludedChannels).toEqual(['web_debug']);
    expect(initial.body.policy.materialization).toEqual({
      basis: 'time_window',
      timeWindowMinutes: 60,
      completedSessionsCount: null,
    });

    const updated = await requestJson<{
      success: boolean;
      overrides: {
        intervalMinutes?: number;
        excludedChannels?: string[];
        materialization?: {
          basis?: string;
          timeWindowMinutes?: number | null;
          completedSessionsCount?: number | null;
        };
      } | null;
      policy: {
        intervalMinutes: number;
        excludedChannels: string[];
        materialization: {
          basis: string;
          timeWindowMinutes: number | null;
          completedSessionsCount: number | null;
        };
      };
    }>(harness, `/api/platform/admin/billing-policy/${admin.tenantId}`, {
      method: 'PUT',
      headers: authHeaders(admin.token),
      body: {
        intervalMinutes: 30,
        excludedChannels: [],
        materialization: {
          basis: 'completed_sessions',
          completedSessionsCount: 25,
          timeWindowMinutes: null,
        },
      },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.success).toBe(true);
    expect(updated.body.overrides).toEqual({
      intervalMinutes: 30,
      excludedChannels: [],
      materialization: {
        basis: 'completed_sessions',
        completedSessionsCount: 25,
        timeWindowMinutes: null,
      },
    });
    expect(updated.body.policy.intervalMinutes).toBe(30);
    expect(updated.body.policy.excludedChannels).toEqual([]);
    expect(updated.body.policy.materialization).toEqual({
      basis: 'completed_sessions',
      completedSessionsCount: 25,
      timeWindowMinutes: null,
    });

    const cleared = await requestJson<{
      success: boolean;
      overrides: Record<string, unknown> | null;
      policy: {
        intervalMinutes: number;
        excludedChannels: string[];
      };
    }>(harness, `/api/platform/admin/billing-policy/${admin.tenantId}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    });

    expect(cleared.status).toBe(200);
    expect(cleared.body.success).toBe(true);
    expect(cleared.body.overrides).toBeNull();
    expect(cleared.body.policy.intervalMinutes).toBe(15);
    expect(cleared.body.policy.excludedChannels).toEqual(['web_debug']);
  });
});
