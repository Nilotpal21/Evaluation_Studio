import http from 'node:http';

import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import {
  apiJson,
  buildStaticAgentDsl,
  createAgent,
  createProject,
  openStudioAgentChat,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { createStudioFixture } from '../lib/studio-harness.mjs';
import {
  createProjectConfigVariable,
  createProjectModel,
  createProjectTool,
  createTenantModel,
} from '../lib/studio-issue-api.mjs';
import { uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

const BATCH_ISSUES = [
  'ABLP-554',
  'ABLP-561',
  'ABLP-552',
  'ABLP-507',
  'ABLP-513',
  'ABLP-477',
  'ABLP-442',
  'ABLP-281',
  'ABLP-183',
];

function authHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  };
}

function normalizeIssue(input) {
  return String(input ?? '')
    .trim()
    .toUpperCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function createLocalJsonServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        json = null;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const captured = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        rawBody,
        json,
      };
      requests.push(captured);

      const body = handler ? handler(captured) : { ok: true, request: captured };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate local JSON evidence server port.'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
      });
    });
  });
}

async function fetchJsonAbsolute(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} failed (${response.status}): ${text}`);
  }
  return body;
}

async function gotoProjectRoute(context, projectId, routeSuffix) {
  const routePath = `/projects/${encodeURIComponent(projectId)}${routeSuffix}`;
  await context.page.goto(`${context.baseUrl}${routePath}`, { waitUntil: 'domcontentloaded' });
  await context.page
    .waitForURL((url) => url.pathname === routePath, { timeout: REQUEST_TIMEOUT_MS })
    .catch(() => {});
  await waitForIdle(context.page, 1_000);
  await context.page.locator('main').first().waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
}

async function waitForBodyText(page, expectedText, timeoutMs = REQUEST_TIMEOUT_MS) {
  await waitForCondition(
    async () => {
      const bodyText = await page
        .locator('body')
        .textContent()
        .catch(() => '');
      return bodyText?.includes(expectedText) ? true : false;
    },
    {
      timeoutMs,
      intervalMs: 250,
      label: `Timed out waiting for page body to contain "${expectedText}".`,
    },
  );
}

async function openApiJsonInBrowser(context, path, expectedText, screenshotName, accessToken) {
  if (accessToken) {
    await context.page.setExtraHTTPHeaders(authHeaders(accessToken));
  }
  try {
    await context.page.goto(`${context.baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
    await waitForBodyText(context.page, expectedText);
    await context.artifacts.captureScreenshot(screenshotName);
  } finally {
    if (accessToken) {
      await context.page.setExtraHTTPHeaders({});
    }
  }
}

function resolveToolId(created) {
  const toolId = created?.tool?.id ?? created?.id;
  if (!toolId) {
    throw new Error(`Unable to resolve tool id from ${JSON.stringify(created)}`);
  }
  return toolId;
}

async function openToolsSurface(context, projectId) {
  await gotoProjectRoute(context, projectId, '/tools');
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

async function clickTab(page, namePattern) {
  await page.getByRole('tab', { name: namePattern }).click({ timeout: REQUEST_TIMEOUT_MS });
  await waitForIdle(page, 800);
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
  await gotoProjectRoute(context, fixture.projectId, '/deployments');
  await context.page.getByRole('tab', { name: /channels/i }).click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await context.page.getByText('Web SDK', { exact: true }).first().click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await context.page.getByText(channelName, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await context.page.getByText(channelName, { exact: true }).click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await context.page.getByRole('tab', { name: /testing/i }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
}

async function generateTestingShareLink(page) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/sdk/share') && response.request().method() === 'POST',
    { timeout: REQUEST_TIMEOUT_MS },
  );
  await page
    .getByRole('button', { name: /^generate link$/i })
    .first()
    .click({
      timeout: REQUEST_TIMEOUT_MS,
    });

  const response = await responsePromise;
  const body = await response.json();
  if (!response.ok() || typeof body?.shareUrl !== 'string') {
    throw new Error(`Share link generation failed: ${JSON.stringify(body)}`);
  }

  await page.getByText(body.shareUrl, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  return body;
}

function extractShareToken(shareUrl) {
  const parsed = new URL(shareUrl);
  return new URLSearchParams(parsed.hash.slice(1)).get('share_token');
}

async function createWebSdkFixture(context, issue) {
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const agentName = `${issue.toLowerCase().replace('-', '_')}_preview_agent_${suffix}`;
  const channelName = `${issue} Web SDK ${suffix}`;
  const welcomeMessage = `${issue} preview connected ${suffix}`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: `${issue} Preview Evidence`,
    projectSlugPrefix: `${issue.toLowerCase()}-preview-evidence`,
  });

  await createAgent(context.baseUrl, fixture.accessToken, fixture.projectId, {
    name: agentName,
    description: `${issue} preview evidence agent`,
    dslContent: buildStaticAgentDsl(agentName, `${issue} runtime reply ${suffix}`),
  });

  const sdkKey = await createSdkKey(
    context.baseUrl,
    fixture.accessToken,
    fixture.projectId,
    `${issue} SDK Key ${suffix}`,
  );
  const channel = await createSdkChannel(
    context.baseUrl,
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
        welcomeMessage,
        placeholderText: `${issue} message`,
      },
    },
  );

  return { fixture, agentName, channelName, channel, welcomeMessage, suffix };
}

async function createEvalRecords(context, accessToken, projectId, issue, suffix) {
  const personaName = `${issue} Persona ${suffix}`;
  const scenarioName = `${issue} Scenario ${suffix}`;
  const evaluatorName = `${issue} Evaluator ${suffix}`;
  const setName = `${issue} Set ${suffix}`;

  const persona = await apiJson(
    context.baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/evals/personas`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        name: personaName,
        description: `${issue} persona with portable eval metadata`,
        communicationStyle: 'technical',
        domainKnowledge: 'expert',
        behaviorTraits: ['deterministic', 'evidence'],
        goals: 'Verify eval import/export behavior.',
        constraints: 'Keep responses concise.',
        sessionVariables: {
          consumer_id: `consumer-${suffix}`,
          contract_id: `contract-${suffix}`,
        },
        source: 'custom',
      }),
    },
  );

  const scenario = await apiJson(
    context.baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/evals/scenarios`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        name: scenarioName,
        description: `${issue} scenario`,
        category: 'regression',
        difficulty: 'easy',
        initialMessage: 'Please verify the imported eval fixtures.',
        expectedOutcome: 'The eval fixtures remain linked after import.',
        maxTurns: 3,
        tags: ['evidence'],
        agentPath: [],
        expectedMilestones: ['Persona selected', 'Evaluator linked'],
      }),
    },
  );

  const evaluator = await apiJson(
    context.baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/evals/evaluators`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        name: evaluatorName,
        description: `${issue} pass/fail evaluator`,
        type: 'code_scorer',
        category: 'custom',
        scorerName: 'always_pass',
        scorerConfig: { expected: true },
      }),
    },
  );

  const evalSet = await apiJson(
    context.baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/evals/sets`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        name: setName,
        description: `${issue} linked eval set`,
        personaIds: [persona.persona.id],
        scenarioIds: [scenario.scenario.id],
        evaluatorIds: [evaluator.evaluator.id],
        variants: 1,
        maxConcurrency: 1,
      }),
    },
  );

  return {
    persona: persona.persona,
    scenario: scenario.scenario,
    evaluator: evaluator.evaluator,
    evalSet: evalSet.evalSet,
    names: { personaName, scenarioName, evaluatorName, setName },
  };
}

async function runAblp554(context) {
  const { artifacts, baseUrl } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const agentName = `ablp_554_source_agent_${suffix}`;
  const sourceDsl = `AGENT: ${agentName}
GOAL: "Preserve source DSL shape, casing, and strings during export."
PERSONA: "Do not canonicalize this source block."
FLOW:
  entry_point: welcome_step
  steps:
    - welcome_step
welcome_step:
  REASONING: false
  RESPOND: "ABLP-554 source DSL kept exactly for ${suffix}."
  THEN: COMPLETE
`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-554 Source Export Evidence',
    projectSlugPrefix: 'ablp-554-source-export-evidence',
  });

  await createAgent(baseUrl, fixture.accessToken, fixture.projectId, {
    name: agentName,
    description: 'ABLP-554 source DSL export evidence agent',
    dslContent: sourceDsl,
  });

  const exportPath = `/api/projects/${encodeURIComponent(
    fixture.projectId,
  )}/export?format=folder&layers=core`;
  const exported = await apiJson(baseUrl, exportPath, {
    headers: authHeaders(fixture.accessToken),
  });
  const matchingFile = Object.entries(exported.files ?? {}).find(
    ([, content]) => typeof content === 'string' && content.includes(agentName),
  );
  const exportedSource = String(matchingFile?.[1] ?? '');

  await openApiJsonInBrowser(
    context,
    exportPath,
    `ABLP-554 source DSL kept exactly for ${suffix}.`,
    'ablp-554-source-export-json.png',
    fixture.accessToken,
  );

  return {
    summary:
      'ABLP-554: Studio project export defaults to source DSL and preserved the saved agent DSL without canonical YAML materialization.',
    metadata: {
      issue: 'ABLP-554',
      projectId: fixture.projectId,
      agentName,
      exportedFile: matchingFile?.[0] ?? null,
    },
    assertions: [
      {
        name: 'source-dsl-export-file-found',
        passed: Boolean(matchingFile),
        details: matchingFile?.[0] ?? 'missing',
      },
      {
        name: 'source-dsl-content-preserved',
        passed: exportedSource.trim() === sourceDsl.trim(),
        details: exportedSource,
      },
    ],
  };
}

async function runAblp561(context) {
  const { artifacts, baseUrl, page } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const sourceFixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-561 Eval Export Source',
    projectSlugPrefix: 'ablp-561-eval-export-source',
  });
  const evalRecords = await createEvalRecords(
    context,
    sourceFixture.accessToken,
    sourceFixture.projectId,
    'ABLP-561',
    suffix,
  );

  const exportBody = await apiJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(sourceFixture.projectId)}/export?format=folder&layers=evals`,
    { headers: authHeaders(sourceFixture.accessToken) },
  );
  const files = exportBody.files ?? {};
  const targetProject = await createProject(baseUrl, sourceFixture.accessToken, {
    name: `ABLP-561 Eval Import Target ${suffix}`,
    slug: `ablp-561-eval-import-target-${suffix.replaceAll('_', '-')}`,
  });

  const preview = await apiJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(targetProject.id)}/import/preview`,
    {
      method: 'POST',
      headers: authHeaders(sourceFixture.accessToken),
      body: JSON.stringify({ files }),
    },
  );
  const apply = await apiJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(targetProject.id)}/import/apply`,
    {
      method: 'POST',
      headers: authHeaders(sourceFixture.accessToken),
      body: JSON.stringify({
        files,
        previewDigest: preview.previewDigest,
        acknowledgedIssueIds: [],
      }),
    },
  );

  const [personas, scenarios, evaluators, sets] = await Promise.all([
    apiJson(baseUrl, `/api/projects/${encodeURIComponent(targetProject.id)}/evals/personas`, {
      headers: authHeaders(sourceFixture.accessToken),
    }),
    apiJson(baseUrl, `/api/projects/${encodeURIComponent(targetProject.id)}/evals/scenarios`, {
      headers: authHeaders(sourceFixture.accessToken),
    }),
    apiJson(baseUrl, `/api/projects/${encodeURIComponent(targetProject.id)}/evals/evaluators`, {
      headers: authHeaders(sourceFixture.accessToken),
    }),
    apiJson(baseUrl, `/api/projects/${encodeURIComponent(targetProject.id)}/evals/sets`, {
      headers: authHeaders(sourceFixture.accessToken),
    }),
  ]);

  await gotoProjectRoute(context, targetProject.id, '/evals');
  await clickTab(page, /personas/i);
  await page.getByText(evalRecords.names.personaName, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-561-imported-persona-visible.png');
  await clickTab(page, /eval sets/i);
  await page.getByText(evalRecords.names.setName, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-561-imported-eval-set-visible.png');

  const exportedEvalFiles = Object.keys(files).filter((filePath) => filePath.startsWith('evals/'));
  const targetPersona = asArray(personas.personas).find(
    (persona) => persona.name === evalRecords.names.personaName,
  );
  const targetSet = asArray(sets.sets).find((set) => set.name === evalRecords.names.setName);

  return {
    summary:
      'ABLP-561: Direct Studio import restored exported eval personas, scenarios, evaluators, and eval sets into a fresh project.',
    metadata: {
      issue: 'ABLP-561',
      sourceProjectId: sourceFixture.projectId,
      targetProjectId: targetProject.id,
      exportedEvalFiles,
      apply,
      importedCounts: {
        personas: asArray(personas.personas).length,
        scenarios: asArray(scenarios.scenarios).length,
        evaluators: asArray(evaluators.evaluators).length,
        sets: asArray(sets.sets).length,
      },
    },
    assertions: [
      {
        name: 'export-includes-eval-files',
        passed: exportedEvalFiles.some((filePath) => filePath.endsWith('.persona.json')),
        details: exportedEvalFiles.join(', '),
      },
      {
        name: 'import-apply-created-eval-entities',
        passed: (apply.applied?.evalsCreated ?? 0) >= 4,
        details: JSON.stringify(apply.applied ?? {}),
      },
      {
        name: 'imported-persona-retains-session-variables',
        passed:
          targetPersona?.sessionVariables?.consumer_id ===
          evalRecords.persona.sessionVariables.consumer_id,
        details: JSON.stringify(targetPersona?.sessionVariables ?? null),
      },
      {
        name: 'imported-eval-set-restores-linked-names',
        passed: Boolean(targetSet),
        details: JSON.stringify(targetSet ?? null),
      },
    ],
  };
}

async function runAblp552(context) {
  const { artifacts, baseUrl, page, runtimeBaseUrl } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const agentName = `ablp_552_context_agent_${suffix}`;
  const sessionVariables = {
    consumer_id: `consumer-${suffix}`,
    contract_id: `contract-${suffix}`,
  };
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-552 Eval Session Variables',
    projectSlugPrefix: 'ablp-552-eval-session-variables',
  });

  await createAgent(baseUrl, fixture.accessToken, fixture.projectId, {
    name: agentName,
    description: 'ABLP-552 HTTP test context evidence agent',
    dslContent: `
AGENT: ${agentName}
GOAL: "Echo injected eval session variables."
FLOW:
  start:
    REASONING: false
    RESPOND: "Eval context received consumer={{consumer_id}} contract={{contract_id}}"
    THEN: COMPLETE
`,
  });

  const evalRecords = await createEvalRecords(
    context,
    fixture.accessToken,
    fixture.projectId,
    'ABLP-552',
    suffix,
  );

  const runtimeResponse = await fetchJsonAbsolute(`${runtimeBaseUrl}/api/v1/chat/agent`, {
    method: 'POST',
    headers: authHeaders(fixture.accessToken),
    body: JSON.stringify({
      projectId: fixture.projectId,
      agentId: agentName,
      message: 'Start eval context proof',
      testContext: { sessionVariables },
    }),
  });

  await gotoProjectRoute(context, fixture.projectId, '/evals');
  await clickTab(page, /personas/i);
  await page.getByText(evalRecords.names.personaName, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  const personaHeading = page.getByText(evalRecords.names.personaName, { exact: true }).first();
  const personaCard = personaHeading.locator('xpath=ancestor::div[contains(@class,"group")][1]');
  await personaCard.locator('button').first().click({ force: true, timeout: REQUEST_TIMEOUT_MS });
  const dialog = page.locator('[role="dialog"]').last();
  await dialog.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await dialog.getByText(/session variables/i).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await dialog
    .locator('textarea')
    .filter({ hasText: /consumer_id/ })
    .first()
    .waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
  await artifacts.captureScreenshot('ablp-552-persona-session-variables-edit-dialog.png');

  await openApiJsonInBrowser(
    context,
    `/api/projects/${encodeURIComponent(fixture.projectId)}/evals/personas`,
    sessionVariables.consumer_id,
    'ablp-552-persona-session-variables-api.png',
    fixture.accessToken,
  );

  const responseText = String(runtimeResponse.response ?? '');

  return {
    summary:
      'ABLP-552: Eval personas store session variables and Runtime HTTP test context receives those variables for agent execution.',
    metadata: {
      issue: 'ABLP-552',
      projectId: fixture.projectId,
      agentName,
      personaId: evalRecords.persona.id,
      sessionVariables,
      runtimeResponse,
    },
    assertions: [
      {
        name: 'persona-session-variables-stored',
        passed:
          evalRecords.persona.sessionVariables?.consumer_id === sessionVariables.consumer_id &&
          evalRecords.persona.sessionVariables?.contract_id === sessionVariables.contract_id,
        details: JSON.stringify(evalRecords.persona.sessionVariables ?? null),
      },
      {
        name: 'runtime-http-test-context-uses-session-variables',
        passed:
          responseText.includes(sessionVariables.consumer_id) &&
          responseText.includes(sessionVariables.contract_id),
        details: responseText,
      },
    ],
  };
}

async function runAblp507(context) {
  const { artifacts, baseUrl, page } = context;
  const echoServer = await createLocalJsonServer((request) => ({
    ok: true,
    received: request.json,
  }));
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const toolName = `verify_pin_${suffix}`;
  const agentName = `ablp_507_pin_agent_${suffix}`;
  const storedPin = 'e82c4b19b8151ddc25d4d93baf7b908f';
  const targetPin = '2468';

  try {
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: false,
      projectNamePrefix: 'ABLP-507 CALL WITH Evidence',
      projectSlugPrefix: 'ablp-507-call-with-evidence',
    });

    await createProjectTool(baseUrl, fixture.accessToken, fixture.projectId, {
      name: toolName,
      toolType: 'http',
      description: 'ABLP-507 evidence HTTP tool that echoes resolved pin arguments.',
      endpoint: `${echoServer.baseUrl}/verify-pin`,
      method: 'POST',
      auth: 'none',
      parameters: [
        {
          name: 'source_pin',
          type: 'string',
          description: 'Stored pin hash',
          required: true,
        },
        {
          name: 'target_pin',
          type: 'string',
          description: 'User entered pin',
          required: true,
        },
      ],
      body: '{ "source_pin": "{{input.source_pin}}", "target_pin": "{{input.target_pin}}" }',
      bodyType: 'json',
      returnType: 'object',
    });

    await createAgent(baseUrl, fixture.accessToken, fixture.projectId, {
      name: agentName,
      description: 'ABLP-507 CALL WITH variable resolution evidence agent',
      dslContent: `
AGENT: ${agentName}
GOAL: "Verify CALL WITH resolves session variable names before tool execution."
TOOLS:
  ${toolName}(source_pin: string, target_pin: string) -> object
FLOW:
  start:
    REASONING: false
    SET: stored_pin = "${storedPin}"
    SET: pin = "${targetPin}"
    CALL: ${toolName}
      WITH:
        source_pin: stored_pin
        target_pin: pin
      AS: verification_result
    RESPOND: "ABLP-507 CALL WITH completed."
    THEN: COMPLETE
`,
    });

    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName,
    });
    await waitForMessageListText(page, 'ABLP-507 CALL WITH completed.');
    const capturedRequest = await waitForCondition(() => echoServer.requests[0] ?? null, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 200,
      label: 'Timed out waiting for verify_pin echo request.',
    });
    await artifacts.captureScreenshot('ablp-507-call-with-chat-result.png');

    return {
      summary:
        'ABLP-507: Runtime CALL WITH resolved stored_pin and pin session variables before invoking the HTTP tool.',
      metadata: {
        issue: 'ABLP-507',
        projectId: fixture.projectId,
        agentName,
        toolName,
        capturedRequest,
      },
      assertions: [
        {
          name: 'call-with-source-pin-resolved',
          passed: capturedRequest.json?.source_pin === storedPin,
          details: JSON.stringify(capturedRequest.json),
        },
        {
          name: 'call-with-target-pin-resolved',
          passed: capturedRequest.json?.target_pin === targetPin,
          details: JSON.stringify(capturedRequest.json),
        },
      ],
    };
  } finally {
    await echoServer.close();
  }
}

async function runAblp513(context) {
  const { artifacts, baseUrl, page } = context;
  const echoServer = await createLocalJsonServer((request) => ({
    ok: true,
    path: request.path,
    query: request.query,
    region: request.headers['x-region'],
    body: request.json,
  }));
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const toolName = `ablp_513_config_tool_${suffix}`;

  try {
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: false,
      projectNamePrefix: 'ABLP-513 Tool Config Evidence',
      projectSlugPrefix: 'ablp-513-tool-config-evidence',
    });

    const created = await createProjectTool(baseUrl, fixture.accessToken, fixture.projectId, {
      name: toolName,
      toolType: 'http',
      description: 'ABLP-513 config variable resolution evidence tool',
      endpoint: `${echoServer.baseUrl}/placeholder`,
      method: 'POST',
      auth: 'none',
      parameters: [
        {
          name: 'message',
          type: 'string',
          description: 'Message payload',
          required: true,
        },
      ],
      body: '{ "message": "{{input.message}}" }',
      bodyType: 'json',
      returnType: 'object',
    });
    const toolId = resolveToolId(created);
    const toolDetail = await apiJson(
      baseUrl,
      `/api/projects/${encodeURIComponent(fixture.projectId)}/tools/${encodeURIComponent(toolId)}`,
      { headers: authHeaders(fixture.accessToken) },
    );
    const namespaceIds =
      toolDetail?.tool?.variableNamespaceIds ??
      toolDetail?.variableNamespaceIds ??
      created?.tool?.variableNamespaceIds ??
      [];
    if (!Array.isArray(namespaceIds) || namespaceIds.length === 0) {
      throw new Error('ABLP-513 evidence tool did not receive a variable namespace.');
    }

    const configValues = {
      API_BASE: echoServer.baseUrl,
      ORG_ID: `org-${suffix}`,
      REGION: 'us-east-1',
      ENV_NAME: `env-${suffix}`,
    };
    for (const [key, value] of Object.entries(configValues)) {
      await createProjectConfigVariable(baseUrl, fixture.accessToken, fixture.projectId, {
        key,
        value,
        description: `ABLP-513 ${key}`,
        variableNamespaceIds: namespaceIds,
      });
    }

    const dslContent = [
      `${toolName}(message: string) -> object`,
      '  description: "Send event to {{config.ENV_NAME}}"',
      '  type: http',
      '  endpoint: "{{config.API_BASE}}/config-echo"',
      '  method: POST',
      '  query_params:',
      '    org: "{{config.ORG_ID}}"',
      '  headers:',
      '    X-Region: "{{config.REGION}}"',
      '  body: |',
      '    { "environment": "{{config.ENV_NAME}}", "message": "{{input.message}}" }',
    ].join('\n');
    await apiJson(
      baseUrl,
      `/api/projects/${encodeURIComponent(fixture.projectId)}/tools/${encodeURIComponent(toolId)}`,
      {
        method: 'PUT',
        headers: authHeaders(fixture.accessToken),
        body: JSON.stringify({ dslContent, variableNamespaceIds: namespaceIds }),
      },
    );

    await openToolsSurface(context, fixture.projectId);
    const dialog = await openToolTestDialog(page, toolId);
    await dialog.getByRole('button', { name: /json/i }).click({ timeout: REQUEST_TIMEOUT_MS });
    await dialog
      .locator('textarea')
      .first()
      .fill(JSON.stringify({ message: `hello-${suffix}` }, null, 2));
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${fixture.projectId}/tools/${toolId}/test`) &&
        response.request().method() === 'POST',
      { timeout: REQUEST_TIMEOUT_MS },
    );
    await dialog.getByRole('button', { name: /execute/i }).click({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await responsePromise;

    const capturedRequest = await waitForCondition(() => echoServer.requests[0] ?? null, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 200,
      label: 'Timed out waiting for config-variable echo request.',
    });
    await dialog.getByText(configValues.ORG_ID, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await dialog.getByText(configValues.ENV_NAME, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await artifacts.captureScreenshot('ablp-513-tool-test-config-resolution.png');

    return {
      summary:
        'ABLP-513: Studio Tool Test resolved {{config.*}} placeholders in endpoint, query params, headers, and body before executing the HTTP tool.',
      metadata: {
        issue: 'ABLP-513',
        projectId: fixture.projectId,
        toolId,
        toolName,
        namespaceIds,
        capturedRequest,
      },
      assertions: [
        {
          name: 'config-endpoint-and-query-resolved',
          passed:
            capturedRequest.path === '/config-echo' &&
            capturedRequest.query.org === configValues.ORG_ID,
          details: `${capturedRequest.path} ${JSON.stringify(capturedRequest.query)}`,
        },
        {
          name: 'config-header-resolved',
          passed: capturedRequest.headers['x-region'] === configValues.REGION,
          details: String(capturedRequest.headers['x-region']),
        },
        {
          name: 'config-body-resolved',
          passed:
            capturedRequest.json?.environment === configValues.ENV_NAME &&
            capturedRequest.json?.message === `hello-${suffix}`,
          details: JSON.stringify(capturedRequest.json),
        },
      ],
    };
  } finally {
    await echoServer.close();
  }
}

async function runAblp477(context) {
  const { artifacts, baseUrl, page } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const modelName = `ABLP-477 Claude No Credentials ${suffix}`;
  const modelId = `claude-no-credentials-${suffix}`;
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: true,
    projectNamePrefix: 'ABLP-477 Model Selector Evidence',
    projectSlugPrefix: 'ablp-477-model-selector-evidence',
    agentNamePrefix: 'ablp_477_agent',
  });

  const tenantModel = await createTenantModel(baseUrl, fixture.accessToken, {
    displayName: modelName,
    integrationType: 'easy',
    modelId,
    provider: 'anthropic',
    supportsTools: true,
    supportsStreaming: true,
    capabilities: ['text', 'tools', 'streaming'],
    tier: 'balanced',
    isDefault: false,
  });
  await createProjectModel(baseUrl, fixture.accessToken, {
    projectId: fixture.projectId,
    name: modelName,
    modelId,
    provider: 'anthropic',
    tenantModelId: tenantModel.id,
    temperature: 0.2,
    maxTokens: 2048,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    contextWindow: 200000,
    tier: 'balanced',
    isDefault: false,
    priority: 0,
  });

  await page.goto(
    `${baseUrl}/projects/${encodeURIComponent(fixture.projectId)}/agents/${encodeURIComponent(
      fixture.agentName,
    )}#execution`,
    { waitUntil: 'domcontentloaded' },
  );
  await waitForIdle(page, 1_000);
  const executionButton = page.getByRole('button', { name: /^execution$/i }).first();
  if (await executionButton.isVisible().catch(() => false)) {
    await executionButton.click({ timeout: REQUEST_TIMEOUT_MS });
  }
  await page.getByText('Primary Model', { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.getByText(/without active credentials.*hidden from this list/i).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-477-model-selector-hides-uncredentialed-model.png');

  const mainText = await page.locator('main').textContent();
  const modelNameVisible = mainText?.includes(modelName) ?? false;

  return {
    summary:
      'ABLP-477: Agent Execution primary model selector hides project models whose tenant model has no active credential connection.',
    metadata: {
      issue: 'ABLP-477',
      projectId: fixture.projectId,
      agentName: fixture.agentName,
      tenantModelId: tenantModel.id,
      modelName,
      modelId,
    },
    assertions: [
      {
        name: 'uncredentialed-project-model-warning-visible',
        passed: true,
        details: 'Studio displayed the hidden uncredentialed project model warning.',
      },
      {
        name: 'uncredentialed-model-name-not-selectable',
        passed: !modelNameVisible,
        details: modelNameVisible
          ? `${modelName} was visible in the execution pane.`
          : `${modelName} was not visible in the execution pane.`,
      },
    ],
  };
}

async function runAblp442(context) {
  const { artifacts, baseUrl, page } = context;
  const preview = await createWebSdkFixture(context, 'ABLP-442');

  await openSdkWebChannelConfig(context, preview.fixture, preview.channelName);
  await clickTab(page, /testing/i);
  const share = await generateTestingShareLink(page);
  await artifacts.captureScreenshot('ablp-442-share-link-generated.png');

  const shareToken = extractShareToken(share.shareUrl);
  if (!shareToken) {
    throw new Error(`Unable to extract share token from ${share.shareUrl}`);
  }
  const exchange = await apiJson(baseUrl, '/api/sdk/share/exchange', {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: JSON.stringify({ token: shareToken }),
  });

  await page.goto(share.shareUrl, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page, 1_000);
  await page.locator('button.fixed').last().waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-442-preview-link-accepted-session-read.png');

  const permissions = asArray(exchange.permissions);
  return {
    summary:
      'ABLP-442: Shared preview accepted Runtime SDK session scopes when Runtime added derived session:read to session:send_message.',
    metadata: {
      issue: 'ABLP-442',
      projectId: preview.fixture.projectId,
      channelId: preview.channel.id,
      shareUrl: share.shareUrl,
      permissions,
    },
    assertions: [
      {
        name: 'runtime-exchange-includes-derived-session-read',
        passed:
          permissions.includes('session:send_message') && permissions.includes('session:read'),
        details: permissions.join(', '),
      },
      {
        name: 'preview-page-accepted-derived-scope',
        passed: true,
        details: 'Preview page rendered the chat launcher instead of Access Denied.',
      },
    ],
  };
}

async function installPreviewWebSocketProbe(page) {
  await page.addInitScript(() => {
    if (window.__ablpPreviewWsProbeInstalled) return;
    window.__ablpPreviewWsProbeInstalled = true;
    window.__ablpPreviewSockets = [];
    const NativeWebSocket = window.WebSocket;
    function ProbedWebSocket(url, protocols) {
      const socket =
        protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      window.__ablpPreviewSockets.push(socket);
      return socket;
    }
    ProbedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    ProbedWebSocket.OPEN = NativeWebSocket.OPEN;
    ProbedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    ProbedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    ProbedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(ProbedWebSocket, NativeWebSocket);
    window.WebSocket = ProbedWebSocket;
  });
}

async function getOpenPreviewSocketCount(page) {
  return page.evaluate(() => {
    const sockets = window.__ablpPreviewSockets ?? [];
    return sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length;
  });
}

async function closePreviewSockets(page) {
  await page.evaluate(() => {
    const sockets = window.__ablpPreviewSockets ?? [];
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(4001, 'ABLP-281 retry evidence close');
      }
    }
  });
}

async function runAblp281(context) {
  const { artifacts, page } = context;
  const preview = await createWebSdkFixture(context, 'ABLP-281');

  await openSdkWebChannelConfig(context, preview.fixture, preview.channelName);
  await clickTab(page, /testing/i);
  const share = await generateTestingShareLink(page);
  await artifacts.captureScreenshot('ablp-281-share-link-generated.png');

  await installPreviewWebSocketProbe(page);
  await page.goto(share.shareUrl, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page, 1_000);
  await page.locator('button.fixed').last().click({ timeout: REQUEST_TIMEOUT_MS });
  await page.getByText(preview.welcomeMessage, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  const openBeforeClose = await getOpenPreviewSocketCount(page);
  await artifacts.captureScreenshot('ablp-281-preview-connected-before-retry.png');

  await closePreviewSockets(page);
  await page.getByText(/connection error/i).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-281-retry-connection-visible.png');

  await page.getByRole('button', { name: /retry connection/i }).click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await waitForCondition(async () => (await getOpenPreviewSocketCount(page)) > 0, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    intervalMs: 250,
    label: 'Timed out waiting for preview retry to reconnect a WebSocket.',
  });
  await page
    .getByText(/connection error/i)
    .waitFor({ state: 'hidden', timeout: REQUEST_TIMEOUT_MS });
  await artifacts.captureScreenshot('ablp-281-preview-reconnected-after-retry.png');
  const openAfterRetry = await getOpenPreviewSocketCount(page);

  return {
    summary:
      'ABLP-281: Shared preview Retry Connection exchanged a fresh SDK session and reopened the WebSocket after an interrupted preview session.',
    metadata: {
      issue: 'ABLP-281',
      projectId: preview.fixture.projectId,
      channelId: preview.channel.id,
      shareUrl: share.shareUrl,
      openBeforeClose,
      openAfterRetry,
    },
    assertions: [
      {
        name: 'preview-websocket-connected-before-close',
        passed: openBeforeClose > 0,
        details: String(openBeforeClose),
      },
      {
        name: 'preview-retry-reconnected-websocket',
        passed: openAfterRetry > 0,
        details: String(openAfterRetry),
      },
    ],
  };
}

async function runAblp183(context) {
  const { artifacts, baseUrl, page } = context;
  const suffix = uniqueSuffix().replace(/-/g, '_');
  const fixture = await createStudioFixture(context, {
    requireProject: true,
    requireAgent: false,
    projectNamePrefix: 'ABLP-183 Project A',
    projectSlugPrefix: 'ablp-183-project-a',
  });
  const projectB = await createProject(baseUrl, fixture.accessToken, {
    name: `ABLP-183 Project B ${suffix}`,
    slug: `ablp-183-project-b-${suffix.replaceAll('_', '-')}`,
  });
  const agentA = `ablp_183_agent_a_${suffix}`;
  const agentB = `ablp_183_agent_b_${suffix}`;
  const replyA = `ABLP-183 Project A reply ${suffix}`;
  const replyB = `ABLP-183 Project B reply ${suffix}`;

  await createAgent(baseUrl, fixture.accessToken, fixture.projectId, {
    name: agentA,
    description: 'ABLP-183 project A stale debug source',
    dslContent: buildStaticAgentDsl(agentA, replyA),
  });
  await createAgent(baseUrl, fixture.accessToken, projectB.id, {
    name: agentB,
    description: 'ABLP-183 project B debug reset target',
    dslContent: buildStaticAgentDsl(agentB, replyB),
  });

  await openStudioAgentChat(page, baseUrl, {
    projectId: fixture.projectId,
    agentName: agentA,
  });
  await waitForMessageListText(page, replyA);
  await page.getByRole('button', { name: /debug/i }).first().click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-183-project-a-debug-before-switch.png');

  await openStudioAgentChat(page, baseUrl, {
    projectId: projectB.id,
    agentName: agentB,
  });
  await waitForMessageListText(page, replyB);
  await page.getByRole('button', { name: /debug/i }).first().click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-183-project-b-debug-after-switch.png');

  const bodyText = await page.locator('body').textContent();
  const staleProjectATextVisible = bodyText?.includes(replyA) ?? false;
  const projectBTextVisible = bodyText?.includes(replyB) ?? false;

  return {
    summary:
      'ABLP-183: Switching projects and testing a second agent clears stale chat/debug content from the previous project.',
    metadata: {
      issue: 'ABLP-183',
      projectAId: fixture.projectId,
      projectBId: projectB.id,
      agentA,
      agentB,
      replyA,
      replyB,
    },
    assertions: [
      {
        name: 'new-project-debug-does-not-show-previous-project-reply',
        passed: !staleProjectATextVisible,
        details: staleProjectATextVisible ? replyA : 'Previous project reply absent after switch.',
      },
      {
        name: 'new-project-chat-response-visible',
        passed: projectBTextVisible,
        details: projectBTextVisible ? replyB : 'Project B reply missing.',
      },
    ],
  };
}

const RUNNERS = {
  'ABLP-554': runAblp554,
  'ABLP-561': runAblp561,
  'ABLP-552': runAblp552,
  'ABLP-507': runAblp507,
  'ABLP-513': runAblp513,
  'ABLP-477': runAblp477,
  'ABLP-442': runAblp442,
  'ABLP-281': runAblp281,
  'ABLP-183': runAblp183,
};

async function runIssue(context, issue) {
  const runner = RUNNERS[issue];
  if (!runner) {
    throw new Error(`ablp-batch-two-evidence does not support issue ${issue}.`);
  }
  const result = await runner(context);
  const failed = result.assertions.filter((assertion) => !assertion.passed);
  if (failed.length > 0) {
    throw new Error(
      `${issue} evidence failed: ${failed
        .map((assertion) => `${assertion.name}: ${assertion.details}`)
        .join('; ')}`,
    );
  }
  return result;
}

export const scenario = {
  id: 'ablp-batch-two-evidence',
  title: 'ABLP Batch Two Evidence',
  description:
    'Runs real Studio UI/API video evidence flows for the second ABLP closure batch by passing --issue <key> or --issue ABLP-BATCH2.',
  example: 'pnpm studio:video:evidence -- --scenario ablp-batch-two-evidence --issue ABLP-513',
  async run(context) {
    const issue = normalizeIssue(context.options.issue);
    if (!issue) {
      throw new Error('ablp-batch-two-evidence requires --issue <ABLP-key|ABLP-BATCH2>.');
    }

    const issues = issue === 'ABLP-BATCH2' ? BATCH_ISSUES : [issue];
    const results = [];
    for (const issueKey of issues) {
      context.log?.(`Running ${issueKey} evidence flow`);
      results.push(await runIssue(context, issueKey));
    }

    return {
      summary: results.map((result) => result.summary).join('\n'),
      metadata: {
        issue,
        issues,
        results: Object.fromEntries(
          results.map((result) => [result.metadata.issue, result.metadata]),
        ),
      },
      assertions: results.flatMap((result) =>
        result.assertions.map((assertion) => ({
          ...assertion,
          name: `${result.metadata.issue}:${assertion.name}`,
        })),
      ),
    };
  },
};
