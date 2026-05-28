import { test, expect } from '@playwright/test';
import {
  REQUEST_TIMEOUT_MS,
  STRICT_BROWSER_E2E,
  SDK_BROWSER_VALIDATION_AGENT,
  SDK_BROWSER_VALIDATION_READY_MESSAGE,
  attachSdkWebSocketProbe,
  bootstrapWidgetContext,
  checkSdkBrowserPrerequisites,
  clickWidgetShadowButton,
  expectSdkFrameSent,
  expectSdkSessionStart,
  expectWidgetShadowDisabled,
  expectWidgetShadowEnabled,
  expectWidgetShadowText,
  expectWidgetShadowVisible,
  fillWidgetInputAndSubmit,
  mountWidgetUnderTest,
  sdkBrowserValidationReply,
} from './helpers/sdk-browser-e2e';

test('vanilla SDK widget completes five visible turns with assistant replies', async ({
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

  await mountWidgetUnderTest(page, widgetContext, {
    title: 'Vanilla SDK Widget Validation',
  });

  await expectWidgetShadowVisible(page, 'button.launcher');
  await clickWidgetShadowButton(page, 'button.launcher');

  await expectWidgetShadowVisible(page, '.widget-container');
  await expectWidgetShadowVisible(page, 'input.input-field');
  await expectWidgetShadowDisabled(page, 'input.input-field');
  await expectSdkSessionStart(sdkProbe);
  await expectWidgetShadowEnabled(page, 'input.input-field');
  await expectWidgetShadowText(page, '.message.assistant', SDK_BROWSER_VALIDATION_READY_MESSAGE, {
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  const turnSeed = Date.now();
  for (let index = 0; index < 5; index += 1) {
    const turnNumber = index + 1;
    const userMessage = `Vanilla SDK widget validation turn ${turnNumber} ${turnSeed}`;
    await fillWidgetInputAndSubmit(page, userMessage);
    await expectWidgetShadowText(page, '.message.user', userMessage, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectWidgetShadowText(
      page,
      '.message.assistant',
      sdkBrowserValidationReply(turnNumber, userMessage),
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
  }

  await expectSdkFrameSent(sdkProbe, 'chat_message');
  await expect(page.locator('#sdk-widget-under-test')).toBeVisible({
    timeout: REQUEST_TIMEOUT_MS,
  });
});
