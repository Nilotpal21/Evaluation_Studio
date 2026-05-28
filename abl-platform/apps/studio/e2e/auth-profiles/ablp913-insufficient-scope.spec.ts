/**
 * E2E-15: Insufficient Scope Detection
 *
 * Verifies that the API properly validates request payloads,
 * returns structured error envelopes for invalid inputs, and
 * handles bulk operations correctly.
 *
 * Requires: Studio + Runtime dev servers running.
 */

import { test, expect } from '@playwright/test';
import { apiGet, apiPost, apiPut } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_EMAIL = 'auth-profiles-scope-err-e2e@e2e-smoke.test';
const TEST_NAME = 'Auth Profiles Scope Error E2E';

test.describe('E2E-15: Insufficient Scope Detection', () => {
  let token: string;
  let projectId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    token = await getDevAccessToken(page, { email: TEST_EMAIL, name: TEST_NAME });
    expect(token).toBeTruthy();

    const resp = await apiPost(page, '/api/projects', token, {
      name: `scope-err-e2e-${Date.now()}`,
    });
    projectId = (resp.body as { id: string }).id;
    await page.close();
  });

  test('creating a profile with invalid authType returns 400', async ({ request }) => {
    const resp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Invalid Type',
      authType: 'not_a_real_type',
      config: {},
      secrets: {},
      projectId,
      scope: 'project',
    });

    expect(resp.status).toBe(400);
    const body = resp.body as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  test('creating a profile without required name returns 400', async ({ request }) => {
    const resp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      authType: 'api_key',
      config: { headerName: 'X-Key', placement: 'header' },
      secrets: { apiKey: 'missing-name' },
      projectId,
      scope: 'project',
    });

    expect(resp.status).toBe(400);
    const body = resp.body as { success: boolean };
    expect(body.success).toBe(false);
  });

  test('bulk action with empty profileIds returns 400', async ({ request }) => {
    const resp = await apiPost(request, `/api/projects/${projectId}/auth-profiles/bulk`, token, {
      action: 'delete',
      profileIds: [],
    });

    // Should reject — empty array is invalid
    expect(resp.status).toBe(400);
  });

  test('bulk action with valid profiles returns results', async ({ request }) => {
    // Create two profiles
    const r1 = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Bulk Target 1',
      authType: 'bearer',
      config: {},
      secrets: { token: 'bulk-1' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    const r2 = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Bulk Target 2',
      authType: 'bearer',
      config: {},
      secrets: { token: 'bulk-2' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });

    const id1 = (r1.body as { data: { id: string } }).data.id;
    const id2 = (r2.body as { data: { id: string } }).data.id;

    const resp = await apiPost(request, `/api/projects/${projectId}/auth-profiles/bulk`, token, {
      action: 'delete',
      profileIds: [id1, id2],
    });

    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { results: Array<{ id: string; status: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.results.length).toBe(2);
  });

  test('updating a non-existent profile returns 404', async ({ request }) => {
    const resp = await apiPut(
      request,
      `/api/projects/${projectId}/auth-profiles/fake-id-does-not-exist`,
      token,
      { name: 'Ghost Profile' },
    );

    expect(resp.status).toBe(404);
  });

  test('revoke-preview for non-existent profile returns 404', async ({ request }) => {
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/fake-id-does-not-exist/revoke-preview?type=profile`,
      token,
    );

    expect(resp.status).toBe(404);
  });
});
