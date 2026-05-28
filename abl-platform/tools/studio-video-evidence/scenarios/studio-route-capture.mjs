import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import { createStudioFixture } from '../lib/studio-harness.mjs';
import { bootstrapStudioBrowserSession, waitForIdle } from '../lib/studio-chat.mjs';
import { numberFromInput } from '../lib/utils.mjs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTargetUrl(baseUrl, options) {
  const absoluteUrl = String(options.url ?? options.sessionUrl ?? '').trim();
  if (absoluteUrl) {
    return absoluteUrl;
  }

  const route = String(options.route ?? '').trim();
  if (!route) {
    throw new Error('studio-route-capture requires --url, --session-url, or --route.');
  }

  if (/^https?:\/\//i.test(route)) {
    return route;
  }

  const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
  return new URL(normalizedRoute, baseUrl).toString();
}

async function maybeSelectTab(page, tabLabel) {
  const normalizedTab = String(tabLabel ?? '').trim();
  if (!normalizedTab) {
    return false;
  }

  const exactTabPattern = new RegExp(`^${escapeRegExp(normalizedTab)}$`, 'i');
  const looseTabPattern = new RegExp(`^\\s*${escapeRegExp(normalizedTab)}\\s*$`, 'i');
  const candidates = [
    page.getByRole('tab', { name: exactTabPattern }).first(),
    page.locator('button, [role="tab"]').filter({ hasText: looseTabPattern }).first(),
    page.getByText(normalizedTab, { exact: true }).first(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await candidate.click({ timeout: REQUEST_TIMEOUT_MS });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}

export const scenario = {
  id: 'studio-route-capture',
  title: 'Studio Route Capture',
  description:
    'Captures any Studio route with either a disposable dev-login fixture or a refresh-token plus tenant bootstrap, then records a ready-state screenshot and video.',
  example:
    'pnpm studio:video:evidence -- --scenario studio-route-capture --route /projects --wait-for-selector main',
  async run(context) {
    const { options, page, artifacts, baseUrl } = context;
    const finalPauseMs = numberFromInput(options.finalPauseMs, 2_000);
    const targetUrl = resolveTargetUrl(baseUrl, options);
    const waitForSelector = String(options.waitForSelector ?? '').trim();
    const waitForText = String(options.waitForText ?? '').trim();
    const screenshotName = String(options.screenshotName ?? 'studio-route-ready.png').trim();
    const captureResponsePattern = String(options.captureResponsePattern ?? '').trim();
    const responseCaptures = [];

    const handleResponse = async (response) => {
      if (!captureResponsePattern || !response.url().includes(captureResponsePattern)) {
        return;
      }

      let body = null;
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('application/json')) {
          body = await response.json();
        } else {
          body = (await response.text()).slice(0, 4_000);
        }
      } catch {
        body = '<unreadable>';
      }

      responseCaptures.push({
        url: response.url(),
        status: response.status(),
        body,
      });
    };

    if (captureResponsePattern) {
      page.on('response', handleResponse);
    }

    const refreshToken = String(options.refreshToken ?? '').trim();
    const accessToken = String(options.accessToken ?? '').trim();
    const tenantId = String(options.tenantId ?? '').trim();
    const usesTokenBootstrap = Boolean(refreshToken || accessToken || tenantId);

    const authMetadata = usesTokenBootstrap
      ? await bootstrapStudioBrowserSession(page, baseUrl, {
          accessToken,
          refreshToken,
          tenantId,
        })
      : await createStudioFixture(context, {
          requireProject: false,
          requireAgent: false,
        });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await waitForIdle(page, 1_000);
    const selectedTab = await maybeSelectTab(page, options.tab);

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

    return {
      summary: `Captured the Studio route ${targetUrl} using the reusable route-capture harness.`,
      metadata: {
        targetUrl,
        finalUrl: page.url(),
        authMode: usesTokenBootstrap ? 'token-bootstrap' : 'dev-login',
        selectedTab,
        waitForSelector: waitForSelector || null,
        waitForText: waitForText || null,
        captureResponsePattern: captureResponsePattern || null,
        capturedResponses: responseCaptures,
        ...authMetadata,
      },
      assertions: [
        {
          name: 'route-loaded',
          passed: true,
          details: `Loaded ${page.url()}`,
        },
        ...(waitForSelector
          ? [
              {
                name: 'selector-visible',
                passed: true,
                details: `Observed selector ${waitForSelector}`,
              },
            ]
          : []),
        ...(waitForText
          ? [
              {
                name: 'text-visible',
                passed: true,
                details: `Observed text ${waitForText}`,
              },
            ]
          : []),
      ],
    };
  },
};
