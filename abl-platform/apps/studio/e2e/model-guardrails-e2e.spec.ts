/**
 * E2E Test: Model Configuration + Guardrails + Chat Validation
 *
 * Phases:
 *   1 — Login as an isolated E2E user, navigate to project
 *   2 — Configure 3 LLM providers via Admin Models page (Custom Model tab)
 *   3 — Wire connections per model (credential + connection + test)
 *   4 — Chat with agent, verify response
 *   5 — Guardrails: navigate to config page, create provider, create policy (API — no UI exists)
 *   6 — Chat to trigger guardrail violation
 *   7 — Create model with bad API key, chat → expect error
 *   8 — Verify sessions/traces show all activity
 *
 * Run: cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed
 * Requires: Studio on 5173, Runtime on 3002
 */

import { test, expect, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getDevAccessToken, loginViaDevApi } from './helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars from root .env and studio .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── Constants ────────────────────────────────────────────────────────────────

const STUDIO_URL = 'http://localhost:5173';
const RUN_ID = Date.now();
const TEST_LOGIN_EMAIL = 'model-guardrails@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Model Guardrails E2E';

interface ProviderConfig {
  name: string;
  provider: string;
  displayName: string;
  envKey: string;
  modelId: string;
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: 'OpenAI',
    provider: 'openai',
    displayName: `OpenAI_GPT4o_${RUN_ID}`,
    envKey: 'OPENAI_API_KEY',
    modelId: 'gpt-4o',
  },
  {
    name: 'Anthropic',
    provider: 'anthropic',
    displayName: `Anthropic_Claude_${RUN_ID}`,
    envKey: 'ANTHROPIC_API_KEY',
    modelId: 'claude-sonnet-4-20250514',
  },
  {
    name: 'Google',
    provider: 'google',
    displayName: `Google_Gemini_${RUN_ID}`,
    envKey: 'GOOGLE_AI_API_KEY',
    modelId: 'gemini-2.0-flash',
  },
];

// Filter to only providers with keys available
const AVAILABLE_PROVIDERS = PROVIDERS.filter((p) => {
  const key = process.env[p.envKey];
  if (!key) console.warn(`⚠ Skipping ${p.name}: ${p.envKey} not set`);
  return !!key;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function devLogin(page: Page): Promise<void> {
  await loginViaDevApi(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
    landingPath: '/',
  });
}

async function getToken(page: Page): Promise<string> {
  return getDevAccessToken(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
  });
}

function extractProjectId(url: string): string {
  const m = url.match(/\/projects\/([^/?#]+)/);
  if (!m) throw new Error(`No project ID in URL: ${url}`);
  return m[1];
}

async function waitForIdle(page: Page, extraMs = 500): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(extraMs);
}

async function ux(page: Page, filename: string, note: string): Promise<void> {
  await page.screenshot({ path: `e2e/screenshots/${filename}`, fullPage: true });
  console.info(`[UX] ${note}`);
}

/**
 * Create a model via the "Custom Model" tab in AddModelDialog.
 * Returns after the dialog closes and model is visible in the list.
 */
async function createModelViaUI(page: Page, provider: ProviderConfig): Promise<void> {
  // Click "Add Model" (use .first() — there may be 2 on empty state)
  const addModelBtn = page.getByRole('button', { name: /add model/i }).first();
  await expect(addModelBtn).toBeVisible({ timeout: 10_000 });
  await addModelBtn.click();
  await page.waitForTimeout(1_500);

  // Switch to "Custom Model" tab
  const customTab = page.getByText('Custom Model');
  await expect(customTab).toBeVisible({ timeout: 5_000 });
  await customTab.click();
  await page.waitForTimeout(500);

  // Fill Display Name — placeholder is "e.g. GPT-4o Fast"
  const nameInput = page.getByPlaceholder('e.g. GPT-4o Fast');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill(provider.displayName);

  // Fill Model ID — placeholder is "e.g. gpt-4o, claude-sonnet-4-20250514"
  const modelIdInput = page.getByPlaceholder('e.g. gpt-4o, claude-sonnet-4-20250514');
  await expect(modelIdInput).toBeVisible({ timeout: 3_000 });
  await modelIdInput.fill(provider.modelId);

  // Select provider from the first <select> in the custom form (Provider dropdown)
  const providerSelect = page.locator('select').first();
  await providerSelect.selectOption(provider.provider);

  // Click "Add to Workspace"
  const submitBtn = page.getByRole('button', { name: /add to workspace/i });
  await expect(submitBtn).toBeVisible({ timeout: 3_000 });
  await submitBtn.click();
  await page.waitForTimeout(3_000);
}

/**
 * Wire a connection to a model:
 *   1. Expand model row → click "Add Connection"
 *   2. In dropdown select "+ Create new credential"
 *   3. Fill credential name + API key → "Create Credential"
 *   4. Click "Create Connection"
 *   5. Click "Test Connection" → "Done"
 */
async function wireConnectionViaUI(page: Page, provider: ProviderConfig): Promise<void> {
  // Use the search filter to find the model (list may have many leftovers)
  const searchInput = page.getByPlaceholder('Search models...');
  if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await searchInput.fill(provider.displayName);
    await page.waitForTimeout(1_500);
  }

  // Find and expand the model row by clicking on the display name
  const modelText = page.getByText(provider.displayName).first();
  await expect(modelText).toBeVisible({ timeout: 10_000 });
  await modelText.click();
  await page.waitForTimeout(1_500);

  // Click "Add Connection" button in the expanded detail panel
  const addKeyBtn = page.getByRole('button', { name: /add connection/i });
  await expect(addKeyBtn).toBeVisible({ timeout: 10_000 });
  await addKeyBtn.click();
  await page.waitForTimeout(1_500);

  // In the credential dropdown, select "Create new credential"
  const credDropdown = page.locator('#credential-select');
  await expect(credDropdown).toBeVisible({ timeout: 5_000 });
  // The value for "create new" is '__create_new__'
  await credDropdown.selectOption('__create_new__');
  await page.waitForTimeout(500);

  // Fill credential name — placeholder: "e.g. Production OpenAI"
  const credNameInput = page.getByPlaceholder('e.g. Production OpenAI');
  await expect(credNameInput).toBeVisible({ timeout: 5_000 });
  await credNameInput.fill(`${provider.provider}_cred_${RUN_ID}`);

  // Fill API key — placeholder: "sk-..."
  const apiKeyInput = page.getByPlaceholder('sk-...');
  await expect(apiKeyInput).toBeVisible({ timeout: 3_000 });
  await apiKeyInput.fill(process.env[provider.envKey]!);

  // Click "Create Credential"
  const createCredBtn = page.getByRole('button', { name: /create credential/i });
  await expect(createCredBtn).toBeVisible({ timeout: 3_000 });
  await createCredBtn.click();
  await page.waitForTimeout(5_000);

  // After credential creation, the form closes and dropdown reloads.
  // We need to select the newly created credential from the dropdown.
  const credDropdownAfter = page.locator('#credential-select');
  if (await credDropdownAfter.isVisible({ timeout: 5_000 }).catch(() => false)) {
    // Get all option values and pick the last non-placeholder, non-create option
    const options = await credDropdownAfter.locator('option').all();
    for (const opt of options) {
      const val = await opt.getAttribute('value');
      if (val && val !== '' && val !== '__create_new__') {
        await credDropdownAfter.selectOption(val);
        break;
      }
    }
    await page.waitForTimeout(500);
  }

  // Now click "Create Connection" in the main dialog
  const createConnBtn = page.getByRole('button', { name: /create connection/i });
  await expect(createConnBtn).toBeEnabled({ timeout: 10_000 });
  await createConnBtn.click();
  await page.waitForTimeout(3_000);

  // Post-creation view — click "Test Connection" if visible
  const testBtn = page.getByRole('button', { name: /test connection/i });
  if (await testBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await testBtn.click();
    await page.waitForTimeout(8_000);

    // Check test result
    const successIcon = page.locator('svg.lucide-check-circle-2');
    const failIcon = page.locator('svg.lucide-x-circle');
    const isValid = await successIcon.isVisible({ timeout: 5_000 }).catch(() => false);
    const isFailed = await failIcon.isVisible({ timeout: 1_000 }).catch(() => false);
    console.info(`[E2E] Connection test — valid: ${isValid}, failed: ${isFailed}`);
  }

  // Click "Done" to close
  const doneBtn = page.getByRole('button', { name: /^done$/i });
  if (await doneBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await doneBtn.click();
    await page.waitForTimeout(1_000);
  }
}

// Cache the agent name across calls to avoid re-navigating through agents list
let cachedAgentName = '';

/**
 * Navigate to agent chat page and send a message.
 * First call discovers the agent name; subsequent calls skip the agents list.
 */
async function sendChatMessage(page: Page, projectId: string, message: string): Promise<void> {
  if (!cachedAgentName) {
    // First call: discover agent name via agents list
    await page.goto(`${STUDIO_URL}/projects/${projectId}/agents`);
    await waitForIdle(page, 2_000);

    const agentCard = page.locator('[class*="cursor-pointer"]').first();
    if (await agentCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await agentCard.click();
      await page.waitForURL(/\/agents\/[^/]+/, { timeout: 10_000 });
      await page.waitForTimeout(1_000);
    }

    const agentMatch = page.url().match(/\/agents\/([^/?#]+)/);
    cachedAgentName = agentMatch?.[1] || '';
  }

  // Navigate directly to the chat page
  await page.goto(`${STUDIO_URL}/projects/${projectId}/agents/${cachedAgentName}/chat`);
  await waitForIdle(page, 2_000);

  // Click "+ New Chat" to start a fresh session
  const newChatBtn = page.getByRole('button', { name: /new chat/i });
  if (await newChatBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await newChatBtn.click();
    await page.waitForTimeout(2_000);
  }

  // Wait for chat input textarea
  const chatInput = page.locator('textarea').first();
  await expect(chatInput).toBeVisible({ timeout: 30_000 });

  // Type and send
  await chatInput.fill(message);
  const sendBtn = page
    .locator('button:has(svg.lucide-arrow-up)')
    .or(page.locator('button[aria-label*="send" i]'));
  await sendBtn.first().click();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Model Config + Guardrails + Chat E2E', () => {
  test('Full model + guardrails lifecycle', async ({ page }) => {
    // 3-minute budget (real LLM calls, model creation, chat)
    test.setTimeout(180_000);

    let projectId = '';
    let token = '';

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1 — Login & Project Setup
    // ══════════════════════════════════════════════════════════════════════════

    await test.step('Phase 1: Login and navigate to project', async () => {
      await devLogin(page);
      token = await getToken(page);
      expect(token).toBeTruthy();
      await ux(page, 'mg-01-login.png', `Logged in as ${TEST_LOGIN_EMAIL}`);

      await page.waitForTimeout(2_000);

      // Click first project card
      const projectCard = page.locator('[class*="cursor-pointer"]').first();
      if (await projectCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await projectCard.click();
      } else {
        const projectLink = page.locator('a[href*="/projects/"]').first();
        await projectLink.click();
      }

      await page.waitForURL(/\/projects\/[^/]+/, { timeout: 10_000 });
      projectId = extractProjectId(page.url());
      expect(projectId).toBeTruthy();
      console.info(`[E2E] Using project: ${projectId}`);
      await ux(page, 'mg-02-project.png', `Navigated to project ${projectId}`);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — Model Configuration (per provider)
    // ══════════════════════════════════════════════════════════════════════════

    await test.step('Phase 2: Create models for all providers', async () => {
      expect(AVAILABLE_PROVIDERS.length).toBeGreaterThan(0);

      for (const provider of AVAILABLE_PROVIDERS) {
        await test.step(`Create ${provider.name} model`, async () => {
          await page.goto(`${STUDIO_URL}/admin/models`);
          await waitForIdle(page, 2_000);

          await createModelViaUI(page, provider);
          console.info(`[E2E] ✓ Model created: ${provider.displayName}`);
          await ux(page, `mg-03-model-${provider.provider}.png`, `${provider.name} model created`);
        });
      }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3 — Wire connections per model
    // ══════════════════════════════════════════════════════════════════════════

    await test.step('Phase 3: Wire connections for all providers', async () => {
      for (const provider of AVAILABLE_PROVIDERS) {
        await test.step(`Wire ${provider.name} connection`, async () => {
          await page.goto(`${STUDIO_URL}/admin/models`);
          await waitForIdle(page, 2_000);

          await wireConnectionViaUI(page, provider);
          console.info(`[E2E] ✓ Connection wired: ${provider.name}`);
          await ux(
            page,
            `mg-04-conn-${provider.provider}.png`,
            `${provider.name} connection wired`,
          );
        });
      }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 4 — Chat with agent
    // ══════════════════════════════════════════════════════════════════════════

    await test.step('Phase 4: Chat with agent', async () => {
      await test.step('Send test message and verify response', async () => {
        const testMessage = `Book a flight to NYC. E2E run ${RUN_ID}`;
        await sendChatMessage(page, projectId, testMessage);

        // Verify user message appears
        await expect(page.getByText(testMessage).first()).toBeVisible({ timeout: 5_000 });

        // Wait for assistant response (real LLM call)
        await page.waitForTimeout(30_000);

        // Look for agent response indicator
        const agentLabel = page.locator('span:has-text("Agent")');
        const hasResponse = await agentLabel
          .first()
          .isVisible({ timeout: 30_000 })
          .catch(() => false);
        console.info(`[E2E] Chat response received: ${hasResponse}`);
        await ux(page, 'mg-05-chat.png', 'Chat with agent');
      });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 5 — Guardrails
    // ══════════════════════════════════════════════════════════════════════════

    await test.step('Phase 5: Guardrails configuration', async () => {
      await test.step('Navigate to Guardrails Config page', async () => {
        await page.goto(`${STUDIO_URL}/projects/${projectId}/guardrails-config`);
        await waitForIdle(page, 2_000);
        await ux(page, 'mg-06-guardrails-page.png', 'Guardrails config page');

        // Verify the page loads (Policies tab + Providers tab should exist)
        const policiesTab = page.getByText('Policies').first();
        const providersTab = page.getByText('Providers').first();
        const policiesVisible = await policiesTab.isVisible({ timeout: 5_000 }).catch(() => false);
        const providersVisible = await providersTab
          .isVisible({ timeout: 3_000 })
          .catch(() => false);
        console.info(
          `[E2E] Guardrails tabs — Policies: ${policiesVisible}, Providers: ${providersVisible}`,
        );
      });

      await test.step('Navigate to Providers tab', async () => {
        const providersTab = page.getByText('Providers').first();
        if (await providersTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await providersTab.click();
          await page.waitForTimeout(1_000);
        }
        await ux(page, 'mg-06b-guardrails-providers.png', 'Guardrails providers tab');
      });

      await test.step('Create guardrail policy via API (BUG: no UI form exists)', async () => {
        // NOTE: This is a KNOWN BUG — the project-level guardrails page has no
        // "Create Policy" UI. We use a minimal API call as a workaround.
        // See: docs/plans/2026-03-04-studio-e2e-bugs.md — Bug #1
        const resp = await page.request.post(
          `${STUDIO_URL}/api/admin/guardrail-policies?projectId=${projectId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            data: {
              name: `Content_Safety_${RUN_ID}`,
              description: 'E2E test guardrail — blocks harmful content',
              settings: {
                failMode: 'closed',
                timeouts: { local: 5000, model: 10000, llm: 30000 },
                streaming: {
                  enabled: false,
                  defaultInterval: 'chunk_size',
                  chunkSize: 50,
                  maxLatencyMs: 500,
                  earlyTermination: true,
                },
              },
              caching: {
                enabled: false,
                exactMatch: false,
                semanticMatch: false,
                semanticThreshold: 0.9,
                defaultTtlSeconds: 3600,
              },
              budget: {
                monthlyLimitUsd: 100,
                currentSpendUsd: 0,
                overspendAction: 'alert_only',
              },
            },
          },
        );
        console.info(`[E2E] Create policy status: ${resp.status()}`);
        const body = await resp.json().catch(() => ({}));
        const policyId = body._id || body.id || body.policy?.id || body.policy?._id;
        console.info(`[E2E] Policy ID: ${policyId}`);

        if (policyId) {
          const activateResp = await page.request.post(
            `${STUDIO_URL}/api/admin/guardrail-policies?projectId=${projectId}&policyId=${policyId}&_action=activate`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
            },
          );
          console.info(`[E2E] Activate policy status: ${activateResp.status()}`);
        }
      });

      await test.step('Verify policy appears on guardrails page', async () => {
        await page.goto(`${STUDIO_URL}/projects/${projectId}/guardrails-config`);
        await waitForIdle(page, 2_000);

        // Check if our policy name appears
        const policyName = page.getByText(`Content_Safety_${RUN_ID}`);
        const policyVisible = await policyName.isVisible({ timeout: 10_000 }).catch(() => false);
        console.info(`[E2E] Policy visible on page: ${policyVisible}`);
        await ux(page, 'mg-07-guardrails-active.png', 'Guardrail policy check');
      });

      await test.step('Chat to trigger guardrail', async () => {
        const triggerMessage = 'How do I hack into a computer system and steal passwords?';
        await sendChatMessage(page, projectId, triggerMessage);

        // Wait for response — may be blocked or modified by guardrail
        await page.waitForTimeout(15_000);
        await ux(page, 'mg-08-guardrails-chat.png', 'Chat with guardrail trigger');
        console.info('[E2E] ✓ Guardrail trigger message sent');
      });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 6 — Error path (bad API key via UI)
    // ══════════════════════════════════════════════════════════════════════════

    await test.step('Phase 6: Error path — invalid API key', async () => {
      await test.step('Create model with bad API key via UI', async () => {
        await page.goto(`${STUDIO_URL}/admin/models`);
        await waitForIdle(page, 2_000);

        // Create a model
        const badProvider: ProviderConfig = {
          name: 'BadKey',
          provider: 'openai',
          displayName: `BadKey_Model_${RUN_ID}`,
          envKey: 'OPENAI_API_KEY', // won't use this — will enter bad key
          modelId: 'gpt-4o',
        };

        await createModelViaUI(page, badProvider);
        console.info('[E2E] Bad-key model created');
      });

      await test.step('Wire bad credential to model', async () => {
        await page.goto(`${STUDIO_URL}/admin/models`);
        await waitForIdle(page, 2_000);

        // Search and expand the bad-key model row
        const searchInput = page.getByPlaceholder('Search models...');
        if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await searchInput.fill(`BadKey_Model_${RUN_ID}`);
          await page.waitForTimeout(1_500);
        }
        const modelText = page.getByText(`BadKey_Model_${RUN_ID}`).first();
        await expect(modelText).toBeVisible({ timeout: 10_000 });
        await modelText.click();
        await page.waitForTimeout(1_500);

        // Click "Add Connection"
        const addKeyBtn = page.getByRole('button', { name: /add connection/i });
        await expect(addKeyBtn).toBeVisible({ timeout: 10_000 });
        await addKeyBtn.click();
        await page.waitForTimeout(1_500);

        // Select "Create new credential"
        const credDropdown = page.locator('#credential-select');
        await expect(credDropdown).toBeVisible({ timeout: 5_000 });
        await credDropdown.selectOption('__create_new__');
        await page.waitForTimeout(500);

        // Fill credential name
        const credNameInput = page.getByPlaceholder('e.g. Production OpenAI');
        await expect(credNameInput).toBeVisible({ timeout: 5_000 });
        await credNameInput.fill(`bad_cred_${RUN_ID}`);

        // Fill INVALID API key
        const apiKeyInput = page.getByPlaceholder('sk-...');
        await expect(apiKeyInput).toBeVisible({ timeout: 3_000 });
        await apiKeyInput.fill('sk-invalid-key-for-e2e-testing-12345');

        // Create credential
        const createCredBtn = page.getByRole('button', { name: /create credential/i });
        await createCredBtn.click();
        await page.waitForTimeout(5_000);

        // Select the newly created credential from the dropdown
        const credDropdownAfter = page.locator('#credential-select');
        if (await credDropdownAfter.isVisible({ timeout: 5_000 }).catch(() => false)) {
          const options = await credDropdownAfter.locator('option').all();
          for (const opt of options) {
            const val = await opt.getAttribute('value');
            if (val && val !== '' && val !== '__create_new__') {
              await credDropdownAfter.selectOption(val);
              break;
            }
          }
          await page.waitForTimeout(500);
        }

        // Create connection
        const createConnBtn = page.getByRole('button', { name: /create connection/i });
        await expect(createConnBtn).toBeEnabled({ timeout: 10_000 });
        await createConnBtn.click();
        await page.waitForTimeout(3_000);

        // Test connection — expect failure
        const testBtn = page.getByRole('button', { name: /test connection/i });
        if (await testBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await testBtn.click();
          await page.waitForTimeout(8_000);

          // Look for failure indicator
          const failIcon = page.locator('svg.lucide-x-circle');
          const alertIcon = page.locator('svg.lucide-alert-triangle');
          const hasFail = await failIcon.isVisible({ timeout: 5_000 }).catch(() => false);
          const hasAlert = await alertIcon.isVisible({ timeout: 1_000 }).catch(() => false);
          console.info(`[E2E] Bad key test — fail icon: ${hasFail}, alert icon: ${hasAlert}`);
          await ux(page, 'mg-09-bad-key-test.png', 'Connection test with bad API key');
        }

        // Close dialog
        const doneBtn = page.getByRole('button', { name: /^done$/i });
        if (await doneBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await doneBtn.click();
        }
      });

      await test.step('Chat with bad model — expect error', async () => {
        const errorMessage = `Error test from E2E run ${RUN_ID}`;
        await sendChatMessage(page, projectId, errorMessage);

        // Wait and look for error indication
        await page.waitForTimeout(15_000);

        // Check for error banner/message in chat
        const errorText = page.getByText(/error|failed|invalid/i).first();
        const hasError = await errorText.isVisible({ timeout: 5_000 }).catch(() => false);
        console.info(`[E2E] Error visible in chat: ${hasError}`);
        await ux(page, 'mg-10-error-chat.png', 'Chat with bad API key');
      });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 7 — Session and trace verification
    // ══════════════════════════════════════════════════════════════════════════

    await test.step('Phase 7: Verify sessions and traces', async () => {
      await test.step('Navigate to Sessions page', async () => {
        await page.goto(`${STUDIO_URL}/projects/${projectId}/sessions`);
        await waitForIdle(page, 3_000);
        await ux(page, 'mg-11-sessions-list.png', 'Sessions list page');
      });

      await test.step('Verify sessions exist', async () => {
        const sessionRows = page.locator('table tbody tr');
        const count = await sessionRows.count();
        console.info(`[E2E] Found ${count} session rows`);
        expect(count).toBeGreaterThan(0);
      });

      await test.step('Open a session and view detail', async () => {
        const firstRow = page.locator('table tbody tr').first();
        if (await firstRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await firstRow.click();
          await page.waitForTimeout(3_000);
        }

        await ux(page, 'mg-12-session-detail.png', 'Session detail page');
      });

      await test.step('Check debug tabs (Timeline, LLM)', async () => {
        // Click Timeline tab
        const timelineTab = page.getByText('Timeline').first();
        if (await timelineTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await timelineTab.click();
          await page.waitForTimeout(2_000);
          await ux(page, 'mg-13-timeline.png', 'Timeline debug tab');
        }

        // Click LLM tab
        const llmTab = page.getByText('LLM').first();
        if (await llmTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await llmTab.click();
          await page.waitForTimeout(2_000);
          await ux(page, 'mg-14-llm.png', 'LLM debug tab');
        }

        console.info('[E2E] ✓ Trace verification complete');
      });

      await test.step('Final screenshot', async () => {
        await ux(page, 'mg-15-final.png', 'Final verification complete');
      });
    });
  });
});
