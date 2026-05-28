import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';

const require = createRequire('/Users/sriharshanalluri/abl-platform/apps/studio/package.json');
const { chromium } = require('@playwright/test');

const BASE_URL = 'http://localhost:5173';
const RESULTS_PATH =
  '/Users/sriharshanalluri/abl-platform/docs/testing/arch-e2e-full-test-results.md';
const OUTPUT_DIR = '/Users/sriharshanalluri/abl-platform/output/playwright';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(text, max = 120) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeFileName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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

async function captureFailure(page, fileBase) {
  const filename = `${OUTPUT_DIR}/${sanitizeFileName(fileBase)}.png`;
  await page.screenshot({ path: filename, fullPage: true });
  return filename.replace('/Users/sriharshanalluri/abl-platform/', '');
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
    ['T5', 'Basic Chat', 'hello :)', {}],
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

async function runScenario(page, project, scenario) {
  const [id, category, text, strategy] = scenario;
  await page.goto(project.projectUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const reset = await resetInProjectSession(page, project.projectId);
  if (!reset.reset) {
    const screenshot = await captureFailure(page, `${project.expectedName}-${id}-reset-failed`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: 0,
      issue: `session reset failed (${reset.reason ?? reset.archiveStatus ?? 'unknown'})`,
      screenshot,
      projectId: project.projectId,
    };
  }

  await page.goto(project.projectUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const opened = await openArchOverlay(page);
  if (!opened) {
    const screenshot = await captureFailure(page, `${project.expectedName}-${id}-overlay-open`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: 0,
      issue: 'could not open overlay',
      screenshot,
      projectId: project.projectId,
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
    const screenshot = await captureFailure(page, `${project.expectedName}-${id}-pre-send`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: 0,
      issue: 'overlay not idle before send',
      screenshot,
      projectId: project.projectId,
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
    const screenshot = await captureFailure(page, `${project.expectedName}-${id}-no-response`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: Date.now() - start,
      issue: 'no response growth detected',
      screenshot,
      preview: lastTail,
      projectId: project.projectId,
    };
  }

  if (!idleReached) {
    idleReached = await recoverOverlayToIdle(page, panel, strategy);
  }

  if (!idleReached && !widgetSeen) {
    const screenshot = await captureFailure(page, `${project.expectedName}-${id}-not-idle`);
    return {
      id,
      category,
      description: text,
      status: 'FAIL',
      ms: Date.now() - start,
      issue: 'did not return to idle',
      screenshot,
      preview: lastTail,
      projectId: project.projectId,
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
    projectId: project.projectId,
  };
}

function parseProjects(markdown) {
  const sections = markdown.split('\n### ').slice(1);
  return sections
    .map((section) => {
      const title = section.split('\n')[0]?.trim();
      const body = section;
      const status = body.match(/- \*\*Status:\*\* (PASS|FAIL)/)?.[1];
      const projectUrl = body.match(/- \*\*Project URL:\*\* `([^`]+)`/)?.[1];
      const projectId = body.match(/- \*\*Project ID:\*\* `([^`]+)`/)?.[1];
      const agentCount = body.match(/- \*\*Agent count:\*\* ([^\n]+)/)?.[1];
      return {
        expectedName: title,
        success: status === 'PASS',
        projectUrl,
        projectId,
        checks: {
          agentCount: agentCount && agentCount !== 'unknown' ? Number(agentCount) : null,
        },
      };
    })
    .filter((project) => project.success && project.projectUrl && project.projectId);
}

async function enrichProjectInfo(page, project) {
  await page.goto(project.projectUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
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
    ...project,
    agentNames,
    checks: {
      ...(project.checks ?? {}),
      urlOk: /\/projects\/[^/]+$/.test(project.projectUrl),
      nameVisible: bodyText.includes(project.expectedName),
      askArchVisible: /Ask Arch/i.test(bodyText),
      breadcrumbVisible: bodyText.includes(project.expectedName),
      leftNavNameVisible: bodyText.includes(project.expectedName),
      agentCount:
        project.checks?.agentCount ??
        (bodyText.match(/AGENTS\s+(\d+)/i)?.[1]
          ? Number(bodyText.match(/AGENTS\s+(\d+)/i)?.[1])
          : null),
    },
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
    `- **Projects created successfully:** ${run.projects.filter((project) => project.success).length}`,
    `- **Project creation failures:** ${run.projects.filter((project) => !project.success).length}`,
    `- **Scenario passes:** ${run.scenarios.filter((scenario) => scenario.status === 'PASS').length}`,
    `- **Scenario failures:** ${run.scenarios.filter((scenario) => scenario.status === 'FAIL').length}`,
    '',
    '## Project Creation Results',
    '',
  ];

  for (const project of run.projects) {
    lines.push(`### ${project.expectedName ?? project.prompt}`);
    lines.push('');
    lines.push(`- **Status:** ${project.success ? 'PASS' : 'FAIL'}`);
    if (project.prompt) lines.push(`- **Prompt:** ${project.prompt}`);
    if (project.projectUrl) lines.push(`- **Project URL:** \`${project.projectUrl}\``);
    if (project.projectId) lines.push(`- **Project ID:** \`${project.projectId}\``);
    if (project.checks) {
      lines.push(`- **URL valid:** ${project.checks.urlOk ? 'yes' : 'no'}`);
      lines.push(
        `- **Breadcrumb shows project name:** ${project.checks.breadcrumbVisible ? 'yes' : 'no'}`,
      );
      lines.push(
        `- **Left nav shows project name:** ${project.checks.leftNavNameVisible ? 'yes' : 'no'}`,
      );
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

  for (const project of run.projects.filter((project) => project.success)) {
    lines.push(`### ${project.expectedName}`);
    lines.push('');
    lines.push(
      '| Test ID | Category | Status | Time (ms) | Widget | Preview | Issue | Screenshot |',
    );
    lines.push('| --- | --- | --- | ---: | --- | --- | --- | --- |');
    for (const scenario of run.scenarios.filter((item) => item.projectId === project.projectId)) {
      lines.push(
        `| ${scenario.id} | ${scenario.category} | ${scenario.status} | ${scenario.ms ?? ''} | ${scenario.widgetSeen ? 'yes' : 'no'} | ${scenario.preview ?? ''} | ${scenario.issue ?? ''} | ${scenario.screenshot ? `\`${scenario.screenshot}\`` : ''} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const markdown = await readFile(RESULTS_PATH, 'utf8');
  const parsedProjects = parseProjects(markdown).slice(0, 10);
  if (parsedProjects.length < 10) {
    throw new Error(`Expected 10 created projects in results file, found ${parsedProjects.length}`);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage();

  try {
    await login(page);

    const projects = [];
    for (const project of parsedProjects) {
      projects.push(await enrichProjectInfo(page, project));
    }

    const scenarios = [];
    const scenarioTemplates = buildScenarios(projects[0]);
    for (let index = 0; index < scenarioTemplates.length; index++) {
      const project = projects[Math.floor(index / 5)] ?? projects[projects.length - 1];
      const projectAwareScenario = buildScenarios(project)[index];
      process.stdout.write(
        `[${project.expectedName}] starting ${projectAwareScenario[0]}: ${projectAwareScenario[2]}\n`,
      );
      const result = await runScenario(page, project, projectAwareScenario);
      scenarios.push(result);
      process.stdout.write(
        `[${project.expectedName}] ${result.id} ${result.status}${result.issue ? ` (${result.issue})` : ''}\n`,
      );
      await writeFile(RESULTS_PATH, renderResults({ projects, scenarios }), 'utf8');
    }
  } finally {
    await browser.close();
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
