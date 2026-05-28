/**
 * Browser E2E: PII Protection built-in override flow
 *
 * Covers the real Studio user path for ABLP-536:
 * - open the built-in Email configuration dialog
 * - run a live test using built-in recognizer metadata
 * - save the first override successfully
 * - reopen and update the existing override
 *
 * Run:
 *   cd apps/studio && npx playwright test e2e/pii-protection-settings-e2e.spec.ts --config=e2e-playwright.config.ts
 *
 * Requires:
 * - Studio running on the configured TEST_BASE_URL / localhost:5173
 * - Runtime reachable by the Studio proxy
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { extractProjectId, getToken, loginViaDevApi } from './helpers/auth';
import { apiDelete, apiGet } from './helpers/api';
import { env } from './helpers/env';
import { waitForIdle } from './helpers/ui';

interface PiiPatternRecord {
  _id: string;
  piiType: string;
  builtinOverride: boolean;
  defaultRenderMode?: string;
}

interface PiiPatternListResponse {
  success?: boolean;
  data?: PiiPatternRecord[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getProjectId(page: Page): Promise<string> {
  await page.goto(`${env.baseUrl}/projects`, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page, 800);

  const targetHeading = env.projectName
    ? page
        .getByRole('heading', {
          name: new RegExp(escapeRegExp(env.projectName), 'i'),
          level: 3,
        })
        .first()
    : page.getByRole('heading', { level: 3 }).first();

  await expect(targetHeading).toBeVisible({ timeout: 20_000 });
  await targetHeading.click();
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
  await waitForIdle(page, 800);

  return extractProjectId(page.url());
}

async function gotoPiiProtectionSettings(page: Page, projectId: string): Promise<void> {
  await page.goto(
    `${env.baseUrl}/projects/${encodeURIComponent(projectId)}/settings/pii-protection`,
    {
      waitUntil: 'domcontentloaded',
    },
  );
  await expect(page.getByRole('heading', { name: 'PII Protection' })).toBeVisible({
    timeout: 15_000,
  });
  await waitForIdle(page, 800);
}

async function chooseSelectOption(
  page: Page,
  scope: Locator,
  labelText: string,
  optionText: string,
): Promise<void> {
  const label = scope
    .locator('label')
    .filter({ hasText: new RegExp(`^${escapeRegExp(labelText)}$`, 'i') })
    .first();
  const selectId = await label.getAttribute('for');
  if (!selectId) {
    throw new Error(`Unable to resolve select "${labelText}"`);
  }

  await scope.locator(`#${selectId}`).first().click();
  await page.getByRole('option', { name: optionText, exact: true }).last().click();
}

async function listPatterns(
  page: Page,
  token: string,
  projectId: string,
): Promise<PiiPatternRecord[]> {
  const { status, body } = await apiGet<PiiPatternListResponse>(
    page,
    `/api/projects/${projectId}/pii-patterns`,
    token,
  );

  expect(status).toBe(200);
  return Array.isArray(body.data) ? body.data : [];
}

async function deleteEmailOverrides(page: Page, token: string, projectId: string): Promise<void> {
  const patterns = await listPatterns(page, token, projectId);
  const emailOverrides = patterns.filter(
    (pattern) => pattern.builtinOverride && pattern.piiType === 'email',
  );

  for (const pattern of emailOverrides) {
    const { status } = await apiDelete(
      page,
      `/api/projects/${projectId}/pii-patterns/${pattern._id}`,
      token,
    );

    expect(status).toBe(200);
  }
}

async function waitForToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible({
    timeout: 10_000,
  });
}

test('built-in email override previews, creates on first save, and updates on reopen', async ({
  page,
}) => {
  test.setTimeout(180_000);

  await loginViaDevApi(page, { landingPath: '/projects' });
  const token = await getToken(page);
  expect(token).toBeTruthy();
  const projectId = await getProjectId(page);

  await deleteEmailOverrides(page, token, projectId);

  try {
    await gotoPiiProtectionSettings(page, projectId);
    await expect(page.getByText('Email Address', { exact: true })).toBeVisible();

    await page.getByTestId('pii-builtin-configure-email').click();

    const dialog = page.getByRole('dialog', { name: 'Configure Email Address' });
    await expect(dialog).toBeVisible();
    await chooseSelectOption(page, dialog, 'Default Render Mode', 'Masked');
    await dialog
      .getByPlaceholder('Enter sample text to test pattern detection...')
      .fill('Contact alice@example.com for help');
    await dialog.getByRole('button', { name: 'Test', exact: true }).click();

    await expect(dialog.getByText('Detections (1)', { exact: true })).toBeVisible();
    await expect(dialog.getByText('alice@example.com', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Consumer Previews', { exact: true })).toBeVisible();

    const previewRow = dialog
      .locator('div.text-xs')
      .filter({ hasText: /^default:/i })
      .first();
    await expect(previewRow).toBeVisible();
    const previewText = (await previewRow.textContent()) ?? '';
    expect(previewText).toContain('default:');
    expect(previewText).not.toContain('alice@example.com');

    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await waitForToast(page, 'Pattern created');
    await expect(page.getByTestId('pii-builtin-customized-email')).toBeVisible();

    const patternsAfterCreate = await listPatterns(page, token, projectId);
    const createdOverride = patternsAfterCreate.find(
      (pattern) => pattern.builtinOverride && pattern.piiType === 'email',
    );

    expect(createdOverride).toBeDefined();
    expect(createdOverride?._id).toBeTruthy();
    expect(createdOverride?.defaultRenderMode).toBe('masked');

    await page.getByTestId('pii-builtin-configure-email').click();

    const editDialog = page.getByRole('dialog', { name: 'Configure Email Address' });
    await expect(editDialog).toBeVisible();
    await chooseSelectOption(page, editDialog, 'Default Render Mode', 'Redacted');
    await editDialog.getByRole('button', { name: 'Save Changes', exact: true }).click();

    await waitForToast(page, 'Pattern updated');
    await expect(page.getByTestId('pii-builtin-customized-email')).toBeVisible();

    const patternsAfterUpdate = await listPatterns(page, token, projectId);
    const updatedOverride = patternsAfterUpdate.find(
      (pattern) => pattern.builtinOverride && pattern.piiType === 'email',
    );

    expect(updatedOverride).toBeDefined();
    expect(updatedOverride?._id).toBe(createdOverride?._id);
    expect(updatedOverride?.defaultRenderMode).toBe('redacted');
  } finally {
    await deleteEmailOverrides(page, token, projectId);
  }
});
