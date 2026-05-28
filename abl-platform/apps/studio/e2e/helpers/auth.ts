/**
 * Authentication helpers for real E2E tests.
 *
 * Handles Dev Login flow against any environment where dev-login is enabled.
 * Returns a token for API calls and leaves the browser session authenticated.
 *
 * Auth flow:
 * 1. Click "Dev Login" button → sets httpOnly `refresh_token` cookie
 * 2. Call `/api/auth/refresh` → exchanges cookie for `accessToken` JWT
 * 3. Use `accessToken` as Bearer token in all API calls
 *
 * This matches how the real Studio frontend works:
 * - Zustand auth store holds accessToken in memory
 * - `apiFetch` sends `Authorization: Bearer <token>` + `X-Tenant-Id`
 * - On 401, auto-refreshes via `/api/auth/refresh` (using cookie)
 *
 * @e2e-real — No mocks. Hits the real auth endpoints.
 */

import { expect, type Page } from '@playwright/test';
import { env } from './env';

export interface AuthContext {
  token: string;
  projectId: string;
}

export interface DevLoginOptions {
  baseUrl?: string;
  email?: string;
  name?: string;
  landingPath?: string;
}

const E2E_SMOKE_EMAIL_DOMAIN = '@e2e-smoke.test';
const ISOLATED_TEST_LOGIN_EMAILS = new Set(['studio-theme-docs@kore.ai']);
const BEST_EFFORT_NETWORK_IDLE_TIMEOUT_MS = 5_000;

function resolveDevLoginOptions(options: DevLoginOptions = {}) {
  return {
    baseUrl: options.baseUrl ?? env.baseUrl,
    email: options.email ?? env.loginEmail,
    name: options.name ?? 'E2E Test User',
    landingPath: options.landingPath ?? '/projects',
  };
}

export function isIsolatedTestLoginEmail(email: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  return (
    normalizedEmail.endsWith(E2E_SMOKE_EMAIL_DOMAIN) ||
    ISOLATED_TEST_LOGIN_EMAILS.has(normalizedEmail)
  );
}

async function waitForBestEffortNetworkIdle(page: Page): Promise<void> {
  await page
    .waitForLoadState('networkidle', {
      timeout: BEST_EFFORT_NETWORK_IDLE_TIMEOUT_MS,
    })
    .catch(() => {});
}

/**
 * Login via the dev-login API and inject the resulting cookies into the browser context.
 * This is the preferred path for isolated E2E users because the UI Dev Login button is
 * intentionally hardcoded to the human local-dev account.
 */
export async function loginViaDevApi(page: Page, options: DevLoginOptions = {}): Promise<void> {
  const { baseUrl, email, name, landingPath } = resolveDevLoginOptions(options);
  const tokenResp = await page.request.post(`${baseUrl}/api/auth/dev-login`, {
    data: { email, name },
  });

  if (!tokenResp.ok()) {
    throw new Error(`Dev Login API failed: ${tokenResp.status()}`);
  }

  const body = (await tokenResp.json()) as {
    accessToken?: string;
    refreshToken?: string;
  };

  const domain = new URL(baseUrl).hostname;
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    sameSite: 'Lax';
  }> = [];

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

  await page.goto(`${baseUrl}${landingPath}`);
  await page
    .waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 10_000 })
    .catch(() => {});
  await waitForBestEffortNetworkIdle(page);
  await page.waitForTimeout(2_000);
}

export async function getDevAccessToken(
  page: Page,
  options: DevLoginOptions = {},
): Promise<string> {
  const { baseUrl, email, name } = resolveDevLoginOptions(options);
  const resp = await page.request
    .post(`${baseUrl}/api/auth/dev-login`, {
      data: { email, name },
    })
    .catch(() => null);

  if (!resp || !resp.ok()) {
    console.warn(`[E2E] getDevAccessToken failed: ${resp?.status() ?? 'no response'}`);
    return '';
  }

  const body = await resp.json().catch(() => ({}));
  return (body as { accessToken?: string }).accessToken ?? '';
}

/**
 * Login via Dev Login button click (real user flow), navigate to first project.
 *
 * Strategy:
 * 1. Navigate to login page, click "Dev Login" button — sets httpOnly refresh_token cookie
 * 2. Wait for redirect to projects page
 * 3. Call /api/auth/refresh to get an accessToken (like the real frontend does on page load)
 * 4. Click first project card to enter a project context
 *
 * Falls back to API-based login if "Dev Login" button is not found.
 */
export async function loginAndNavigateToProject(page: Page): Promise<AuthContext> {
  if (isIsolatedTestLoginEmail(env.loginEmail)) {
    console.info(`[E2E] Using isolated test login via API for ${env.loginEmail}`);
    await loginViaDevApi(page);
  } else {
    // ── Step 1: Navigate to login page ──
    await page.goto(`${env.baseUrl}/auth/login`);
    await page.waitForLoadState('load');

    // Wait for page to be interactive
    await page.waitForTimeout(2_000);

    // ── Step 2: Click "Dev Login" button (preferred — sets cookies properly) ──
    const devLoginBtn = page.locator('button', { hasText: /dev login/i });
    const hasDevLogin = await devLoginBtn.isVisible({ timeout: 10_000 }).catch(() => false);

    if (hasDevLogin) {
      console.info('[E2E] Found Dev Login button — clicking');
      await devLoginBtn.click();

      // Wait for redirect to projects page
      await page.waitForURL(/\/(projects|$)/, { timeout: 15_000 }).catch(() => {});
      await waitForBestEffortNetworkIdle(page);
      await page.waitForTimeout(2_000);
    } else {
      // Fallback: API-based login + cookie injection
      console.warn('[E2E] No Dev Login button found — using API fallback');
      await loginViaDevApi(page);
    }

    // ── Step 3: Ensure we're on the projects page ──
    if (!page.url().includes('/projects')) {
      await page.goto(`${env.baseUrl}/projects`);
      await waitForBestEffortNetworkIdle(page);
      await page.waitForTimeout(2_000);
    }

    // If still on login, try API fallback
    if (page.url().includes('/auth/login')) {
      console.warn('[E2E] Still on login after Dev Login click — using API fallback');
      await loginViaDevApi(page);
    }
  }

  // ── Step 4: Get access token via refresh (like the real frontend does) ──
  const token = await getToken(page);
  expect(token, 'Auth token should be non-empty').toBeTruthy();

  // ── Step 5: Wait for project cards to load and select ──
  const allCards = page.locator('button:has(h3)');
  const hasCards = await allCards
    .first()
    .isVisible({ timeout: 20_000 })
    .catch(() => false);

  if (!hasCards) {
    const pageText = await page
      .locator('main')
      .textContent()
      .catch(() => '');
    throw new Error(
      `No project cards found after 20s. Page content: "${(pageText || '').slice(0, 200)}". ` +
        `Create a project first, or check if dev-login email has access.`,
    );
  }

  // If TEST_PROJECT_NAME is set, find that specific card
  if (env.projectName) {
    const targetCard = page.locator('button:has(h3)', {
      hasText: new RegExp(env.projectName, 'i'),
    });
    const found = await targetCard.isVisible({ timeout: 5_000 }).catch(() => false);
    if (found) {
      console.info(`[E2E] Selecting project: "${env.projectName}"`);
      await targetCard.click();
    } else {
      console.warn(`[E2E] Project "${env.projectName}" not found — falling back to first card`);
      await allCards.first().click();
    }
  } else {
    await allCards.first().click();
  }

  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
  await waitForBestEffortNetworkIdle(page);

  const projectId = extractProjectId(page.url());
  console.info(`[E2E] Logged in. Project: ${projectId}`);

  return { token, projectId };
}

/**
 * API-based login fallback — for environments where Dev Login button isn't visible.
 * Calls the dev-login API and injects the session cookie.
 */
/**
 * Get an access token by calling /api/auth/refresh.
 *
 * This mirrors the real frontend flow:
 * - After Dev Login, the browser has a `refresh_token` httpOnly cookie
 * - /api/auth/refresh reads this cookie and returns a new accessToken JWT
 * - The frontend stores this in Zustand and uses it as Bearer token
 *
 * page.request automatically includes the browser context's cookies,
 * so the refresh_token cookie is sent along.
 */
export async function getToken(page: Page): Promise<string> {
  // Try refresh endpoint first (uses the httpOnly refresh_token cookie)
  const refreshResp = await page.request
    .post(`${env.baseUrl}/api/auth/refresh`, {
      data: {},
    })
    .catch(() => null);

  if (refreshResp && refreshResp.ok()) {
    const body = (await refreshResp.json().catch(() => ({}))) as {
      accessToken?: string;
    };
    if (body.accessToken) {
      console.info('[E2E] Got access token via /api/auth/refresh');
      return body.accessToken;
    }
  }

  console.warn(
    `[E2E] /api/auth/refresh failed (${refreshResp?.status() ?? 'no response'}) — trying dev-login fallback`,
  );

  return getDevAccessToken(page);
}

/** Extract projectId from URL. */
export function extractProjectId(url: string): string {
  const m = url.match(/\/projects\/([^/?#]+)/);
  if (!m) throw new Error(`No project ID in URL: ${url}`);
  return m[1];
}
