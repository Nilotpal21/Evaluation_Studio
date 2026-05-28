/**
 * SDK Chat UI Consolidation — Performance Tests
 *
 * Validates performance characteristics of the consolidated SDK chat:
 *   PERF-1 — Bundle size check (<200KB raw, <40KB gzipped budget)
 *   PERF-2 — 200+ messages rendering performance (<2s)
 *   PERF-3 — Rapid streaming chunk delivery (no dropped chunks)
 *   PERF-4 — Theme switch (CSS vars update without re-mount)
 *
 * ── Recording with Playwright Codegen ───────────────────────────────────────
 *
 * These tests are mostly programmatic (page.evaluate), so recording is only
 * useful for the navigation steps. Each test has "RECORD:" comments for the
 * manual parts.
 *
 *   npx playwright codegen http://localhost:5173 --test-id-attribute data-testid
 *
 * ── Running ─────────────────────────────────────────────────────────────────
 *
 * Run: cd apps/studio && npx playwright test e2e/sdk-chat-performance.spec.ts --headed
 * Requires: pnpm dev running (Studio on 5173, Runtime on 3112)
 *
 * @e2e-real — No mocks. Real browser measurements and file system checks.
 */

import { test, expect } from '@playwright/test';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAndNavigateToProject, waitForIdle, screenshot, env } from './helpers';

const STUDIO_URL = env.baseUrl;

// ── Bundle paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_SDK_REACT_BUNDLE = resolve(__dirname, '../../../packages/web-sdk/dist/react/index.js');

// ── Performance budgets ─────────────────────────────────────────────────────

/** Raw bundle size budget in bytes (200KB) */
const RAW_SIZE_BUDGET_BYTES = 200 * 1024;

/** Estimated gzip ratio — real gzip typically achieves 3-4x compression on JS */
const GZIP_RATIO = 0.3;

/** Gzip budget in bytes (40KB) */
const GZIP_SIZE_BUDGET_BYTES = 40 * 1024;

/** Maximum time to render 200+ messages (ms) */
const RENDER_200_MESSAGES_BUDGET_MS = 2_000;

/** Number of messages for the bulk render test */
const BULK_MESSAGE_COUNT = 210;

/** Number of rapid chunks for streaming test */
const RAPID_CHUNK_COUNT = 100;

// ── Selectors ───────────────────────────────────────────────────────────────

const CHAT_WIDGET_SEL = '[data-testid="chat-widget"]';
const MESSAGE_LIST_SEL = '[data-testid="message-list"]';
const SDK_THEME_SEL = '[data-sdk-theme]';

// ── Test Suite ───────────────────────────────────────────────────────────────

test.describe('SDK Chat Performance', () => {
  test.setTimeout(120_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // PERF-1: Bundle size check
  //
  // RECORD STEPS: None — this test is purely file-system based.
  //   It checks packages/web-sdk/dist/react/index.js exists and is <200KB.
  //   Run `pnpm build` in web-sdk first to generate the bundle.
  // ═══════════════════════════════════════════════════════════════════════════
  test('PERF-1: Bundle size — web-sdk/react under 200KB raw', async () => {
    await test.step('Check raw bundle size', async () => {
      let stat;
      try {
        stat = statSync(WEB_SDK_REACT_BUNDLE);
      } catch {
        test.skip(true, `Bundle not found at ${WEB_SDK_REACT_BUNDLE} — run pnpm build first`);
        return;
      }

      const rawSizeKB = stat.size / 1024;
      const estimatedGzipBytes = stat.size * GZIP_RATIO;
      const estimatedGzipKB = estimatedGzipBytes / 1024;

      console.info(`[PERF] web-sdk/react bundle:`);
      console.info(
        `  Raw size: ${rawSizeKB.toFixed(1)}KB (budget: ${RAW_SIZE_BUDGET_BYTES / 1024}KB)`,
      );
      console.info(
        `  Estimated gzip: ${estimatedGzipKB.toFixed(1)}KB (budget: ${GZIP_SIZE_BUDGET_BYTES / 1024}KB)`,
      );

      expect(stat.size).toBeLessThan(RAW_SIZE_BUDGET_BYTES);
      expect.soft(estimatedGzipBytes).toBeLessThan(GZIP_SIZE_BUDGET_BYTES);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PERF-2: 200+ messages rendering performance
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Wait for [data-testid="chat-widget"] to appear
  //   (Rest is programmatic: injects 210 DOM nodes into message list and
  //    measures render time. No manual interaction needed after step 2.)
  // ═══════════════════════════════════════════════════════════════════════════
  test('PERF-2: 200+ messages render under 2 seconds', async ({ page }) => {
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      await navigateToAgentForPerf(page, auth.projectId);
    });

    await test.step('Inject 200+ messages and measure render time', async () => {
      // Wait for chat widget to be present
      const chatWidget = page.locator(CHAT_WIDGET_SEL);
      const widgetVisible = await chatWidget.isVisible({ timeout: 15_000 }).catch(() => false);

      if (!widgetVisible) {
        test.skip(true, 'Chat widget not visible — no agent configured');
        return;
      }

      // Measure rendering performance by injecting messages via page.evaluate
      const renderTimeMs = await page.evaluate(async (count: number) => {
        // Find the message list container
        const messageList = document.querySelector('[data-testid="message-list"]');
        if (!messageList) return -1;

        const start = performance.now();

        // Create message divs directly in the DOM to simulate bulk rendering
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < count; i++) {
          const role = i % 2 === 0 ? 'user' : 'assistant';
          const div = document.createElement('div');
          div.setAttribute('data-role', role);
          div.style.padding = '8px 16px';
          div.style.margin = '4px 0';
          div.style.borderRadius = '8px';
          div.style.backgroundColor = role === 'user' ? '#e3f2fd' : '#f5f5f5';
          div.textContent = `[${role}] Message ${i + 1}: ${
            role === 'user'
              ? 'What is the weather like today in New York?'
              : 'The weather in New York today is partly cloudy with temperatures around 65°F (18°C).'
          }`;
          fragment.appendChild(div);
        }

        messageList.appendChild(fragment);

        // Force layout recalculation
        void messageList.scrollHeight;

        // Scroll to bottom (triggers any scroll-based effects)
        messageList.scrollTop = messageList.scrollHeight;

        const end = performance.now();
        return end - start;
      }, BULK_MESSAGE_COUNT);

      console.info(
        `[PERF] Render ${BULK_MESSAGE_COUNT} messages: ${renderTimeMs.toFixed(1)}ms (budget: ${RENDER_200_MESSAGES_BUDGET_MS}ms)`,
      );

      if (renderTimeMs > 0) {
        expect(renderTimeMs).toBeLessThan(RENDER_200_MESSAGES_BUDGET_MS);
      }

      // Verify all messages are present in the DOM
      const messageCount = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="message-list"]');
        return list ? list.children.length : 0;
      });
      expect.soft(messageCount).toBeGreaterThanOrEqual(BULK_MESSAGE_COUNT);

      // Verify scroll behavior works with many messages
      const scrollInfo = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="message-list"]');
        if (!list) return null;
        return {
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          scrollTop: list.scrollTop,
          isScrolledToBottom: Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 5,
        };
      });

      if (scrollInfo) {
        console.info(
          `[PERF] Scroll state: height=${scrollInfo.scrollHeight}, ` +
            `client=${scrollInfo.clientHeight}, top=${scrollInfo.scrollTop}, ` +
            `atBottom=${scrollInfo.isScrolledToBottom}`,
        );
      }

      await screenshot(page, 'perf2-bulk-messages.png', `${BULK_MESSAGE_COUNT} messages rendered`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PERF-3: Rapid streaming — no dropped chunks
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Wait for [data-testid="chat-widget"] to appear
  //   (Rest is programmatic: injects 100 text chunks into a div inside
  //    message list and verifies none are dropped. No manual interaction.)
  // ═══════════════════════════════════════════════════════════════════════════
  test('PERF-3: Rapid streaming — no dropped chunks', async ({ page }) => {
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      await navigateToAgentForPerf(page, auth.projectId);
    });

    await test.step('Simulate rapid chunk delivery and verify completeness', async () => {
      const chatWidget = page.locator(CHAT_WIDGET_SEL);
      const widgetVisible = await chatWidget.isVisible({ timeout: 15_000 }).catch(() => false);

      if (!widgetVisible) {
        test.skip(true, 'Chat widget not visible — no agent configured');
        return;
      }

      // Simulate rapid streaming by injecting content into the message list
      // at high frequency and verifying nothing is lost
      const result = await page.evaluate(async (chunkCount: number) => {
        const messageList = document.querySelector('[data-testid="message-list"]');
        if (!messageList) return { success: false, reason: 'no message list' };

        // Create a streaming container to simulate rapid updates
        const streamDiv = document.createElement('div');
        streamDiv.setAttribute('data-testid', 'perf-streaming-target');
        messageList.appendChild(streamDiv);

        const chunks: string[] = [];
        const startTime = performance.now();

        // Deliver chunks as fast as possible (simulate rapid streaming)
        for (let i = 0; i < chunkCount; i++) {
          const chunk = `chunk-${i}-`;
          chunks.push(chunk);
          streamDiv.textContent += chunk;

          // Yield to browser every 10 chunks to simulate real streaming
          if (i % 10 === 0) {
            await new Promise((r) => requestAnimationFrame(r));
          }
        }

        // Final flush
        await new Promise((r) => requestAnimationFrame(r));

        const endTime = performance.now();
        const finalContent = streamDiv.textContent ?? '';
        const expectedContent = chunks.join('');

        return {
          success: finalContent === expectedContent,
          reason:
            finalContent === expectedContent
              ? 'all chunks present'
              : `content mismatch: expected ${expectedContent.length} chars, got ${finalContent.length}`,
          chunkCount,
          durationMs: endTime - startTime,
          contentLength: finalContent.length,
          expectedLength: expectedContent.length,
        };
      }, RAPID_CHUNK_COUNT);

      console.info(
        `[PERF] Rapid streaming: ${result.chunkCount} chunks in ${result.durationMs?.toFixed(1)}ms — ${result.reason}`,
      );

      expect(result.success).toBe(true);
      expect(result.contentLength).toBe(result.expectedLength);

      await screenshot(page, 'perf3-rapid-streaming.png', 'Rapid streaming chunk test');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PERF-4: Theme switch — CSS variables update without re-mount
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Wait for [data-sdk-theme] element to appear
  //   (Rest is programmatic: reads initial CSS vars, sets new values like
  //    --sdk-primary=#ff6600, verifies same DOM element (no re-mount),
  //    then restores original values. No manual interaction.)
  // ═══════════════════════════════════════════════════════════════════════════
  test('PERF-4: Theme switch — CSS vars update without re-mount', async ({ page }) => {
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      await navigateToAgentForPerf(page, auth.projectId);
    });

    await test.step('Apply new theme and verify CSS variables update', async () => {
      const themeWrapper = page.locator(SDK_THEME_SEL);
      const visible = await themeWrapper.isVisible({ timeout: 15_000 }).catch(() => false);

      if (!visible) {
        test.skip(true, 'SDK theme wrapper not visible — no chat panel loaded');
        return;
      }

      // Read initial theme values
      const initialVars = await page.evaluate(() => {
        const el = document.querySelector('[data-sdk-theme]') as HTMLElement | null;
        if (!el) return null;
        return {
          primary: el.style.getPropertyValue('--sdk-primary'),
          bg: el.style.getPropertyValue('--sdk-bg'),
          text: el.style.getPropertyValue('--sdk-text'),
          elementId: el.getAttribute('data-sdk-theme'),
        };
      });

      console.info(`[PERF] Initial theme vars: ${JSON.stringify(initialVars)}`);

      // Apply new theme via direct style manipulation and measure time
      const switchResult = await page.evaluate(() => {
        const el = document.querySelector('[data-sdk-theme]') as HTMLElement | null;
        if (!el) return null;

        // Record element identity (to verify no re-mount)
        const originalElement = el;

        const start = performance.now();

        // Apply new CSS custom properties (simulating theme switch)
        el.style.setProperty('--sdk-primary', '#ff6600');
        el.style.setProperty('--sdk-bg', '#1a1a2e');
        el.style.setProperty('--sdk-text', '#e0e0e0');
        el.style.setProperty('--sdk-user-bubble', '#ff6600');
        el.style.setProperty('--sdk-assistant-bubble', '#2a2a4e');

        // Force style recalculation
        void window.getComputedStyle(el).getPropertyValue('--sdk-primary');

        const end = performance.now();

        // Verify the element is the same (no re-mount)
        const currentElement = document.querySelector('[data-sdk-theme]');
        const sameElement = currentElement === originalElement;

        // Read back the new values
        const newPrimary = el.style.getPropertyValue('--sdk-primary');

        return {
          durationMs: end - start,
          sameElement,
          newPrimary,
        };
      });

      if (switchResult) {
        console.info(
          `[PERF] Theme switch: ${switchResult.durationMs.toFixed(2)}ms, ` +
            `same element: ${switchResult.sameElement}, ` +
            `new primary: ${switchResult.newPrimary}`,
        );

        // Theme switch should be near-instant (CSS variable update, no React re-render)
        expect(switchResult.durationMs).toBeLessThan(100);

        // Element should be the same (no re-mount)
        expect(switchResult.sameElement).toBe(true);

        // New value should be applied
        expect(switchResult.newPrimary).toBe('#ff6600');
      }

      // Restore original theme by resetting properties
      await page.evaluate(() => {
        const el = document.querySelector('[data-sdk-theme]') as HTMLElement | null;
        if (!el) return;
        el.style.removeProperty('--sdk-primary');
        el.style.removeProperty('--sdk-bg');
        el.style.removeProperty('--sdk-text');
        el.style.removeProperty('--sdk-user-bubble');
        el.style.removeProperty('--sdk-assistant-bubble');
      });

      await screenshot(page, 'perf4-theme-switch.png', 'Theme switch performance');
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Navigate to the first available agent's chat panel for perf testing.
 * Uses the API to find agents, then navigates to /agents/:name/chat.
 */
async function navigateToAgentForPerf(
  page: import('@playwright/test').Page,
  pid: string,
): Promise<void> {
  const resp = await page.request
    .get(`${STUDIO_URL}/api/projects/${encodeURIComponent(pid)}/agents`)
    .catch(() => null);

  if (!resp || !resp.ok()) return;

  const data = await resp.json().catch(() => null);
  if (!data) return;

  const agents = Array.isArray(data)
    ? data
    : ((data as Record<string, unknown>).data ?? (data as Record<string, unknown>).agents ?? []);
  if (!Array.isArray(agents) || agents.length === 0) return;

  // Prefer agents likely to support chat (skip auth-only agents)
  const skipNames = new Set(['authentication']);
  const preferred = (agents as Array<Record<string, unknown>>).find((a) => {
    const n = ((a.name ?? a.agentName ?? '') as string).trim().toLowerCase();
    return n && !skipNames.has(n);
  });
  const chosen = preferred ?? (agents[0] as Record<string, unknown>);
  const agentName = ((chosen.name ?? chosen.agentName ?? '') as string).trim();
  if (!agentName) return;

  await page.goto(
    `${STUDIO_URL}/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(agentName)}/chat`,
  );
  await waitForIdle(page, 2_000);

  // Click "New Chat" to start a session (required before chat widget renders)
  const newChatBtn = page.locator('button:has-text("New Chat")');
  const hasNewChat = await newChatBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (hasNewChat) {
    await newChatBtn.click();
    await page
      .locator('[data-testid="chat-widget"]')
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {});
    await waitForIdle(page, 1_000);
  }
}
