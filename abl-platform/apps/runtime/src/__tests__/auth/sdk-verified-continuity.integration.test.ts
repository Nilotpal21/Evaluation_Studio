import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { getRuntimeExecutor } from '../../services/runtime-executor.js';
import {
  bootstrapProject,
  createSdkChannelDetailed,
  createSdkChannel,
  createSdkCustomerSession,
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
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';

const PREFLIGHT_AGENT_DSL = `
AGENT: verified_continuity_agent
GOAL: "Require preflight before execution"

TOOLS:
  oauth_lookup(query: string) -> Result
    auth_profile: "google-creds"
    consent: preflight
    description: "Requires preflight auth"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "This should not execute until auth is satisfied."
  THEN: COMPLETE
`;

async function settleAsyncPersistence(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function setupVerifiedContinuityProject(harness: RuntimeApiHarness): Promise<{
  admin: { token: string; tenantId: string; projectId: string };
  primaryChannel: { id: string; serverSecret: string };
  secondaryChannel: { id: string; serverSecret: string };
}> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail('sdk-verified-continuity-admin'),
    uniqueSlug('tenant-sdk-verified-continuity'),
    uniqueSlug('project-sdk-verified-continuity'),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, {
    'agents/verified-continuity.agent.abl': PREFLIGHT_AGENT_DSL,
  });

  await provisionTenantModel(harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: 'Verified Continuity Model',
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'verified-continuity-model',
    endpointUrl: 'https://example.com/v1',
    supportsStreaming: false,
    supportsTools: true,
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: 'verified-continuity-model',
      apiKey: 'verified-continuity-api-key',
    },
  });

  const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
    name: 'Verified Continuity SDK Key',
    permissions: { chat: true, voice: false },
  });

  const primaryChannel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
    name: 'verified-primary',
    channelType: 'web',
    publicApiKeyId: publicKey.id,
    auth: {
      mode: 'hosted_exchange',
    },
  });

  const secondaryChannel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
    name: 'verified-secondary',
    channelType: 'web',
    publicApiKeyId: publicKey.id,
    auth: {
      mode: 'hosted_exchange',
    },
  });

  return {
    admin,
    primaryChannel: {
      id: primaryChannel.channel.id,
      serverSecret: primaryChannel.serverSecret!,
    },
    secondaryChannel: {
      id: secondaryChannel.channel.id,
      serverSecret: secondaryChannel.serverSecret!,
    },
  };
}

async function issueVerifiedSdkToken(
  harness: RuntimeApiHarness,
  params: {
    tenantId: string;
    projectId: string;
    channelId: string;
    channelSecret: string;
    verifiedUserId: string;
  },
) {
  const customerSession = await createSdkCustomerSession(harness, {
    tenantId: params.tenantId,
    projectId: params.projectId,
    channelId: params.channelId,
    channelSecret: params.channelSecret,
    verifiedUserId: params.verifiedUserId,
  });

  return initSdkSession(harness, {
    bootstrapToken: customerSession.bootstrapToken,
  });
}

describe('verified SDK identity continuity guardrails over HTTP chat', () => {
  let harness!: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness({}, { autoIndex: false });
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await harness.close();
  }, 120_000);

  test('fails closed and creates a new HTTP session when verified SDK continuity is unavailable on a non-distributed store', async () => {
    const { admin, primaryChannel, secondaryChannel } =
      await setupVerifiedContinuityProject(harness);

    const primaryTokenA = await issueVerifiedSdkToken(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelId: primaryChannel.id,
      channelSecret: primaryChannel.serverSecret,
      verifiedUserId: 'verified-user-42',
    });

    const firstTurn = await requestJson<{
      sessionId: string;
      action?: { type: string };
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(primaryTokenA.token),
      body: {
        projectId: admin.projectId,
        message: 'start verified continuity session',
      },
    });

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.body.sessionId).toBeTruthy();
    expect(firstTurn.body.action?.type).toBe('auth_required');

    await settleAsyncPersistence();

    const primaryTokenB = await issueVerifiedSdkToken(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelId: primaryChannel.id,
      channelSecret: primaryChannel.serverSecret,
      verifiedUserId: 'verified-user-42',
    });

    const resumedTurn = await requestJson<{
      sessionId: string;
      action?: { type: string };
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(primaryTokenB.token),
      body: {
        projectId: admin.projectId,
        message: 'resume verified continuity session',
      },
    });

    expect(resumedTurn.status).toBe(200);
    expect(resumedTurn.body.sessionId).not.toBe(firstTurn.body.sessionId);
    expect(resumedTurn.body.action?.type).toBe('auth_required');

    const secondaryToken = await issueVerifiedSdkToken(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelId: secondaryChannel.id,
      channelSecret: secondaryChannel.serverSecret,
      verifiedUserId: 'verified-user-42',
    });

    const otherChannelTurn = await requestJson<{
      sessionId: string;
      action?: { type: string };
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(secondaryToken.token),
      body: {
        projectId: admin.projectId,
        message: 'same verified user, different channel',
      },
    });

    expect(otherChannelTurn.status).toBe(200);
    expect(otherChannelTurn.body.action?.type).toBe('auth_required');
    expect(otherChannelTurn.body.sessionId).not.toBe(firstTurn.body.sessionId);
    expect(otherChannelTurn.body.sessionId).not.toBe(resumedTurn.body.sessionId);
  });

  test('does not artifact-rehydrate a verified HTTP session after pod-local eviction when continuity store is not distributed', async () => {
    const { admin, primaryChannel } = await setupVerifiedContinuityProject(harness);

    const sdkToken = await issueVerifiedSdkToken(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelId: primaryChannel.id,
      channelSecret: primaryChannel.serverSecret,
      verifiedUserId: 'verified-user-rehydrate',
    });

    const firstTurn = await requestJson<{
      sessionId: string;
      action?: { type: string };
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkToken.token),
      body: {
        projectId: admin.projectId,
        message: 'establish verified session before simulated pod handoff',
      },
    });

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.body.action?.type).toBe('auth_required');

    await settleAsyncPersistence();

    const executor = getRuntimeExecutor() as unknown as {
      getSession(sessionId: string): unknown;
      sessions: Map<string, unknown>;
    };
    // Simulate a pod-local cache miss while leaving the persisted SessionService state intact.
    expect(executor.getSession(firstTurn.body.sessionId)).toBeTruthy();
    expect(executor.sessions.delete(firstTurn.body.sessionId)).toBe(true);
    expect(executor.getSession(firstTurn.body.sessionId)).toBeUndefined();

    const resumedTurn = await requestJson<{
      sessionId: string;
      action?: { type: string };
      response?: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(sdkToken.token),
      body: {
        projectId: admin.projectId,
        message: 'resume after simulated pod-local eviction',
      },
    });

    expect(resumedTurn.status).toBe(200);
    expect(resumedTurn.body.sessionId).not.toBe(firstTurn.body.sessionId);
    expect(resumedTurn.body.action?.type).toBe('auth_required');
    expect(resumedTurn.body.response).toBe(
      'Authorization is required before the agent can continue.',
    );
  });
});
