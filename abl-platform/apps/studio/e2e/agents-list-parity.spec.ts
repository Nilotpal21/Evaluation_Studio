import { test, expect, type Page } from '@playwright/test';
import { apiDelete, apiGet, apiPost, apiPut } from './helpers/api';
import { getDevAccessToken, loginViaDevApi } from './helpers/auth';
import { env } from './helpers/env';
import { waitForIdle } from './helpers/ui';

const TEST_LOGIN_EMAIL = 'agents-ui@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Agents UI E2E';

const SUPERVISOR_DSL = `SUPERVISOR: main_supervisor
GOAL: "Route customer requests"
HANDOFF:
  - TO: booking_agent
    WHEN: true`;

const BOOKING_AGENT_DSL = `AGENT: booking_agent
GOAL: "Help users book hotels"`;

const BILLING_AGENT_DSL = `AGENT: billing_agent
GOAL: "Handle billing questions"`;

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string) {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? env.tenantId;
}

async function createProject(page: Page, token: string, tenantId: string) {
  const suffix = uniqueSuffix();
  const response = await apiPost<{
    success: boolean;
    project: { id: string; name: string; slug: string };
  }>(
    page,
    '/api/projects',
    token,
    {
      name: `Agents List Parity ${suffix}`,
      slug: `agents-list-parity-${suffix}`,
      description: 'Playwright parity coverage for agents list controls',
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);

  return response.body.project;
}

async function createAgent(
  page: Page,
  token: string,
  tenantId: string,
  projectId: string,
  name: string,
  dsl: string,
) {
  const createResponse = await apiPost(
    page,
    `/api/projects/${projectId}/agents`,
    token,
    {
      name,
      agentPath: name,
      description: `E2E agent ${name}`,
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(createResponse.status).toBe(201);

  const dslResponse = await apiPut(
    page,
    `/api/projects/${projectId}/agents/${name}/dsl`,
    token,
    {
      dslContent: dsl,
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(dslResponse.status).toBe(200);
}

async function openFilterOption(page: Page, triggerLabel: string, optionLabel: string) {
  await page.getByRole('button', { name: triggerLabel, exact: true }).click();
  await page
    .locator('div[style*="z-index: 9999"]')
    .getByRole('button', { name: optionLabel, exact: true })
    .click();
}

test.describe('Agents List Parity', () => {
  let token = '';
  let tenantId = '';
  let projectId = '';
  let projectName = '';

  test.beforeEach(async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: env.baseUrl,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
      landingPath: '/projects',
    });

    token = await getDevAccessToken(page, {
      baseUrl: env.baseUrl,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    expect(token).toBeTruthy();
    tenantId = getTenantIdFromToken(token);

    const project = await createProject(page, token, tenantId);
    projectId = project.id;
    projectName = project.name;

    await createAgent(page, token, tenantId, projectId, 'main_supervisor', SUPERVISOR_DSL);
    await createAgent(page, token, tenantId, projectId, 'booking_agent', BOOKING_AGENT_DSL);
    await createAgent(page, token, tenantId, projectId, 'billing_agent', BILLING_AGENT_DSL);

    await page.goto(`${env.baseUrl}/projects/${projectId}/agents`);
    await waitForIdle(page, 2000);
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    if (projectId && token) {
      await apiDelete(page, `/api/projects/${projectId}`, token, {
        headers: { 'X-Tenant-Id': tenantId },
      });
    }
    tenantId = '';
    projectId = '';
    projectName = '';
  });

  test('entry agent selection persists across refresh and canvas view', async ({ page }) => {
    await expect(page.getByTestId('entry-agent-list-toolbar')).toBeVisible();

    const updateRequest = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${projectId}`) &&
        response.request().method() === 'PATCH' &&
        response.status() === 200,
    );

    await openFilterOption(page, 'Auto-detect', 'billing agent');
    await updateRequest;

    await expect(page.getByText('Start agent set to billing_agent')).toBeVisible();

    const projectResponse = await apiGet<{
      success: boolean;
      project: { entryAgentName: string | null };
    }>(page, `/api/projects/${projectId}`, token, {
      headers: { 'X-Tenant-Id': tenantId },
    });
    expect(projectResponse.status).toBe(200);
    expect(projectResponse.body.project.entryAgentName).toBe('billing_agent');

    await page.reload();
    await waitForIdle(page, 1500);

    await expect(
      page.getByTestId('entry-agent-list-toolbar').getByRole('button', {
        name: 'billing agent',
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await waitForIdle(page, 1000);

    await expect(
      page.getByTestId('entry-agent-canvas-toolbar').getByRole('button', {
        name: 'billing agent',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('type filter works through the real portal-based filter select', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'main supervisor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'booking agent' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'billing agent' })).toBeVisible();

    await openFilterOption(page, 'All Types', 'Supervisor');
    await waitForIdle(page, 1000);

    await expect(page.getByRole('heading', { name: 'main supervisor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'booking agent' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'billing agent' })).toHaveCount(0);
  });
});
