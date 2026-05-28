import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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
const videoDir = path.join(outputDir, 'studio-analytics-video');
const screenshotsDir = path.join(outputDir, 'studio-analytics-screenshots');
const mp4Path = path.join(outputDir, 'studio-analytics-walkthrough.mp4');
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

const { chromium } = await import(pathToFileURL(playwrightEntry).href);

function clearDirectoryArtifacts(dirPath, predicate) {
  for (const entry of fs.readdirSync(dirPath)) {
    const absolutePath = path.join(dirPath, entry);
    if (!predicate(entry, absolutePath)) continue;
    fs.rmSync(absolutePath, { force: true, recursive: true });
  }
}

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
  console.log(`[analytics-walkthrough] ${message}`);
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
    name: `Studio Analytics Walkthrough ${suffix}`,
    slug: `studio-analytics-walkthrough-${suffix}`,
    description: 'Walkthrough project for Studio analytics page review',
  });
}

function isoMinutesAgo(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function buildAnalyticsDemo(projectId) {
  const sessions = [
    {
      id: 'session-analytics-001',
      agentId: 'agent-support',
      agentName: 'Support Supervisor',
      status: 'completed',
      durationMs: 1280,
      messageCount: 5,
      traceEventCount: 7,
      tokenCount: 248,
      estimatedCost: 0.052,
      errorCount: 0,
      channel: 'web_chat',
      environment: 'production',
      createdAt: isoMinutesAgo(18),
      lastActivityAt: isoMinutesAgo(16),
      projectId,
    },
    {
      id: 'session-analytics-002',
      agentId: 'agent-voice',
      agentName: 'Voice Support',
      status: 'completed',
      durationMs: 910,
      messageCount: 4,
      traceEventCount: 6,
      tokenCount: 193,
      estimatedCost: 0.041,
      errorCount: 1,
      channel: 'voice_pipeline',
      environment: 'staging',
      createdAt: isoMinutesAgo(9),
      lastActivityAt: isoMinutesAgo(5),
      projectId,
    },
    {
      id: 'session-analytics-003',
      agentId: 'agent-billing',
      agentName: 'Billing Helper',
      status: 'active',
      durationMs: 420,
      messageCount: 2,
      traceEventCount: 3,
      tokenCount: 76,
      estimatedCost: 0.018,
      errorCount: 0,
      channel: 'web_chat',
      environment: 'production',
      createdAt: isoMinutesAgo(4),
      lastActivityAt: isoMinutesAgo(1),
      projectId,
    },
  ];

  const tracesBySession = {
    'session-analytics-001': [
      {
        id: 'sup-root',
        type: 'agent_enter',
        timestamp: isoMinutesAgo(18),
        durationMs: 520,
        agentName: 'Support Supervisor',
        spanId: 'span-support-root',
        data: {},
      },
      {
        id: 'sup-llm',
        type: 'llm_call',
        timestamp: isoMinutesAgo(17.8),
        durationMs: 110,
        agentName: 'Support Supervisor',
        spanId: 'span-support-root',
        parentSpanId: 'span-support-root',
        data: {
          model: 'gpt-4o',
          promptTokens: 24,
          completionTokens: 12,
          cost: 0.02,
        },
      },
    ],
    'session-analytics-002': [
      {
        id: 'evt-root',
        type: 'agent_enter',
        timestamp: isoMinutesAgo(9),
        durationMs: 400,
        agentName: 'Voice Support',
        spanId: 'span-root',
        data: {},
      },
      {
        id: 'evt-step-enter',
        type: 'flow_step_enter',
        timestamp: isoMinutesAgo(8.95),
        durationMs: 210,
        agentName: 'Voice Support',
        spanId: 'span-step',
        parentSpanId: 'span-root',
        data: {
          stepName: 'collect_billing_context',
        },
      },
      {
        id: 'evt-llm-1',
        type: 'llm_call',
        timestamp: isoMinutesAgo(8.9),
        durationMs: 80,
        agentName: 'Voice Support',
        spanId: 'span-step',
        parentSpanId: 'span-root',
        data: {
          model: 'claude-sonnet-4-6',
          promptTokens: 12,
          completionTokens: 5,
          cost: 0.024,
        },
      },
      {
        id: 'evt-tool',
        type: 'tool_call',
        timestamp: isoMinutesAgo(8.85),
        durationMs: 60,
        agentName: 'Voice Support',
        spanId: 'span-step',
        parentSpanId: 'span-root',
        data: {
          toolName: 'lookup_invoice',
        },
      },
      {
        id: 'evt-handoff',
        type: 'handoff',
        timestamp: isoMinutesAgo(8.8),
        durationMs: 20,
        agentName: 'Voice Support',
        spanId: 'span-root',
        data: {
          fromAgent: 'Voice Support',
          toAgent: 'Billing Helper',
        },
      },
      {
        id: 'evt-error',
        type: 'error',
        timestamp: isoMinutesAgo(8.75),
        durationMs: 10,
        agentName: 'Voice Support',
        spanId: 'span-root',
        data: {
          message: 'Invoice lookup timed out',
        },
      },
    ],
    'session-analytics-003': [
      {
        id: 'bill-root',
        type: 'agent_enter',
        timestamp: isoMinutesAgo(4),
        durationMs: 180,
        agentName: 'Billing Helper',
        spanId: 'span-billing-root',
        data: {},
      },
      {
        id: 'bill-llm',
        type: 'llm_call',
        timestamp: isoMinutesAgo(3.9),
        durationMs: 75,
        agentName: 'Billing Helper',
        spanId: 'span-billing-root',
        parentSpanId: 'span-billing-root',
        data: {
          model: 'gpt-4o',
          promptTokens: 8,
          completionTokens: 4,
          cost: 0.01,
        },
      },
    ],
  };

  const volumeBuckets = [
    { hour: isoMinutesAgo(27), count: 14 },
    { hour: isoMinutesAgo(19), count: 21 },
    { hour: isoMinutesAgo(11), count: 18 },
    { hour: isoMinutesAgo(3), count: 26 },
  ];

  const llmBuckets = [
    {
      hour: isoMinutesAgo(27),
      count: 6,
      avg_duration: 420,
      p95_duration: 610,
      sum_tokens: 620,
      sum_cost: 0.024,
    },
    {
      hour: isoMinutesAgo(19),
      count: 8,
      avg_duration: 390,
      p95_duration: 580,
      sum_tokens: 840,
      sum_cost: 0.037,
    },
    {
      hour: isoMinutesAgo(11),
      count: 7,
      avg_duration: 360,
      p95_duration: 520,
      sum_tokens: 790,
      sum_cost: 0.033,
    },
    {
      hour: isoMinutesAgo(3),
      count: 9,
      avg_duration: 340,
      p95_duration: 470,
      sum_tokens: 910,
      sum_cost: 0.041,
    },
  ];

  const tenantUsage = {
    success: true,
    summary: {
      totalRequests: 31,
      inputTokens: 2210,
      outputTokens: 1010,
      totalTokens: 3220,
      estimatedCost: 0.135,
      avgLatencyMs: 378,
    },
    breakdown: [
      {
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        requests: 15,
        inputTokens: 1120,
        outputTokens: 540,
        totalTokens: 1660,
        estimatedCost: 0.078,
      },
      {
        modelId: 'gpt-4o',
        provider: 'openai',
        requests: 16,
        inputTokens: 1090,
        outputTokens: 470,
        totalTokens: 1560,
        estimatedCost: 0.057,
      },
    ],
    daily: [
      { date: isoMinutesAgo(27), requests: 6, totalTokens: 620, estimatedCost: 0.024 },
      { date: isoMinutesAgo(19), requests: 8, totalTokens: 840, estimatedCost: 0.037 },
      { date: isoMinutesAgo(11), requests: 7, totalTokens: 790, estimatedCost: 0.033 },
      { date: isoMinutesAgo(3), requests: 10, totalTokens: 970, estimatedCost: 0.041 },
    ],
    projects: [{ projectId, requests: 31, totalTokens: 3220, estimatedCost: 0.135 }],
  };

  const generations = [
    {
      id: 'gen-001',
      model: 'claude-sonnet-4-6',
      name: 'intent_router',
      tokensIn: 420,
      tokensOut: 90,
      latencyMs: 420,
      cost: 0.031,
      timestamp: isoMinutesAgo(12),
      sessionId: 'session-analytics-002',
    },
    {
      id: 'gen-002',
      model: 'gpt-4o',
      name: 'response_formatter',
      tokensIn: 320,
      tokensOut: 110,
      latencyMs: 360,
      cost: 0.019,
      timestamp: isoMinutesAgo(10),
      sessionId: 'session-analytics-001',
    },
    {
      id: 'gen-003',
      model: 'claude-sonnet-4-6',
      name: 'handoff_decider',
      tokensIn: 280,
      tokensOut: 60,
      latencyMs: 310,
      cost: 0.017,
      timestamp: isoMinutesAgo(7),
      sessionId: 'session-analytics-002',
    },
    {
      id: 'gen-004',
      model: 'gpt-4o',
      name: 'billing_summary',
      tokensIn: 190,
      tokensOut: 48,
      latencyMs: 240,
      cost: 0.011,
      timestamp: isoMinutesAgo(3),
      sessionId: 'session-analytics-003',
    },
  ];

  return {
    sessions,
    flushStatus: {
      success: true,
      data: {
        liveSessionCount: 2,
        visibleLiveSessionCount: 1,
        unflushedLiveSessionCount: 1,
        pendingSessionIds: ['session-live-pending-004'],
        lastCheckedAt: new Date().toISOString(),
      },
    },
    tracesBySession,
    volumeBuckets,
    llmBuckets,
    tenantUsage,
    generations,
    eventCounts: {
      success: true,
      data: {
        counts: [
          { key: 'session', count: 3, errorCount: 0 },
          { key: 'message', count: 11, errorCount: 0 },
          { key: 'llm', count: 9, errorCount: 1 },
          { key: 'tool', count: 4, errorCount: 1 },
          { key: 'handoff', count: 2, errorCount: 0 },
          { key: 'error', count: 2, errorCount: 2 },
        ],
      },
    },
    sessionMetrics: {
      success: true,
      data: {
        totalSessions: 3,
        completedSessions: 2,
        completionRate: 66.7,
        avgDurationMs: 870,
        avgCost: 0.037,
      },
    },
    recentErrors: {
      success: true,
      data: {
        events: [
          {
            timestamp: isoMinutesAgo(9),
            event_type: 'tool_call',
            agent_name: 'Voice Support',
            error_message: 'Invoice lookup timed out',
          },
          {
            timestamp: isoMinutesAgo(21),
            event_type: 'llm_call',
            agent_name: 'Support Supervisor',
            error_message: 'Provider fallback engaged after latency spike',
          },
        ],
        total: 2,
        hasMore: false,
      },
    },
    sqlQuery: {
      success: true,
      data: {
        columns: ['model', 'provider', 'calls', 'total_cost'],
        rows: [
          ['claude-sonnet-4-6', 'anthropic', 15, 0.078],
          ['gpt-4o', 'openai', 16, 0.057],
        ],
        rowCount: 2,
      },
      executionTimeMs: 42,
    },
  };
}

function installAnalyticsInterceptors(page, projectId) {
  const demo = buildAnalyticsDemo(projectId);

  page.route('**/api/runtime/sessions/*/traces?*', async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/api\/runtime\/sessions\/([^/]+)\/traces$/);
    const sessionId = match?.[1] ? decodeURIComponent(match[1]) : null;

    if (!sessionId || url.searchParams.get('projectId') !== projectId) {
      await route.continue();
      return;
    }

    const traces = demo.tracesBySession[sessionId] ?? [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        total: traces.length,
        traces,
      }),
    });
  });

  page.route('**/api/analytics/tenant-usage?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('projectId') !== projectId) {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(demo.tenantUsage),
    });
  });

  page.route('**/api/runtime/analytics?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.searchParams.get('endpoint');

    if (url.searchParams.get('projectId') !== projectId) {
      await route.continue();
      return;
    }

    if (request.method() === 'POST' && endpoint === 'sql-query') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(demo.sqlQuery),
      });
      return;
    }

    let payload = { success: true };

    if (endpoint === 'sessions') {
      payload = {
        success: true,
        data: {
          sessions: demo.sessions,
          total: demo.sessions.length,
          limit: 1000,
          offset: 0,
        },
      };
    } else if (endpoint === 'generations') {
      payload = {
        success: true,
        data: {
          generations: demo.generations,
          total: demo.generations.length,
          limit: 1000,
          offset: 0,
        },
      };
    } else if (endpoint === 'flush-status') {
      payload = demo.flushStatus;
    } else if (endpoint === 'event-counts') {
      payload = demo.eventCounts;
    } else if (endpoint === 'session-metrics') {
      payload = demo.sessionMetrics;
    } else if (endpoint === 'events') {
      payload = demo.recentErrors;
    } else if (endpoint === 'metrics') {
      payload = {
        success: true,
        data: {
          buckets:
            url.searchParams.get('category') === 'llm' ? demo.llmBuckets : demo.volumeBuckets,
        },
      };
    } else if (endpoint === 'cost-breakdown') {
      payload = {
        success: true,
        data: demo.tenantUsage.breakdown.map((item) => ({
          model: item.modelId,
          provider: item.provider,
          callCount: item.requests,
          totalTokens: item.totalTokens,
          totalCost: item.estimatedCost,
        })),
      };
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

async function openRadixOption(page, combobox, optionName) {
  await combobox.click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

async function waitForVisibleText(page, text) {
  await page.getByText(text, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
}

async function runWalkthrough(page, projectId) {
  logStep('Opening analytics workspace');
  installAnalyticsInterceptors(page, projectId);
  await page.goto(`${studioBaseUrl}/projects/${projectId}/analytics`);
  await waitForIdle(page, 1_400);
  await waitForVisibleText(page, 'Event Volume Over Time');
  await waitForVisibleText(page, 'Live sessions may still be flushing');
  await captureScreenshot(page, 'analytics-00-live-flush-notice.png');
  await captureScreenshot(page, 'analytics-01-overview.png');

  logStep('Changing the analytics date range');
  await page.getByRole('button', { name: '24h', exact: true }).click();
  await waitForIdle(page, 1_000);

  logStep('Opening LLM performance');
  await page.getByRole('button', { name: 'LLM Performance', exact: true }).click();
  await waitForVisibleText(page, 'Latency Trend');
  await page.getByRole('columnheader', { name: /cost/i }).click();
  await waitForIdle(page, 800);
  await captureScreenshot(page, 'analytics-02-llm-performance.png');

  logStep('Opening sessions explorer');
  await page.getByRole('button', { name: 'Sessions Explorer', exact: true }).click();
  await waitForVisibleText(page, 'Total Sessions');
  await captureScreenshot(page, 'analytics-03-sessions-explorer.png');

  logStep('Applying session quick filters');
  await openRadixOption(page, page.getByLabel('Channel'), 'voice_pipeline');
  await waitForIdle(page, 500);
  await openRadixOption(page, page.getByLabel('Environment'), 'staging');
  await waitForIdle(page, 700);
  await captureScreenshot(page, 'analytics-04-sessions-filtered.png');

  logStep('Opening traces from the selected session');
  await page.getByText('Voice Support', { exact: true }).click();
  await page.getByRole('button', { name: 'View Traces', exact: true }).click();
  await waitForVisibleText(page, 'Sessions');
  await captureScreenshot(page, 'analytics-05-traces-timeline.png');

  logStep('Opening the traces waterfall');
  await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
  await page.getByText('Flow Step Enter', { exact: true }).click();
  await page.getByText('Show details', { exact: true }).click();
  await waitForIdle(page, 700);
  await captureScreenshot(page, 'analytics-06-traces-waterfall.png');

  logStep('Opening generations');
  await page.getByRole('button', { name: 'Generations', exact: true }).click();
  await page.getByPlaceholder('Search generations...').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await waitForIdle(page, 700);
  await captureScreenshot(page, 'analytics-07-generations.png');

  logStep('Opening query explorer');
  await page.getByRole('button', { name: 'Query', exact: true }).click();
  await page.getByRole('button', { name: 'Example Queries', exact: true }).waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Example Queries', exact: true }).click();
  await page.getByText('LLM Cost by Model', { exact: true }).click();
  await page.getByRole('button', { name: 'Guide', exact: true }).click();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await page.getByText(/Results — 2 rows/).waitFor({ state: 'visible', timeout: 20_000 });
  await waitForIdle(page, 700);
  await captureScreenshot(page, 'analytics-08-query-results.png');
}

function convertVideo(videoPath, targetMp4Path) {
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', videoPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', targetMp4Path],
      { stdio: 'ignore' },
    );
    return targetMp4Path;
  } catch {
    return videoPath;
  }
}

let stackHandle = null;
let browser = null;
let context = null;

try {
  clearDirectoryArtifacts(videoDir, (entry) => entry.endsWith('.webm'));
  clearDirectoryArtifacts(screenshotsDir, (entry) => entry.startsWith('analytics-'));
  fs.rmSync(mp4Path, { force: true });

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
    `studio-analytics-walkthrough-${Date.now()}@e2e-smoke.test`,
    'Studio Analytics Walkthrough',
  );
  const payload = decodeJwtPayload(login.accessToken);
  const tenantId = payload.tenantId ?? '';

  logStep('Creating walkthrough project');
  const projectResponse = await createProject(page, login.accessToken, tenantId);
  const projectId = projectResponse.project.id;

  logStep('Running analytics walkthrough');
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

  const finalVideo = recordedVideo ? convertVideo(recordedVideo, mp4Path) : null;

  logStep('Analytics walkthrough capture complete');

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
