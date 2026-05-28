import { test, expect, type APIRequestContext } from '@playwright/test';
import { env } from './helpers/env';
import { getDevAccessToken, loginViaDevApi } from './helpers/auth';

const TEST_LOGIN_EMAIL = 'localization-assets@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Localization Assets E2E';

interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string): string {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? env.tenantId;
}

async function createProject(
  request: APIRequestContext,
  token: string,
  tenantId: string,
): Promise<ProjectRecord> {
  const suffix = uniqueSuffix();
  const response = await request.post(`${env.baseUrl}/api/projects`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name: `Localization Assets ${suffix}`,
      slug: `localization-assets-${suffix}`,
      description: 'Playwright project for localization asset management',
    },
  });

  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { success: boolean; project: ProjectRecord };
  expect(body.success).toBe(true);
  return body.project;
}

async function deleteProject(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
): Promise<void> {
  await request.delete(`${env.baseUrl}/api/projects/${projectId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
  });
}

test.describe.serial('Localization assets browser flow', () => {
  test('creates, updates, uploads, and deletes localization assets from project settings', async ({
    page,
    request,
  }) => {
    await loginViaDevApi(page, {
      baseUrl: env.baseUrl,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
      landingPath: '/projects',
    });
    const token = await getDevAccessToken(page, {
      baseUrl: env.baseUrl,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    const tenantId = getTenantIdFromToken(token);
    const project = await createProject(request, token, tenantId);

    try {
      await page.goto(`${env.baseUrl}/projects/${project.id}/settings/localization`);
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('Localization').first()).toBeVisible({ timeout: 20_000 });

      await page.locator('main').getByRole('button', { name: 'New Asset' }).first().click();
      await expect(page.getByText('Create localization asset')).toBeVisible();
      await page.getByLabel('Relative Path').fill('fr/messages.json');
      await page.getByLabel('Description').fill('French shared messages');
      await page.locator('input[type="file"]').setInputFiles({
        name: 'messages.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
          'utf8',
        ),
      });

      await page.getByRole('button', { name: /^Create$/ }).click();
      await expect(page.getByText('Localization asset created')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('locales/fr/messages.json')).toBeVisible({ timeout: 10_000 });
      const assetRow = page.locator('tbody tr').filter({ hasText: 'locales/fr/messages.json' });

      await page.getByLabel('Description').fill('French shared messages v2');
      await page.getByRole('button', { name: /^Save$/ }).click();
      await expect(page.getByText('Localization asset saved')).toBeVisible({ timeout: 10_000 });

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(assetRow.getByText('French shared messages v2')).toBeVisible({
        timeout: 10_000,
      });

      await assetRow.getByText('locales/fr/messages.json').click();
      await expect(page.getByText('Edit localization asset')).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: /^Delete$/ }).click();
      await expect(page.getByText('Delete localization asset')).toBeVisible({ timeout: 10_000 });
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^Delete$/ })
        .click();
      await expect(page.getByText('Localization asset deleted')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('locales/fr/messages.json')).not.toBeVisible();
    } finally {
      await deleteProject(request, token, tenantId, project.id);
    }
  });
});
