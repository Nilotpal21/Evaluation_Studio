import { test, expect, type Page } from '@playwright/test';
import { apiDelete, apiPost, apiPut } from './helpers/api';
import { getDevAccessToken, loginViaDevApi } from './helpers/auth';
import { env } from './helpers/env';
import { waitForIdle } from './helpers/ui';

const TEST_LOGIN_EMAIL = 'agent-model-selector@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Agent Model Selector E2E';
const AGENT_NAME = 'selector_agent';
const AGENT_DSL = `AGENT: selector_agent
GOAL: "Help users with model selection questions"`;

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
      name: `Agent Model Selector ${suffix}`,
      slug: `agent-model-selector-${suffix}`,
      description: 'Playwright coverage for execution model selector options',
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);

  return response.body.project;
}

async function createAgent(page: Page, token: string, tenantId: string, projectId: string) {
  const createResponse = await apiPost(
    page,
    `/api/projects/${projectId}/agents`,
    token,
    {
      name: AGENT_NAME,
      agentPath: AGENT_NAME,
      description: 'E2E agent for execution model selector coverage',
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(createResponse.status).toBe(201);

  const dslResponse = await apiPut(
    page,
    `/api/projects/${projectId}/agents/${AGENT_NAME}/dsl`,
    token,
    {
      dslContent: AGENT_DSL,
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(dslResponse.status).toBe(200);
}

async function createProjectModel(page: Page, token: string, tenantId: string, projectId: string) {
  const response = await apiPost<{
    id?: string;
    model?: { id?: string };
  }>(
    page,
    '/api/models',
    token,
    {
      projectId,
      name: 'GPT-4o',
      modelId: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'balanced',
      isDefault: true,
      priority: 0,
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.id || response.body.model?.id).toBeTruthy();
}

test.describe('Agent execution model selector', () => {
  let token = '';
  let tenantId = '';
  let projectId = '';

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

    await createProjectModel(page, token, tenantId, projectId);
    await createAgent(page, token, tenantId, projectId);
  });

  test.afterEach(async ({ page }) => {
    if (projectId && token) {
      await apiDelete(page, `/api/projects/${projectId}`, token, {
        headers: { 'X-Tenant-Id': tenantId },
      });
    }

    token = '';
    tenantId = '';
    projectId = '';
  });

  test('hides project-scoped models without active credentials from the primary model dropdown', async ({
    page,
  }) => {
    await page.goto(`${env.baseUrl}/projects/${projectId}/agents/${AGENT_NAME}`);
    await waitForIdle(page, 1_500);

    await page.getByRole('button', { name: 'Execution', exact: true }).click();
    const primaryModelSelect = page.locator('dt:text-is("Primary Model") + dd button');
    await expect(primaryModelSelect).toBeVisible();
    await primaryModelSelect.click();

    await expect(page.getByRole('option', { name: 'Default', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'GPT-4o', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Claude Sonnet 4.6', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('option', { name: 'GPT-4o Mini', exact: true })).toHaveCount(0);
    await expect(
      page.getByText('1 project model without active credentials is hidden from this list.'),
    ).toBeVisible();
  });
});
