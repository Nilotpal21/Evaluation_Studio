/**
 * E2E-9: Project-Scoped Consent
 *
 * Verifies that auth profiles created at project scope are only
 * visible within that project and not accessible from other projects.
 *
 * Requires: Studio + Runtime dev servers running.
 */

import { test, expect } from '@playwright/test';
import { apiGet, apiPost } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_EMAIL = 'auth-profiles-scope-e2e@e2e-smoke.test';
const TEST_NAME = 'Auth Profiles Scope E2E';

test.describe('E2E-9: Project-Scoped Consent', () => {
  let token: string;
  let projectIdA: string;
  let projectIdB: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    token = await getDevAccessToken(page, { email: TEST_EMAIL, name: TEST_NAME });
    expect(token).toBeTruthy();

    // Create two isolated projects
    const respA = await apiPost(page, '/api/projects', token, {
      name: `scope-test-A-${Date.now()}`,
    });
    projectIdA = (respA.body as { id: string }).id;

    const respB = await apiPost(page, '/api/projects', token, {
      name: `scope-test-B-${Date.now()}`,
    });
    projectIdB = (respB.body as { id: string }).id;

    await page.close();
  });

  test('profile created in project A is not visible in project B', async ({ request }) => {
    // Create profile in project A
    const createResp = await apiPost(request, `/api/projects/${projectIdA}/auth-profiles`, token, {
      name: 'Project A Only',
      authType: 'api_key',
      config: { headerName: 'X-Key', placement: 'header' },
      secrets: { apiKey: 'scoped-key' },
      projectId: projectIdA,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    expect(createResp.status).toBe(200);
    const profileId = (createResp.body as { data: { id: string } }).data.id;

    // List in project A — should include the profile
    const listA = await apiGet(request, `/api/projects/${projectIdA}/auth-profiles`, token);
    const profilesA = (listA.body as { data: Array<{ id: string }> }).data;
    expect(profilesA.some((p) => p.id === profileId)).toBe(true);

    // List in project B — should NOT include the profile
    const listB = await apiGet(request, `/api/projects/${projectIdB}/auth-profiles`, token);
    const profilesB = (listB.body as { data: Array<{ id: string }> }).data;
    expect(profilesB.some((p) => p.id === profileId)).toBe(false);
  });

  test('cannot access project A profile via project B detail endpoint', async ({ request }) => {
    // Create profile in project A
    const createResp = await apiPost(request, `/api/projects/${projectIdA}/auth-profiles`, token, {
      name: 'Cross-Project Guard',
      authType: 'bearer',
      config: {},
      secrets: { token: 'cross-check' },
      projectId: projectIdA,
      scope: 'project',
      usageMode: 'preconfigured',
    });
    const profileId = (createResp.body as { data: { id: string } }).data.id;

    // Try to access from project B — should be 404
    const crossResp = await apiGet(
      request,
      `/api/projects/${projectIdB}/auth-profiles/${profileId}`,
      token,
    );
    expect(crossResp.status).toBe(404);
  });
});
