import { expect, test, type Page } from '@playwright/test';
import { env, getToken, loginViaDevApi } from './helpers';

const STUDIO_URL = env.baseUrl;
const TEST_LOGIN_EMAIL = 'auth-profile-ui@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Auth Profile UI E2E';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string): string {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? 'tenant-kore';
}

async function createProject(page: Page, token: string, tenantId: string): Promise<string> {
  const suffix = uniqueSuffix();
  const response = await page.request.post(`${STUDIO_URL}/api/projects`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name: `Auth Profiles UI ${suffix}`,
      slug: `auth-profiles-ui-${suffix.replace(/_/g, '-')}`,
      description: 'Project created for auth profile Playwright coverage',
    },
  });

  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as {
    project?: {
      id?: string;
    };
  };

  expect(body.project?.id).toBeTruthy();
  return body.project?.id ?? '';
}

async function deleteProject(
  page: Page,
  token: string,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const response = await page.request.delete(`${STUDIO_URL}/api/projects/${projectId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
  });

  expect([200, 204, 404]).toContain(response.status());
}

async function openCreateProfile(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Add Profile/i }).click();
  // Menu item label is "Custom Profile" (i18n key add_custom_profile),
  // not "Add Custom Profile" — match the rendered text exactly.
  await page.getByRole('button', { name: /^Custom Profile$/i }).click();
  await expect(page.getByRole('button', { name: /Basic Auth/i })).toBeVisible();
}

async function createBasicProfile(page: Page): Promise<void> {
  await openCreateProfile(page);
  await page.getByRole('button', { name: /Basic Auth/i }).click();
  await page.getByPlaceholder('e.g. Basic Auth - Production').fill('Basic UI Profile');
  await page.getByLabel('Username').fill('svc-user');
  await page.getByLabel('Password').fill('sup3r-secret');
  await page.getByRole('button', { name: /Create Profile/i }).click();
  await expect(page.getByText('Basic UI Profile')).toBeVisible();
}

async function createCustomHeaderProfile(page: Page): Promise<void> {
  await openCreateProfile(page);
  await page.getByRole('button', { name: /Custom Header/i }).click();
  await page.getByPlaceholder('e.g. Custom Header - Production').fill('Header UI Profile');
  await page.getByLabel('Header Names').fill('X-API-Key');
  await page.getByPlaceholder('Header value').fill('header-secret');
  await page.getByRole('button', { name: /Create Profile/i }).click();
  await expect(page.getByText('Header UI Profile')).toBeVisible();
}

async function createAwsIamProfile(page: Page): Promise<void> {
  await openCreateProfile(page);
  await page.getByRole('button', { name: /AWS IAM/i }).click();
  await page.getByPlaceholder('e.g. AWS IAM - Production').fill('AWS IAM UI Profile');
  await page.getByLabel('Region').fill('us-east-1');
  await page.getByLabel('Service').fill('execute-api');
  await page.getByLabel('Access Key ID').fill('AKIA_TEST_KEY');
  await page.getByLabel('Secret Access Key').fill('very-secret-key');
  await page.getByLabel('Session Token').fill('temporary-session-token');
  await page.getByRole('button', { name: /Create Profile/i }).click();
  await expect(page.getByText('AWS IAM UI Profile')).toBeVisible();
}

async function createMtlsProfile(page: Page): Promise<void> {
  await openCreateProfile(page);
  await page.getByRole('button', { name: /mTLS/i }).click();
  await page.getByPlaceholder('e.g. mTLS - Production').fill('mTLS UI Profile');
  await page
    .getByLabel('Client Certificate')
    .fill('-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----');
  await page
    .getByLabel('Client Key')
    .fill('-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----');
  await page
    .getByLabel('CA Certificate')
    .fill('-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----');
  await page.getByRole('button', { name: /Create Profile/i }).click();
  await expect(page.getByText('mTLS UI Profile')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('Auth Profile Phase 2 Core Types UI', () => {
  test('creates Phase 2 auth profiles from the Studio UI', async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
      landingPath: '/projects',
    });

    const token = await getToken(page);
    expect(token, 'Auth token should be non-empty').toBeTruthy();

    const tenantId = getTenantIdFromToken(token);
    const projectId = await createProject(page, token, tenantId);

    try {
      await page.goto(`${STUDIO_URL}/projects/${projectId}/settings/auth-profiles`);
      await page.waitForLoadState('networkidle').catch(() => {});

      // First-hit hydration on Next.js dev (Turbopack) can exceed the default
      // 5s assertion timeout for newly-compiled routes — wait longer for the
      // SPA to mount the AppShell and render the page heading.
      await expect(page.getByRole('heading', { name: /Auth Profiles/i })).toBeVisible({
        timeout: 60_000,
      });

      await createBasicProfile(page);
      await createCustomHeaderProfile(page);
      await createAwsIamProfile(page);
      await createMtlsProfile(page);

      await expect(page.getByText('Basic UI Profile')).toBeVisible();
      await expect(page.getByText('Header UI Profile')).toBeVisible();
      await expect(page.getByText('AWS IAM UI Profile')).toBeVisible();
      await expect(page.getByText('mTLS UI Profile')).toBeVisible();
    } finally {
      await deleteProject(page, token, tenantId, projectId);
    }
  });
});
