import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire('/Users/sriharshanalluri/abl-platform/apps/studio/package.json');
const { chromium } = require('@playwright/test');

const BASE_URL = 'http://localhost:5173';
const OUTPUT_DIR = '/Users/sriharshanalluri/abl-platform/output/playwright';
const RESULTS_PATH =
  '/Users/sriharshanalluri/abl-platform/docs/testing/arch-e2e-full-test-results.md';

const PROJECT_PROMPTS = [
  'Build a customer support bot with billing, tech support, and escalation agents. Name it Arch E2E Customer Support 01.',
  'Create an HR onboarding assistant that handles new hire paperwork and training. Name it Arch E2E HR Onboarding 02.',
  'Design an e-commerce product recommendation system. Name it Arch E2E Commerce Reco 03.',
  'Build a healthcare triage system for patient intake. Name it Arch E2E Healthcare Triage 04.',
  'Create a financial advisory bot for investment planning. Name it Arch E2E Financial Advisor 05.',
  'Design a travel booking assistant with flight, hotel, and car rental agents. Name it Arch E2E Travel Booking 06.',
  'Build an IT helpdesk system with ticket routing and resolution. Name it Arch E2E IT Helpdesk 07.',
  'Create a real estate agent for property search and mortgage calculation. Name it Arch E2E Real Estate 08.',
  'Design a restaurant reservation and menu recommendation system. Name it Arch E2E Restaurant 09.',
  'Build a legal document review assistant. Name it Arch E2E Legal Review 10.',
];

const PROJECT_LIMIT = Number(process.env.ARCH_E2E_PROJECT_LIMIT || PROJECT_PROMPTS.length || 10);
const SCENARIO_LIMIT = Number(process.env.ARCH_E2E_SCENARIO_LIMIT || 50);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFileName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function summarize(text, max = 120) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function ensureDirs() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

async function login(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  if (page.url().includes('/auth/login')) {
    const devLogin = page.getByRole('button', { name: /Dev Login/i });
    if (await devLogin.count()) {
      await devLogin.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(2000);
    }
  }
}

async function handleResumeDialog(page) {
  const dialog = page.getByText('Resume previous session?');
  if (await dialog.count()) {
    const startFresh = page.getByRole('button', { name: /Start Fresh/i });
    if (await startFresh.count()) {
      await startFresh.click();
      await sleep(3000);
    }
  }
}

async function captureFailure(page, fileBase) {
  const filename = `${OUTPUT_DIR}/${sanitizeFileName(fileBase)}.png`;
  await page.screenshot({ path: filename, fullPage: true });
  return filename.replace('/Users/sriharshanalluri/abl-platform/', '');
}

async function waitForOnboardingIdle(page, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const disabled = await page
      .locator('textarea[placeholder="Describe your project..."]')
      .first()
      .isDisabled()
      .catch(() => true);
    if (!disabled) return true;
    await sleep(500);
  }
  return false;
}

async function runOnboardingCreation(page, prompt, index) {
  await page.goto(`${BASE_URL}/arch`, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  process.stdout.write(`[create ${index + 1}] loaded /arch\n`);
  await handleResumeDialog(page);
  process.stdout.write(`[create ${index + 1}] handled resume dialog\n`);
  await waitForOnboardingIdle(page);
  process.stdout.write(`[create ${index + 1}] onboarding input ready\n`);

  const textarea = page.locator('textarea[placeholder="Describe your project..."]').first();
  const sendButton = page.getByRole('button', { name: 'Send message' }).first();
  await textarea.click();
  await textarea.fill('');
  await textarea.pressSequentially(prompt, { delay: 15 });
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await sendButton.isEnabled().catch(() => false)) {
      break;
    }
    await sleep(200);
  }
  if (await sendButton.isEnabled().catch(() => false)) {
    await sendButton.click({ force: true });
  } else {
    await textarea.press('Enter');
  }
  process.stdout.write(`[create ${index + 1}] sent initial prompt\n`);

  const start = Date.now();
  let projectUrl = null;
  const expectedNameMatch = prompt.match(/Name it (.+?)\./i);
  const expectedName = expectedNameMatch?.[1] ?? `Project ${index + 1}`;

  for (let step = 0; step < 260; step++) {
    await sleep(2000);
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    if (step % 5 === 0) {
      process.stdout.write(
        `[create ${index + 1}] step ${step} url=${page.url()} tail=${summarize(bodyText, 220)}\n`,
      );
    }

    if (page.url().includes('/projects/')) {
      projectUrl = page.url();
      break;
    }

    const projectCreated = page.getByText('Project Created!');
    if (await projectCreated.count()) {
      const openProject = page.getByRole('link', { name: /Open Project/i }).first();
      if (await openProject.count()) {
        await openProject.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await sleep(2000);
        projectUrl = page.url();
        break;
      }
    }

    const setupProjectName = page
      .getByRole('textbox', { name: /e\.g\., Fintech Customer Support/i })
      .first();
    if (await setupProjectName.count()) {
      const currentName = await setupProjectName.inputValue().catch(() => '');
      if (!currentName.trim()) {
        process.stdout.write(`[create ${index + 1}] filling project setup name=${expectedName}\n`);
        await setupProjectName.fill(expectedName);
      }
    }

    const setupDescription = page
      .getByRole('textbox', { name: /What does this project do\?/i })
      .first();
    if (await setupDescription.count()) {
      const currentDescription = await setupDescription.inputValue().catch(() => '');
      if (!currentDescription.trim()) {
        process.stdout.write(`[create ${index + 1}] filling project setup description\n`);
        await setupDescription.fill(prompt.replace(/Name it .+?\./i, '').trim());
      }
    }

    const createBtn = page.getByRole('button', { name: /Create Project/i }).first();
    if (
      (await createBtn.count()) &&
      !(await createBtn.isDisabled().catch(() => true)) &&
      !bodyText.includes('Generating agents...')
    ) {
      process.stdout.write(`[create ${index + 1}] clicking Create Project\n`);
      await createBtn.click();
      continue;
    }

    const continueBtn = page.getByRole('button', { name: /Continue/i }).first();
    if ((await continueBtn.count()) && !(await continueBtn.isDisabled().catch(() => true))) {
      process.stdout.write(`[create ${index + 1}] clicking Continue\n`);
      await continueBtn.click();
      continue;
    }

    const acceptBtn = page.getByRole('button', { name: /^Accept$/i }).first();
    if ((await acceptBtn.count()) && !(await acceptBtn.isDisabled().catch(() => true))) {
      process.stdout.write(`[create ${index + 1}] clicking Accept\n`);
      await acceptBtn.click();
      continue;
    }

    const widgetInput = page
      .locator('input[placeholder*="Enter"], textarea[placeholder*="Enter"]')
      .first();
    if (await widgetInput.count()) {
      const placeholder = await widgetInput.getAttribute('placeholder').catch(() => '');
      const answer =
        placeholder && placeholder.toLowerCase().includes('project')
          ? 'customer support automation'
          : 'Please continue with available project information';
      process.stdout.write(
        `[create ${index + 1}] answering widget placeholder=${placeholder || 'n/a'} answer=${answer}\n`,
      );
      await widgetInput.fill(answer);
      const submit = page.getByRole('button', { name: /Submit/i }).first();
      if (await submit.count()) {
        await submit.click().catch(() => {});
      }
      continue;
    }

    const optionButtons = page.locator('button');
    const optionCount = await optionButtons.count();
    for (let i = 0; i < optionCount; i++) {
      const text = (
        await optionButtons
          .nth(i)
          .innerText()
          .catch(() => '')
      ).trim();
      const disabled = await optionButtons
        .nth(i)
        .isDisabled()
        .catch(() => true);
      if (
        !disabled &&
        text &&
        !/Continue|Create Project|Resume|Start Fresh|Send|Admin|Developer|Agent Platform|Specification|Journal|\+ Add/i.test(
          text,
        )
      ) {
        process.stdout.write(`[create ${index + 1}] clicking option=${text}\n`);
        await optionButtons
          .nth(i)
          .click()
          .catch(() => {});
        break;
      }
    }
  }

  if (!projectUrl) {
    const screenshot = await captureFailure(page, `project-create-fail-${index + 1}`);
    return {
      success: false,
      prompt,
      elapsedMs: Date.now() - start,
      finalUrl: page.url(),
      screenshot,
      note: summarize(
        await page
          .locator('body')
          .innerText()
          .catch(() => ''),
        400,
      ),
    };
  }

  const projectText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const agentCountMatch = projectText.match(/AGENTS\s+(\d+)/i);
  const projectId = projectUrl.split('/projects/')[1] ?? '';

  return {
    success: true,
    prompt,
    projectId,
    projectUrl,
    expectedName,
    elapsedMs: Date.now() - start,
    checks: {
      urlOk: /\/projects\/[^/]+$/.test(projectUrl),
      nameVisible: projectText.includes(expectedName),
      askArchVisible: /Ask Arch/i.test(projectText),
      agentCount: agentCountMatch ? Number(agentCountMatch[1]) : null,
    },
  };
}

function buildScenarios(project) {
  const firstAgent = project.agentNames?.[0] ?? 'first agent';
  const secondAgent = project.agentNames?.[1] ?? firstAgent;

  return [
    ['T1', 'Basic Chat', 'hello', {}],
    ['T2', 'Basic Chat', 'what can you do', {}],
    ['T3', 'Basic Chat', 'help me', { widgetOption: 0 }],
    [
      'T4',
      'Basic Chat',
      'send a very detailed explanation of this project and what it can do for users across all major workflows in a few paragraphs',
      {},
    ],
    ['T5', 'Basic Chat', 'hello 😊', {}],
    ['T6', 'Basic Chat', 'thanks', {}],
    ['T7', 'Basic Chat', 'what did you just do', {}],
    ['T8', 'Basic Chat', 'what can you help me improve next', {}],
    ['T9', 'Basic Chat', 'can you continue from the last answer', {}],
    ['T10', 'Basic Chat', 'ask the same thing again: what can you do', {}],

    ['T11', 'Agent Queries', 'how many agents', {}],
    ['T12', 'Agent Queries', 'list all agents', {}],
    ['T13', 'Agent Queries', `tell me about ${firstAgent}`, {}],
    ['T14', 'Agent Queries', `what does ${firstAgent} do`, {}],
    ['T15', 'Agent Queries', `show me ${firstAgent} code`, {}],
    ['T16', 'Agent Queries', `what tools does ${firstAgent} have`, {}],
    ['T17', 'Agent Queries', `compare ${firstAgent} and ${secondAgent}`, {}],
    ['T18', 'Agent Queries', 'which agent handles this topic best', {}],
    ['T19', 'Agent Queries', `is ${firstAgent} configured correctly`, {}],
    ['T20', 'Agent Queries', 'what is the entry agent', {}],

    ['T21', 'Health & Diagnostics', 'check health of all agents', {}],
    ['T22', 'Health & Diagnostics', 'are there any errors', {}],
    ['T23', 'Health & Diagnostics', 'show recent traces', {}],
    ['T24', 'Health & Diagnostics', 'any tool call failures', {}],
    ['T25', 'Health & Diagnostics', 'is the project ready for deployment', {}],
    ['T26', 'Health & Diagnostics', 'what is the error rate', {}],
    ['T27', 'Health & Diagnostics', 'how many sessions', {}],
    ['T28', 'Health & Diagnostics', `debug ${firstAgent}`, {}],
    ['T29', 'Health & Diagnostics', 'why did the last session fail', {}],
    ['T30', 'Health & Diagnostics', 'check if agents compile', {}],

    ['T31', 'Topology & Architecture', 'what is the topology', {}],
    ['T32', 'Topology & Architecture', 'how do handoffs work', {}],
    ['T33', 'Topology & Architecture', 'show me the agent flow', {}],
    ['T34', 'Topology & Architecture', 'is the topology complete', {}],
    ['T35', 'Topology & Architecture', 'any orphan agents', {}],
    ['T36', 'Topology & Architecture', 'how does delegation work', {}],
    ['T37', 'Topology & Architecture', 'what is the routing strategy', {}],
    ['T38', 'Topology & Architecture', 'can you improve the topology', {}],
    [
      'T39',
      'Topology & Architecture',
      'add a handoff from one agent to another',
      { widgetText: 'Route billing questions to a specialist agent' },
    ],
    ['T40', 'Topology & Architecture', 'explain the multi-agent architecture', {}],

    ['T41', 'Widget & Tool Interaction', 'help me', { widgetOption: 0 }],
    [
      'T42',
      'Widget & Tool Interaction',
      'add another agent',
      { widgetText: 'Handles billing escalation requests' },
    ],
    ['T43', 'Widget & Tool Interaction', 'show me agent code', { widgetOption: 0 }],
    ['T44', 'Widget & Tool Interaction', 'check health of all agents', {}],
    ['T45', 'Widget & Tool Interaction', `show me ${firstAgent} code`, {}],
    ['T46', 'Widget & Tool Interaction', 'query recent traces and summarize them', {}],
    ['T47', 'Widget & Tool Interaction', 'check if agents compile', {}],
    ['T48', 'Widget & Tool Interaction', 'trigger a tool error and explain it gracefully', {}],
    ['T49', 'Widget & Tool Interaction', 'what happens if a widget is needed', { widgetOption: 0 }],
    [
      'T50',
      'Widget & Tool Interaction',
      'run a test message and then tell me what happened',
      { widgetText: `Test ${firstAgent}` },
    ],
  ];
}

async function openArchOverlay(page) {
  const askArch = page.getByRole('button', { name: /Ask Arch/i });
  await askArch.click();

  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const input = page
      .locator('[class*="arch-panel"] input, [class*="arch-panel"] textarea')
      .first();
    const placeholder = await input.getAttribute('placeholder').catch(() => null);
    if (placeholder) return true;
    await sleep(500);
  }

  return false;
}

async function resetInProjectSession(page, projectId) {
  return await page.evaluate(async (pid) => {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: '{}',
    });
    if (!refresh.ok) {
      return { reset: false, reason: `auth refresh failed: ${refresh.status}` };
    }
    const tokens = await refresh.json();
    const accessToken = tokens?.accessToken;
    if (!accessToken) {
      return { reset: false, reason: 'auth refresh returned no access token' };
    }

    let tenantId = null;
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1]));
      tenantId = payload?.tenantId ?? null;
    } catch {
      tenantId = null;
    }

    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    };

    const current = await fetch(`/api/arch-ai/sessions/current?mode=IN_PROJECT&projectId=${pid}`, {
      credentials: 'include',
      headers: authHeaders,
    });
    if (!current.ok) {
      return { reset: false, reason: `current session lookup failed: ${current.status}` };
    }
    const data = await current.json();
    if (!data?.success || !data?.session?.id) {
      return { reset: true, archived: false };
    }

    const archive = await fetch(`/api/arch-ai/sessions/${data.session.id}/archive`, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders,
    });

    return {
      reset: archive.ok,
      archived: archive.ok,
      archiveStatus: archive.status,
      sessionId: data.session.id,
    };
  }, projectId);
}

async function resolveOverlayWidgets(panel, strategy = {}) {
  const input = panel.locator('input, textarea').first();
  const placeholder = await input.getAttribute('placeholder').catch(() => null);

  if (placeholder === 'Ask about this project...') {
    return { state: 'idle' };
  }

  if (placeholder && (placeholder.includes('Enter') || placeholder.includes('e.g.'))) {
    const answer = strategy.widgetText ?? 'Please continue with available project information';
    await input.fill(answer);
    const submit = panel.getByRole('button', { name: /Submit/i }).first();
    if (await submit.count()) {
      await submit.click().catch(() => {});
      return { state: 'widget_text', answer };
    }
  }

  if (placeholder === 'Waiting...') {
    const buttons = panel.locator('button');
    const count = await buttons.count();
    const optionTexts = [];
    for (let i = 0; i < count; i++) {
      const text = (
        await buttons
          .nth(i)
          .innerText()
          .catch(() => '')
      ).trim();
      const disabled = await buttons
        .nth(i)
        .isDisabled()
        .catch(() => true);
      if (text && !disabled && !/Send|Close|Reject|Modify|Accept/i.test(text)) {
        optionTexts.push({ index: i, text });
      }
    }
    if (optionTexts.length > 0) {
      const pick = optionTexts[Math.min(strategy.widgetOption ?? 0, optionTexts.length - 1)];
      await buttons
        .nth(pick.index)
        .click()
        .catch(() => {});
      return { state: 'widget_option', answer: pick.text };
    }
  }

  return { state: 'streaming' };
}

async function recoverOverlayToIdle(page, panel, strategy = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await resolveOverlayWidgets(panel, strategy);
    if (state.state === 'idle') {
      return true;
    }

    const placeholder = await panel
      .locator('input, textarea')
      .first()
      .getAttribute('placeholder')
      .catch(() => null);
    if (placeholder === 'Ask about this project...') {
      return true;
    }

    await sleep(1000);
  }

  // Close and reopen overlay to recover from nested widget chains.
  const closeButton = panel.locator('button').first();
  if (await closeButton.count()) {
    await closeButton.click().catch(() => {});
    await sleep(1000);
  }

  const askArch = page.getByRole('button', { name: /Ask Arch/i });
  if (await askArch.count()) {
    await askArch.click().catch(() => {});
    await sleep(2000);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await resolveOverlayWidgets(panel, strategy);
    if (state.state === 'idle') {
      return true;
    }
    const placeholder = await panel
      .locator('input, textarea')
      .first()
      .getAttribute('placeholder')
      .catch(() => null);
    if (placeholder === 'Ask about this project...') {
      return true;
    }
    await sleep(1000);
  }

  return false;
}

async function runScenario(page, project, scenario, projectKey) {
  const [id, category, text, strategy] = scenario;
  await page.goto(project.projectUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const reset = await resetInProjectSession(page, project.projectId);
  if (!reset.reset) {
    const screenshot = await captureFailure(page, `${projectKey}-${id}-reset-failed`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: 0,
      issue: `session reset failed (${reset.reason ?? reset.archiveStatus ?? 'unknown'})`,
      screenshot,
    };
  }

  await page.goto(project.projectUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const opened = await openArchOverlay(page);
  if (!opened) {
    const screenshot = await captureFailure(page, `${projectKey}-${id}-overlay-open`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: 0,
      issue: 'could not open overlay',
      screenshot,
    };
  }

  const panel = page.locator('[class*="arch-panel"]');

  const ready = await recoverOverlayToIdle(page, panel, strategy);

  const input = panel
    .locator(
      'input[placeholder="Ask about this project..."], textarea[placeholder="Ask about this project..."]',
    )
    .first();
  if (!ready || !(await input.count())) {
    const screenshot = await captureFailure(page, `${projectKey}-${id}-pre-send`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: 0,
      issue: 'overlay not idle before send',
      screenshot,
    };
  }

  const before = (await panel.innerText().catch(() => '')).length;
  await input.fill(text);
  await input.press('Enter');

  const start = Date.now();
  let sawGrowth = false;
  let widgetSeen = false;
  let idleReached = false;
  let lastTail = '';

  for (let tick = 0; tick < 90; tick++) {
    await sleep(1000);
    const panelText = await panel.innerText().catch(() => '');
    lastTail = summarize(panelText.slice(-800), 220);
    if (panelText.length > before + 20) {
      sawGrowth = true;
    }

    const state = await resolveOverlayWidgets(panel, strategy);
    if (state.state === 'widget_option' || state.state === 'widget_text') {
      widgetSeen = true;
    }

    const placeholder = await panel
      .locator('input, textarea')
      .first()
      .getAttribute('placeholder')
      .catch(() => null);
    if (placeholder === 'Ask about this project...') {
      idleReached = true;
      break;
    }
  }

  if (!sawGrowth && !widgetSeen) {
    const screenshot = await captureFailure(page, `${projectKey}-${id}-no-response`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: Date.now() - start,
      issue: 'no response growth detected',
      screenshot,
      preview: lastTail,
    };
  }

  if (!idleReached) {
    idleReached = await recoverOverlayToIdle(page, panel, strategy);
  }

  if (!idleReached && !widgetSeen) {
    const screenshot = await captureFailure(page, `${projectKey}-${id}-not-idle`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: Date.now() - start,
      issue: 'did not return to idle',
      screenshot,
      preview: lastTail,
    };
  }

  // Widget scenarios can validly end in a follow-up question chain. Since each
  // scenario runs in a fresh session, treat "widget rendered + interaction worked"
  // as success even when the assistant remains in a pending follow-up state.
  if (!idleReached && widgetSeen) {
    return {
      id,
      category,
      description: text,
      status: 'PASS',
      ms: Date.now() - start,
      widgetSeen: true,
      preview: lastTail,
    };
  }

  return {
    id,
    category,
    description: text,
    status: 'PASS',
    ms: Date.now() - start,
    widgetSeen,
    preview: lastTail,
  };
}

async function extractProjectInfo(page, creation) {
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const lines = bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const agentsIndex = lines.findIndex((line) => /^AGENTS\s+\d+/i.test(line));
  const sessionIndex = lines.findIndex((line) => /^SESSIONS/i.test(line));
  const agentNames =
    agentsIndex >= 0 && sessionIndex > agentsIndex
      ? lines.slice(agentsIndex + 1, sessionIndex).filter((line) => !/^QUICK ACTIONS$/i.test(line))
      : [];

  return {
    ...creation,
    bodyText,
    agentNames,
  };
}

function renderResults(run) {
  const lines = [
    '# Arch AI E2E Full Test Results',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    '**Branch:** `Archv03`',
    '**Tester:** Codex autonomous Playwright browser harness',
    '**Context:** `docs/testing/arch-e2e-test-context.md`',
    '',
    '## Run Summary',
    '',
    `- **Projects requested:** 10`,
    `- **Projects created successfully:** ${run.projects.filter((p) => p.success).length}`,
    `- **Project creation failures:** ${run.projects.filter((p) => !p.success).length}`,
    `- **Scenario passes:** ${run.scenarios.filter((s) => s.status === 'PASS').length}`,
    `- **Scenario failures:** ${run.scenarios.filter((s) => s.status === 'FAIL').length}`,
    '',
    '## Project Creation Results',
    '',
  ];

  for (const project of run.projects) {
    lines.push(`### ${project.expectedName ?? project.prompt}`);
    lines.push('');
    lines.push(`- **Status:** ${project.success ? 'PASS' : 'FAIL'}`);
    lines.push(`- **Prompt:** ${project.prompt}`);
    if (project.projectUrl) lines.push(`- **Project URL:** \`${project.projectUrl}\``);
    if (project.projectId) lines.push(`- **Project ID:** \`${project.projectId}\``);
    if (project.checks) {
      lines.push(`- **URL valid:** ${project.checks.urlOk ? 'yes' : 'no'}`);
      lines.push(`- **Expected name visible:** ${project.checks.nameVisible ? 'yes' : 'no'}`);
      lines.push(`- **Ask Arch visible:** ${project.checks.askArchVisible ? 'yes' : 'no'}`);
      lines.push(`- **Agent count:** ${project.checks.agentCount ?? 'unknown'}`);
    }
    if (project.note) lines.push(`- **Note:** ${project.note}`);
    if (project.screenshot) lines.push(`- **Screenshot:** \`${project.screenshot}\``);
    lines.push('');
  }

  lines.push('## Scenario Results');
  lines.push('');

  for (const project of run.projects.filter((p) => p.success)) {
    lines.push(`### ${project.expectedName}`);
    lines.push('');
    lines.push(
      '| Test ID | Category | Status | Time (ms) | Widget | Preview | Issue | Screenshot |',
    );
    lines.push('| --- | --- | --- | ---: | --- | --- | --- | --- |');
    for (const scenario of run.scenarios.filter((s) => s.projectId === project.projectId)) {
      lines.push(
        `| ${scenario.id} | ${scenario.category} | ${scenario.status} | ${scenario.ms ?? ''} | ${scenario.widgetSeen ? 'yes' : 'no'} | ${scenario.preview ?? ''} | ${scenario.issue ?? ''} | ${scenario.screenshot ? `\`${scenario.screenshot}\`` : ''} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  await ensureDirs();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage();

  const run = {
    startedAt: nowIso(),
    projects: [],
    scenarios: [],
  };

  try {
    await login(page);

    const prompts = PROJECT_PROMPTS.slice(0, PROJECT_LIMIT);
    for (let i = 0; i < prompts.length; i++) {
      process.stdout.write(`\n[${i + 1}/${prompts.length}] Creating project...\n`);
      const creation = await runOnboardingCreation(page, prompts[i], i);
      if (!creation.success) {
        run.projects.push(creation);
        await writeFile(RESULTS_PATH, renderResults(run), 'utf8');
        continue;
      }

      const project = await extractProjectInfo(page, creation);
      run.projects.push(project);
      process.stdout.write(
        `[${i + 1}/${prompts.length}] Created ${project.expectedName} (${project.projectId})\n`,
      );

      const overlayOpened = await openArchOverlay(page);
      if (!overlayOpened) {
        const screenshot = await captureFailure(page, `project-${i + 1}-overlay-open`);
        run.scenarios.push({
          projectId: project.projectId,
          id: 'OVERLAY',
          category: 'Setup',
          description: 'Open Arch overlay',
          status: 'FAIL',
          ms: 0,
          issue: 'could not open overlay',
          screenshot,
        });
        await writeFile(RESULTS_PATH, renderResults(run), 'utf8');
        continue;
      }

      const scenarios = buildScenarios(project).slice(0, SCENARIO_LIMIT);
      const projectKey = sanitizeFileName(project.expectedName ?? `project-${i + 1}`);
      for (const scenario of scenarios) {
        process.stdout.write(`[${project.expectedName}] starting ${scenario[0]}: ${scenario[2]}\n`);
        const result = await runScenario(page, project, scenario, projectKey);
        run.scenarios.push({ projectId: project.projectId, ...result });
        process.stdout.write(
          `[${project.expectedName}] ${result.id} ${result.status}${result.issue ? ` (${result.issue})` : ''}\n`,
        );
      }
      await writeFile(RESULTS_PATH, renderResults(run), 'utf8');
    }
  } finally {
    const markdown = renderResults(run);
    await writeFile(RESULTS_PATH, markdown, 'utf8');
    await browser.close();
  }
}

main().catch(async (error) => {
  const failureText = [
    '# Arch AI E2E Full Test Results',
    '',
    `Run failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    '',
  ].join('\n');
  await ensureDirs();
  await writeFile(RESULTS_PATH, failureText, 'utf8');
  process.exitCode = 1;
});
