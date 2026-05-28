import { test, expect, type Page } from '@playwright/test';
import {
  REQUEST_TIMEOUT_MS,
  STRICT_BROWSER_E2E,
  attachSdkWebSocketProbe,
  bootstrapProjectPreviewContext,
  bootstrapPreviewShareContext,
  browserDevLogin,
  checkSdkBrowserPrerequisites,
  expectSdkFrameSent,
  expectSdkSessionStart,
} from './helpers/sdk-browser-e2e';

async function openSharePreviewWidget(page: Page): Promise<void> {
  const launcher = page.getByTestId('share-preview-widget-launcher');
  await expect(launcher).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
  await launcher.click();
  await expect(page.getByTestId('share-preview-widget')).toBeVisible({
    timeout: REQUEST_TIMEOUT_MS,
  });
}

test.describe('SDK preview/share browser E2E', () => {
  test('renders preview widget from share URL and supports in-browser chat send', async ({
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
    const { projectName, shareUrl } = await bootstrapPreviewShareContext(request);

    await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });

    await expect.poll(() => page.url().includes('share_token'), { timeout: 15_000 }).toBe(false);
    await openSharePreviewWidget(page);
    await expectSdkSessionStart(sdkProbe);

    const messageInput = page.getByRole('textbox');
    await expect(messageInput).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
    await expect(messageInput).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });

    const messageText = `Browser preview says hello ${Date.now()}`;
    await messageInput.fill(messageText);
    await messageInput.press('Enter');

    await expect(page.getByText(messageText, { exact: true })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expectSdkFrameSent(sdkProbe, 'chat_message');
  });

  test('keeps a single SDK WebSocket session alive across preview mode toggles', async ({
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
      keyPermissions: {
        chat: true,
        voice: true,
      },
      widgetConfig: {
        mode: 'unified',
        chatEnabled: true,
        voiceEnabled: true,
      },
    });

    await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });

    await expect.poll(() => page.url().includes('share_token'), { timeout: 15_000 }).toBe(false);
    await openSharePreviewWidget(page);
    await expectSdkSessionStart(sdkProbe);
    await expect.poll(() => sdkProbe.urls.length, { timeout: REQUEST_TIMEOUT_MS }).toBe(1);

    const messageInputs = page.getByRole('textbox');
    const voiceModeButton = page.getByTitle('Voice mode');
    const chatModeButton = page.getByTitle('Chat mode');

    await expect(messageInputs).toHaveCount(1, { timeout: REQUEST_TIMEOUT_MS });
    await expect(messageInputs).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });
    await expect(voiceModeButton).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });

    await voiceModeButton.click();
    await expect(messageInputs).toHaveCount(0, { timeout: REQUEST_TIMEOUT_MS });
    await expect.poll(() => sdkProbe.urls.length, { timeout: 5_000 }).toBe(1);

    await chatModeButton.click();
    await expect(messageInputs).toHaveCount(1, { timeout: REQUEST_TIMEOUT_MS });
    await expect(messageInputs).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });
    await expect.poll(() => sdkProbe.urls.length, { timeout: 5_000 }).toBe(1);
    await expect
      .poll(
        () =>
          sdkProbe.receivedFrames.filter((frame) => frame.includes('"type":"session_start"'))
            .length,
        { timeout: 5_000 },
      )
      .toBe(1);

    const continuityMessage = `Mode toggle continuity ${Date.now()}`;
    await messageInputs.first().fill(continuityMessage);
    await messageInputs.first().press('Enter');
    await expect(page.getByText(continuityMessage, { exact: true })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expectSdkFrameSent(sdkProbe, 'chat_message');
    await expect.poll(() => sdkProbe.urls.length, { timeout: 5_000 }).toBe(1);
  });

  test('clamps unsupported voice mode query to chat when the shared widget does not allow voice', async ({
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
    const { shareUrl } = await bootstrapPreviewShareContext(request);
    const clampedShareUrl = shareUrl.includes('#')
      ? shareUrl.replace('#', '?mode=voice#')
      : `${shareUrl}?mode=voice`;

    await page.goto(clampedShareUrl, {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT_MS,
    });

    await expect.poll(() => page.url().includes('share_token'), { timeout: 15_000 }).toBe(false);
    await openSharePreviewWidget(page);
    await expectSdkSessionStart(sdkProbe);

    const messageInput = page.getByRole('textbox');
    await expect(messageInput).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
    await expect(messageInput).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });
    await expect(page.locator('button[title="Voice mode"]')).toHaveCount(0);

    const messageText = `Clamped preview ${Date.now()}`;
    await messageInput.fill(messageText);
    await messageInput.press('Enter');

    await expect(page.getByText(messageText, { exact: true })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expectSdkFrameSent(sdkProbe, 'chat_message');
  });

  test('clamps unsupported voice mode requests back to chat for chat-only share links', async ({
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
    const { projectName, shareUrl } = await bootstrapPreviewShareContext(request);
    const previewUrl = new URL(shareUrl);
    previewUrl.searchParams.set('mode', 'voice');

    await page.goto(previewUrl.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expect.poll(() => page.url().includes('share_token'), { timeout: 15_000 }).toBe(false);
    await openSharePreviewWidget(page);
    await expectSdkSessionStart(sdkProbe);

    const messageInput = page.getByRole('textbox');
    await expect(messageInput).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
    await expect(messageInput).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });
    await expect(page.getByTitle('Voice mode')).toHaveCount(0);
  });

  test('loads the authenticated project preview page and sends chat only after the SDK session is ready', async ({
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
    const { projectId, projectName, ownerEmail } = await bootstrapProjectPreviewContext(request);

    await browserDevLogin(page, {
      email: ownerEmail,
      name: 'SDK Project Preview Browser',
    });

    await page.goto(`/preview/${projectId}`, {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expectSdkSessionStart(sdkProbe);

    const messageInput = page.getByRole('textbox');
    await expect(messageInput).toBeVisible({ timeout: REQUEST_TIMEOUT_MS });
    await expect(messageInput).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });

    const messageText = `Authenticated preview ${Date.now()}`;
    await messageInput.fill(messageText);
    await messageInput.press('Enter');

    await expect(page.getByText(messageText, { exact: true })).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expectSdkFrameSent(sdkProbe, 'chat_message');
  });
});
