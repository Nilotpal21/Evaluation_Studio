// @vitest-environment node

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { verifySDKSessionToken, type SDKSessionTokenPayload } from '@agent-platform/shared-auth';
import {
  startStudioApiHarness,
  TEST_STUDIO_SDK_SESSION_SIGNING_SECRET,
  type StudioApiHarness,
} from './helpers/studio-api-harness';

// setup-light.ts replaces globalThis.fetch with a mock that throws on any
// call. This e2e test needs real HTTP — restore native fetch saved by
// setup-light.ts on globalThis.__nativeFetch.
const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as typeof fetch;
vi.stubGlobal('fetch', nativeFetch);

interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

interface DevLoginResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

interface ProjectResponse {
  success: boolean;
  project: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
    tenantId: string;
  };
}

interface PreviewTokenResponse {
  sdkToken: string;
}

interface WidgetConfigResponse {
  channelId: string | null;
  mode: 'chat' | 'voice' | 'unified';
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  welcomeMessage: string | null;
  placeholderText: string | null;
  voiceEnabled: boolean;
  chatEnabled: boolean;
  showActivityUpdates: boolean;
  theme: Record<string, string>;
}

interface EmbedResponse {
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
    showActivityUpdates: boolean;
  };
  keyPrefix: string;
  keyName: string;
  sdkUrl: string;
  runtimeEndpoint: string;
}

interface CreateSdkKeyResponse {
  id: string;
  keyPrefix: string;
  name: string;
  key: string;
}

interface CreateRuntimeSdkChannelResponse {
  success: boolean;
  channel: {
    id: string;
    name: string;
    publicApiKeyId: string;
  };
}

interface RuntimeSdkSessionClaims {
  bootstrapType?: string;
  authScope?: string;
  sessionPrincipal?: string;
}

interface ValidationErrorResponse {
  success: false;
  errors: Array<{ msg: string; code: string }>;
}

interface ShareResponse {
  token: string;
  shareUrl: string;
  expiresAt: string;
  projectId: string;
  projectName: string;
}

interface ShareExchangeResponse {
  valid: boolean;
  projectId: string;
  projectName: string;
  expiresAt: string;
  sdkToken: string;
  permissions: string[];
  config: {
    mode: string;
    position: string;
    welcomeMessage: string;
    placeholderText: string;
    chatEnabled: boolean;
    voiceEnabled: boolean;
    showActivityUpdates: boolean;
  };
}

interface CreateWorkspaceResponse {
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
  accessToken: string;
  expiresIn: number;
}

interface CreateInvitationResponse {
  invitation: {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomSuffix()}@e2e-smoke.test`;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomSuffix()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function requestJson<T>(
  harness: StudioApiHarness,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${harness.baseUrl}${path}`, init);
  const text = await response.text();

  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as T) : ({} as T),
    headers: response.headers,
  };
}

async function devLogin(harness: StudioApiHarness, email: string): Promise<DevLoginResponse> {
  const response = await requestJson<DevLoginResponse>(harness, '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0] }),
  });

  expect(response.status).toBe(200);
  return response.body;
}

async function createWorkspace(
  harness: StudioApiHarness,
  token: string,
  name: string,
): Promise<CreateWorkspaceResponse> {
  const response = await requestJson<CreateWorkspaceResponse>(
    harness,
    '/api/auth/create-workspace',
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    },
  );

  expect(response.status).toBe(200);
  return response.body;
}

async function createProject(
  harness: StudioApiHarness,
  token: string,
  name: string,
  slug: string,
): Promise<ProjectResponse['project']> {
  const response = await requestJson<ProjectResponse>(harness, '/api/projects', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name, slug }),
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.project;
}

async function createSdkKey(
  harness: StudioApiHarness,
  token: string,
  projectId: string,
  name: string,
): Promise<CreateSdkKeyResponse> {
  const response = await requestJson<CreateSdkKeyResponse>(harness, '/api/sdk/keys', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      projectId,
      name,
      permissions: {
        chat: true,
        voice: false,
      },
    }),
  });

  expect(response.status).toBe(201);
  expect(response.body.key.startsWith('pk_')).toBe(true);
  return response.body;
}

async function createSdkBootstrapChannel(
  harness: StudioApiHarness,
  token: string,
  projectId: string,
  publicApiKeyId: string,
  name = `default-${randomSuffix()}`,
): Promise<CreateRuntimeSdkChannelResponse['channel']> {
  const response = await requestJson<CreateRuntimeSdkChannelResponse>(
    harness,
    `/api/runtime/sdk-channels?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        name,
        channelType: 'web',
        publicApiKeyId,
      }),
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.channel;
}

async function updateWidgetConfig(
  harness: StudioApiHarness,
  token: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<ApiResponse<WidgetConfigResponse | { error: string } | ValidationErrorResponse>> {
  return requestJson(harness, `/api/sdk/widget/${projectId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

function verifySdkSessionToken(token: string): SDKSessionTokenPayload {
  return verifySDKSessionToken(token, TEST_STUDIO_SDK_SESSION_SIGNING_SECRET);
}

async function inviteWorkspaceMember(
  harness: StudioApiHarness,
  token: string,
  tenantId: string,
  email: string,
  role: 'VIEWER' | 'MEMBER' | 'OPERATOR' | 'ADMIN' = 'VIEWER',
): Promise<CreateInvitationResponse['invitation']> {
  const response = await requestJson<CreateInvitationResponse>(
    harness,
    `/api/workspaces/${tenantId}/invitations`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ email, role }),
    },
  );

  expect(response.status).toBe(201);
  return response.body.invitation;
}

async function expectNonLeakingProjectRouteDenial(
  harness: StudioApiHarness,
  token: string,
  deniedPath: string,
  missingPath: string,
  init: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: Record<string, unknown>;
  },
): Promise<void> {
  const headers =
    init.body === undefined
      ? {
          Authorization: `Bearer ${token}`,
        }
      : authHeaders(token);

  const denied = await requestJson<Record<string, unknown>>(harness, deniedPath, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const missing = await requestJson<Record<string, unknown>>(harness, missingPath, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  expect(denied.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(denied.body).toEqual(missing.body);
}

describe.sequential('Studio SDK preview/share API e2e', () => {
  let harness!: StudioApiHarness;

  beforeAll(async () => {
    harness = await startStudioApiHarness();
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  }, 120_000);

  test('issues preview tokens to authenticated callers and returns runtime-compatible SDK claims', async () => {
    const owner = await devLogin(harness, uniqueEmail('sdk-preview-owner'));
    const ownerWorkspace = await createWorkspace(
      harness,
      owner.accessToken,
      `SDK Preview Owner ${randomSuffix()}`,
    );
    const project = await createProject(
      harness,
      ownerWorkspace.accessToken,
      `SDK Preview ${randomSuffix()}`,
      uniqueSlug('sdk-preview'),
    );
    const key = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      `SDK Preview Key ${randomSuffix()}`,
    );
    const channel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      key.id,
    );

    const authorizedPreview = await requestJson<PreviewTokenResponse>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );

    expect(authorizedPreview.status).toBe(200);
    const previewPayload = verifySdkSessionToken(authorizedPreview.body.sdkToken);
    const previewClaims = previewPayload as SDKSessionTokenPayload & RuntimeSdkSessionClaims;
    expect(previewPayload.type).toBe('sdk_session');
    expect(previewPayload.projectId).toBe(project.id);
    expect(previewPayload.tenantId).toBe(project.tenantId);
    expect(previewPayload.channelId).toBe(channel.id);
    expect(previewClaims.bootstrapType).toBe('studio_preview');
    expect(previewClaims.authScope).toBe('session');
    expect(previewClaims.sessionId).toBeTruthy();
    expect(previewClaims.sessionPrincipal).toBe(previewClaims.sessionId);
    expect(previewPayload.permissions).toEqual(['session:send_message', 'session:read']);

    const unauthenticatedPreview = await requestJson<{
      success: boolean;
      errors: Array<{ code: string }>;
    }>(harness, '/api/sdk/preview-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    });

    expect(unauthenticatedPreview.status).toBe(401);
    expect(unauthenticatedPreview.body.success).toBe(false);
    expect(unauthenticatedPreview.body.errors[0]?.code).toBe('UNAUTHORIZED');

    const outsider = await devLogin(harness, uniqueEmail('sdk-preview-outsider'));
    const outsiderWorkspace = await createWorkspace(
      harness,
      outsider.accessToken,
      `SDK Preview Outsider ${randomSuffix()}`,
    );
    const unauthorizedPreview = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(outsiderWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );

    expect(unauthorizedPreview.status).toBe(404);
    expect(unauthorizedPreview.body.error).toBe('Project not found');

    const missingProjectPreview = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({ projectId: 'missing-project-id' }),
      },
    );

    expect(missingProjectPreview.status).toBe(404);
    expect(missingProjectPreview.body.error).toBe('Project not found');

    const invalidPreview = await requestJson<ValidationErrorResponse>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({}),
      },
    );

    expect(invalidPreview.status).toBe(400);
    expect(invalidPreview.body.success).toBe(false);
    expect(invalidPreview.body.errors[0]?.code).toBe('VALIDATION_ERROR');

    const invalidPreviewJson = await requestJson<ValidationErrorResponse>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerWorkspace.accessToken}`,
          'Content-Type': 'text/plain',
        },
        body: '{',
      },
    );

    expect(invalidPreviewJson.status).toBe(400);
    expect(invalidPreviewJson.body.success).toBe(false);
    expect(invalidPreviewJson.body.errors[0]?.code).toBe('VALIDATION_ERROR');
  }, 120_000);

  test('creates fragment-based share links and exchanges them into least-privilege SDK session tokens', async () => {
    const owner = await devLogin(harness, uniqueEmail('sdk-share-owner'));
    const project = await createProject(
      harness,
      owner.accessToken,
      `SDK Share ${randomSuffix()}`,
      uniqueSlug('sdk-share'),
    );
    const key = await createSdkKey(
      harness,
      owner.accessToken,
      project.id,
      `SDK Share Key ${randomSuffix()}`,
    );
    const channel = await createSdkBootstrapChannel(harness, owner.accessToken, project.id, key.id);

    const share = await requestJson<ShareResponse>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(owner.accessToken),
      body: JSON.stringify({ projectId: project.id }),
    });

    expect(share.status).toBe(200);
    expect(share.body.projectId).toBe(project.id);
    expect(share.body.projectName).toBe(project.name);
    expect(share.body.shareUrl).toContain('#share_token=');
    expect(share.body.shareUrl).not.toContain('?token=');

    const shareUrl = new URL(share.body.shareUrl);
    const shareToken = new URLSearchParams(shareUrl.hash.slice(1)).get('share_token');
    expect(shareToken).toBe(share.body.token);
    const { verifyShareToken } = await import('@/lib/sdk-share-token');
    const sharePayload = verifyShareToken(share.body.token);
    expect(sharePayload?.channelId).toBe(channel.id);
    expect(sharePayload?.permissions).toEqual(['session:send_message', 'session:read']);

    const outsider = await devLogin(harness, uniqueEmail('sdk-share-outsider'));
    const outsiderWorkspace = await createWorkspace(
      harness,
      outsider.accessToken,
      `SDK Share Outsider ${randomSuffix()}`,
    );

    const unauthorizedShareCreate = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/share',
      {
        method: 'POST',
        headers: authHeaders(outsiderWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );

    expect(unauthorizedShareCreate.status).toBe(404);
    expect(unauthorizedShareCreate.body.error).toBe('Project not found');

    const invalidChannelShareCreate = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/share',
      {
        method: 'POST',
        headers: authHeaders(owner.accessToken),
        body: JSON.stringify({
          projectId: project.id,
          channelId: 'missing-channel-id',
        }),
      },
    );

    expect(invalidChannelShareCreate.status).toBe(404);
    expect(invalidChannelShareCreate.body.error).toBe('Channel not found');

    const exchange = await requestJson<ShareExchangeResponse>(harness, '/api/sdk/share/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: share.body.token }),
    });

    expect(exchange.status).toBe(200);
    expect(exchange.body.valid).toBe(true);
    expect(exchange.body.projectId).toBe(project.id);
    expect(exchange.body.permissions).toEqual(['session:send_message', 'session:read']);
    expect(exchange.body.config.chatEnabled).toBe(true);
    expect(exchange.body.config.voiceEnabled).toBe(false);
    expect(exchange.body.config.showActivityUpdates).toBe(false);

    const exchangePayload = verifySdkSessionToken(exchange.body.sdkToken);
    const exchangeClaims = exchangePayload as SDKSessionTokenPayload & RuntimeSdkSessionClaims;
    expect(exchangePayload.type).toBe('sdk_session');
    expect(exchangePayload.projectId).toBe(project.id);
    expect(exchangePayload.tenantId).toBe(project.tenantId);
    expect(exchangePayload.channelId).toBe(channel.id);
    expect(exchangeClaims.bootstrapType).toBe('studio_share');
    expect(exchangeClaims.authScope).toBe('session');
    expect(exchangeClaims.sessionId).toBeTruthy();
    expect(exchangeClaims.sessionPrincipal).toBe(exchangeClaims.sessionId);
    expect(exchangePayload.permissions).toEqual(['session:send_message', 'session:read']);

    const narrowedExchange = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/share/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: share.body.token,
          requiredPermission: 'session:voice',
        }),
      },
    );

    expect(narrowedExchange.status).toBe(403);
    expect(narrowedExchange.body.error).toBe('Share link does not grant the required permission');

    const invalidShareCreate = await requestJson<ValidationErrorResponse>(
      harness,
      '/api/sdk/share',
      {
        method: 'POST',
        headers: authHeaders(owner.accessToken),
        body: JSON.stringify({}),
      },
    );

    expect(invalidShareCreate.status).toBe(400);
    expect(invalidShareCreate.body.success).toBe(false);
    expect(invalidShareCreate.body.errors[0]?.code).toBe('VALIDATION_ERROR');

    const invalidShareJson = await requestJson<ValidationErrorResponse>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.accessToken}`,
        'Content-Type': 'text/plain',
      },
      body: '{',
    });

    expect(invalidShareJson.status).toBe(400);
    expect(invalidShareJson.body.success).toBe(false);
    expect(invalidShareJson.body.errors[0]?.code).toBe('VALIDATION_ERROR');

    const missingTokenExchange = await requestJson<ValidationErrorResponse>(
      harness,
      '/api/sdk/share/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );

    expect(missingTokenExchange.status).toBe(400);
    expect(missingTokenExchange.body.success).toBe(false);
    expect(missingTokenExchange.body.errors[0]?.code).toBe('VALIDATION_ERROR');

    const invalidPermissionExchange = await requestJson<ValidationErrorResponse>(
      harness,
      '/api/sdk/share/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: share.body.token,
          requiredPermission: 'session:admin',
        }),
      },
    );

    expect(invalidPermissionExchange.status).toBe(400);
    expect(invalidPermissionExchange.body.success).toBe(false);
    expect(invalidPermissionExchange.body.errors[0]?.code).toBe('VALIDATION_ERROR');

    const invalidExchangeJson = await requestJson<ValidationErrorResponse>(
      harness,
      '/api/sdk/share/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{',
      },
    );

    expect(invalidExchangeJson.status).toBe(400);
    expect(invalidExchangeJson.body.success).toBe(false);
    expect(invalidExchangeJson.body.errors[0]?.code).toBe('VALIDATION_ERROR');

    const shortLivedShare = await requestJson<ShareResponse>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(owner.accessToken),
      body: JSON.stringify({ projectId: project.id, expiresIn: 1 }),
    });

    expect(shortLivedShare.status).toBe(200);
    await sleep(10);

    const expiredExchange = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/share/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: shortLivedShare.body.token }),
      },
    );

    expect(expiredExchange.status).toBe(401);
    expect(expiredExchange.body.error).toBe('Invalid or expired token');

    const invalidExchange = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/share/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid-token' }),
      },
    );

    expect(invalidExchange.status).toBe(401);
    expect(invalidExchange.body.error).toBe('Invalid or expired token');
  });

  test('requires a real active SDK channel and explicit selection when multiple channels exist', async () => {
    const owner = await devLogin(harness, uniqueEmail('sdk-channel-binding-owner'));
    const ownerWorkspace = await createWorkspace(
      harness,
      owner.accessToken,
      `SDK Channel Binding ${randomSuffix()}`,
    );
    const project = await createProject(
      harness,
      ownerWorkspace.accessToken,
      `SDK Channel Binding ${randomSuffix()}`,
      uniqueSlug('sdk-channel-binding'),
    );

    const previewWithoutChannel = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );
    expect(previewWithoutChannel.status).toBe(422);
    expect(previewWithoutChannel.body.error).toContain('active SDK channel');

    const shareWithoutChannel = await requestJson<{ error: string }>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(ownerWorkspace.accessToken),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(shareWithoutChannel.status).toBe(422);
    expect(shareWithoutChannel.body.error).toContain('active SDK channel');

    const firstKey = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      `SDK Channel Binding Key A ${randomSuffix()}`,
    );
    const firstChannel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      firstKey.id,
      'primary-channel',
    );

    const autoResolvedPreview = await requestJson<PreviewTokenResponse>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );
    expect(autoResolvedPreview.status).toBe(200);
    expect(verifySdkSessionToken(autoResolvedPreview.body.sdkToken).channelId).toBe(
      firstChannel.id,
    );

    const secondKey = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      `SDK Channel Binding Key B ${randomSuffix()}`,
    );
    const secondChannel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      secondKey.id,
      'secondary-channel',
    );

    const ambiguousPreview = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );
    expect(ambiguousPreview.status).toBe(409);
    expect(ambiguousPreview.body.error).toBe(
      'Multiple active SDK channels found. Specify channelId.',
    );

    const explicitPreview = await requestJson<PreviewTokenResponse>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id, channelId: secondChannel.id }),
      },
    );
    expect(explicitPreview.status).toBe(200);
    expect(verifySdkSessionToken(explicitPreview.body.sdkToken).channelId).toBe(secondChannel.id);

    const ambiguousShare = await requestJson<{ error: string }>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(ownerWorkspace.accessToken),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(ambiguousShare.status).toBe(409);
    expect(ambiguousShare.body.error).toBe(
      'Multiple active SDK channels found. Specify channelId.',
    );

    const explicitShare = await requestJson<ShareResponse>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(ownerWorkspace.accessToken),
      body: JSON.stringify({ projectId: project.id, channelId: secondChannel.id }),
    });
    expect(explicitShare.status).toBe(200);
    const { verifyShareToken } = await import('@/lib/sdk-share-token');
    expect(verifyShareToken(explicitShare.body.token)?.channelId).toBe(secondChannel.id);
  }, 120_000);

  test('uses the widget-configured default channel for project-level preview/share/embed flows and lets explicit embed overrides win', async () => {
    const owner = await devLogin(harness, uniqueEmail('sdk-widget-channel-owner'));
    const ownerWorkspace = await createWorkspace(
      harness,
      owner.accessToken,
      `SDK Widget Channel ${randomSuffix()}`,
    );
    const project = await createProject(
      harness,
      ownerWorkspace.accessToken,
      `SDK Widget Channel ${randomSuffix()}`,
      uniqueSlug('sdk-widget-channel'),
    );

    const firstKey = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      `SDK Widget Key A ${randomSuffix()}`,
    );
    const firstChannel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      firstKey.id,
      'primary-widget-channel',
    );
    const secondKey = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      `SDK Widget Key B ${randomSuffix()}`,
    );
    const secondChannel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      secondKey.id,
      'secondary-widget-channel',
    );

    const configuredWidget = await updateWidgetConfig(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      {
        channelId: secondChannel.id,
        mode: 'chat',
        chatEnabled: true,
        voiceEnabled: false,
      },
    );
    expect(configuredWidget.status).toBe(200);
    expect((configuredWidget.body as WidgetConfigResponse).channelId).toBe(secondChannel.id);

    const preview = await requestJson<PreviewTokenResponse>(harness, '/api/sdk/preview-token', {
      method: 'POST',
      headers: authHeaders(ownerWorkspace.accessToken),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(preview.status).toBe(200);
    expect(verifySdkSessionToken(preview.body.sdkToken).channelId).toBe(secondChannel.id);

    const share = await requestJson<ShareResponse>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(ownerWorkspace.accessToken),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(share.status).toBe(200);
    const { verifyShareToken } = await import('@/lib/sdk-share-token');
    expect(verifyShareToken(share.body.token)?.channelId).toBe(secondChannel.id);

    const defaultEmbed = await requestJson<EmbedResponse>(harness, `/api/sdk/embed/${project.id}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ownerWorkspace.accessToken}`,
      },
    });
    expect(defaultEmbed.status).toBe(200);
    expect(defaultEmbed.body.config.channelId).toBe(secondChannel.id);
    expect(defaultEmbed.body.config.channelName).toBe('secondary-widget-channel');
    expect(defaultEmbed.body.keyPrefix).toBe(secondKey.keyPrefix);
    expect(defaultEmbed.body.snippet).toContain(`channel-id="${secondChannel.id}"`);
    expect(defaultEmbed.body.snippet).toContain('chat-enabled="true"');
    expect(defaultEmbed.body.snippet).toContain('voice-enabled="false"');

    const explicitEmbed = await requestJson<EmbedResponse>(
      harness,
      `/api/sdk/embed/${project.id}?channelId=${encodeURIComponent(firstChannel.id)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ownerWorkspace.accessToken}`,
        },
      },
    );
    expect(explicitEmbed.status).toBe(200);
    expect(explicitEmbed.body.config.channelId).toBe(firstChannel.id);
    expect(explicitEmbed.body.config.channelName).toBe('primary-widget-channel');
    expect(explicitEmbed.body.keyPrefix).toBe(firstKey.keyPrefix);
    expect(explicitEmbed.body.snippet).toContain(`channel-id="${firstChannel.id}"`);
    expect(explicitEmbed.body.snippet).toContain('chat-enabled="true"');
    expect(explicitEmbed.body.snippet).toContain('voice-enabled="false"');

    const deletedChannel = await requestJson<{ success: boolean }>(
      harness,
      `/api/runtime/sdk-channels/${secondChannel.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${ownerWorkspace.accessToken}`,
        },
      },
    );
    expect(deletedChannel.status).toBe(200);
    expect(deletedChannel.body.success).toBe(true);

    const previewAfterFallback = await requestJson<PreviewTokenResponse>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(ownerWorkspace.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );
    expect(previewAfterFallback.status).toBe(200);
    expect(verifySdkSessionToken(previewAfterFallback.body.sdkToken).channelId).toBe(
      firstChannel.id,
    );

    const shareAfterFallback = await requestJson<ShareResponse>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(ownerWorkspace.accessToken),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(shareAfterFallback.status).toBe(200);
    expect(verifyShareToken(shareAfterFallback.body.token)?.channelId).toBe(firstChannel.id);

    const embedAfterFallback = await requestJson<EmbedResponse>(
      harness,
      `/api/sdk/embed/${project.id}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ownerWorkspace.accessToken}`,
        },
      },
    );
    expect(embedAfterFallback.status).toBe(200);
    expect(embedAfterFallback.body.config.channelId).toBe(firstChannel.id);
    expect(embedAfterFallback.body.config.channelName).toBe('primary-widget-channel');
    expect(embedAfterFallback.body.keyPrefix).toBe(firstKey.keyPrefix);
    expect(embedAfterFallback.body.snippet).toContain(`channel-id="${firstChannel.id}"`);
  }, 120_000);

  test('fails closed for embed generation when the widget disables both chat and voice', async () => {
    const owner = await devLogin(harness, uniqueEmail('sdk-embed-disabled-owner'));
    const ownerWorkspace = await createWorkspace(
      harness,
      owner.accessToken,
      `SDK Embed Disabled ${randomSuffix()}`,
    );
    const project = await createProject(
      harness,
      ownerWorkspace.accessToken,
      `SDK Embed Disabled ${randomSuffix()}`,
      uniqueSlug('sdk-embed-disabled'),
    );
    const key = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      `SDK Embed Disabled Key ${randomSuffix()}`,
    );
    const channel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      key.id,
      'disabled-widget-channel',
    );

    const configuredWidget = await updateWidgetConfig(
      harness,
      ownerWorkspace.accessToken,
      project.id,
      {
        channelId: channel.id,
        mode: 'unified',
        chatEnabled: false,
        voiceEnabled: false,
      },
    );
    expect(configuredWidget.status).toBe(200);
    expect((configuredWidget.body as WidgetConfigResponse).chatEnabled).toBe(false);
    expect((configuredWidget.body as WidgetConfigResponse).voiceEnabled).toBe(false);

    const embedResponse = await requestJson<{ error: string }>(
      harness,
      `/api/sdk/embed/${project.id}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ownerWorkspace.accessToken}`,
        },
      },
    );

    expect(embedResponse.status).toBe(422);
    expect(embedResponse.body.error).toBe('Embed is not enabled for this project');
  }, 120_000);

  test('rejects cross-project widget channel binding and fails closed for ambiguous project-level embed generation', async () => {
    const owner = await devLogin(harness, uniqueEmail('sdk-widget-binding-isolation-owner'));
    const ownerWorkspace = await createWorkspace(
      harness,
      owner.accessToken,
      `SDK Widget Binding ${randomSuffix()}`,
    );

    const primaryProject = await createProject(
      harness,
      ownerWorkspace.accessToken,
      `SDK Widget Primary ${randomSuffix()}`,
      uniqueSlug('sdk-widget-primary'),
    );
    const secondaryProject = await createProject(
      harness,
      ownerWorkspace.accessToken,
      `SDK Widget Secondary ${randomSuffix()}`,
      uniqueSlug('sdk-widget-secondary'),
    );

    const primaryKeyA = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      primaryProject.id,
      `SDK Widget Primary Key A ${randomSuffix()}`,
    );
    await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      primaryProject.id,
      primaryKeyA.id,
      'primary-a',
    );
    const primaryKeyB = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      primaryProject.id,
      `SDK Widget Primary Key B ${randomSuffix()}`,
    );
    await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      primaryProject.id,
      primaryKeyB.id,
      'primary-b',
    );

    const secondaryKey = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      secondaryProject.id,
      `SDK Widget Secondary Key ${randomSuffix()}`,
    );
    const secondaryChannel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      secondaryProject.id,
      secondaryKey.id,
      'secondary-project-channel',
    );

    const invalidBinding = await updateWidgetConfig(
      harness,
      ownerWorkspace.accessToken,
      primaryProject.id,
      {
        channelId: secondaryChannel.id,
      },
    );
    expect(invalidBinding.status).toBe(404);
    expect((invalidBinding.body as { error: string }).error).toBe('Channel not found');

    const ambiguousEmbed = await requestJson<{ error: string }>(
      harness,
      `/api/sdk/embed/${primaryProject.id}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ownerWorkspace.accessToken}`,
        },
      },
    );
    expect(ambiguousEmbed.status).toBe(409);
    expect(ambiguousEmbed.body.error).toBe(
      'Multiple active SDK channels found. Specify channelId.',
    );
  }, 120_000);

  test('rate limits repeated invalid share-token exchange attempts before token validation succeeds', async () => {
    const invalidExchangeHeaders = {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.50',
    };

    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await requestJson<{ error: string }>(harness, '/api/sdk/share/exchange', {
        method: 'POST',
        headers: invalidExchangeHeaders,
        body: JSON.stringify({ token: `invalid-token-${attempt}` }),
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid or expired token');
    }

    const rateLimited = await requestJson<{ error: string }>(harness, '/api/sdk/share/exchange', {
      method: 'POST',
      headers: invalidExchangeHeaders,
      body: JSON.stringify({ token: 'invalid-token-over-limit' }),
    });

    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body.error).toBe('Too many requests. Please try again later.');
  });

  test('returns non-leaking denial for authenticated outsiders across preview and share APIs', async () => {
    const owner = await devLogin(harness, uniqueEmail('sdk-authz-owner'));
    const ownerWorkspace = await createWorkspace(
      harness,
      owner.accessToken,
      `SDK Authz Owner ${randomSuffix()}`,
    );
    const ownerProject = await createProject(
      harness,
      ownerWorkspace.accessToken,
      `SDK Authz ${randomSuffix()}`,
      uniqueSlug('sdk-authz'),
    );
    const ownerKey = await createSdkKey(
      harness,
      ownerWorkspace.accessToken,
      ownerProject.id,
      `SDK Authz Key ${randomSuffix()}`,
    );
    const ownerChannel = await createSdkBootstrapChannel(
      harness,
      ownerWorkspace.accessToken,
      ownerProject.id,
      ownerKey.id,
      `sdk-authz-channel-${randomSuffix()}`,
    );
    const missingOwnerChannelPath = '/api/runtime/sdk-channels/missing-sdk-channel-id';

    const ownerChannelDetail = await requestJson<{
      success: boolean;
      data: { id: string; name: string };
    }>(harness, `/api/runtime/sdk-channels/${ownerChannel.id}`, {
      method: 'GET',
      headers: authHeaders(ownerWorkspace.accessToken),
    });

    expect(ownerChannelDetail.status).toBe(200);
    expect(ownerChannelDetail.body.success).toBe(true);
    expect(ownerChannelDetail.body.data.id).toBe(ownerChannel.id);

    const ownerRenamedChannel = `sdk-authz-channel-renamed-${randomSuffix()}`;
    const ownerChannelPatch = await requestJson<{
      success: boolean;
      data: { id: string; name: string };
    }>(harness, `/api/runtime/sdk-channels/${ownerChannel.id}`, {
      method: 'PATCH',
      headers: authHeaders(ownerWorkspace.accessToken),
      body: JSON.stringify({
        name: ownerRenamedChannel,
      }),
    });

    expect(ownerChannelPatch.status).toBe(200);
    expect(ownerChannelPatch.body.success).toBe(true);
    expect(ownerChannelPatch.body.data.id).toBe(ownerChannel.id);
    expect(ownerChannelPatch.body.data.name).toBe(ownerRenamedChannel);

    const outsider = await devLogin(harness, uniqueEmail('sdk-authz-outsider'));
    const outsiderWorkspace = await createWorkspace(
      harness,
      outsider.accessToken,
      `SDK Authz Outsider ${randomSuffix()}`,
    );

    const outsiderPreviewDenied = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(outsiderWorkspace.accessToken),
        body: JSON.stringify({ projectId: ownerProject.id }),
      },
    );

    const outsiderPreviewMissing = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(outsiderWorkspace.accessToken),
        body: JSON.stringify({ projectId: 'missing-project-id' }),
      },
    );

    expect(outsiderPreviewDenied.status).toBe(404);
    expect(outsiderPreviewDenied.body.error).toBe('Project not found');
    expect(outsiderPreviewMissing.status).toBe(404);
    expect(outsiderPreviewMissing.body.error).toBe('Project not found');
    expect(outsiderPreviewDenied.body).toEqual(outsiderPreviewMissing.body);

    const outsiderShareDenied = await requestJson<{ error: string }>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(outsiderWorkspace.accessToken),
      body: JSON.stringify({ projectId: ownerProject.id }),
    });

    const outsiderShareMissing = await requestJson<{ error: string }>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(outsiderWorkspace.accessToken),
      body: JSON.stringify({ projectId: 'missing-project-id' }),
    });

    expect(outsiderShareDenied.status).toBe(404);
    expect(outsiderShareDenied.body.error).toBe('Project not found');
    expect(outsiderShareMissing.status).toBe(404);
    expect(outsiderShareMissing.body.error).toBe('Project not found');
    expect(outsiderShareDenied.body).toEqual(outsiderShareMissing.body);

    const sameTenantViewerEmail = uniqueEmail('sdk-authz-viewer');
    await inviteWorkspaceMember(
      harness,
      ownerWorkspace.accessToken,
      ownerProject.tenantId,
      sameTenantViewerEmail,
      'VIEWER',
    );
    const sameTenantViewer = await devLogin(harness, sameTenantViewerEmail);

    const viewerPreviewDenied = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(sameTenantViewer.accessToken),
        body: JSON.stringify({ projectId: ownerProject.id }),
      },
    );

    const viewerPreviewMissing = await requestJson<{ error: string }>(
      harness,
      '/api/sdk/preview-token',
      {
        method: 'POST',
        headers: authHeaders(sameTenantViewer.accessToken),
        body: JSON.stringify({ projectId: 'missing-project-id' }),
      },
    );

    expect(viewerPreviewDenied.status).toBe(404);
    expect(viewerPreviewDenied.body.error).toBe('Project not found');
    expect(viewerPreviewMissing.status).toBe(404);
    expect(viewerPreviewMissing.body.error).toBe('Project not found');
    expect(viewerPreviewDenied.body).toEqual(viewerPreviewMissing.body);

    const viewerShareDenied = await requestJson<{ error: string }>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(sameTenantViewer.accessToken),
      body: JSON.stringify({ projectId: ownerProject.id }),
    });

    const viewerShareMissing = await requestJson<{ error: string }>(harness, '/api/sdk/share', {
      method: 'POST',
      headers: authHeaders(sameTenantViewer.accessToken),
      body: JSON.stringify({ projectId: 'missing-project-id' }),
    });

    expect(viewerShareDenied.status).toBe(404);
    expect(viewerShareDenied.body.error).toBe('Project not found');
    expect(viewerShareMissing.status).toBe(404);
    expect(viewerShareMissing.body.error).toBe('Project not found');
    expect(viewerShareDenied.body).toEqual(viewerShareMissing.body);

    await expectNonLeakingProjectRouteDenial(
      harness,
      outsiderWorkspace.accessToken,
      `/api/sdk/widget/${ownerProject.id}`,
      '/api/sdk/widget/missing-project-id',
      {
        method: 'GET',
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      outsiderWorkspace.accessToken,
      `/api/sdk/widget/${ownerProject.id}`,
      '/api/sdk/widget/missing-project-id',
      {
        method: 'PUT',
        body: {
          mode: 'chat',
          chatEnabled: true,
          voiceEnabled: false,
        },
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      outsiderWorkspace.accessToken,
      `/api/sdk/embed/${ownerProject.id}`,
      '/api/sdk/embed/missing-project-id',
      {
        method: 'GET',
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      sameTenantViewer.accessToken,
      `/api/sdk/widget/${ownerProject.id}`,
      '/api/sdk/widget/missing-project-id',
      {
        method: 'GET',
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      sameTenantViewer.accessToken,
      `/api/sdk/widget/${ownerProject.id}`,
      '/api/sdk/widget/missing-project-id',
      {
        method: 'PUT',
        body: {
          mode: 'chat',
          chatEnabled: true,
          voiceEnabled: false,
        },
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      sameTenantViewer.accessToken,
      `/api/sdk/embed/${ownerProject.id}`,
      '/api/sdk/embed/missing-project-id',
      {
        method: 'GET',
      },
    );

    const outsiderChannelListDenied = await requestJson<{ error: { message: string } }>(
      harness,
      `/api/runtime/sdk-channels?projectId=${encodeURIComponent(ownerProject.id)}`,
      {
        method: 'GET',
        headers: authHeaders(outsiderWorkspace.accessToken),
      },
    );

    const outsiderChannelListMissing = await requestJson<{ error: { message: string } }>(
      harness,
      '/api/runtime/sdk-channels?projectId=missing-project-id',
      {
        method: 'GET',
        headers: authHeaders(outsiderWorkspace.accessToken),
      },
    );

    expect(outsiderChannelListDenied.status).toBe(404);
    expect(outsiderChannelListMissing.status).toBe(404);
    expect(outsiderChannelListDenied.body).toEqual(outsiderChannelListMissing.body);

    const outsiderChannelCreateDenied = await requestJson<{ error: { message: string } }>(
      harness,
      `/api/runtime/sdk-channels?projectId=${encodeURIComponent(ownerProject.id)}`,
      {
        method: 'POST',
        headers: authHeaders(outsiderWorkspace.accessToken),
        body: JSON.stringify({
          name: `blocked-sdk-channel-${randomSuffix()}`,
          channelType: 'web',
          publicApiKeyId: 'key-does-not-matter',
        }),
      },
    );

    const outsiderChannelCreateMissing = await requestJson<{ error: { message: string } }>(
      harness,
      '/api/runtime/sdk-channels?projectId=missing-project-id',
      {
        method: 'POST',
        headers: authHeaders(outsiderWorkspace.accessToken),
        body: JSON.stringify({
          name: `missing-sdk-channel-${randomSuffix()}`,
          channelType: 'web',
          publicApiKeyId: 'key-does-not-matter',
        }),
      },
    );

    expect(outsiderChannelCreateDenied.status).toBe(404);
    expect(outsiderChannelCreateMissing.status).toBe(404);
    expect(outsiderChannelCreateDenied.body).toEqual(outsiderChannelCreateMissing.body);

    await expectNonLeakingProjectRouteDenial(
      harness,
      outsiderWorkspace.accessToken,
      `/api/runtime/sdk-channels/${ownerChannel.id}`,
      missingOwnerChannelPath,
      {
        method: 'GET',
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      outsiderWorkspace.accessToken,
      `/api/runtime/sdk-channels/${ownerChannel.id}`,
      missingOwnerChannelPath,
      {
        method: 'PATCH',
        body: {
          name: `outsider-updated-sdk-channel-${randomSuffix()}`,
        },
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      outsiderWorkspace.accessToken,
      `/api/runtime/sdk-channels/${ownerChannel.id}`,
      missingOwnerChannelPath,
      {
        method: 'DELETE',
      },
    );

    const viewerChannelListDenied = await requestJson<{ error: { message: string } }>(
      harness,
      `/api/runtime/sdk-channels?projectId=${encodeURIComponent(ownerProject.id)}`,
      {
        method: 'GET',
        headers: authHeaders(sameTenantViewer.accessToken),
      },
    );

    const viewerChannelListMissing = await requestJson<{ error: { message: string } }>(
      harness,
      '/api/runtime/sdk-channels?projectId=missing-project-id',
      {
        method: 'GET',
        headers: authHeaders(sameTenantViewer.accessToken),
      },
    );

    expect(viewerChannelListDenied.status).toBe(404);
    expect(viewerChannelListMissing.status).toBe(404);
    expect(viewerChannelListDenied.body).toEqual(viewerChannelListMissing.body);

    const viewerChannelCreateDenied = await requestJson<{ error: { message: string } }>(
      harness,
      `/api/runtime/sdk-channels?projectId=${encodeURIComponent(ownerProject.id)}`,
      {
        method: 'POST',
        headers: authHeaders(sameTenantViewer.accessToken),
        body: JSON.stringify({
          name: `viewer-blocked-sdk-channel-${randomSuffix()}`,
          channelType: 'web',
          publicApiKeyId: 'key-does-not-matter',
        }),
      },
    );

    const viewerChannelCreateMissing = await requestJson<{ error: { message: string } }>(
      harness,
      '/api/runtime/sdk-channels?projectId=missing-project-id',
      {
        method: 'POST',
        headers: authHeaders(sameTenantViewer.accessToken),
        body: JSON.stringify({
          name: `viewer-missing-sdk-channel-${randomSuffix()}`,
          channelType: 'web',
          publicApiKeyId: 'key-does-not-matter',
        }),
      },
    );

    expect(viewerChannelCreateDenied.status).toBe(404);
    expect(viewerChannelCreateMissing.status).toBe(404);
    expect(viewerChannelCreateDenied.body).toEqual(viewerChannelCreateMissing.body);

    await expectNonLeakingProjectRouteDenial(
      harness,
      sameTenantViewer.accessToken,
      `/api/runtime/sdk-channels/${ownerChannel.id}`,
      missingOwnerChannelPath,
      {
        method: 'GET',
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      sameTenantViewer.accessToken,
      `/api/runtime/sdk-channels/${ownerChannel.id}`,
      missingOwnerChannelPath,
      {
        method: 'PATCH',
        body: {
          name: `viewer-updated-sdk-channel-${randomSuffix()}`,
        },
      },
    );
    await expectNonLeakingProjectRouteDenial(
      harness,
      sameTenantViewer.accessToken,
      `/api/runtime/sdk-channels/${ownerChannel.id}`,
      missingOwnerChannelPath,
      {
        method: 'DELETE',
      },
    );
  }, 120_000);
});
