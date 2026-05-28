import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATCH_PROJECTS } from './projects.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

const BASE_URL = process.env.ARCH_STUDIO_URL || process.env.STUDIO_URL || 'http://localhost:5173';
const HEADLESS = process.env.ARCH_BATCH_HEADLESS !== 'false';
const PROJECT_OFFSET = Number(process.env.ARCH_BATCH_OFFSET || 0);
const PROJECT_LIMIT = Number(process.env.ARCH_BATCH_LIMIT || BATCH_PROJECTS.length || 10);
const TURN_TIMEOUT_MS = Number(process.env.ARCH_BATCH_TIMEOUT_MS || 420_000);
const TIMEOUT_RESCUE_TIMEOUT_MS = Number(
  process.env.ARCH_BATCH_TIMEOUT_RESCUE_TIMEOUT_MS || 60_000,
);
const INITIAL_PAGE_TIMEOUT_MS = Number(process.env.ARCH_BATCH_INITIAL_PAGE_TIMEOUT_MS || 120_000);
const INITIAL_PAGE_RETRY_DELAY_MS = Number(
  process.env.ARCH_BATCH_INITIAL_PAGE_RETRY_DELAY_MS || 5_000,
);
const OUTPUT_LABEL = process.env.ARCH_BATCH_OUTPUT_LABEL || '';
const OUTPUT_DIR = path.join(
  REPO_ROOT,
  OUTPUT_LABEL
    ? `docs/testing/arch-onboarding-batch-2026-04-22-${sanitizeFileName(OUTPUT_LABEL)}`
    : 'docs/testing/arch-onboarding-batch-2026-04-22',
);
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');
const RESULTS_MD_PATH = path.join(OUTPUT_DIR, 'results.md');
const RESULTS_JSON_PATH = path.join(OUTPUT_DIR, 'results.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFileName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function summarize(text, max = 220) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function listVisibleButtonTexts(page) {
  const buttons = page.locator('button');
  const count = await buttons.count();
  const texts = [];

  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const text = (await button.innerText().catch(() => '')).trim();
    if (text) {
      texts.push(text);
    }
  }

  return texts;
}

function getChatPanel(page) {
  return page.locator('div[style*="width: 38%"]').first();
}

function buildAuthHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    ...(auth.tenantId ? { 'X-Tenant-Id': auth.tenantId } : {}),
  };
}

async function fetchProjects(page, auth) {
  const response = await page.request.get(`${BASE_URL}/api/projects`, {
    headers: buildAuthHeaders(auth),
  });
  if (!response.ok()) {
    throw new Error(`Failed to fetch projects (${response.status()})`);
  }

  const data = await response.json().catch(() => ({}));
  return Array.isArray(data?.projects) ? data.projects : [];
}

function selectNewestCreatedProject(projects, projectName, existingProjectIds) {
  return projects
    .filter(
      (candidate) =>
        candidate?.name === projectName &&
        typeof candidate?.id === 'string' &&
        !existingProjectIds.has(candidate.id),
    )
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(left?.createdAt ?? '') || 0;
      const rightTime = Date.parse(right?.createdAt ?? '') || 0;
      return rightTime - leftTime;
    })[0];
}

async function findCreatedProject(page, auth, projectName, existingProjectIds) {
  const projects = await fetchProjects(page, auth);
  return selectNewestCreatedProject(projects, projectName, existingProjectIds) ?? null;
}

async function waitForCreatedProject(page, auth, projectName, existingProjectIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const newestProject = await findCreatedProject(page, auth, projectName, existingProjectIds);
    if (newestProject) {
      return newestProject;
    }
    await sleep(1_000);
  }
  return null;
}

function replaceProjectName(text, currentName, nextName) {
  if (typeof text !== 'string' || !text.includes(currentName)) {
    return text;
  }

  return text.split(currentName).join(nextName);
}

function deriveRuntimeProject(project, existingProjects) {
  const existingNames = new Set(
    existingProjects
      .map((candidate) => (typeof candidate?.name === 'string' ? candidate.name : null))
      .filter(Boolean),
  );

  if (!existingNames.has(project.name)) {
    return project;
  }

  let nextVersion = 2;
  let nextName = `${project.name} v${nextVersion}`;
  while (existingNames.has(nextName)) {
    nextVersion += 1;
    nextName = `${project.name} v${nextVersion}`;
  }

  return {
    ...project,
    name: nextName,
    description: replaceProjectName(project.description, project.name, nextName),
    prompt: replaceProjectName(project.prompt, project.name, nextName),
  };
}

async function ensureDirs() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

async function loginViaDevApi(page, project) {
  const tokenResp = await page.request.post(`${BASE_URL}/api/auth/dev-login`, {
    data: {
      email: project.email,
      name: `Arch Batch ${project.name}`,
    },
  });

  if (!tokenResp.ok()) {
    throw new Error(`Dev login failed (${tokenResp.status()}) for ${project.email}`);
  }

  const body = await tokenResp.json();
  const domain = new URL(BASE_URL).hostname;
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

  let tenantId = null;
  if (body.accessToken) {
    try {
      const payload = JSON.parse(Buffer.from(body.accessToken.split('.')[1], 'base64').toString());
      tenantId = payload?.tenantId ?? null;
    } catch {
      tenantId = null;
    }
  }

  return {
    accessToken: body.accessToken ?? '',
    tenantId,
  };
}

async function openArchPage(page, project) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(`${BASE_URL}/arch`, {
        waitUntil: 'domcontentloaded',
        timeout: INITIAL_PAGE_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      if (attempt >= 2) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `[startup] ${project.name} /arch navigation attempt ${attempt} failed; retrying after ${INITIAL_PAGE_RETRY_DELAY_MS}ms. reason=${summarize(message, 180)}\n`,
      );
      await sleep(INITIAL_PAGE_RETRY_DELAY_MS);
    }
  }
}

async function archiveCurrentOnboardingSession(page, auth) {
  if (!auth.accessToken) {
    return { archived: false, reason: 'missing access token' };
  }

  const headers = buildAuthHeaders(auth);

  const currentResp = await page.request.get(
    `${BASE_URL}/api/arch-ai/sessions/current?mode=ONBOARDING`,
    {
      headers,
    },
  );
  if (!currentResp.ok()) {
    return { archived: false, reason: `current session lookup failed (${currentResp.status()})` };
  }

  const currentBody = await currentResp.json().catch(() => null);
  const sessionId = currentBody?.session?.id;
  if (!sessionId) {
    return { archived: true, sessionId: null };
  }

  const archiveResp = await page.request.post(
    `${BASE_URL}/api/arch-ai/sessions/${encodeURIComponent(sessionId)}/archive`,
    { headers },
  );

  return {
    archived: archiveResp.ok(),
    sessionId,
    reason: archiveResp.ok() ? null : `archive failed (${archiveResp.status()})`,
  };
}

async function fetchCurrentOnboardingSession(page, auth) {
  const response = await page.request.get(
    `${BASE_URL}/api/arch-ai/sessions/current?mode=ONBOARDING`,
    {
      headers: buildAuthHeaders(auth),
    },
  );
  if (!response.ok()) {
    return null;
  }
  const body = await response.json().catch(() => null);
  return body?.session ?? null;
}

function choosePendingWidgetAnswer(pending) {
  const payload = pending?.payload ?? {};
  const widgetType = payload?.widgetType;
  const options = Array.isArray(payload?.options) ? payload.options : [];

  if (widgetType === 'BlueprintConfirm') {
    return 'generate_draft_topology';
  }

  if (widgetType === 'TopologyApproval') {
    return { action: 'accept' };
  }

  if (widgetType === 'TopologyRevision') {
    const first = options.find((option) => typeof option?.value === 'string');
    return {
      targets: first ? [first.value] : [],
      notes: 'Keep the topology compact and consistent with the current concept.',
    };
  }

  if (widgetType === 'BuildComplete') {
    const optionValues = options
      .map((option) => (typeof option?.value === 'string' ? option.value : null))
      .filter(Boolean);
    return optionValues.includes('create')
      ? 'create'
      : optionValues.includes('retry')
        ? 'retry'
        : optionValues.includes('retry_all')
          ? 'retry_all'
          : optionValues.includes('modify')
            ? 'modify'
            : (optionValues[0] ?? null);
  }

  if (widgetType === 'SingleSelect') {
    return typeof options[0]?.value === 'string' ? options[0].value : null;
  }

  if (widgetType === 'MultiSelect') {
    const minSelect = typeof payload?.minSelect === 'number' ? payload.minSelect : 1;
    return options
      .map((option) => (typeof option?.value === 'string' ? option.value : null))
      .filter(Boolean)
      .slice(0, minSelect);
  }

  if (widgetType === 'TextInput') {
    if (typeof payload?.defaultValue === 'string' && payload.defaultValue.trim()) {
      return payload.defaultValue.trim();
    }
    return 'Please continue with the strongest default choice.';
  }

  if (widgetType === 'Confirmation') {
    return true;
  }

  return null;
}

async function maybeAnswerPendingWidget(page, auth, lastActionRef) {
  const session = await fetchCurrentOnboardingSession(page, auth);
  const pending = session?.metadata?.pendingInteraction;
  if (pending?.kind !== 'widget' || typeof pending?.id !== 'string') {
    return false;
  }

  const answer = choosePendingWidgetAnswer(pending);
  if (answer == null) {
    return false;
  }

  const response = await page.request.post(`${BASE_URL}/api/arch-ai/message`, {
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(auth),
    },
    timeout: 0,
    data: {
      sessionId: session.id,
      type: 'tool_answer',
      toolCallId: pending.id,
      answer,
    },
  });
  if (!response.ok()) {
    throw new Error(
      `tool_answer failed (${response.status()}) for widget ${pending.payload?.widgetType ?? 'unknown'}`,
    );
  }

  await response.body().catch(() => null);
  lastActionRef.value = `tool_answer:${pending.payload?.widgetType ?? 'widget'}`;
  return true;
}

async function rescueTimedOutRun(page, auth, project, existingProjectIds, lastActionRef) {
  const rescueDeadline = Date.now() + TIMEOUT_RESCUE_TIMEOUT_MS;

  while (Date.now() < rescueDeadline) {
    const currentUrl = page.url();
    if (/\/projects\/[^/]+$/.test(currentUrl)) {
      return {
        projectId: currentUrl.split('/projects/')[1] ?? '',
        projectUrl: currentUrl,
        note: 'Recovered after timeout via final URL check.',
      };
    }

    const newestProject = await findCreatedProject(page, auth, project.name, existingProjectIds);
    if (newestProject) {
      return {
        projectId: newestProject.id,
        projectUrl: `${BASE_URL}/projects/${newestProject.id}`,
        note: 'Recovered after timeout via final projects API check.',
      };
    }

    const answered = await maybeAnswerPendingWidget(page, auth, lastActionRef);
    if (!answered) {
      break;
    }

    await sleep(2_000);
  }

  const rescuedProject = await waitForCreatedProject(
    page,
    auth,
    project.name,
    existingProjectIds,
    Math.max(0, rescueDeadline - Date.now()),
  );
  if (!rescuedProject) {
    return null;
  }

  return {
    projectId: rescuedProject.id,
    projectUrl: `${BASE_URL}/projects/${rescuedProject.id}`,
    note: 'Recovered after timeout by answering the pending widget via API.',
  };
}

async function captureFailure(page, fileBase) {
  const filename = path.join(SCREENSHOT_DIR, `${sanitizeFileName(fileBase)}.png`);
  await page.screenshot({ path: filename, fullPage: true });
  return path.relative(REPO_ROOT, filename);
}

async function waitForChatInputReady(page) {
  const input = page.getByTestId('chat-input-textarea').first();
  await input.waitFor({ state: 'visible', timeout: 90_000 });

  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const disabled = await input.isDisabled().catch(() => true);
    const placeholder = await input.getAttribute('placeholder').catch(() => '');
    if (!disabled && placeholder && placeholder !== 'Thinking...') {
      return input;
    }
    await sleep(500);
  }

  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  throw new Error(
    `Chat input never became ready on /arch. url=${page.url()} preview=${summarize(bodyText, 260)}`,
  );
}

async function handleResumeDialog(page) {
  const startFresh = page.getByRole('button', { name: /start fresh/i }).first();
  if (await startFresh.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await startFresh.click();
    await sleep(2_000);
  }
}

async function clickFirstVisible(scope, labels) {
  for (const label of labels) {
    const buttons = scope.getByRole('button', { name: label });
    const count = await buttons.count();
    for (let index = count - 1; index >= 0; index--) {
      const button = buttons.nth(index);
      const visible = await button.isVisible({ timeout: 500 }).catch(() => false);
      const disabled = visible ? await button.isDisabled().catch(() => true) : true;
      if (!visible || disabled) {
        continue;
      }
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ force: true });
      return true;
    }
  }
  return false;
}

async function chooseInterviewAnswer(scope) {
  const option = scope.locator('[role="listbox"] [role="option"]').first();
  if (await option.isVisible({ timeout: 500 }).catch(() => false)) {
    await option.scrollIntoViewIfNeeded().catch(() => {});
    await option.click({ force: true });
    return true;
  }

  const confirm = scope.getByRole('button', { name: /confirm/i }).first();
  if (
    (await confirm.isVisible({ timeout: 500 }).catch(() => false)) &&
    !(await confirm.isDisabled().catch(() => true))
  ) {
    await confirm.scrollIntoViewIfNeeded().catch(() => {});
    await confirm.click({ force: true });
    return true;
  }

  const customInput = scope.getByPlaceholder('Type your answer...').first();
  if (await customInput.isVisible({ timeout: 500 }).catch(() => false)) {
    await customInput.fill('Please continue with the strongest default option.');
    const submit = scope.getByRole('button', { name: /submit/i }).first();
    if (await submit.isVisible({ timeout: 500 }).catch(() => false)) {
      await submit.scrollIntoViewIfNeeded().catch(() => {});
      await submit.click({ force: true });
      return true;
    }
  }

  return false;
}

async function fillProjectSpecFields(page, project) {
  const nameField = page.getByPlaceholder('e.g., Fintech Customer Support').first();
  if (await nameField.isVisible({ timeout: 500 }).catch(() => false)) {
    const currentValue = await nameField.inputValue().catch(() => '');
    if (!currentValue.trim()) {
      await nameField.fill(project.name);
    }
  }

  const descriptionField = page.getByPlaceholder('What does this project do?').first();
  if (await descriptionField.isVisible({ timeout: 500 }).catch(() => false)) {
    const currentValue = await descriptionField.inputValue().catch(() => '');
    if (!currentValue.trim()) {
      await descriptionField.fill(project.description);
    }
  }
}

async function clickGenericActionButton(scope, project) {
  const visibleButtons = await listVisibleButtonTexts(scope);
  if (visibleButtons.some((text) => /Rendering|Compiling/i.test(text))) {
    return null;
  }

  const buttons = scope.locator('button');
  const count = await buttons.count();

  for (let i = count - 1; i >= 0; i--) {
    const button = buttons.nth(i);
    const text = (await button.innerText().catch(() => '')).trim();
    const disabled = await button.isDisabled().catch(() => true);
    if (!text || disabled) {
      continue;
    }

    if (
      /New chat|Start Fresh|Send message|Projects|Journal|Spec|Topology|Business|\+ Add|Guest mode|Open .* profile|Other\.\.\./i.test(
        text,
      )
    ) {
      continue;
    }

    if (project.name && text.includes(project.name)) {
      continue;
    }

    if (
      /Generate draft topology|Accept topology|Submit|Create project|Create Project|Continue|Yes|Build agents|Generate agents|Retry failed agents|Retry all agents/i.test(
        text,
      )
    ) {
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ force: true });
      return text;
    }

    if (
      !/Agent Platform|Exit|Arch Batch|Automate customer support|Let customers book appointments|Qualify leads before sales/i.test(
        text,
      )
    ) {
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ force: true });
      return text;
    }
  }

  return null;
}

async function maybeAdvanceUi(page, chatPanel, auth, project, step, lastActionRef) {
  await fillProjectSpecFields(page, project);

  if (await maybeAnswerPendingWidget(page, auth, lastActionRef)) {
    return true;
  }

  if (await chooseInterviewAnswer(chatPanel)) {
    lastActionRef.value = `interview_option:${step}`;
    return true;
  }

  const targetedClicked = await clickFirstVisible(chatPanel, [
    /Generate draft topology/i,
    /Accept topology/i,
    /^Submit$/i,
    /^Create project$/i,
    /^Create Project$/i,
    /^Continue$/i,
    /^Yes$/i,
  ]);
  if (targetedClicked) {
    lastActionRef.value = `targeted_button:${step}`;
    return true;
  }

  const genericText = await clickGenericActionButton(chatPanel, project);
  if (genericText) {
    lastActionRef.value = `generic_button:${genericText}`;
    return true;
  }

  return false;
}

async function runOnboardingCreation(page, project, index) {
  const start = Date.now();
  const lastActionRef = { value: 'none' };

  const auth = await loginViaDevApi(page, project);
  const existingProjects = await fetchProjects(page, auth);
  const runtimeProject = deriveRuntimeProject(project, existingProjects);
  if (runtimeProject.name !== project.name) {
    process.stdout.write(
      `[startup] ${project.name} already exists; rerun will use "${runtimeProject.name}" instead.\n`,
    );
  }
  const existingProjectIds = new Set(
    existingProjects
      .filter(
        (candidate) => candidate?.name === runtimeProject.name && typeof candidate?.id === 'string',
      )
      .map((candidate) => candidate.id),
  );
  const archiveResult = await archiveCurrentOnboardingSession(page, auth);
  if (!archiveResult.archived) {
    throw new Error(
      `Failed to archive current onboarding session before run. reason=${archiveResult.reason ?? 'unknown'}`,
    );
  }

  await openArchPage(page, runtimeProject);
  await handleResumeDialog(page);
  const chatPanel = getChatPanel(page);

  const input = await waitForChatInputReady(page);
  await input.fill(runtimeProject.prompt);
  const sendButton = page.getByRole('button', { name: /send message/i }).first();
  if (await sendButton.isEnabled().catch(() => false)) {
    await sendButton.click();
  } else {
    await input.press('Enter');
  }

  for (let step = 0; Date.now() - start < TURN_TIMEOUT_MS; step++) {
    await sleep(2_000);

    const currentUrl = page.url();
    if (/\/projects\/[^/]+$/.test(currentUrl)) {
      const bodyText = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      const agentCountMatch = bodyText.match(/AGENTS\s+(\d+)/i);
      return {
        success: true,
        id: project.id,
        complexity: project.complexity,
        email: project.email,
        name: runtimeProject.name,
        prompt: runtimeProject.prompt,
        projectId: currentUrl.split('/projects/')[1] ?? '',
        projectUrl: currentUrl,
        elapsedMs: Date.now() - start,
        agentCount: agentCountMatch ? Number(agentCountMatch[1]) : null,
        finalPreview: summarize(bodyText, 260),
      };
    }

    const newestProject = await findCreatedProject(
      page,
      auth,
      runtimeProject.name,
      existingProjectIds,
    );
    if (newestProject) {
      const bodyText = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      return {
        success: true,
        id: project.id,
        complexity: project.complexity,
        email: project.email,
        name: runtimeProject.name,
        prompt: runtimeProject.prompt,
        projectId: newestProject.id,
        projectUrl: `${BASE_URL}/projects/${newestProject.id}`,
        elapsedMs: Date.now() - start,
        agentCount: typeof newestProject.agentCount === 'number' ? newestProject.agentCount : null,
        finalPreview: summarize(bodyText, 260),
        note: 'Project record created successfully (detected via projects API).',
      };
    }

    const bodyText = await chatPanel.innerText().catch(() => '');
    if (step % 5 === 0) {
      const visibleButtons = await listVisibleButtonTexts(chatPanel);
      process.stdout.write(
        `[${index + 1}/${PROJECT_LIMIT}] ${project.name} step=${step} action=${lastActionRef.value} url=${currentUrl} tail=${summarize(bodyText.slice(-800), 220)} buttons=${visibleButtons.slice(0, 8).join(' | ')}\n`,
      );
    }

    await maybeAdvanceUi(page, chatPanel, auth, runtimeProject, step, lastActionRef);
  }

  const rescued = await rescueTimedOutRun(
    page,
    auth,
    runtimeProject,
    existingProjectIds,
    lastActionRef,
  );
  if (rescued) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    return {
      success: true,
      id: project.id,
      complexity: project.complexity,
      email: project.email,
      name: runtimeProject.name,
      prompt: runtimeProject.prompt,
      projectId: rescued.projectId,
      projectUrl: rescued.projectUrl,
      elapsedMs: Date.now() - start,
      agentCount: null,
      finalPreview: summarize(bodyText, 260),
      note: rescued.note,
    };
  }

  const screenshot = await captureFailure(page, `${project.id}-create-failure`);
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  return {
    success: false,
    id: project.id,
    complexity: project.complexity,
    email: project.email,
    name: runtimeProject.name,
    prompt: runtimeProject.prompt,
    elapsedMs: Date.now() - start,
    finalUrl: page.url(),
    lastAction: lastActionRef.value,
    note: summarize(bodyText, 400),
    screenshot,
  };
}

function renderMarkdown(run) {
  const successCount = run.results.filter((result) => result.success).length;
  const failCount = run.results.length - successCount;

  const lines = [
    '# Arch Onboarding Batch Results',
    '',
    `- **Started:** ${run.startedAt}`,
    `- **Updated:** ${nowIso()}`,
    `- **Studio URL:** ${BASE_URL}`,
    `- **Projects requested:** ${run.requested}`,
    `- **Projects finished:** ${run.results.length}`,
    `- **Successes:** ${successCount}`,
    `- **Failures:** ${failCount}`,
    '',
    '| # | Project | Complexity | Status | Project ID | Elapsed (s) | Notes | Screenshot |',
    '| --- | --- | --- | --- | --- | ---: | --- | --- |',
  ];

  for (const [index, result] of run.results.entries()) {
    lines.push(
      `| ${index + 1} | ${result.name} | ${result.complexity} | ${result.success ? 'PASS' : 'FAIL'} | ${result.projectId ?? ''} | ${Math.round(result.elapsedMs / 1000)} | ${result.note ?? result.finalPreview ?? ''} | ${result.screenshot ? `\`${result.screenshot}\`` : ''} |`,
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function persistResults(run) {
  await writeFile(RESULTS_JSON_PATH, JSON.stringify(run, null, 2), 'utf8');
  await writeFile(RESULTS_MD_PATH, renderMarkdown(run), 'utf8');
}

async function main() {
  await ensureDirs();

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
  });

  const run = {
    startedAt: nowIso(),
    offset: PROJECT_OFFSET,
    requested: PROJECT_LIMIT,
    results: [],
  };

  try {
    const projects = BATCH_PROJECTS.slice(PROJECT_OFFSET, PROJECT_OFFSET + PROJECT_LIMIT);
    for (let index = 0; index < projects.length; index++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
      });
      const page = await context.newPage();

      process.stdout.write(
        `\n[${index + 1}/${projects.length}] Creating ${projects[index].name}\n`,
      );
      const result = await runOnboardingCreation(page, projects[index], index);
      run.results.push(result);
      await persistResults(run);
      await context.close();
    }
  } finally {
    await browser.close();
    await persistResults(run);
  }

  const failed = run.results.filter((result) => !result.success);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const failure = {
    startedAt: nowIso(),
    requested: PROJECT_LIMIT,
    results: [],
    fatalError: error instanceof Error ? error.message : String(error),
  };
  await ensureDirs();
  await persistResults(failure);
  throw error;
});
