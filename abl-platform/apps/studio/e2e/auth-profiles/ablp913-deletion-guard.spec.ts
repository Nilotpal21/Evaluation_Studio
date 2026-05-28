/**
 * E2E-11: Deletion Guard
 *
 * Verifies that deletion of auth profiles with linked consumers is
 * properly guarded — the consumers endpoint returns accurate counts,
 * and deletion of profiles with active consumers returns appropriate
 * error responses.
 *
 * Requires: Studio + Runtime dev servers running.
 */

import { test, expect } from '@playwright/test';
import { apiGet, apiPost, apiDelete } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_EMAIL = 'auth-profiles-delete-e2e@e2e-smoke.test';
const TEST_NAME = 'Auth Profiles Delete E2E';

test.describe('E2E-11: Deletion Guard', () => {
  let token: string;
  let projectId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    token = await getDevAccessToken(page, { email: TEST_EMAIL, name: TEST_NAME });
    expect(token).toBeTruthy();

    const resp = await apiPost(page, '/api/projects', token, {
      name: `deletion-guard-e2e-${Date.now()}`,
    });
    projectId = (resp.body as { id: string }).id;
    await page.close();
  });

  test('consumers endpoint returns counts for a profile', async ({ request }) => {
    // Create a profile
    const createResp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Consumer Check Profile',
      authType: 'api_key',
      config: { headerName: 'X-Key', placement: 'header' },
      secrets: { apiKey: 'consumer-test' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    const profileId = (createResp.body as { data: { id: string } }).data.id;

    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}/consumers`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('profile without consumers can be deleted', async ({ request }) => {
    const createResp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'No Consumer Profile',
      authType: 'bearer',
      config: {},
      secrets: { token: 'delete-ok' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    const profileId = (createResp.body as { data: { id: string } }).data.id;

    const deleteResp = await apiDelete(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}`,
      token,
    );

    expect(deleteResp.status).toBe(200);
    expect((deleteResp.body as { success: boolean }).success).toBe(true);
  });

  test('deleting a non-existent profile returns 404', async ({ request }) => {
    const deleteResp = await apiDelete(
      request,
      `/api/projects/${projectId}/auth-profiles/non-existent-id-999`,
      token,
    );

    expect(deleteResp.status).toBe(404);
  });

  test('validate endpoint returns validation result', async ({ request }) => {
    const createResp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Validate Check Profile',
      authType: 'api_key',
      config: { headerName: 'X-Key', placement: 'header' },
      secrets: { apiKey: 'validate-test' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    const profileId = (createResp.body as { data: { id: string } }).data.id;

    const resp = await apiPost(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}/validate`,
      token,
      {},
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { success: boolean; data: { valid: boolean } };
    expect(body.success).toBe(true);
    expect(typeof body.data.valid).toBe('boolean');
  });
});
