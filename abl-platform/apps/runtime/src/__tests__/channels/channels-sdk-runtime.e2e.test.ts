import type { IncomingMessage } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { Window } from 'happy-dom';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createSdkBootstrapChannel,
  createProject,
  createSdkPublicKey,
  importProjectFiles,
  initSdkSession,
  provisionTenantModel,
  requestJson,
  sdkHeaders,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  startMultimodalServiceHarness,
  type MultimodalServiceHarness,
} from '../helpers/multimodal-service-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import { AgentSDK } from '../../../../../packages/web-sdk/src/core/AgentSDK.js';
import { createActionHandler } from '../../../../../packages/web-sdk/src/ui/action-handler.js';
import type {
  Message,
  WebSocketConstructor,
} from '../../../../../packages/web-sdk/src/core/types.js';

const CONTEXT_AGENT_DSL = `
AGENT: Channel_Context_Agent

GOAL: "Collect user context across multiple turns"

FLOW:
  entry_point: collect_name
  steps:
    - collect_name
    - collect_topic
    - summary

collect_name:
  REASONING: false
  GATHER:
    - name: required
  THEN: collect_topic

collect_topic:
  REASONING: false
  GATHER:
    - topic: required
  THEN: summary

summary:
  REASONING: false
  RESPOND: "Summary for {{name}} about {{topic}}."
  THEN: COMPLETE
`;

const SDK_BUTTON_SUPERVISOR_DSL = `
AGENT: Sdk_Button_Supervisor
GOAL: "Route SDK button clicks to child agents"
PERSONA: "Supervisor"

HANDOFF:
  - TO: Sdk_Button_Child
    WHEN: always
    RETURN: false

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose a specialist"
    ACTIONS:
      - BUTTON: "Child Agent"
        ID: child_agent
        VALUE: "child_payload"
  ON_ACTION:
    child_agent:
      DO:
        - RESPOND: "Routing to child from SDK..."
        - HANDOFF: Sdk_Button_Child
`;

const SDK_BUTTON_CHILD_DSL = `
AGENT: Sdk_Button_Child
GOAL: "Handle SDK button handoff"
PERSONA: "Child"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Child agent handled the SDK button click."
  THEN: COMPLETE
`;

const SDK_STRUCTURED_READBACK_DSL = `
AGENT: Sdk_Structured_Readback_Agent
GOAL: "Return structured content through SDK chat and session readback"

FLOW:
  entry_point: show_summary
  steps:
    - show_summary

show_summary:
  REASONING: false
  RESPOND: "Account summary ready"
    VOICE:
      plain_text: "Account summary ready"
    FORMATS:
      MARKDOWN: "**Account summary**"
    ACTIONS:
      - BUTTON: "Review details" -> review_details
  THEN: COMPLETE
`;

const SDK_BUTTON_PROJECT_MANIFEST = JSON.stringify(
  {
    format_version: '2.0',
    name: 'SDK Button Handoff Project',
    slug: 'sdk-button-handoff-project',
    description: null,
    abl_version: '2.0',
    exported_at: '2026-05-02T00:00:00.000Z',
    exported_by: 'ABLP-612',
    entry_agent: 'Sdk_Button_Supervisor',
    dsl_format: 'legacy',
    layers_included: ['core'],
    agents: {
      Sdk_Button_Supervisor: {
        path: 'agents/sdk-button-supervisor.agent.abl',
        owner: null,
        ownerTeam: null,
        description: null,
        version: null,
      },
      Sdk_Button_Child: {
        path: 'agents/sdk-button-child.agent.abl',
        owner: null,
        ownerTeam: null,
        description: null,
        version: null,
      },
    },
    tools: {},
    metadata: {
      source: 'ABLP-612 SDK action handoff E2E',
    },
  },
  null,
  2,
);

type TestDomGlobalName =
  | 'window'
  | 'document'
  | 'HTMLElement'
  | 'HTMLButtonElement'
  | 'CustomEvent'
  | 'Event'
  | 'MouseEvent'
  | 'Node'
  | 'navigator';

interface TestDomSnapshot {
  existed: boolean;
  value: unknown;
}

function parseSseEvents(raw: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];

  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) {
      continue;
    }

    let event = 'message';
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }

    const payload = dataLines.join('\n');
    events.push({
      event,
      data: payload.length > 0 ? JSON.parse(payload) : null,
    });
  }

  return events;
}

async function waitFor<T>(
  label: string,
  getValue: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await getValue();
    if (value !== null && value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function setTestDomGlobal(name: TestDomGlobalName, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function installTestDom(window: Window): Map<TestDomGlobalName, TestDomSnapshot> {
  const globalRecord = globalThis as Record<TestDomGlobalName, unknown>;
  const names: TestDomGlobalName[] = [
    'window',
    'document',
    'HTMLElement',
    'HTMLButtonElement',
    'CustomEvent',
    'Event',
    'MouseEvent',
    'Node',
    'navigator',
  ];
  const snapshot = new Map<TestDomGlobalName, TestDomSnapshot>();

  for (const name of names) {
    snapshot.set(name, {
      existed: Object.prototype.hasOwnProperty.call(globalRecord, name),
      value: globalRecord[name],
    });
  }

  setTestDomGlobal('window', window);
  setTestDomGlobal('document', window.document);
  setTestDomGlobal('HTMLElement', window.HTMLElement);
  setTestDomGlobal('HTMLButtonElement', window.HTMLButtonElement);
  setTestDomGlobal('CustomEvent', window.CustomEvent);
  setTestDomGlobal('Event', window.Event);
  setTestDomGlobal('MouseEvent', window.MouseEvent);
  setTestDomGlobal('Node', window.Node);
  setTestDomGlobal('navigator', window.navigator);

  return snapshot;
}

function restoreTestDom(snapshot: Map<TestDomGlobalName, TestDomSnapshot>): void {
  const globalRecord = globalThis as Record<TestDomGlobalName, unknown>;

  for (const [name, previous] of snapshot) {
    if (previous.existed) {
      setTestDomGlobal(name, previous.value);
    } else {
      delete globalRecord[name];
    }
  }
}

async function renderAndClickSdkButton(
  message: Message,
  onAction: (actionId: string, value?: string) => void,
  buttonLabel: string,
): Promise<void> {
  const window = new Window();
  const snapshot = installTestDom(window);

  try {
    await import('../../../../../packages/web-sdk/src/templates/index.js');
    const { renderRichMessage } =
      await import('../../../../../packages/web-sdk/src/ui/rich-renderer.js');
    const container = window.document.createElement('div');
    renderRichMessage(container as unknown as HTMLElement, message, { onAction });

    const buttons = Array.from(container.querySelectorAll('button'));
    const button = buttons.find((candidate) => candidate.textContent === buttonLabel);

    expect(button, container.innerHTML).toBeTruthy();
    expect(button?.textContent).toBe(buttonLabel);

    button?.click();
    expect(button?.disabled).toBe(true);
  } finally {
    restoreTestDom(snapshot);
  }
}

describe('SDK runtime channel E2E', () => {
  let harness!: RuntimeApiHarness;
  let harnessStarted = false;
  let multimodal!: MultimodalServiceHarness;
  let multimodalStarted = false;
  let mockLlm!: MockLLM;
  let mockLlmStarted = false;
  let lastSdkUpgradeUrl: string | null = null;
  let lastSdkProtocolHeader: string | null = null;

  const observeSdkUpgrade = (request: IncomingMessage) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname !== '/ws/sdk') {
      return;
    }

    lastSdkUpgradeUrl = request.url || null;
    lastSdkProtocolHeader = Array.isArray(request.headers['sec-websocket-protocol'])
      ? request.headers['sec-websocket-protocol'].join(',')
      : (request.headers['sec-websocket-protocol'] ?? null);
  };

  beforeAll(async () => {
    multimodal = await startMultimodalServiceHarness();
    multimodalStarted = true;
    mockLlm = await startMockLLM();
    mockLlmStarted = true;

    harness = await startRuntimeServerHarness(
      {
        MULTIMODAL_SERVICE_URL: multimodal.baseUrl,
        FEATURE_LIVEKIT_ENABLED: 'true',
        LIVEKIT_URL: 'wss://livekit.test.local',
        LIVEKIT_API_KEY: 'test-livekit-api-key',
        LIVEKIT_API_SECRET: 'test-livekit-api-secret',
      },
      { autoIndex: false },
    );
    harnessStarted = true;
    harness.server.on('upgrade', observeSdkUpgrade);
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    lastSdkUpgradeUrl = null;
    lastSdkProtocolHeader = null;
  });

  afterAll(async () => {
    if (harnessStarted) {
      harness.server.off('upgrade', observeSdkUpgrade);
      await harness.close();
    }

    if (mockLlmStarted) {
      await mockLlm.close();
    }

    if (multimodalStarted) {
      await multimodal.close();
    }
  }, 120_000);

  test('packaged SDK bootstraps through sdk/init, authenticates via WebSocket subprotocol, and uploads attachments through the scoped SDK route', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-package-admin'),
      uniqueSlug('tenant-sdk-package'),
      uniqueSlug('project-sdk-package'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/channel-context.agent.abl': CONTEXT_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Package Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-package-model',
        apiKey: 'test-api-key',
      },
    });

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Package Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdk = new AgentSDK({
      projectId: admin.projectId,
      apiKey: publicKey.key!,
      endpoint: harness.baseUrl,
      webSocketConstructor: NodeWebSocket as unknown as WebSocketConstructor,
      userContext: { userId: 'sdk-package-user' },
    });

    try {
      await sdk.connect();

      const sessionId = await waitFor('packaged SDK session', () => sdk.getSessionId());
      expect(sessionId).toBeTruthy();
      expect(lastSdkUpgradeUrl).toBe('/ws/sdk');
      expect(lastSdkUpgradeUrl).not.toContain('token=');
      expect(lastSdkProtocolHeader).toContain('sdk-ticket');
      expect(lastSdkProtocolHeader).not.toContain('pk_');
      expect(lastSdkProtocolHeader).not.toContain('sdk_token');

      const chat = sdk.chat();
      const attachmentId = await chat.uploadAttachment(
        new File(['hello from package sdk'], 'package-sdk.txt', { type: 'text/plain' }),
      );
      expect(attachmentId).toBeTruthy();

      sdk.disconnect();

      const listedAttachment = await waitFor(
        'persisted attachment-scoped SDK session',
        async () => {
          const response = await requestJson<{
            success: boolean;
            data?: { attachments: Array<{ id: string }> };
          }>(
            harness,
            `/api/projects/${encodeURIComponent(admin.projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments`,
            {
              headers: authHeaders(admin.token),
            },
          );

          if (response.status !== 200) {
            return null;
          }

          return (
            response.body.data?.attachments.find((attachment) => attachment.id === attachmentId) ??
            null
          );
        },
      );
      expect(listedAttachment?.id).toBe(attachmentId);
    } finally {
      if (sdk.isConnected()) {
        sdk.disconnect();
      }
    }
  }, 90_000);

  test('packaged SDK renders a supervisor button click and receives the child agent handoff response over WebSocket', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-action-admin'),
      uniqueSlug('tenant-sdk-action'),
      uniqueSlug('project-sdk-action'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'project.json': SDK_BUTTON_PROJECT_MANIFEST,
      'agents/sdk-button-supervisor.agent.abl': SDK_BUTTON_SUPERVISOR_DSL,
      'agents/sdk-button-child.agent.abl': SDK_BUTTON_CHILD_DSL,
    });

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Action Handoff Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdk = new AgentSDK({
      projectId: admin.projectId,
      apiKey: publicKey.key!,
      endpoint: harness.baseUrl,
      webSocketConstructor: NodeWebSocket as unknown as WebSocketConstructor,
      userContext: { userId: 'sdk-action-user' },
    });
    const chat = sdk.chat();
    const messages: Message[] = [];
    const chunks: string[] = [];

    chat.on('message', (message) => {
      messages.push(message);
    });
    chat.on('messageChunk', ({ chunk }) => {
      chunks.push(chunk);
    });

    try {
      await sdk.connect();

      const promptMessage = await waitFor(
        'supervisor button prompt over SDK websocket',
        () =>
          messages.find(
            (message) =>
              message.role === 'assistant' &&
              message.content.includes('Choose a specialist') &&
              message.actions?.elements.some((element) => element.id === 'child_agent'),
          ),
        20_000,
      );
      const buttonAction = promptMessage.actions?.elements.find(
        (element) => element.id === 'child_agent',
      );

      expect(buttonAction).toEqual(
        expect.objectContaining({
          id: 'child_agent',
          type: 'button',
          label: 'Child Agent',
          value: 'child_payload',
        }),
      );
      expect(promptMessage.actions?.renderId).toMatch(/^action-render-/);

      await renderAndClickSdkButton(
        promptMessage,
        createActionHandler(chat),
        buttonAction?.label ?? 'Child Agent',
      );

      const childMessage = await waitFor(
        'child agent handoff response over SDK websocket',
        () =>
          messages.find(
            (message) =>
              message.role === 'assistant' &&
              message.content.includes('Child agent handled the SDK button click.'),
          ),
        20_000,
      );

      expect(childMessage.content).toContain('Child agent handled the SDK button click.');
      expect(chunks.join('')).toContain('Routing to child from SDK...');
      expect(chunks.join('')).toContain('Child agent handled the SDK button click.');
    } finally {
      if (sdk.isConnected()) {
        sdk.disconnect();
      }
    }
  }, 90_000);

  test('rejects query-string SDK token transport without the sdk-auth subprotocol', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-query-admin'),
      uniqueSlug('tenant-sdk-query'),
      uniqueSlug('project-sdk-query'),
    );

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Query Fallback Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkSession = await initSdkSession(harness, {
      publicKey: publicKey.key!,
    });

    const wsUrl =
      harness.baseUrl.replace(/^http/, 'ws') +
      `/ws/sdk?token=${encodeURIComponent(sdkSession.token)}`;

    // The server upgrades the connection (101) then immediately closes the WS
    // with code 4001 because the sdk-auth subprotocol header is missing.
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new NodeWebSocket(wsUrl);
      let settled = false;

      ws.on('unexpected-response', (_request, response) => {
        settled = true;
        response.resume();
        // If the server rejects at the HTTP level, treat the status code as close code
        resolve(response.statusCode ?? 0);
      });

      ws.on('close', (code) => {
        if (!settled) {
          settled = true;
          resolve(code);
        }
      });

      ws.on('error', (error) => {
        if (!settled) {
          reject(error);
        }
      });
    });

    expect(closeCode).toBe(4001);
  });

  test('preserves SDK session ownership and multi-turn context even when unsigned userContext metadata matches', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-admin'),
      uniqueSlug('tenant-sdk'),
      uniqueSlug('project-sdk'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/channel-context.agent.abl': CONTEXT_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Context Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-context-model',
        apiKey: 'test-api-key',
      },
    });

    mockLlm.registerToolCall('Alice', {
      name: '_extract_entities',
      arguments: { name: 'Alice' },
      followUpContent: '{}',
    });
    mockLlm.registerToolCall('tenant isolation', {
      name: '_extract_entities',
      arguments: { topic: 'tenant isolation' },
      followUpContent: '{}',
    });

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Browser Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkUserA = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'shared-metadata-user' },
    });
    const sdkUserB = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'shared-metadata-user' },
    });

    const initialTurn = await requestJson<{
      sessionId: string;
      response: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkUserA.token),
      body: {
        projectId: admin.projectId,
        message: 'start',
      },
    });

    expect(initialTurn.status).toBe(200);
    expect(initialTurn.body.sessionId).toBeTruthy();
    expect(initialTurn.body.response).toContain('name');

    const ownList = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${admin.projectId}/sessions`, {
      method: 'GET',
      headers: sdkHeaders(sdkUserA.token),
    });

    expect(ownList.status).toBe(200);
    expect(ownList.body.sessions.map((session) => session.id)).toContain(
      initialTurn.body.sessionId,
    );

    const ownDetail = await requestJson<{
      success: boolean;
      session: {
        id: string;
        messages: Array<{ id: string; role: string; content: string }>;
      };
    }>(harness, `/api/projects/${admin.projectId}/sessions/${initialTurn.body.sessionId}`, {
      method: 'GET',
      headers: sdkHeaders(sdkUserA.token),
    });

    expect(ownDetail.status).toBe(200);
    expect(ownDetail.body.session.id).toBe(initialTurn.body.sessionId);
    expect(ownDetail.body.session.messages.length).toBeGreaterThan(0);

    const foreignDetail = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/sessions/${initialTurn.body.sessionId}`,
      {
        method: 'GET',
        headers: sdkHeaders(sdkUserB.token),
      },
    );

    expect(foreignDetail.status).toBe(404);

    const foreignResume = await requestJson<{ error: string }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkUserB.token),
      body: {
        projectId: admin.projectId,
        sessionId: initialTurn.body.sessionId,
        message: 'steal context',
      },
    });

    expect(foreignResume.status).toBe(404);

    const secondTurn = await requestJson<{
      sessionId: string;
      response: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkUserA.token),
      body: {
        projectId: admin.projectId,
        sessionId: initialTurn.body.sessionId,
        message: 'Alice',
      },
    });

    expect(secondTurn.status).toBe(200);
    expect(secondTurn.body.sessionId).toBe(initialTurn.body.sessionId);
    expect(secondTurn.body.response).toContain('topic');

    const thirdTurn = await requestJson<{
      sessionId: string;
      response: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkUserA.token),
      body: {
        projectId: admin.projectId,
        sessionId: initialTurn.body.sessionId,
        message: 'tenant isolation',
      },
    });

    expect(thirdTurn.status).toBe(200);
    expect(thirdTurn.body.sessionId).toBe(initialTurn.body.sessionId);
    expect(thirdTurn.body.response).toContain('Alice');
    expect(thirdTurn.body.response).toContain('tenant isolation');

    const persistedSession = await waitFor('persisted multi-turn SDK session', async () => {
      const detail = await requestJson<{
        success: boolean;
        session: {
          id: string;
          messages: Array<{ content: string }>;
        };
      }>(harness, `/api/projects/${admin.projectId}/sessions/${initialTurn.body.sessionId}`, {
        method: 'GET',
        headers: sdkHeaders(sdkUserA.token),
      });

      const contents = detail.body.session.messages.map((message) => message.content).join('\n');
      return contents.includes('tenant isolation') ? detail.body.session : null;
    });

    expect(persistedSession.id).toBe(initialTurn.body.sessionId);
    expect(persistedSession.messages.map((message) => message.content).join('\n')).toContain(
      'tenant isolation',
    );
  });

  test('preserves structured SDK chat output through persisted session readback', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-structured-readback-admin'),
      uniqueSlug('tenant-sdk-structured-readback'),
      uniqueSlug('project-sdk-structured-readback'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/sdk-structured-readback.agent.abl': SDK_STRUCTURED_READBACK_DSL,
    });

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Structured Readback Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkSession = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'sdk-structured-readback-user' },
    });

    const turn = await requestJson<{
      sessionId: string;
      response: string;
      richContent?: { markdown?: string };
      voiceConfig?: { plain_text?: string };
      actions?: { elements?: Array<{ label?: string; value?: string }> };
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkSession.token),
      body: {
        projectId: admin.projectId,
        message: 'show account summary',
      },
    });

    expect(turn.status).toBe(200);
    expect(turn.body.response).toBe('Account summary ready');
    expect(turn.body.richContent?.markdown).toBe('**Account summary**');
    expect(turn.body.voiceConfig?.plain_text).toBe('Account summary ready');
    expect(turn.body.actions?.elements?.[0]).toMatchObject({
      label: 'Review details',
      value: 'review_details',
    });

    const persistedMessage = await waitFor('structured SDK session readback', async () => {
      const detail = await requestJson<{
        success: boolean;
        session: {
          id: string;
          messages: Array<{
            role: string;
            content: string;
            contentEnvelope?: {
              text?: string;
              richContent?: { markdown?: string };
              voiceConfig?: { plain_text?: string };
              actions?: { elements?: Array<{ label?: string; value?: string }> };
            };
          }>;
        };
      }>(harness, `/api/projects/${admin.projectId}/sessions/${turn.body.sessionId}`, {
        method: 'GET',
        headers: sdkHeaders(sdkSession.token),
      });

      if (detail.status !== 200) {
        return null;
      }

      return (
        detail.body.session.messages.find(
          (message) =>
            message.role === 'assistant' &&
            message.contentEnvelope?.richContent?.markdown === '**Account summary**',
        ) ?? null
      );
    });

    expect(persistedMessage.content).toBe('Account summary ready');
    expect(persistedMessage.contentEnvelope?.text).toBe('Account summary ready');
    expect(persistedMessage.contentEnvelope?.voiceConfig?.plain_text).toBe('Account summary ready');
    expect(persistedMessage.contentEnvelope?.actions?.elements?.[0]).toMatchObject({
      label: 'Review details',
      value: 'review_details',
    });
  });

  test('keeps anonymous SDK sessions isolated per issued token when no user id is provided', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-anon-admin'),
      uniqueSlug('tenant-sdk-anon'),
      uniqueSlug('project-sdk-anon'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/channel-context.agent.abl': CONTEXT_AGENT_DSL,
    });

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Anonymous SDK Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const anonymousUserA = await initSdkSession(harness, {
      publicKey: publicKey.key!,
    });
    const anonymousUserB = await initSdkSession(harness, {
      publicKey: publicKey.key!,
    });

    const firstTurn = await requestJson<{
      sessionId: string;
      response: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(anonymousUserA.token),
      body: {
        projectId: admin.projectId,
        message: 'start',
      },
    });

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.body.sessionId).toBeTruthy();

    const foreignDetail = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/sessions/${firstTurn.body.sessionId}`,
      {
        method: 'GET',
        headers: sdkHeaders(anonymousUserB.token),
      },
    );

    expect(foreignDetail.status).toBe(404);

    const foreignResume = await requestJson<{ error: string }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(anonymousUserB.token),
      body: {
        projectId: admin.projectId,
        sessionId: firstTurn.body.sessionId,
        message: 'attempt anonymous takeover',
      },
    });

    expect(foreignResume.status).toBe(404);
  });

  test('scopes attachment detail and deletion to the owning SDK session rather than tenant-only attachment ids', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('attachment-admin'),
      uniqueSlug('tenant-attach'),
      uniqueSlug('project-attach'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/channel-context.agent.abl': CONTEXT_AGENT_DSL,
    });

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Attachment SDK Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkUserA = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'attachment-user-a' },
    });
    const sdkUserB = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'attachment-user-b' },
    });

    const sessionA = await requestJson<{ sessionId: string }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkUserA.token),
      body: {
        projectId: admin.projectId,
        message: 'Alice',
      },
    });
    expect(sessionA.status).toBe(200);

    const sessionB = await requestJson<{ sessionId: string }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkUserB.token),
      body: {
        projectId: admin.projectId,
        message: 'Bob',
      },
    });
    expect(sessionB.status).toBe(200);

    const form = new FormData();
    form.append(
      'file',
      new Blob(['classified channel payload'], { type: 'text/plain' }),
      'secret.txt',
    );

    const uploadResponse = await fetch(
      `${harness.baseUrl}/api/projects/${admin.projectId}/sessions/${sessionA.body.sessionId}/attachments`,
      {
        method: 'POST',
        headers: sdkHeaders(sdkUserA.token),
        body: form,
      },
    );
    const uploadBody = (await uploadResponse.json()) as {
      success: boolean;
      attachmentId: string;
      status: string;
    };

    expect(uploadResponse.status).toBe(201);
    expect(uploadBody.success).toBe(true);
    expect(uploadBody.attachmentId).toBeTruthy();

    const ownList = await requestJson<{
      success: boolean;
      data: {
        attachments: Array<{ _id: string }>;
      };
    }>(
      harness,
      `/api/projects/${admin.projectId}/sessions/${sessionA.body.sessionId}/attachments`,
      {
        method: 'GET',
        headers: sdkHeaders(sdkUserA.token),
      },
    );

    expect(ownList.status).toBe(200);
    expect(ownList.body.data.attachments.map((attachment) => attachment._id)).toContain(
      uploadBody.attachmentId,
    );

    const foreignDetail = await requestJson<{ success: boolean; error: { code: string } }>(
      harness,
      `/api/projects/${admin.projectId}/sessions/${sessionB.body.sessionId}/attachments/${uploadBody.attachmentId}`,
      {
        method: 'GET',
        headers: sdkHeaders(sdkUserB.token),
      },
    );

    expect(foreignDetail.status).toBe(404);

    const foreignDelete = await fetch(
      `${harness.baseUrl}/api/projects/${admin.projectId}/sessions/${sessionB.body.sessionId}/attachments/${uploadBody.attachmentId}`,
      {
        method: 'DELETE',
        headers: sdkHeaders(sdkUserB.token),
      },
    );

    expect(foreignDelete.status).toBe(404);

    const ownerDetailAfter = await requestJson<{
      success: boolean;
      data: {
        attachment: {
          _id: string;
          originalFilename: string;
        };
      };
    }>(
      harness,
      `/api/projects/${admin.projectId}/sessions/${sessionA.body.sessionId}/attachments/${uploadBody.attachmentId}`,
      {
        method: 'GET',
        headers: sdkHeaders(sdkUserA.token),
      },
    );

    expect(ownerDetailAfter.status).toBe(200);
    expect(ownerDetailAfter.body.data.attachment._id).toBe(uploadBody.attachmentId);
    expect(ownerDetailAfter.body.data.attachment.originalFilename).toBe('secret.txt');
  });

  test('streams ordered SSE events and preserves structured payloads through the real model resolution path', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('stream-admin'),
      uniqueSlug('tenant-stream'),
      uniqueSlug('project-stream'),
    );

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Stream Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: true,
      supportsTools: false,
      capabilities: ['text', 'streaming'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-openai-compatible',
        apiKey: 'test-api-key',
      },
    });

    mockLlm.register('Hello stream', { content: 'Streaming hello from model.' });

    const response = await fetch(`${harness.baseUrl}/api/v1/chat/stream`, {
      method: 'POST',
      headers: {
        ...authHeaders(admin.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: admin.projectId,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello stream' },
              {
                type: 'image_url',
                image_url: {
                  url: 'https://example.com/asset.png',
                  detail: 'low',
                },
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = parseSseEvents(await response.text());
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.event).toBe('metadata');
    expect(events.some((event) => event.event === 'usage')).toBe(true);
    expect(events.at(-1)?.event).toBe('complete');

    const renderedText = events
      .filter((event) => event.event === 'text_delta')
      .map((event) => (event.data as { delta: string }).delta)
      .join('');
    expect(renderedText).toBe('Streaming hello from model.');

    const lastRequest = mockLlm.getLastRequest();
    expect(lastRequest).toBeDefined();
    expect(lastRequest?.messages.at(-1)?.content).toContain('Hello stream');
    expect(lastRequest?.messages.at(-1)?.content).toContain('image_url');
    expect(lastRequest?.messages.at(-1)?.content).toContain('https://example.com/asset.png');
  });

  test('rejects SDK chat requests that target a different project than the bound SDK session', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-scope-admin'),
      uniqueSlug('tenant-sdk-scope'),
      uniqueSlug('project-sdk-scope-a'),
    );

    const projectB = await createProject(
      harness,
      admin.token,
      admin.tenantId,
      `${uniqueSlug('project-sdk-scope-b')} Name`,
      uniqueSlug('project-sdk-scope-b'),
    );

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Scope Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkSession = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'sdk-scope-user' },
    });

    const agentResponse = await requestJson<{
      success: boolean;
      error: { code: string; message: string };
      required?: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkSession.token),
      body: {
        projectId: projectB._id,
        message: 'cross project attempt',
      },
    });

    expect(agentResponse.status).toBe(404);
    expect(agentResponse.body).toMatchObject({
      error: { message: 'Project not found' },
      required: 'session:send_message',
    });

    const streamResponse = await fetch(`${harness.baseUrl}/api/v1/chat/stream`, {
      method: 'POST',
      headers: {
        ...sdkHeaders(sdkSession.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: projectB._id,
        messages: [{ role: 'user', content: 'cross project attempt' }],
      }),
    });

    expect(streamResponse.status).toBe(404);
    await expect(streamResponse.json()).resolves.toMatchObject({
      error: { message: 'Project not found' },
      required: 'session:send_message',
    });
  });

  test('rejects SDK chat execution when the public key only grants voice capability', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-voice-only-admin'),
      uniqueSlug('tenant-sdk-voice-only'),
      uniqueSlug('project-sdk-voice-only'),
    );

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Voice Only Key',
      permissions: {
        chat: false,
        voice: true,
      },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkSession = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'voice-only-sdk-user' },
    });

    const response = await requestJson<{
      success: boolean;
      error: { code: string; message: string };
      required?: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkSession.token),
      body: {
        projectId: admin.projectId,
        message: 'this should be rejected',
      },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { message: 'Forbidden' },
      required: 'session:send_message',
    });
  });

  test('rejects SDK LiveKit token generation when the public key does not grant voice capability', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-livekit-chat-only-admin'),
      uniqueSlug('tenant-sdk-livekit-chat-only'),
      uniqueSlug('project-sdk-livekit-chat-only'),
    );

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Chat Only Key',
      permissions: {
        chat: true,
        voice: false,
      },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkSession = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'chat-only-livekit-user' },
    });

    const response = await requestJson<{
      success: boolean;
      error: { code: string; message: string };
      required?: string;
    }>(harness, '/api/v1/livekit/token', {
      method: 'POST',
      headers: sdkHeaders(sdkSession.token),
      body: {
        sessionId: 'livekit-chat-only-session',
        projectId: admin.projectId,
      },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { message: 'Forbidden' },
    });
  });

  test('rejects SDK LiveKit token generation for a different project in the same tenant', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-livekit-scope-admin'),
      uniqueSlug('tenant-sdk-livekit-scope'),
      uniqueSlug('project-sdk-livekit-scope-a'),
    );

    const projectB = await createProject(
      harness,
      admin.token,
      admin.tenantId,
      `${uniqueSlug('project-sdk-livekit-scope-b')} Name`,
      uniqueSlug('project-sdk-livekit-scope-b'),
    );

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Voice Key',
      permissions: {
        chat: false,
        voice: true,
      },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkSession = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: 'voice-scope-user' },
    });

    const response = await requestJson<{
      success: boolean;
      error: { code: string; message: string };
    }>(harness, '/api/v1/livekit/token', {
      method: 'POST',
      headers: sdkHeaders(sdkSession.token),
      body: {
        sessionId: 'livekit-cross-project-session',
        projectId: projectB._id,
      },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { message: 'Project not found' },
    });
  });
});
