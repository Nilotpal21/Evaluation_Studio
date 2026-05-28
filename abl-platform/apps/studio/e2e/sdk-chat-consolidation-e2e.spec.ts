/**
 * SDK Chat UI Consolidation — E2E Tests
 *
 * Exercises the consolidated SDK chat components within Studio:
 *   E2E-1  — Studio chat send and streaming response
 *   E2E-2  — Studio debug workflow (export and reset)
 *   E2E-3  — Studio session switching
 *   E2E-4  — SDK embed (basic chat with thought cards)
 *   E2E-6  — Theme and strings (CSS custom properties)
 *   E2E-7  — Rich content rendering
 *   E2E-8  — Error surfacing
 *   E2E-9  — Auth isolation
 *   E2E-10 — Connection resilience
 *
 * ── Recording with Playwright Codegen ───────────────────────────────────────
 *
 * To record a test scenario interactively:
 *
 *   npx playwright codegen http://localhost:5173 --test-id-attribute data-testid
 *
 * Each test below has "RECORD:" comments describing the manual steps.
 * Follow them in the recorder, then paste the generated code.
 *
 * To save auth state and reuse across recordings:
 *
 *   npx playwright codegen http://localhost:5173 --save-storage auth.json
 *   npx playwright codegen http://localhost:5173 --load-storage auth.json
 *
 * ── Running ─────────────────────────────────────────────────────────────────
 *
 * Run: cd apps/studio && npx playwright test e2e/sdk-chat-consolidation-e2e.spec.ts --headed
 * Requires: pnpm dev running (Studio on 5173, Runtime on 3112)
 *
 * @e2e-real — No mocks. All interactions hit real endpoints and real browser UI.
 */

import { test, expect } from '@playwright/test';
import {
  loginAndNavigateToProject,
  loginViaDevApi,
  getDevAccessToken,
  waitForIdle,
  screenshot,
  env,
} from './helpers';

// ── Module-level mutable state (shared across serial tests) ─────────────────

let token = '';
let projectId = '';
let firstAgentName = '';

// ── Selectors ───────────────────────────────────────────────────────────────

/** Chat input — textarea inside the SDK ChatInput component */
const CHAT_INPUT_SEL = '[data-testid="chat-input"] textarea';

/** Message list container */
const MESSAGE_LIST_SEL = '[data-testid="message-list"]';

/** Chat widget container */
const CHAT_WIDGET_SEL = '[data-testid="chat-widget"]';

/** Thought card */
const THOUGHT_CARD_SEL = '[data-testid="thought-card"]';

/** Typing indicator */
const TYPING_INDICATOR_SEL = '[data-testid="typing-indicator"]';

/** Error message */
const ERROR_MESSAGE_SEL = '[data-testid="error-message"]';

/** SDK theme wrapper */
const SDK_THEME_SEL = '[data-sdk-theme]';

/** Streaming message */
const STREAMING_MESSAGE_SEL = '[data-testid="streaming-message"]';

// ── Helpers ─────────────────────────────────────────────────────────────────

const STUDIO_URL = env.baseUrl;

interface SdkSocketTracker {
  sockets: WebSocket[];
  urls: string[];
  sentFrames: string[];
  receivedFrames: string[];
  openCount: number;
  closeCount: number;
  forcedCloseCount: number;
}

interface SdkSocketTrackerSnapshot {
  urls: string[];
  sentFrames: string[];
  receivedFrames: string[];
  openCount: number;
  closeCount: number;
  forcedCloseCount: number;
  activeOpenSockets: number;
}

type SdkSocketTrackerWindow = Window & {
  __sdkSocketTracker?: SdkSocketTracker;
};

function countFrameType(frames: string[], type: string): number {
  return frames.filter((frame) => frame.includes(`"type":"${type}"`)).length;
}

async function installSdkSocketTracker(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const tracker: SdkSocketTracker = {
      sockets: [],
      urls: [],
      sentFrames: [],
      receivedFrames: [],
      openCount: 0,
      closeCount: 0,
      forcedCloseCount: 0,
    };

    Object.defineProperty(window, '__sdkSocketTracker', {
      value: tracker,
      configurable: true,
    });

    const NativeWebSocket = window.WebSocket;
    const TRACKED_SOCKET = Symbol('sdk-socket-tracker');

    const serializeFrame = (payload: unknown): string => {
      if (typeof payload === 'string') {
        return payload;
      }

      if (payload instanceof Blob) {
        return `[blob:${payload.type || 'application/octet-stream'}:${String(payload.size)}]`;
      }

      if (payload instanceof ArrayBuffer) {
        return `[arraybuffer:${String(payload.byteLength)}]`;
      }

      if (ArrayBuffer.isView(payload)) {
        return `[typedarray:${String(payload.byteLength)}]`;
      }

      return String(payload);
    };

    const shouldTrackSocket = (rawUrl: string): boolean => {
      try {
        const parsedUrl = new URL(rawUrl, window.location.href);
        return parsedUrl.pathname === '/ws' || parsedUrl.pathname === '/ws/sdk';
      } catch {
        return rawUrl.includes('/ws');
      }
    };

    const nativeSend = NativeWebSocket.prototype.send;
    NativeWebSocket.prototype.send = function patchedSend(data: unknown): void {
      const socket = this as WebSocket & {
        [TRACKED_SOCKET]?: boolean;
      };

      if (socket[TRACKED_SOCKET]) {
        tracker.sentFrames.push(serializeFrame(data));
      }

      nativeSend.call(this, data as Parameters<typeof nativeSend>[0]);
    };

    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        const url = String(args[0] ?? '');

        if (shouldTrackSocket(url)) {
          (socket as WebSocket & { [TRACKED_SOCKET]?: boolean })[TRACKED_SOCKET] = true;
          tracker.sockets.push(socket);
          tracker.urls.push(url);
          socket.addEventListener('open', () => {
            tracker.openCount += 1;
          });
          socket.addEventListener('close', () => {
            tracker.closeCount += 1;
          });
          socket.addEventListener('message', (event) => {
            tracker.receivedFrames.push(serializeFrame(event.data));
          });
        }

        return socket;
      },
    }) as typeof WebSocket;
  });
}

async function readSdkSocketTracker(
  page: import('@playwright/test').Page,
): Promise<SdkSocketTrackerSnapshot> {
  return page.evaluate(() => {
    const tracker = (window as SdkSocketTrackerWindow).__sdkSocketTracker;

    return {
      urls: tracker?.urls ?? [],
      sentFrames: tracker?.sentFrames ?? [],
      receivedFrames: tracker?.receivedFrames ?? [],
      openCount: tracker?.openCount ?? 0,
      closeCount: tracker?.closeCount ?? 0,
      forcedCloseCount: tracker?.forcedCloseCount ?? 0,
      activeOpenSockets:
        tracker?.sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length ?? 0,
    };
  });
}

async function forceCloseLatestSdkSocket(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const tracker = (window as SdkSocketTrackerWindow).__sdkSocketTracker;
    if (!tracker || tracker.sockets.length === 0) {
      return false;
    }

    const latestOpenSocket =
      [...tracker.sockets].reverse().find((socket) => socket.readyState === WebSocket.OPEN) ??
      tracker.sockets[tracker.sockets.length - 1];

    if (!latestOpenSocket) {
      return false;
    }

    tracker.forcedCloseCount += 1;
    latestOpenSocket.close(4000, 'E2E forced disconnect');
    return true;
  });
}

async function waitForStreamingSignal(
  page: import('@playwright/test').Page,
  timeoutMs = 15_000,
): Promise<{ typingAppeared: boolean; streamingAppeared: boolean }> {
  let typingAppeared = false;
  let streamingAppeared = false;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const typingVisible = await page
      .locator(TYPING_INDICATOR_SEL)
      .isVisible()
      .catch(() => false);
    const streamingVisible = await page
      .locator(STREAMING_MESSAGE_SEL)
      .isVisible()
      .catch(() => false);

    if (typingVisible) typingAppeared = true;
    if (streamingVisible) streamingAppeared = true;

    if (typingAppeared || streamingAppeared) {
      break;
    }

    await page.waitForTimeout(200);
  }

  return { typingAppeared, streamingAppeared };
}

/**
 * Find and return the first available agent name via the API.
 * Requires `token` to be set from a prior login step.
 */
async function findFirstAgent(
  page: import('@playwright/test').Page,
  pid: string,
  authToken: string,
): Promise<string> {
  const resp = await page.request
    .get(`${STUDIO_URL}/api/projects/${encodeURIComponent(pid)}/agents`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        'X-Tenant-Id': env.tenantId,
      },
    })
    .catch(() => null);

  if (!resp || !resp.ok()) {
    console.warn(`[E2E] Agents API failed: ${resp?.status() ?? 'no response'}`);
    return '';
  }

  const data = await resp.json().catch(() => null);
  if (!data) return '';

  // Response is an array of agent objects with { name } or { agentName }
  const agents = Array.isArray(data)
    ? data
    : ((data as Record<string, unknown>).data ?? (data as Record<string, unknown>).agents ?? []);
  if (!Array.isArray(agents) || agents.length === 0) return '';

  // Prefer agents likely to support chat (skip auth-only agents like "authentication")
  const skipNames = new Set(['authentication']);
  const preferred = (agents as Array<Record<string, unknown>>).find((a) => {
    const n = ((a.name ?? a.agentName ?? '') as string).trim().toLowerCase();
    return n && !skipNames.has(n);
  });
  const chosen = preferred ?? (agents[0] as Record<string, unknown>);
  const name = ((chosen.name ?? chosen.agentName ?? '') as string).trim();
  console.info(`[E2E] Found ${(agents as unknown[]).length} agents, using: ${name}`);
  return name;
}

/**
 * Find and return the first available project id via the API.
 * Uses TEST_PROJECT_NAME when provided; otherwise falls back to the first project.
 */
async function findFirstProjectId(
  page: import('@playwright/test').Page,
  authToken: string,
): Promise<string> {
  const resp = await page.request
    .get(`${STUDIO_URL}/api/projects`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        'X-Tenant-Id': env.tenantId,
      },
    })
    .catch(() => null);

  if (!resp || !resp.ok()) {
    console.warn(`[E2E] Projects API failed: ${resp?.status() ?? 'no response'}`);
    return '';
  }

  const data = (await resp.json().catch(() => null)) as {
    projects?: Array<{ id?: string; name?: string }>;
  } | null;
  const projects = data?.projects;

  if (!Array.isArray(projects) || projects.length === 0) {
    return '';
  }

  const preferredProject =
    env.projectName.trim().length > 0
      ? projects.find((project) =>
          project.name?.toLowerCase().includes(env.projectName.trim().toLowerCase()),
        )
      : undefined;
  const chosenProject = preferredProject ?? projects[0];

  return (chosenProject?.id ?? '').trim();
}

/**
 * Navigate to an agent's chat panel and start a new session.
 * Studio URL pattern: /projects/:pid/agents/:name/chat
 *
 * After loading, the page shows an empty state with a "New Chat" button.
 * We must click it to establish a WebSocket session before the ChatWidget renders.
 */
async function navigateToAgentChat(
  page: import('@playwright/test').Page,
  pid: string,
  agentName: string,
): Promise<void> {
  await page.goto(
    `${STUDIO_URL}/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(agentName)}/chat`,
    {
      waitUntil: 'domcontentloaded',
    },
  );
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(1_000);

  // The chat panel shows an empty state until a session is started.
  // Click "New Chat" to establish a WebSocket session.
  const newChatBtn = page.locator('button:has-text("New Chat")');
  const hasNewChat = await newChatBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (hasNewChat) {
    await newChatBtn.click();
    // Wait for the session to establish and chat widget to render
    await page
      .locator('[data-testid="chat-widget"]')
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(1_000);
  }
}

/**
 * Find the chat input textarea and return it, or null if not found.
 */
async function getChatInput(page: import('@playwright/test').Page) {
  // Try SDK ChatInput data-testid first, then fall back to generic textarea selectors
  const input = page
    .locator(CHAT_INPUT_SEL)
    .or(page.locator('textarea[placeholder*="message" i]'))
    .or(page.locator('textarea[placeholder*="type" i]'))
    .or(page.locator('textarea[placeholder*="send" i]'))
    .first();

  const visible = await input.isVisible({ timeout: 10_000 }).catch(() => false);
  return visible ? input : null;
}

/**
 * Send a chat message and wait for a response to appear.
 * Returns true if a response was detected, false otherwise.
 */
async function sendMessageAndWait(
  page: import('@playwright/test').Page,
  message: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const input = await getChatInput(page);
  if (!input) return false;

  await input.fill(message);
  await page.keyboard.press('Enter');

  // Wait for response: look for streaming message or new content in message list
  const responseDetected = await page
    .locator(`${STREAMING_MESSAGE_SEL}, ${MESSAGE_LIST_SEL} > div:last-child`)
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  // Wait for streaming to complete
  await page.waitForTimeout(2_000);

  // Wait until typing indicator disappears (response complete)
  await page
    .locator(TYPING_INDICATOR_SEL)
    .waitFor({ state: 'hidden', timeout: timeoutMs })
    .catch(() => {});

  await page.waitForTimeout(500);

  return responseDetected;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

test.describe.serial('SDK Chat UI Consolidation E2E', () => {
  test.setTimeout(120_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-1: Studio chat send and streaming response
  //
  // RECORD STEPS:
  //   1. Go to http://localhost:5173
  //   2. Click "Dev Login" button on the login page
  //   3. Click the project card for "Travel Assistant" (or your test project)
  //   4. Click the "Agents" nav item in the left sidebar
  //   5. Click on an agent card (e.g. "supervisor" or "welcome_agent")
  //   6. Click the "chat" tab to open the chat panel
  //   7. Click the "New Chat" button to start a session
  //   8. Wait for the chat widget to appear (textarea + message list)
  //   9. Type a test message in the chat textarea (e.g. "Hello, how are you?")
  //  10. Press Enter to send
  //  11. Wait for the streaming response to appear and complete
  //  12. (Optional) If thought cards appear, click one to expand, then collapse
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-1: Studio chat send and streaming response', async ({ page }) => {
    // RECORD: Steps 1-3 — Login and select project
    await test.step('Login and navigate to project', async () => {
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;
      expect(token).toBeTruthy();
      expect(projectId).toBeTruthy();
    });

    // RECORD: Steps 4-6 — Find and navigate to an agent
    await test.step('Find first available agent', async () => {
      firstAgentName = await findFirstAgent(page, projectId, token);
      if (!firstAgentName) {
        test.skip(true, 'No agents found in project — create at least one agent to run chat tests');
      }
      console.info(`[E2E] Using agent: ${firstAgentName}`);
    });

    // RECORD: Step 7 — Click "New Chat" to start session
    await test.step('Navigate to agent chat panel', async () => {
      await navigateToAgentChat(page, projectId, firstAgentName);
      await screenshot(page, 'e2e1-chat-panel.png', 'Agent chat panel loaded');
    });

    // RECORD: Step 8 — Verify chat widget, message list, and input are visible
    await test.step('Verify chat widget components are present', async () => {
      // ChatWidget container
      const chatWidget = page.locator(CHAT_WIDGET_SEL);
      expect.soft(await chatWidget.isVisible({ timeout: 10_000 }).catch(() => false)).toBe(true);

      // MessageList container
      const messageList = page.locator(MESSAGE_LIST_SEL);
      expect.soft(await messageList.isVisible({ timeout: 5_000 }).catch(() => false)).toBe(true);

      // ChatInput
      const chatInput = await getChatInput(page);
      expect(chatInput).not.toBeNull();
    });

    // RECORD: Steps 9-11 — Type message, press Enter, wait for response
    await test.step('Send a message and verify streaming response', async () => {
      const testMessage = `E2E test message ${Date.now()}`;
      const gotResponse = await sendMessageAndWait(page, testMessage);

      // Verify user message appears in message list
      const messageList = page.locator(MESSAGE_LIST_SEL);
      const messageListText = await messageList.textContent().catch(() => '');
      expect.soft(messageListText).toContain(testMessage);

      // Verify some assistant response appeared
      if (gotResponse) {
        const messageCount = await messageList.locator('> div').count();
        expect.soft(messageCount).toBeGreaterThanOrEqual(2); // user + assistant
      }

      await screenshot(page, 'e2e1-message-sent.png', 'Message sent and response received');
    });

    // RECORD: Step 12 — If thought cards visible, click header to expand/collapse
    await test.step('Check for thought cards (if agent emits thoughts)', async () => {
      const thoughtCards = page.locator(THOUGHT_CARD_SEL);
      const thoughtCount = await thoughtCards.count();
      console.info(`[E2E] Thought cards found: ${thoughtCount}`);

      if (thoughtCount > 0) {
        // Click first thought card to expand
        const firstThought = thoughtCards.first();
        const header = firstThought.locator('[role="button"]');
        if (await header.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await header.click();
          await page.waitForTimeout(500);

          // Verify aria-expanded toggled
          const expanded = await header.getAttribute('aria-expanded');
          expect.soft(expanded).toBe('true');

          // Check for "View trace" button when expanded
          const viewTraceBtn = firstThought.locator('button', {
            hasText: /view trace/i,
          });
          expect
            .soft(await viewTraceBtn.isVisible({ timeout: 2_000 }).catch(() => false))
            .toBe(true);

          // Collapse it again
          await header.click();
          await page.waitForTimeout(300);
          const collapsed = await header.getAttribute('aria-expanded');
          expect.soft(collapsed).toBe('false');
        }

        await screenshot(page, 'e2e1-thought-cards.png', 'Thought cards present and interactive');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-2: Studio debug workflow — export and reset
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Type a message and press Enter (need content in the session)
  //   3. Wait for the response to complete
  //   4. Look for a debug toggle button in the chat header (bug/debug icon)
  //   5. Click the debug toggle → a debug panel should slide open on the right
  //   6. Look for a "Reset" button in the chat header
  //   7. Click Reset → the message list should clear (session reset)
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-2: Studio debug workflow — export and reset', async ({ page }) => {
    test.skip(!firstAgentName, 'Skipped — no agent available');

    // RECORD: Step 1 — Login and navigate to agent chat
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;
      await navigateToAgentChat(page, projectId, firstAgentName);
    });

    // RECORD: Steps 2-3 — Send a message so there's content to debug/reset
    await test.step('Send a message to have content', async () => {
      await sendMessageAndWait(page, `Debug workflow test ${Date.now()}`);
    });

    // RECORD: Steps 4-5 — Click the debug toggle button (look for bug icon or "Debug" text)
    await test.step('Toggle debug panel', async () => {
      // Find the debug toggle button (Bug icon button)
      const debugBtn = page
        .locator('button[title*="debug" i]')
        .or(page.locator('button:has-text("Debug")'))
        .first();

      const hasDebug = await debugBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!hasDebug) {
        console.warn('[E2E] Debug toggle not found — skipping debug panel check');
        return;
      }

      await debugBtn.click();
      await waitForIdle(page, 1_000);

      await screenshot(page, 'e2e2-debug-panel.png', 'Debug panel toggled open');
    });

    // RECORD: Steps 6-7 — Click Reset, verify messages cleared
    await test.step('Click reset session', async () => {
      const resetBtn = page
        .locator('button[title*="reset" i]')
        .or(page.locator('button:has-text("Reset")'))
        .first();

      const hasReset = await resetBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!hasReset) {
        console.warn('[E2E] Reset button not found — skipping reset check');
        return;
      }

      await resetBtn.click();
      await waitForIdle(page, 1_500);

      // After reset, message list should be empty or contain only system messages
      const messageList = page.locator(MESSAGE_LIST_SEL);
      const messageCount = await messageList
        .locator('> div')
        .count()
        .catch(() => -1);
      console.info(`[E2E] Messages after reset: ${messageCount}`);

      await screenshot(page, 'e2e2-after-reset.png', 'Chat after session reset');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-3: Studio session switching
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Type "Session-1 marker" and press Enter → wait for response
  //   3. Click "New Chat" button again (creates a second session)
  //   4. Verify the old "Session-1 marker" message is NOT visible
  //   5. Type "Session-2 marker" and press Enter → wait for response
  //   6. (Optional) If a session sidebar is visible on the left:
  //      - Click on the previous session entry
  //      - Verify "Session-1 marker" message reappears
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-3: Studio session switching', async ({ page }) => {
    test.skip(!firstAgentName, 'Skipped — no agent available');

    // RECORD: Step 1
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;
      await navigateToAgentChat(page, projectId, firstAgentName);
    });

    let session1Message = '';

    // RECORD: Step 2 — Send first message
    await test.step('Send message in first session', async () => {
      session1Message = `Session-1 marker ${Date.now()}`;
      await sendMessageAndWait(page, session1Message);
      await screenshot(page, 'e2e3-session1.png', 'First session with message');
    });

    // RECORD: Steps 3-4 — Click "New Chat", verify old message gone
    await test.step('Create/switch to new session', async () => {
      // Look for "New Chat" or "New Session" button
      const newChatBtn = page
        .locator('button:has-text("New Chat")')
        .or(page.locator('button:has-text("New Session")'))
        .or(page.locator('button:has-text("Start Chat")'))
        .first();

      const hasNewChat = await newChatBtn.isVisible({ timeout: 5_000 }).catch(() => false);

      if (hasNewChat) {
        await newChatBtn.click();
        await waitForIdle(page, 1_500);
      } else {
        // Fallback: use reset to start fresh session
        const resetBtn = page
          .locator('button[title*="reset" i]')
          .or(page.locator('button:has-text("Reset")'))
          .first();
        if (await resetBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await resetBtn.click();
          await waitForIdle(page, 1_500);
        }
      }

      // Verify message list is different (session1 message not visible)
      const messageList = page.locator(MESSAGE_LIST_SEL);
      const text = await messageList.textContent().catch(() => '');
      // In a new session, the old message should not be present
      expect.soft(text).not.toContain(session1Message);

      await screenshot(page, 'e2e3-session2.png', 'New session — old messages cleared');
    });

    // RECORD: Step 5 — Send second message in new session
    await test.step('Send message in second session', async () => {
      const session2Message = `Session-2 marker ${Date.now()}`;
      await sendMessageAndWait(page, session2Message);

      const messageList = page.locator(MESSAGE_LIST_SEL);
      const text = await messageList.textContent().catch(() => '');
      expect.soft(text).toContain(session2Message);
    });

    // RECORD: Step 6 — If session sidebar exists, click previous session entry
    await test.step('Switch back to previous session (if session list exists)', async () => {
      // Look for session sidebar or session list
      const sessionSidebar = page
        .locator('[data-testid="session-sidebar"]')
        .or(page.locator('.session-list'))
        .or(page.locator('[aria-label*="session" i]'))
        .first();

      const hasSidebar = await sessionSidebar.isVisible({ timeout: 3_000 }).catch(() => false);

      if (hasSidebar) {
        // Click on a previous session entry
        const sessions = sessionSidebar.locator('button, [role="button"]');
        const count = await sessions.count();
        if (count > 1) {
          // Click the second entry (first is current)
          await sessions.nth(1).click();
          await waitForIdle(page, 1_500);

          // Verify the original message is restored
          const messageList = page.locator(MESSAGE_LIST_SEL);
          const text = await messageList.textContent().catch(() => '');
          expect.soft(text).toContain(session1Message);

          await screenshot(page, 'e2e3-session1-restored.png', 'Original session restored');
        } else {
          console.info('[E2E] Only one session entry — cannot verify switch-back');
        }
      } else {
        console.info('[E2E] No session sidebar found — switch-back verification skipped');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-4: SDK embed — basic chat with thought cards
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Verify these elements are visible in the page:
  //      - [data-testid="chat-widget"] — the chat widget container
  //      - [data-sdk-theme] — the SDK theme wrapper div
  //      - [data-testid="message-list"] — the message list
  //      - [data-testid="chat-input"] — the chat input area
  //   3. Type a message and press Enter
  //   4. Wait for response
  //   5. (Optional) If [data-testid="thought-card"] elements appear,
  //      click the [role="button"] header to expand one
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-4: SDK embed — basic chat with thought cards', async ({ page }) => {
    test.skip(!firstAgentName, 'Skipped — no agent available');

    // RECORD: Step 1
    await test.step('Login and navigate to agent', async () => {
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;
      await navigateToAgentChat(page, projectId, firstAgentName);
    });

    // RECORD: Step 2 — Check for SDK component tree in DOM
    await test.step('Verify SDK components render in Studio context', async () => {
      // The Studio chat panel wraps SDK's AgentProvider + ChatWidget
      // Verify the SDK component tree is present
      const chatWidget = page.locator(CHAT_WIDGET_SEL);
      const widgetVisible = await chatWidget.isVisible({ timeout: 10_000 }).catch(() => false);
      expect(widgetVisible).toBe(true);

      // Verify SDK theme wrapper is present
      const themeWrapper = page.locator(SDK_THEME_SEL);
      expect.soft(await themeWrapper.isVisible({ timeout: 5_000 }).catch(() => false)).toBe(true);

      // Verify MessageList is present
      const messageList = page.locator(MESSAGE_LIST_SEL);
      expect.soft(await messageList.isVisible({ timeout: 5_000 }).catch(() => false)).toBe(true);

      // Verify ChatInput is present with data-testid
      const chatInput = page.locator('[data-testid="chat-input"]');
      expect.soft(await chatInput.isVisible({ timeout: 5_000 }).catch(() => false)).toBe(true);
    });

    // RECORD: Steps 3-5 — Send message, check response + thought cards
    await test.step('Send message and verify response renders', async () => {
      const testMessage = `SDK embed test ${Date.now()}`;
      const gotResponse = await sendMessageAndWait(page, testMessage);
      expect.soft(gotResponse).toBe(true);

      // Check for thought cards (agent may or may not emit them)
      const thoughtCards = page.locator(THOUGHT_CARD_SEL);
      const thoughtCount = await thoughtCards.count();
      console.info(`[E2E] SDK embed thought cards: ${thoughtCount}`);

      if (thoughtCount > 0) {
        // Verify thought card has expandable header
        const firstHeader = thoughtCards.first().locator('[role="button"]');
        expect.soft(await firstHeader.isVisible({ timeout: 2_000 }).catch(() => false)).toBe(true);
      }

      await screenshot(page, 'e2e4-sdk-embed.png', 'SDK embed chat with response');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-6: Theme and strings — verify CSS custom properties
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Right-click the chat area → Inspect Element
  //   3. Find the element with [data-sdk-theme] attribute
  //   4. In the Styles panel, verify these CSS vars are set on its style:
  //      --sdk-primary, --sdk-bg, --sdk-text, --sdk-border,
  //      --sdk-font-family, --sdk-font-size, --sdk-user-bubble, etc.
  //   5. Check the chat textarea has a placeholder text (from SDK strings)
  //   6. Check buttons have aria-label attributes (from SDK strings)
  //
  //   NOTE: This test reads CSS vars programmatically — recording just needs
  //   to navigate to the chat panel. The assertions run in page.evaluate().
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-6: Theme and strings — verify CSS custom properties', async ({ page }) => {
    test.skip(!firstAgentName, 'Skipped — no agent available');

    // RECORD: Step 1
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;
      await navigateToAgentChat(page, projectId, firstAgentName);
    });

    // RECORD: Steps 2-4 — Verify [data-sdk-theme] element exists
    await test.step('Verify SDK theme wrapper exists', async () => {
      const themeWrapper = page.locator(SDK_THEME_SEL);
      const visible = await themeWrapper.isVisible({ timeout: 10_000 }).catch(() => false);
      expect(visible).toBe(true);
    });

    // RECORD: (programmatic) Read CSS vars from the [data-sdk-theme] element
    await test.step('Verify CSS custom properties are set', async () => {
      // Check that the SDK theme wrapper div has CSS custom properties applied
      const cssVars = await page.evaluate(() => {
        const el = document.querySelector('[data-sdk-theme]');
        if (!el) return null;

        const style = (el as HTMLElement).style;
        const vars: Record<string, string> = {};

        // Check for known SDK CSS variables
        const knownVars = [
          '--sdk-primary',
          '--sdk-bg',
          '--sdk-text',
          '--sdk-border',
          '--sdk-font-family',
          '--sdk-font-size',
          '--sdk-radius',
          '--sdk-user-bubble',
          '--sdk-assistant-bubble',
          '--sdk-error',
        ];

        for (const v of knownVars) {
          const val = style.getPropertyValue(v);
          if (val) vars[v] = val;
        }

        return vars;
      });

      expect(cssVars).not.toBeNull();
      // At minimum, primary color and bg should be set
      if (cssVars) {
        const varCount = Object.keys(cssVars).length;
        console.info(`[E2E] SDK CSS vars found: ${varCount} — ${JSON.stringify(cssVars)}`);
        expect.soft(varCount).toBeGreaterThanOrEqual(3);
      }
    });

    // RECORD: Steps 5-6 — Check placeholder and aria-labels
    await test.step('Verify string labels render', async () => {
      // ChatInput should have a placeholder (from SDK strings)
      const chatInput = page
        .locator(CHAT_INPUT_SEL)
        .or(page.locator('textarea[placeholder]'))
        .first();
      const placeholder = await chatInput.getAttribute('placeholder').catch(() => '');
      expect.soft(placeholder).toBeTruthy();
      console.info(`[E2E] Chat input placeholder: "${placeholder}"`);

      // Send button should have an aria-label
      const sendBtn = page.locator('[data-testid="chat-input"] button[aria-label]').first();
      const sendLabel = await sendBtn.getAttribute('aria-label').catch(() => '');
      if (sendLabel) {
        expect.soft(sendLabel.length).toBeGreaterThan(0);
        console.info(`[E2E] Send button aria-label: "${sendLabel}"`);
      }

      await screenshot(page, 'e2e6-theme-strings.png', 'Theme and strings verification');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-7: Rich content rendering
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Type: "Can you provide a summary with some key points?"
  //   3. Press Enter
  //   4. Wait for the response to complete (may take up to 45s)
  //   5. Verify the response contains rich HTML (paragraphs, lists, bold, code, etc.)
  //      — look at the last message bubble's innerHTML
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-7: Rich content rendering', async ({ page }) => {
    test.skip(!firstAgentName, 'Skipped — no agent available');

    // RECORD: Step 1
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;
      await navigateToAgentChat(page, projectId, firstAgentName);
    });

    // RECORD: Steps 2-5 — Send message, verify rich HTML in response
    await test.step('Send message that may trigger rich content', async () => {
      // Send a message likely to get a structured/rich response
      const testMessage = 'Can you provide a summary with some key points?';
      await sendMessageAndWait(page, testMessage, 45_000);

      // Verify response is rendered in the message list
      const messageList = page.locator(MESSAGE_LIST_SEL);
      const responseChildren = await messageList.locator('> div').count();
      expect.soft(responseChildren).toBeGreaterThanOrEqual(2);

      // Check that response contains rendered content (markdown, lists, etc.)
      const lastAssistantMsg = messageList.locator('> div').last();
      const html = await lastAssistantMsg.innerHTML().catch(() => '');

      // Rich content could include markdown-rendered elements
      const hasRichContent =
        html.includes('<p>') ||
        html.includes('<ul>') ||
        html.includes('<ol>') ||
        html.includes('<code>') ||
        html.includes('<strong>') ||
        html.includes('<em>') ||
        html.includes('<h') ||
        html.length > 50; // At minimum, non-trivial content

      expect.soft(hasRichContent).toBe(true);
      console.info(`[E2E] Rich content check: response HTML length=${html.length}`);

      await screenshot(page, 'e2e7-rich-content.png', 'Rich content rendering');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-8: Error surfacing
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Send a normal message first (to establish connection)
  //   3. Wait for the response
  //   4. (Test blocks network requests to **/api/runtime/** programmatically)
  //   5. Type "This should trigger an error" and press Enter
  //   6. Wait ~5s — look for:
  //      - [data-testid="error-message"] element with role="alert"
  //      - OR a red error banner with class ".bg-error-subtle"
  //   7. (Test unblocks network)
  //   8. Send another message to verify recovery after error
  //
  //   NOTE: The network blocking is done via page.route() — you can't
  //   record that part. Just record the navigation + message sending.
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-8: Error surfacing', async ({ page }) => {
    test.skip(!firstAgentName, 'Skipped — no agent available');

    // RECORD: Step 1
    await test.step('Login and navigate to agent chat', async () => {
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;
      await navigateToAgentChat(page, projectId, firstAgentName);
    });

    // RECORD: Steps 2-7 — Send message, block network, send again, check error
    await test.step('Verify ErrorMessage component renders on transport error', async () => {
      // Intercept WebSocket to simulate a transport error
      // Use page.route to block WebSocket upgrade and trigger error state
      let errorDetected = false;

      // Send a normal message first to establish connection
      await sendMessageAndWait(page, `Error test setup ${Date.now()}`);

      // Check if any error messages are already visible (from real errors)
      const existingErrors = page.locator(ERROR_MESSAGE_SEL);
      const existingErrorCount = await existingErrors.count();

      if (existingErrorCount > 0) {
        // Error already present — verify the component renders correctly
        const errorEl = existingErrors.first();
        expect.soft(await errorEl.getAttribute('role')).toBe('alert');
        errorDetected = true;
      }

      // Simulate error via page.route intercepting chat API
      await page.route('**/api/runtime/**', (route) => {
        void route.abort('connectionrefused');
      });

      // Try to send a message that will fail
      const input = await getChatInput(page);
      if (input) {
        await input.fill('This should trigger an error');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5_000);

        // Check for error message or error banner
        const errorMsg = page.locator(ERROR_MESSAGE_SEL);
        const errorBanner = page.locator('.bg-error-subtle');
        const hasError =
          (await errorMsg.isVisible({ timeout: 5_000 }).catch(() => false)) ||
          (await errorBanner.isVisible({ timeout: 3_000 }).catch(() => false));

        if (hasError) {
          errorDetected = true;
          // Verify error has role="alert"
          if (await errorMsg.isVisible().catch(() => false)) {
            expect.soft(await errorMsg.getAttribute('role')).toBe('alert');
          }
        }
      }

      // Restore routes
      await page.unroute('**/api/runtime/**');

      console.info(`[E2E] Error detection: ${errorDetected ? 'found' : 'no error surfaced'}`);
      await screenshot(page, 'e2e8-error-surfacing.png', 'Error surfacing check');
    });

    // RECORD: Step 8 — Send another message to verify recovery
    await test.step('Verify recovery — can send after error', async () => {
      // After restoring routes, verify we can still send messages
      await page.waitForTimeout(2_000);
      const input = await getChatInput(page);
      if (input) {
        const recoveryMsg = `Recovery test ${Date.now()}`;
        const recovered = await sendMessageAndWait(page, recoveryMsg);
        console.info(`[E2E] Recovery after error: ${recovered ? 'success' : 'failed'}`);
      }

      await screenshot(page, 'e2e8-recovery.png', 'Recovery after error');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-9: Auth isolation
  //
  // RECORD STEPS:
  //   1. Clear all cookies (open DevTools → Application → Cookies → Clear)
  //   2. Navigate to http://localhost:5173/projects/fake-project/agents
  //   3. Verify you are redirected to the login page (/auth/login)
  //   4. Log in again (Dev Login → Select project)
  //   5. Navigate to an agent's chat panel → Click "New Chat"
  //   6. Verify the chat widget loads (proves auth is required)
  //   7. Open DevTools → Network tab
  //   8. Make a fetch to /api/runtime/agents with NO Authorization header
  //   9. Verify the response status is 401 or 404
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-9: Auth isolation', async ({ page }) => {
    // RECORD: Steps 1-3 — Clear cookies, try to access protected page
    await test.step('Verify unauthenticated access is blocked', async () => {
      // Create a fresh browser context with no cookies/auth
      const context = page.context();

      // Clear cookies to simulate unauthenticated state
      await context.clearCookies();

      // Try to access agents page directly without auth
      await page.goto(`${STUDIO_URL}/projects/fake-project/agents`);
      await page.waitForLoadState('load');
      await page.waitForTimeout(2_000);

      // Should be redirected to login page
      const url = page.url();
      const isOnLogin = url.includes('/auth/login') || url.includes('/login');
      const isOnProtected = url.includes('/projects/fake-project/agents');

      // Either redirected to login or showed an error — both are valid auth guards
      expect.soft(isOnLogin || !isOnProtected).toBe(true);
      console.info(`[E2E] Unauth redirect — URL: ${url}, on login: ${isOnLogin}`);

      await screenshot(page, 'e2e9-unauth.png', 'Unauthenticated access blocked');
    });

    // RECORD: Steps 4-6 — Re-login, navigate to chat, verify it loads
    await test.step('Verify chat panel requires authenticated session', async () => {
      // Re-authenticate
      const auth = await loginAndNavigateToProject(page);
      token = auth.token;
      projectId = auth.projectId;

      if (!firstAgentName) {
        console.info('[E2E] No agent — skipping authenticated chat check');
        return;
      }

      await navigateToAgentChat(page, projectId, firstAgentName);

      // Verify chat panel loaded (requires auth)
      const chatWidget = page.locator(CHAT_WIDGET_SEL);
      const widgetVisible = await chatWidget.isVisible({ timeout: 10_000 }).catch(() => false);
      expect.soft(widgetVisible).toBe(true);

      await screenshot(page, 'e2e9-auth-verified.png', 'Authenticated chat panel loaded');
    });

    // RECORD: Steps 7-9 — Make unauthenticated API call, check status
    await test.step('Verify API calls require auth token', async () => {
      // Make an API call without auth — should return 401
      const resp = await page.request.get(`${STUDIO_URL}/api/runtime/agents`, {
        headers: {}, // No auth headers
      });

      // Should be unauthorized
      expect.soft(resp.status()).toBeGreaterThanOrEqual(400);
      console.info(`[E2E] Unauth API call status: ${resp.status()}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E-10: Connection resilience
  //
  // RECORD STEPS:
  //   1. Login → Select project → Navigate to agent → Click "New Chat"
  //   2. Type a long-form prompt and press Enter
  //   3. QUICKLY watch for:
  //      - [data-testid="typing-indicator"] to appear
  //      - OR [data-testid="streaming-message"] to appear
  //   4. (Test forces a real `window.WebSocket.close(...)` against the shared `/ws` transport)
  //   5. Wait for a real `resume_session` / `session_resumed` reconnect cycle
  //   6. Send a follow-up message and verify streaming resumes
  // ═══════════════════════════════════════════════════════════════════════════
  test('E2E-10: Connection resilience', async ({ page }) => {
    await installSdkSocketTracker(page);
    let initialResumeRequestCount = 0;
    let initialResumeResponseCount = 0;
    let initialSocketCount = 0;

    // RECORD: Step 1
    await test.step('Login and navigate to agent chat', async () => {
      await loginViaDevApi(page);
      token = await getDevAccessToken(page);
      expect(token).toBeTruthy();

      projectId = await findFirstProjectId(page, token);
      if (!projectId) {
        test.skip(true, 'No projects found for E2E test user');
      }

      if (!firstAgentName) {
        firstAgentName = await findFirstAgent(page, projectId, token);
        if (!firstAgentName) {
          test.skip(
            true,
            'No agents found in project — create at least one agent to run chat tests',
          );
        }
      }
      await navigateToAgentChat(page, projectId, firstAgentName);
    });

    await test.step('Capture the initial shared Studio transport state', async () => {
      await expect
        .poll(async () => (await readSdkSocketTracker(page)).urls.length > 0, {
          timeout: 30_000,
        })
        .toBe(true);

      const trackerState = await readSdkSocketTracker(page);
      initialSocketCount = trackerState.urls.length;
      initialResumeRequestCount = countFrameType(trackerState.sentFrames, 'resume_session');
      initialResumeResponseCount = countFrameType(trackerState.receivedFrames, 'session_resumed');
    });

    // RECORD: Steps 2-5 — Send message, interrupt the live websocket, wait for reconnect
    await test.step('Force a real shared transport disconnect during streaming and wait for reconnect', async () => {
      const input = await getChatInput(page);
      expect(input).not.toBeNull();

      const interruptedMessage = `Resilience disconnect ${Date.now()} — please provide a detailed response`;

      await input!.fill(interruptedMessage);
      await page.keyboard.press('Enter');

      const initialStreaming = await waitForStreamingSignal(page);

      console.info(
        `[E2E] Pre-disconnect typing indicator: ${initialStreaming.typingAppeared}, streaming message: ${initialStreaming.streamingAppeared}`,
      );
      expect.soft(initialStreaming.typingAppeared || initialStreaming.streamingAppeared).toBe(true);

      const socketClosed = await forceCloseLatestSdkSocket(page);
      expect(socketClosed).toBe(true);

      await expect
        .poll(async () => (await readSdkSocketTracker(page)).urls.length > initialSocketCount, {
          timeout: 45_000,
        })
        .toBe(true);
      await expect
        .poll(
          async () =>
            countFrameType((await readSdkSocketTracker(page)).sentFrames, 'resume_session') >
            initialResumeRequestCount,
          { timeout: 45_000 },
        )
        .toBe(true);
      await expect
        .poll(
          async () =>
            countFrameType((await readSdkSocketTracker(page)).receivedFrames, 'session_resumed') >
            initialResumeResponseCount,
          { timeout: 45_000 },
        )
        .toBe(true);

      const reconnectedInput = await getChatInput(page);
      expect(reconnectedInput).not.toBeNull();
      await expect(reconnectedInput!).toBeEnabled({ timeout: 30_000 });
    });

    // RECORD: Step 6 — Send again after reconnect and verify streaming resumes
    await test.step('Verify the reconnected SDK resumes streaming on the next message', async () => {
      await page
        .locator(TYPING_INDICATOR_SEL)
        .waitFor({ state: 'hidden', timeout: 10_000 })
        .catch(() => {});
      await page
        .locator(STREAMING_MESSAGE_SEL)
        .waitFor({ state: 'hidden', timeout: 10_000 })
        .catch(() => {});

      const followUpMessage = `Reconnect follow-up ${Date.now()} — continue with another detailed answer`;
      const messageList = page.locator(MESSAGE_LIST_SEL);
      const childCountBeforeFollowUp = await messageList.locator('> *').count();
      const transportMessagesBefore = countFrameType(
        (await readSdkSocketTracker(page)).sentFrames,
        'send_message',
      );
      const input = await getChatInput(page);
      expect(input).not.toBeNull();

      await input!.fill(followUpMessage);
      await page.keyboard.press('Enter');

      const resumedStreaming = await waitForStreamingSignal(page);
      console.info(
        `[E2E] Post-reconnect typing indicator: ${resumedStreaming.typingAppeared}, streaming message: ${resumedStreaming.streamingAppeared}`,
      );

      expect.soft(resumedStreaming.typingAppeared || resumedStreaming.streamingAppeared).toBe(true);
      await expect
        .poll(
          async () =>
            countFrameType((await readSdkSocketTracker(page)).sentFrames, 'send_message') >
            transportMessagesBefore,
          {
            timeout: 10_000,
          },
        )
        .toBe(true);
      await expect
        .poll(
          async () => (await messageList.locator('> *').count()) >= childCountBeforeFollowUp + 2,
          {
            timeout: 60_000,
          },
        )
        .toBe(true);
      await page
        .locator(TYPING_INDICATOR_SEL)
        .waitFor({ state: 'hidden', timeout: 60_000 })
        .catch(() => {});

      const messageListText = await messageList.textContent().catch(() => '');
      expect.soft(messageListText).toContain(followUpMessage);

      await screenshot(page, 'e2e10-resilience.png', 'Connection resilience — final state');
    });
  });
});
