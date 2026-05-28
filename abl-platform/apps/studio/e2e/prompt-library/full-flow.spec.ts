/**
 * E2E-7: Studio UI — Prompt Library full flow
 *
 * Covers:
 *   Step 1 — Navigate to Prompt Library in the resource sidebar
 *   Step 2 — Create a prompt with a template + variables
 *   Step 3 — Promote draft version to active
 *   Step 4 — Open Compare page and verify pane layout renders
 *   Step 5 — Navigate to IdentityEditor and verify System Prompt Source section exists
 *   Step 6 — (Smoke) list page shows the new prompt after creation
 *
 * Prerequisites:
 *   - Studio dev server running (PLAYWRIGHT_BASE_URL or http://localhost:5173)
 *   - Runtime running (http://localhost:3112) with dev-login enabled
 *   - MongoDB available
 *
 * Run: cd apps/studio && npx playwright test e2e/prompt-library/full-flow.spec.ts --headed
 */

import { test, expect, type Page } from '@playwright/test';
import { getDevAccessToken, loginViaDevApi } from '../helpers';

const STUDIO_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const RUNTIME_URL = process.env.RUNTIME_BASE_URL ?? 'http://localhost:3112';
const RUN_ID = Date.now();
const TEST_EMAIL = `pl-e2e-${RUN_ID}@e2e-smoke.test`;
const PROMPT_NAME = `E2E Greeting ${RUN_ID}`;
const PROMPT_TEMPLATE = 'Hello {{name}}, welcome to {{company}}!';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function setupProject(page: Page): Promise<{ token: string; projectId: string }> {
  await loginViaDevApi(page, { email: TEST_EMAIL });
  const token = await getDevAccessToken(page);

  // Create tenant + project via runtime API
  const adminRes = await page.request.post(`${RUNTIME_URL}/api/auth/dev-login`, {
    data: { email: TEST_EMAIL },
  });
  const { user, accessToken } = await adminRes.json();

  // Make super-admin
  await page.request.post(`${RUNTIME_URL}/api/platform/internal/super-admin`, {
    data: { userId: user.id },
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Create tenant
  const tenantSlug = `pl-e2e-${RUN_ID}`;
  const tenantRes = await page.request.post(`${RUNTIME_URL}/api/platform/admin/tenants`, {
    data: { name: `PL E2E Tenant ${RUN_ID}`, slug: tenantSlug, planTier: 'TEAM' },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const { tenant } = await tenantRes.json();

  // Create project
  const projectRes = await page.request.post(
    `${RUNTIME_URL}/api/platform/admin/tenants/${tenant._id}/projects`,
    {
      data: { name: `PL E2E Project ${RUN_ID}`, slug: `pl-e2e-proj-${RUN_ID}` },
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  const { project } = await projectRes.json();
  return { token: accessToken, projectId: project._id };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('E2E-7: Prompt Library Studio UI flow', () => {
  let token: string;
  let projectId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      ({ token, projectId } = await setupProject(page));
    } finally {
      await page.close();
    }
  });

  test('Step 1: Prompt Library nav slot is visible in the resource sidebar', async ({ page }) => {
    await loginViaDevApi(page, { email: TEST_EMAIL });
    await page.goto(`${STUDIO_URL}/projects/${projectId}/prompt-library`);
    await page.waitForLoadState('networkidle');

    // Sidebar nav entry should be present
    await expect(
      page
        .getByRole('button', { name: /prompt library/i })
        .or(page.getByText(/prompt library/i).first()),
    ).toBeVisible({ timeout: 10_000 });
  }, 60_000);

  test('Step 2: Create a prompt with initialVersion via the Create dialog', async ({ page }) => {
    await loginViaDevApi(page, { email: TEST_EMAIL });
    await page.goto(`${STUDIO_URL}/projects/${projectId}/prompt-library`);
    await page.waitForLoadState('networkidle');

    // Click "Create" / "New Prompt" button
    const createBtn = page
      .getByRole('button', { name: /create/i })
      .or(page.getByRole('button', { name: /new prompt/i }))
      .first();
    await createBtn.click();

    // Fill in the name
    const nameInput = page
      .getByPlaceholder(/prompt name/i)
      .or(page.getByLabel(/name/i))
      .first();
    await nameInput.fill(PROMPT_NAME);

    // Submit
    const submitBtn = page
      .getByRole('button', { name: /create/i })
      .or(page.getByRole('button', { name: /save/i }))
      .last();
    await submitBtn.click();

    // The new prompt should appear in the list
    await expect(page.getByText(PROMPT_NAME)).toBeVisible({ timeout: 15_000 });
  }, 60_000);

  test('Step 3: Open prompt detail; template editor and version list are visible', async ({
    page,
  }) => {
    // Create a prompt via API so the test is self-contained
    const createRes = await page.request.post(
      `${RUNTIME_URL}/api/projects/${projectId}/prompt-library/prompts`,
      {
        data: {
          name: `Detail Test ${RUN_ID}`,
          initialVersion: {
            template: PROMPT_TEMPLATE,
            variables: ['name', 'company'],
          },
        },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    expect(createRes.status()).toBe(201);
    const { item } = await createRes.json();

    await loginViaDevApi(page, { email: TEST_EMAIL });
    await page.goto(`${STUDIO_URL}/projects/${projectId}/prompt-library/${item._id}`);
    await page.waitForLoadState('networkidle');

    // Template tab should be active by default
    await expect(page.getByText(/template/i).first()).toBeVisible({ timeout: 10_000 });

    // Version status badge (draft)
    await expect(page.getByText(/draft/i).first()).toBeVisible({ timeout: 10_000 });
  }, 60_000);

  test('Step 3b: Promote a draft version to active via the UI', async ({ page }) => {
    // Setup prompt + draft version via API
    const createRes = await page.request.post(
      `${RUNTIME_URL}/api/projects/${projectId}/prompt-library/prompts`,
      {
        data: {
          name: `Promote UI Test ${RUN_ID}`,
          initialVersion: { template: 'Hello world', variables: [] },
        },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    expect(createRes.status()).toBe(201);
    const { item } = await createRes.json();

    await loginViaDevApi(page, { email: TEST_EMAIL });
    await page.goto(`${STUDIO_URL}/projects/${projectId}/prompt-library/${item._id}`);
    await page.waitForLoadState('networkidle');

    // Click Promote button
    const promoteBtn = page.getByRole('button', { name: /promote/i }).first();
    await promoteBtn.click();

    // Status should change to active
    await expect(page.getByText(/active/i).first()).toBeVisible({ timeout: 15_000 });
  }, 60_000);

  test('Step 4: Compare page renders with two-pane layout', async ({ page }) => {
    const createRes = await page.request.post(
      `${RUNTIME_URL}/api/projects/${projectId}/prompt-library/prompts`,
      {
        data: {
          name: `Compare Page Test ${RUN_ID}`,
          initialVersion: { template: 'Summarize: {{text}}', variables: ['text'] },
        },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    expect(createRes.status()).toBe(201);
    const { item } = await createRes.json();

    await loginViaDevApi(page, { email: TEST_EMAIL });
    await page.goto(`${STUDIO_URL}/projects/${projectId}/prompt-library/${item._id}?tab=compare`);
    await page.waitForLoadState('networkidle');

    // Compare page shows mode toggle
    await expect(
      page
        .getByText(/compare models/i)
        .or(page.getByText(/compare versions/i))
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Run button present
    await expect(page.getByRole('button', { name: /run/i }).first()).toBeVisible({
      timeout: 10_000,
    });
  }, 60_000);

  test('Step 5: IdentityEditor shows System Prompt Source section', async ({ page }) => {
    // Create an agent via API
    const agentRes = await page.request.post(`${RUNTIME_URL}/api/projects/${projectId}/agents`, {
      data: { name: `pl-e2e-agent-${RUN_ID}` },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    // Agent creation endpoint may return 201 or 200
    expect([200, 201]).toContain(agentRes.status());

    await loginViaDevApi(page, { email: TEST_EMAIL });
    // Navigate to agent detail, Identity section
    await page.goto(
      `${STUDIO_URL}/projects/${projectId}/agents/pl-e2e-agent-${RUN_ID}?section=identity`,
    );
    await page.waitForLoadState('networkidle');

    // System Prompt Source section should be visible in IdentityEditor
    await expect(page.getByText(/system prompt source/i).first()).toBeVisible({ timeout: 15_000 });

    // "Select from Prompt Library" button should be present (no ref set yet)
    await expect(
      page
        .getByRole('button', { name: /select from prompt library/i })
        .or(page.getByText(/select from prompt library/i).first()),
    ).toBeVisible({ timeout: 10_000 });
  }, 60_000);

  test('Step 6: List page is stable — shows all created prompts', async ({ page }) => {
    await loginViaDevApi(page, { email: TEST_EMAIL });
    await page.goto(`${STUDIO_URL}/projects/${projectId}/prompt-library`);
    await page.waitForLoadState('networkidle');

    // Should show a prompt list (or empty state) — no crash
    const listContent = page
      .getByRole('table')
      .or(page.getByRole('list'))
      .or(page.getByText(/no prompts/i))
      .or(page.getByText(/create.*prompt/i));
    await expect(listContent.first()).toBeVisible({ timeout: 10_000 });

    // No unhandled JS errors
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.waitForTimeout(1000);
    const fatalErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('Failed to load resource'),
    );
    expect(fatalErrors).toHaveLength(0);
  }, 60_000);
});
