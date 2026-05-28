import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createSdkBootstrapChannel,
  createSdkPublicKey,
  importProjectFiles,
  provisionTenantModel,
  setSuperAdmins,
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
import {
  extractRuntimeInteractionBlock,
  findLatestRuntimeInteractionRequestForLastUserMessage,
  stringifyMessageContent,
} from '../helpers/mock-llm-request-utils.js';

const SDK_REASONING_AGENT_DSL = `
AGENT: SDK_Interaction_Context_Reasoner

GOAL: "Answer briefly while respecting SDK-provided interaction context"

PERSONA: "A concise assistant"
`;

function getRuntimeInteractionBlock(mockLlm: MockLLM, userMessage: string): string {
  const request = findLatestRuntimeInteractionRequestForLastUserMessage(mockLlm, userMessage);
  const systemMessage = request?.messages.find((message) => message.role === 'system');
  return systemMessage
    ? extractRuntimeInteractionBlock(stringifyMessageContent(systemMessage.content))
    : '';
}

async function waitForAssistantCount(
  sdk: AgentSDK,
  expectedCount: number,
  timeoutMs = 15_000,
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

describe.sequential('SDK interaction context E2E', () => {
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
    await setSuperAdmins([]);
    mockLlm.reset();

    admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-interaction-admin'),
      uniqueSlug('tenant-sdk-interaction'),
      uniqueSlug('project-sdk-interaction'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/sdk-interaction-context-reasoner.agent.abl': SDK_REASONING_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock SDK Interaction Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-sdk-interaction-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-sdk-interaction-model',
        apiKey: 'test-api-key',
      },
    });

    publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'SDK Interaction Context Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, 120_000);

  test('applies per-message SDK metadata when the same session switches locale and language', async () => {
    const sdk = new AgentSDK({
      projectId: admin.projectId,
      apiKey: publicKey.key!,
      endpoint: harness.baseUrl,
      webSocketConstructor: NodeWebSocket as unknown as WebSocketConstructor,
      userContext: { userId: 'sdk-interaction-user' },
    });

    try {
      await sdk.connect();
      expect(sdk.getSessionId()).toBeTruthy();

      const chat = sdk.chat();

      await chat.send('bonjour sdk context', {
        metadata: {
          language: 'fr',
          locale: 'fr-FR',
          timezone: 'Europe/Paris',
        },
      });
      await waitForAssistantCount(sdk, 1);

      await chat.send('hola sdk context', {
        metadata: {
          language: 'es',
          locale: 'es-MX',
          timezone: 'America/Mexico_City',
        },
      });
      await waitForAssistantCount(sdk, 2);

      const frenchBlock = getRuntimeInteractionBlock(mockLlm, 'bonjour sdk context');
      const spanishBlock = getRuntimeInteractionBlock(mockLlm, 'hola sdk context');

      expect(frenchBlock).toContain('"language": "fr"');
      expect(frenchBlock).toContain('"locale": "fr-FR"');
      expect(frenchBlock).toContain('"timezone": "Europe/Paris"');

      expect(spanishBlock).toContain('"language": "es"');
      expect(spanishBlock).toContain('"locale": "es-MX"');
      expect(spanishBlock).toContain('"timezone": "America/Mexico_City"');
    } finally {
      if (sdk.isConnected()) {
        sdk.disconnect();
      }
    }
  }, 90_000);

  test('seeds the first SDK turn from bootstrap userContext customAttributes', async () => {
    const sdk = new AgentSDK({
      projectId: admin.projectId,
      apiKey: publicKey.key!,
      endpoint: harness.baseUrl,
      webSocketConstructor: NodeWebSocket as unknown as WebSocketConstructor,
      userContext: {
        userId: 'sdk-bootstrap-user',
        customAttributes: {
          language: 'fr',
          locale: 'fr-FR',
          timezone: 'Europe/Paris',
        },
      },
    });

    try {
      await sdk.connect();
      expect(sdk.getSessionId()).toBeTruthy();

      await sdk.chat().send('bootstrap sdk context');
      await waitForAssistantCount(sdk, 1);

      const interactionBlock = getRuntimeInteractionBlock(mockLlm, 'bootstrap sdk context');
      expect(interactionBlock).toContain('"language": "fr"');
      expect(interactionBlock).toContain('"locale": "fr-FR"');
      expect(interactionBlock).toContain('"timezone": "Europe/Paris"');
    } finally {
      if (sdk.isConnected()) {
        sdk.disconnect();
      }
    }
  }, 90_000);
});
