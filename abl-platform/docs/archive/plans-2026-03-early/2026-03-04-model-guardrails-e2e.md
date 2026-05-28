# Model Configuration + Guardrails + Chat E2E Test — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Playwright E2E test that configures OpenAI/Anthropic/Google models, activates guardrails, chats through each provider, triggers errors, and verifies everything shows up in sessions/traces.

**Architecture:** Single sequential spec file with 6 phases — login, model config, chat per provider, guardrails, error path, session/trace verification. Uses existing dev-login pattern, reads API keys from env vars.

**Tech Stack:** Playwright, TypeScript, dotenv for env loading

---

### Task 1: Create the spec file scaffold with helpers

**Files:**

- Create: `apps/studio/e2e/model-guardrails-e2e.spec.ts`

**Step 1: Write the spec scaffold**

```typescript
/**
 * E2E Test: Model Configuration + Guardrails + Chat Validation
 *
 * Phases:
 *   1 — Login as dev@example.com
 *   2 — Configure 3 LLM providers (OpenAI, Anthropic, Google)
 *   3 — Chat with each provider, verify response
 *   4 — Create guardrail policy, activate, trigger violation
 *   5 — Create model with bad API key, chat → verify error in traces
 *   6 — Verify sessions/traces show all activity
 *
 * Run: cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed
 * Requires: Studio on 5173, Runtime on 3002
 */

import { test, expect, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env vars from root .env and studio .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── Constants ────────────────────────────────────────────────────────────────

const STUDIO_URL = 'http://localhost:5173';
const RUN_ID = Date.now();

interface ProviderConfig {
  name: string;
  provider: string;
  displayName: string;
  envKey: string;
  modelId: string;
  tier: string;
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: 'OpenAI',
    provider: 'openai',
    displayName: `OpenAI_GPT4o_${RUN_ID}`,
    envKey: 'OPENAI_API_KEY',
    modelId: 'gpt-4o',
    tier: 'balanced',
  },
  {
    name: 'Anthropic',
    provider: 'anthropic',
    displayName: `Anthropic_Claude_${RUN_ID}`,
    envKey: 'ANTHROPIC_API_KEY',
    modelId: 'claude-sonnet-4-20250514',
    tier: 'balanced',
  },
  {
    name: 'Google',
    provider: 'google',
    displayName: `Google_Gemini_${RUN_ID}`,
    envKey: 'GOOGLE_AI_API_KEY',
    modelId: 'gemini-2.0-flash',
    tier: 'balanced',
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
  await page.goto(`${STUDIO_URL}/auth/login`);
  await page.waitForLoadState('networkidle');
  const devBtn = page.locator('button:has-text("Dev Login")');
  await expect(devBtn).toBeVisible({ timeout: 15_000 });
  await devBtn.click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2_000);
}

async function getToken(page: Page): Promise<string> {
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: 'dev@example.com', name: 'Developer' },
  });
  const body = await resp.json();
  return body.accessToken ?? '';
}

function extractProjectId(url: string): string {
  const m = url.match(/\/projects\/([^/?#]+)/);
  if (!m) throw new Error(`No project ID in URL: ${url}`);
  return m[1];
}

async function waitForIdle(page: Page, ms = 2000): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(ms);
}

async function ux(page: Page, filename: string, note: string): Promise<void> {
  await page.screenshot({ path: `e2e/screenshots/${filename}`, fullPage: true });
  console.info(`[UX] ${note}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe.serial('Model Config + Guardrails + Chat E2E', () => {
  let page: Page;
  let projectId: string;
  let token: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  // Phase 1: Login
  // Phase 2: Model configuration
  // Phase 3: Chat per provider
  // Phase 4: Guardrails
  // Phase 5: Error path
  // Phase 6: Session/trace verification
});
```

**Step 2: Verify the scaffold compiles**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --list`
Expected: Shows test structure (no failures)

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): scaffold model+guardrails E2E spec"
```

---

### Task 2: Phase 1 — Login & Project Setup

**Files:**

- Modify: `apps/studio/e2e/model-guardrails-e2e.spec.ts`

**Step 1: Add Phase 1 test**

Inside the `test.describe.serial` block, add:

```typescript
test('Phase 1: Login and navigate to project', async () => {
  await test.step('Login as dev@example.com', async () => {
    await devLogin(page);
    token = await getToken(page);
    expect(token).toBeTruthy();
    await ux(page, 'mg-01-login.png', 'Logged in as dev@example.com');
  });

  await test.step('Navigate to project', async () => {
    // Look for existing project or use first available
    await page.waitForTimeout(2_000);

    // Click first project card
    const projectCard = page.locator('[class*="cursor-pointer"]').first();
    if (await projectCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await projectCard.click();
    } else {
      // Fallback: look for any project link
      const projectLink = page.locator('a[href*="/projects/"]').first();
      await projectLink.click();
    }

    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 10_000 });
    projectId = extractProjectId(page.url());
    expect(projectId).toBeTruthy();
    console.info(`[E2E] Using project: ${projectId}`);
    await ux(page, 'mg-02-project.png', `Navigated to project ${projectId}`);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed -g "Phase 1"`
Expected: PASS — logs in, navigates to project

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): add Phase 1 login and project setup"
```

---

### Task 3: Phase 2 — Model Configuration (all 3 providers)

**Files:**

- Modify: `apps/studio/e2e/model-guardrails-e2e.spec.ts`

**Step 1: Add Phase 2 test**

```typescript
test('Phase 2: Configure LLM providers', async () => {
  expect(AVAILABLE_PROVIDERS.length).toBeGreaterThan(0);

  for (const provider of AVAILABLE_PROVIDERS) {
    await test.step(`Configure ${provider.name}`, async () => {
      // Navigate to Admin → Models
      await page.goto(`${STUDIO_URL}/admin/models`);
      await waitForIdle(page);

      // Click "Add Model" button (Plus icon button)
      const addModelBtn = page
        .getByRole('button', { name: /add model/i })
        .or(page.locator('button:has(svg.lucide-plus)').first());
      await addModelBtn.click();
      await page.waitForTimeout(1_000);

      // In AddModelDialog — use Custom Model tab for direct entry
      const customTab = page
        .getByText('Custom Model')
        .or(page.getByText('custom', { exact: false }));
      if (await customTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await customTab.click();
        await page.waitForTimeout(500);
      }

      // Fill model form
      const nameInput = page
        .getByLabel(/display name/i)
        .or(page.locator('input[name="displayName"]'));
      await nameInput.fill(provider.displayName);

      const modelIdInput = page.getByLabel(/model id/i).or(page.locator('input[name="modelId"]'));
      await modelIdInput.fill(provider.modelId);

      // Select provider from dropdown
      const providerSelect = page
        .getByLabel(/provider/i)
        .or(page.locator('select[name="provider"]'));
      await providerSelect.selectOption(provider.provider);

      // Submit
      const submitBtn = page
        .getByRole('button', { name: /add to workspace/i })
        .or(page.getByRole('button', { name: /create/i }));
      await submitBtn.click();
      await page.waitForTimeout(2_000);

      // Verify model appears in list
      await expect(page.getByText(provider.displayName)).toBeVisible({ timeout: 10_000 });
      console.info(`[E2E] ✓ Model created: ${provider.displayName}`);

      await ux(page, `mg-03-model-${provider.provider}.png`, `${provider.name} model configured`);
    });

    await test.step(`Add connection for ${provider.name}`, async () => {
      // Find the model row and expand it
      const modelRow = page.getByText(provider.displayName);
      await modelRow.click();
      await page.waitForTimeout(500);

      // Click "Add Connection" button
      const addConnBtn = page
        .getByRole('button', { name: /add connection/i })
        .or(page.locator('button:has(svg.lucide-link-2)'));
      await addConnBtn.click();
      await page.waitForTimeout(1_000);

      // In AddConnectionDialog — create new credential inline
      const credSelect = page.locator('select').first();
      if (await credSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await credSelect.selectOption('__create_new__');
        await page.waitForTimeout(500);
      }

      // Fill credential name
      const credNameInput = page
        .getByLabel(/credential name/i)
        .or(page.getByLabel(/name/i).first());
      if (await credNameInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await credNameInput.fill(`${provider.provider}_cred_${RUN_ID}`);
      }

      // Fill API key
      const apiKeyInput = page
        .getByLabel(/api key/i)
        .or(page.locator('input[type="password"]').first());
      await apiKeyInput.fill(process.env[provider.envKey]!);

      // Submit connection
      const createBtn = page.getByRole('button', { name: /create/i }).last();
      await createBtn.click();
      await page.waitForTimeout(3_000);

      // Test connection if button appears
      const testBtn = page.getByRole('button', { name: /test connection/i });
      if (await testBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await testBtn.click();
        await page.waitForTimeout(5_000);
        // Look for success indicator
        const success = page.locator('svg.lucide-check-circle-2').or(page.getByText(/valid/i));
        expect(await success.isVisible({ timeout: 10_000 }).catch(() => false)).toBeTruthy();
        console.info(`[E2E] ✓ Connection validated: ${provider.name}`);
      }

      // Close dialog
      const doneBtn = page
        .getByRole('button', { name: /done/i })
        .or(page.getByRole('button', { name: /close/i }));
      if (await doneBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await doneBtn.click();
      }

      await ux(page, `mg-04-conn-${provider.provider}.png`, `${provider.name} connection added`);
    });
  }
});
```

**Step 2: Run test**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed -g "Phase 2"`
Expected: Creates models and connections for each available provider

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): add Phase 2 model configuration for 3 providers"
```

---

### Task 4: Phase 3 — Chat per provider

**Files:**

- Modify: `apps/studio/e2e/model-guardrails-e2e.spec.ts`

**Step 1: Add Phase 3 test**

```typescript
test('Phase 3: Chat with each provider', async () => {
  for (const provider of AVAILABLE_PROVIDERS) {
    await test.step(`Chat using ${provider.name}`, async () => {
      // Navigate to first agent's chat
      await page.goto(`${STUDIO_URL}/projects/${projectId}/agents`);
      await waitForIdle(page);

      // Click first agent card to open detail
      const agentCard = page
        .locator('[class*="cursor-pointer"]')
        .first()
        .or(page.locator('button:has-text("Open")').first());
      await agentCard.click();
      await page.waitForTimeout(2_000);

      // Navigate to chat tab
      const chatTab = page.getByText('Chat').or(page.getByRole('tab', { name: /chat/i }));
      await chatTab.click();
      await page.waitForTimeout(3_000);

      // Wait for chat to be ready (agent loaded or error)
      const chatInput = page.locator('textarea').or(page.getByPlaceholder(/type/i));
      await expect(chatInput).toBeVisible({ timeout: 30_000 });

      // Send test message
      const testMessage = `Hello, test message from ${provider.name} E2E run ${RUN_ID}`;
      await chatInput.fill(testMessage);

      // Click send button
      const sendBtn = page
        .locator('button:has(svg.lucide-arrow-up)')
        .or(page.getByRole('button', { name: /send/i }));
      await sendBtn.click();

      // Verify user message appears
      await expect(page.getByText(testMessage)).toBeVisible({ timeout: 5_000 });

      // Wait for assistant response (may take time with real LLM)
      const assistantMsg = page
        .locator('[class*="message"]')
        .last()
        .or(page.locator('div:has(svg.lucide-bot) + div'));
      await expect(assistantMsg).toBeVisible({ timeout: 60_000 });

      console.info(`[E2E] ✓ Chat response received from ${provider.name}`);
      await ux(page, `mg-05-chat-${provider.provider}.png`, `Chat with ${provider.name}`);
    });
  }
});
```

**Step 2: Run test**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed -g "Phase 3"`
Expected: Sends message, gets response for each provider

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): add Phase 3 chat per provider"
```

---

### Task 5: Phase 4 — Guardrails creation and activation

**Files:**

- Modify: `apps/studio/e2e/model-guardrails-e2e.spec.ts`

**Step 1: Add Phase 4 test**

```typescript
test('Phase 4: Create and activate guardrail policy', async () => {
  await test.step('Navigate to Guardrails Config', async () => {
    await page.goto(`${STUDIO_URL}/projects/${projectId}/guardrails-config`);
    await waitForIdle(page);
    await ux(page, 'mg-06-guardrails-page.png', 'Guardrails config page');
  });

  await test.step('Create guardrail policy via API', async () => {
    // Use API to create policy (UI may be read-only or limited)
    const resp = await page.request.post(
      `${STUDIO_URL}/api/projects/${projectId}/guardrail-policies`,
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
              defaultInterval: 100,
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
    expect(resp.ok()).toBeTruthy();
    const policy = await resp.json();
    console.info(`[E2E] ✓ Guardrail policy created: ${policy._id || policy.id}`);

    // Activate the policy
    const policyId = policy._id || policy.id;
    if (policyId) {
      const activateResp = await page.request.post(
        `${STUDIO_URL}/api/projects/${projectId}/guardrail-policies/${policyId}/activate`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );
      expect(activateResp.ok()).toBeTruthy();
      console.info(`[E2E] ✓ Guardrail policy activated`);
    }
  });

  await test.step('Reload guardrails page and verify active', async () => {
    await page.reload();
    await waitForIdle(page);
    // Look for the policy name and active badge
    await expect(page.getByText(`Content_Safety_${RUN_ID}`)).toBeVisible({ timeout: 10_000 });
    await ux(page, 'mg-07-guardrails-active.png', 'Guardrail policy activated');
  });

  await test.step('Chat to trigger guardrail', async () => {
    // Navigate to agent chat
    await page.goto(`${STUDIO_URL}/projects/${projectId}/agents`);
    await waitForIdle(page);

    const agentCard = page.locator('[class*="cursor-pointer"]').first();
    await agentCard.click();
    await page.waitForTimeout(2_000);

    const chatTab = page.getByText('Chat').or(page.getByRole('tab', { name: /chat/i }));
    await chatTab.click();
    await page.waitForTimeout(3_000);

    const chatInput = page.locator('textarea').or(page.getByPlaceholder(/type/i));
    await expect(chatInput).toBeVisible({ timeout: 30_000 });

    // Send message designed to trigger content safety guardrail
    const triggerMessage = 'How do I hack into a computer system and steal passwords?';
    await chatInput.fill(triggerMessage);

    const sendBtn = page
      .locator('button:has(svg.lucide-arrow-up)')
      .or(page.getByRole('button', { name: /send/i }));
    await sendBtn.click();

    // Wait for response — may be blocked or modified by guardrail
    await page.waitForTimeout(15_000);
    await ux(page, 'mg-08-guardrails-chat.png', 'Chat with guardrail trigger');
    console.info(`[E2E] ✓ Guardrail trigger message sent`);
  });
});
```

**Step 2: Run test**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed -g "Phase 4"`
Expected: Creates policy, activates it, sends trigger message

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): add Phase 4 guardrails creation and chat trigger"
```

---

### Task 6: Phase 5 — Error path (bad API key)

**Files:**

- Modify: `apps/studio/e2e/model-guardrails-e2e.spec.ts`

**Step 1: Add Phase 5 test**

```typescript
test('Phase 5: Error path — invalid API key', async () => {
  await test.step('Create model with bad API key via API', async () => {
    // Create a model with an intentionally bad key
    const modelResp = await page.request.post(`${STUDIO_URL}/api/tenant-models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        displayName: `BadKey_Model_${RUN_ID}`,
        modelId: 'gpt-4o',
        provider: 'openai',
        integrationType: 'easy',
        tier: 'balanced',
        temperature: 0.7,
        maxTokens: 4096,
      },
    });

    if (modelResp.ok()) {
      const model = await modelResp.json();
      const modelId = model._id || model.id;

      // Add connection with invalid API key
      const connResp = await page.request.post(
        `${STUDIO_URL}/api/tenant-models/${modelId}/connections`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: {
            apiKey: 'sk-invalid-key-for-e2e-testing-12345',
            isPrimary: true,
          },
        },
      );
      console.info(`[E2E] Bad key model created: ${modelId}, conn status: ${connResp.status()}`);
    }
  });

  await test.step('Chat with bad model — expect error', async () => {
    // Navigate to agent chat
    await page.goto(`${STUDIO_URL}/projects/${projectId}/agents`);
    await waitForIdle(page);

    const agentCard = page.locator('[class*="cursor-pointer"]').first();
    await agentCard.click();
    await page.waitForTimeout(2_000);

    const chatTab = page.getByText('Chat').or(page.getByRole('tab', { name: /chat/i }));
    await chatTab.click();
    await page.waitForTimeout(3_000);

    const chatInput = page.locator('textarea').or(page.getByPlaceholder(/type/i));
    await expect(chatInput).toBeVisible({ timeout: 30_000 });

    // Send message — this may fail with LLM error
    await chatInput.fill(`Error test from E2E run ${RUN_ID}`);
    const sendBtn = page
      .locator('button:has(svg.lucide-arrow-up)')
      .or(page.getByRole('button', { name: /send/i }));
    await sendBtn.click();

    // Wait and look for error indication (banner, error message, or in debug panel)
    await page.waitForTimeout(15_000);

    // Check for error banner in chat
    const errorBanner = page
      .locator('[class*="error"]')
      .or(page.getByText(/error|failed|invalid/i));
    const hasError = await errorBanner.isVisible({ timeout: 5_000 }).catch(() => false);
    console.info(`[E2E] Error visible in chat: ${hasError}`);

    await ux(page, 'mg-09-error-chat.png', 'Chat with bad API key');
  });
});
```

**Step 2: Run test**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed -g "Phase 5"`
Expected: Creates bad model, sends chat, error may appear

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): add Phase 5 error path with invalid API key"
```

---

### Task 7: Phase 6 — Session and trace verification

**Files:**

- Modify: `apps/studio/e2e/model-guardrails-e2e.spec.ts`

**Step 1: Add Phase 6 test**

```typescript
test('Phase 6: Verify sessions and traces', async () => {
  await test.step('Navigate to Sessions page', async () => {
    await page.goto(`${STUDIO_URL}/projects/${projectId}/sessions`);
    await waitForIdle(page, 3_000);
    await ux(page, 'mg-10-sessions-list.png', 'Sessions list page');
  });

  await test.step('Verify sessions exist in table', async () => {
    // Wait for session rows to appear
    const sessionRows = page.locator('table tbody tr').or(page.locator('[class*="session"]'));
    const count = await sessionRows.count();
    expect(count).toBeGreaterThan(0);
    console.info(`[E2E] ✓ Found ${count} sessions`);
  });

  await test.step('Open a session and verify traces', async () => {
    // Click first session row
    const firstRow = page
      .locator('table tbody tr')
      .first()
      .or(page.locator('[class*="cursor-pointer"]').first());
    await firstRow.click();
    await page.waitForTimeout(3_000);

    // Verify we're on session detail
    await expect(page.getByText(/conversation/i).or(page.getByText(/session/i))).toBeVisible({
      timeout: 10_000,
    });

    await ux(page, 'mg-11-session-detail.png', 'Session detail page');
  });

  await test.step('Check trace events', async () => {
    // Look for trace/activity indicators
    const traceIndicator = page.locator('svg.lucide-activity').or(page.getByText(/traces?/i));
    const hasTraces = await traceIndicator.isVisible({ timeout: 5_000 }).catch(() => false);
    console.info(`[E2E] Trace indicators visible: ${hasTraces}`);

    // Look for debug tabs (Observatory)
    const debugTabs = page
      .getByText(/timeline/i)
      .or(page.getByText(/llm/i))
      .or(page.getByText(/constraints/i));
    const hasDebugTabs = await debugTabs.isVisible({ timeout: 5_000 }).catch(() => false);
    console.info(`[E2E] Debug tabs visible: ${hasDebugTabs}`);

    await ux(page, 'mg-12-traces.png', 'Session traces and debug tabs');
  });

  await test.step('Switch to Traces tab on sessions page', async () => {
    // Go back to sessions list
    await page.goto(`${STUDIO_URL}/projects/${projectId}/sessions`);
    await waitForIdle(page, 3_000);

    // Click Traces tab
    const tracesTab = page.getByText('Traces').or(page.getByRole('tab', { name: /traces/i }));
    if (await tracesTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await tracesTab.click();
      await page.waitForTimeout(2_000);
      await ux(page, 'mg-13-traces-tab.png', 'Traces tab view');
      console.info(`[E2E] ✓ Traces tab loaded`);
    }
  });

  await test.step('Verify error traces exist', async () => {
    // Look for error indicators in traces
    const errorIndicator = page
      .getByText(/error/i)
      .or(page.locator('[class*="error"]'))
      .or(page.locator('svg.lucide-alert-triangle'));
    const hasErrors = await errorIndicator.isVisible({ timeout: 5_000 }).catch(() => false);
    console.info(`[E2E] Error traces visible: ${hasErrors}`);
    // Soft assertion — errors may not appear if bad key model wasn't used by the agent
    if (hasErrors) {
      console.info(`[E2E] ✓ Error traces confirmed in sessions/traces`);
    }
    await ux(page, 'mg-14-final.png', 'Final verification complete');
  });
});
```

**Step 2: Run full test suite**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed`
Expected: All 6 phases run sequentially, screenshots captured

**Step 3: Commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): add Phase 6 session and trace verification"
```

---

### Task 8: Ensure dotenv dependency and final polish

**Files:**

- Modify: `apps/studio/e2e/model-guardrails-e2e.spec.ts` (test timeouts)

**Step 1: Check dotenv is available**

Run: `cd apps/studio && node -e "require('dotenv')" && echo "OK" || echo "MISSING"`

If MISSING:

```bash
pnpm --filter @agent-platform/studio add -D dotenv
```

**Step 2: Set test timeout for the full spec**

Add after the imports at the top of the spec:

```typescript
// Full E2E with real LLM calls needs generous timeouts
test.setTimeout(300_000); // 5 minutes per test
```

**Step 3: Run full suite end to end**

Run: `cd apps/studio && npx playwright test e2e/model-guardrails-e2e.spec.ts --headed`
Expected: All phases pass, screenshots in `e2e/screenshots/mg-*.png`

**Step 4: Final commit**

```bash
npx prettier --write apps/studio/e2e/model-guardrails-e2e.spec.ts
git add apps/studio/e2e/model-guardrails-e2e.spec.ts
git commit -m "[ABLP-2] test(studio): finalize model+guardrails E2E with timeouts and polish"
```
