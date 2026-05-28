/**
 * E2E-13: Revoke Actions
 *
 * Verifies the revoke-preview and revoke flows for both profile-level
 * revocation and per-user token revocation through the Studio API proxy.
 *
 * Requires: Studio + Runtime dev servers running.
 */

import { test, expect } from '@playwright/test';
import { apiGet, apiPost } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_EMAIL = 'auth-profiles-revoke-e2e@e2e-smoke.test';
const TEST_NAME = 'Auth Profiles Revoke E2E';

test.describe('E2E-13: Revoke Actions', () => {
  let token: string;
  let projectId: string;
  let profileId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    token = await getDevAccessToken(page, { email: TEST_EMAIL, name: TEST_NAME });
    expect(token).toBeTruthy();

    const projResp = await apiPost(page, '/api/projects', token, {
      name: `revoke-e2e-${Date.now()}`,
    });
    projectId = (projResp.body as { id: string }).id;

    // Create a profile to revoke
    const createResp = await apiPost(page, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Revoke Target Profile',
      authType: 'api_key',
      config: { headerName: 'X-Key', placement: 'header' },
      secrets: { apiKey: 'revoke-me' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    profileId = (createResp.body as { data: { id: string } }).data.id;
    await page.close();
  });

  test('revoke-preview returns blast-radius for profile revocation', async ({ request }) => {
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}/revoke-preview?type=profile`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: {
        type: string;
        affectedUsers: number;
        activeSessions: number;
        affectedConsumers: Record<string, number>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.type).toBe('profile');
    expect(typeof body.data.affectedUsers).toBe('number');
    expect(typeof body.data.activeSessions).toBe('number');
    expect(body.data.affectedConsumers).toBeDefined();
  });

  test('revoke-preview returns blast-radius for token revocation', async ({ request }) => {
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}/revoke-preview?type=tokens`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { type: string; affectedUsers: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.type).toBe('tokens');
  });

  test('revoke-user-tokens endpoint executes without error', async ({ request }) => {
    const resp = await apiPost(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}/revoke-user-tokens`,
      token,
      {},
    );

    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { deletedCount: number; affectedUsers: number };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data.deletedCount).toBe('number');
  });

  test('revoking a profile changes its status to revoked', async ({ request }) => {
    // Create a separate profile for this test
    const createResp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Revoke Status Test',
      authType: 'bearer',
      config: {},
      secrets: { token: 'revoke-status-check' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    const revokeProfileId = (createResp.body as { data: { id: string } }).data.id;

    // Revoke the profile
    const revokeResp = await apiPost(
      request,
      `/api/projects/${projectId}/auth-profiles/${revokeProfileId}/revoke`,
      token,
      {},
    );
    expect(revokeResp.status).toBe(200);

    // Verify status changed
    const getResp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/${revokeProfileId}`,
      token,
    );
    expect(getResp.status).toBe(200);
    const body = getResp.body as { data: { status: string } };
    expect(body.data.status).toBe('revoked');
  });
});
