import { test, expect } from '@playwright/test';
import {
  REQUEST_TIMEOUT_MS,
  STRICT_BROWSER_E2E,
  SDK_BROWSER_VALIDATION_AGENT,
  SDK_BROWSER_VALIDATION_READY_MESSAGE,
  attachSdkWebSocketProbe,
  bootstrapPreviewShareContext,
  checkSdkBrowserPrerequisites,
  expectSdkFrameSent,
  expectSdkSessionStart,
  sdkBrowserValidationReply,
} from './helpers/sdk-browser-e2e';

test('hosted preview establishes a session after opening the launcher and supports chat send', async ({
  page,
  request,
}) => {
  const prerequisites = await checkSdkBrowserPrerequisites(request);
  if (!prerequisites.ok) {
    if (STRICT_BROWSER_E2E) {
      throw new Error(prerequisites.reason);
    }
    test.skip(true, prerequisites.reason);
  }

  const sdkProbe = attachSdkWebSocketProbe(page);
  const { projectName, shareUrl } = await bootstrapPreviewShareContext(request, {
    entryAgent: SDK_BROWSER_VALIDATION_AGENT,
  });

  await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible({
    timeout: REQUEST_TIMEOUT_MS,
  });

  const launcher = page.locator('button').last();
  await expect(launcher).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
  await launcher.click();

  await expectSdkSessionStart(sdkProbe);

  const messageInput = page.getByRole('textbox').first();
  await expect(messageInput).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
  await expect(messageInput).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });
  await expect(page.getByText(SDK_BROWSER_VALIDATION_READY_MESSAGE)).toBeVisible({
    timeout: REQUEST_TIMEOUT_MS,
  });

  const turnSeed = Date.now();
  for (let index = 0; index < 5; index += 1) {
    const turnNumber = index + 1;
    const messageText = `Hosted preview validation turn ${turnNumber} ${turnSeed}`;
    await messageInput.fill(messageText);
    await messageInput.press('Enter');

    await expect(page.getByText(messageText, { exact: true })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expect(page.getByText(sdkBrowserValidationReply(turnNumber, messageText))).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  await expectSdkFrameSent(sdkProbe, 'chat_message');
});
