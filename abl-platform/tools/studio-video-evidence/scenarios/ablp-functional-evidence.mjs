import http from 'node:http';

import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import {
  apiJson,
  createAgent,
  openStudioAgentChat,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { createStudioFixture } from '../lib/studio-harness.mjs';
import { createProjectTool } from '../lib/studio-issue-api.mjs';
import { uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

function authHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  };
}

function startFormEchoServer() {
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const contentType = req.headers['content-type'] ?? '';
      const parsed = Object.fromEntries(new URLSearchParams(rawBody).entries());
      const captured = {
        method: req.method,
        url: req.url,
        contentType,
        rawBody,
        parsed,
      };
      requests.push(captured);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          receivedMethod: captured.method,
          receivedContentType: captured.contentType,
          rawBody: captured.rawBody,
          parsed: captured.parsed,
        }),
      );
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate local form echo server port.'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
        requests,
      });
    });
  });
}

function openAiTextResponse(content) {
  return {
    id: `chatcmpl_${uniqueSuffix().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-3.5-turbo',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
      total_tokens: 120 + Math.max(1, Math.ceil(content.length / 4)),
    },
  };
}

function openAiResponsesApiResponse(content) {
  return {
    id: `resp_${uniqueSuffix().replace(/-/g, '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: 'gpt-3.5-turbo',
    output_text: content,
    output: [
      {
        type: 'message',
        id: `msg_${uniqueSuffix().replace(/-/g, '')}`,
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: content,
          },
        ],
      },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: Math.max(1, Math.ceil(content.length / 4)),
      total_tokens: 120 + Math.max(1, Math.ceil(content.length / 4)),
    },
  };
}

function startEvalGenerationLlmServer() {
  const requests = [];
  const personaPayload = [
    {
      name: 'ABLP-550 Boundary Persona',
      description: 'Generated persona with the exact blank adversarial type regression shape.',
      communicationStyle: 'friendly',
      domainKnowledge: 'wizard',
      behaviorTraits: ['skeptical', 'short on time'],
      goals: 'Confirm that generated personas can be saved without a 400 validation error.',
      constraints: 'Always asks for a concise answer.',
      isAdversarial: true,
      adversarialType: '',
    },
  ];
  const scenarioPayload = [
    {
      name: 'ABLP-551 Billing Follow Up',
      description: 'Resolve a generated billing question.',
      category: '',
      difficulty: 'medium',
      entryAgent: 'NotARealAgent',
      maxTurns: 100,
      expectedMilestones: ['User explains issue', 'Agent resolves issue'],
      agentPath: ['NotARealAgent'],
      tags: ['billing', 'generated', 'extra-tag-ignored', 'overflow-tag'],
    },
  ];

  const server = http.createServer((req, res) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        rawBody,
      });

      const lowerBody = rawBody.toLowerCase();
      const payload = lowerBody.includes('scenario') ? scenarioPayload : personaPayload;
      const content = JSON.stringify(payload);
      const responseBody = req.url?.includes('/responses')
        ? openAiResponsesApiResponse(content)
        : openAiTextResponse(content);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate local eval generation LLM server port.'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
        requests,
      });
    });
  });
}

async function startEventStoreProbeServer() {
  const { eventRegistry } = await import(
    new URL('../../../packages/eventstore/dist/schema/index.js', import.meta.url).href
  );

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
    });

    const accepted = {};
    const errors = {};
    for (const result of ['completed', 'continue', 'constraint_blocked', 'handoff', 'delegate']) {
      const validation = eventRegistry.validate({
        event_type: 'agent.exited',
        data: { result, duration_ms: 42 },
      });
      accepted[result] = validation.valid;
      if (!validation.valid) {
        errors[result] = validation.errors?.map((error) => error.message) ?? [];
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        success: Object.values(accepted).every(Boolean),
        eventType: 'agent.exited',
        accepted,
        errors,
      }),
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate local EventStore probe server port.'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
        requests,
      });
    });
  });
}

async function openToolTestDialog(page, toolId) {
  const row = page.getByTestId(`tool-row-${toolId}`);
  await row.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });

  await row.locator('button').first().click({ timeout: REQUEST_TIMEOUT_MS });
  const testButton = page.getByRole('button', { name: /^test$/i }).last();
  await testButton.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await testButton.click({ timeout: REQUEST_TIMEOUT_MS });

  const dialog = page.locator('[role="dialog"]').last();
  await dialog.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  return dialog;
}

async function executeToolFromToolsPage(context, fixture, toolId, screenshotName, options = {}) {
  const { artifacts, page } = context;
  const expectedText = Array.isArray(options.expectedText) ? options.expectedText : [];

  await openToolsSurface(context, fixture.projectId);
  const dialog = await openToolTestDialog(page, toolId);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/projects/${fixture.projectId}/tools/${toolId}/test`) &&
      response.request().method() === 'POST',
    { timeout: REQUEST_TIMEOUT_MS },
  );

  await dialog.getByRole('button', { name: /execute/i }).click({ timeout: REQUEST_TIMEOUT_MS });
  const response = await responsePromise;
  const body = await response.json();
  const result = body?.result ?? body?.data?.result ?? null;

  for (const text of expectedText) {
    await dialog.getByText(text, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  await artifacts.captureScreenshot(screenshotName);
  await page.waitForTimeout(1_000);
  return result;
}

async function createRuntimeHttpTool(context, fixture, options) {
  const { baseUrl } = context;
  const toolName = options.name;
  const created = await createProjectTool(baseUrl, fixture.accessToken, fixture.projectId, {
    name: toolName,
    toolType: 'http',
    description: options.description,
    endpoint: options.endpoint,
    method: options.method ?? 'GET',
    auth: 'none',
    headers: options.headers ?? [],
    body: options.body,
    bodyType: options.bodyType ?? (options.body ? 'json' : undefined),
    parameters: [],
    returnType: 'object',
    timeout: options.timeout ?? 30_000,
  });

  const toolId = created?.tool?.id ?? created?.id;
  if (!toolId) {
    throw new Error(`Unable to resolve created tool id from ${JSON.stringify(created)}`);
  }

  return { toolId, toolName };
}

async function openToolsSurface(context, projectId) {
  const { baseUrl, page } = context;
  const routePath = `/projects/${encodeURIComponent(projectId)}/tools`;
  const route = `${baseUrl}${routePath}`;

  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page
    .waitForURL((url) => url.pathname === routePath, { timeout: REQUEST_TIMEOUT_MS })
    .catch(() => {});
  await waitForIdle(page, 1_000);
  await page.locator('main').first().waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
}

async function gotoProjectRoute(context, projectId, routeSuffix) {
  const { baseUrl, page } = context;
  const routePath = `/projects/${encodeURIComponent(projectId)}${routeSuffix}`;

  await page.goto(`${baseUrl}${routePath}`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForURL((url) => url.pathname === routePath, { timeout: REQUEST_TIMEOUT_MS })
    .catch(() => {});
  await waitForIdle(page, 1_000);
  await page.locator('main').first().waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
}

async function createSdkKey(baseUrl, accessToken, projectId, name) {
  return apiJson(baseUrl, '/api/sdk/keys', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      projectId,
      name,
      permissions: { chat: true, voice: false },
    }),
  });
}

async function createSdkChannel(baseUrl, accessToken, projectId, publicApiKeyId, body) {
  const result = await apiJson(
    baseUrl,
    `/api/runtime/sdk-channels?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        channelType: 'web',
        publicApiKeyId,
        ...body,
      }),
    },
  );

  return result?.channel ?? result;
}

async function openSdkWebChannelConfig(context, fixture, channelName) {
  const { page } = context;

  await gotoProjectRoute(context, fixture.projectId, '/deployments');
  await page.getByRole('tab', { name: /channels/i }).click({ timeout: REQUEST_TIMEOUT_MS });
  await page.getByText('Web SDK', { exact: true }).first().click({ timeout: REQUEST_TIMEOUT_MS });
  await page.getByText(channelName, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.getByText(channelName, { exact: true }).click({ timeout: REQUEST_TIMEOUT_MS });
  await page.getByRole('tab', { name: /testing/i }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
}

async function clickChannelTab(page, namePattern) {
  await page.getByRole('tab', { name: namePattern }).click({ timeout: REQUEST_TIMEOUT_MS });
  await waitForIdle(page, 800);
}

async function generateTestingShareLink(page, projectId) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/sdk/share') && response.request().method() === 'POST',
    { timeout: REQUEST_TIMEOUT_MS },
  );
  await page
    .getByRole('button', { name: /^generate link$/i })
    .first()
    .click({ timeout: REQUEST_TIMEOUT_MS });

  const response = await responsePromise;
  const body = await response.json();
  if (!response.ok() || typeof body?.shareUrl !== 'string') {
    throw new Error(
      `Share link generation failed for project ${projectId}: ${JSON.stringify(body)}`,
    );
  }

  await page.getByText(body.shareUrl, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });

  return body;
}

async function configureArchDirectOpenAi(context, fixture, endpoint) {
  return apiJson(context.baseUrl, '/api/arch/config', {
    method: 'PUT',
    headers: authHeaders(fixture.accessToken),
    body: JSON.stringify({
      provider: 'openai',
      modelId: 'openai/gpt-3.5-turbo',
      usePlatformCredits: false,
      apiKey: 'fake-openai-key-for-local-evidence',
      endpoint,
      maxTokensChat: 2048,
      maxTokensGenerate: 2048,
      temperature: 0.1,
      lastValidatedAt: new Date().toISOString(),
    }),
  });
}

async function createEvalFixture(context, issue, agentName) {
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const resolvedAgentName = agentName ?? `${issue.toLowerCase().replace('-', '_')}_agent_${suffix}`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: `${issue} Functional Evidence`,
    projectSlugPrefix: `${issue.toLowerCase()}-functional-evidence`,
  });

  await createAgent(context.baseUrl, fixture.accessToken, fixture.projectId, {
    name: resolvedAgentName,
    description: `${issue} evidence agent for eval generation topology`,
    dslContent: `
AGENT: ${resolvedAgentName}
GOAL: "Provide deterministic eval generation topology"
FLOW:
  start:
    REASONING: false
    RESPOND: "Ready for eval generation."
    THEN: COMPLETE
`,
  });

  return { fixture, agentName: resolvedAgentName, suffix };
}

async function openEvalsSurface(context, projectId) {
  await gotoProjectRoute(context, projectId, '/evals');
  const personasTab = context.page.getByRole('tab', { name: /personas/i });
  await personasTab.waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await personasTab.click({ timeout: REQUEST_TIMEOUT_MS });
}

async function installWebSocketSendProbe(page) {
  await page.addInitScript(() => {
    if (window.__ablpActionProbeInstalled) return;
    window.__ablpActionProbeInstalled = true;
    window.__ablpActionSentFrames = [];

    const NativeWebSocket = window.WebSocket;
    function ProbedWebSocket(url, protocols) {
      const socket =
        protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        try {
          window.__ablpActionSentFrames.push(String(data));
        } catch {
          // Keep the application websocket behavior untouched if capture fails.
        }
        return nativeSend(data);
      };
      return socket;
    }

    ProbedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(ProbedWebSocket, NativeWebSocket);
    window.WebSocket = ProbedWebSocket;
  });
}

function recordEvalsTraffic(page) {
  const traffic = [];
  const isEvalRequest = (url) => url.includes('/evals');

  page.on('request', (request) => {
    if (!isEvalRequest(request.url())) return;
    traffic.push({
      type: 'request',
      method: request.method(),
      url: request.url(),
    });
  });
  page.on('response', (response) => {
    if (!isEvalRequest(response.url())) return;
    traffic.push({
      type: 'response',
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    });
  });

  return traffic;
}

async function runAblp265(context) {
  const { artifacts, baseUrl, page } = context;
  const echoServer = await startFormEchoServer();
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const toolName = `ablp_265_form_echo_${suffix}`;
  const inputPayload = {
    username: 'alice@example.test',
    scope: 'claims',
    note: 'hello world & billing=on',
  };

  try {
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: false,
      projectNamePrefix: 'ABLP-265 Functional Evidence',
      projectSlugPrefix: 'ablp-265-functional-evidence',
    });

    const created = await createProjectTool(baseUrl, fixture.accessToken, fixture.projectId, {
      name: toolName,
      toolType: 'http',
      description: 'ABLP-265 evidence: form-url-encoded auto body reaches an echo endpoint.',
      endpoint: `${echoServer.baseUrl}/form-echo`,
      method: 'POST',
      auth: 'none',
      bodyType: 'form',
      parameters: [
        {
          name: 'username',
          type: 'string',
          description: 'User identifier',
          required: true,
        },
        {
          name: 'scope',
          type: 'string',
          description: 'Lookup scope',
          required: true,
        },
        {
          name: 'note',
          type: 'string',
          description: 'Free-form note with characters that require form encoding',
          required: true,
        },
      ],
      returnType: 'object',
    });

    const toolId = created?.tool?.id ?? created?.id;
    if (!toolId) {
      throw new Error(`Unable to resolve created tool id from ${JSON.stringify(created)}`);
    }

    await openToolsSurface(context, fixture.projectId);
    await page.getByText(toolName, { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await artifacts.captureScreenshot('ablp-265-tool-visible-before-test.png');

    const dialog = await openToolTestDialog(page, toolId);
    await dialog.getByRole('button', { name: /json/i }).click({ timeout: REQUEST_TIMEOUT_MS });
    await dialog
      .locator('textarea')
      .first()
      .fill(JSON.stringify(inputPayload, null, 2));
    await artifacts.captureScreenshot('ablp-265-json-input-before-execute.png');

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(`/api/projects/${fixture.projectId}/tools/${toolId}/test`) &&
          response.request().method() === 'POST',
        { timeout: REQUEST_TIMEOUT_MS },
      ),
      dialog.getByRole('button', { name: /execute/i }).click({ timeout: REQUEST_TIMEOUT_MS }),
    ]);

    const capturedRequest = await waitForCondition(() => echoServer.requests[0] ?? null, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 100,
      label: 'Timed out waiting for local form echo server request.',
    });

    const resultBlocks = dialog.locator('pre');
    await resultBlocks
      .filter({ hasText: /receivedContentType/i })
      .first()
      .waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });
    await resultBlocks
      .filter({ hasText: /application\/x-www-form-urlencoded/i })
      .first()
      .waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });
    await resultBlocks
      .filter({ hasText: /hello\+world\+%26\+billing%3Don/i })
      .first()
      .waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });
    await artifacts.captureScreenshot('ablp-265-form-urlencoded-result.png');
    await page.waitForTimeout(2_000);

    const parsedMatches =
      capturedRequest.parsed.username === inputPayload.username &&
      capturedRequest.parsed.scope === inputPayload.scope &&
      capturedRequest.parsed.note === inputPayload.note;
    const contentTypeMatches = String(capturedRequest.contentType)
      .toLowerCase()
      .includes('application/x-www-form-urlencoded');
    const rawBodyUsesFormEncoding =
      capturedRequest.rawBody.includes('username=alice%40example.test') &&
      capturedRequest.rawBody.includes('scope=claims') &&
      capturedRequest.rawBody.includes('note=hello+world+%26+billing%3Don');

    return {
      summary:
        'ABLP-265: Studio tool test executed an HTTP tool with bodyType=form and the local echo server received application/x-www-form-urlencoded raw body.',
      metadata: {
        issue: 'ABLP-265',
        projectId: fixture.projectId,
        toolId,
        toolName,
        echoEndpoint: `${echoServer.baseUrl}/form-echo`,
        capturedRequest,
      },
      assertions: [
        {
          name: 'studio-tool-test-called-local-echo-endpoint',
          passed: capturedRequest.method === 'POST' && capturedRequest.url === '/form-echo',
          details: `${capturedRequest.method} ${capturedRequest.url}`,
        },
        {
          name: 'content-type-is-form-urlencoded',
          passed: contentTypeMatches,
          details: String(capturedRequest.contentType),
        },
        {
          name: 'raw-body-is-url-encoded-form-data',
          passed: rawBodyUsesFormEncoding,
          details: capturedRequest.rawBody,
        },
        {
          name: 'server-parsed-form-values-match-input',
          passed: parsedMatches,
          details: JSON.stringify(capturedRequest.parsed),
        },
      ],
    };
  } finally {
    await echoServer.close();
  }
}

async function runAblp282(context) {
  const { artifacts, baseUrl, page } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const channelName = `ABLP-282 Web SDK ${suffix}`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-282 Functional Evidence',
    projectSlugPrefix: 'ablp-282-functional-evidence',
  });
  const sdkKey = await createSdkKey(
    baseUrl,
    fixture.accessToken,
    fixture.projectId,
    `ABLP-282 SDK Key ${suffix}`,
  );
  const channel = await createSdkChannel(
    baseUrl,
    fixture.accessToken,
    fixture.projectId,
    sdkKey.id,
    {
      name: channelName,
      config: {
        mode: 'chat',
        chatEnabled: true,
        voiceEnabled: false,
        position: 'bottom-right',
      },
    },
  );

  await openSdkWebChannelConfig(context, fixture, channelName);
  await clickChannelTab(page, /testing/i);
  const firstShare = await generateTestingShareLink(page, fixture.projectId);
  await artifacts.captureScreenshot('ablp-282-share-link-generated.png');

  await clickChannelTab(page, /configuration/i);
  await page.getByLabel(/welcome message/i).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-282-navigated-away-from-testing.png');

  await clickChannelTab(page, /testing/i);
  await page.getByText(firstShare.shareUrl, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-282-share-link-restored.png');

  const restoredFromSessionStorage = await page.evaluate(
    ({ projectId, channelId }) => {
      const key = `studio:sdk-share-link:${projectId}:${channelId}:chat`;
      const raw = window.sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    { projectId: fixture.projectId, channelId: channel.id },
  );

  const restoredMatches =
    restoredFromSessionStorage?.url === firstShare.shareUrl &&
    typeof restoredFromSessionStorage?.expiresAt === 'string';

  return {
    summary:
      'ABLP-282: Studio Web SDK Testing tab generated a secure preview link, navigated away, and restored the same link when returning to Testing.',
    metadata: {
      issue: 'ABLP-282',
      projectId: fixture.projectId,
      channelId: channel.id,
      channelName,
      shareUrl: firstShare.shareUrl,
      restoredFromSessionStorage,
    },
    assertions: [
      {
        name: 'share-link-generated-in-testing-tab',
        passed: typeof firstShare.shareUrl === 'string' && firstShare.shareUrl.includes('/preview'),
        details: firstShare.shareUrl,
      },
      {
        name: 'share-link-restored-after-tab-navigation',
        passed: restoredMatches,
        details: JSON.stringify(restoredFromSessionStorage),
      },
    ],
  };
}

async function runAblp285(context) {
  const { artifacts, baseUrl, page } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const channelName = `ABLP-285 Web SDK ${suffix}`;
  const welcomeMessage = `Welcome from ABLP-285 ${suffix}`;
  const placeholderText = `Type ABLP-285 ${suffix}`;
  const updatedPosition = 'top-left';
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-285 Functional Evidence',
    projectSlugPrefix: 'ablp-285-functional-evidence',
  });
  const sdkKey = await createSdkKey(
    baseUrl,
    fixture.accessToken,
    fixture.projectId,
    `ABLP-285 SDK Key ${suffix}`,
  );
  const channel = await createSdkChannel(
    baseUrl,
    fixture.accessToken,
    fixture.projectId,
    sdkKey.id,
    {
      name: channelName,
      config: {
        mode: 'chat',
        chatEnabled: true,
        voiceEnabled: false,
        position: 'bottom-right',
        welcomeMessage: 'Initial welcome',
        placeholderText: 'Initial placeholder',
      },
    },
  );

  await openSdkWebChannelConfig(context, fixture, channelName);
  await clickChannelTab(page, /configuration/i);
  await page.getByLabel(/welcome message/i).fill(welcomeMessage);
  await page.getByLabel(/input placeholder/i).fill(placeholderText);
  await page.getByRole('button', { name: /top left/i }).click({ timeout: REQUEST_TIMEOUT_MS });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/api/runtime/sdk-channels/${channel.id}`) &&
        response.request().method() === 'PATCH',
      { timeout: REQUEST_TIMEOUT_MS },
    ),
    page.getByRole('button', { name: /save configuration/i }).click({
      timeout: REQUEST_TIMEOUT_MS,
    }),
  ]);
  await page
    .getByText(/configuration saved|saved/i)
    .first()
    .waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    })
    .catch(() => null);
  await artifacts.captureScreenshot('ablp-285-configuration-saved.png');

  await clickChannelTab(page, /testing/i);
  await page.getByText(welcomeMessage, { exact: false }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.getByText(placeholderText, { exact: false }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  const share = await generateTestingShareLink(page, fixture.projectId);
  await artifacts.captureScreenshot('ablp-285-embed-and-link-updated.png');

  await page.goto(share.shareUrl, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page, 1_000);
  const launcher = page.getByTestId('share-preview-widget-launcher');
  await launcher.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  const launcherBox = await launcher.boundingBox();
  await launcher.click({ timeout: REQUEST_TIMEOUT_MS });
  const previewWidget = page.getByTestId('share-preview-widget');
  await previewWidget.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await page.getByText(welcomeMessage, { exact: false }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.getByPlaceholder(placeholderText).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  const previewWidgetBox = await previewWidget.boundingBox();
  await artifacts.captureScreenshot('ablp-285-share-link-preview-top-left.png');

  const embed = await apiJson(
    baseUrl,
    `/api/sdk/embed/${encodeURIComponent(fixture.projectId)}?channelId=${encodeURIComponent(
      channel.id,
    )}`,
    {
      headers: authHeaders(fixture.accessToken),
    },
  );
  const snippet = String(embed?.snippet ?? '');
  const snippetIncludesWelcome = snippet.includes(`welcome-message="${welcomeMessage}"`);
  const snippetIncludesPlaceholder = snippet.includes(`placeholder="${placeholderText}"`);
  const snippetIncludesPosition = snippet.includes(`position="${updatedPosition}"`);
  const previewWidgetRenderedTopLeft =
    Boolean(previewWidgetBox) && previewWidgetBox.x < 80 && previewWidgetBox.y < 80;
  const previewLauncherRenderedTopLeft =
    Boolean(launcherBox) && launcherBox.x < 80 && launcherBox.y < 80;

  return {
    summary:
      'ABLP-285: saved Web SDK channel widget configuration is reflected in the Testing tab embed code and generated share-link preview widget.',
    metadata: {
      issue: 'ABLP-285',
      projectId: fixture.projectId,
      channelId: channel.id,
      channelName,
      welcomeMessage,
      placeholderText,
      position: updatedPosition,
      shareUrl: share.shareUrl,
      embedSnippet: snippet,
      previewLauncherBox: launcherBox,
      previewWidgetBox,
    },
    assertions: [
      {
        name: 'embed-code-includes-updated-welcome-message',
        passed: snippetIncludesWelcome,
        details: snippet,
      },
      {
        name: 'embed-code-includes-updated-placeholder',
        passed: snippetIncludesPlaceholder,
        details: snippet,
      },
      {
        name: 'embed-code-includes-updated-position',
        passed: snippetIncludesPosition,
        details: snippet,
      },
      {
        name: 'generate-link-still-succeeds-after-config-save',
        passed: typeof share.shareUrl === 'string' && share.shareUrl.includes('/preview'),
        details: share.shareUrl,
      },
      {
        name: 'share-link-launcher-renders-top-left',
        passed: previewLauncherRenderedTopLeft,
        details: JSON.stringify(launcherBox),
      },
      {
        name: 'share-link-open-widget-renders-top-left',
        passed: previewWidgetRenderedTopLeft,
        details: JSON.stringify(previewWidgetBox),
      },
    ],
  };
}

async function runAblp381(context) {
  const { runtimeBaseUrl } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const agentName = `ablp_381_redos_${suffix}`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-381 Functional Evidence',
    projectSlugPrefix: 'ablp-381-functional-evidence',
  });
  const unsafePattern = '(a+)+$';
  const unsafeDsl = `
AGENT: ${agentName}
GOAL: "Collect account values while rejecting unsafe extraction patterns"
GATHER:
  account:
    PROMPT: "What is your account?"
    TYPE: string
    extraction_pattern: "${unsafePattern}"
`;

  await createAgent(context.baseUrl, fixture.accessToken, fixture.projectId, {
    name: agentName,
    description: 'ABLP-381 unsafe extraction_pattern evidence agent',
    dslContent: unsafeDsl,
  });

  const { toolId } = await createRuntimeHttpTool(context, fixture, {
    name: `ablp_381_compile_probe_${suffix}`,
    description: 'ABLP-381 evidence: Runtime version creation must reject unsafe GATHER regex.',
    endpoint: `${runtimeBaseUrl}/api/projects/${fixture.projectId}/agents/${agentName}/versions`,
    method: 'POST',
    headers: [{ key: 'Authorization', value: `Bearer ${fixture.accessToken}` }],
    body: JSON.stringify({ changelog: 'ABLP-381 unsafe extraction pattern evidence' }),
    bodyType: 'json',
  });
  const result = await executeToolFromToolsPage(
    context,
    fixture,
    toolId,
    'ablp-381-runtime-rejects-unsafe-pattern.png',
    { expectedText: ['HTTP 422', 'unsafe extraction_pattern'] },
  );

  const error = String(result?.error ?? '');
  const rejectedUnsafePattern =
    error.includes('HTTP 422') && error.includes('unsafe extraction_pattern');
  const mentionsNestedQuantifiers =
    error.includes('Nested quantifiers') || error.includes(unsafePattern);

  return {
    summary:
      'ABLP-381: Studio Tool Test called Runtime version creation for an agent with unsafe GATHER extraction_pattern and Runtime rejected it with HTTP 422.',
    metadata: {
      issue: 'ABLP-381',
      projectId: fixture.projectId,
      agentName,
      unsafePattern,
      toolId,
      error,
    },
    assertions: [
      {
        name: 'runtime-version-create-rejects-unsafe-extraction-pattern',
        passed: rejectedUnsafePattern,
        details: error,
      },
      {
        name: 'error-identifies-redos-shape',
        passed: mentionsNestedQuantifiers,
        details: error,
      },
    ],
  };
}

async function runAblp422(context) {
  const { runtimeBaseUrl } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const mainAgentName = `ablp_422_supervisor_${suffix}`;
  const siblingAgentName = `ablp_422_specialist_${suffix}`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-422 Functional Evidence',
    projectSlugPrefix: 'ablp-422-functional-evidence',
  });
  const siblingDsl = `
AGENT: ${siblingAgentName}
GOAL: "Handle specialist requests"
FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Specialist is ready."
  THEN: COMPLETE
`;
  const mainDsl = `
SUPERVISOR: ${mainAgentName}
GOAL: "Route requests to project sibling agents"
HANDOFF:
  - TO: ${siblingAgentName}
    WHEN: intent.type == "specialist"
    RETURN: false
`;

  await createAgent(context.baseUrl, fixture.accessToken, fixture.projectId, {
    name: siblingAgentName,
    description: 'ABLP-422 sibling specialist evidence agent',
    dslContent: siblingDsl,
  });
  await createAgent(context.baseUrl, fixture.accessToken, fixture.projectId, {
    name: mainAgentName,
    description: 'ABLP-422 supervisor evidence agent',
    dslContent: mainDsl,
  });

  const { toolId } = await createRuntimeHttpTool(context, fixture, {
    name: `ablp_422_version_probe_${suffix}`,
    description:
      'ABLP-422 evidence: Runtime version creation compiles a supervisor with project sibling DSLs.',
    endpoint: `${runtimeBaseUrl}/api/projects/${fixture.projectId}/agents/${mainAgentName}/versions`,
    method: 'POST',
    headers: [{ key: 'Authorization', value: `Bearer ${fixture.accessToken}` }],
    body: JSON.stringify({ changelog: 'ABLP-422 project peer compilation evidence' }),
    bodyType: 'json',
  });
  const result = await executeToolFromToolsPage(
    context,
    fixture,
    toolId,
    'ablp-422-runtime-version-created-with-peer-dsl.png',
    { expectedText: ['"success": true', '"versionId"'] },
  );

  const output = result?.output ?? null;
  const createdVersion =
    output?.success === true &&
    typeof output?.versionId === 'string' &&
    typeof output?.version === 'string';

  return {
    summary:
      'ABLP-422: Studio Tool Test called Runtime version creation for a supervisor that references a sibling project agent, and Runtime created the version successfully.',
    metadata: {
      issue: 'ABLP-422',
      projectId: fixture.projectId,
      mainAgentName,
      siblingAgentName,
      toolId,
      output,
    },
    assertions: [
      {
        name: 'version-created-for-agent-that-references-project-sibling',
        passed: createdVersion,
        details: JSON.stringify(output),
      },
    ],
  };
}

async function runAblp538(context) {
  const { runtimeBaseUrl } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-538 Functional Evidence',
    projectSlugPrefix: 'ablp-538-functional-evidence',
  });
  const sdkKey = await createSdkKey(
    context.baseUrl,
    fixture.accessToken,
    fixture.projectId,
    `ABLP-538 SDK Key ${suffix}`,
  );

  const publicKey = sdkKey.key;
  if (typeof publicKey !== 'string' || !publicKey.startsWith('pk_')) {
    throw new Error(`Expected a pk_* SDK key, received ${JSON.stringify(sdkKey)}`);
  }

  const configProbe = await createRuntimeHttpTool(context, fixture, {
    name: `ablp_538_sdk_config_${suffix}`,
    description: 'ABLP-538 evidence: public pk_* key can read SDK widget config only.',
    endpoint: `${runtimeBaseUrl}/api/v1/sdk/config/${fixture.projectId}`,
    method: 'GET',
    headers: [{ key: 'X-API-Key', value: publicKey }],
  });
  const configResult = await executeToolFromToolsPage(
    context,
    fixture,
    configProbe.toolId,
    'ablp-538-public-key-sdk-config-allowed.png',
    { expectedText: ['"projectId"', '"config"'] },
  );

  const controlProbe = await createRuntimeHttpTool(context, fixture, {
    name: `ablp_538_control_denied_${suffix}`,
    description:
      'ABLP-538 evidence: public pk_* key must not authenticate generic Runtime control APIs.',
    endpoint: `${runtimeBaseUrl}/api/projects/${fixture.projectId}/agents`,
    method: 'GET',
    headers: [{ key: 'Authorization', value: `Bearer ${publicKey}` }],
  });
  const controlResult = await executeToolFromToolsPage(
    context,
    fixture,
    controlProbe.toolId,
    'ablp-538-public-key-control-api-denied.png',
    { expectedText: ['HTTP 401'] },
  );

  const configAllowed = configResult?.output?.projectId === fixture.projectId;
  const controlDenied = String(controlResult?.error ?? '').includes('HTTP 401');

  return {
    summary:
      'ABLP-538: Studio Tool Test proved a pk_* key works for the public SDK config endpoint and is rejected by generic Runtime control API auth.',
    metadata: {
      issue: 'ABLP-538',
      projectId: fixture.projectId,
      keyPrefix: sdkKey.keyPrefix,
      configOutput: configResult?.output,
      controlError: controlResult?.error,
    },
    assertions: [
      {
        name: 'pk-key-can-read-sdk-config',
        passed: configAllowed,
        details: JSON.stringify(configResult?.output),
      },
      {
        name: 'pk-key-cannot-authenticate-control-api',
        passed: controlDenied,
        details: String(controlResult?.error ?? ''),
      },
    ],
  };
}

async function runAblp568(context) {
  const { runtimeBaseUrl } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const configuredCidrs = String(process.env.INTERNAL_NETWORK_EXTRA_CIDRS ?? '');
  if (
    !configuredCidrs
      .split(',')
      .map((entry) => entry.trim())
      .includes('160.83.0.0/16')
  ) {
    throw new Error(
      'ABLP-568 evidence requires INTERNAL_NETWORK_EXTRA_CIDRS=160.83.0.0/16 in the isolated Runtime environment.',
    );
  }

  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-568 Functional Evidence',
    projectSlugPrefix: 'ablp-568-functional-evidence',
  });

  const allowedProbe = await createRuntimeHttpTool(context, fixture, {
    name: `ablp_568_allowed_${suffix}`,
    description:
      'ABLP-568 evidence: Runtime internal-network middleware accepts configured extra VPC CIDR.',
    endpoint: `${runtimeBaseUrl}/health`,
    method: 'GET',
    headers: [{ key: 'X-Forwarded-For', value: '160.83.1.5' }],
  });
  const allowedResult = await executeToolFromToolsPage(
    context,
    fixture,
    allowedProbe.toolId,
    'ablp-568-extra-cidr-health-allowed.png',
    { expectedText: ['"status": "healthy"'] },
  );

  const blockedProbe = await createRuntimeHttpTool(context, fixture, {
    name: `ablp_568_blocked_${suffix}`,
    description:
      'ABLP-568 evidence: Runtime still rejects forwarded chains containing non-allowlisted public hops.',
    endpoint: `${runtimeBaseUrl}/health`,
    method: 'GET',
    headers: [{ key: 'X-Forwarded-For', value: '203.0.113.10, 160.83.1.5' }],
  });
  const blockedResult = await executeToolFromToolsPage(
    context,
    fixture,
    blockedProbe.toolId,
    'ablp-568-public-hop-health-blocked.png',
    { expectedText: ['HTTP 403'] },
  );

  const allowed = allowedResult?.output?.status === 'healthy';
  const blocked = String(blockedResult?.error ?? '').includes('HTTP 403');

  return {
    summary:
      'ABLP-568: Studio Tool Test called Runtime /health with configured extra CIDR headers and proved allowed VPC CIDR access while unrelated public hops remain blocked.',
    metadata: {
      issue: 'ABLP-568',
      projectId: fixture.projectId,
      configuredCidrs,
      allowedOutput: allowedResult?.output,
      blockedError: blockedResult?.error,
    },
    assertions: [
      {
        name: 'configured-extra-cidr-is-accepted',
        passed: allowed,
        details: JSON.stringify(allowedResult?.output),
      },
      {
        name: 'public-hop-outside-allowlist-is-still-rejected',
        passed: blocked,
        details: String(blockedResult?.error ?? ''),
      },
    ],
  };
}

async function runAblp424(context) {
  const probeServer = await startEventStoreProbeServer();
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-424 Functional Evidence',
    projectSlugPrefix: 'ablp-424-functional-evidence',
  });

  try {
    const { toolId } = await createRuntimeHttpTool(context, fixture, {
      name: `ablp_424_eventstore_probe_${suffix}`,
      description:
        'ABLP-424 evidence: EventStore agent.exited schema accepts continuation and constraint-blocked results.',
      endpoint: `${probeServer.baseUrl}/eventstore/agent-exited`,
      method: 'GET',
    });
    const result = await executeToolFromToolsPage(
      context,
      fixture,
      toolId,
      'ablp-424-eventstore-agent-exited-results.png',
      { expectedText: ['"continue": true', '"constraint_blocked": true'] },
    );

    const accepted = result?.output?.accepted ?? {};
    return {
      summary:
        'ABLP-424: Studio Tool Test invoked an EventStore schema probe and proved agent.exited accepts continue and constraint_blocked results.',
      metadata: {
        issue: 'ABLP-424',
        projectId: fixture.projectId,
        probeEndpoint: `${probeServer.baseUrl}/eventstore/agent-exited`,
        output: result?.output,
      },
      assertions: [
        {
          name: 'agent-exited-accepts-continue',
          passed: accepted.continue === true,
          details: JSON.stringify(accepted),
        },
        {
          name: 'agent-exited-accepts-constraint-blocked',
          passed: accepted.constraint_blocked === true,
          details: JSON.stringify(accepted),
        },
      ],
    };
  } finally {
    await probeServer.close();
  }
}

async function runAblp550(context) {
  const { artifacts, page } = context;
  const llmServer = await startEvalGenerationLlmServer();
  const evalsTraffic = recordEvalsTraffic(page);

  try {
    const { fixture, agentName } = await createEvalFixture(context, 'ABLP-550');
    await configureArchDirectOpenAi(context, fixture, llmServer.baseUrl);
    await openEvalsSurface(context, fixture.projectId);
    const generateButton = page.getByRole('button', { name: /generate with ai/i }).first();
    await generateButton.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    await waitForCondition(async () => generateButton.isEnabled().catch(() => false), {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 250,
      label: 'Timed out waiting for the persona Generate with AI button to become enabled.',
    });

    const generateResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${fixture.projectId}/evals/generate/personas`) &&
        response.request().method() === 'POST',
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const saveResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${fixture.projectId}/evals/personas`) &&
        response.request().method() === 'POST',
      { timeout: REQUEST_TIMEOUT_MS },
    );

    await generateButton.click({ timeout: REQUEST_TIMEOUT_MS });
    const [generateResponse, saveResponse] = await Promise.all([
      generateResponsePromise,
      saveResponsePromise,
    ]).catch((error) => {
      throw new Error(
        `Timed out waiting for ABLP-550 persona generate/save responses. Observed Evals traffic: ${JSON.stringify(evalsTraffic)}. ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const generateBody = await generateResponse.json();
    const saveBody = await saveResponse.json();

    await page.getByText('ABLP-550 Boundary Persona', { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await page.getByText('casual', { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await page.getByText('intermediate', { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await artifacts.captureScreenshot('ablp-550-generated-persona-saved.png');

    const generatedPersona = generateBody?.personas?.[0] ?? {};
    const savedPersona = saveBody?.persona ?? {};

    return {
      summary:
        'ABLP-550: Studio Eval personas generated from a malformed AI payload, normalized blank adversarialType to edge_case, and saved without the previous 400.',
      metadata: {
        issue: 'ABLP-550',
        projectId: fixture.projectId,
        agentName,
        llmProbeRequests: llmServer.requests.length,
        evalsTraffic,
        generatedPersona,
        savedPersona,
        generateStatus: generateResponse.status(),
        saveStatus: saveResponse.status(),
      },
      assertions: [
        {
          name: 'persona-generation-route-normalizes-blank-adversarial-type',
          passed:
            generateResponse.ok() &&
            generatedPersona.isAdversarial === true &&
            generatedPersona.adversarialType === 'edge_case',
          details: JSON.stringify(generatedPersona),
        },
        {
          name: 'persona-save-no-longer-returns-400',
          passed:
            saveResponse.status() === 201 &&
            saveBody?.success === true &&
            savedPersona.adversarialType === 'edge_case',
          details: JSON.stringify(saveBody),
        },
      ],
    };
  } finally {
    await llmServer.close();
  }
}

async function runAblp551(context) {
  const { artifacts, page } = context;
  const llmServer = await startEvalGenerationLlmServer();
  const evalsTraffic = recordEvalsTraffic(page);

  try {
    const { fixture, agentName } = await createEvalFixture(context, 'ABLP-551');
    await configureArchDirectOpenAi(context, fixture, llmServer.baseUrl);
    await openEvalsSurface(context, fixture.projectId);
    await page.getByRole('tab', { name: /scenarios/i }).click({ timeout: REQUEST_TIMEOUT_MS });
    const generateButton = page.getByRole('button', { name: /generate with ai/i }).first();
    await generateButton.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    await waitForCondition(async () => generateButton.isEnabled().catch(() => false), {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 250,
      label: 'Timed out waiting for the scenario Generate with AI button to become enabled.',
    });

    const generateResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${fixture.projectId}/evals/generate/scenarios`) &&
        response.request().method() === 'POST',
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const saveResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${fixture.projectId}/evals/scenarios`) &&
        response.request().method() === 'POST',
      { timeout: REQUEST_TIMEOUT_MS },
    );

    await generateButton.click({ timeout: REQUEST_TIMEOUT_MS });
    const [generateResponse, saveResponse] = await Promise.all([
      generateResponsePromise,
      saveResponsePromise,
    ]).catch((error) => {
      throw new Error(
        `Timed out waiting for ABLP-551 scenario generate/save responses. Observed Evals traffic: ${JSON.stringify(evalsTraffic)}. ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const generateBody = await generateResponse.json();
    const saveBody = await saveResponse.json();

    await page.getByText('ABLP-551 Billing Follow Up', { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await page.getByText('happy_path', { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await artifacts.captureScreenshot('ablp-551-generated-scenario-table.png');

    await page.getByText('ABLP-551 Billing Follow Up', { exact: true }).click({
      timeout: REQUEST_TIMEOUT_MS,
    });
    const dialog = page.locator('[role="dialog"]').last();
    await dialog.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    await dialog.getByText('Happy Path', { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await waitForCondition(
      async () => {
        const value = await dialog.getByLabel(/initial message/i).inputValue();
        return value.includes('I need help: Resolve a generated billing question.');
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 250,
        label: 'Timed out waiting for generated initial message to be populated.',
      },
    );
    await waitForCondition(
      async () => {
        const value = await dialog.getByLabel(/expected outcome/i).inputValue();
        return value.includes('User explains issue; Agent resolves issue');
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 250,
        label: 'Timed out waiting for generated expected outcome to be populated.',
      },
    );
    await artifacts.captureScreenshot('ablp-551-edit-dialog-fields-populated.png');

    const generatedScenario = generateBody?.scenarios?.[0] ?? {};
    const savedScenario = saveBody?.scenario ?? {};

    return {
      summary:
        'ABLP-551: Studio Eval scenarios generated from missing AI fields, filled initial message and expected outcome, saved the category, and showed the category selected in the edit dialog.',
      metadata: {
        issue: 'ABLP-551',
        projectId: fixture.projectId,
        agentName,
        llmProbeRequests: llmServer.requests.length,
        evalsTraffic,
        generatedScenario,
        savedScenario,
        generateStatus: generateResponse.status(),
        saveStatus: saveResponse.status(),
      },
      assertions: [
        {
          name: 'scenario-generation-fills-initial-message-and-expected-outcome',
          passed:
            generateResponse.ok() &&
            typeof generatedScenario.initialMessage === 'string' &&
            generatedScenario.initialMessage.length > 0 &&
            typeof generatedScenario.expectedOutcome === 'string' &&
            generatedScenario.expectedOutcome.length > 0,
          details: JSON.stringify(generatedScenario),
        },
        {
          name: 'scenario-category-is-selected-in-edit-dialog',
          passed: generatedScenario.category === 'happy_path' && saveResponse.status() === 201,
          details: JSON.stringify(saveBody),
        },
      ],
    };
  } finally {
    await llmServer.close();
  }
}

async function runAblp559(context) {
  const { artifacts, baseUrl, page } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const agentName = `ablp_559_action_agent_${suffix}`;
  const childAgentName = `ablp_559_child_agent_${suffix}`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-559 Functional Evidence',
    projectSlugPrefix: 'ablp-559-functional-evidence',
  });
  const dslContent = `
SUPERVISOR: ${agentName}
  GOAL: "Show two buttons and confirm which one was clicked."
  FLOW:
    entry_point: main_menu
    steps:
      - main_menu
      - selection_result
  main_menu:
    REASONING: false
    RESPOND: "Welcome to HandoffTest staging. Choose your preferred option:"
      ACTIONS:
        - BUTTON: "Agent A" -> agent_a
        - BUTTON: "Agent B" -> agent_b
    ON_ACTION:
      agent_a:
        SET: selected_agent = "Agent_A"
        RESPOND: "Agent A button clicked."
        TRANSITION: selection_result
      agent_b:
        SET: selected_agent = "Agent_B"
        RESPOND: "Agent B button clicked."
        TRANSITION: selection_result
    ON_INPUT:
      - ELSE:
          RESPOND: "Please click Agent A or Agent B."
          THEN: main_menu
  selection_result:
    REASONING: false
    RESPOND: "Selected: {{selected_agent}}"
`;

  await createAgent(baseUrl, fixture.accessToken, fixture.projectId, {
    name: childAgentName,
    description: 'ABLP-559 minimal child agent for supervisor Studio chat eligibility',
    dslContent: `
AGENT: ${childAgentName}
GOAL: "Allow the supervisor evidence agent to load in Studio chat."
FLOW:
  start:
    REASONING: false
    RESPOND: "Child ready."
    THEN: COMPLETE
`,
  });

  await createAgent(baseUrl, fixture.accessToken, fixture.projectId, {
    name: agentName,
    description: 'ABLP-559 Runtime ON_ACTION evidence agent',
    dslContent,
  });

  await installWebSocketSendProbe(page);
  await openStudioAgentChat(page, baseUrl, { projectId: fixture.projectId, agentName });
  await waitForMessageListText(page, 'Welcome to HandoffTest staging');
  await page.getByRole('button', { name: /^agent a$/i }).click({ timeout: REQUEST_TIMEOUT_MS });
  await waitForMessageListText(page, 'Selected: Agent_A');
  await artifacts.captureScreenshot('ablp-559-action-submit-follow-up-response.png');

  const sentFrames = await page.evaluate(() => window.__ablpActionSentFrames ?? []);
  const sentActionSubmit = sentFrames.some(
    (frame) => frame.includes('"type":"action_submit"') && frame.includes('"actionId":"agent_a"'),
  );
  const sentLegacyActionText = sentFrames.some((frame) => frame.includes('__action__:agent_a'));
  const renderedFallbackAfterClick = await page
    .getByText('Please click Agent A or Agent B.')
    .isVisible()
    .catch(() => false);

  return {
    summary:
      'ABLP-559: Studio chat button click sent a real action_submit WebSocket frame and Runtime executed the matching flow ON_ACTION branch even with an ON_INPUT fallback on the same step.',
    metadata: {
      issue: 'ABLP-559',
      projectId: fixture.projectId,
      agentName,
      childAgentName,
      sentFrames: sentFrames.filter((frame) => frame.includes('action')),
    },
    assertions: [
      {
        name: 'studio-chat-sent-real-action-submit-frame',
        passed: sentActionSubmit,
        details: JSON.stringify(sentFrames.filter((frame) => frame.includes('action'))),
      },
      {
        name: 'studio-chat-did-not-send-legacy-action-text',
        passed: !sentLegacyActionText,
        details: JSON.stringify(sentFrames.filter((frame) => frame.includes('__action__'))),
      },
      {
        name: 'runtime-flow-on-action-branch-rendered-selection-result',
        passed: true,
        details:
          'Visible Studio chat response included "Selected: Agent_A", proving the action handler SET + TRANSITION executed.',
      },
      {
        name: 'runtime-flow-did-not-fall-through-on-input-fallback',
        passed: !renderedFallbackAfterClick,
        details: renderedFallbackAfterClick
          ? 'Fallback prompt was visible after clicking Agent A.'
          : 'Fallback prompt was not visible after clicking Agent A.',
      },
    ],
  };
}

const RUNNERS = {
  'ABLP-265': runAblp265,
  'ABLP-282': runAblp282,
  'ABLP-285': runAblp285,
  'ABLP-381': runAblp381,
  'ABLP-422': runAblp422,
  'ABLP-424': runAblp424,
  'ABLP-550': runAblp550,
  'ABLP-551': runAblp551,
  'ABLP-538': runAblp538,
  'ABLP-559': runAblp559,
  'ABLP-568': runAblp568,
};

export const scenario = {
  id: 'ablp-functional-evidence',
  title: 'ABLP Functional Evidence',
  description:
    'Runs issue-specific functional Studio video evidence flows; use --issue ABLP-265 to prove HTTP form body behavior with a real tool execution.',
  example: 'pnpm studio:video:evidence -- --scenario ablp-functional-evidence --issue ABLP-265',
  async run(context) {
    const issue = String(context.options.issue ?? '')
      .trim()
      .toUpperCase();
    const runner = RUNNERS[issue];
    if (!runner) {
      throw new Error(`ablp-functional-evidence does not support issue ${issue}.`);
    }

    const result = await runner(context);
    const failedAssertions = result.assertions.filter((assertion) => !assertion.passed);
    if (failedAssertions.length > 0) {
      throw new Error(
        `${issue} functional evidence failed: ${failedAssertions
          .map((assertion) => `${assertion.name}: ${assertion.details}`)
          .join('; ')}`,
      );
    }

    return {
      ...result,
      metadata: {
        ...result.metadata,
        issue,
        evidenceType: 'functional-studio-tool-test',
      },
    };
  },
};
