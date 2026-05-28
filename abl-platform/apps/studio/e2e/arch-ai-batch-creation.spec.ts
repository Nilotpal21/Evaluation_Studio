/**
 * Arch AI Batch Creation Test
 *
 * Tests the complete Arch AI project creation flow end-to-end.
 * Creates N projects (configurable) with diverse use cases and validates:
 * 1. Chat interaction works (message sent, Arch responds)
 * 2. Interactive UI components render (multi-select, single-select)
 * 3. Topology generation succeeds
 * 4. Agent generation or project creation succeeds
 * 5. Project appears in dashboard with agents
 * 6. Agents have valid ABL (no MODE:, no DOMAIN: errors)
 *
 * PASS criteria: All projects created successfully with 0 ABL syntax errors.
 * E721 "tool not found" errors are EXPECTED and NOT counted as failures
 * (tools need to be configured separately in Tool Library).
 *
 * Configuration:
 *   ARCH_BATCH_SIZE=10 npx playwright test e2e/arch-ai-batch-creation.spec.ts
 *   ARCH_BATCH_SIZE=50 npx playwright test e2e/arch-ai-batch-creation.spec.ts --headed
 *   Default: 10 projects
 *
 * Requires: pnpm dev running (Studio on 5173)
 */

import { test, expect, Page } from '@playwright/test';
import {
  checkArchConversationPrerequisites,
  loginViaDevApi,
  type ArchE2EPrerequisites,
} from './helpers';

const STUDIO_URL = process.env.ARCH_STUDIO_URL || 'http://localhost:5173';
const BATCH_SIZE = parseInt(process.env.ARCH_BATCH_SIZE || '10', 10);
const configuredTimeoutMs = parseInt(process.env.ARCH_TIMEOUT_MS || '180000', 10);
const MAX_WAIT_MS = Number.isFinite(configuredTimeoutMs)
  ? Math.min(Math.max(configuredTimeoutMs, 60_000), 180_000)
  : 180_000;
const TEST_LOGIN_NAME = 'Arch AI Batch Creation E2E';
const ARCH_E2E_SMOKE_DOMAIN = '@e2e-smoke.test';

// Diverse use cases for testing
const USE_CASES = [
  'Build a pizza delivery bot that handles orders and tracking via web chat. Friendly tone. 2 agents.',
  'Build a hotel concierge chatbot for room service, spa bookings, and local recommendations. Elegant tone. 3 agents.',
  'Build an IT helpdesk bot for hardware, software, and network troubleshooting via web chat. Professional tone.',
  'Build a real estate assistant that helps with property listings and viewing appointments. Helpful tone. 2 agents.',
  'Build a gym membership bot for signups, class bookings, and billing inquiries. Energetic tone. 2 agents.',
  'Build an airline customer service bot for booking changes, baggage claims, and complaints. Professional tone.',
  'Build a simple FAQ bot for a bakery that answers questions about cakes, prices, and custom orders. Sweet tone. 2 agents.',
  'Build an e-commerce returns bot that handles refunds, exchanges, and order tracking. Patient tone. 2 agents.',
  'Build a doctor appointment scheduler for booking, rescheduling, and canceling visits. Calm tone. 2 agents.',
  'Build a library assistant that helps patrons search books and check availability. Friendly tone. 2 agents.',
  'Build a pet store chatbot for product recommendations and order inquiries. Fun tone. 2 agents.',
  'Build a coffee shop FAQ bot for menu, hours, and loyalty program questions. Casual tone. 2 agents.',
  'Build a car dealership bot for test drive bookings and vehicle inquiries. Professional tone. 2 agents.',
  'Build a fitness trainer bot that creates workout plans and tracks progress. Motivational tone. 2 agents.',
  'Build a travel agency bot for vacation planning and booking assistance. Adventurous tone. 2 agents.',
  'Build a bank customer service bot for account inquiries and transaction issues. Formal tone. 3 agents.',
  'Build a restaurant reservation bot for booking tables and managing waitlists. Polite tone. 2 agents.',
  'Build a music school bot for lesson scheduling and instrument inquiries. Creative tone. 2 agents.',
  'Build a moving company bot for quote requests and scheduling moves. Helpful tone. 2 agents.',
  'Build a dental clinic bot for appointment booking and procedure inquiries. Reassuring tone. 2 agents.',
  'Build a flower shop bot for bouquet orders and delivery scheduling. Cheerful tone. 2 agents.',
  'Build an insurance claims bot for filing and tracking claims. Empathetic tone. 2 agents.',
  'Build a tutoring service bot for session booking and subject matching. Encouraging tone. 2 agents.',
  'Build a spa and wellness bot for treatment bookings and package inquiries. Relaxing tone. 2 agents.',
  'Build a veterinary clinic bot for pet appointments and health questions. Caring tone. 2 agents.',
  'Build a tech support bot for troubleshooting printers, Wi-Fi, and software. Patient tone. 2 agents.',
  'Build a wedding planner bot for venue booking and vendor coordination. Elegant tone. 2 agents.',
  'Build a food truck ordering bot for menu browsing and pickup scheduling. Casual tone. 2 agents.',
  'Build a parking management bot for space reservation and payment. Efficient tone. 2 agents.',
  'Build a childcare center bot for enrollment and schedule inquiries. Warm tone. 2 agents.',
  'Build a home repair service bot for booking plumbers, electricians, and painters. Reliable tone. 2 agents.',
  'Build a yoga studio bot for class scheduling and membership questions. Peaceful tone. 2 agents.',
  'Build a photo studio bot for session booking and package selection. Creative tone. 2 agents.',
  'Build a car wash bot for appointment booking and service selection. Quick tone. 2 agents.',
  'Build a furniture store bot for product inquiries and delivery scheduling. Helpful tone. 2 agents.',
  'Build a language school bot for course enrollment and placement tests. Encouraging tone. 2 agents.',
  'Build an event planning bot for venue search and catering coordination. Organized tone. 2 agents.',
  'Build a pharmacy bot for prescription refills and medication questions. Professional tone. 2 agents.',
  'Build a cleaning service bot for booking house cleaning and estimates. Friendly tone. 2 agents.',
  'Build a karate dojo bot for class enrollment and belt testing schedules. Disciplined tone. 2 agents.',
  'Build a gaming cafe bot for PC reservations and tournament signups. Energetic tone. 2 agents.',
  'Build a laundromat bot for machine availability and pickup scheduling. Simple tone. 2 agents.',
  'Build an art gallery bot for exhibit information and tour booking. Sophisticated tone. 2 agents.',
  'Build a camping gear rental bot for equipment booking and trail recommendations. Adventurous tone. 2 agents.',
  'Build a tailor shop bot for measurements scheduling and order tracking. Refined tone. 2 agents.',
  'Build a dog grooming bot for appointment booking and service selection. Playful tone. 2 agents.',
  'Build a juice bar bot for custom drink orders and nutritional info. Fresh tone. 2 agents.',
  'Build a bowling alley bot for lane reservations and party bookings. Fun tone. 2 agents.',
  'Build a swimming pool bot for lane booking and lesson scheduling. Active tone. 2 agents.',
  'Build a bicycle shop bot for repair bookings and part inquiries. Helpful tone. 2 agents.',
];

interface TestResult {
  index: number;
  useCase: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  projectId?: string;
  agentCount?: number;
  chatResponseReceived: boolean;
  topologyGenerated: boolean;
  projectCreated: boolean;
  syntaxErrors: string[];
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

/** Login via the dev-login flow and wait for dashboard. */
function buildBatchIdentity(index: number): { email: string; name: string } {
  return {
    email: `arch-ai-batch-${index}-${Date.now().toString(36)}${ARCH_E2E_SMOKE_DOMAIN}`,
    name: `${TEST_LOGIN_NAME} ${index}`,
  };
}

async function devLogin(page: Page, index: number): Promise<void> {
  const identity = buildBatchIdentity(index);
  await loginViaDevApi(page, {
    baseUrl: STUDIO_URL,
    email: identity.email,
    name: identity.name,
    landingPath: '/arch',
  });
}

test.describe.serial(`Arch AI Batch Creation - ${BATCH_SIZE} Projects`, () => {
  let prerequisites: ArchE2EPrerequisites = { ok: true, reason: 'ready' };

  test.setTimeout(MAX_WAIT_MS);

  test.beforeAll(async ({ request }) => {
    prerequisites = await checkArchConversationPrerequisites(request);
  });

  test.beforeEach(() => {
    test.skip(!prerequisites.ok, prerequisites.reason);
  });

  for (let i = 0; i < BATCH_SIZE; i++) {
    const useCase = USE_CASES[i % USE_CASES.length];
    const testName = `Project ${i + 1}/${BATCH_SIZE}: ${useCase.slice(0, 60)}...`;

    test(testName, async ({ page }) => {
      const startTime = Date.now();
      const result: TestResult = {
        index: i + 1,
        useCase: useCase.slice(0, 80),
        status: 'FAIL',
        chatResponseReceived: false,
        topologyGenerated: false,
        projectCreated: false,
        syntaxErrors: [],
        duration: 0,
      };

      try {
        // 0. Authenticate
        await devLogin(page, i + 1);

        // 1. Navigate to chat
        await page.goto(`${STUDIO_URL}/arch`);
        await page.waitForSelector('[data-testid="chat-input-textarea"]', { timeout: 15_000 });

        // 2. Send use case
        await page.getByTestId('chat-input-textarea').fill(useCase);
        await page.getByTestId('chat-input-textarea').press('Enter');

        // 3. Wait for first Arch response (interactive UI or text)
        await expect(page.getByText(useCase)).toBeVisible({ timeout: 10_000 });
        await page.waitForFunction(
          () => {
            const text = document.body.innerText;
            return (
              text.includes('Arch is working...') ||
              text.includes('Something else...') ||
              text.includes('Agent Topology') ||
              text.includes('Project Created Successfully') ||
              Boolean(document.querySelector('[role="listbox"], [role="option"]'))
            );
          },
          { timeout: 30_000 },
        );
        result.chatResponseReceived = true;

        // 4. Auto-interact with ask_user components
        // Click first available option for any single_select
        for (let attempt = 0; attempt < 5; attempt++) {
          await page.waitForTimeout(3000);

          // Check for single_select (listbox options)
          const option = page.locator('div[role="listbox"] div[role="option"]').first();
          if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {
            await option.click();
            await page.waitForTimeout(2000);
            continue;
          }

          // Check for multi_select confirm button
          const confirmBtn = page.locator('button:has-text("Confirm")').first();
          if (await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await confirmBtn.click();
            await page.waitForTimeout(2000);
            continue;
          }

          // Check for confirmation buttons (Yes/Generate/Create)
          const yesBtn = page
            .locator(
              'button:has-text("Yes"), button:has-text("Generate the agents"), button:has-text("Create the project now")',
            )
            .first();
          if (await yesBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await yesBtn.click();
            await page.waitForTimeout(2000);
            continue;
          }

          // Check if topology is visible (means we passed the Q&A phase)
          const topologyCard = page.locator('text=Agent Topology');
          if (await topologyCard.isVisible({ timeout: 1000 }).catch(() => false)) {
            result.topologyGenerated = true;
            break;
          }

          // Check if project was created
          const projectCreated = page.locator('text=Project Created Successfully');
          if (await projectCreated.isVisible({ timeout: 1000 }).catch(() => false)) {
            result.projectCreated = true;
            break;
          }
        }

        // 5. If topology visible but agents not generated yet, click Generate
        if (result.topologyGenerated && !result.projectCreated) {
          const generateBtn = page.locator('button:has-text("Generate the agents")');
          if (await generateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await generateBtn.click();
          }

          // Wait for agents or project creation (up to 90s)
          await page.waitForFunction(
            () => {
              const text = document.body.innerText;
              return (
                text.includes('Project Created Successfully') ||
                text.includes('valid') ||
                text.includes('Create the project now')
              );
            },
            { timeout: 90_000 },
          );

          // Click create if available
          const createBtn = page.locator('button:has-text("Create the project now")');
          if (await createBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await createBtn.click();
          }
        }

        // 6. Wait for project creation to complete
        await page.waitForFunction(
          () => {
            const text = document.body.innerText;
            return text.includes('Project Created Successfully') || text.includes('Project ID:');
          },
          { timeout: 60_000 },
        );
        result.projectCreated = true;

        // 7. Extract project ID
        const bodyText = await page.evaluate(() => document.body.innerText);
        const projectIdMatch = bodyText.match(
          /Project ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        );
        if (projectIdMatch) {
          result.projectId = projectIdMatch[1];
        }

        // 8. Navigate to project agents page and check for SYNTAX errors (not E721)
        if (result.projectId) {
          await page.goto(`${STUDIO_URL}/projects/${result.projectId}/agents`);
          await page.waitForTimeout(5000);

          const agentPageText = await page.evaluate(() => document.body.innerText);

          // Count agents
          const agentCountMatch = agentPageText.match(/(\d+) agents?/);
          if (agentCountMatch) {
            result.agentCount = parseInt(agentCountMatch[1]);
          }

          // Check for REAL syntax errors (not E721 tool-not-found)
          const hasModeError = agentPageText.includes('MODE is no longer supported');
          const hasDomainError = agentPageText.includes('DOMAIN is not');
          const hasRoutingError = agentPageText.includes('ROUTING is not');

          if (hasModeError) result.syntaxErrors.push('MODE: keyword used');
          if (hasDomainError) result.syntaxErrors.push('DOMAIN: keyword used');
          if (hasRoutingError) result.syntaxErrors.push('ROUTING: keyword used');
        }

        // 9. Determine pass/fail
        // E721 "tool not found" is NOT a failure — only syntax errors count
        if (result.projectCreated && result.syntaxErrors.length === 0) {
          result.status = 'PASS';
        }
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        if (result.error.includes('Timeout')) {
          result.status = 'TIMEOUT';
        }
      }

      result.duration = Math.round((Date.now() - startTime) / 1000);
      results.push(result);

      // Log progress
      const passed = results.filter((r) => r.status === 'PASS').length;
      const failed = results.filter((r) => r.status === 'FAIL').length;
      const timedOut = results.filter((r) => r.status === 'TIMEOUT').length;
      console.log(
        `[${i + 1}/${BATCH_SIZE}] ${result.status} (${result.duration}s) — ${passed} pass, ${failed} fail, ${timedOut} timeout | ${result.useCase.slice(0, 50)}`,
      );

      // Assert this test passed
      expect(result.syntaxErrors, `Syntax errors: ${result.syntaxErrors.join(', ')}`).toHaveLength(
        0,
      );
      expect(result.projectCreated, 'Project should be created').toBe(true);
    });
  }

  test('Summary Report', async () => {
    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    const timedOut = results.filter((r) => r.status === 'TIMEOUT').length;
    const avgDuration = Math.round(
      results.reduce((sum, r) => sum + r.duration, 0) / results.length,
    );

    console.log('\n========================================');
    console.log('       ARCH AI BATCH TEST REPORT');
    console.log('========================================');
    console.log(`Total:    ${results.length}`);
    console.log(`Passed:   ${passed}`);
    console.log(`Failed:   ${failed}`);
    console.log(`Timeout:  ${timedOut}`);
    console.log(`Avg time: ${avgDuration}s per project`);
    console.log(`Pass rate: ${((passed / results.length) * 100).toFixed(1)}%`);
    console.log('========================================\n');

    // Print table
    console.log('| # | Use Case | Status | Agents | Duration | Errors |');
    console.log('|---|----------|--------|--------|----------|--------|');
    for (const r of results) {
      console.log(
        `| ${r.index} | ${r.useCase.slice(0, 40)}... | ${r.status} | ${r.agentCount ?? '-'} | ${r.duration}s | ${r.syntaxErrors.length > 0 ? r.syntaxErrors.join(', ') : (r.error?.slice(0, 30) ?? 'none')} |`,
      );
    }

    // Assert batch passes
    expect(passed, `Only ${passed}/${results.length} passed`).toBe(results.length);
  });
});
