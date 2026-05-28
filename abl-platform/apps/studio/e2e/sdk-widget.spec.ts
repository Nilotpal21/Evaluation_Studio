import { test, expect } from '@playwright/test';
import {
  REQUEST_TIMEOUT_MS,
  STRICT_BROWSER_E2E,
  attachSdkWebSocketProbe,
  bootstrapWidgetContext,
  clickWidgetShadowButton,
  checkSdkBrowserPrerequisites,
  expectSdkFrameSent,
  expectSdkSessionStart,
  expectWidgetShadowAbsent,
  expectWidgetShadowDisabled,
  expectWidgetShadowEnabled,
  expectWidgetShadowText,
  expectWidgetShadowVisible,
  fillWidgetInputAndSubmit,
  mountWidgetUnderTest,
  selectWidgetShadowOption,
} from './helpers/sdk-browser-e2e';

interface WidgetElementLike extends Element {
  getSDK?: () => {
    getSessionId?: () => string | null;
  };
}

const CHANNEL_NATIVE_FALLBACK_AGENT_NAME = 'sdk_widget_fallback_agent';
const CHANNEL_NATIVE_FALLBACK_SUMMARY = 'Approval required • Approve invoice INV-42';
const ACTION_BUTTON_AGENT_NAME = 'sdk_widget_action_button_agent';
const ACTION_SELECT_AGENT_NAME = 'sdk_widget_action_select_agent';
const ABLP_376_WIDGET_AUTH_AGENT_NAME = 'sdk_widget_ablp_376_auth_agent';
const CHANNEL_NATIVE_FALLBACK_DSL = `
AGENT: ${CHANNEL_NATIVE_FALLBACK_AGENT_NAME}
GOAL: "Emit channel-native content for browser fallback coverage"
PERSONA: "Test"

FLOW:
  welcome:
    REASONING: false
    RESPOND: ""
      FORMATS:
        SLACK: |
          {
            "blocks": [
              {
                "type": "header",
                "text": {
                  "type": "plain_text",
                  "text": "Approval required"
                }
              },
              {
                "type": "section",
                "text": {
                  "type": "plain_text",
                  "text": "Approve invoice INV-42"
                }
              }
            ]
          }
    THEN: COMPLETE
`;

const ACTION_BUTTON_DSL = `
AGENT: ${ACTION_BUTTON_AGENT_NAME}
GOAL: "Exercise button action round-trips in the SDK widget"
PERSONA: "Test"

FLOW:
  welcome:
    REASONING: false
    RESPOND: "Review this request"
      ACTIONS:
        - BUTTON: "Approve" -> approve
    ON_ACTION:
      approve:
        RESPOND: "Approval recorded."
        TRANSITION: done
  done:
    REASONING: false
    RESPOND: "All set."
    THEN: COMPLETE
`;

const ACTION_SELECT_DSL = `
AGENT: ${ACTION_SELECT_AGENT_NAME}
GOAL: "Exercise select action round-trips in the SDK widget"
PERSONA: "Test"

FLOW:
  welcome:
    REASONING: false
    RESPOND: "Pick a color"
      ACTIONS:
        - SELECT: "Color"
          OPTIONS:
            - "Red" -> red
            - "Blue" -> blue
    ON_ACTION:
      color:
        RESPOND: "Selection recorded."
        TRANSITION: done
  done:
    REASONING: false
    RESPOND: "Thanks for choosing."
    THEN: COMPLETE
`;

const ABLP_376_WIDGET_AUTH_DSL = `
AGENT: ${ABLP_376_WIDGET_AUTH_AGENT_NAME}
GOAL: "Exercise repeated identical widget turns across lockout flow"
PERSONA: "Test"

FLOW:
  entry_point: init_auth
  steps:
    - init_auth
    - ask_pin
    - verify_pin
    - auth_fail
    - locked

init_auth:
  REASONING: false
  SET: auth_attempts = 0
  RESPOND: "Let's verify your PIN. attempts={{auth_attempts}}"
  THEN: ask_pin

ask_pin:
  REASONING: false
  SET: pin = ""
  GATHER:
    - pin:
        type: string
        required: true
        prompt: "Enter your PIN."
  THEN: verify_pin

verify_pin:
  REASONING: false
  CHECK: pin == "1234"
  ON_FAIL: auth_fail
  RESPOND: "PIN accepted."
  THEN: COMPLETE

auth_fail:
  REASONING: false
  SET: auth_attempts = auth_attempts + 1
  CHECK: auth_attempts < 2
  ON_FAIL: locked
  RESPOND: "PIN mismatch. Attempts={{auth_attempts}}. Try again."
  THEN: ask_pin

locked:
  REASONING: false
  RESPOND: "Account locked after 2 attempts."
  THEN: COMPLETE
`;

test.describe('SDK widget browser E2E', () => {
  test('loads UMD widget bundle, connects through Runtime, and supports in-browser chat send', async ({
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
    const widgetContext = await bootstrapWidgetContext(request);

    await mountWidgetUnderTest(page, widgetContext, {
      title: 'SDK Widget Browser E2E',
    });

    await expectWidgetShadowVisible(page, 'button.launcher');
    await clickWidgetShadowButton(page, 'button.launcher');

    await expectWidgetShadowVisible(page, '.widget-container');
    await expectWidgetShadowVisible(page, 'input.input-field');
    await expectWidgetShadowDisabled(page, 'input.input-field');
    await expectSdkSessionStart(sdkProbe);
    await expectWidgetShadowEnabled(page, 'input.input-field');

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const widget = document.getElementById(
              'sdk-widget-under-test',
            ) as WidgetElementLike | null;
            return widget?.getSDK?.()?.getSessionId?.() ?? null;
          }),
        { timeout: REQUEST_TIMEOUT_MS },
      )
      .not.toBeNull();

    const userMessage = `Widget browser e2e ${Date.now()}`;
    await fillWidgetInputAndSubmit(page, userMessage);
    await expectWidgetShadowText(page, '.message.user', userMessage, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectSdkFrameSent(sdkProbe, 'chat_message');
  });

  test('renders channel-native rich content fallback instead of a blank assistant turn', async ({
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
      entryAgent: {
        name: CHANNEL_NATIVE_FALLBACK_AGENT_NAME,
        dslContent: CHANNEL_NATIVE_FALLBACK_DSL,
        description: 'SDK widget browser fallback coverage',
      },
    });

    await mountWidgetUnderTest(page, widgetContext, {
      title: 'SDK Widget Browser E2E Fallback Rendering',
    });

    await expectWidgetShadowVisible(page, 'button.launcher');
    await clickWidgetShadowButton(page, 'button.launcher');

    await expectWidgetShadowVisible(page, '.widget-container');
    await expectWidgetShadowVisible(page, 'input.input-field');
    await expectWidgetShadowDisabled(page, 'input.input-field');
    await expectSdkSessionStart(sdkProbe);
    await expectWidgetShadowEnabled(page, 'input.input-field');

    await expect
      .poll(
        () =>
          sdkProbe.receivedFrames.some(
            (frame) =>
              frame.includes('Approval required') && frame.includes('Approve invoice INV-42'),
          ),
        { timeout: REQUEST_TIMEOUT_MS },
      )
      .toBe(true);

    await expectWidgetShadowText(page, '.rich-channel-fallback-title', 'Slack Block Kit payload', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectWidgetShadowText(
      page,
      '.rich-channel-fallback-body',
      CHANNEL_NATIVE_FALLBACK_SUMMARY,
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
  });

  test('routes button actions through action_submit and renders the follow-up response', async ({
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
      entryAgent: {
        name: ACTION_BUTTON_AGENT_NAME,
        dslContent: ACTION_BUTTON_DSL,
        description: 'SDK widget browser action button coverage',
      },
    });

    await mountWidgetUnderTest(page, widgetContext, {
      title: 'SDK Widget Browser E2E Button Actions',
    });

    await expectWidgetShadowVisible(page, 'button.launcher');
    await clickWidgetShadowButton(page, 'button.launcher');

    await expectWidgetShadowVisible(page, '.widget-container');
    await expectWidgetShadowVisible(page, 'input.input-field');
    await expectWidgetShadowDisabled(page, 'input.input-field');
    await expectSdkSessionStart(sdkProbe);
    await expectWidgetShadowEnabled(page, 'input.input-field');

    await expectWidgetShadowText(page, '.message.assistant', 'Review this request', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectWidgetShadowText(page, '.rich-btn', 'Approve', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    await clickWidgetShadowButton(page, '.rich-actions .rich-btn');

    await expect
      .poll(
        () =>
          sdkProbe.sentFrames.some(
            (frame) =>
              frame.includes('"type":"action_submit"') && frame.includes('"actionId":"approve"'),
          ),
        { timeout: REQUEST_TIMEOUT_MS },
      )
      .toBe(true);

    await expectWidgetShadowText(page, '.message.assistant', 'Approval recorded.', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectWidgetShadowText(page, '.message.assistant', 'All set.', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  });

  test('routes select actions through action_submit with the selected value', async ({
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
      entryAgent: {
        name: ACTION_SELECT_AGENT_NAME,
        dslContent: ACTION_SELECT_DSL,
        description: 'SDK widget browser action select coverage',
      },
    });

    await mountWidgetUnderTest(page, widgetContext, {
      title: 'SDK Widget Browser E2E Select Actions',
    });

    await expectWidgetShadowVisible(page, 'button.launcher');
    await clickWidgetShadowButton(page, 'button.launcher');

    await expectWidgetShadowVisible(page, '.widget-container');
    await expectWidgetShadowVisible(page, 'input.input-field');
    await expectWidgetShadowDisabled(page, 'input.input-field');
    await expectSdkSessionStart(sdkProbe);
    await expectWidgetShadowEnabled(page, 'input.input-field');

    await expectWidgetShadowText(page, '.message.assistant', 'Pick a color', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectWidgetShadowVisible(page, '.rich-select', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    await selectWidgetShadowOption(page, '.rich-select', 'blue');

    await expect
      .poll(
        () =>
          sdkProbe.sentFrames.some(
            (frame) =>
              frame.includes('"type":"action_submit"') &&
              frame.includes('"actionId":"color"') &&
              frame.includes('"value":"blue"'),
          ),
        { timeout: REQUEST_TIMEOUT_MS },
      )
      .toBe(true);

    await expectWidgetShadowText(page, '.message.assistant', 'Selection recorded.', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectWidgetShadowText(page, '.message.assistant', 'Thanks for choosing.', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  });

  test('clamps a unified embed snippet down to chat when voice capability is disabled', async ({
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
      widgetConfig: {
        mode: 'unified',
        chatEnabled: true,
        voiceEnabled: false,
      },
    });

    await mountWidgetUnderTest(page, widgetContext, {
      title: 'SDK Widget Browser E2E Capability Clamp',
    });

    await expectWidgetShadowVisible(page, 'button.launcher');
    await clickWidgetShadowButton(page, 'button.launcher');

    await expectWidgetShadowVisible(page, '.widget-container');
    await expectWidgetShadowVisible(page, 'input.input-field');
    await expectWidgetShadowDisabled(page, 'input.input-field');
    await expectSdkSessionStart(sdkProbe);
    await expectWidgetShadowEnabled(page, 'input.input-field');
    await expectWidgetShadowAbsent(page, '.mode-toggle');
  });

  test('repeated identical widget turns stay distinct and reach lockout on the second failure', async ({
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
      entryAgent: {
        name: ABLP_376_WIDGET_AUTH_AGENT_NAME,
        dslContent: ABLP_376_WIDGET_AUTH_DSL,
        description: 'SDK widget ABLP-376 regression coverage',
      },
    });

    await mountWidgetUnderTest(page, widgetContext, {
      title: 'SDK Widget Browser E2E ABLP-376',
    });

    await expectWidgetShadowVisible(page, 'button.launcher');
    await clickWidgetShadowButton(page, 'button.launcher');

    await expectWidgetShadowVisible(page, '.widget-container');
    await expectWidgetShadowVisible(page, 'input.input-field');
    await expectWidgetShadowDisabled(page, 'input.input-field');
    await expectSdkSessionStart(sdkProbe);
    await expectWidgetShadowEnabled(page, 'input.input-field');

    await expectWidgetShadowText(page, '.widget-container', "Let's verify your PIN. attempts=0", {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    await expectWidgetShadowText(page, '.widget-container', 'Enter your PIN.', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    await fillWidgetInputAndSubmit(page, '9999');
    await expectWidgetShadowText(
      page,
      '.widget-container',
      'PIN mismatch. Attempts=1. Try again.',
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );

    await fillWidgetInputAndSubmit(page, '9999');
    await expectWidgetShadowText(page, '.widget-container', 'Account locked after 2 attempts.', {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    await expect
      .poll(
        () => sdkProbe.sentFrames.filter((frame) => frame.includes('"type":"chat_message"')).length,
        { timeout: REQUEST_TIMEOUT_MS },
      )
      .toBeGreaterThanOrEqual(2);

    const chatMessages = sdkProbe.sentFrames
      .filter((frame) => frame.includes('"type":"chat_message"'))
      .map((frame) => JSON.parse(frame) as { type: string; text?: string; messageId?: string });

    const repeatedPinFrames = chatMessages.filter((frame) => frame.text === '9999');
    expect(repeatedPinFrames).toHaveLength(2);
    expect(repeatedPinFrames[0]?.messageId).toMatch(/^msg_/);
    expect(repeatedPinFrames[1]?.messageId).toMatch(/^msg_/);
    expect(new Set(repeatedPinFrames.map((frame) => frame.messageId)).size).toBe(2);
  });
});
