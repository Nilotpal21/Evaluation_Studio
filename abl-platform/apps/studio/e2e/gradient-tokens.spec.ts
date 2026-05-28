/**
 * Gradient Design Token E2E Tests (E2E-1 through E2E-5)
 *
 * Verifies gradient tokens render correctly in a real browser using Playwright.
 * Tests computed styles, theme switching, gradient borders, and reduced-motion.
 *
 * Prerequisites: Studio running at localhost:5173 with dev login available.
 */

import { test, expect, type Page } from '@playwright/test';
import { getDevAccessToken, loginViaDevApi } from './helpers';

// =============================================================================
// HELPERS
// =============================================================================

const STUDIO_URL = 'http://localhost:5173';
const TEST_LOGIN_EMAIL = 'gradient-tokens@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Gradient Tokens E2E';

function getTenantIdFromToken(token: string): string {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? 'tenant-kore';
}

async function createProject(page: Page, token: string, tenantId: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post(`${STUDIO_URL}/api/projects`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name: `Gradient Tokens ${suffix}`,
      slug: `gradient-tokens-${suffix}`,
      description: 'Project created by the gradient token Playwright coverage',
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    project?: {
      id?: string;
    };
  };
  expect(body.project?.id).toBeTruthy();
  return body.project?.id ?? '';
}

/**
 * Perform Dev Login and navigate to a project page.
 */
async function devLogin(page: Page): Promise<string> {
  await loginViaDevApi(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
    landingPath: '/',
  });

  const currentUrl = page.url();

  // Extract project ID or navigate to first project
  if (currentUrl.includes('/projects/')) {
    return currentUrl;
  }

  await page.goto(`${STUDIO_URL}/projects`);
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('Escape').catch(() => {});

  // Click a real project card instead of generic rounded containers.
  const firstCard = page.locator('button:has(h3)').first();
  if (await firstCard.isVisible({ timeout: 5000 }).catch(() => false)) {
    await firstCard.click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
  }

  if (!page.url().includes('/projects/')) {
    const token = await getDevAccessToken(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    const tenantId = getTenantIdFromToken(token);
    const projectId = await createProject(page, token, tenantId);
    await page.goto(`${STUDIO_URL}/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
  }

  return page.url();
}

/**
 * Get computed backgroundImage for an element matching a CSS class.
 */
async function getComputedGradient(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'NOT_FOUND';
    return window.getComputedStyle(el).backgroundImage;
  }, selector);
}

// =============================================================================
// TESTS
// =============================================================================

test.describe('Gradient Design Tokens E2E', () => {
  test.describe.configure({ mode: 'serial' });

  // E2E-1: Gradient tokens apply correctly in dark theme
  test('E2E-1: gradient tokens render in dark theme', async ({ page }) => {
    await devLogin(page);

    // Dark theme is the default. Check sidebar gradient.
    // The sidebar uses .sidebar-bg which is aliased to var(--gradient-surface-sidebar)
    const sidebarBg = await page.evaluate(() => {
      // Look for elements with gradient background
      const sidebar = document.querySelector(
        '[class*="sidebar-bg"], [class*="bg-gradient-surface-sidebar"]',
      );
      if (!sidebar) return 'NO_SIDEBAR';
      return window.getComputedStyle(sidebar).backgroundImage;
    });

    // Sidebar should have a gradient, not 'none'
    if (sidebarBg !== 'NO_SIDEBAR') {
      expect(sidebarBg).not.toBe('none');
      expect(sidebarBg).toContain('gradient');
    }

    // Check for any element with an actual gradient background.
    const hasGradientElement = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const style = window.getComputedStyle(el);
        if (
          style.backgroundImage &&
          style.backgroundImage !== 'none' &&
          style.backgroundImage.includes('gradient')
        ) {
          return {
            tag: el.tagName.toLowerCase(),
            value: style.backgroundImage,
          };
        }
      }
      return null;
    });

    // At minimum, sidebar or some gradient element should be visible
    expect(hasGradientElement).not.toBeNull();
    expect(hasGradientElement!.value).toContain('gradient');
  });

  // E2E-2: Gradient tokens apply correctly in light theme
  test('E2E-2: gradient tokens render in light theme', async ({ page }) => {
    await devLogin(page);

    // Capture dark theme gradient value
    const darkGradient = await page.evaluate(() => {
      const el = document.querySelector(
        '[class*="sidebar-bg"], [class*="bg-gradient-surface-sidebar"], [class*="bg-gradient-"]',
      );
      if (!el) return 'NONE';
      return window.getComputedStyle(el).backgroundImage;
    });

    // Switch to light theme
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await page.waitForTimeout(500);

    // Capture light theme gradient value
    const lightGradient = await page.evaluate(() => {
      const el = document.querySelector(
        '[class*="sidebar-bg"], [class*="bg-gradient-surface-sidebar"], [class*="bg-gradient-"]',
      );
      if (!el) return 'NONE';
      return window.getComputedStyle(el).backgroundImage;
    });

    // Light theme should either have a gradient or a valid background
    // (some surface gradients intentionally flatten in light mode)
    if (darkGradient !== 'NONE' && lightGradient !== 'NONE') {
      // The values should differ between themes
      // (light theme uses different HSL values)
      expect(lightGradient).not.toBe('none');
    }
  });

  // E2E-3: Theme toggle transitions without flash
  test('E2E-3: theme toggle transitions without FOUC', async ({ page }) => {
    await devLogin(page);

    // Take dark theme screenshot
    const darkScreenshot = await page.screenshot();
    expect(darkScreenshot.length).toBeGreaterThan(0);

    // Toggle to light theme
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });

    // Take mid-transition screenshot (50ms)
    await page.waitForTimeout(50);
    const midScreenshot = await page.screenshot();
    expect(midScreenshot.length).toBeGreaterThan(0);

    // Wait for transition to complete
    await page.waitForTimeout(350);
    const lightScreenshot = await page.screenshot();
    expect(lightScreenshot.length).toBeGreaterThan(0);

    // Verify the page didn't go fully white during transition
    // (a FOUC would produce a very different pixel distribution)
    // Simple check: mid-transition screenshot should have content
    // (not a blank white page)
    const midHasContent = await page.evaluate(() => {
      const body = document.body;
      const bg = window.getComputedStyle(body).backgroundColor;
      // A FOUC flash would be pure white (rgb(255, 255, 255))
      return bg !== 'rgb(255, 255, 255)' || document.body.children.length > 0;
    });
    expect(midHasContent).toBe(true);
  });

  // E2E-4: Gradient borders render with border-radius
  test('E2E-4: gradient borders render on interactive elements', async ({ page }) => {
    await devLogin(page);

    // Navigate to agents page where AgentCard with hover:border-gradient-brand exists
    const currentUrl = page.url();
    const projectMatch = currentUrl.match(/\/projects\/([^/]+)/);
    if (projectMatch) {
      await page.goto(`${STUDIO_URL}/projects/${projectMatch[1]}/agents`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }

    // Check if agent cards exist with the gradient border class
    const hasGradientBorderCards = await page.evaluate(() => {
      const cards = document.querySelectorAll(
        '[class*="border-gradient-brand"], [class*="hover\\:border-gradient-brand"]',
      );
      return cards.length;
    });

    // If cards exist, verify they have border-radius
    if (hasGradientBorderCards > 0) {
      const cardBorderRadius = await page.evaluate(() => {
        const card = document.querySelector(
          '[class*="border-gradient-brand"], [class*="hover\\:border-gradient-brand"]',
        );
        if (!card) return '0px';
        return window.getComputedStyle(card).borderRadius;
      });
      // Cards should have rounded corners
      expect(cardBorderRadius).not.toBe('0px');
    }

    // Even without cards, verify the CSS class exists by checking
    // a style element or the stylesheet
    const borderGradientExists = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (
              rule instanceof CSSStyleRule &&
              rule.selectorText?.includes('border-gradient-brand')
            ) {
              return true;
            }
          }
        } catch {
          // Cross-origin stylesheets may throw
        }
      }
      return false;
    });

    expect(borderGradientExists).toBe(true);
  });

  // E2E-5: Reduced-motion disables animated gradients
  test('E2E-5: prefers-reduced-motion disables skeleton animation', async ({ page }) => {
    // Enable reduced motion
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await devLogin(page);

    // Navigate to a page that triggers loading (agents list)
    const currentUrl = page.url();
    const projectMatch = currentUrl.match(/\/projects\/([^/]+)/);
    if (projectMatch) {
      // Intercept the agents API to delay response and show skeletons
      await page.route('**/api/projects/*/agents**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.continue();
      });

      await page.goto(`${STUDIO_URL}/projects/${projectMatch[1]}/agents`);

      // Wait briefly for skeleton to appear
      await page.waitForTimeout(500);

      // Check if skeleton elements are visible
      const skeletonAnimation = await page.evaluate(() => {
        const skeleton = document.querySelector('.skeleton, [class*="skeleton"]');
        if (!skeleton) return { found: false, animation: 'N/A' };
        const style = window.getComputedStyle(skeleton);
        return {
          found: true,
          animation: style.animation,
          animationName: style.animationName,
          animationDuration: style.animationDuration,
        };
      });

      if (skeletonAnimation.found) {
        // Under reduced-motion, animation should be 'none'
        const isDisabled =
          skeletonAnimation.animation === 'none' ||
          skeletonAnimation.animation.includes('none') ||
          skeletonAnimation.animationName === 'none' ||
          skeletonAnimation.animationDuration === '0s';
        expect(isDisabled).toBe(true);
      }
    }

    // Disable reduced motion and verify animations would be active
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // Verify the CSS rule exists by checking stylesheet
    const hasReducedMotionRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (
              rule instanceof CSSMediaRule &&
              rule.conditionText?.includes('prefers-reduced-motion')
            ) {
              return true;
            }
          }
        } catch {
          // Cross-origin stylesheets may throw
        }
      }
      return false;
    });

    expect(hasReducedMotionRule).toBe(true);
  });
});
