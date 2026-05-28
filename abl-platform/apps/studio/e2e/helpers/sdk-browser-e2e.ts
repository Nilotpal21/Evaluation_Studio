import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { getSdkBrowserRuntimeBaseUrl, getSdkBrowserStudioBaseUrl } from './sdk-browser-env';

export const STUDIO_BASE_URL = getSdkBrowserStudioBaseUrl();
export const RUNTIME_BASE_URL = getSdkBrowserRuntimeBaseUrl();
export const REQUEST_TIMEOUT_MS = 60_000;
export const STRICT_BROWSER_E2E = process.env.SDK_BROWSER_E2E_STRICT === 'true';
const SDK_BROWSER_E2E_HOST_PATH = '/sdk-browser-e2e-host.html';

interface RuntimeHealthResponse {
  status?: string;
}

const ACCEPTED_RUNTIME_HEALTH_STATUSES = new Set(['ok', 'healthy']);

interface DevLoginResponse {
  accessToken: string;
}

interface CreateProjectResponse {
  success: boolean;
  project: {
    id: string;
    name: string;
    slug: string;
  };
}

interface CreateShareResponse {
  token: string;
  shareUrl: string;
  projectId: string;
  projectName: string;
}

interface CreateSdkKeyResponse {
  id: string;
  keyPrefix: string;
  name: string;
  key: string;
}

interface CreateSdkChannelResponse {
  success: boolean;
  channel: {
    id: string;
    name: string;
    publicApiKeyId: string;
  };
}

interface EmbedSnippetResponse {
  snippet: string;
  config: {
    projectId: string;
    channelId: string | null;
    channelName: string | null;
    mode: 'chat' | 'voice' | 'unified';
    position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    theme: Record<string, string>;
    welcomeMessage?: string;
    placeholderText?: string;
    voiceEnabled: boolean;
    chatEnabled: boolean;
  };
  sdkUrl: string;
  runtimeEndpoint: string;
}

interface UpdateWidgetConfigRequest {
  channelId?: string | null;
  mode?: 'chat' | 'voice' | 'unified';
  chatEnabled?: boolean;
  voiceEnabled?: boolean;
}

interface SDKKeyPermissions {
  chat: boolean;
  voice: boolean;
}

export interface BrowserEntryAgent {
  name: string;
  dslContent: string;
  description?: string;
}

export interface PreviewShareContext {
  projectId: string;
  projectName: string;
  shareUrl: string;
}

export interface ProjectPreviewContext {
  projectId: string;
  projectName: string;
  ownerEmail: string;
}

export interface WidgetContext {
  projectId: string;
  projectName: string;
  sdkPublicKey: string;
  embedSnippet: string;
  config: EmbedSnippetResponse['config'];
  sdkUrl: string;
  runtimeEndpoint: string;
}

export interface BootstrapWidgetContextOptions {
  entryAgent?: BrowserEntryAgent;
  widgetConfig?: UpdateWidgetConfigRequest;
}

export interface BootstrapPreviewShareContextOptions {
  widgetConfig?: UpdateWidgetConfigRequest;
  keyPermissions?: SDKKeyPermissions;
  entryAgent?: BrowserEntryAgent;
}

export interface BootstrapProjectPreviewContextOptions {
  widgetConfig?: UpdateWidgetConfigRequest;
  entryAgent?: BrowserEntryAgent;
}

export interface SdkWebSocketProbe {
  urls: string[];
  receivedFrames: string[];
  sentFrames: string[];
}

const DEFAULT_SDK_KEY_PERMISSIONS: SDKKeyPermissions = {
  chat: true,
  voice: false,
};

export const SDK_BROWSER_VALIDATION_READY_MESSAGE = 'SDK browser validation ready.';
export const SDK_BROWSER_VALIDATION_AGENT_NAME = 'sdk_browser_multiturn_validation_agent';
export const SDK_BROWSER_VALIDATION_AGENT: BrowserEntryAgent = {
  name: SDK_BROWSER_VALIDATION_AGENT_NAME,
  description: 'SDK browser validation multi-turn fixture',
  dslContent: `
AGENT: ${SDK_BROWSER_VALIDATION_AGENT_NAME}
GOAL: "Validate five-turn browser SDK conversations"
PERSONA: "Regression validation agent"

FLOW:
  entry_point: initialize
  steps:
    - initialize
    - ask
    - respond

initialize:
  REASONING: false
  SET: turn_count = 0
  RESPOND: "${SDK_BROWSER_VALIDATION_READY_MESSAGE}"
  THEN: ask

ask:
  REASONING: false
  SET: user_message = ""
  GATHER:
    - user_message:
        type: string
        required: true
        prompt: "Share your next validation message."
  THEN: respond

respond:
  REASONING: false
  SET: turn_count = turn_count + 1
  RESPOND: "SDK browser validation turn {{turn_count}} received: {{user_message}}"
  THEN: ask
`,
};

export function sdkBrowserValidationReply(turnNumber: number, userMessage: string): string {
  return `SDK browser validation turn ${turnNumber} received: ${userMessage}`;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLocalOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.hostname === '127.0.0.1') {
    parsed.hostname = 'localhost';
  }
  return parsed.origin;
}

async function parseJsonBody<T>(response: APIResponse): Promise<T> {
  const bodyText = await response.text();
  return JSON.parse(bodyText) as T;
}

export async function checkSdkBrowserPrerequisites(
  request: APIRequestContext,
): Promise<{ ok: boolean; reason?: string }> {
  const studioHealth = await request
    .get(`${STUDIO_BASE_URL}/auth/login`, { timeout: 10_000 })
    .catch(() => null);
  if (!studioHealth || !studioHealth.ok()) {
    return {
      ok: false,
      reason: `Studio must be reachable for browser E2E (${STUDIO_BASE_URL}/auth/login)`,
    };
  }

  const runtimeHealth = await request
    .get(`${RUNTIME_BASE_URL}/health`, { timeout: 10_000 })
    .catch(() => null);
  if (!runtimeHealth || !runtimeHealth.ok()) {
    return {
      ok: false,
      reason: `Runtime must be reachable for browser E2E (${RUNTIME_BASE_URL}/health)`,
    };
  }

  const runtimeHealthBody = await parseJsonBody<RuntimeHealthResponse>(runtimeHealth);
  if (!ACCEPTED_RUNTIME_HEALTH_STATUSES.has(runtimeHealthBody.status ?? '')) {
    return {
      ok: false,
      reason: `Runtime health endpoint returned unsupported status (${JSON.stringify(runtimeHealthBody)})`,
    };
  }

  return { ok: true };
}

async function devLogin(
  request: APIRequestContext,
  emailPrefix: string,
  options: {
    email?: string;
  } = {},
): Promise<{ accessToken: string; email: string }> {
  const email = options.email?.trim() || `${emailPrefix}-${uniqueSuffix()}@e2e-smoke.test`;
  const loginResponse = await request.post(`${STUDIO_BASE_URL}/api/auth/dev-login`, {
    data: {
      email,
      name: `SDK Browser E2E ${uniqueSuffix()}`,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (loginResponse.status() === 404) {
    throw new Error(
      'Studio dev-login is disabled (ENABLE_DEV_LOGIN must be true for SDK browser E2E bootstrap).',
    );
  }

  expect(loginResponse.ok()).toBe(true);
  const loginBody = await parseJsonBody<DevLoginResponse>(loginResponse);
  expect(typeof loginBody.accessToken).toBe('string');
  return { accessToken: loginBody.accessToken, email };
}

async function createProject(
  request: APIRequestContext,
  accessToken: string,
  namePrefix: string,
  slugPrefix: string,
): Promise<{ id: string; name: string; slug: string }> {
  const suffix = uniqueSuffix();
  const createProjectResponse = await request.post(`${STUDIO_BASE_URL}/api/projects`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      name: `${namePrefix} ${suffix}`,
      slug: `${slugPrefix}-${suffix}`,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  expect(createProjectResponse.status()).toBe(201);
  const createProjectBody = await parseJsonBody<CreateProjectResponse>(createProjectResponse);
  expect(createProjectBody.success).toBe(true);

  return {
    id: createProjectBody.project.id,
    name: createProjectBody.project.name,
    slug: createProjectBody.project.slug,
  };
}

async function createSdkKey(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  namePrefix: string,
  permissions: SDKKeyPermissions = DEFAULT_SDK_KEY_PERMISSIONS,
): Promise<CreateSdkKeyResponse> {
  const createKeyResponse = await request.post(`${STUDIO_BASE_URL}/api/sdk/keys`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      projectId,
      name: `${namePrefix} ${uniqueSuffix()}`,
      permissions,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  expect(createKeyResponse.status()).toBe(201);
  const keyBody = await parseJsonBody<CreateSdkKeyResponse>(createKeyResponse);
  expect(typeof keyBody.key).toBe('string');
  expect(keyBody.key.startsWith('pk_')).toBe(true);
  return keyBody;
}

async function createSdkBootstrapChannel(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  publicApiKeyId: string,
  name: string,
): Promise<CreateSdkChannelResponse['channel']> {
  const createChannelResponse = await request.post(
    `${STUDIO_BASE_URL}/api/runtime/sdk-channels?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        name,
        channelType: 'web',
        publicApiKeyId,
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  expect(createChannelResponse.status()).toBe(201);
  const channelBody = await parseJsonBody<CreateSdkChannelResponse>(createChannelResponse);
  expect(channelBody.success).toBe(true);
  expect(channelBody.channel.publicApiKeyId).toBe(publicApiKeyId);
  return channelBody.channel;
}

async function updateWidgetConfig(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  config: UpdateWidgetConfigRequest,
): Promise<void> {
  const updateWidgetResponse = await request.put(`${STUDIO_BASE_URL}/api/sdk/widget/${projectId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    data: config,
    timeout: REQUEST_TIMEOUT_MS,
  });

  expect(updateWidgetResponse.ok()).toBe(true);
}

async function createProjectAgent(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
  agent: BrowserEntryAgent,
): Promise<void> {
  const createAgentResponse = await request.post(
    `${STUDIO_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/agents`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        name: agent.name,
        agentPath: agent.name,
        description: agent.description ?? `SDK Browser E2E agent ${agent.name}`,
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  expect(createAgentResponse.status()).toBe(201);

  const updateDslResponse = await request.put(
    `${STUDIO_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agent.name)}/dsl`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        dslContent: agent.dslContent,
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  expect(updateDslResponse.status()).toBe(200);

  const updateProjectResponse = await request.patch(
    `${STUDIO_BASE_URL}/api/projects/${encodeURIComponent(projectId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        entryAgentName: agent.name,
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  expect(updateProjectResponse.status()).toBe(200);
}

export async function bootstrapPreviewShareContext(
  request: APIRequestContext,
  options: BootstrapPreviewShareContextOptions = {},
): Promise<PreviewShareContext> {
  const login = await devLogin(request, 'sdk-preview-browser');
  const project = await createProject(
    request,
    login.accessToken,
    'SDK Preview Browser',
    'sdk-preview',
  );
  if (options.entryAgent) {
    await createProjectAgent(request, login.accessToken, project.id, options.entryAgent);
  }
  const key = await createSdkKey(
    request,
    login.accessToken,
    project.id,
    'SDK Preview Key',
    options.keyPermissions ?? DEFAULT_SDK_KEY_PERMISSIONS,
  );
  const channel = await createSdkBootstrapChannel(
    request,
    login.accessToken,
    project.id,
    key.id,
    'preview-default',
  );

  await updateWidgetConfig(request, login.accessToken, project.id, {
    channelId: channel.id,
    chatEnabled: true,
    voiceEnabled: false,
    ...options.widgetConfig,
  });

  const createShareResponse = await request.post(`${STUDIO_BASE_URL}/api/sdk/share`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      projectId: project.id,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  expect(createShareResponse.status()).toBe(200);
  const createShareBody = await parseJsonBody<CreateShareResponse>(createShareResponse);
  expect(createShareBody.projectId).toBe(project.id);
  expect(createShareBody.projectName).toBe(project.name);
  expect(createShareBody.shareUrl).toContain('#share_token=');
  expect(createShareBody.shareUrl).not.toContain('?token=');

  return {
    projectId: project.id,
    projectName: project.name,
    shareUrl: createShareBody.shareUrl,
  };
}

export async function bootstrapProjectPreviewContext(
  request: APIRequestContext,
  options: BootstrapProjectPreviewContextOptions = {},
): Promise<ProjectPreviewContext> {
  const login = await devLogin(request, 'sdk-project-preview-browser');
  const project = await createProject(
    request,
    login.accessToken,
    'SDK Project Preview Browser',
    'sdk-project-preview',
  );
  if (options.entryAgent) {
    await createProjectAgent(request, login.accessToken, project.id, options.entryAgent);
  }
  const key = await createSdkKey(request, login.accessToken, project.id, 'SDK Project Preview Key');
  const channel = await createSdkBootstrapChannel(
    request,
    login.accessToken,
    project.id,
    key.id,
    'project-preview-default',
  );

  await updateWidgetConfig(request, login.accessToken, project.id, {
    channelId: channel.id,
    chatEnabled: true,
    voiceEnabled: false,
    ...options.widgetConfig,
  });

  return {
    projectId: project.id,
    projectName: project.name,
    ownerEmail: login.email,
  };
}

export async function bootstrapWidgetContext(
  request: APIRequestContext,
  options: BootstrapWidgetContextOptions = {},
): Promise<WidgetContext> {
  const login = await devLogin(request, 'sdk-widget-browser');
  const project = await createProject(
    request,
    login.accessToken,
    'SDK Widget Browser',
    'sdk-widget',
  );
  if (options.entryAgent) {
    await createProjectAgent(request, login.accessToken, project.id, options.entryAgent);
  }
  const keyBody = await createSdkKey(request, login.accessToken, project.id, 'SDK Widget Key');
  const channel = await createSdkBootstrapChannel(
    request,
    login.accessToken,
    project.id,
    keyBody.id,
    'default',
  );

  await updateWidgetConfig(request, login.accessToken, project.id, {
    channelId: channel.id,
    chatEnabled: true,
    voiceEnabled: false,
    ...options.widgetConfig,
  });

  const embedResponse = await request.get(`${STUDIO_BASE_URL}/api/sdk/embed/${project.id}`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });
  expect(embedResponse.status()).toBe(200);
  const embedBody = await parseJsonBody<EmbedSnippetResponse>(embedResponse);
  expect(normalizeLocalOrigin(embedBody.runtimeEndpoint)).toBe(
    normalizeLocalOrigin(RUNTIME_BASE_URL),
  );
  expect(embedBody.sdkUrl).toContain('/api/sdk/embed/script');
  expect(embedBody.runtimeEndpoint.length).toBeGreaterThan(0);
  expect(embedBody.snippet).toContain('<agent-widget');
  expect(embedBody.snippet).toContain(`channel-id="${channel.id}"`);
  expect(embedBody.snippet).toContain('YOUR_PUBLIC_API_KEY');
  const resolvedSnippet = embedBody.snippet.split('YOUR_PUBLIC_API_KEY').join(keyBody.key);

  return {
    projectId: project.id,
    projectName: project.name,
    sdkPublicKey: keyBody.key,
    embedSnippet: resolvedSnippet,
    config: embedBody.config,
    sdkUrl: embedBody.sdkUrl,
    runtimeEndpoint: embedBody.runtimeEndpoint,
  };
}

function normalizeWebSocketFramePayload(payload: string | Buffer): string {
  return typeof payload === 'string' ? payload : payload.toString('utf8');
}

export function attachSdkWebSocketProbe(page: Page): SdkWebSocketProbe {
  const probe: SdkWebSocketProbe = {
    urls: [],
    receivedFrames: [],
    sentFrames: [],
  };

  page.on('websocket', (webSocket) => {
    if (!webSocket.url().includes('/ws/sdk')) {
      return;
    }

    probe.urls.push(webSocket.url());
    webSocket.on('framereceived', (frame) => {
      probe.receivedFrames.push(normalizeWebSocketFramePayload(frame.payload));
    });
    webSocket.on('framesent', (frame) => {
      probe.sentFrames.push(normalizeWebSocketFramePayload(frame.payload));
    });
  });

  return probe;
}

export async function expectSdkSessionStart(
  probe: SdkWebSocketProbe,
  options: {
    timeoutMs?: number;
  } = {},
): Promise<void> {
  await expect
    .poll(() => probe.receivedFrames.some((frame) => frame.includes('"type":"session_start"')), {
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    .toBe(true);
}

export async function expectSdkFrameSent(
  probe: SdkWebSocketProbe,
  frameType: string,
  options: {
    timeoutMs?: number;
  } = {},
): Promise<void> {
  await expect
    .poll(() => probe.sentFrames.some((frame) => frame.includes(`"type":"${frameType}"`)), {
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    .toBe(true);
}

export async function browserDevLogin(
  page: Page,
  options: {
    email: string;
    name?: string;
  },
): Promise<void> {
  await page.goto(`${STUDIO_BASE_URL}/auth/login`, {
    waitUntil: 'domcontentloaded',
    timeout: REQUEST_TIMEOUT_MS,
  });

  const result = await page.evaluate(
    async ({ email, name }) => {
      const response = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, name }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };

      return {
        ok: response.ok,
        status: response.status,
        error: body.error ?? null,
      };
    },
    {
      email: options.email,
      name: options.name ?? 'SDK Browser E2E',
    },
  );

  expect(result.ok, result.error ?? `Dev login failed with status ${String(result.status)}`).toBe(
    true,
  );
}

export async function mountWidgetUnderTest(
  page: Page,
  context: WidgetContext,
  options: {
    title?: string;
    hostId?: string;
  } = {},
): Promise<void> {
  const hostId = options.hostId ?? 'sdk-widget-under-test';
  const documentTitle = options.title ?? 'SDK Widget Browser E2E';
  const snippet = context.embedSnippet.replace('<agent-widget', `<agent-widget id="${hostId}"`);

  // Keep the document on a real Studio origin, but use a dedicated static host
  // page so the widget browser lane is not coupled to Studio's auth UI lifecycle.
  await page.goto(`${STUDIO_BASE_URL}${SDK_BROWSER_E2E_HOST_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await page.evaluate(
    ({ mountSnippet, title, projectName }) => {
      document.title = title;

      const mountRoot = document.getElementById('sdk-browser-e2e-root');
      if (!(mountRoot instanceof HTMLElement)) {
        throw new Error('SDK browser E2E mount root not found');
      }

      mountRoot.replaceChildren();

      const heading = document.createElement('h1');
      heading.textContent = projectName;
      mountRoot.appendChild(heading);

      const template = document.createElement('template');
      template.innerHTML = mountSnippet;

      for (const child of Array.from(template.content.childNodes)) {
        if (!(child instanceof Element) || child.tagName !== 'SCRIPT') {
          mountRoot.appendChild(child.cloneNode(true));
          continue;
        }

        const originalScript = child as HTMLScriptElement;
        const runtimeScript = document.createElement('script');
        for (const attribute of Array.from(originalScript.attributes)) {
          runtimeScript.setAttribute(attribute.name, attribute.value);
        }
        if (originalScript.textContent) {
          runtimeScript.textContent = originalScript.textContent;
        }
        mountRoot.appendChild(runtimeScript);
      }
    },
    {
      mountSnippet: snippet,
      title: documentTitle,
      projectName: context.projectName,
    },
  );
  await page.evaluate(async () => {
    await customElements.whenDefined('agent-widget');
  });
}

const DEFAULT_WIDGET_HOST_SELECTOR = '#sdk-widget-under-test';

async function widgetShadowState(
  page: Page,
  hostSelector: string,
  shadowSelector: string,
): Promise<{
  exists: boolean;
  visible: boolean;
  texts: string[];
  disabled: boolean | null;
}> {
  const host = page.locator(hostSelector);
  if ((await host.count()) === 0) {
    return { exists: false, visible: false, texts: [], disabled: null };
  }

  return await host.evaluate((element, selector) => {
    const target = element.shadowRoot?.querySelector(selector as string);
    if (!target) {
      return { exists: false, visible: false, texts: [], disabled: null };
    }

    const renderedText = target.textContent?.trim();
    const texts = renderedText && renderedText.length > 0 ? [renderedText] : [];

    if (!(target instanceof HTMLElement)) {
      return { exists: true, visible: false, texts, disabled: null };
    }

    const computedStyle = window.getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const disabled =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLButtonElement
        ? target.disabled
        : null;

    return {
      exists: true,
      visible:
        computedStyle.display !== 'none' &&
        computedStyle.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0,
      texts,
      disabled,
    };
  }, shadowSelector);
}

export async function expectWidgetShadowVisible(
  page: Page,
  shadowSelector: string,
  options: {
    hostSelector?: string;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  await expect
    .poll(() => widgetShadowState(page, hostSelector, shadowSelector), {
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    .toMatchObject({ exists: true, visible: true });
}

export async function expectWidgetShadowAbsent(
  page: Page,
  shadowSelector: string,
  options: {
    hostSelector?: string;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  await expect
    .poll(() => widgetShadowState(page, hostSelector, shadowSelector), {
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    .toMatchObject({ exists: false });
}

export async function expectWidgetShadowDisabled(
  page: Page,
  shadowSelector: string,
  options: {
    hostSelector?: string;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  await expect
    .poll(() => widgetShadowState(page, hostSelector, shadowSelector), {
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    .toMatchObject({ exists: true, disabled: true });
}

export async function expectWidgetShadowEnabled(
  page: Page,
  shadowSelector: string,
  options: {
    hostSelector?: string;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  await expect
    .poll(() => widgetShadowState(page, hostSelector, shadowSelector), {
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    .toMatchObject({ exists: true, disabled: false });
}

export async function clickWidgetShadowButton(
  page: Page,
  shadowSelector: string,
  options: {
    hostSelector?: string;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  await expectWidgetShadowVisible(page, shadowSelector, { hostSelector });
  await page.locator(hostSelector).evaluate((element, selector) => {
    const target = element.shadowRoot?.querySelector(selector as string);
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error(`Shadow button not found: ${String(selector)}`);
    }
    target.click();
  }, shadowSelector);
}

export async function fillWidgetInputAndSubmit(
  page: Page,
  value: string,
  options: {
    hostSelector?: string;
    inputSelector?: string;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  const inputSelector = options.inputSelector ?? 'input.input-field';
  await expectWidgetShadowVisible(page, inputSelector, { hostSelector });
  await page.locator(hostSelector).evaluate(
    (element, payload) => {
      const target = element.shadowRoot?.querySelector(payload.selector);
      if (!(target instanceof HTMLInputElement)) {
        throw new Error(`Shadow input not found: ${payload.selector}`);
      }
      if (target.disabled) {
        throw new Error(`Shadow input is disabled: ${payload.selector}`);
      }

      target.focus();
      target.value = payload.value;
      target.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          data: payload.value,
          inputType: 'insertText',
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          composed: true,
        }),
      );
    },
    { selector: inputSelector, value },
  );
}

export async function selectWidgetShadowOption(
  page: Page,
  shadowSelector: string,
  value: string,
  options: {
    hostSelector?: string;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  await expectWidgetShadowVisible(page, shadowSelector, { hostSelector });
  await page.locator(hostSelector).evaluate(
    (element, payload) => {
      const target = element.shadowRoot?.querySelector(payload.selector);
      if (!(target instanceof HTMLSelectElement)) {
        throw new Error(`Shadow select not found: ${payload.selector}`);
      }

      target.focus();
      target.value = payload.value;
      target.dispatchEvent(
        new Event('input', {
          bubbles: true,
          composed: true,
        }),
      );
      target.dispatchEvent(
        new Event('change', {
          bubbles: true,
          composed: true,
        }),
      );
    },
    { selector: shadowSelector, value },
  );
}

export async function expectWidgetShadowText(
  page: Page,
  shadowSelector: string,
  expectedText: string,
  options: {
    hostSelector?: string;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const hostSelector = options.hostSelector ?? DEFAULT_WIDGET_HOST_SELECTOR;
  await expect
    .poll(
      async () => {
        const host = page.locator(hostSelector);
        if ((await host.count()) === 0) {
          return false;
        }

        return await host.evaluate(
          (element, payload) => {
            const texts = Array.from(
              element.shadowRoot?.querySelectorAll(payload.selector as string) ?? [],
            )
              .map((node) => node.textContent?.trim() ?? '')
              .filter((text) => text.length > 0);
            return texts.some((text) => text.includes(payload.expectedText as string));
          },
          { selector: shadowSelector, expectedText },
        );
      },
      { timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS },
    )
    .toBe(true);
}
