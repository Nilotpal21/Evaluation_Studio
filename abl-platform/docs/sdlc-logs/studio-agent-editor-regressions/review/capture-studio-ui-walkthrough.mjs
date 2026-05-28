import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const outputDir = path.join(
  repoRoot,
  'docs',
  'sdlc-logs',
  'studio-agent-editor-regressions',
  'review',
  'artifacts',
);
const videoDir = path.join(outputDir, 'studio-ui-video');
const screenshotsDir = path.join(outputDir, 'studio-ui-screenshots');
const playwrightEntry = path.join(
  repoRoot,
  'apps',
  'studio',
  'node_modules',
  '@playwright',
  'test',
  'index.mjs',
);
const studioBaseUrl = 'http://127.0.0.1:45173';
const runtimeBaseUrl = 'http://127.0.0.1:43112';
const stackScript = path.join(repoRoot, 'apps', 'studio', 'e2e', 'helpers', 'sdk-browser-stack.ts');
const screenshotFiles = [];
const IDLE_TIMEOUT_MS = 5_000;

fs.mkdirSync(videoDir, { recursive: true });
fs.mkdirSync(screenshotsDir, { recursive: true });

function clearDirectoryArtifacts(dirPath, predicate) {
  for (const entry of fs.readdirSync(dirPath)) {
    const absolutePath = path.join(dirPath, entry);
    if (!predicate(entry, absolutePath)) continue;
    fs.rmSync(absolutePath, { force: true, recursive: true });
  }
}

const { chromium } = await import(pathToFileURL(playwrightEntry).href);

function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return '';
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const lineKey = line.slice(0, separator).trim();
    if (lineKey !== key) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

function decodeJwtPayload(token) {
  const [, payload = ''] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function recentLogSuffix(recentLogs) {
  if (recentLogs.length === 0) return '';
  return ` recent logs: ${recentLogs.slice(-12).join(' | ')}`;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(message) {
  console.log(`[walkthrough] ${message}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function waitForReadiness(stackHandle) {
  const deadline = Date.now() + 300_000;

  while (Date.now() < deadline) {
    if (stackHandle.child.exitCode !== null) {
      throw new Error(
        `Isolated Studio stack exited before becoming ready.${recentLogSuffix(stackHandle.recentLogs)}`,
      );
    }

    try {
      const [
        { response: runtimeResponse, body: runtimeBody },
        { response: studioResponse, body: studioBody },
      ] = await Promise.all([
        fetchJson(`${runtimeBaseUrl}/health`),
        fetchJson(`${studioBaseUrl}/api/health/e2e-ready`),
      ]);

      if (
        runtimeResponse.ok &&
        studioResponse.ok &&
        ['ok', 'healthy'].includes(runtimeBody?.status ?? '') &&
        studioBody?.status === 'ready'
      ) {
        return;
      }
    } catch {
      // Retry until the stack comes up.
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for isolated Studio stack.${recentLogSuffix(stackHandle.recentLogs)}`,
  );
}

function startIsolatedStack() {
  const recentLogs = [];
  const child = spawn(process.execPath, ['--import', 'tsx', stackScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SDK_BROWSER_E2E_ISOLATED: 'true',
      ANTHROPIC_API_KEY:
        process.env.ANTHROPIC_API_KEY ||
        readEnvValue(path.join(repoRoot, '.env'), 'ANTHROPIC_API_KEY'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const captureChunk = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      recentLogs.push(trimmed);
      if (recentLogs.length > 120) recentLogs.shift();
    }
  };

  child.stdout.on('data', captureChunk);
  child.stderr.on('data', captureChunk);

  return { child, recentLogs };
}

async function stopIsolatedStack(stackHandle) {
  if (!stackHandle || stackHandle.child.exitCode !== null) return;

  stackHandle.child.kill('SIGTERM');
  const deadline = Date.now() + 15_000;
  while (stackHandle.child.exitCode === null && Date.now() < deadline) {
    await delay(250);
  }
  if (stackHandle.child.exitCode === null) {
    stackHandle.child.kill('SIGKILL');
  }
}

async function waitForIdle(page, extraMs = 700) {
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(extraMs);
}

async function captureScreenshot(page, filename, options = {}) {
  const absolutePath = path.join(screenshotsDir, filename);
  await page.screenshot({ path: absolutePath, fullPage: true, ...options });
  screenshotFiles.push(absolutePath);
  return absolutePath;
}

async function loginViaDevApi(page, email, name) {
  logStep('Logging into Studio via dev-login');
  const response = await page.request.post(`${studioBaseUrl}/api/auth/dev-login`, {
    data: { email, name },
  });

  if (!response.ok()) {
    throw new Error(`Dev login failed (${response.status()})`);
  }

  const body = await response.json();
  const domain = new URL(studioBaseUrl).hostname;
  const cookies = [];

  if (body.refreshToken) {
    cookies.push({
      name: 'refresh_token',
      value: body.refreshToken,
      domain,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
  }
  if (body.accessToken) {
    cookies.push({
      name: 'access_token',
      value: body.accessToken,
      domain,
      path: '/',
      httpOnly: false,
      sameSite: 'Lax',
    });
  }

  if (cookies.length > 0) {
    await page.context().addCookies(cookies);
  }

  await page.goto(`${studioBaseUrl}/projects`);
  await waitForIdle(page, 1_000);
  logStep('Dev-login complete');

  return body;
}

async function apiRequest(page, method, pathname, token, tenantId, body) {
  const response = await page.request.fetch(`${studioBaseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    ...(body !== undefined ? { data: body } : {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok()) {
    throw new Error(`${method} ${pathname} failed (${response.status()}): ${text}`);
  }
  return parsed;
}

async function createProject(page, token, tenantId) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return await apiRequest(page, 'POST', '/api/projects', token, tenantId, {
    name: `Studio Walkthrough ${suffix}`,
    slug: `studio-walkthrough-${suffix}`,
    description: 'Walkthrough project for Studio UI fix review',
  });
}

async function patchProject(page, projectId, token, tenantId, body) {
  return await apiRequest(page, 'PATCH', `/api/projects/${projectId}`, token, tenantId, body);
}

async function createModelConfig(page, token, tenantId, body) {
  return await apiRequest(page, 'POST', '/api/models', token, tenantId, body);
}

async function createAgent(page, token, tenantId, projectId, agentName, dslContent, description) {
  await apiRequest(page, 'POST', `/api/projects/${projectId}/agents`, token, tenantId, {
    name: agentName,
    agentPath: agentName,
    description,
  });

  await apiRequest(
    page,
    'PUT',
    `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}/dsl`,
    token,
    tenantId,
    { dslContent },
  );
}

function buildDemoSession(projectId) {
  const now = Date.now();
  const sessionId = 'session-studio-walkthrough';
  const createdAt = new Date(now - 5 * 60_000).toISOString();
  const lastActivityAt = new Date(now - 4 * 60_000).toISOString();
  return {
    sessions: [
      {
        id: sessionId,
        agentId: 'support_supervisor',
        agentName: 'support_supervisor',
        status: 'completed',
        durationMs: 900,
        messageCount: 3,
        traceEventCount: 4,
        tokenCount: 17,
        estimatedCost: 0.04,
        errorCount: 0,
        createdAt,
        lastActivityAt,
        projectId,
      },
    ],
    traces: {
      success: true,
      total: 4,
      offset: 0,
      limit: 100,
      traces: [
        {
          id: 'evt-root',
          type: 'agent_enter',
          timestamp: new Date(now - 4 * 60_000).toISOString(),
          durationMs: 400,
          agentName: 'support_supervisor',
          spanId: 'span-root',
          data: {},
        },
        {
          id: 'evt-step-enter',
          type: 'flow_step_enter',
          timestamp: new Date(now - 4 * 60_000 + 50).toISOString(),
          durationMs: 50,
          agentName: 'support_supervisor',
          spanId: 'span-step',
          parentSpanId: 'span-root',
          data: {
            stepName: 'collect_billing_context',
          },
        },
        {
          id: 'evt-step-llm-1',
          type: 'llm_call',
          timestamp: new Date(now - 4 * 60_000 + 120).toISOString(),
          durationMs: 80,
          agentName: 'support_supervisor',
          spanId: 'span-step',
          parentSpanId: 'span-root',
          data: {
            model: 'gpt-4o',
            promptTokens: 10,
            completionTokens: 4,
            cost: 0.03,
          },
        },
        {
          id: 'evt-step-llm-2',
          type: 'llm_call',
          timestamp: new Date(now - 4 * 60_000 + 220).toISOString(),
          durationMs: 40,
          agentName: 'support_supervisor',
          spanId: 'span-step',
          parentSpanId: 'span-root',
          data: {
            model: 'gpt-4o',
            promptTokens: 2,
            completionTokens: 1,
            cost: 0.01,
          },
        },
      ],
      _meta: {
        source: 'clickhouse_platform_events',
        event_count: 4,
        is_truncated: false,
      },
    },
  };
}

function installAnalyticsInterceptors(page, projectId) {
  const demo = buildDemoSession(projectId);

  page.route('**/api/runtime/sessions?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('projectId') !== projectId) {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        total: demo.sessions.length,
        sessions: demo.sessions,
      }),
    });
  });

  page.route(`**/api/runtime/sessions/${demo.sessions[0].id}/traces?*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(demo.traces),
    });
  });

  page.route('**/api/runtime/analytics?*', async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.searchParams.get('endpoint');

    let payload = { success: true };
    if (endpoint === 'event-counts') {
      payload = { success: true, data: { counts: [] } };
    } else if (endpoint === 'session-metrics') {
      payload = {
        success: true,
        data: {
          totalSessions: 0,
          completedSessions: 0,
          completionRate: 0,
          avgDurationMs: 0,
          avgCost: 0,
        },
      };
    } else if (endpoint === 'events') {
      payload = { success: true, data: { events: [], total: 0, hasMore: false } };
    } else if (endpoint === 'metrics') {
      payload = { success: true, data: { buckets: [] } };
    } else if (endpoint === 'cost-breakdown') {
      payload = { success: true, data: [] };
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  page.route('**/api/analytics/tenant-usage?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        summary: {
          totalRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          avgLatencyMs: 0,
        },
        breakdown: [],
        daily: [],
        projects: [],
      }),
    });
  });
}

async function openRadixOption(page, combobox, optionName) {
  await combobox.click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

async function runWalkthrough(page, projectId) {
  logStep('Opening agents list');
  await page.goto(`${studioBaseUrl}/projects/${projectId}/agents`);
  await waitForIdle(page, 1_200);
  await captureScreenshot(page, 'studio-01-agent-list-before-import.png');

  logStep('Opening import dialog');
  await page.getByRole('button', { name: 'Import' }).click();
  await page.waitForTimeout(500);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'faq_helper.abl',
    mimeType: 'text/plain',
    buffer: Buffer.from(`AGENT: faq_helper
GOAL: "Answer FAQ questions quickly"
`),
  });
  await page.waitForTimeout(2_000);
  await captureScreenshot(page, 'studio-02-import-preview.png');

  logStep('Applying loose .abl import');
  await page.getByRole('button', { name: /apply/i }).click();
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await waitForIdle(page, 1_500);
  await page.waitForTimeout(1_000);
  await captureScreenshot(page, 'studio-03-agent-list-after-import.png');

  logStep('Opening support supervisor editor');
  await page.goto(`${studioBaseUrl}/projects/${projectId}/agents/support_supervisor`);
  await waitForIdle(page, 1_200);
  await page.getByRole('button', { name: 'Execution', exact: true }).click();
  await page.waitForTimeout(600);

  logStep('Changing DSL primary model');
  const topCombobox = page.getByRole('combobox').first();
  await openRadixOption(page, topCombobox, 'GPT-4o');
  await page.waitForTimeout(400);
  await captureScreenshot(page, 'studio-04-execution-dsl-save.png');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.waitForTimeout(1_500);

  logStep('Opening runtime overrides panel');
  await page.getByRole('button', { name: /runtime-only model overrides/i }).click();
  await page.waitForTimeout(700);

  logStep('Changing runtime override model');
  const overrideCombobox = page.getByRole('combobox', { name: 'Runtime Override Model' });
  await openRadixOption(page, overrideCombobox, 'Claude Sonnet (claude-sonnet-4-6)');
  await page.waitForTimeout(500);
  await captureScreenshot(page, 'studio-05-runtime-override-save-enabled.png');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await page.waitForTimeout(1_500);

  logStep('Navigating from editor to chat');
  await page.getByRole('button', { name: /chat with agent/i }).click();
  await page.waitForURL(/\/chat$/);
  await waitForIdle(page, 1_500);

  logStep('Starting a real chat session so the Studio chat header loads');
  const sessionNewChatButton = page
    .locator('button')
    .filter({ hasText: /^New Chat$/ })
    .first();
  await sessionNewChatButton.waitFor({ state: 'visible', timeout: 20_000 });
  await sessionNewChatButton.click();
  await page.getByRole('button', { name: /back to agent/i }).waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await waitForIdle(page, 1_500);
  await captureScreenshot(page, 'studio-06-chat-back-button.png');

  logStep('Returning from chat to agent editor');
  await page.getByRole('button', { name: /back to agent/i }).click();
  await page.waitForURL(/\/projects\/[^/]+\/agents\/support_supervisor$/);
  await waitForIdle(page, 1_000);

  logStep('Opening delete dialog for billing agent');
  await page.goto(`${studioBaseUrl}/projects/${projectId}/agents/billing_agent`);
  await waitForIdle(page, 1_000);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(600);
  await captureScreenshot(page, 'studio-07-delete-dialog.png');
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/agents$`));
  await waitForIdle(page, 1_200);
  await captureScreenshot(page, 'studio-08-agent-list-after-delete.png');

  logStep('Opening analytics traces explorer');
  installAnalyticsInterceptors(page, projectId);
  await page.goto(`${studioBaseUrl}/projects/${projectId}/analytics`);
  await waitForIdle(page, 1_200);
  await page.getByRole('button', { name: /traces explorer/i }).click();
  await page.waitForTimeout(1_000);
  await page.getByText('support_supervisor').first().click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
  await page.waitForTimeout(700);
  await page.getByText('Flow Step Enter', { exact: true }).click();
  await page.waitForTimeout(700);
  await captureScreenshot(page, 'studio-09-traces-collapsed-summary.png');
  logStep('Expanding collapsed trace details');
  await page.getByText('Show details', { exact: true }).click();
  await page.waitForTimeout(600);
  await captureScreenshot(page, 'studio-10-traces-expanded-details.png');
  await page.waitForTimeout(1_200);
}

function convertVideo(videoPath, mp4Path) {
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', videoPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path],
      { stdio: 'ignore' },
    );
    return mp4Path;
  } catch {
    return videoPath;
  }
}

let stackHandle = null;
let browser = null;
let context = null;

try {
  clearDirectoryArtifacts(videoDir, (entry) => entry.endsWith('.webm'));
  clearDirectoryArtifacts(screenshotsDir, (entry) => entry.startsWith('studio-'));
  fs.rmSync(path.join(outputDir, 'studio-ui-walkthrough.mp4'), { force: true });

  logStep('Starting isolated Studio/runtime stack');
  stackHandle = startIsolatedStack();
  await waitForReadiness(stackHandle);
  logStep('Isolated stack ready');

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    baseURL: studioBaseUrl,
    colorScheme: 'light',
    recordVideo: {
      dir: videoDir,
      size: { width: 1440, height: 900 },
    },
  });

  const page = await context.newPage();
  const login = await loginViaDevApi(
    page,
    `studio-ui-walkthrough-${Date.now()}@e2e-smoke.test`,
    'Studio UI Walkthrough',
  );
  const payload = decodeJwtPayload(login.accessToken);
  const tenantId = payload.tenantId ?? '';

  logStep('Creating walkthrough project');
  const projectResponse = await createProject(page, login.accessToken, tenantId);
  const projectId = projectResponse.project.id;

  logStep('Creating workspace models');
  await createModelConfig(page, login.accessToken, tenantId, {
    projectId,
    name: 'Workspace GPT-4o',
    modelId: 'gpt-4o',
    provider: 'openai',
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    contextWindow: 128000,
    tier: 'balanced',
    isDefault: true,
    priority: 0,
  });

  await createModelConfig(page, login.accessToken, tenantId, {
    projectId,
    name: 'Claude Sonnet',
    modelId: 'claude-sonnet-4-6',
    provider: 'anthropic',
    temperature: 0.5,
    maxTokens: 8192,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    contextWindow: 200000,
    tier: 'balanced',
    isDefault: false,
    priority: 1,
  });

  logStep('Creating demo agents');
  await createAgent(
    page,
    login.accessToken,
    tenantId,
    projectId,
    'booking_agent',
    `AGENT: booking_agent
GOAL: "Help users manage travel bookings"
`,
    'Handles reservations and itinerary changes',
  );

  await createAgent(
    page,
    login.accessToken,
    tenantId,
    projectId,
    'billing_agent',
    `AGENT: billing_agent
GOAL: "Handle billing questions"
`,
    'Handles invoices, refunds, and payment questions',
  );

  await createAgent(
    page,
    login.accessToken,
    tenantId,
    projectId,
    'support_supervisor',
    `SUPERVISOR: support_supervisor
GOAL: "Route support requests"

HANDOFF:
  - TO: booking_agent
    WHEN: true
  - TO: billing_agent
    WHEN: true
`,
    'Routes customer issues to the right specialist',
  );

  await patchProject(page, projectId, login.accessToken, tenantId, {
    entryAgentName: 'support_supervisor',
  });

  logStep('Running Studio walkthrough');
  await runWalkthrough(page, projectId);
  await page.close();
  await context.close();
  await browser.close();
  browser = null;
  context = null;

  const recordedVideo = fs
    .readdirSync(videoDir)
    .filter((entry) => entry.endsWith('.webm'))
    .map((entry) => path.join(videoDir, entry))
    .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs)
    .at(-1);

  const mp4Path = path.join(outputDir, 'studio-ui-walkthrough.mp4');
  const finalVideo = recordedVideo ? convertVideo(recordedVideo, mp4Path) : null;

  logStep('Walkthrough capture complete');

  console.log(
    JSON.stringify(
      {
        video: finalVideo,
        screenshots: screenshotFiles,
        studioBaseUrl,
        runtimeBaseUrl,
      },
      null,
      2,
    ),
  );
} finally {
  if (context) {
    await context.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (stackHandle) {
    await stopIsolatedStack(stackHandle).catch(() => {});
  }
}
