/**
 * Track 1.16 — Arch AI overlay both-theme validation captures.
 *
 * Opens the in-project Arch overlay on a fresh project in both light and dark
 * themes and captures the SmartWelcome state. Verifies that Track 1.13/1.14/1.15
 * changes (bg-gradient-surface-panel, SpecialistBadge text-xs, AIAuthoredBadge)
 * render correctly in both themes.
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-arch-overlay-validation
 */

import {
  buildStaticAgentDsl,
  bootstrapStudioBrowserSession,
  createAgent,
  createProject,
  devLogin,
  forceTheme,
  waitForIdle,
} from '../lib/studio-chat.mjs';
import { uniqueSuffix } from '../lib/utils.mjs';

const THEMES = ['light', 'dark'];

export const scenario = {
  id: 'audit-arch-overlay-validation',
  title: 'Arch AI overlay both-theme validation (Track 1.16)',
  description:
    'Opens the Arch in-project overlay on a disposable project in light + dark themes ' +
    'to validate Track 1.13–1.15 typography and token changes look correct.',
  example: 'pnpm studio:video:evidence -- --scenario audit-arch-overlay-validation',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const { accessToken, refreshToken } = await devLogin(baseUrl, {
      email,
      name: 'Arch Overlay Validation',
    });

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      // ignore
    }

    const slug = `arch-overlay-val-${uniqueSuffix()}`;
    log(`Creating disposable project ${slug}...`);
    const project = await createProject(baseUrl, accessToken, {
      name: 'Arch Overlay Validation',
      slug,
    });
    const projectId = project.id;

    const agentName = 'arch_overlay_val_agent';
    log(`Creating agent ${agentName}...`);
    await createAgent(baseUrl, accessToken, projectId, {
      name: agentName,
      dslContent: buildStaticAgentDsl(agentName, 'Arch overlay validation fixture ready.'),
    });

    log('Bootstrapping browser session...');
    await bootstrapStudioBrowserSession(page, baseUrl, {
      accessToken,
      refreshToken,
      tenantId,
      landingPath: `/projects/${encodeURIComponent(projectId)}`,
    });
    await page.waitForTimeout(5_000);
    await waitForIdle(page, 1_500);

    const results = [];

    for (const theme of THEMES) {
      log(`--- Theme: ${theme} ---`);
      await forceTheme(page, theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3_000);
      await waitForIdle(page, 1_000);

      // Capture the project overview (closed overlay)
      await artifacts.captureScreenshot(`${theme}/arch-overlay-closed.png`);
      log(`[${theme}] Captured closed state`);

      // Open the Arch overlay by clicking the Arch toggle button (aria-label="Toggle Arch")
      const archBtn = page.locator('[aria-label="Toggle Arch"]').first();

      let opened = false;
      try {
        await archBtn.click({ timeout: 5_000 });
        opened = true;
      } catch {
        log(`[${theme}] Could not find Arch toggle button`);
      }

      if (!opened) {
        log(`[${theme}] SKIP: could not open Arch overlay`);
        results.push({ theme, surface: 'arch-overlay-open', status: 'skipped' });
        continue;
      }

      // Wait for overlay to appear
      await page.waitForTimeout(2_000);
      await waitForIdle(page, 1_000);

      // Capture the open overlay (SmartWelcome state)
      await artifacts.captureScreenshot(`${theme}/arch-overlay-open.png`);
      log(`[${theme}] Captured open overlay`);
      results.push({ theme, surface: 'arch-overlay-open', status: 'ok' });

      // Close the overlay with Escape key
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    const summary = {
      themes: THEMES,
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      results,
    };
    log(`Capture summary: ${JSON.stringify(summary, null, 2)}`);
    return {
      summary: `${summary.ok}/${summary.total} arch overlay captures ok`,
      metadata: summary,
    };
  },
};
