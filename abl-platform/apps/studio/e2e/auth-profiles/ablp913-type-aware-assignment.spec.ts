/**
 * E2E-10: Type-Aware Assignment
 *
 * Verifies that auth profile listing supports type filtering and that
 * profiles of different types are properly isolated in list queries.
 *
 * Requires: Studio + Runtime dev servers running.
 */

import { test, expect } from '@playwright/test';
import { apiGet, apiPost } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_EMAIL = 'auth-profiles-type-e2e@e2e-smoke.test';
const TEST_NAME = 'Auth Profiles Type E2E';

test.describe('E2E-10: Type-Aware Assignment', () => {
  let token: string;
  let projectId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    token = await getDevAccessToken(page, { email: TEST_EMAIL, name: TEST_NAME });
    expect(token).toBeTruthy();

    const resp = await apiPost(page, '/api/projects', token, {
      name: `type-assign-e2e-${Date.now()}`,
    });
    projectId = (resp.body as { id: string }).id;

    // Seed profiles of different types
    await apiPost(page, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'API Key Profile',
      authType: 'api_key',
      config: { headerName: 'X-Key', placement: 'header' },
      secrets: { apiKey: 'key-1' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });

    await apiPost(page, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Bearer Profile',
      authType: 'bearer',
      config: {},
      secrets: { token: 'tok-1' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });

    await apiPost(page, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'Basic Auth Profile',
      authType: 'basic',
      config: {},
      secrets: { username: 'user', password: 'pass' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
    });

    await page.close();
  });

  test('filters profiles by authType=api_key', async ({ request }) => {
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles?authType=api_key`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { data: Array<{ authType: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((p) => p.authType === 'api_key')).toBe(true);
  });

  test('filters profiles by authType=bearer', async ({ request }) => {
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles?authType=bearer`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { data: Array<{ authType: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((p) => p.authType === 'bearer')).toBe(true);
  });

  test('unfiltered list returns all types', async ({ request }) => {
    const resp = await apiGet(request, `/api/projects/${projectId}/auth-profiles`, token);

    expect(resp.status).toBe(200);
    const body = resp.body as { data: Array<{ authType: string }> };
    const types = new Set(body.data.map((p) => p.authType));
    expect(types.size).toBeGreaterThanOrEqual(2);
  });

  test('returns empty array for type with no profiles', async ({ request }) => {
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles?authType=oauth2_app`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { data: Array<{ authType: string }> };
    expect(body.data.length).toBe(0);
  });
});
