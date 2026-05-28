import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import { createStudioFixture } from '../lib/studio-harness.mjs';
import { openStudioAgentChat, waitForIdle } from '../lib/studio-chat.mjs';
import {
  createProjectEnvironmentVariable,
  createTenantModel,
  listProjectModels,
  listProjectTools,
  testProjectPIIPattern,
} from '../lib/studio-issue-api.mjs';
import { numberFromInput, uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function gotoProjectRoute(page, baseUrl, projectId, routeSuffix) {
  await page.goto(`${baseUrl}/projects/${encodeURIComponent(projectId)}${routeSuffix}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('main').first().waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await waitForIdle(page, 800);
}

async function chooseSelectOption(page, scope, labelText, optionText) {
  const label = scope
    .locator('label')
    .filter({ hasText: new RegExp(escapeRegExp(labelText), 'i') })
    .first();
  const selectId = await label.getAttribute('for');
  if (!selectId) {
    throw new Error(`Unable to resolve select "${labelText}"`);
  }

  const trigger = scope.locator(`#${selectId}`).first();
  await trigger.click({ timeout: REQUEST_TIMEOUT_MS });

  const option = page.getByRole('option', { name: optionText, exact: true }).last();
  await option.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await option.click({ timeout: REQUEST_TIMEOUT_MS });
}

function inputAfterLabel(scope, labelPattern) {
  return scope
    .locator('label')
    .filter({ hasText: labelPattern })
    .first()
    .locator('xpath=following::input[1]');
}

async function waitForToast(page, pattern, timeoutMs = REQUEST_TIMEOUT_MS) {
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: pattern }).first();
  await toast.waitFor({ state: 'visible', timeout: timeoutMs });
  return toast;
}

async function runAblp540(context, fixture) {
  const { page, baseUrl, artifacts } = context;
  const modelName = 'GPT-4o Realtime Preview (2025-06-03)';
  const modelId = 'gpt-4o-realtime-preview-2025-06-03';
  const apiResponses = [];
  const responseListener = async (response) => {
    if (!response.url().includes('/api/models') || response.request().method() !== 'POST') {
      return;
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }

    apiResponses.push({
      url: response.url(),
      status: response.status(),
      body,
    });
  };

  page.on('response', responseListener);
  try {
    await createTenantModel(baseUrl, fixture.accessToken, {
      displayName: modelName,
      integrationType: 'easy',
      modelId,
      provider: 'openai',
      supportsTools: true,
      supportsStreaming: true,
      capabilities: ['text', 'streaming', 'realtime_voice'],
      tier: 'voice',
      isDefault: false,
    });

    await gotoProjectRoute(page, baseUrl, fixture.projectId, '/settings/models');
    await page.getByRole('button', { name: /add from catalog/i }).click({
      timeout: REQUEST_TIMEOUT_MS,
    });

    const dialog = page.locator('[role="dialog"]').last();
    await dialog.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    await dialog.getByText(modelName, { exact: true }).waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });

    const addButton = dialog
      .locator('div')
      .filter({ hasText: modelName })
      .getByRole('button', { name: /^add$/i })
      .first();
    await addButton.click({ timeout: REQUEST_TIMEOUT_MS });

    await waitForCondition(() => apiResponses.length > 0, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 200,
      label: 'Timed out waiting for the project model create request.',
    });

    await waitForToast(page, new RegExp(escapeRegExp(`Added ${modelName}`))).catch(() => null);
    await dialog.waitFor({ state: 'hidden', timeout: REQUEST_TIMEOUT_MS }).catch(() => null);
    await waitForIdle(page, 800);
    await artifacts.captureScreenshot('ablp-540-realtime-voice-model-add-success.png');

    const models = await waitForCondition(
      async () => {
        const entries = await listProjectModels(baseUrl, fixture.accessToken, fixture.projectId);
        return entries.some((model) => model.modelId === modelId) ? entries : null;
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 500,
        label: 'Timed out waiting for the project model to appear after add.',
      },
    );

    return {
      summary:
        'ABLP-540: adding the GPT-4o Realtime Preview voice-tier catalog model now succeeds at project level.',
      metadata: {
        issue: 'ABLP-540',
        projectId: fixture.projectId,
        modelName,
        apiResponses,
        projectModelCount: models.length,
      },
      assertions: [
        {
          name: 'project-model-create-succeeds',
          passed: apiResponses.some((entry) => entry.status >= 200 && entry.status < 300),
          details: `Observed statuses: ${apiResponses.map((entry) => entry.status).join(', ')}`,
        },
        {
          name: 'display-name-preserved',
          passed: models.some((model) => model.name === modelName && model.modelId === modelId),
          details: `Project model count after add: ${models.length}`,
        },
      ],
    };
  } finally {
    page.off('response', responseListener);
  }
}

async function runAblp536(context, fixture) {
  const { page, baseUrl, artifacts } = context;

  await gotoProjectRoute(page, baseUrl, fixture.projectId, '/settings/pii-protection');
  await page.getByText('Email Address', { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page
    .getByRole('button', { name: /configure/i })
    .first()
    .click({
      timeout: REQUEST_TIMEOUT_MS,
    });

  const dialog = page.locator('[role="dialog"]').last();
  await dialog.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  const textarea = dialog.locator('textarea').first();
  await textarea.fill('alice@example.com');

  await dialog.getByRole('button', { name: /^test$/i }).click({
    timeout: REQUEST_TIMEOUT_MS,
  });

  const previewVisible = await dialog
    .getByText(/consumer previews|detections/i)
    .first()
    .waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);

  await chooseSelectOption(page, dialog, 'Default Render Mode', 'Masked');

  const createResponse = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${fixture.projectId}/pii-patterns`) &&
        !response.url().includes('/test') &&
        response.request().method() === 'POST',
      { timeout: REQUEST_TIMEOUT_MS },
    ),
    dialog.getByRole('button', { name: /save changes/i }).click({
      timeout: REQUEST_TIMEOUT_MS,
    }),
  ]).then(([response]) => response);

  const createStatus = createResponse.status();
  const createUrl = createResponse.url();
  const createBody = await createResponse.text().catch(() => '<unreadable>');

  await page.getByText('Customized', { exact: true }).first().waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });

  await page
    .getByRole('button', { name: /configure/i })
    .first()
    .click({
      timeout: REQUEST_TIMEOUT_MS,
    });

  const editDialog = page.locator('[role="dialog"]').last();
  await editDialog.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await chooseSelectOption(page, editDialog, 'Default Render Mode', 'Redacted');

  const updateResponse = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${fixture.projectId}/pii-patterns/`) &&
        response.request().method() === 'PUT',
      { timeout: REQUEST_TIMEOUT_MS },
    ),
    editDialog.getByRole('button', { name: /save changes/i }).click({
      timeout: REQUEST_TIMEOUT_MS,
    }),
  ]).then(([response]) => response);

  const updateStatus = updateResponse.status();
  const updateUrl = updateResponse.url();
  const updateBody = await updateResponse.text().catch(() => '<unreadable>');

  await page.waitForTimeout(1500);
  await artifacts.captureScreenshot('ablp-536-builtin-pattern-config-fixed.png');

  const hasErrorToast = await page
    .locator('[data-sonner-toast]')
    .filter({ hasText: /Unexpected token|Failed|Error/i })
    .first()
    .isVisible()
    .catch(() => false);

  return {
    summary:
      'ABLP-536: built-in PII pattern configuration now previews using built-in recognizers, creates the first override with POST, and updates subsequent saves with PUT.',
    metadata: {
      issue: 'ABLP-536',
      projectId: fixture.projectId,
      previewVisible,
      createStatus,
      createUrl,
      createBody: createBody.slice(0, 500),
      updateStatus,
      updateUrl,
      updateBody: updateBody.slice(0, 500),
      hasErrorToast,
    },
    assertions: [
      {
        name: 'test-produces-preview',
        passed: previewVisible,
        details: `Preview visible after clicking Test: ${String(previewVisible)}`,
      },
      {
        name: 'first-save-creates-override',
        passed: createStatus >= 200 && createStatus < 300,
        details: `Observed POST ${createStatus} at ${createUrl}`,
      },
      {
        name: 'subsequent-save-updates-override',
        passed: updateStatus >= 200 && updateStatus < 300,
        details: `Observed PUT ${updateStatus} at ${updateUrl}`,
      },
      {
        name: 'save-flow-has-no-error-toast',
        passed: !hasErrorToast,
        details: `Error toast visible after save flow: ${String(hasErrorToast)}`,
      },
    ],
  };
}

async function runAblp534(context, fixture) {
  const { page, baseUrl, runtimeBaseUrl, artifacts } = context;
  const uuid = '780b4d1c-1166-487e-ae7a-27eedd12905b';
  const previewPrefix = 'Contract ID ';
  const regex = '[0-9a-fA-F-]{36}';
  const previewRequestBody = {
    regex,
    text: `${previewPrefix}${uuid}`,
    redaction: {
      type: 'random',
      randomConfig: {
        charset: 'numeric',
        length: 6,
      },
    },
    consumerAccess: [],
    piiType: 'custom',
  };

  await gotoProjectRoute(page, baseUrl, fixture.projectId, '/settings/pii-protection');
  await page.getByText('Custom Patterns', { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page
    .getByRole('button', { name: /add pattern/i })
    .first()
    .click({
      timeout: REQUEST_TIMEOUT_MS,
    });

  const dialog = page.locator('[role="dialog"]').last();
  async function runPreviewForMode(renderModeLabel, renderModeValue) {
    await chooseSelectOption(page, dialog, 'Default Render Mode', renderModeLabel);
    await page.waitForTimeout(200);

    const response = await testProjectPIIPattern(
      runtimeBaseUrl,
      fixture.accessToken,
      fixture.projectId,
      {
        ...previewRequestBody,
        defaultRenderMode: renderModeValue,
      },
    );

    const preview = response?.data?.consumerPreviews?.default;
    return typeof preview === 'string' ? preview : '';
  }

  await dialog.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await inputAfterLabel(dialog, /name/i).fill(`uuid_pattern_${uniqueSuffix()}`);
  await inputAfterLabel(dialog, /regex pattern/i).fill(regex);
  await dialog.getByRole('radio', { name: /^Random$/i }).click({ timeout: REQUEST_TIMEOUT_MS });
  await chooseSelectOption(page, dialog, 'Charset', 'Numeric');
  await inputAfterLabel(dialog, /length/i).fill('6');
  await dialog.locator('textarea').first().fill(previewRequestBody.text);

  const maskedPreview = await runPreviewForMode('Masked', 'masked');
  const tokenizedPreview = await runPreviewForMode('Tokenized', 'tokenized');
  const randomPreview = await runPreviewForMode('Random replacement', 'random');

  const maskedValid =
    maskedPreview !== `${previewPrefix}${uuid}` &&
    maskedPreview.startsWith(previewPrefix) &&
    maskedPreview.includes('*') &&
    /^Contract ID [*]+[0-9A-Fa-f]{4}$/.test(maskedPreview);
  const tokenizedValid =
    tokenizedPreview.startsWith(`${previewPrefix}{{PII:`) && !tokenizedPreview.includes(uuid);
  const randomValid = /^Contract ID \d{6}$/.test(randomPreview) && !randomPreview.includes(uuid);

  if (!maskedValid || !tokenizedValid || !randomValid) {
    throw new Error(
      `Unexpected preview outputs for ABLP-534. masked="${maskedPreview}" tokenized="${tokenizedPreview}" random="${randomPreview}"`,
    );
  }

  await dialog
    .locator('div[class*="overflow-y-auto"]')
    .first()
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  await page.waitForTimeout(500);
  await artifacts.captureScreenshot('ablp-534-render-mode-preview.png');

  return {
    summary:
      'ABLP-534: the live PII preview now renders masked, tokenized, and random outputs without leaking the raw UUID.',
    metadata: {
      issue: 'ABLP-534',
      projectId: fixture.projectId,
      uuid,
      maskedPreview,
      tokenizedPreview,
      randomPreview,
    },
    assertions: [
      {
        name: 'masked-preview-hides-raw-value',
        passed: maskedValid,
        details: `Observed masked preview: ${maskedPreview}`,
      },
      {
        name: 'tokenized-preview-uses-synthetic-token',
        passed: tokenizedValid,
        details: `Observed tokenized preview: ${tokenizedPreview}`,
      },
      {
        name: 'random-preview-replaces-with-random-digits',
        passed: randomValid,
        details: `Observed random preview: ${randomPreview}`,
      },
    ],
  };
}

async function runAblp524(context, fixture) {
  const { page, baseUrl, artifacts, runtimeBaseUrl } = context;
  const toolName = `schedule_lookup_${uniqueSuffix()}`.replace(/-/g, '_');
  const payload = {
    tool: {
      name: toolName,
      toolType: 'http',
      description: 'Imported env-placeholder tool for ABLP-524 evidence',
      dslContent: [
        `TOOL: ${toolName}`,
        'TYPE: http',
        'DESCRIPTION: "Imported env-placeholder tool for ABLP-524 evidence"',
        'INPUT:',
        '  doctorId: string',
        'ENDPOINT:',
        '  method: GET',
        '  endpoint: "{{env.SCHEDULING_API_BASE_URL}}/doctors/{{doctorId}}"',
      ].join('\n'),
    },
  };

  await createProjectEnvironmentVariable(runtimeBaseUrl, fixture.accessToken, fixture.projectId, {
    key: 'SCHEDULING_API_BASE_URL',
    value: 'https://scheduler.example.test',
    environment: 'dev',
    isSecret: false,
    description: 'Seeded by Studio video evidence for ABLP-524',
  });

  await gotoProjectRoute(page, baseUrl, fixture.projectId, '/tools');
  const importInput = page.locator('input[data-testid="tool-import-input"]').first();
  await importInput.setInputFiles({
    name: 'ablp-524-env-placeholder.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(payload, null, 2)),
  });

  await waitForCondition(
    async () => {
      const tools = await listProjectTools(baseUrl, fixture.accessToken, fixture.projectId);
      return tools.some((tool) => tool.name === toolName);
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 300,
      label: 'Timed out waiting for the imported tool to appear in the project tools API.',
    },
  );

  await page.getByText(toolName, { exact: true }).first().waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await waitForIdle(page, 800);
  await artifacts.captureScreenshot('ablp-524-import-success.png');

  return {
    summary:
      'ABLP-524: importing an HTTP tool that uses an {{env.*}} endpoint placeholder succeeds on the current Studio build.',
    metadata: {
      issue: 'ABLP-524',
      projectId: fixture.projectId,
      toolName,
    },
    assertions: [
      {
        name: 'imported-tool-visible',
        passed: true,
        details: `Imported tool ${toolName} is visible in the tools list.`,
      },
    ],
  };
}

async function runAblp548(context, fixture) {
  const { page, baseUrl, artifacts } = context;
  const limitationText = 'Do not approve transactions above $5000 without review';
  const editedLimitationText = 'Do not approve transactions above $2500 without manager review';

  await gotoProjectRoute(
    page,
    baseUrl,
    fixture.projectId,
    `/agents/${encodeURIComponent(fixture.agentName)}`,
  );

  const limitationInput = page.getByLabel('Limitations');
  await limitationInput.fill(limitationText);
  await page.getByRole('button', { name: /^add$/i }).click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.getByText(limitationText, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-548-limitation-chip.png');

  const editButton = page.getByRole('button', {
    name: new RegExp(`edit limitation: ${escapeRegExp(limitationText)}`, 'i'),
  });
  await editButton.click({ timeout: REQUEST_TIMEOUT_MS });

  await limitationInput.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await limitationInput.fill(editedLimitationText);

  await page.getByLabel('Save').click({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.getByText(editedLimitationText, { exact: true }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await artifacts.captureScreenshot('ablp-548-limitation-edited.png');

  return {
    summary:
      'ABLP-548: agent limitation chips expose an edit affordance that reopens the input with the existing value and saves the updated copy inline.',
    metadata: {
      issue: 'ABLP-548',
      projectId: fixture.projectId,
      agentName: fixture.agentName,
      limitationText,
      editedLimitationText,
    },
    assertions: [
      {
        name: 'limitation-added',
        passed: true,
        details: `Added limitation "${limitationText}" and captured the rendered chip.`,
      },
      {
        name: 'edit-affordance-visible',
        passed: true,
        details: `Located the inline edit affordance for "${limitationText}" and reopened the input.`,
      },
      {
        name: 'limitation-edited-inline',
        passed: true,
        details: `Updated the limitation chip text to "${editedLimitationText}".`,
      },
    ],
  };
}

async function runAblp537(context, fixture) {
  const { page, artifacts, baseUrl } = context;
  const markdownPrompt = `ABL markdown evidence ${uniqueSuffix()}`;

  await openStudioAgentChat(page, baseUrl, {
    projectId: fixture.projectId,
    agentName: fixture.agentName,
  });
  const chatInput = page.locator('[data-testid="chat-input"] textarea').first();
  await chatInput.fill(markdownPrompt);
  await page.keyboard.press('Enter');

  await page.getByText('Document Summary', { exact: false }).waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await waitForCondition(
    async () => {
      const strongCount = await page.locator('[data-testid="message-list"] strong').count();
      const listCount = await page.locator('[data-testid="message-list"] ul li').count();
      return strongCount > 0 && listCount > 0;
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 200,
      label: 'Timed out waiting for rendered markdown elements in the main chat window.',
    },
  );

  await artifacts.captureScreenshot('ablp-537-markdown-rendered.png');
  return {
    summary:
      'ABLP-537: the current main chat window renders markdown structure correctly for headings, bold text, and lists.',
    metadata: {
      issue: 'ABLP-537',
      projectId: fixture.projectId,
      agentName: fixture.agentName,
      markdownPrompt,
    },
    assertions: [
      {
        name: 'markdown-elements-rendered',
        passed: true,
        details: 'Observed rendered <strong> and list elements in the main chat window.',
      },
    ],
  };
}

function buildMarkdownAgentDsl(agentName) {
  return `
AGENT: ${agentName}
GOAL: "Return deterministic markdown evidence"
PERSONA: "Markdown verification agent"

FLOW:
  entry_point: reply
  steps:
    - reply

reply:
  REASONING: false
  RESPOND: |
    # Document Summary

    **Document ID**: 12345

    ## Findings
    - Item one
    - Item two
  THEN: COMPLETE
`;
}

export const scenario = {
  id: 'ablp-ui-regressions',
  title: 'ABLP UI Regression Evidence',
  description:
    'Runs reproducible Studio UI evidence flows for the UI-heavy ABLP ticket set by passing --issue <key>.',
  example: 'pnpm studio:video:evidence -- --scenario ablp-ui-regressions --issue ABLP-540',
  async run(context) {
    const { options, page } = context;
    const issue = String(options.issue ?? '')
      .trim()
      .toUpperCase();
    if (!issue) {
      throw new Error('ablp-ui-regressions requires --issue <ABLP-key>.');
    }

    const finalPauseMs = numberFromInput(options.finalPauseMs, 1500);

    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: issue === 'ABLP-548' || issue === 'ABLP-537',
      ...(issue === 'ABLP-537'
        ? {
            agentDslContent: buildMarkdownAgentDsl(
              `ablp_markdown_agent_${uniqueSuffix().replace(/-/g, '_')}`,
            ),
          }
        : {}),
    });

    let result;
    switch (issue) {
      case 'ABLP-540':
        result = await runAblp540(context, fixture);
        break;
      case 'ABLP-536':
        result = await runAblp536(context, fixture);
        break;
      case 'ABLP-534':
        result = await runAblp534(context, fixture);
        break;
      case 'ABLP-524':
        result = await runAblp524(context, fixture);
        break;
      case 'ABLP-548':
        result = await runAblp548(context, fixture);
        break;
      case 'ABLP-537':
        result = await runAblp537(context, fixture);
        break;
      default:
        throw new Error(`ablp-ui-regressions does not support issue ${issue}.`);
    }

    await waitForIdle(page, 500);
    await page.waitForTimeout(finalPauseMs);

    return {
      ...result,
      metadata: {
        ...result.metadata,
        issue,
        projectId: fixture.projectId,
        agentName: fixture.agentName ?? null,
        email: fixture.email,
      },
    };
  },
};
