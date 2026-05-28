/**
 * E2E-12: Session Init Scan
 *
 * Verifies that the providers endpoint returns the correct integration
 * provider catalog, and that profiles can be filtered by connector association.
 *
 * Requires: Studio + Runtime dev servers running.
 */

import { test, expect } from '@playwright/test';
import { apiGet, apiPost } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_EMAIL = 'auth-profiles-session-e2e@e2e-smoke.test';
const TEST_NAME = 'Auth Profiles Session E2E';

test.describe('E2E-12: Session Init Scan', () => {
  let token: string;
  let projectId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    token = await getDevAccessToken(page, { email: TEST_EMAIL, name: TEST_NAME });
    expect(token).toBeTruthy();

    const resp = await apiPost(page, '/api/projects', token, {
      name: `session-scan-e2e-${Date.now()}`,
    });
    projectId = (resp.body as { id: string }).id;
    await page.close();
  });

  test('providers endpoint returns integration catalog', async ({ request }) => {
    const resp = await apiGet(request, `/api/projects/${projectId}/auth-profiles/providers`, token);

    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: Array<{
        connectorName: string;
        displayName: string;
        availableAuthTypes: string[];
      }>;
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('integrations endpoint returns vendor-grouped view', async ({ request }) => {
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles/integrations`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { vendors: Array<{ connector: string; profileCount: number }> };
    };
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data.vendors)).toBe(true);
  });

  test('profile created with connector tag appears in filtered list', async ({ request }) => {
    // Create a profile with a connector tag
    await apiPost(request, `/api/projects/${projectId}/auth-profiles`, token, {
      name: 'GitHub Integration Profile',
      authType: 'api_key',
      config: { headerName: 'Authorization', placement: 'header', prefix: 'token ' },
      secrets: { apiKey: 'ghp-test-token' },
      projectId,
      scope: 'project',
      usageMode: 'preconfigured',
      connector: 'github',
    });

    // Filter by connector
    const resp = await apiGet(
      request,
      `/api/projects/${projectId}/auth-profiles?connector=github`,
      token,
    );

    expect(resp.status).toBe(200);
    const body = resp.body as { data: Array<{ connector?: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });
});
