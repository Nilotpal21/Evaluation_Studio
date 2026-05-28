import { expect } from 'vitest';
import { reloadConfig } from '../../config/index.js';
import type { RuntimeApiHarness } from './runtime-api-harness.js';

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

export type JsonRequestInit = Omit<RequestInit, 'body' | 'headers'> & {
  body?: unknown;
  headers?: HeadersInit;
};

export interface DevLoginResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
  tenantId?: string;
  role?: string;
}

export interface TenantRecord {
  _id: string;
  name: string;
  slug: string;
  memberCount: number;
}

export interface ProjectRecord {
  _id: string;
  name: string;
  slug: string;
  tenantId: string;
}

export interface ChannelConnectionRecord {
  id: string;
  projectId: string;
  channelType: string;
  displayName: string | null;
  externalIdentifier: string;
  config: Record<string, unknown>;
  identityVerification?: {
    providerVerificationStrength: 'weak' | 'strong';
  };
  status: string;
  deploymentId: string | null;
  environment: string | null;
  webhookUrl: string | null;
}

export interface ChannelConnectionCreateResult extends ChannelConnectionRecord {
  ai4w?: {
    connectionId: string;
    connectionSecret: string;
    note: string;
  };
}

export interface BootstrapProjectResult {
  token: string;
  userId: string;
  tenantId: string;
  projectId: string;
}

export interface SdkPublicKeyRecord {
  id: string;
  key?: string;
  keyPrefix: string;
  allowedOrigins: string[] | null;
  permissions: Record<string, boolean> | null;
  isActive: boolean;
}

export interface SdkChannelRecord {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  channelType: string;
  deploymentId: string | null;
  publicApiKeyId: string;
  config: Record<string, unknown>;
  isActive: boolean;
  environment: string | null;
  followEnvironment: boolean;
  auth?: {
    mode: 'anonymous' | 'hosted_exchange';
    hasServerSecret: boolean;
    serverSecretPrefix?: string;
    serverSecretLastRotatedAt?: string;
  };
}

export interface SdkInitResult {
  token: string;
  tokenEnvelope?: 'signed' | 'jwe';
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  channelId: string;
  permissions: string[];
  expiresIn: number;
  showActivityUpdates: boolean;
}

export interface SdkCustomerSessionResult {
  bootstrapToken: string;
  tokenEnvelope?: 'signed' | 'jwe';
  expiresIn: number;
  tenantId: string;
  projectId: string;
  channelId: string;
}

export interface TenantModelRecord {
  id: string;
  tenantId: string;
  displayName: string;
  provider: string | null;
  modelId: string | null;
  endpointUrl: string | null;
  tier?: string;
  hyperParameters?: Record<string, unknown> | null;
  useResponsesApi?: boolean | null;
  useStreaming?: boolean | null;
  isDefault: boolean;
}

export interface DeploymentRecord {
  id: string;
  projectId: string;
  environment: string;
  status: string;
  label: string | null;
  description: string | null;
  endpointSlug: string;
  entryAgentName: string;
  agentVersionManifest: Record<string, string>;
  workflowVersionManifest?: Record<string, string>;
}

interface TenantResponse {
  success: boolean;
  tenant: TenantRecord;
}

interface ProjectResponse {
  success: boolean;
  project: ProjectRecord;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomSuffix()}`;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomSuffix()}@example.com`;
}

export function authHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

export function sdkHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'X-SDK-Token': token,
    ...extra,
  };
}

export async function requestJson<T>(
  harness: RuntimeApiHarness,
  path: string,
  init: JsonRequestInit = {},
): Promise<ApiResponse<T>> {
  const headers = new Headers(init.headers ?? {});
  let body = init.body;

  if (
    body &&
    typeof body === 'object' &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof Blob) &&
    !(body instanceof FormData) &&
    !(body instanceof URLSearchParams)
  ) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  const response = await fetch(`${harness.baseUrl}${path}`, {
    ...init,
    headers,
    body,
  });

  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);

  return {
    status: response.status,
    body: parsed,
    headers: response.headers,
  };
}

export async function setSuperAdmins(userIds: string[]): Promise<void> {
  // TODO(test-architecture): Replace process-global SUPER_ADMIN_USER_IDS mutation with a
  // per-harness platform-admin bootstrap path so multiple Redis-backed channel E2E files can
  // run in parallel without cross-file auth races.
  process.env.SUPER_ADMIN_USER_IDS = userIds.join(',');
  await reloadConfig({ logSummary: false });
}

export async function devLogin(
  harness: RuntimeApiHarness,
  email: string,
): Promise<DevLoginResponse> {
  const response = await requestJson<DevLoginResponse>(harness, '/api/auth/dev-login', {
    method: 'POST',
    body: { email },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

export async function createTenant(
  harness: RuntimeApiHarness,
  token: string,
  name: string,
  slug: string,
): Promise<TenantRecord> {
  const response = await requestJson<TenantResponse>(harness, '/api/platform/admin/tenants', {
    method: 'POST',
    headers: authHeaders(token),
    body: { name, slug, planTier: 'TEAM' },
  });

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.tenant;
}

export async function createProject(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  name: string,
  slug: string,
): Promise<ProjectRecord> {
  const response = await requestJson<ProjectResponse>(
    harness,
    `/api/platform/admin/tenants/${tenantId}/projects`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: { name, slug },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.project;
}

export async function addMember(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  email: string,
  role = 'ADMIN',
): Promise<void> {
  const response = await requestJson<{ success: boolean }>(
    harness,
    `/api/platform/admin/tenants/${tenantId}/members`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: { email, role },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
}

export async function bootstrapProject(
  harness: RuntimeApiHarness,
  email: string,
  tenantSlug: string,
  projectSlug: string,
): Promise<BootstrapProjectResult> {
  const login = await devLogin(harness, email);
  await setSuperAdmins([login.user.id]);

  const tenant = await createTenant(harness, login.accessToken, `${tenantSlug} Name`, tenantSlug);
  const project = await createProject(
    harness,
    login.accessToken,
    tenant._id,
    `${projectSlug} Name`,
    projectSlug,
  );

  return {
    token: login.accessToken,
    userId: login.user.id,
    tenantId: tenant._id,
    projectId: project._id,
  };
}

export async function createSdkPublicKey(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: {
    name: string;
    allowedOrigins?: string[];
    permissions?: { chat?: boolean; voice?: boolean };
    expiresAt?: string;
  },
): Promise<SdkPublicKeyRecord> {
  const response = await requestJson<{
    success: boolean;
    key: SdkPublicKeyRecord;
  }>(harness, `/api/projects/${projectId}/sdk-public-keys`, {
    method: 'POST',
    headers: authHeaders(token),
    body,
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.key;
}

export async function createSdkChannelDetailed(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: {
    name: string;
    channelType: 'web' | 'mobile_ios' | 'mobile_android' | 'voice' | 'api';
    publicApiKeyId: string;
    deploymentId?: string | null;
    config?: Record<string, unknown>;
    environment?: string | null;
    followEnvironment?: boolean;
    auth?: {
      mode?: 'anonymous' | 'hosted_exchange';
      rotateServerSecret?: boolean;
    };
  },
): Promise<{ channel: SdkChannelRecord; serverSecret?: string }> {
  const response = await requestJson<{
    success: boolean;
    channel: SdkChannelRecord;
    serverSecret?: string;
  }>(harness, `/api/projects/${projectId}/sdk-channels`, {
    method: 'POST',
    headers: authHeaders(token),
    body,
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return {
    channel: response.body.channel,
    ...(typeof response.body.serverSecret === 'string'
      ? { serverSecret: response.body.serverSecret }
      : {}),
  };
}

export async function createSdkChannel(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: {
    name: string;
    channelType: 'web' | 'mobile_ios' | 'mobile_android' | 'voice' | 'api';
    publicApiKeyId: string;
    deploymentId?: string | null;
    config?: Record<string, unknown>;
    environment?: string | null;
    followEnvironment?: boolean;
    auth?: {
      mode?: 'anonymous' | 'hosted_exchange';
      rotateServerSecret?: boolean;
    };
  },
): Promise<SdkChannelRecord> {
  const response = await createSdkChannelDetailed(harness, token, projectId, body);
  return response.channel;
}

export async function createSdkBootstrapChannel(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  publicApiKeyId: string,
  overrides: Partial<{
    name: string;
    channelType: 'web' | 'mobile_ios' | 'mobile_android' | 'voice' | 'api';
    deploymentId: string | null;
    config: Record<string, unknown>;
    environment: string | null;
    followEnvironment: boolean;
    auth: {
      mode?: 'anonymous' | 'hosted_exchange';
      rotateServerSecret?: boolean;
    };
  }> = {},
): Promise<SdkChannelRecord> {
  return createSdkChannel(harness, token, projectId, {
    name: overrides.name ?? 'default',
    channelType: overrides.channelType ?? 'web',
    publicApiKeyId,
    deploymentId: overrides.deploymentId,
    config: overrides.config,
    environment: overrides.environment,
    followEnvironment: overrides.followEnvironment,
    auth: overrides.auth,
  });
}

export async function updateSdkChannelDetailed(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  channelId: string,
  body: {
    name?: string;
    publicApiKeyId?: string;
    deploymentId?: string | null;
    config?: Record<string, unknown>;
    isActive?: boolean;
    environment?: string | null;
    followEnvironment?: boolean;
    auth?: {
      mode?: 'anonymous' | 'hosted_exchange';
      rotateServerSecret?: boolean;
    };
  },
): Promise<{ channel: SdkChannelRecord; serverSecret?: string }> {
  const response = await requestJson<{
    success: boolean;
    channel: SdkChannelRecord;
    serverSecret?: string;
  }>(harness, `/api/projects/${projectId}/sdk-channels/${channelId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body,
  });

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.success).toBe(true);
  return {
    channel: response.body.channel,
    ...(typeof response.body.serverSecret === 'string'
      ? { serverSecret: response.body.serverSecret }
      : {}),
  };
}

export async function updateSdkChannel(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  channelId: string,
  body: {
    name?: string;
    publicApiKeyId?: string;
    deploymentId?: string | null;
    config?: Record<string, unknown>;
    isActive?: boolean;
    environment?: string | null;
    followEnvironment?: boolean;
    auth?: {
      mode?: 'anonymous' | 'hosted_exchange';
      rotateServerSecret?: boolean;
    };
  },
): Promise<SdkChannelRecord> {
  const response = await updateSdkChannelDetailed(harness, token, projectId, channelId, body);
  return response.channel;
}

export async function initSdkSession(
  harness: RuntimeApiHarness,
  input: {
    publicKey?: string;
    bootstrapToken?: string;
    origin?: string;
    deploymentSlug?: string;
    channelId?: string;
    channelName?: string;
    userContext?: {
      userId?: string;
      customAttributes?: Record<string, unknown>;
    };
  },
): Promise<SdkInitResult> {
  const headers: Record<string, string> = {
    ...(input.origin ? { Origin: input.origin } : {}),
  };
  if (input.publicKey) {
    headers['X-Public-Key'] = input.publicKey;
  }

  const response = await requestJson<SdkInitResult>(harness, '/api/v1/sdk/init', {
    method: 'POST',
    headers,
    body: {
      deploymentSlug: input.deploymentSlug,
      channelId: input.channelId,
      channelName: input.channelName,
      bootstrapToken: input.bootstrapToken,
      userContext: input.userContext,
    },
  });

  expect(response.status).toBe(200);
  expect(response.body.token).toBeTruthy();
  return response.body;
}

export async function createSdkCustomerSession(
  harness: RuntimeApiHarness,
  input: {
    tenantId: string;
    projectId: string;
    channelSecret: string;
    channelId?: string;
    channelName?: string;
    verifiedUserId: string;
    customAttributes?: Record<string, unknown>;
  },
): Promise<SdkCustomerSessionResult> {
  const response = await requestJson<SdkCustomerSessionResult>(
    harness,
    '/api/v1/sdk/customer-sessions',
    {
      method: 'POST',
      headers: {
        'X-SDK-Channel-Secret': input.channelSecret,
      },
      body: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        channelId: input.channelId,
        channelName: input.channelName,
        verifiedUserId: input.verifiedUserId,
        customAttributes: input.customAttributes,
      },
    },
  );

  expect(response.status).toBe(200);
  expect(response.body.bootstrapToken).toBeTruthy();
  return response.body;
}

export async function importProjectFiles(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  files: Record<string, string>,
): Promise<{
  success: boolean;
  applied: {
    created: number;
    updated: number;
    deleted: number;
    toolsCreated: number;
    toolsUpdated: number;
    toolsDeleted: number;
  };
}> {
  const response = await requestJson<{
    success: boolean;
    applied: {
      created: number;
      updated: number;
      deleted: number;
      toolsCreated: number;
      toolsUpdated: number;
      toolsDeleted: number;
    };
  }>(harness, `/api/projects/${projectId}/project-io/import`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { files },
  });

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.success).toBe(true);
  return response.body;
}

export async function createDeployment(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: {
    environment: string;
    agentVersionManifest: Record<string, string>;
    entryAgentName: string;
    label?: string;
    description?: string;
    workflowVersionManifest?: Record<string, string>;
    force?: boolean;
  },
): Promise<DeploymentRecord> {
  const response = await requestJson<{
    success: boolean;
    deployment: DeploymentRecord;
  }>(harness, `/api/projects/${projectId}/deployments`, {
    method: 'POST',
    headers: authHeaders(token),
    body,
  });

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.deployment;
}

export async function createChannelConnection(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: {
    channel_type: string;
    display_name?: string;
    external_identifier: string;
    credentials?: Record<string, unknown>;
    config?: Record<string, unknown>;
    identityVerification?: {
      providerVerificationStrength: 'weak' | 'strong';
    };
    deployment_id?: string;
    environment?: string;
  },
): Promise<ChannelConnectionCreateResult> {
  const response = await requestJson<{
    success: boolean;
    connection: ChannelConnectionRecord;
    ai4w?: ChannelConnectionCreateResult['ai4w'];
  }>(harness, `/api/projects/${projectId}/channel-connections`, {
    method: 'POST',
    headers: authHeaders(token),
    body,
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return {
    ...response.body.connection,
    ai4w: response.body.ai4w,
  };
}

export async function updateChannelConnection(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  connectionId: string,
  body: {
    display_name?: string;
    credentials?: Record<string, unknown> | null;
    config?: Record<string, unknown>;
    identityVerification?: {
      providerVerificationStrength: 'weak' | 'strong';
    };
    status?: 'active' | 'inactive';
    deployment_id?: string | null;
    environment?: string | null;
  },
): Promise<ChannelConnectionRecord> {
  const response = await requestJson<{
    success: boolean;
    connection: ChannelConnectionRecord;
  }>(harness, `/api/projects/${projectId}/channel-connections/${connectionId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body,
  });

  expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);
  return response.body.connection;
}

export async function provisionTenantModel(
  harness: RuntimeApiHarness,
  token: string,
  body: {
    targetTenantId: string;
    displayName: string;
    integrationType: 'easy' | 'api';
    modelId?: string;
    provider?: string;
    endpointUrl?: string;
    providerStructure?: string;
    supportsTools?: boolean;
    supportsStreaming?: boolean;
    supportsVision?: boolean;
    supportsStructured?: boolean;
    capabilities?: Array<
      'text' | 'tools' | 'streaming' | 'vision' | 'realtime_voice' | 'embedding'
    >;
    hyperParameters?: Record<string, unknown> | null;
    useResponsesApi?: boolean | null;
    useStreaming?: boolean | null;
    tier?: string;
    isDefault?: boolean;
    connection?: {
      credentialName: string;
      apiKey: string;
      authType?: string;
      authConfig?: Record<string, unknown>;
    };
  },
): Promise<TenantModelRecord> {
  const response = await requestJson<{
    success: boolean;
    model: TenantModelRecord;
  }>(harness, '/api/platform/admin/tenant-models', {
    method: 'POST',
    headers: authHeaders(token),
    body,
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.model;
}

export async function provisionBasicAgentProject(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  projectId: string,
  endpointUrl: string,
  agentName = 'ai4w_test_agent',
): Promise<DeploymentRecord> {
  const modelId = `${agentName}_model`;

  await provisionTenantModel(harness, token, {
    targetTenantId: tenantId,
    displayName: `${agentName} Model`,
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId,
    endpointUrl,
    supportsStreaming: true,
    supportsTools: true,
    capabilities: ['text', 'tools', 'streaming'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: `${agentName}-credential`,
      apiKey: 'test-api-key',
    },
  });

  await importProjectFiles(harness, token, projectId, {
    [`agents/${agentName}.agent.abl`]: [
      `AGENT: ${agentName}`,
      'GOAL: "Respond concisely to test messages"',
      'EXECUTION:',
      `  model: ${modelId}`,
      'PERSONA:',
      '  You are a concise test assistant.',
    ].join('\n'),
  });

  return createDeployment(harness, token, projectId, {
    environment: 'production',
    entryAgentName: agentName,
    agentVersionManifest: { [agentName]: 'auto' },
    force: true,
  });
}
