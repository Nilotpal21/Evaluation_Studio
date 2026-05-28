import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { signSdkBootstrapArtifact } from '@agent-platform/shared';
import type { SDKSessionTokenPayload } from '@agent-platform/shared-auth';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
  TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createDeployment,
  createSdkBootstrapChannel,
  createSdkChannelDetailed,
  createSdkChannel,
  createSdkCustomerSession,
  createSdkPublicKey,
  initSdkSession,
  importProjectFiles,
  requestJson,
  sdkHeaders,
  setSuperAdmins,
  type SdkInitResult,
  updateSdkChannel,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import { verifyRuntimeSdkSessionForAuth } from '../../services/identity/sdk-session-token-auth.js';

const SDK_DEPLOYMENT_AGENT_DSL = `
AGENT: Channel_Context_Agent

GOAL: "Answer helpfully"

FLOW:
  entry_point: answer
  steps:
    - answer

answer:
  REASONING: false
  RESPOND: "Hello from the deployment-bound preview."
  THEN: COMPLETE
`;

function verifySdkToken(token: string): SDKSessionTokenPayload {
  return jwt.verify(token, TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET, {
    issuer: 'abl-platform',
    audience: 'sdk-session',
  }) as SDKSessionTokenPayload;
}

async function verifyRuntimeSdkToken(token: string): Promise<SDKSessionTokenPayload> {
  const verified = await verifyRuntimeSdkSessionForAuth(token);
  expect(verified.success).toBe(true);
  if (!verified.success) {
    throw new Error(`Expected SDK session token to verify: ${verified.error}`);
  }
  return verified.payload;
}

function tokenSegmentCount(token: string): number {
  return token.split('.').length;
}

function issueExpiredSdkSessionToken(token: string): string {
  const payload = verifySdkToken(token) as SDKSessionTokenPayload & { iat?: number; exp?: number };
  const {
    iat: _iat,
    exp: _exp,
    aud: _aud,
    iss: _iss,
    ...unsignedPayload
  } = payload as {
    iat?: number;
    exp?: number;
    aud?: string | string[];
    iss?: string;
  } & SDKSessionTokenPayload;

  return jwt.sign(unsignedPayload, TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET, {
    issuer: 'abl-platform',
    audience: 'sdk-session',
    expiresIn: -5,
  });
}

describe('SDK bootstrap auth integration', () => {
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

  test('enforces origin allowlists during sdk init and issues scoped chat permissions', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-origin-admin'),
      uniqueSlug('tenant-sdk-origin'),
      uniqueSlug('project-sdk-origin'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Origin Locked SDK Key',
      allowedOrigins: ['https://allowed.example'],
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const missingOrigin = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': key.key!,
      },
      body: {},
    });

    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.body.error).toBe('Origin not allowed');

    const disallowedOrigin = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': key.key!,
        Origin: 'https://blocked.example',
      },
      body: {},
    });

    expect(disallowedOrigin.status).toBe(403);
    expect(disallowedOrigin.body.error).toBe('Origin not allowed');

    const allowedSession = await initSdkSession(harness, {
      publicKey: key.key!,
      origin: 'https://allowed.example',
      userContext: { userId: 'origin-locked-user' },
    });

    expect(allowedSession.permissions).toEqual(
      expect.arrayContaining([
        'session:send_message',
        'session:read',
        'attachment:read',
        'attachment:write',
        'attachment:delete',
      ]),
    );
    expect(allowedSession.permissions).not.toContain('session:voice');

    const payload = verifySdkToken(allowedSession.token);
    expect(payload.projectId).toBe(admin.projectId);
    expect(payload.tenantId).toBe(admin.tenantId);
    expect(payload.sessionId).toBeTruthy();
    expect(payload.sessionPrincipal).toBe(payload.sessionId);
    expect(payload.authScope).toBe('session');
    expect(payload.identityTier).toBe(0);
    expect(payload.verifiedUserId).toBeUndefined();
    expect(payload.userContext?.userId).toBe('origin-locked-user');
    expect(payload.permissions).toEqual(allowedSession.permissions);

    const scopedSessions = await requestJson<{
      success: boolean;
      sessions: Array<unknown>;
    }>(harness, `/api/projects/${admin.projectId}/sessions`, {
      method: 'GET',
      headers: sdkHeaders(allowedSession.token),
    });

    expect(scopedSessions.status).toBe(200);
    expect(scopedSessions.body.success).toBe(true);
    expect(scopedSessions.body.sessions).toEqual([]);
  }, 90_000);

  test('treats unsigned userContext as metadata and mints unique session principals', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-metadata-admin'),
      uniqueSlug('tenant-sdk-metadata'),
      uniqueSlug('project-sdk-metadata'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Metadata Only SDK Key',
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const sessionA = await initSdkSession(harness, {
      publicKey: key.key!,
      userContext: {
        userId: 'shared-metadata-user',
        customAttributes: { locale: 'en-US', plan: 'free' },
      },
    });
    const sessionB = await initSdkSession(harness, {
      publicKey: key.key!,
      userContext: {
        userId: 'shared-metadata-user',
        customAttributes: { locale: 'en-US', plan: 'free' },
      },
    });

    const payloadA = verifySdkToken(sessionA.token);
    const payloadB = verifySdkToken(sessionB.token);

    expect(payloadA.userContext).toEqual({
      userId: 'shared-metadata-user',
      customAttributes: { locale: 'en-US', plan: 'free' },
    });
    expect(payloadA.verifiedUserId).toBeUndefined();
    expect(payloadA.authScope).toBe('session');
    expect(payloadA.identityTier).toBe(0);
    expect(payloadA.sessionId).toBeTruthy();
    expect(payloadA.sessionPrincipal).toBe(payloadA.sessionId);
    expect(payloadB.sessionId).toBeTruthy();
    expect(payloadB.sessionPrincipal).toBe(payloadB.sessionId);
    expect(payloadB.sessionId).not.toBe(payloadA.sessionId);
  });

  test('rejects oversized userContext values at the request boundary', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-validation-admin'),
      uniqueSlug('tenant-sdk-validation'),
      uniqueSlug('project-sdk-validation'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Validated SDK Key',
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const invalidInit = await requestJson<{
      error: string;
      message: string;
      issues: string[];
    }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': key.key!,
      },
      body: {
        userContext: {
          customAttributes: {
            note: 'x'.repeat(600),
          },
        },
      },
    });

    expect(invalidInit.status).toBe(400);
    expect(invalidInit.body.error).toBe('INVALID_USER_CONTEXT');
    expect(invalidInit.body.issues[0]).toContain('customAttributes.note');
  });

  test('rejects customer bootstrap tokens combined with browser userContext', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-customer-bootstrap-guard-admin'),
      uniqueSlug('tenant-sdk-customer-bootstrap-guard'),
      uniqueSlug('project-sdk-customer-bootstrap-guard'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Customer Bootstrap Guard SDK Key',
      permissions: { chat: true, voice: false },
    });
    const hostedChannel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
      name: 'customer-bootstrap-guard',
      channelType: 'web',
      publicApiKeyId: key.id,
      auth: { mode: 'hosted_exchange' },
    });
    expect(hostedChannel.serverSecret).toMatch(/^sk_[0-9a-f]+$/);

    const customerSession = await createSdkCustomerSession(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelId: hostedChannel.channel.id,
      channelSecret: hostedChannel.serverSecret!,
      verifiedUserId: 'verified-user-1',
      customAttributes: { locale: 'en-US' },
    });

    const invalidInit = await requestJson<{
      error: string;
      message: string;
    }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        bootstrapToken: customerSession.bootstrapToken,
        userContext: { userId: 'sdk-user' },
      },
    });

    expect(invalidInit.status).toBe(400);
    expect(invalidInit.body.error).toBe('INVALID_BOOTSTRAP_REQUEST');
    expect(invalidInit.body.message).toBe(
      'Customer bootstrap tokens cannot be combined with browser userContext',
    );
  });

  test('encrypts hosted exchange bootstrap tokens for jwe_required channels and accepts them in sdk init', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-jwe-bootstrap-admin'),
      uniqueSlug('tenant-sdk-jwe-bootstrap'),
      uniqueSlug('project-sdk-jwe-bootstrap'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'JWE Bootstrap SDK Key',
      permissions: { chat: true, voice: false },
    });
    const hostedChannel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
      name: 'jwe-bootstrap-required',
      channelType: 'web',
      publicApiKeyId: key.id,
      config: { sdkTokenEnvelopePolicy: 'jwe_required' },
      auth: { mode: 'hosted_exchange' },
    });
    expect(hostedChannel.serverSecret).toMatch(/^sk_[0-9a-f]+$/);

    const customerSession = await createSdkCustomerSession(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelId: hostedChannel.channel.id,
      channelSecret: hostedChannel.serverSecret!,
      verifiedUserId: 'verified-jwe-user',
      customAttributes: { policyId: 'sensitive-policy-123' },
    });

    expect(customerSession.tokenEnvelope).toBe('jwe');
    expect(tokenSegmentCount(customerSession.bootstrapToken)).toBe(5);
    expect(customerSession.bootstrapToken).not.toContain('verified-jwe-user');
    expect(customerSession.bootstrapToken).not.toContain('sensitive-policy-123');

    const init = await initSdkSession(harness, {
      bootstrapToken: customerSession.bootstrapToken,
    });
    expect(init.channelId).toBe(hostedChannel.channel.id);

    const payload = await verifyRuntimeSdkToken(init.token);
    expect(payload.bootstrapType).toBe('customer');
    expect(payload.verifiedUserId).toBe('verified-jwe-user');
    expect(payload.userContext?.customAttributes).toEqual({ policyId: 'sensitive-policy-123' });
  });

  test('rejects signed hosted exchange bootstrap artifacts when the channel requires JWE', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-jwe-required-signed-admin'),
      uniqueSlug('tenant-sdk-jwe-required-signed'),
      uniqueSlug('project-sdk-jwe-required-signed'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Strict JWE SDK Key',
      permissions: { chat: true, voice: false },
    });
    const hostedChannel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
      name: 'strict-jwe-bootstrap',
      channelType: 'web',
      publicApiKeyId: key.id,
      config: { sdkTokenEnvelopePolicy: 'jwe_required' },
      auth: { mode: 'hosted_exchange' },
    });

    const signedBootstrap = signSdkBootstrapArtifact(
      {
        type: 'customer',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: hostedChannel.channel.id,
        permissions: ['session:send_message', 'session:read'],
        exp: Date.now() + 60_000,
        verifiedUserId: 'signed-strict-user',
        channelArtifact: 'signed-strict-artifact',
        jti: uniqueSlug('signed-strict-jti'),
      },
      TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
    );

    const init = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      body: { bootstrapToken: signedBootstrap },
    });

    expect(init.status).toBe(401);
    expect(init.body.error).toBe('Invalid or expired bootstrap token');
  });

  test('uses project hosted exchange JWE default when a channel inherits token policy', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-jwe-project-default-admin'),
      uniqueSlug('tenant-sdk-jwe-project-default'),
      uniqueSlug('project-sdk-jwe-project-default'),
    );

    const settings = await requestJson<{ success: boolean }>(
      harness,
      `/api/projects/${admin.projectId}/settings`,
      {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          sdkDefaults: {
            hostedExchangeTokenEnvelopePolicy: 'jwe_required',
          },
        },
      },
    );
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect(settings.body.success).toBe(true);

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Project Default JWE SDK Key',
      permissions: { chat: true, voice: false },
    });
    const hostedChannel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
      name: 'project-default-jwe-bootstrap',
      channelType: 'web',
      publicApiKeyId: key.id,
      config: {},
      auth: { mode: 'hosted_exchange' },
    });

    const customerSession = await createSdkCustomerSession(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelId: hostedChannel.channel.id,
      channelSecret: hostedChannel.serverSecret!,
      verifiedUserId: 'project-default-jwe-user',
    });

    expect(customerSession.tokenEnvelope).toBe('jwe');
    expect(tokenSegmentCount(customerSession.bootstrapToken)).toBe(5);
  });

  test('rejects malformed sdk init bootstrap fields with deterministic 400 responses', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-shape-validation-admin'),
      uniqueSlug('tenant-sdk-shape-validation'),
      uniqueSlug('project-sdk-shape-validation'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Shape Validated SDK Key',
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const invalidInit = await requestJson<{
      error: string;
      message: string;
      issues: string[];
    }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': key.key!,
      },
      body: {
        deploymentSlug: 42,
        channelId: 42,
        channelName: { invalid: true },
        bootstrapToken: 123,
      },
    });

    expect(invalidInit.status).toBe(400);
    expect(invalidInit.body.error).toBe('VALIDATION_ERROR');
    expect(invalidInit.body.message).toBe('Invalid SDK init request body');
    expect(invalidInit.body.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('deploymentSlug'),
        expect.stringContaining('channelId'),
        expect.stringContaining('channelName'),
        expect.stringContaining('bootstrapToken'),
      ]),
    );
  });

  test('requires public keys to bootstrap through an active bound SDK channel', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-channel-binding-admin'),
      uniqueSlug('tenant-sdk-channel-binding'),
      uniqueSlug('project-sdk-channel-binding'),
    );

    const keyA = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Key A',
      permissions: { chat: true, voice: false },
    });

    const keyB = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Key B',
      permissions: { chat: true, voice: false },
    });

    const missingChannel = await requestJson<{ error: string; message: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Public-Key': keyA.key!,
        },
        body: {},
      },
    );

    expect(missingChannel.status).toBe(409);
    expect(missingChannel.body.error).toBe('SDK channel not configured');

    const keyBChannel = await createSdkBootstrapChannel(
      harness,
      admin.token,
      admin.projectId,
      keyB.id,
      {
        name: 'key-b-web',
      },
    );

    const mismatchedChannel = await requestJson<{ error: string; message: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Public-Key': keyA.key!,
        },
        body: {
          channelId: keyBChannel.id,
        },
      },
    );

    expect(mismatchedChannel.status).toBe(404);
    expect(mismatchedChannel.body.error).toBe('SDK channel not found');

    const keyAChannel = await createSdkBootstrapChannel(
      harness,
      admin.token,
      admin.projectId,
      keyA.id,
      {
        name: 'key-a-web',
      },
    );

    const boundChannel = await initSdkSession(harness, {
      publicKey: keyA.key!,
      channelId: keyAChannel.id,
    });

    expect(boundChannel.channelId).toBeTruthy();
  });

  test('requires channelId or channelName when multiple active SDK channels are bound to the same public key', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-channel-ambiguity-admin'),
      uniqueSlug('tenant-sdk-channel-ambiguity'),
      uniqueSlug('project-sdk-channel-ambiguity'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Ambiguous Channel Key',
      permissions: { chat: true, voice: false },
    });

    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id, {
      name: 'default-web',
    });
    const backupChannel = await createSdkBootstrapChannel(
      harness,
      admin.token,
      admin.projectId,
      key.id,
      {
        name: 'backup-web',
      },
    );

    const ambiguousInit = await requestJson<{ error: string; message: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Public-Key': key.key!,
        },
        body: {},
      },
    );

    expect(ambiguousInit.status).toBe(409);
    expect(ambiguousInit.body.error).toBe('SDK channel is ambiguous');

    const namedInit = await initSdkSession(harness, {
      publicKey: key.key!,
      channelName: 'backup-web',
    });

    expect(namedInit.channelId).toBeTruthy();

    const idBoundInit = await initSdkSession(harness, {
      publicKey: key.key!,
      channelId: backupChannel.id,
    });

    expect(idBoundInit.channelId).toBe(backupChannel.id);
  });

  test('rejects channelId when it is combined with channelName during public-key bootstrap', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-channel-id-name-admin'),
      uniqueSlug('tenant-sdk-channel-id-name'),
      uniqueSlug('project-sdk-channel-id-name'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Channel ID and Name Key',
      permissions: { chat: true, voice: false },
    });
    const channel = await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id, {
      name: 'stable-channel',
    });

    const invalidInit = await requestJson<{ error: string; message: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Public-Key': key.key!,
        },
        body: {
          channelId: channel.id,
          channelName: channel.name,
        },
      },
    );

    expect(invalidInit.status).toBe(400);
    expect(invalidInit.body.error).toBe('INVALID_BOOTSTRAP_REQUEST');
    expect(invalidInit.body.message).toBe('channelId cannot be combined with channelName');
  });

  test('rejects share bootstrap artifacts that claim an unknown or cross-project channel id', async () => {
    const owner = await bootstrapProject(
      harness,
      uniqueEmail('sdk-share-bootstrap-owner'),
      uniqueSlug('tenant-sdk-share-bootstrap'),
      uniqueSlug('project-sdk-share-bootstrap'),
    );

    const outsider = await bootstrapProject(
      harness,
      uniqueEmail('sdk-share-bootstrap-outsider'),
      uniqueSlug('tenant-sdk-share-bootstrap-outsider'),
      uniqueSlug('project-sdk-share-bootstrap-outsider'),
    );
    const ownerKey = await createSdkPublicKey(harness, owner.token, owner.projectId, {
      name: 'Owner Share Bootstrap Key',
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, owner.token, owner.projectId, ownerKey.id);
    const outsiderKey = await createSdkPublicKey(harness, outsider.token, outsider.projectId, {
      name: 'Outsider Share Bootstrap Key',
      permissions: { chat: true, voice: false },
    });
    const outsiderChannel = await createSdkBootstrapChannel(
      harness,
      outsider.token,
      outsider.projectId,
      outsiderKey.id,
    );

    const invalidChannelToken = signSdkBootstrapArtifact(
      {
        type: 'share',
        tenantId: owner.tenantId,
        projectId: owner.projectId,
        channelId: 'missing-channel-id',
        permissions: ['session:send_message'],
        exp: Date.now() + 60_000,
      },
      TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
    );

    const invalidChannelResponse = await requestJson<{ error: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          bootstrapToken: invalidChannelToken,
        },
      },
    );

    expect(invalidChannelResponse.status).toBe(404);
    expect(invalidChannelResponse.body.error).toBe('Channel not found');

    const crossProjectChannelToken = signSdkBootstrapArtifact(
      {
        type: 'share',
        tenantId: owner.tenantId,
        projectId: owner.projectId,
        channelId: outsiderChannel.id,
        permissions: ['session:send_message'],
        exp: Date.now() + 60_000,
      },
      TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
    );

    const crossProjectChannelResponse = await requestJson<{ error: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          bootstrapToken: crossProjectChannelToken,
        },
      },
    );

    expect(crossProjectChannelResponse.status).toBe(404);
    expect(crossProjectChannelResponse.body.error).toBe('Channel not found');
  });

  test('preview/share refresh fails when the bound SDK channel is deactivated', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-preview-refresh-admin'),
      uniqueSlug('tenant-sdk-preview-refresh'),
      uniqueSlug('project-sdk-preview-refresh'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Preview Refresh SDK Key',
      permissions: { chat: true, voice: false },
    });
    const channel = await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id, {
      name: 'preview-refresh-web',
    });

    const bootstrapToken = signSdkBootstrapArtifact(
      {
        type: 'share',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: channel.id,
        permissions: ['session:send_message'],
        exp: Date.now() + 60_000,
      },
      TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
    );

    const initial = await requestJson<{ token: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        bootstrapToken,
      },
    });

    expect(initial.status).toBe(200);

    await updateSdkChannel(harness, admin.token, admin.projectId, channel.id, {
      isActive: false,
    });

    const refresh = await requestJson<{ error: string }>(harness, '/api/v1/sdk/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Token': initial.body.token,
      },
      body: {},
    });

    expect(refresh.status).toBe(401);
    expect(refresh.body.error).toBe('Invalid or expired SDK session token');
  });

  test('public-key refresh fails when the bound SDK channel is deactivated', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-public-refresh-channel-admin'),
      uniqueSlug('tenant-sdk-public-refresh-channel'),
      uniqueSlug('project-sdk-public-refresh-channel'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Public Refresh Channel SDK Key',
      permissions: { chat: true, voice: false },
    });
    const channel = await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id, {
      name: 'public-refresh-web',
    });

    const initialSession = await initSdkSession(harness, {
      publicKey: key.key!,
      channelName: 'public-refresh-web',
    });
    const initialPayload = verifySdkToken(initialSession.token);

    expect(initialPayload.bootstrapType).toBe('public_key');
    expect(initialPayload.channelId).toBe(channel.id);

    await updateSdkChannel(harness, admin.token, admin.projectId, channel.id, {
      isActive: false,
    });

    const refresh = await requestJson<{ error: string }>(harness, '/api/v1/sdk/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Token': initialSession.token,
      },
      body: {},
    });

    expect(refresh.status).toBe(401);
    expect(refresh.body.error).toBe('Invalid or expired SDK session token');
  });

  test('preview/share bootstrap preserves deployment binding from the bound SDK channel', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-preview-deployment-admin'),
      uniqueSlug('tenant-sdk-preview-deployment'),
      uniqueSlug('project-sdk-preview-deployment'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/channel-context.agent.abl': SDK_DEPLOYMENT_AGENT_DSL,
    });

    const deployment = await createDeployment(harness, admin.token, admin.projectId, {
      environment: 'staging',
      agentVersionManifest: { Channel_Context_Agent: 'auto' },
      entryAgentName: 'Channel_Context_Agent',
      label: 'SDK Preview Deployment',
      force: true,
    });

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Preview Deployment SDK Key',
      permissions: { chat: true, voice: false },
    });
    const channel = await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id, {
      name: 'preview-deployment-web',
      deploymentId: deployment.id,
    });

    const bootstrapToken = signSdkBootstrapArtifact(
      {
        type: 'preview',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: channel.id,
        permissions: ['session:send_message'],
        exp: Date.now() + 60_000,
      },
      TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
    );

    const previewInit = await requestJson<{ token: string; deploymentId?: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          bootstrapToken,
        },
      },
    );

    expect(previewInit.status).toBe(200);
    expect(previewInit.body.deploymentId).toBe(deployment.id);

    const previewPayload = verifySdkToken(previewInit.body.token);
    expect(previewPayload.bootstrapType).toBe('studio_preview');
    expect(previewPayload.channelId).toBe(channel.id);
    expect(previewPayload.deploymentId).toBe(deployment.id);
  });

  test('preview/share bootstrap preserves environment binding from environment-following SDK channels', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-preview-environment-admin'),
      uniqueSlug('tenant-sdk-preview-environment'),
      uniqueSlug('project-sdk-preview-environment'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Preview Environment SDK Key',
      permissions: { chat: true, voice: false },
    });
    const channel = await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id, {
      name: 'preview-environment-web',
      deploymentId: null,
      environment: 'production',
      followEnvironment: true,
    });

    const bootstrapToken = signSdkBootstrapArtifact(
      {
        type: 'preview',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: channel.id,
        permissions: ['session:send_message'],
        exp: Date.now() + 60_000,
      },
      TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
    );

    const previewInit = await requestJson<{ token: string; deploymentId?: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          bootstrapToken,
        },
      },
    );

    expect(previewInit.status).toBe(200);
    expect(previewInit.body.deploymentId).toBeUndefined();

    const previewPayload = verifySdkToken(previewInit.body.token);
    expect(previewPayload.bootstrapType).toBe('studio_preview');
    expect(previewPayload.channelId).toBe(channel.id);
    expect(previewPayload.deploymentId).toBeUndefined();
    expect(previewPayload.environment).toBe('production');
  });

  test('refresh preserves claims and revocation blocks additional bootstrap and refresh requests', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-refresh-admin'),
      uniqueSlug('tenant-sdk-refresh'),
      uniqueSlug('project-sdk-refresh'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Refreshable SDK Key',
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const initialSession = await initSdkSession(harness, {
      publicKey: key.key!,
      userContext: {
        userId: 'sdk-refresh-user',
        customAttributes: { plan: 'pro', region: 'us-east' },
      },
    });

    const initialPayload = verifySdkToken(initialSession.token);
    expect(initialPayload.bootstrapKeyId).toBe(key.id);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const refreshed = await requestJson<SdkInitResult>(harness, '/api/v1/sdk/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Token': initialSession.token,
      },
      body: {},
    });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.token).not.toBe(initialSession.token);
    expect(refreshed.body.expiresIn).toBe(4 * 60 * 60);
    expect(refreshed.body.tenantId).toBe(initialPayload.tenantId);
    expect(refreshed.body.projectId).toBe(initialPayload.projectId);
    expect(refreshed.body.deploymentId).toBe(initialPayload.deploymentId);
    expect(refreshed.body.channelId).toBe(initialPayload.channelId);
    expect(refreshed.body.permissions).toEqual(initialPayload.permissions);

    const refreshedPayload = verifySdkToken(refreshed.body.token);
    expect(refreshedPayload.projectId).toBe(initialPayload.projectId);
    expect(refreshedPayload.tenantId).toBe(initialPayload.tenantId);
    expect(refreshedPayload.channelId).toBe(initialPayload.channelId);
    expect(refreshedPayload.sessionId).toBe(initialPayload.sessionId);
    expect(refreshedPayload.sessionPrincipal).toBe(initialPayload.sessionPrincipal);
    expect(refreshedPayload.authScope).toBe(initialPayload.authScope);
    expect(refreshedPayload.verifiedUserId).toBe(initialPayload.verifiedUserId);
    expect(refreshedPayload.bootstrapKeyId).toBe(initialPayload.bootstrapKeyId);
    expect(refreshedPayload.permissions).toEqual(initialPayload.permissions);
    expect(refreshedPayload.userContext).toEqual(initialPayload.userContext);
    expect(refreshedPayload.exp).toBeGreaterThan(initialPayload.exp);

    const refreshedList = await requestJson<{
      success: boolean;
      sessions: Array<unknown>;
    }>(harness, `/api/projects/${admin.projectId}/sessions`, {
      method: 'GET',
      headers: sdkHeaders(refreshed.body.token),
    });

    expect(refreshedList.status).toBe(200);
    expect(refreshedList.body.success).toBe(true);

    const revoke = await requestJson<{ success: boolean }>(
      harness,
      `/api/projects/${admin.projectId}/sdk-public-keys/${key.id}`,
      {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      },
    );

    expect(revoke.status).toBe(200);
    expect(revoke.body.success).toBe(true);

    const reinitAfterRevoke = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': key.key!,
      },
      body: {},
    });

    expect(reinitAfterRevoke.status).toBe(401);
    expect(reinitAfterRevoke.body.error).toBe('Invalid or expired public API key');

    const refreshAfterRevoke = await requestJson<{ error: string }>(
      harness,
      '/api/v1/sdk/refresh',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Token': refreshed.body.token,
        },
        body: {},
      },
    );

    expect(refreshAfterRevoke.status).toBe(401);
    expect(refreshAfterRevoke.body.error).toBe('Invalid or expired SDK session token');
  });

  test('public-key refresh is pinned to the original bootstrap key binding', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-refresh-binding-admin'),
      uniqueSlug('tenant-sdk-refresh-binding'),
      uniqueSlug('project-sdk-refresh-binding'),
    );

    const keyA = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Original Refresh Binding Key',
      permissions: { chat: true, voice: false },
    });
    const channel = await createSdkBootstrapChannel(harness, admin.token, admin.projectId, keyA.id);

    const initialSession = await initSdkSession(harness, {
      publicKey: keyA.key!,
      channelId: channel.id,
    });
    const initialPayload = verifySdkToken(initialSession.token);
    expect(initialPayload.bootstrapKeyId).toBe(keyA.id);

    const keyB = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Replacement Refresh Binding Key',
      permissions: { chat: true, voice: false },
    });

    await updateSdkChannel(harness, admin.token, admin.projectId, channel.id, {
      publicApiKeyId: keyB.id,
    });

    const refresh = await requestJson<{ error: string }>(harness, '/api/v1/sdk/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Token': initialSession.token,
      },
      body: {},
    });

    expect(refresh.status).toBe(401);
    expect(refresh.body.error).toBe('Invalid or expired SDK session token');
  });

  test('supports hosted exchange bootstrap, enforces allowed origins, and blocks bootstrap token replay', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-hosted-exchange-admin'),
      uniqueSlug('tenant-sdk-hosted-exchange'),
      uniqueSlug('project-sdk-hosted-exchange'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Hosted Exchange SDK Key',
      allowedOrigins: ['https://allowed.example'],
      permissions: { chat: true, voice: false },
    });

    const configuredChannel = await createSdkChannelDetailed(
      harness,
      admin.token,
      admin.projectId,
      {
        name: 'hosted-exchange',
        channelType: 'web',
        publicApiKeyId: key.id,
        auth: {
          mode: 'hosted_exchange',
        },
      },
    );

    expect(configuredChannel.channel.auth).toEqual({
      mode: 'hosted_exchange',
      hasServerSecret: true,
      serverSecretPrefix: configuredChannel.serverSecret?.slice(0, 15),
      serverSecretLastRotatedAt: expect.any(String),
    });
    expect(configuredChannel.serverSecret).toMatch(/^sk_[0-9a-f]+$/);

    const configuredChannelRead = await requestJson<{
      success: boolean;
      channel: Record<string, unknown>;
    }>(harness, `/api/projects/${admin.projectId}/sdk-channels/${configuredChannel.channel.id}`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });
    expect(configuredChannelRead.status).toBe(200);
    expect(configuredChannelRead.body.channel.serverSecret).toBeUndefined();
    expect(configuredChannelRead.body.channel.auth).toEqual({
      mode: 'hosted_exchange',
      hasServerSecret: true,
      serverSecretPrefix: configuredChannel.serverSecret?.slice(0, 15),
      serverSecretLastRotatedAt: expect.any(String),
    });

    const customerSession = await createSdkCustomerSession(harness, {
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelName: 'hosted-exchange',
      channelSecret: configuredChannel.serverSecret!,
      verifiedUserId: 'verified-user-1',
      customAttributes: { plan: 'enterprise' },
    });

    const blockedOrigin = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://blocked.example',
      },
      body: {
        bootstrapToken: customerSession.bootstrapToken,
      },
    });

    expect(blockedOrigin.status).toBe(403);
    expect(blockedOrigin.body.error).toBe('Origin not allowed');

    const verifiedSession = await requestJson<{ token: string }>(harness, '/api/v1/sdk/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://allowed.example',
      },
      body: {
        bootstrapToken: customerSession.bootstrapToken,
      },
    });
    expect(verifiedSession.status).toBe(200);
    const verifiedPayload = verifySdkToken(verifiedSession.body.token);
    expect(verifiedPayload.identityTier).toBe(2);
    expect(verifiedPayload.verificationMethod).toBe('server_secret');
    expect(verifiedPayload.verifiedUserId).toBe('verified-user-1');
    expect(verifiedPayload.authScope).toBe('user');
    expect(verifiedPayload.bootstrapType).toBe('customer');
    expect(verifiedPayload.userContext).toEqual({
      userId: 'verified-user-1',
      customAttributes: { plan: 'enterprise' },
    });
    expect(verifiedPayload.sessionPrincipal).toBe(verifiedPayload.sessionId);
    expect(verifiedPayload.channelArtifact).toMatch(/^[0-9a-f]{64}$/);

    const replayedBootstrapToken = await requestJson<{ error: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://allowed.example',
        },
        body: {
          bootstrapToken: customerSession.bootstrapToken,
        },
      },
    );

    expect(replayedBootstrapToken.status).toBe(401);
    expect(replayedBootstrapToken.body.error).toBe('Bootstrap token already used');
  });

  test('rejects customer bootstrap tokens signed with the shared preview/share secret', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-customer-derived-secret-admin'),
      uniqueSlug('tenant-sdk-customer-derived-secret'),
      uniqueSlug('project-sdk-customer-derived-secret'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Customer Derived Secret SDK Key',
      allowedOrigins: ['https://allowed.example'],
      permissions: { chat: true, voice: false },
    });
    const configuredChannel = await createSdkChannelDetailed(
      harness,
      admin.token,
      admin.projectId,
      {
        name: 'customer-derived-secret',
        channelType: 'web',
        publicApiKeyId: key.id,
        auth: {
          mode: 'hosted_exchange',
        },
      },
    );

    const invalidSharedSecretToken = signSdkBootstrapArtifact(
      {
        type: 'customer',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: configuredChannel.channel.id,
        permissions: ['session:send_message'],
        exp: Date.now() + 60_000,
        verifiedUserId: 'verified-user-1',
        channelArtifact: 'a'.repeat(64),
        jti: 'customer-shared-secret-invalid',
        userContext: { userId: 'verified-user-1' },
      },
      TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
    );

    const invalidSharedSecretResponse = await requestJson<{ error: string }>(
      harness,
      '/api/v1/sdk/init',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://allowed.example',
        },
        body: {
          bootstrapToken: invalidSharedSecretToken,
        },
      },
    );

    expect(invalidSharedSecretResponse.status).toBe(401);
    expect(invalidSharedSecretResponse.body.error).toBe('Invalid or expired bootstrap token');
  });

  test('scopes hosted customer session exchange by tenant and project', async () => {
    const adminA = await bootstrapProject(
      harness,
      uniqueEmail('sdk-customer-scope-a-admin'),
      uniqueSlug('tenant-sdk-customer-scope-a'),
      uniqueSlug('project-sdk-customer-scope-a'),
    );
    const adminB = await bootstrapProject(
      harness,
      uniqueEmail('sdk-customer-scope-b-admin'),
      uniqueSlug('tenant-sdk-customer-scope-b'),
      uniqueSlug('project-sdk-customer-scope-b'),
    );

    const keyA = await createSdkPublicKey(harness, adminA.token, adminA.projectId, {
      name: 'Scoped Hosted Exchange SDK Key',
      permissions: { chat: true, voice: false },
    });
    const hostedChannelA = await createSdkChannelDetailed(harness, adminA.token, adminA.projectId, {
      name: 'scoped-hosted-exchange',
      channelType: 'web',
      publicApiKeyId: keyA.id,
      auth: {
        mode: 'hosted_exchange',
      },
    });

    const byId = await requestJson<{
      success: boolean;
      error: { code: string; message: string };
    }>(harness, '/api/v1/sdk/customer-sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Channel-Secret': hostedChannelA.serverSecret!,
      },
      body: {
        tenantId: adminB.tenantId,
        projectId: adminB.projectId,
        channelId: hostedChannelA.channel.id,
        verifiedUserId: 'verified-user-cross-tenant',
      },
    });

    expect(byId.status).toBe(404);
    expect(byId.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'SDK channel not found',
      },
    });

    const byName = await requestJson<{
      success: boolean;
      error: { code: string; message: string };
    }>(harness, '/api/v1/sdk/customer-sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Channel-Secret': hostedChannelA.serverSecret!,
      },
      body: {
        tenantId: adminB.tenantId,
        projectId: adminB.projectId,
        channelName: 'scoped-hosted-exchange',
        verifiedUserId: 'verified-user-cross-tenant',
      },
    });

    expect(byName.status).toBe(404);
    expect(byName.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'SDK channel not found',
      },
    });
  });

  test('rate limits hosted customer session bootstrap exchange requests', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-customer-rate-limit-admin'),
      uniqueSlug('tenant-sdk-customer-rate-limit'),
      uniqueSlug('project-sdk-customer-rate-limit'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Customer Rate Limit SDK Key',
      permissions: { chat: true, voice: false },
    });
    const configuredChannel = await createSdkChannelDetailed(
      harness,
      admin.token,
      admin.projectId,
      {
        name: 'customer-rate-limit',
        channelType: 'web',
        publicApiKeyId: key.id,
        auth: {
          mode: 'hosted_exchange',
        },
      },
    );

    let rateLimitedResponse: {
      status: number;
      body: {
        success: boolean;
        error: { code: string; message: string };
        retryAfterMs?: number;
        limit?: number;
        operation?: string;
      };
    } | null = null;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
        retryAfterMs?: number;
        limit?: number;
        operation?: string;
      }>(harness, '/api/v1/sdk/customer-sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Channel-Secret': 'invalid-secret',
        },
        body: {
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          channelId: configuredChannel.channel.id,
          verifiedUserId: `verified-user-${attempt}`,
        },
      });

      if (response.status === 429) {
        rateLimitedResponse = response;
        break;
      }

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('INVALID_SDK_CHANNEL_SECRET');
    }

    expect(rateLimitedResponse).not.toBeNull();
    expect(rateLimitedResponse?.status).toBe(429);
    expect(rateLimitedResponse?.body.success).toBe(false);
    expect(rateLimitedResponse?.body.error).toEqual({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded',
    });
    expect(rateLimitedResponse?.body.limit).toBe(30);
    expect(rateLimitedResponse?.body.operation).toBe('request');
    expect(rateLimitedResponse?.body.retryAfterMs).toBeGreaterThan(0);
  });

  test('rejects expired sdk_session tokens on HTTP routes and refresh', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-expired-admin'),
      uniqueSlug('tenant-sdk-expired'),
      uniqueSlug('project-sdk-expired'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Expired Token SDK Key',
      permissions: { chat: true, voice: false },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const activeSession = await initSdkSession(harness, { publicKey: key.key! });
    const expiredToken = issueExpiredSdkSessionToken(activeSession.token);

    const sessionsWithExpiredToken = await requestJson<{ error?: string }>(
      harness,
      `/api/projects/${admin.projectId}/sessions`,
      {
        method: 'GET',
        headers: sdkHeaders(expiredToken),
      },
    );
    expect(sessionsWithExpiredToken.status).toBe(401);

    const chatWithExpiredToken = await requestJson<{ error?: string }>(
      harness,
      '/api/v1/chat/agent',
      {
        method: 'POST',
        headers: sdkHeaders(expiredToken),
        body: {
          projectId: admin.projectId,
          message: 'expired token should fail before chat execution',
        },
      },
    );
    expect(chatWithExpiredToken.status).toBe(401);

    const attachmentsWithExpiredToken = await requestJson<{ error?: string }>(
      harness,
      `/api/projects/${admin.projectId}/sessions/expired-sdk-token-session/attachments`,
      {
        method: 'GET',
        headers: sdkHeaders(expiredToken),
      },
    );
    expect(attachmentsWithExpiredToken.status).toBe(401);

    const refreshWithExpiredToken = await requestJson<{ error: string }>(
      harness,
      '/api/v1/sdk/refresh',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Token': expiredToken,
        },
        body: {},
      },
    );

    expect(refreshWithExpiredToken.status).toBe(401);
    expect(refreshWithExpiredToken.body.error).toBe(
      'Token expired - re-authenticate via /api/v1/sdk/init',
    );
  });

  test('voice-only sdk keys stay least-privilege and cannot use chat send routes', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sdk-voice-only-admin'),
      uniqueSlug('tenant-sdk-voice'),
      uniqueSlug('project-sdk-voice'),
    );

    const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'Voice Only SDK Key',
      permissions: { chat: false, voice: true },
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, key.id);

    const voiceOnly = await initSdkSession(harness, {
      publicKey: key.key!,
    });

    expect(voiceOnly.permissions).toEqual(
      expect.arrayContaining(['session:voice', 'session:read']),
    );
    expect(voiceOnly.permissions).not.toContain('session:send_message');
    expect(voiceOnly.permissions).not.toContain('attachment:write');

    const listSessions = await requestJson<{
      success: boolean;
      sessions: Array<unknown>;
    }>(harness, `/api/projects/${admin.projectId}/sessions`, {
      method: 'GET',
      headers: sdkHeaders(voiceOnly.token),
    });

    expect(listSessions.status).toBe(200);
    expect(listSessions.body.success).toBe(true);

    const chatAttempt = await requestJson<{
      error: { code: string; message: string };
      required?: string;
    }>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: sdkHeaders(voiceOnly.token),
      body: {
        projectId: admin.projectId,
        message: 'hello from a voice-only token',
      },
    });

    expect(chatAttempt.status).toBe(403);
    expect(chatAttempt.body).toMatchObject({
      error: { message: 'Forbidden' },
      required: 'session:send_message',
    });
  });
});
