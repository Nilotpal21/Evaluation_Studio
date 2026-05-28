import { test, expect } from '@playwright/test';
import {
  REQUEST_TIMEOUT_MS,
  STRICT_BROWSER_E2E,
  SDK_BROWSER_VALIDATION_AGENT,
  SDK_BROWSER_VALIDATION_READY_MESSAGE,
  attachSdkWebSocketProbe,
  bootstrapWidgetContext,
  checkSdkBrowserPrerequisites,
  expectSdkFrameSent,
  expectSdkSessionStart,
  sdkBrowserValidationReply,
} from './helpers/sdk-browser-e2e';

const DEFAULT_REACT_SDK_HOST_URL =
  'http://127.0.0.1:4174/.codex-artifacts/ui-validation/react-sdk-host.html';

test('react AgentProvider + hooks host connects and sends chat through the runtime', async ({
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
  const widgetContext = await bootstrapWidgetContext(request, {
    entryAgent: SDK_BROWSER_VALIDATION_AGENT,
  });
  const hostUrl = new URL(process.env.REACT_SDK_HOST_URL ?? DEFAULT_REACT_SDK_HOST_URL);
  hostUrl.searchParams.set('projectId', widgetContext.projectId);
  hostUrl.searchParams.set('apiKey', widgetContext.sdkPublicKey);
  hostUrl.searchParams.set('endpoint', widgetContext.runtimeEndpoint);

  await page.goto(hostUrl.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: REQUEST_TIMEOUT_MS,
  });

  await expect(page.getByRole('heading', { name: 'React SDK Validation Host' })).toBeVisible({
    timeout: REQUEST_TIMEOUT_MS,
  });

  await expectSdkSessionStart(sdkProbe);

  const status = page.getByTestId('react-sdk-status');
  await expect(status).toContainText('connected', {
    timeout: REQUEST_TIMEOUT_MS,
    ignoreCase: true,
  });

  const input = page.locator('#react-sdk-input');
  await expect(input).toBeEnabled({ timeout: REQUEST_TIMEOUT_MS });
  await expect(
    page.getByTestId('react-sdk-messages').getByText(SDK_BROWSER_VALIDATION_READY_MESSAGE),
  ).toBeVisible({
    timeout: REQUEST_TIMEOUT_MS,
  });

  const turnSeed = Date.now();
  for (let index = 0; index < 5; index += 1) {
    const turnNumber = index + 1;
    const messageText = `React SDK validation turn ${turnNumber} ${turnSeed}`;
    await input.fill(messageText);
    await page.locator('#react-sdk-send').click();

    await expect(
      page.getByTestId('react-sdk-messages').getByText(messageText, { exact: true }),
    ).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await expect(
      page
        .getByTestId('react-sdk-messages')
        .getByText(sdkBrowserValidationReply(turnNumber, messageText)),
    ).toBeVisible({
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  await expectSdkFrameSent(sdkProbe, 'chat_message');
});
