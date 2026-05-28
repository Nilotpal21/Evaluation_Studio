import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import {
  createStudioFixture,
  getStudioSurface,
  openStudioSurface,
} from '../lib/studio-harness.mjs';
import { numberFromInput } from '../lib/utils.mjs';

export const scenario = {
  id: 'studio-surface-capture',
  title: 'Studio Surface Capture',
  description:
    'Creates or reuses a Studio fixture, navigates to a named Studio surface, and records a ready-state screenshot and video without requiring a one-off scenario file.',
  example:
    'pnpm studio:video:evidence -- --surface agent-chat --headed --wait-for-selector "[data-testid=\\"chat-widget\\"]"',
  async run(context) {
    const { options, artifacts, page } = context;
    const surfaceId = String(options.surface ?? 'agent-chat').trim() || 'agent-chat';
    const surface = getStudioSurface(surfaceId);
    if (!surface) {
      throw new Error(`Unknown Studio surface "${surfaceId}".`);
    }

    const waitForSelector = String(options.waitForSelector ?? '').trim();
    const waitForText = String(options.waitForText ?? '').trim();
    const screenshotName = String(options.screenshotName ?? `${surface.id}-ready.png`).trim();
    const finalPauseMs = numberFromInput(options.finalPauseMs, 2_000);
    const fixture = await createStudioFixture(context, {
      requireProject: surface.requiresProject,
      requireAgent: surface.requiresAgent,
      assistantReply: String(
        options.assistantReply ??
          'Acknowledged. The reusable Studio surface capture fixture is ready.',
      ).trim(),
    });
    const navigation = await openStudioSurface(context, surface, fixture);

    if (waitForSelector) {
      await page.locator(waitForSelector).first().waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });
    }

    if (waitForText) {
      await page.getByText(waitForText, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });
    }

    await artifacts.captureScreenshot(screenshotName);
    await page.waitForTimeout(finalPauseMs);

    const assertions = [
      {
        name: 'surface-ready',
        passed: true,
        details: `Loaded ${surface.title} at ${navigation.route}`,
      },
    ];

    if (waitForSelector) {
      assertions.push({
        name: 'surface-selector-visible',
        passed: true,
        details: `Observed selector ${waitForSelector}`,
      });
    }

    if (waitForText) {
      assertions.push({
        name: 'surface-text-visible',
        passed: true,
        details: `Observed text ${waitForText}`,
      });
    }

    return {
      summary: `Captured the ${surface.title} Studio surface using the reusable launch and navigation harness.`,
      metadata: {
        surfaceId: surface.id,
        route: navigation.route,
        projectId: fixture.projectId ?? null,
        projectName: fixture.projectName ?? null,
        agentName: fixture.agentName ?? null,
        email: fixture.email,
        waitForSelector: waitForSelector || null,
        waitForText: waitForText || null,
      },
      assertions,
    };
  },
};
