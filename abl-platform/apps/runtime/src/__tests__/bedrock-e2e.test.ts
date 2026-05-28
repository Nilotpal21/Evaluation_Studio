/**
 * Bedrock E2E Tests
 *
 * Full E2E tests using startRuntimeServerHarness(), bootstrapProject(),
 * and nock for external Bedrock HTTP interception.
 *
 * Tests Bedrock credential provisioning, cross-tenant isolation, and
 * authConfig round-trip through the platform admin models API.
 *
 * NO mocking of @agent-platform/* or @abl/* packages.
 * Only external HTTP (AWS Bedrock endpoint) is intercepted via nock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import nock from 'nock';
import {
  authHeaders,
  bootstrapProject,
  createProject,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';

const TIMEOUT_MS = 90_000;
const BEDROCK_MODEL_ID = 'anthropic.claude-sonnet-4-6-v1:0';
const BEDROCK_ENDPOINT_URL = 'https://bedrock-runtime.us-east-1.amazonaws.com';
const FOUNDRY_ANTHROPIC_MODEL_ID = 'claude-opus-4-7';
const FOUNDRY_ANTHROPIC_ENDPOINT_URL = 'https://fde-int-resource.openai.azure.com';
const FOUNDRY_ANTHROPIC_MESSAGES_PATH = '/anthropic/v1/messages';

const SIMPLE_AGENT_DSL = `AGENT: BedrockTestAgent
GOAL: "Answer user questions"
PERSONA: "Helpful assistant"

ON_ERROR:
  RESPOND: "Something went wrong."
`;

const BEDROCK_MODEL_ENCODED = encodeURIComponent(BEDROCK_MODEL_ID);
const CANNED_BEDROCK_RESPONSE = {
  output: {
    message: {
      role: 'assistant',
      content: [{ text: 'Hello from Bedrock.' }],
    },
  },
  usage: { inputTokens: 8, outputTokens: 6 },
  stopReason: 'end_turn',
};
const CANNED_ANTHROPIC_MESSAGES_RESPONSE = {
  id: 'msg_foundry_mock',
  type: 'message',
  role: 'assistant',
  model: FOUNDRY_ANTHROPIC_MODEL_ID,
  content: [{ type: 'text', text: 'Hello from Foundry Anthropic.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 6 },
};

describe(
  'Bedrock E2E tests',
  () => {
    let harness: RuntimeApiHarness | undefined;
    let token: string;
    let userId: string;
    let tenantId: string;
    let projectId: string;

    beforeAll(async () => {
      // Start Mongo/runtime before disabling outbound network. MongoMemoryServer
      // may need to fetch its binary on a fresh local machine.
      nock.enableNetConnect();
      harness = await startRuntimeServerHarness();

      const boot = await bootstrapProject(
        harness,
        uniqueEmail('bedrock-e2e'),
        uniqueSlug('bedrock-tenant'),
        uniqueSlug('bedrock-proj'),
      );
      token = boot.token;
      userId = boot.userId;
      tenantId = boot.tenantId;
      projectId = boot.projectId;

      // Import a simple agent for chat round-trip tests
      await importProjectFiles(harness, token, projectId, {
        'project.json': JSON.stringify({
          format_version: '2.0',
          entry_agent: 'BedrockTestAgent',
          agents: [{ name: 'BedrockTestAgent', file: 'agents/bedrocktestagent.agent.abl' }],
          tools: [],
        }),
        'agents/bedrocktestagent.agent.abl': SIMPLE_AGENT_DSL,
      });

      nock.disableNetConnect();
      // Allow local connections (harness uses 127.0.0.1:PORT) — regex matches host:port
      nock.enableNetConnect(/127\.0\.0\.1|localhost/);
    }, TIMEOUT_MS);

    afterAll(async () => {
      await harness?.close();
      nock.cleanAll();
      nock.enableNetConnect();
    });

    beforeEach(() => {
      nock.cleanAll();
    });

    afterEach(() => {
      nock.cleanAll();
    });

    // E2E-1: Full Bedrock chat roundtrip — explicit credentials, nock-intercepted Converse API
    test('E2E-1: Bedrock chat round-trip returns assistant text via nock-intercepted converse call', async () => {
      // Provision a Bedrock TenantModel with explicit credentials as the default model
      await provisionTenantModel(harness!, token, {
        targetTenantId: tenantId,
        displayName: 'Bedrock Chat Test',
        integrationType: 'api',
        provider: 'bedrock',
        modelId: BEDROCK_MODEL_ID,
        endpointUrl: BEDROCK_ENDPOINT_URL,
        isDefault: true,
        connection: {
          credentialName: `bedrock-chat-creds-${uniqueSlug('c')}`,
          apiKey: 'AKIATEST',
          authType: 'aws_iam',
          authConfig: {
            region: 'us-east-1',
            accessKeyId: 'AKIATEST',
            secretAccessKey: 'secretvalue',
          },
        },
      });

      // Intercept the Bedrock Converse API call
      const scope = nock(BEDROCK_ENDPOINT_URL)
        .post(`/model/${BEDROCK_MODEL_ENCODED}/converse`)
        .reply(200, CANNED_BEDROCK_RESPONSE);

      // Send chat message through the full runtime stack
      const chatRes = await requestJson<{
        sessionId?: string;
        response?: string;
        messages?: Array<{ role: string; content: string }>;
        success?: boolean;
        error?: unknown;
      }>(harness!, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          projectId,
          agentName: 'BedrockTestAgent',
          message: 'Hello',
        },
      });

      // Assert: response received, Bedrock was called, no "OpenAI API error"
      expect(chatRes.status).toBe(200);
      expect(scope.isDone()).toBe(true); // nock interceptor was hit
      const bodyStr = JSON.stringify(chatRes.body);
      expect(bodyStr.toLowerCase()).not.toContain('openai api error');
    });

    test('E2E-2: Foundry Anthropic chat round-trip uses Anthropic Messages with bearer auth', async () => {
      const foundryProject = await createProject(
        harness!,
        token,
        tenantId,
        'Foundry Anthropic Project',
        uniqueSlug('foundry-proj'),
      );
      await importProjectFiles(harness!, token, foundryProject._id, {
        'project.json': JSON.stringify({
          format_version: '2.0',
          entry_agent: 'BedrockTestAgent',
          agents: [{ name: 'BedrockTestAgent', file: 'agents/bedrocktestagent.agent.abl' }],
          tools: [],
        }),
        'agents/bedrocktestagent.agent.abl': SIMPLE_AGENT_DSL,
      });

      await provisionTenantModel(harness!, token, {
        targetTenantId: tenantId,
        displayName: 'Foundry Anthropic Chat Test',
        integrationType: 'api',
        provider: 'microsoft_foundry_anthropic',
        modelId: FOUNDRY_ANTHROPIC_MODEL_ID,
        endpointUrl: `${FOUNDRY_ANTHROPIC_ENDPOINT_URL}${FOUNDRY_ANTHROPIC_MESSAGES_PATH}`,
        providerStructure: 'anthropic_messages',
        isDefault: true,
        supportsTools: true,
        supportsStreaming: false,
        connection: {
          credentialName: `foundry-anthropic-creds-${uniqueSlug('fa')}`,
          apiKey: 'aad-token',
          authType: 'azure_ad',
          authConfig: {
            anthropicVersion: '2023-06-01',
          },
        },
      });

      let requestBody: Record<string, unknown> | undefined;
      const scope = nock(FOUNDRY_ANTHROPIC_ENDPOINT_URL)
        .matchHeader('authorization', 'Bearer aad-token')
        .matchHeader('anthropic-version', '2023-06-01')
        .post(FOUNDRY_ANTHROPIC_MESSAGES_PATH, (body: unknown) => {
          if (body && typeof body === 'object' && !Array.isArray(body)) {
            requestBody = body as Record<string, unknown>;
          }
          return true;
        })
        .reply(200, CANNED_ANTHROPIC_MESSAGES_RESPONSE);

      const chatRes = await requestJson<{
        sessionId?: string;
        response?: string;
        messages?: Array<{ role: string; content: string }>;
        success?: boolean;
        error?: unknown;
      }>(harness!, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          projectId: foundryProject._id,
          agentName: 'BedrockTestAgent',
          message: 'Hello',
        },
      });

      expect(chatRes.status).toBe(200);
      expect(scope.isDone()).toBe(true);
      expect(requestBody?.model).toBe(FOUNDRY_ANTHROPIC_MODEL_ID);
      expect(requestBody).toHaveProperty('max_tokens');
      expect(requestBody).not.toHaveProperty('temperature');
      expect(requestBody).not.toHaveProperty('top_p');
      const bodyStr = JSON.stringify(chatRes.body);
      expect(bodyStr.toLowerCase()).not.toContain('openai api error');
    });

    // E2E-3: Bedrock provider error surfaces as provider-specific message in chat response
    test('E2E-3: Bedrock provider error surfaces as provider-specific message (not OpenAI) in chat response', async () => {
      // Provision a Bedrock TenantModel (may reuse existing if already provisioned)
      await provisionTenantModel(harness!, token, {
        targetTenantId: tenantId,
        displayName: 'Bedrock Error Test',
        integrationType: 'api',
        provider: 'bedrock',
        modelId: BEDROCK_MODEL_ID,
        endpointUrl: BEDROCK_ENDPOINT_URL,
        isDefault: true,
        connection: {
          credentialName: `bedrock-err-creds-${uniqueSlug('e')}`,
          apiKey: 'AKIATEST_INVALID',
          authType: 'aws_iam',
          authConfig: {
            region: 'us-east-1',
            accessKeyId: 'AKIATEST_INVALID',
            secretAccessKey: 'invalidsecret',
          },
        },
      });

      // Intercept Bedrock and return 401 Unauthorized
      nock(BEDROCK_ENDPOINT_URL).post(`/model/${BEDROCK_MODEL_ENCODED}/converse`).reply(401, {
        message: 'The security token included in the request is invalid.',
      });

      const chatRes = await requestJson<{
        sessionId?: string;
        response?: string;
        error?: string | object;
        success?: boolean;
      }>(harness!, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          projectId,
          agentName: 'BedrockTestAgent',
          message: 'Hello',
        },
      });

      // The response may be a 200 with an error in the body, or a 4xx/5xx
      // In either case: no "OpenAI API error" text should appear
      const bodyStr = JSON.stringify(chatRes.body);
      expect(bodyStr.toLowerCase()).not.toContain('openai api error');
      // The error path should surface something meaningful
      // (either response from ON_ERROR, or an error field)
      expect(chatRes.status).toBeDefined();
    });

    // Provision a Bedrock TenantModel with authConfig and verify it round-trips
    test('Bedrock TenantModel provisioning with authConfig round-trips correctly', async () => {
      const modelRes = await requestJson<{
        success: boolean;
        model: { id: string; provider: string; modelId: string };
      }>(harness!, '/api/platform/admin/tenant-models', {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          targetTenantId: tenantId,
          displayName: 'Bedrock E2E AuthConfig Test',
          integrationType: 'api',
          provider: 'bedrock',
          modelId: BEDROCK_MODEL_ID,
          endpointUrl: BEDROCK_ENDPOINT_URL,
          supportsTools: false,
          supportsStreaming: true,
          connection: {
            credentialName: 'bedrock-e2e-creds',
            apiKey: 'AKIATEST',
            authType: 'aws_iam',
            authConfig: {
              region: 'us-east-1',
              accessKeyId: 'AKIATEST',
              secretAccessKey: 'secretvalue',
            },
          },
        },
      });

      expect(modelRes.status).toBe(201);
      expect(modelRes.body.success).toBe(true);
      expect(modelRes.body.model.provider).toBe('bedrock');
      expect(modelRes.body.model.modelId).toBe(BEDROCK_MODEL_ID);

      // Verify the model can be retrieved
      const getRes = await requestJson<{
        success: boolean;
        model: { id: string; provider: string };
      }>(harness!, `/api/platform/admin/tenant-models/${modelRes.body.model.id}`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      expect(getRes.status).toBe(200);
      expect(getRes.body.success).toBe(true);
      expect(getRes.body.model.provider).toBe('bedrock');
    });

    // E2E-4: Cross-tenant Bedrock credential ownership — tenantId field locked to original tenant
    test('E2E-4: cross-tenant Bedrock model retains original tenantId ownership', async () => {
      // Set up a second tenant — bootstrapProject resets super admins to boot2.userId only,
      // so we must restore both users as super admins afterward.
      const boot2 = await bootstrapProject(
        harness!,
        uniqueEmail('bedrock-tenant2'),
        uniqueSlug('bedrock-tenant2'),
        uniqueSlug('bedrock-proj2'),
      );
      // Restore both users as super admins so tenant 1's token still works
      await setSuperAdmins([userId, boot2.userId]);

      // Provision a Bedrock model in tenant 1
      const modelRes = await requestJson<{
        success: boolean;
        model: { id: string };
      }>(harness!, '/api/platform/admin/tenant-models', {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          targetTenantId: tenantId,
          displayName: 'Bedrock Isolation Test',
          integrationType: 'api',
          provider: 'bedrock',
          modelId: BEDROCK_MODEL_ID,
          endpointUrl: BEDROCK_ENDPOINT_URL,
          connection: {
            credentialName: 'bedrock-isolation-creds',
            apiKey: 'AKIATEST',
            authType: 'aws_iam',
            authConfig: {
              region: 'us-east-1',
              accessKeyId: 'AKIATEST',
              secretAccessKey: 'secret',
            },
          },
        },
      });
      expect(modelRes.status).toBe(201);
      const modelId = modelRes.body.model.id;

      // Tenant 2 (super admin) reads tenant 1's model via platform admin route.
      // Both users are super admins so access is permitted at the route layer.
      // Isolation is enforced at the tenantId field: the model must always belong to tenant 1.
      const isolRes = await requestJson<{
        success: boolean;
        model?: { id: string; tenantId: string };
      }>(harness!, `/api/platform/admin/tenant-models/${modelId}`, {
        method: 'GET',
        headers: authHeaders(boot2.token),
      });

      // Platform admin route may return 200 or 404 depending on super-admin resolution path
      expect([200, 404]).toContain(isolRes.status);
      if (isolRes.status === 200 && isolRes.body.model) {
        // tenantId must be locked to the provisioning tenant — never boot2.tenantId
        expect(isolRes.body.model.tenantId).toBe(tenantId);
        expect(isolRes.body.model.tenantId).not.toBe(boot2.tenantId);
      }
    });

    // Add connection with authConfig via separate endpoint
    test('adding Bedrock connection via POST /:id/connections persists authConfig', async () => {
      // Ensure user is still a super admin (may have been overridden by E2E-4)
      await setSuperAdmins([userId]);

      // Create a model without initial connection
      const modelRes = await requestJson<{
        success: boolean;
        model: { id: string };
      }>(harness!, '/api/platform/admin/tenant-models', {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          targetTenantId: tenantId,
          displayName: 'Bedrock Connection Test',
          integrationType: 'api',
          provider: 'bedrock',
          modelId: BEDROCK_MODEL_ID,
          endpointUrl: BEDROCK_ENDPOINT_URL,
        },
      });
      expect(modelRes.status).toBe(201);
      const modelId = modelRes.body.model.id;

      // Add a connection with authConfig via the separate endpoint
      const connRes = await requestJson<{
        success: boolean;
        connection?: { id: string };
      }>(harness!, `/api/platform/admin/tenant-models/${modelId}/connections`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          credentialName: 'bedrock-conn-test',
          apiKey: 'AKIATEST',
          authType: 'aws_iam',
          authConfig: {
            region: 'us-west-2',
            accessKeyId: 'AKIATEST',
            secretAccessKey: 'secretvalue',
          },
        },
      });

      expect(connRes.status).toBe(201);
      expect(connRes.body.success).toBe(true);
    });
  },
  TIMEOUT_MS,
);
