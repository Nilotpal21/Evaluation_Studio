import fs from 'node:fs';
import path from 'node:path';
import { IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './constants.mjs';
import { delay, ensureDir, waitForCondition } from './utils.mjs';

export function buildStaticAgentDsl(agentName, replyText) {
  return `
AGENT: ${agentName}
GOAL: "Provide deterministic Studio video evidence replies"
PERSONA: "Regression verification agent"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  REASONING: false
  RESPOND: "${replyText.replaceAll('"', '\\"')}"
  THEN: COMPLETE
`;
}

export async function apiJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
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
    const error = new Error(
      `${options.method ?? 'GET'} ${pathname} failed (${response.status}): ${text}`,
    );
    error.status = response.status;
    error.responseBody = body;
    error.responseText = text;
    error.retryAfterMs =
      Number(
        response.headers.get('retry-after-ms') ??
          (typeof body === 'object' && body ? body.retryAfterMs : undefined),
      ) || 0;
    throw error;
  }
  return body;
}

export async function devLogin(baseUrl, { email, name }) {
  const body = await apiJson(baseUrl, '/api/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ email, name }),
  });
  if (!body?.accessToken) {
    throw new Error('Dev login succeeded but no access token was returned.');
  }
  return body;
}

function createAuthCookie(baseUrl, name, value, { httpOnly }) {
  return {
    name,
    value,
    domain: new URL(baseUrl).hostname,
    path: '/',
    httpOnly,
    sameSite: 'Lax',
    secure: baseUrl.startsWith('https://'),
  };
}

function buildPersistedTenantState(tenantId) {
  return JSON.stringify({
    state: {
      tenantId,
    },
    version: 0,
  });
}

/**
 * Force Studio's theme store to a specific resolved theme before navigation.
 *
 * Studio persists `{ state: { mode } }` under the `kore-theme-storage`
 * localStorage key (zustand persist middleware). On rehydrate, the store
 * reads that key and writes `data-theme` to <html>. Setting localStorage
 * via `addInitScript` runs before any page script, so the initial paint
 * already reflects the requested theme. We also write `data-theme` directly
 * as a belt-and-suspenders measure to suppress the system-default flash.
 *
 * @param {import('playwright').Page} page
 * @param {'light' | 'dark'} theme
 */
export async function forceTheme(page, theme) {
  if (theme !== 'light' && theme !== 'dark') {
    throw new Error(`forceTheme: unsupported theme "${theme}". Expected "light" or "dark".`);
  }
  const persistedThemeState = JSON.stringify({
    state: { mode: theme },
    version: 0,
  });
  await page.addInitScript(
    ({ storageValue, resolved }) => {
      try {
        window.localStorage.setItem('kore-theme-storage', storageValue);
      } catch {
        // Ignore storage write failures during browser bootstrap.
      }
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.setAttribute('data-theme', resolved);
        }
      } catch {
        // Ignore DOM access failures during init.
      }
    },
    { storageValue: persistedThemeState, resolved: theme },
  );
}

export async function bootstrapStudioBrowserSession(
  page,
  baseUrl,
  { accessToken, refreshToken, tenantId, landingPath = '/projects' },
) {
  let resolvedAccessToken = String(accessToken ?? '').trim();
  let resolvedRefreshToken = String(refreshToken ?? '').trim();
  const resolvedTenantId = String(tenantId ?? '').trim();

  if (!resolvedAccessToken && resolvedRefreshToken) {
    const refreshBody = resolvedTenantId
      ? { tenantId: resolvedTenantId, refresh_token: resolvedRefreshToken }
      : { refresh_token: resolvedRefreshToken };
    const refreshResult = await apiJson(baseUrl, '/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify(refreshBody),
    });
    resolvedAccessToken =
      typeof refreshResult?.accessToken === 'string' ? refreshResult.accessToken : '';
    if (typeof refreshResult?.refreshToken === 'string' && refreshResult.refreshToken.trim()) {
      resolvedRefreshToken = refreshResult.refreshToken.trim();
    }
  }

  if (resolvedTenantId) {
    const persistedTenantState = buildPersistedTenantState(resolvedTenantId);
    await page.addInitScript((storageValue) => {
      try {
        window.localStorage.setItem('kore-auth-storage', storageValue);
      } catch {
        // Ignore storage write failures during browser bootstrap.
      }
    }, persistedTenantState);
  }

  const cookies = [];
  if (resolvedRefreshToken) {
    cookies.push(
      createAuthCookie(baseUrl, 'refresh_token', resolvedRefreshToken, {
        httpOnly: true,
      }),
    );
  }
  if (resolvedAccessToken) {
    cookies.push(
      createAuthCookie(baseUrl, 'access_token', resolvedAccessToken, {
        httpOnly: false,
      }),
    );
  }
  if (cookies.length > 0) {
    await page.context().addCookies(cookies);
  }

  await page.goto(`${baseUrl}${landingPath}`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForURL((url) => !url.pathname.includes('/auth/login'), {
      timeout: REQUEST_TIMEOUT_MS,
    })
    .catch(() => {});
  await waitForIdle(page, 1_000);

  return {
    accessToken: resolvedAccessToken || null,
    refreshToken: resolvedRefreshToken || null,
    tenantId: resolvedTenantId || null,
  };
}

export async function createProject(baseUrl, accessToken, { name, slug }) {
  const body = await apiJson(baseUrl, '/api/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name, slug }),
  });
  if (!body?.project?.id) {
    throw new Error('Project creation succeeded but no project id was returned.');
  }
  return body.project;
}

export async function createAgent(
  baseUrl,
  accessToken,
  projectId,
  { name, description, dslContent },
) {
  await apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/agents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      name,
      agentPath: name,
      description,
    }),
  });

  await apiJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(name)}/dsl`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ dslContent }),
    },
  );

  await apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ entryAgentName: name }),
  });

  return { name };
}

export async function createSession(baseUrl, accessToken, projectId, { agentId }) {
  const body = await apiJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ agentId }),
  });

  if (!body?.session?.id) {
    throw new Error('Session creation succeeded but no session id was returned.');
  }

  return body.session;
}

export async function loginBrowserViaDevApi(page, baseUrl, { email, name, landingPath }) {
  const loginBody = await devLogin(baseUrl, { email, name });
  const domain = new URL(baseUrl).hostname;
  const cookies = [];

  if (loginBody.refreshToken) {
    cookies.push({
      name: 'refresh_token',
      value: loginBody.refreshToken,
      domain,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
  }

  if (loginBody.accessToken) {
    cookies.push({
      name: 'access_token',
      value: loginBody.accessToken,
      domain,
      path: '/',
      httpOnly: false,
      sameSite: 'Lax',
    });
  }

  if (cookies.length > 0) {
    await page.context().addCookies(cookies);
  }

  await page.goto(`${baseUrl}${landingPath}`, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page, 1_000);
  return loginBody;
}

export async function waitForIdle(page, extraMs = 700) {
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(extraMs);
}

export async function waitForStudioAgentChatReady(page) {
  const newChatButton = page.locator('button:has-text("New Chat")').first();
  await newChatButton.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
  await waitForCondition(
    async () => (await newChatButton.isEnabled().catch(() => false)) || false,
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 250,
      label: 'Timed out waiting for the New Chat button to become enabled.',
    },
  );
  await newChatButton.click();

  await page.locator('[data-testid="chat-widget"]').waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.locator('[data-testid="chat-input"] textarea').waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
}

export async function openStudioAgentChat(page, baseUrl, { projectId, agentName }) {
  await page.goto(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}/chat`,
    {
      waitUntil: 'domcontentloaded',
    },
  );
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(1_000);
  await waitForStudioAgentChatReady(page);
}

export async function sendStudioChatMessage(page, text) {
  const input = page.locator('[data-testid="chat-input"] textarea').first();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

export async function countExactMessageBubbles(page, text) {
  return await page.locator('[data-testid="message-list"]').evaluate((node, expectedText) => {
    return Array.from(node.children).filter((child) => child.textContent?.trim() === expectedText)
      .length;
  }, text);
}

export async function assertExactMessageBubbleCount(page, text, expectedCount, { timeoutMs }) {
  await waitForCondition(
    async () => ((await countExactMessageBubbles(page, text)) === expectedCount ? true : false),
    {
      timeoutMs,
      intervalMs: 250,
      label: `Expected "${text}" to appear exactly ${String(expectedCount)} time(s) in the message list.`,
    },
  );
}

export async function sampleExactMessageBubbleCount(
  page,
  text,
  expectedCount,
  { sampleCount, intervalMs },
) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const count = await countExactMessageBubbles(page, text);
    samples.push(count);
    if (count !== expectedCount) {
      throw new Error(
        `Expected "${text}" to remain at ${String(expectedCount)} bubble(s), but saw samples ${samples.join(', ')}.`,
      );
    }
    await delay(intervalMs);
  }
  return samples;
}

export async function waitForMessageListText(page, text, timeoutMs = REQUEST_TIMEOUT_MS) {
  await waitForCondition(
    async () => {
      const messageListText = await page
        .locator('[data-testid="message-list"]')
        .textContent()
        .catch(() => '');
      return messageListText?.includes(text) ? true : false;
    },
    {
      timeoutMs,
      intervalMs: 250,
      label: `Timed out waiting for the message list to contain "${text}".`,
    },
  );
}

export function createArtifactHelpers({ page, screenshotsDir, log }) {
  ensureDir(screenshotsDir);

  const screenshots = [];

  return {
    screenshots,
    async captureScreenshot(filename, options = {}) {
      const absolutePath = path.join(screenshotsDir, filename);
      await page.screenshot({ path: absolutePath, fullPage: true, ...options });
      screenshots.push(absolutePath);
      if (log) {
        log(`Captured screenshot ${path.basename(absolutePath)}`);
      }
      return absolutePath;
    },
    async captureFailureScreenshot(filename = 'failure.png') {
      const absolutePath = path.join(screenshotsDir, filename);
      try {
        await page.screenshot({ path: absolutePath, fullPage: true });
        screenshots.push(absolutePath);
        return absolutePath;
      } catch {
        return null;
      }
    },
    findRecordedVideo(rawVideoDir) {
      if (!fs.existsSync(rawVideoDir)) return null;
      const candidates = fs
        .readdirSync(rawVideoDir)
        .filter((entry) => entry.endsWith('.webm'))
        .map((entry) => path.join(rawVideoDir, entry))
        .sort();
      return candidates.at(-1) ?? null;
    },
  };
}
