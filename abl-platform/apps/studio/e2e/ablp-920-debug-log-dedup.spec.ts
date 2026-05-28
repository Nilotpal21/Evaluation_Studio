import { expect, test } from '@playwright/test';
import {
  bootstrapProjectPreviewContext,
  browserDevLogin,
  checkSdkBrowserPrerequisites,
  REQUEST_TIMEOUT_MS,
  SDK_BROWSER_VALIDATION_AGENT,
  SDK_BROWSER_VALIDATION_AGENT_NAME,
  STUDIO_BASE_URL,
  STRICT_BROWSER_E2E,
} from './helpers/sdk-browser-e2e';

const SESSION_ID = 'ablp-920-session';
const DUPLICATE_TRACE_ID = 'ablp-920-duplicate-llm';
const TRACE_TIMESTAMP = '2026-05-09T00:00:00.000Z';

async function installDuplicateTraceWebSocket(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ({ sessionId, traceId, timestamp }) => {
      type WebSocketState = 0 | 1 | 2 | 3;

      interface TraceMessage {
        type: 'trace_event';
        sessionId: string;
        event: {
          id: string;
          type: 'llm_call';
          timestamp: string;
          sessionId: string;
          traceId: string;
          spanId: string;
          agentName: string;
          data: {
            model: string;
            agentName: string;
          };
        };
      }

      interface BrowserWindowWithProbe extends Window {
        __ablp920DuplicateFramesEmitted?: number;
        __ablp920SocketOpen?: boolean;
        __ablp920SentFrames?: string[];
      }

      const probeWindow = window as BrowserWindowWithProbe;
      probeWindow.__ablp920DuplicateFramesEmitted = 0;
      probeWindow.__ablp920SocketOpen = false;
      probeWindow.__ablp920SentFrames = [];

      class DuplicateTraceWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readonly url: string;
        readonly protocol = '';
        readonly extensions = '';
        binaryType: BinaryType = 'blob';
        bufferedAmount = 0;
        readyState: WebSocketState = DuplicateTraceWebSocket.CONNECTING;
        onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
        onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
        onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
        onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

        constructor(url: string | URL) {
          super();
          this.url = String(url);

          window.setTimeout(() => {
            this.readyState = DuplicateTraceWebSocket.OPEN;
            probeWindow.__ablp920SocketOpen = true;
            const event = new Event('open');
            this.onopen?.call(this as unknown as WebSocket, event);
            this.dispatchEvent(event);
          }, 0);
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          const payload = typeof data === 'string' ? data : String(data);
          probeWindow.__ablp920SentFrames?.push(payload);

          let parsed: { type?: string; agentPath?: string } | null = null;
          try {
            parsed = JSON.parse(payload) as { type?: string; agentPath?: string };
          } catch {
            return;
          }

          if (parsed?.type !== 'load_agent') {
            return;
          }

          const agentName = parsed.agentPath ?? 'unknown';
          window.setTimeout(() => {
            this.emitMessage({
              type: 'agent_loaded',
              sessionId,
              agent: {
                id: 'agent-ablp-920',
                name: agentName,
                filePath: agentName,
                type: 'agent',
                mode: 'reasoning',
                toolCount: 0,
                gatherFieldCount: 0,
                isSupervisor: false,
                dsl: '',
                ir: {},
              },
            });

            const duplicateTrace: TraceMessage = {
              type: 'trace_event',
              sessionId,
              event: {
                id: traceId,
                type: 'llm_call',
                timestamp,
                sessionId,
                traceId: sessionId,
                spanId: 'span-ablp-920',
                agentName,
                data: {
                  model: 'sonnet',
                  agentName,
                },
              },
            };

            this.emitMessage(duplicateTrace);
            this.emitMessage(duplicateTrace);
            probeWindow.__ablp920DuplicateFramesEmitted = 2;
          }, 0);
        }

        close(code?: number, reason?: string): void {
          this.readyState = DuplicateTraceWebSocket.CLOSED;
          const event = new CloseEvent('close', { code, reason });
          this.onclose?.call(this as unknown as WebSocket, event);
          this.dispatchEvent(event);
        }

        private emitMessage(message: unknown): void {
          const event = new MessageEvent('message', { data: JSON.stringify(message) });
          this.onmessage?.call(this as unknown as WebSocket, event);
          this.dispatchEvent(event);
        }
      }

      window.WebSocket = DuplicateTraceWebSocket as unknown as typeof WebSocket;
    },
    {
      sessionId: SESSION_ID,
      traceId: DUPLICATE_TRACE_ID,
      timestamp: TRACE_TIMESTAMP,
    },
  );
}

async function openDebugLogs(page: import('@playwright/test').Page) {
  const performanceTab = page.getByRole('button', { name: /Performance/i }).first();
  if (!(await performanceTab.isVisible({ timeout: 1_000 }).catch(() => false))) {
    const debugButton = page
      .locator('button:has-text("Debug")')
      .or(page.locator('[title*="debug" i]'))
      .first();
    await expect(debugButton).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
    await debugButton.click();
  }

  await expect(performanceTab).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
  await performanceTab.click();

  const logsSection = page.getByRole('button', { name: /Logs/i }).first();
  await expect(logsSection).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
  await logsSection.click();
}

async function openAgentChat(page: import('@playwright/test').Page, projectId: string) {
  await page.goto(
    `${STUDIO_BASE_URL}/projects/${projectId}/agents/${SDK_BROWSER_VALIDATION_AGENT_NAME}`,
    {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  const chatWithAgentButton = page.getByRole('button', { name: /Chat with Agent/i }).first();
  await expect(chatWithAgentButton).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
  await chatWithAgentButton.click();
  await expect(page.getByRole('button', { name: /New Chat/i }).first()).toBeVisible({
    timeout: REQUEST_TIMEOUT_MS,
  });
}

async function startDuplicateTraceSessionAndExpectOneLog(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => window.__ablp920SocketOpen === true, null, {
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page
    .getByRole('button', { name: /New Chat/i })
    .first()
    .click();
  await page.waitForFunction(() => window.__ablp920DuplicateFramesEmitted === 2, null, {
    timeout: REQUEST_TIMEOUT_MS,
  });

  await openDebugLogs(page);

  await expect(page.getByText(/LLM call to sonnet/)).toHaveCount(1, {
    timeout: REQUEST_TIMEOUT_MS,
  });
}

test('debug logs render one row when duplicate trace events arrive after reload', async ({
  page,
  request,
}) => {
  const prerequisites = await checkSdkBrowserPrerequisites(request);
  if (!prerequisites.ok) {
    if (STRICT_BROWSER_E2E) {
      throw new Error(prerequisites.reason);
    }
    test.skip(true, prerequisites.reason);
  }

  const { projectId, ownerEmail } = await bootstrapProjectPreviewContext(request, {
    entryAgent: SDK_BROWSER_VALIDATION_AGENT,
  });

  await browserDevLogin(page, { email: ownerEmail, name: 'ABLP 920 E2E' });
  await installDuplicateTraceWebSocket(page);

  await openAgentChat(page, projectId);
  await startDuplicateTraceSessionAndExpectOneLog(page);

  await page.reload({
    waitUntil: 'domcontentloaded',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await openAgentChat(page, projectId);
  await startDuplicateTraceSessionAndExpectOneLog(page);
});
