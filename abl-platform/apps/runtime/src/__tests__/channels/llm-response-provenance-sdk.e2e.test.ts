import { WebSocket as NodeWebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createSdkBootstrapChannel,
  createSdkPublicKey,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import { AgentSDK } from '../../../../../packages/web-sdk/src/core/AgentSDK.js';
import type {
  Message,
  WebSocketConstructor,
} from '../../../../../packages/web-sdk/src/core/types.js';

const SIMPLE_AGENT_DSL = `AGENT: Provenance_Test_Agent

GOAL: "Answer user questions conversationally"

PERSONA: "Helpful assistant"
`;

interface SessionDetailResponse {
  success: boolean;
  session: {
    id: string;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      metadata?: {
        isLlmGenerated?: boolean;
        responseProvenance?: {
          schemaVersion: number;
          kind: string;
          disclaimerRequired: boolean;
          usedLlmInternally: boolean;
        };
      };
    }>;
  };
}

async function waitForAssistantCount(
  sdk: AgentSDK,
  expectedCount: number,
  timeoutMs = 20_000,
): Promise<Message[]> {
  const startedAt = Date.now();
  const chat = sdk.chat();

  while (Date.now() - startedAt < timeoutMs) {
    const assistantMessages = chat.getMessages().filter((message) => message.role === 'assistant');
    if (assistantMessages.length >= expectedCount) {
      return assistantMessages;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${expectedCount} assistant SDK messages`);
}

async function waitForPersistedAssistantMessage(
  harness: RuntimeApiHarness,
  adminToken: string,
  projectId: string,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<SessionDetailResponse['session']['messages'][number]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson<SessionDetailResponse>(
      harness,
      `/api/projects/${projectId}/sessions/${sessionId}`,
      {
        headers: authHeaders(adminToken),
      },
    );

    if (response.status === 200 && response.body.success) {
      const assistantMessage = [...response.body.session.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && !!message.metadata?.responseProvenance);

      if (assistantMessage) {
        return assistantMessage;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for persisted assistant provenance metadata');
}

describe.sequential('LLM response provenance SDK E2E', () => {
  let harness!: RuntimeApiHarness;
  let mockLlm!: MockLLM;
  let admin!: Awaited<ReturnType<typeof bootstrapProject>>;
  let publicKey!: Awaited<ReturnType<typeof createSdkPublicKey>>;

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness();
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    mockLlm.reset();

    admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-provenance-admin'),
      uniqueSlug('tenant-sdk-provenance'),
      uniqueSlug('project-sdk-provenance'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/provenance-test.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Provenance Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-provenance-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-provenance-model',
        apiKey: 'test-api-key',
      },
    });

    publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Provenance Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, 120_000);

  test('propagates LLM provenance from the live SDK response to persisted session detail', async () => {
    const sdk = new AgentSDK({
      projectId: admin.projectId,
      apiKey: publicKey.key!,
      endpoint: harness.baseUrl,
      webSocketConstructor: NodeWebSocket as unknown as WebSocketConstructor,
      userContext: { userId: 'sdk-provenance-user' },
    });

    try {
      await sdk.connect();
      const sessionId = sdk.getSessionId();
      expect(sessionId).toBeTruthy();

      await sdk.chat().send('hello provenance');
      const assistantMessages = await waitForAssistantCount(sdk, 1);
      const liveAssistant = assistantMessages.at(-1);
      expect(liveAssistant).toBeDefined();
      expect(liveAssistant?.metadata).toMatchObject({
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      });

      const persistedAssistant = await waitForPersistedAssistantMessage(
        harness,
        admin.token,
        admin.projectId,
        sessionId!,
      );
      expect(persistedAssistant.metadata).toMatchObject({
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      });
    } finally {
      if (sdk.isConnected()) {
        sdk.disconnect();
      }
    }
  }, 90_000);
});
