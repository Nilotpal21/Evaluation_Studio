/**
 * UI interaction helpers for real E2E tests.
 *
 * Reusable page-level utilities: screenshots, waiting, navigation.
 * Extracted from patterns in full-platform-e2e.spec.ts and guardrails-comprehensive-e2e.spec.ts.
 *
 * @e2e-real — No mocks. Real browser interactions.
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Page } from '@playwright/test';
import { env } from './env';

/** Take a named screenshot + console annotation. Auto-creates directories. */
export async function screenshot(page: Page, name: string, note: string): Promise<void> {
  const path = `${env.screenshotDir}/${name}`;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  console.info(`[E2E] ${name}: ${note}`);
}

/** Wait for network to settle + optional extra delay. */
export async function waitForIdle(page: Page, extraMs = 500): Promise<void> {
  await page
    .waitForLoadState('load')
    .catch((e: Error) => console.warn('[E2E] load timeout:', e.message));
  await page
    .waitForLoadState('networkidle')
    .catch((e: Error) => console.warn('[E2E] networkidle timeout:', e.message));
  await page.waitForTimeout(extraMs);
}

/** Wait for visible content (proves React rendered). */
export async function waitForRendered(page: Page, timeout = 30_000): Promise<void> {
  await page
    .locator('h1, h2, h3, button, [role="main"]')
    .first()
    .waitFor({ state: 'visible', timeout })
    .catch(() => console.warn('[E2E] Page did not render visible content in time'));
  await page.waitForTimeout(500);
}

/**
 * Navigate to a specific section within Studio.
 * Handles the common pattern: sidebar nav click -> wait for URL -> wait for render.
 *
 * @param slug - URL-safe path segment (e.g., 'search-ai', 'agents'). Used for fallback direct nav.
 */
export async function navigateToSection(
  page: Page,
  projectId: string,
  label: string,
  slug?: string,
  waitForUrlPattern?: RegExp,
): Promise<void> {
  const sidebarLink = page.locator(`nav >> text=${label}`);
  const isVisible = await sidebarLink.isVisible({ timeout: 5_000 }).catch(() => false);

  if (isVisible) {
    await sidebarLink.click();
  } else {
    // Fallback: direct navigation using slug
    const path = slug || label.toLowerCase().replace(/\s+/g, '-');
    await page.goto(`${env.baseUrl}/projects/${projectId}/${path}`);
  }

  if (waitForUrlPattern) {
    await page.waitForURL(waitForUrlPattern, { timeout: 15_000 }).catch(() => {});
  }
  await waitForIdle(page);
}

/**
 * Poll a condition until it's true, with timeout.
 * Useful for waiting on async backend operations (ingestion, crawl, etc.).
 */
export async function pollUntil(
  fn: () => Promise<boolean>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const { timeout = env.longTimeout, interval = 3_000, label = 'condition' } = opts;
  const start = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(
    `Timed out after ${timeout}ms waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`,
  );
}
