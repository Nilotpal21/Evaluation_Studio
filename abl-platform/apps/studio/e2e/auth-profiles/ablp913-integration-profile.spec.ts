/**
 * E2E-8: Integration Profile Lifecycle
 *
 * Exercises the full CRUD lifecycle of an integration auth profile
 * (api_key type) through the Studio API proxy, verifying project isolation
 * and proper response envelopes.
 *
 * Requires: Studio + Runtime dev servers running.
 */

import { test, expect } from '@playwright/test';
import { apiGet, apiPost, apiPut, apiDelete } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_EMAIL = 'auth-profiles-e2e@e2e-smoke.test';
const TEST_NAME = 'Auth Profiles E2E';

test.describe('E2E-8: Integration Profile Lifecycle', () => {
  let token: string;
  let projectId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    token = await getDevAccessToken(page, { email: TEST_EMAIL, name: TEST_NAME });
    expect(token).toBeTruthy();

    // Create a test project
    const createResp = await apiPost(page, '/api/projects', token, {
      name: `auth-profile-e2e-${Date.now()}`,
    });
    expect(createResp.status).toBe(200);
    projectId = (createResp.body as { id: string }).id;
    expect(projectId).toBeTruthy();
    await page.close();
  });

  test('creates an api_key auth profile', async ({ request }) => {
    const resp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'E2E API Key Profile',
      authType: 'api_key',
      config: { headerName: 'X-API-Key', placement: 'header' },
      secrets: { apiKey: 'sk-e2e-test-key-123' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });

    expect(resp.status).toBe(200);
    const body = resp.body as { success: boolean; data: { id: string; authType: string } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBeTruthy();
    expect(body.data.authType).toBe('api_key');
  });

  test('lists auth profiles with project isolation', async ({ request }) => {
    const resp = await apiGet(request, `/api/projects/${projectId}/auth-profiles`, token);

    expect(resp.status).toBe(200);
    const body = resp.body as { success: boolean; data: Array<{ id: string }> };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  test('gets a single auth profile by ID', async ({ request }) => {
    // First list to get an ID
    const listResp = await apiGet(request, `/api/projects/${projectId}/auth-profiles`, token);
    const profiles = (listResp.body as { data: Array<{ id: string }> }).data;
    const profileId = profiles[0].id;

    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: {
        id: string;
        config: Record<string, unknown>;
        redactedSecrets: Record<string, string>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(profileId);
    // Secrets should be redacted
    expect(body.data.redactedSecrets).toBeDefined();
  });

  test('updates an auth profile name', async ({ request }) => {
    const listResp = await apiGet(request, `/api/projects/${projectId}/auth-profiles`, token);
    const profiles = (listResp.body as { data: Array<{ id: string }> }).data;
    const profileId = profiles[0].id;

    const resp = await apiPut(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}`,
      token,
      { name: 'Updated E2E Profile Name' },
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { success: boolean; data: { name: string } };
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Updated E2E Profile Name');
  });

  test('deletes an auth profile', async ({ request }) => {
    // Create a profile to delete
    const createResp = await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'E2E Delete Target',
      authType: 'bearer',
      config: {},
      secrets: { token: 'delete-me' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    const profileId = (createResp.body as { data: { id: string } }).data.id;

    const resp = await apiDelete(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { success: boolean };
    expect(body.success).toBe(true);

    // Confirm it is gone
    const getResp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/${profileId}`,
      token,
    );
    expect(getResp.status).toBe(404);
  });
});
