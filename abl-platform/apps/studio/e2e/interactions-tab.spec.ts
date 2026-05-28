/**
 * E2E Tests: Interactions Tab
 *
 * Tests the Interactions Tab feature end-to-end:
 * - E2E-1: Load Session and View Interactions Timeline
 * - SEC-1: Cross-Tenant Isolation
 * - SEC-2: Cross-Project Isolation
 *
 * Requires: Studio server running (pm2 start), MongoDB connected
 *
 * @e2e-real — No mocks, exercises full system
 */

import { test, expect, type Page } from '@playwright/test';
import { loginViaDevApi, getDevAccessToken } from './helpers/auth';
import { env } from './helpers/env';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';
import {
  seedTestSession,
  seedTraceEvents,
  clearTestData,
  disconnectTestDB,
} from './helpers/test-db';
import {
  testSessionWithInteractions,
  crossTenantSession,
  crossProjectSession,
} from './fixtures/sessions';

// Test constants
const BASE_TENANT_ID = 'tenant-e2e-interactions';
const BASE_PROJECT_ID = 'project-e2e-interactions';
const BASE_USER_EMAIL = 'interactions-e2e@e2e-smoke.test';

test.skip(
  isIsolatedSdkBrowserE2E(),
  'This placeholder suite seeds Mongo directly and targets a route that is not yet wired for isolated E2E.',
);

/**
 * Helper: Navigate to session's interactions tab
 * TODO: Update route once the Interactions Tab UI is wired into routing
 */
async function navigateToSessionInteractions(
  page: Page,
  projectId: string,
  sessionId: string,
): Promise<void> {
  // ASSUMPTION: Interactions tab is at /projects/{projectId}/debug/interactions?session={sessionId}
  // OR: /projects/{projectId}/sessions/{sessionId}/interactions
  const route = `/projects/${projectId}/debug/interactions?session=${sessionId}`;
  await page.goto(`${env.baseUrl}${route}`);
  await page.waitForLoadState('networkidle');
}

test.describe('E2E-1: Load Session and View Interactions Timeline', () => {
  let sessionId: string;

  test.beforeEach(async ({ page }) => {
    // Seed a test session with interactions
    const fixture = testSessionWithInteractions({
      tenantId: BASE_TENANT_ID,
      projectId: BASE_PROJECT_ID,
    });

    sessionId = fixture.sessionId;

    await seedTestSession({
      sessionId,
      tenantId: BASE_TENANT_ID,
      projectId: BASE_PROJECT_ID,
      userId: 'user-e2e-interactions',
      channel: 'web',
      status: 'active',
      currentAgent: 'test-agent',
    });

    await seedTraceEvents(sessionId, fixture.events);

    // Login as test user
    await loginViaDevApi(page, {
      email: BASE_USER_EMAIL,
      name: 'Interactions E2E Test',
    });
  });

  test.afterEach(async () => {
    await clearTestData(sessionId);
  });

  test.afterAll(async () => {
    await disconnectTestDB();
  });

  test('should load session and display interactions timeline', async ({ page }) => {
    // Navigate to the interactions tab for this session
    await navigateToSessionInteractions(page, BASE_PROJECT_ID, sessionId);

    // A5: Minimal assertions until Interactions Tab route is wired into Studio
    // Currently verifies:
    // 1. Authentication works (loginViaDevApi)
    // 2. Session seed succeeds (seedTestSession via DB fixture)
    // 3. Navigation doesn't crash
    // 4. Page loads and contains project context

    await page.waitForTimeout(1000);

    // Verify page loaded and contains project context
    expect(page.url()).toContain(BASE_PROJECT_ID);

    // Future assertions when route is implemented:
    // - Session header displays correct interaction count, tokens, duration
    // - Interaction cards render (14 trace events → 3 interactions)
    // - Click to expand shows steps (user_input, llm_call, tool_call, agent_response)
    // - Token badges show non-zero values
    // - Memory diff sections render for data_stored events
  });

  // A5: Skip placeholder tests until Interactions Tab route is wired into Studio routing
  // These tests require UI elements (interaction cards, step expansion, memory diff sections)
  // that cannot be asserted until the route implementation is complete.
  // Tests are scaffolded for BETA promotion — enable when route is live.
  test.skip('should display interaction steps when expanded', async ({ page }) => {
    // This test will verify:
    // 1. Click an interaction card to expand
    // 2. Steps are rendered (user_input, llm_call, tool_call, agent_response)
    // 3. Token counts are shown in badges
    // 4. Content is displayed correctly (not just contentLength)
    await navigateToSessionInteractions(page, BASE_PROJECT_ID, sessionId);
  });

  test.skip('should show memory diff section for context mutations', async ({ page }) => {
    // This test will verify:
    // 1. If trace events include data_stored events, memory diff section renders
    // 2. Memory diff shows before/after context state
    // 3. Diff highlighting works correctly
    await navigateToSessionInteractions(page, BASE_PROJECT_ID, sessionId);
  });
});

test.describe('SEC-1: Cross-Tenant Isolation', () => {
  let mainSessionId: string;
  let crossTenantSessionId: string;

  test.beforeEach(async ({ page }) => {
    // Seed session in BASE_TENANT_ID
    const mainFixture = testSessionWithInteractions({
      tenantId: BASE_TENANT_ID,
      projectId: BASE_PROJECT_ID,
    });
    mainSessionId = mainFixture.sessionId;

    await seedTestSession({
      sessionId: mainSessionId,
      tenantId: BASE_TENANT_ID,
      projectId: BASE_PROJECT_ID,
      userId: 'user-main-tenant',
    });
    await seedTraceEvents(mainSessionId, mainFixture.events);

    // Seed session in DIFFERENT_TENANT_ID
    const crossFixture = crossTenantSession(BASE_TENANT_ID);
    crossTenantSessionId = crossFixture.sessionId;

    await seedTestSession({
      sessionId: crossTenantSessionId,
      tenantId: crossFixture.tenantId,
      projectId: crossFixture.projectId,
      userId: 'user-cross-tenant',
    });
    await seedTraceEvents(crossTenantSessionId, crossFixture.events);

    // Login as user from BASE_TENANT_ID
    await loginViaDevApi(page, {
      email: BASE_USER_EMAIL,
      name: 'Interactions E2E Test',
    });
  });

  test.afterEach(async () => {
    await clearTestData(mainSessionId);
    await clearTestData(crossTenantSessionId);
  });

  test.afterAll(async () => {
    await disconnectTestDB();
  });

  test('should return 404 when accessing session from different tenant', async ({ page }) => {
    // Get API token for authenticated requests
    const token = await getDevAccessToken(page, { email: BASE_USER_EMAIL });
    expect(token).toBeTruthy();

    // Attempt to load cross-tenant session via API
    // ASSUMPTION: GET /api/sessions/{sessionId} or /api/projects/{projectId}/sessions/{sessionId}
    const apiUrl = `${env.baseUrl}/api/projects/${BASE_PROJECT_ID}/sessions/${crossTenantSessionId}`;

    const response = await page.request.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Id': BASE_TENANT_ID,
      },
    });

    // CRITICAL: Must return 404, not 403 (don't leak existence)
    expect(response.status()).toBe(404);

    // Verify response body does not contain cross-tenant data
    const body = await response.json().catch(() => ({}));
    expect(body).not.toHaveProperty('sessionId', crossTenantSessionId);

    console.info('[SEC-1] Cross-tenant access correctly returned 404');
  });

  test('should not render interactions tab for cross-tenant session', async ({ page }) => {
    // Attempt to navigate to interactions tab for cross-tenant session
    await navigateToSessionInteractions(page, BASE_PROJECT_ID, crossTenantSessionId);

    // Page should show 404 or "Session not found", not render the interactions tab
    await page.waitForTimeout(1000);

    const pageText = await page.textContent('body');
    expect(pageText).toMatch(/not found|404/i);

    console.info('[SEC-1] Cross-tenant UI navigation correctly blocked');
  });
});

test.describe('SEC-2: Cross-Project Isolation', () => {
  let mainSessionId: string;
  let crossProjectSessionId: string;

  test.beforeEach(async ({ page }) => {
    // Seed session in BASE_PROJECT_ID
    const mainFixture = testSessionWithInteractions({
      tenantId: BASE_TENANT_ID,
      projectId: BASE_PROJECT_ID,
    });
    mainSessionId = mainFixture.sessionId;

    await seedTestSession({
      sessionId: mainSessionId,
      tenantId: BASE_TENANT_ID,
      projectId: BASE_PROJECT_ID,
      userId: 'user-main-project',
    });
    await seedTraceEvents(mainSessionId, mainFixture.events);

    // Seed session in DIFFERENT_PROJECT_ID (same tenant)
    const crossFixture = crossProjectSession(BASE_TENANT_ID, BASE_PROJECT_ID);
    crossProjectSessionId = crossFixture.sessionId;

    await seedTestSession({
      sessionId: crossProjectSessionId,
      tenantId: crossFixture.tenantId,
      projectId: crossFixture.projectId,
      userId: 'user-cross-project',
    });
    await seedTraceEvents(crossProjectSessionId, crossFixture.events);

    // Login as user with access to BASE_PROJECT_ID only
    await loginViaDevApi(page, {
      email: BASE_USER_EMAIL,
      name: 'Interactions E2E Test',
    });
  });

  test.afterEach(async () => {
    await clearTestData(mainSessionId);
    await clearTestData(crossProjectSessionId);
  });

  test.afterAll(async () => {
    await disconnectTestDB();
  });

  test('should return 404 when accessing session from different project', async ({ page }) => {
    // Get API token
    const token = await getDevAccessToken(page, { email: BASE_USER_EMAIL });
    expect(token).toBeTruthy();

    // Attempt to load cross-project session via API (using BASE_PROJECT_ID in URL)
    const apiUrl = `${env.baseUrl}/api/projects/${BASE_PROJECT_ID}/sessions/${crossProjectSessionId}`;

    const response = await page.request.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Id': BASE_TENANT_ID,
      },
    });

    // CRITICAL: Must return 404, not 403
    expect(response.status()).toBe(404);

    console.info('[SEC-2] Cross-project access correctly returned 404');
  });

  test('should not render interactions tab for cross-project session', async ({ page }) => {
    // Attempt to navigate to interactions tab for cross-project session
    await navigateToSessionInteractions(page, BASE_PROJECT_ID, crossProjectSessionId);

    await page.waitForTimeout(1000);

    const pageText = await page.textContent('body');
    expect(pageText).toMatch(/not found|404/i);

    console.info('[SEC-2] Cross-project UI navigation correctly blocked');
  });
});
