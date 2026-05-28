import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import deploymentsRouter from '../../routes/deployments.js';
import projectIoRouter from '../../routes/project-io.js';
import channelConnectionsRouter from '../../routes/channel-connections.js';
import sessionsRouter from '../../routes/sessions.js';
import channelVxmlRouter from '../../routes/channel-vxml.js';
import channelGenesysRouter from '../../routes/channel-genesys.js';
import channelAudiocodesRouter from '../../routes/channel-audiocodes.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { disconnectRedis, initializeRedis } from '../../services/redis/redis-client.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createDeployment,
  createChannelConnection,
  createProject,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from '../helpers/redis-server-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const CONTEXT_AGENT_DSL = `
AGENT: Voice_Context_Agent

GOAL: "Collect caller context across multiple turns"

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

const ACTION_AGENT_DSL = `
AGENT: Genesys_Action_Agent
GOAL: "Handle action callbacks"
PERSONA: "Helpful"

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirmed
    - cancelled

ask:
  REASONING: false
  RESPOND: "Confirm order?"
    ACTIONS:
      - BUTTON: "Yes" -> confirm_yes
      - BUTTON: "No" -> confirm_no
  ON_ACTION:
    confirm_yes:
      SET: choice = yes
      RESPOND: "Order confirmed!"
      TRANSITION: confirmed
    confirm_no:
      RESPOND: "Order cancelled."
      TRANSITION: cancelled

confirmed:
  REASONING: false
  RESPOND: "Processing your order. choice={{choice}}"
  THEN: COMPLETE

cancelled:
  REASONING: false
  RESPOND: "Goodbye."
  THEN: COMPLETE
`;

const GATHER_INTERRUPT_SUPERVISOR_FIXTURE = new URL(
  '../fixtures/gather-interrupt/supervisor.abl',
  import.meta.url,
);
const GATHER_INTERRUPT_CHILD_FIXTURE = new URL(
  '../fixtures/gather-interrupt/child-gather.abl',
  import.meta.url,
);

const GATHER_INTERRUPT_SIBLING_DSL = `
AGENT: BranchLocatorSibling

GOAL: "Help find nearby branches"

FLOW:
  entry_point: respond_location
  steps:
    - respond_location

respond_location:
  REASONING: false
  RESPOND: "I can help find branches nearby."
  THEN: COMPLETE
`;

const GATHER_INTERRUPT_ENTRY_MESSAGE = 'start destination collection';
const GATHER_INTERRUPT_REROUTE_MESSAGE = 'show me nearby branches';
const GATHER_INTERRUPT_PROJECT_MANIFEST = JSON.stringify({
  format_version: '2.0',
  entry_agent: 'GatherInterruptSupervisor',
  agents: [
    {
      name: 'GatherInterruptSupervisor',
      file: 'agents/gather-interrupt-supervisor.agent.abl',
    },
    {
      name: 'ChildGatherFlow',
      file: 'agents/gather-interrupt-child.agent.abl',
    },
    {
      name: 'BranchLocatorSibling',
      file: 'agents/gather-interrupt-sibling.agent.abl',
    },
  ],
  tools: [],
});

const OVERSIZED_SESSION_METADATA = {
  big: 'x'.repeat(70_000),
};

async function loadFixture(path: URL): Promise<string> {
  return readFile(path, 'utf8');
}

async function postForm(
  harness: RuntimeApiHarness,
  path: string,
  form: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });

  return {
    status: response.status,
    text: await response.text(),
  };
}

const describeVoiceChannelIngressE2E = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeVoiceChannelIngressE2E('Voice channel ingress E2E', () => {
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;
  let redis: RedisServerHarness;

  beforeAll(async () => {
    redis = await startRedisServerHarness();
    mockLlm = await startMockLLM();

    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/deployments', deploymentsRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/projects/:projectId/sessions', sessionsRouter);
        app.use('/api/v1/channels/vxml', channelVxmlRouter);
        app.use('/api/v1/channels/genesys', channelGenesysRouter);
        app.use('/api/v1/channels/audiocodes', channelAudiocodesRouter);
      },
      {
        REDIS_ENABLED: 'true',
        REDIS_URL: redis.url,
      },
      {
        requireAsyncInfra: false,
      },
    );

    await initializeRedis();
  });

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await redis.clear();
    await setSuperAdmins([]);
    mockLlm.reset();
  });

  afterAll(async () => {
    await disconnectRedis();
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (redis) await redis.close();
  });

  test('VXML enforces ingress token auth and preserves multi-turn call context', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-vxml-admin'),
      uniqueSlug('tenant-vxml'),
      uniqueSlug('project-vxml'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/voice-context.agent.abl': CONTEXT_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Voice Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-voice-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-voice-model',
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

    const streamId = uniqueSlug('voice-vxml-stream');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_vxml',
      display_name: 'Test Voice VXML',
      external_identifier: streamId,
      config: {
        inboundAuthToken: 'vxml-secret',
        publicBaseUrl: 'https://voice.example.com',
      },
    });

    const unauthorized = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}`,
      {
        callId: 'call-1',
        userinput: 'hello',
      },
    );

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.text).toContain('Unauthorized request.');

    const firstTurn = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}?token=vxml-secret`,
      {
        callId: 'call-1',
      },
    );

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.text).toContain('name');
    expect(firstTurn.text).toContain(
      `https://voice.example.com/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}?token=vxml-secret`,
    );
    expect(firstTurn.text).not.toContain(harness.baseUrl);

    const secondTurn = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}?token=vxml-secret`,
      {
        callId: 'call-1',
        userinput: 'Alice',
      },
    );

    expect(secondTurn.status).toBe(200);
    expect(secondTurn.text).toContain('topic');

    const thirdTurn = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}?token=vxml-secret`,
      {
        callId: 'call-1',
        userinput: 'tenant isolation',
      },
    );

    expect(thirdTurn.status).toBe(200);
    expect(thirdTurn.text).toContain('Summary for Alice about tenant isolation.');

    const sessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${admin.projectId}/sessions?channel=voice_vxml`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${admin.token}`,
      },
    });

    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);
  }, 90_000);

  test('VXML preserves gather-interrupt reroute parity and trace contract', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-gather-admin'),
      uniqueSlug('tenant-voice-gather'),
      uniqueSlug('project-voice-gather'),
    );

    const supervisorDsl = await loadFixture(GATHER_INTERRUPT_SUPERVISOR_FIXTURE);
    const childDsl = await loadFixture(GATHER_INTERRUPT_CHILD_FIXTURE);

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'project.json': GATHER_INTERRUPT_PROJECT_MANIFEST,
      'agents/gather-interrupt-supervisor.agent.abl': supervisorDsl,
      'agents/gather-interrupt-child.agent.abl': childDsl,
      'agents/gather-interrupt-sibling.agent.abl': GATHER_INTERRUPT_SIBLING_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Gather Interrupt Voice Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-gather-interrupt-voice-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-gather-interrupt-voice-model',
        apiKey: 'test-api-key',
      },
    });

    const deployment = await createDeployment(harness, admin.token, admin.projectId, {
      environment: 'staging',
      agentVersionManifest: {
        GatherInterruptSupervisor: 'auto',
        ChildGatherFlow: 'auto',
        BranchLocatorSibling: 'auto',
      },
      entryAgentName: 'GatherInterruptSupervisor',
      label: 'Gather Interrupt Voice Deployment',
      force: true,
    });

    mockLlm.registerToolCall(GATHER_INTERRUPT_ENTRY_MESSAGE, {
      name: 'handoff_to_ChildGatherFlow',
      arguments: {
        reason: 'The child gather flow should collect the destination first.',
        message: 'I need to collect a destination.',
      },
      followUpContent: 'Let me collect your destination first.',
    });

    const streamId = uniqueSlug('voice-gather-vxml-stream');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_vxml',
      display_name: 'Gather Interrupt Voice VXML',
      external_identifier: streamId,
      deployment_id: deployment.id,
      config: {
        inboundAuthToken: 'voice-gather-secret',
        publicBaseUrl: 'https://voice.example.com',
      },
    });

    const firstTurn = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}?token=voice-gather-secret`,
      {
        callId: 'gather-call-1',
        userinput: GATHER_INTERRUPT_ENTRY_MESSAGE,
      },
    );

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.text).toContain('destination');

    const sessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${admin.projectId}/sessions?channel=voice_vxml`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${admin.token}`,
      },
    });

    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);

    const sessionId = sessions.body.sessions[0]?.id;
    expect(sessionId).toBeTruthy();

    const secondTurn = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}?token=voice-gather-secret`,
      {
        callId: 'gather-call-1',
        userinput: GATHER_INTERRUPT_REROUTE_MESSAGE,
      },
    );

    expect(secondTurn.status).toBe(200);
    expect(secondTurn.text).toContain('I can help find branches nearby.');

    const detail = await requestJson<{
      success: boolean;
      session: {
        id: string;
        traceEvents: Array<{ type: string; data: Record<string, unknown> }>;
      };
    }>(harness, `/api/projects/${admin.projectId}/sessions/${encodeURIComponent(sessionId!)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${admin.token}`,
      },
    });

    expect(detail.status).toBe(200);
    expect(detail.body.success).toBe(true);
    expect(detail.body.session.id).toBe(sessionId);
    expect(detail.body.session.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'digression',
          data: expect.objectContaining({
            intent: 'branch_locator',
            detectionMode: 'lexical',
            lexicalMatchType: 'normalized',
            target: 'BranchLocatorSibling',
          }),
        }),
        expect.objectContaining({
          type: 'return_to_parent',
          data: expect.objectContaining({
            from: 'ChildGatherFlow',
            to: 'GatherInterruptSupervisor',
            forwardedMessage: GATHER_INTERRUPT_REROUTE_MESSAGE,
          }),
        }),
      ]),
    );
  }, 90_000);

  test('AudioCodes init provisions only token-scoped callback URLs while query-token fallback remains live', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-audiocodes-admin'),
      uniqueSlug('tenant-audiocodes'),
      uniqueSlug('project-audiocodes'),
    );

    const identifier = uniqueSlug('voice-audiocodes');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'audiocodes',
      display_name: 'Test AudioCodes',
      external_identifier: identifier,
      credentials: {
        inboundAuthToken: 'audiocodes-secret',
      },
    });

    const unauthorized = await fetch(
      `${harness.baseUrl}/api/v1/channels/audiocodes/webhook/${encodeURIComponent(identifier)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation: 'conv-1' }),
      },
    );

    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(
      `${harness.baseUrl}/api/v1/channels/audiocodes/webhook/${encodeURIComponent(identifier)}?token=audiocodes-secret`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation: 'conv-1' }),
      },
    );

    expect(authorized.status).toBe(200);

    const payload = (await authorized.json()) as {
      activitiesURL: string;
      refreshURL: string;
      disconnectURL: string;
      websocketURL: string;
    };

    expect(payload.activitiesURL).toContain('?token=audiocodes-secret');
    expect(payload.refreshURL).toContain('?token=audiocodes-secret');
    expect(payload.disconnectURL).toContain('?token=audiocodes-secret');
    expect(payload.websocketURL).toContain('?token=audiocodes-secret');
  });

  test('rejects VXML ingress when no shared secret is configured', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-vxml-config-admin'),
      uniqueSlug('tenant-vxml-config'),
      uniqueSlug('project-vxml-config'),
    );

    const streamId = uniqueSlug('voice-vxml-config-stream');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_vxml',
      display_name: 'Unconfigured Voice VXML',
      external_identifier: streamId,
      config: {
        publicBaseUrl: 'https://voice.example.com',
      },
    });

    const response = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}`,
      {
        callId: 'call-unconfigured',
      },
    );

    expect(response.status).toBe(503);
    expect(response.text).toContain('Channel ingress is not configured.');
  });

  test('rejects oversized VXML sessionMetadata with a 413 XML boundary error', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-vxml-metadata-admin'),
      uniqueSlug('tenant-vxml-metadata'),
      uniqueSlug('project-vxml-metadata'),
    );

    const streamId = uniqueSlug('voice-vxml-metadata-stream');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_vxml',
      display_name: 'Voice VXML Metadata Guard',
      external_identifier: streamId,
      config: {
        inboundAuthToken: 'vxml-metadata-secret',
        publicBaseUrl: 'https://voice.example.com',
      },
    });

    const response = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamId)}?token=vxml-metadata-secret`,
      {
        callId: 'call-metadata-1',
        userinput: 'hello',
        sessionMetadata: JSON.stringify(OVERSIZED_SESSION_METADATA),
      },
    );

    expect(response.status).toBe(413);
    expect(response.text).toContain('sessionMetadata exceeds maximum size');
  });

  test('Genesys enforces bearer auth and round-trips structured quick replies', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-genesys-admin'),
      uniqueSlug('tenant-genesys'),
      uniqueSlug('project-genesys'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/genesys-action.agent.abl': ACTION_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Genesys Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-genesys-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-genesys-model',
        apiKey: 'test-api-key',
      },
    });

    const streamId = uniqueSlug('genesys-stream');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'genesys',
      display_name: 'Test Genesys',
      external_identifier: streamId,
      credentials: {
        client_secret: 'genesys-secret',
      },
    });

    const unauthorized = await requestJson<{
      error: { code: string; message: string };
    }>(harness, `/api/v1/channels/genesys/hooks/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      body: {
        genesysConversationId: 'conv-1',
        inputMessage: {
          type: 'Text',
          text: 'hello',
        },
      },
    });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.code).toBe('UNAUTHORIZED');

    const firstTurn = await requestJson<{
      replymessages: Array<{
        type: string;
        text: string;
        content?: Array<{
          contentType: string;
          quickReply: { text: string; payload: string };
        }>;
      }>;
    }>(harness, `/api/v1/channels/genesys/hooks/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer genesys-secret',
      },
      body: {
        genesysConversationId: 'conv-1',
        inputMessage: {
          type: 'Text',
          text: 'hello',
        },
      },
    });

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.body.replymessages[0].type).toBe('Structured');
    expect(firstTurn.body.replymessages[0].text).toContain('Confirm order?');
    expect(firstTurn.body.replymessages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentType: 'QuickReply',
          quickReply: expect.objectContaining({ payload: 'confirm_yes' }),
        }),
      ]),
    );

    const secondTurn = await requestJson<{
      replymessages: Array<{ type: string; text: string }>;
    }>(harness, `/api/v1/channels/genesys/hooks/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer genesys-secret',
      },
      body: {
        genesysConversationId: 'conv-1',
        inputMessage: {
          type: 'Structured',
          buttonResponse: {
            payload: 'confirm_yes',
          },
        },
      },
    });

    expect(secondTurn.status).toBe(200);
    expect(secondTurn.body.replymessages[0].text).toContain('Processing your order');
    expect(secondTurn.body.replymessages[0].text).toContain('choice=yes');

    const sessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${admin.projectId}/sessions?channel=genesys`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${admin.token}`,
      },
    });

    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);
  });

  test('rejects Genesys ingress when no bearer secret is configured', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-genesys-config-admin'),
      uniqueSlug('tenant-genesys-config'),
      uniqueSlug('project-genesys-config'),
    );

    const streamId = uniqueSlug('genesys-config-stream');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'genesys',
      display_name: 'Unconfigured Genesys',
      external_identifier: streamId,
    });

    const response = await requestJson<{
      error: { code: string; message: string };
    }>(harness, `/api/v1/channels/genesys/hooks/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      body: {
        genesysConversationId: 'conv-unconfigured',
        inputMessage: {
          type: 'Text',
          text: 'hello',
        },
      },
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('NOT_CONFIGURED');
    expect(response.body.error.message).toBe('Channel ingress is not configured.');
  });

  test('rejects oversized Genesys sessionMetadata with a 413 boundary error', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-genesys-metadata-admin'),
      uniqueSlug('tenant-genesys-metadata'),
      uniqueSlug('project-genesys-metadata'),
    );

    const streamId = uniqueSlug('genesys-metadata-stream');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'genesys',
      display_name: 'Genesys Metadata Guard',
      external_identifier: streamId,
      credentials: {
        client_secret: 'genesys-metadata-secret',
      },
    });

    const response = await requestJson<{
      success: false;
      error: { code: string; message: string };
    }>(harness, `/api/v1/channels/genesys/hooks/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer genesys-metadata-secret',
      },
      body: {
        genesysConversationId: 'conv-metadata-1',
        inputMessage: {
          type: 'Text',
          text: 'hello',
        },
        sessionMetadata: OVERSIZED_SESSION_METADATA,
      },
    });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('rejects oversized AudioCodes sessionMetadata with a deterministic 413 response', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-audiocodes-metadata-admin'),
      uniqueSlug('tenant-audiocodes-metadata'),
      uniqueSlug('project-audiocodes-metadata'),
    );

    const identifier = uniqueSlug('voice-audiocodes-metadata');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'audiocodes',
      display_name: 'AudioCodes Metadata Guard',
      external_identifier: identifier,
      credentials: {
        inboundAuthToken: 'audiocodes-metadata-secret',
      },
    });

    const response = await fetch(
      `${harness.baseUrl}/api/v1/channels/audiocodes/webhook/${encodeURIComponent(identifier)}/conversation/conv-metadata-1/activities?token=audiocodes-metadata-secret`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation: 'conv-metadata-1',
          activities: [
            {
              type: 'message',
              text: 'hello',
              sessionParams: {
                sessionMetadata: OVERSIZED_SESSION_METADATA,
              },
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      success: false;
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('keeps voice sessions isolated per channel connection even when external call ids collide inside the same tenant', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('voice-isolation-admin'),
      uniqueSlug('tenant-voice-isolation'),
      uniqueSlug('project-voice-isolation-a'),
    );

    const projectB = await createProject(
      harness,
      admin.token,
      admin.tenantId,
      `${uniqueSlug('project-voice-isolation-b')} Name`,
      uniqueSlug('project-voice-isolation-b'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/voice-context.agent.abl': CONTEXT_AGENT_DSL,
    });
    await importProjectFiles(harness, admin.token, projectB._id, {
      'agents/voice-context.agent.abl': CONTEXT_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Voice Isolation Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-voice-isolation-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-voice-isolation-model',
        apiKey: 'test-api-key',
      },
    });

    const streamA = uniqueSlug('voice-isolation-stream-a');
    const streamB = uniqueSlug('voice-isolation-stream-b');

    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_vxml',
      display_name: 'Voice Isolation A',
      external_identifier: streamA,
      config: {
        inboundAuthToken: 'voice-isolation-secret-a',
        publicBaseUrl: 'https://voice-a.example.com',
      },
    });

    await createChannelConnection(harness, admin.token, projectB._id, {
      channel_type: 'voice_vxml',
      display_name: 'Voice Isolation B',
      external_identifier: streamB,
      config: {
        inboundAuthToken: 'voice-isolation-secret-b',
        publicBaseUrl: 'https://voice-b.example.com',
      },
    });

    const sharedCallId = 'shared-call-1';

    const firstProjectTurn = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamA)}?token=voice-isolation-secret-a`,
      {
        callId: sharedCallId,
      },
    );
    expect(firstProjectTurn.status).toBe(200);

    const secondProjectTurn = await postForm(
      harness,
      `/api/v1/channels/vxml/hooks/${encodeURIComponent(streamB)}?token=voice-isolation-secret-b`,
      {
        callId: sharedCallId,
      },
    );
    expect(secondProjectTurn.status).toBe(200);

    const projectASessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${admin.projectId}/sessions?channel=voice_vxml`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${admin.token}`,
      },
    });

    const projectBSessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${projectB._id}/sessions?channel=voice_vxml`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${admin.token}`,
      },
    });

    expect(projectASessions.status).toBe(200);
    expect(projectBSessions.status).toBe(200);
    expect(projectASessions.body.sessions).toHaveLength(1);
    expect(projectBSessions.body.sessions).toHaveLength(1);
    expect(projectASessions.body.sessions[0].id).not.toBe(projectBSessions.body.sessions[0].id);
  });
});
