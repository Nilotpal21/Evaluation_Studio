import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { reloadConfig } from '../../config/index.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import sdkPublicKeysRouter from '../../routes/sdk-public-keys.js';
import sdkChannelsRouter from '../../routes/sdk-channels.js';
import tenantSdkChannelsRouter from '../../routes/tenant-sdk-channels.js';
import channelConnectionsRouter from '../../routes/channel-connections.js';
import sdkCustomerSessionsRouter from '../../routes/sdk-customer-sessions.js';
import sdkInitRouter from '../../routes/sdk-init.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  createSdkCustomerSession,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';

const CONTROL_PLANE_E2E_TIMEOUT_MS = 90_000;

interface ApiResponse<T> {
  status: number;
  body: T;
}

type JsonRequestInit = Omit<RequestInit, 'body' | 'headers'> & {
  body?: unknown;
  headers?: HeadersInit;
};

interface DevLoginResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
  tenantId?: string;
  role?: string;
}

interface TenantResponse {
  success: boolean;
  tenant: {
    _id: string;
    name: string;
    slug: string;
    memberCount: number;
  };
}

interface ProjectResponse {
  success: boolean;
  project: {
    _id: string;
    name: string;
    slug: string;
    tenantId: string;
  };
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function requestJson<T>(
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
  };
}

async function devLogin(harness: RuntimeApiHarness, email: string): Promise<DevLoginResponse> {
  const response = await requestJson<DevLoginResponse>(harness, '/api/auth/dev-login', {
    method: 'POST',
    body: { email },
  });
  expect(response.status).toBe(200);
  return response.body;
}

async function setSuperAdmins(userIds: string[]): Promise<void> {
  process.env.SUPER_ADMIN_USER_IDS = userIds.join(',');
  await reloadConfig({ logSummary: false });
}

async function createTenant(
  harness: RuntimeApiHarness,
  token: string,
  name: string,
  slug: string,
): Promise<TenantResponse['tenant']> {
  const response = await requestJson<TenantResponse>(harness, '/api/platform/admin/tenants', {
    method: 'POST',
    headers: authHeaders(token),
    body: { name, slug, planTier: 'TEAM' },
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.tenant;
}

async function createProject(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  name: string,
  slug: string,
): Promise<ProjectResponse['project']> {
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

async function addMember(
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

async function bootstrapProject(
  harness: RuntimeApiHarness,
  email: string,
  tenantSlug: string,
  projectSlug: string,
): Promise<{
  token: string;
  userId: string;
  tenantId: string;
  projectId: string;
}> {
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

async function createSlackConnection(
  harness: RuntimeApiHarness,
  projectId: string,
  token: string,
  {
    displayName = 'Support Slack',
    externalIdentifier = 'T12345ABC:A67890XYZ',
  }: {
    displayName?: string;
    externalIdentifier?: string;
  } = {},
): Promise<{
  id: string;
  channelType: string;
  displayName: string | null;
  externalIdentifier: string;
  hasCredentials: boolean;
  status: string;
}> {
  const createConnection = await requestJson<{
    success: boolean;
    connection: {
      id: string;
      channelType: string;
      displayName: string | null;
      externalIdentifier: string;
      hasCredentials: boolean;
      status: string;
    };
  }>(harness, `/api/projects/${projectId}/channel-connections`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      channel_type: 'slack',
      display_name: displayName,
      external_identifier: externalIdentifier,
      credentials: {
        bot_token: 'xoxb-test-token',
        signing_secret: 'signing-secret',
      },
    },
  });

  expect(createConnection.status).toBe(201);
  expect(createConnection.body.success).toBe(true);

  return createConnection.body.connection;
}

describe('Channel control plane E2E', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/sdk-public-keys', sdkPublicKeysRouter);
      app.use('/api/projects/:projectId/sdk-channels', sdkChannelsRouter);
      app.use('/api/tenants/:tenantId/sdk-channels', tenantSdkChannelsRouter);
      app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
      app.use('/api/v1/sdk', sdkCustomerSessionsRouter);
      app.use('/api/v1/sdk', sdkInitRouter);
    });
  });

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await harness.close();
  });

  test(
    'bootstraps tenant and project via APIs, creates SDK keys, enforces origin allowlist, and revokes keys',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('platform-admin'),
        uniqueSlug('tenant-alpha'),
        uniqueSlug('project-alpha'),
      );

      const keyCreate = await requestJson<{
        success: boolean;
        key: {
          id: string;
          key: string;
          keyPrefix: string;
          allowedOrigins: string[];
          isActive: boolean;
        };
      }>(harness, `/api/projects/${admin.projectId}/sdk-public-keys`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'Browser Key',
          allowedOrigins: ['https://allowed.example'],
        },
      });

      expect(keyCreate.status).toBe(201);
      expect(keyCreate.body.success).toBe(true);
      expect(keyCreate.body.key.key.startsWith('pk_')).toBe(true);
      expect(keyCreate.body.key.allowedOrigins).toEqual(['https://allowed.example']);
      expect(keyCreate.body.key.isActive).toBe(true);

      const channelCreate = await requestJson<{
        success: boolean;
        channel: { id: string; name: string };
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'customer-web',
          channelType: 'web',
          publicApiKeyId: keyCreate.body.key.id,
        },
      });

      expect(channelCreate.status).toBe(201);
      expect(channelCreate.body.success).toBe(true);
      expect(channelCreate.body.channel.name).toBe('customer-web');

      const keyList = await requestJson<{
        success: boolean;
        keys: Array<Record<string, unknown>>;
      }>(harness, `/api/projects/${admin.projectId}/sdk-public-keys`, {
        headers: authHeaders(admin.token),
      });

      expect(keyList.status).toBe(200);
      expect(keyList.body.success).toBe(true);
      expect(keyList.body.keys).toHaveLength(1);
      expect(keyList.body.keys[0]).not.toHaveProperty('key');

      const disallowedInit = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        headers: {
          'X-Public-Key': keyCreate.body.key.key,
          Origin: 'https://evil.example',
        },
        body: { channelName: 'customer-web' },
      });

      expect(disallowedInit.status).toBe(403);
      expect(disallowedInit.body.error).toBe('Origin not allowed');

      const missingOriginInit = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        headers: {
          'X-Public-Key': keyCreate.body.key.key,
        },
        body: { channelName: 'customer-web' },
      });

      expect(missingOriginInit.status).toBe(403);
      expect(missingOriginInit.body.error).toBe('Origin not allowed');

      const allowedInit = await requestJson<{ token: string; expiresIn: number }>(
        harness,
        '/api/v1/sdk/init',
        {
          method: 'POST',
          headers: {
            'X-Public-Key': keyCreate.body.key.key,
            Origin: 'https://allowed.example',
          },
          body: { channelName: 'customer-web' },
        },
      );

      expect(allowedInit.status).toBe(200);
      expect(typeof allowedInit.body.token).toBe('string');
      expect(allowedInit.body.token.length).toBeGreaterThan(20);
      expect(allowedInit.body.expiresIn).toBeGreaterThan(0);

      const revoke = await requestJson<{ success: boolean }>(
        harness,
        `/api/projects/${admin.projectId}/sdk-public-keys/${keyCreate.body.key.id}`,
        {
          method: 'DELETE',
          headers: authHeaders(admin.token),
        },
      );

      expect(revoke.status).toBe(200);
      expect(revoke.body.success).toBe(true);

      const revokedInit = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        headers: {
          'X-Public-Key': keyCreate.body.key.key,
          Origin: 'https://allowed.example',
        },
        body: { channelName: 'customer-web' },
      });

      expect(revokedInit.status).toBe(401);
      expect(revokedInit.body.error).toBe('Invalid or expired public API key');
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test(
    'creates, rotates, disables, and conceals hosted exchange SDK channel auth settings through project-scoped APIs',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('identity-policy-admin'),
        uniqueSlug('tenant-identity-policy'),
        uniqueSlug('project-identity-policy'),
      );

      const keyCreate = await requestJson<{
        success: boolean;
        key: {
          id: string;
          key: string;
        };
      }>(harness, `/api/projects/${admin.projectId}/sdk-public-keys`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'Identity Policy Key',
        },
      });

      expect(keyCreate.status).toBe(201);
      expect(keyCreate.body.success).toBe(true);

      const legacyShapeCreate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'hosted-web-legacy-shape',
          channelType: 'web',
          publicApiKeyId: keyCreate.body.key.id,
          identityVerification: {
            hmacEnforcement: 'required',
            secretKey: 'tenant-hmac-secret',
          },
        },
      });

      expect(legacyShapeCreate.status).toBe(400);
      expect(legacyShapeCreate.body.success).toBe(false);
      expect(legacyShapeCreate.body.error.code).toBe('INVALID_SDK_CHANNEL_AUTH_FIELDS');

      const invalidAuthMode = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'hosted-web-invalid',
          channelType: 'web',
          publicApiKeyId: keyCreate.body.key.id,
          auth: {
            mode: 'invalid-mode',
          },
        },
      });

      expect(invalidAuthMode.status).toBe(400);
      expect(invalidAuthMode.body.success).toBe(false);
      expect(invalidAuthMode.body.error.code).toBe('INVALID_SDK_CHANNEL_AUTH_MODE');

      const channelCreate = await requestJson<{
        success: boolean;
        channel: {
          id: string;
          auth: {
            mode: string;
            hasServerSecret: boolean;
            serverSecretPrefix?: string;
            serverSecretLastRotatedAt?: string;
          };
        };
        serverSecret?: string;
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'hosted-web',
          channelType: 'web',
          publicApiKeyId: keyCreate.body.key.id,
          auth: {
            mode: 'hosted_exchange',
          },
        },
      });

      expect(channelCreate.status).toBe(201);
      expect(channelCreate.body.success).toBe(true);
      expect(channelCreate.body.serverSecret).toMatch(/^sk_[0-9a-f]+$/);
      expect(channelCreate.body.channel.auth).toEqual({
        mode: 'hosted_exchange',
        hasServerSecret: true,
        serverSecretPrefix: channelCreate.body.serverSecret?.slice(0, 15),
        serverSecretLastRotatedAt: expect.any(String),
      });

      const channelId = channelCreate.body.channel.id;

      const channelGet = await requestJson<{
        success: boolean;
        channel: {
          id: string;
          auth: {
            mode: string;
            hasServerSecret: boolean;
            serverSecretPrefix?: string;
          };
        };
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels/${channelId}`, {
        headers: authHeaders(admin.token),
      });

      expect(channelGet.status).toBe(200);
      expect(channelGet.body.success).toBe(true);
      expect(channelGet.body.channel.auth).toMatchObject({
        mode: 'hosted_exchange',
        hasServerSecret: true,
        serverSecretPrefix: channelCreate.body.serverSecret?.slice(0, 15),
      });
      expect(channelGet.body.channel).not.toHaveProperty('serverSecret');

      const customerSession = await createSdkCustomerSession(harness, {
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId,
        channelSecret: channelCreate.body.serverSecret!,
        verifiedUserId: 'verified-project-user',
      });
      expect(customerSession.channelId).toBe(channelId);

      const disableChannel = await requestJson<{
        success: boolean;
        channel: {
          auth: {
            mode: string;
            hasServerSecret: boolean;
          };
        };
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels/${channelId}`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          auth: {
            mode: 'anonymous',
          },
        },
      });

      expect(disableChannel.status).toBe(200);
      expect(disableChannel.body.success).toBe(true);
      expect(disableChannel.body.channel.auth).toEqual({
        mode: 'anonymous',
        hasServerSecret: false,
      });

      const invalidRotate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels/${channelId}`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          auth: {
            rotateServerSecret: true,
          },
        },
      });

      expect(invalidRotate.status).toBe(400);
      expect(invalidRotate.body.success).toBe(false);
      expect(invalidRotate.body.error.code).toBe('INVALID_SDK_CHANNEL_SECRET_ROTATION');

      const reenableHostedExchange = await requestJson<{
        success: boolean;
        channel: {
          auth: {
            mode: string;
            hasServerSecret: boolean;
            serverSecretPrefix?: string;
          };
        };
        serverSecret?: string;
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels/${channelId}`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          auth: {
            mode: 'hosted_exchange',
          },
        },
      });

      expect(reenableHostedExchange.status).toBe(200);
      expect(reenableHostedExchange.body.success).toBe(true);
      expect(reenableHostedExchange.body.serverSecret).toMatch(/^sk_[0-9a-f]+$/);

      const rotateSecretOnly = await requestJson<{
        success: boolean;
        channel: {
          auth: {
            mode: string;
            hasServerSecret: boolean;
            serverSecretPrefix?: string;
          };
        };
        serverSecret?: string;
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels/${channelId}`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          auth: {
            mode: 'hosted_exchange',
            rotateServerSecret: true,
          },
        },
      });

      expect(rotateSecretOnly.status).toBe(200);
      expect(rotateSecretOnly.body.success).toBe(true);
      expect(rotateSecretOnly.body.serverSecret).toMatch(/^sk_[0-9a-f]+$/);
      expect(rotateSecretOnly.body.serverSecret).not.toBe(reenableHostedExchange.body.serverSecret);

      const oldSecretRejected = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, '/api/v1/sdk/customer-sessions', {
        method: 'POST',
        headers: {
          'X-SDK-Channel-Secret': reenableHostedExchange.body.serverSecret!,
        },
        body: {
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          channelId,
          verifiedUserId: 'verified-project-user',
        },
      });

      expect(oldSecretRejected.status).toBe(401);
      expect(oldSecretRejected.body.success).toBe(false);
      expect(oldSecretRejected.body.error).toEqual({
        code: 'INVALID_SDK_CHANNEL_SECRET',
        message: 'Invalid SDK channel secret',
      });

      const newSecretAccepted = await createSdkCustomerSession(harness, {
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId,
        channelSecret: rotateSecretOnly.body.serverSecret!,
        verifiedUserId: 'verified-project-user',
      });
      expect(newSecretAccepted.channelId).toBe(channelId);

      const listChannels = await requestJson<{
        success: boolean;
        channels: Array<{
          id: string;
          auth: {
            mode: string;
            hasServerSecret: boolean;
          };
        }>;
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels`, {
        headers: authHeaders(admin.token),
      });

      expect(listChannels.status).toBe(200);
      expect(listChannels.body.success).toBe(true);
      const listed = listChannels.body.channels.find((channel) => channel.id === channelId);
      expect(listed?.auth).toMatchObject({
        mode: 'hosted_exchange',
        hasServerSecret: true,
      });
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test(
    'creates, rotates, disables, and conceals hosted exchange SDK channel auth settings through tenant-scoped admin APIs',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('tenant-identity-policy-admin'),
        uniqueSlug('tenant-admin-identity-policy'),
        uniqueSlug('project-admin-identity-policy'),
      );

      const keyCreate = await requestJson<{
        success: boolean;
        key: {
          id: string;
          key: string;
        };
      }>(harness, `/api/projects/${admin.projectId}/sdk-public-keys`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'Tenant Identity Policy Key',
        },
      });

      expect(keyCreate.status).toBe(201);
      expect(keyCreate.body.success).toBe(true);

      const invalidCreate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'tenant-hosted-web-invalid',
          channelType: 'web',
          publicApiKeyId: keyCreate.body.key.id,
          identityVerification: {
            hmacEnforcement: 'required',
          },
        },
      });

      expect(invalidCreate.status).toBe(400);
      expect(invalidCreate.body.success).toBe(false);
      expect(invalidCreate.body.error.code).toBe('INVALID_SDK_CHANNEL_AUTH_FIELDS');

      const channelCreate = await requestJson<{
        success: boolean;
        data: {
          id: string;
          auth: {
            mode: string;
            hasServerSecret: boolean;
            serverSecretPrefix?: string;
            serverSecretLastRotatedAt?: string;
          };
        };
        serverSecret?: string;
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'tenant-hosted-web',
          channelType: 'web',
          publicApiKeyId: keyCreate.body.key.id,
          auth: {
            mode: 'hosted_exchange',
          },
        },
      });

      expect(channelCreate.status).toBe(201);
      expect(channelCreate.body.success).toBe(true);
      expect(channelCreate.body.serverSecret).toMatch(/^sk_[0-9a-f]+$/);
      expect(channelCreate.body.data.auth).toEqual({
        mode: 'hosted_exchange',
        hasServerSecret: true,
        serverSecretPrefix: channelCreate.body.serverSecret?.slice(0, 15),
        serverSecretLastRotatedAt: expect.any(String),
      });

      const outsider = await devLogin(harness, uniqueEmail('tenant-identity-policy-outsider'));
      await setSuperAdmins([admin.userId]);
      await addMember(harness, admin.token, admin.tenantId, outsider.user.email, 'VIEWER');

      const outsiderUpdate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${channelCreate.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(outsider.accessToken),
        body: {
          auth: {
            rotateServerSecret: true,
          },
        },
      });

      expect(outsiderUpdate.status).toBe(404);
      expect(outsiderUpdate.body.success).toBe(false);
      expect(outsiderUpdate.body.error.code).toBe('PROJECT_MEMBERSHIP_REQUIRED');

      const rotateSecretOnly = await requestJson<{
        success: boolean;
        data: {
          auth: {
            mode: string;
            hasServerSecret: boolean;
            serverSecretPrefix?: string;
          };
        };
        serverSecret?: string;
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${channelCreate.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          auth: {
            mode: 'hosted_exchange',
            rotateServerSecret: true,
          },
        },
      });

      expect(rotateSecretOnly.status).toBe(200);
      expect(rotateSecretOnly.body.success).toBe(true);
      expect(rotateSecretOnly.body.serverSecret).toMatch(/^sk_[0-9a-f]+$/);
      expect(rotateSecretOnly.body.serverSecret).not.toBe(channelCreate.body.serverSecret);
      expect(rotateSecretOnly.body.data.auth).toMatchObject({
        mode: 'hosted_exchange',
        hasServerSecret: true,
        serverSecretPrefix: rotateSecretOnly.body.serverSecret?.slice(0, 15),
      });

      const oldSecretRejected = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, '/api/v1/sdk/customer-sessions', {
        method: 'POST',
        headers: {
          'X-SDK-Channel-Secret': channelCreate.body.serverSecret!,
        },
        body: {
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          channelId: channelCreate.body.data.id,
          verifiedUserId: 'tenant-admin-user',
        },
      });

      expect(oldSecretRejected.status).toBe(401);
      expect(oldSecretRejected.body.success).toBe(false);
      expect(oldSecretRejected.body.error).toEqual({
        code: 'INVALID_SDK_CHANNEL_SECRET',
        message: 'Invalid SDK channel secret',
      });

      const newSecretAccepted = await createSdkCustomerSession(harness, {
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: channelCreate.body.data.id,
        channelSecret: rotateSecretOnly.body.serverSecret!,
        verifiedUserId: 'tenant-admin-user',
      });
      expect(newSecretAccepted.channelId).toBe(channelCreate.body.data.id);

      const disabledUpdate = await requestJson<{
        success: boolean;
        data: {
          auth: {
            mode: string;
            hasServerSecret: boolean;
          };
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${channelCreate.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          auth: {
            mode: 'anonymous',
          },
        },
      });

      expect(disabledUpdate.status).toBe(200);
      expect(disabledUpdate.body.success).toBe(true);
      expect(disabledUpdate.body.data.auth).toEqual({
        mode: 'anonymous',
        hasServerSecret: false,
      });

      const invalidRotate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${channelCreate.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          auth: {
            rotateServerSecret: true,
          },
        },
      });

      expect(invalidRotate.status).toBe(400);
      expect(invalidRotate.body.success).toBe(false);
      expect(invalidRotate.body.error.code).toBe('INVALID_SDK_CHANNEL_SECRET_ROTATION');
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test(
    'updates SDK channel public API key bindings through project-scoped APIs',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('sdk-key-rebind-admin'),
        uniqueSlug('tenant-sdk-key-rebind'),
        uniqueSlug('project-sdk-key-rebind'),
      );

      const keyA = await requestJson<{
        success: boolean;
        key: { id: string };
      }>(harness, `/api/projects/${admin.projectId}/sdk-public-keys`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'Original SDK Key',
        },
      });

      expect(keyA.status).toBe(201);
      expect(keyA.body.success).toBe(true);

      const keyB = await requestJson<{
        success: boolean;
        key: { id: string };
      }>(harness, `/api/projects/${admin.projectId}/sdk-public-keys`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'Replacement SDK Key',
        },
      });

      expect(keyB.status).toBe(201);
      expect(keyB.body.success).toBe(true);

      const channelCreate = await requestJson<{
        success: boolean;
        channel: { id: string; publicApiKeyId: string };
      }>(harness, `/api/projects/${admin.projectId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name: 'rebind-me',
          channelType: 'web',
          publicApiKeyId: keyA.body.key.id,
        },
      });

      expect(channelCreate.status).toBe(201);
      expect(channelCreate.body.success).toBe(true);
      expect(channelCreate.body.channel.publicApiKeyId).toBe(keyA.body.key.id);

      const channelUpdate = await requestJson<{
        success: boolean;
        channel: { id: string; publicApiKeyId: string };
      }>(
        harness,
        `/api/projects/${admin.projectId}/sdk-channels/${channelCreate.body.channel.id}`,
        {
          method: 'PATCH',
          headers: authHeaders(admin.token),
          body: {
            publicApiKeyId: keyB.body.key.id,
          },
        },
      );

      expect(channelUpdate.status).toBe(200);
      expect(channelUpdate.body.success).toBe(true);
      expect(channelUpdate.body.channel.publicApiKeyId).toBe(keyB.body.key.id);

      const channelGet = await requestJson<{
        success: boolean;
        channel: { id: string; publicApiKeyId: string };
      }>(
        harness,
        `/api/projects/${admin.projectId}/sdk-channels/${channelCreate.body.channel.id}`,
        {
          headers: authHeaders(admin.token),
        },
      );

      expect(channelGet.status).toBe(200);
      expect(channelGet.body.success).toBe(true);
      expect(channelGet.body.channel.publicApiKeyId).toBe(keyB.body.key.id);
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test(
    'tenant-scoped SDK channel admin route auto-creates default keys, filters inaccessible projects, and conceals unauthorized mutations',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('tenant-sdk-admin'),
        uniqueSlug('tenant-sdk-admin'),
        uniqueSlug('project-sdk-admin'),
      );

      const channelCreate = await requestJson<{
        success: boolean;
        data: {
          id: string;
          projectId: string;
          publicApiKeyId: string | null;
        };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'tenant-admin-web',
        },
      });

      expect(channelCreate.status).toBe(201);
      expect(channelCreate.body.success).toBe(true);
      expect(channelCreate.body.data.projectId).toBe(admin.projectId);
      expect(typeof channelCreate.body.data.publicApiKeyId).toBe('string');
      expect(channelCreate.body.data.publicApiKeyId?.length ?? 0).toBeGreaterThan(0);

      const outsider = await devLogin(harness, uniqueEmail('tenant-sdk-outsider'));
      await setSuperAdmins([admin.userId]);
      await addMember(harness, admin.token, admin.tenantId, outsider.user.email, 'VIEWER');

      const outsiderList = await requestJson<{
        success: boolean;
        data: Array<{ id: string }>;
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        headers: authHeaders(outsider.accessToken),
      });

      expect(outsiderList.status).toBe(200);
      expect(outsiderList.body.success).toBe(true);
      expect(outsiderList.body.data).toHaveLength(0);

      const outsiderCreate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(outsider.accessToken),
        body: {
          projectId: admin.projectId,
          name: 'forbidden-tenant-web',
        },
      });

      expect(outsiderCreate.status).toBe(404);
      expect(outsiderCreate.body.success).toBe(false);
      expect(outsiderCreate.body.error.code).toBe('PROJECT_MEMBERSHIP_REQUIRED');
      expect(outsiderCreate.body.error.message).toBe('Project not found');
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test(
    'tenant-scoped SDK channel admin route rejects missing projects and conflicting deployment or environment updates',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('tenant-sdk-validation'),
        uniqueSlug('tenant-sdk-validation'),
        uniqueSlug('project-sdk-validation'),
      );

      const missingProject = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: 'missing-project-id',
          name: 'missing-project-channel',
        },
      });

      expect(missingProject.status).toBe(404);
      expect(missingProject.body.success).toBe(false);
      expect(missingProject.body.error.code).toBe('PROJECT_NOT_FOUND');

      const conflictingCreate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'conflicting-channel',
          channelType: 'web',
          deploymentId: 'deployment-1',
          environment: 'staging',
        },
      });

      expect(conflictingCreate.status).toBe(400);
      expect(conflictingCreate.body.success).toBe(false);
      expect(conflictingCreate.body.error.code).toBe('CONFLICTING_PARAMS');

      const validCreate = await requestJson<{
        success: boolean;
        data: { id: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          name: 'valid-tenant-channel',
          channelType: 'web',
        },
      });

      expect(validCreate.status).toBe(201);
      expect(validCreate.body.success).toBe(true);

      const conflictingUpdate = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `/api/tenants/${admin.tenantId}/sdk-channels/${validCreate.body.data.id}`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: {
          deploymentId: 'deployment-1',
          environment: 'production',
        },
      });

      expect(conflictingUpdate.status).toBe(400);
      expect(conflictingUpdate.body.success).toBe(false);
      expect(conflictingUpdate.body.error.code).toBe('CONFLICTING_PARAMS');
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test('soft-deletes active channel connections on the first delete', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('connection-admin'),
      uniqueSlug('tenant-beta'),
      uniqueSlug('project-beta'),
    );

    const connection = await createSlackConnection(harness, admin.projectId, admin.token);

    expect(connection.channelType).toBe('slack');
    expect(connection.hasCredentials).toBe(true);
    expect(connection.status).toBe('active');

    const deleteConnection = await requestJson<{ success: boolean; outcome: string }>(
      harness,
      `/api/projects/${admin.projectId}/channel-connections/${connection.id}`,
      {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      },
    );

    expect(deleteConnection.status).toBe(200);
    expect(deleteConnection.body.success).toBe(true);
    expect(deleteConnection.body.outcome).toBe('deactivated');

    const fetchAfterFirstDelete = await requestJson<{
      success: boolean;
      connection: {
        id: string;
        status: string;
      };
    }>(harness, `/api/projects/${admin.projectId}/channel-connections/${connection.id}`, {
      headers: authHeaders(admin.token),
    });

    expect(fetchAfterFirstDelete.status).toBe(200);
    expect(fetchAfterFirstDelete.body.success).toBe(true);
    expect(fetchAfterFirstDelete.body.connection).toMatchObject({
      id: connection.id,
      status: 'inactive',
    });

    const listAfterFirstDelete = await requestJson<{
      success: boolean;
      connections: Array<{
        id: string;
        status: string;
      }>;
    }>(harness, `/api/projects/${admin.projectId}/channel-connections`, {
      headers: authHeaders(admin.token),
    });

    expect(listAfterFirstDelete.status).toBe(200);
    expect(listAfterFirstDelete.body.success).toBe(true);
    expect(listAfterFirstDelete.body.connections).toHaveLength(1);
    expect(listAfterFirstDelete.body.connections[0]).toMatchObject({
      id: connection.id,
      status: 'inactive',
    });
  });

  test('hard-deletes an already inactive channel connection on the second delete', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('connection-admin-hard-delete'),
      uniqueSlug('tenant-beta-hard-delete'),
      uniqueSlug('project-beta-hard-delete'),
    );

    const connection = await createSlackConnection(harness, admin.projectId, admin.token);

    const duplicateConnection = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/channel-connections`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          channel_type: 'slack',
          display_name: 'Duplicate Slack',
          external_identifier: connection.externalIdentifier,
          credentials: {
            bot_token: 'xoxb-test-token',
            signing_secret: 'signing-secret',
          },
        },
      },
    );

    expect(duplicateConnection.status).toBe(409);
    expect(duplicateConnection.body.error).toContain('already exists');

    const updateConnection = await requestJson<{
      success: boolean;
      connection: {
        id: string;
        displayName: string | null;
      };
    }>(harness, `/api/projects/${admin.projectId}/channel-connections/${connection.id}`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        display_name: 'Support Slack Renamed',
      },
    });

    expect(updateConnection.status).toBe(200);
    expect(updateConnection.body.success).toBe(true);
    expect(updateConnection.body.connection.displayName).toBe('Support Slack Renamed');

    const firstDelete = await requestJson<{ success: boolean; outcome: string }>(
      harness,
      `/api/projects/${admin.projectId}/channel-connections/${connection.id}`,
      {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      },
    );

    expect(firstDelete.status).toBe(200);
    expect(firstDelete.body.success).toBe(true);
    expect(firstDelete.body.outcome).toBe('deactivated');

    const deleteInactiveConnection = await requestJson<{ success: boolean; outcome: string }>(
      harness,
      `/api/projects/${admin.projectId}/channel-connections/${connection.id}`,
      {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      },
    );

    expect(deleteInactiveConnection.status).toBe(200);
    expect(deleteInactiveConnection.body.success).toBe(true);
    expect(deleteInactiveConnection.body.outcome).toBe('deleted');

    const fetchAfterSecondDelete = await requestJson<{
      success: boolean;
      error: string;
    }>(harness, `/api/projects/${admin.projectId}/channel-connections/${connection.id}`, {
      headers: authHeaders(admin.token),
    });

    expect(fetchAfterSecondDelete.status).toBe(404);
    expect(fetchAfterSecondDelete.body.success).toBe(false);
    expect(fetchAfterSecondDelete.body.error).toContain('not found');

    const listAfterSecondDelete = await requestJson<{
      success: boolean;
      connections: Array<{
        id: string;
        status: string;
      }>;
    }>(harness, `/api/projects/${admin.projectId}/channel-connections`, {
      headers: authHeaders(admin.token),
    });

    expect(listAfterSecondDelete.status).toBe(200);
    expect(listAfterSecondDelete.body.success).toBe(true);
    expect(listAfterSecondDelete.body.connections).toHaveLength(0);

    const recreateConnection = await requestJson<{
      success: boolean;
      connection: {
        status: string;
      };
    }>(harness, `/api/projects/${admin.projectId}/channel-connections`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        channel_type: 'slack',
        display_name: 'Support Slack Recreated',
        external_identifier: 'T12345ABC:A67890XYZ',
        credentials: {
          bot_token: 'xoxb-test-token',
          signing_secret: 'signing-secret',
        },
      },
    });

    expect(recreateConnection.status).toBe(201);
    expect(recreateConnection.body.success).toBe(true);
    expect(recreateConnection.body.connection.status).toBe('active');
  });

  test(
    'surfaces provider verification strength explicitly on channel connections through project-scoped APIs',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('connection-identity-admin'),
        uniqueSlug('tenant-connection-identity'),
        uniqueSlug('project-connection-identity'),
      );

      const createConnection = await requestJson<{
        success: boolean;
        connection: {
          id: string;
          channelType: string;
          identityVerification: {
            providerVerificationStrength: 'weak' | 'strong';
          };
          config: {
            identityVerification?: {
              providerVerificationStrength?: 'weak' | 'strong';
            };
          };
        };
      }>(harness, `/api/projects/${admin.projectId}/channel-connections`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          channel_type: 'http_async',
          display_name: 'Async Identity Channel',
          external_identifier: 'http_async:identity-contract',
          identityVerification: {
            providerVerificationStrength: 'strong',
          },
        },
      });

      expect(createConnection.status).toBe(201);
      expect(createConnection.body.success).toBe(true);
      expect(createConnection.body.connection.channelType).toBe('http_async');
      expect(createConnection.body.connection.identityVerification).toEqual({
        providerVerificationStrength: 'strong',
      });
      expect(createConnection.body.connection.config.identityVerification).toEqual({
        providerVerificationStrength: 'strong',
      });

      const connectionId = createConnection.body.connection.id;

      const getConnection = await requestJson<{
        success: boolean;
        connection: {
          identityVerification: {
            providerVerificationStrength: 'weak' | 'strong';
          };
        };
      }>(harness, `/api/projects/${admin.projectId}/channel-connections/${connectionId}`, {
        headers: authHeaders(admin.token),
      });

      expect(getConnection.status).toBe(200);
      expect(getConnection.body.success).toBe(true);
      expect(getConnection.body.connection.identityVerification).toEqual({
        providerVerificationStrength: 'strong',
      });

      const updateConnection = await requestJson<{
        success: boolean;
        connection: {
          identityVerification: {
            providerVerificationStrength: 'weak' | 'strong';
          };
        };
      }>(harness, `/api/projects/${admin.projectId}/channel-connections/${connectionId}`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          identityVerification: {
            providerVerificationStrength: 'weak',
          },
        },
      });

      expect(updateConnection.status).toBe(200);
      expect(updateConnection.body.success).toBe(true);
      expect(updateConnection.body.connection.identityVerification).toEqual({
        providerVerificationStrength: 'weak',
      });

      const listConnections = await requestJson<{
        success: boolean;
        connections: Array<{
          id: string;
          identityVerification: {
            providerVerificationStrength: 'weak' | 'strong';
          };
        }>;
      }>(harness, `/api/projects/${admin.projectId}/channel-connections`, {
        headers: authHeaders(admin.token),
      });

      expect(listConnections.status).toBe(200);
      expect(listConnections.body.success).toBe(true);
      expect(
        listConnections.body.connections.find((connection) => connection.id === connectionId)
          ?.identityVerification,
      ).toEqual({
        providerVerificationStrength: 'weak',
      });
    },
    CONTROL_PLANE_E2E_TIMEOUT_MS,
  );

  test('rejects per-connection provider API base overrides outside test mode', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('provider-override-admin'),
      uniqueSlug('tenant-provider-override'),
      uniqueSlug('project-provider-override'),
    );

    const originalNodeEnv = process.env.NODE_ENV;
    const originalOverrideFlag = process.env.ALLOW_CHANNEL_PROVIDER_API_BASE_OVERRIDE;
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_CHANNEL_PROVIDER_API_BASE_OVERRIDE;

    try {
      const response = await requestJson<{ success: boolean; error: string }>(
        harness,
        `/api/projects/${admin.projectId}/channel-connections`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            channel_type: 'slack',
            display_name: 'Unsafe Override Slack',
            external_identifier: 'TOVERRIDE:AOVERRIDE',
            credentials: {
              bot_token: 'xoxb-test-token',
              signing_secret: 'signing-secret',
            },
            config: {
              slackApiBaseUrl: 'http://127.0.0.1:9999',
            },
          },
        },
      );

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain(
        'Provider API base URL overrides are only allowed in test mode',
      );
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalOverrideFlag === undefined) {
        delete process.env.ALLOW_CHANNEL_PROVIDER_API_BASE_OVERRIDE;
      } else {
        process.env.ALLOW_CHANNEL_PROVIDER_API_BASE_OVERRIDE = originalOverrideFlag;
      }
    }
  });

  test('returns 404 for cross-tenant access to foreign project SDK keys and channel connections', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('super-admin'),
      uniqueSlug('tenant-gamma'),
      uniqueSlug('project-gamma'),
    );

    const foreignKey = await requestJson<{
      success: boolean;
      key: {
        id: string;
        key: string;
      };
    }>(harness, `/api/projects/${admin.projectId}/sdk-public-keys`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        name: 'Foreign Project Key',
      },
    });

    expect(foreignKey.status).toBe(201);

    const foreignConnection = await requestJson<{
      success: boolean;
      connection: {
        id: string;
      };
    }>(harness, `/api/projects/${admin.projectId}/channel-connections`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        channel_type: 'slack',
        display_name: 'Foreign Slack',
        external_identifier: 'T99999XYZ:A11111XYZ',
        credentials: {
          bot_token: 'xoxb-test-token',
          signing_secret: 'signing-secret',
        },
      },
    });

    expect(foreignConnection.status).toBe(201);

    const otherUser = await devLogin(harness, uniqueEmail('tenant-b-user'));
    await setSuperAdmins([admin.userId]);

    const otherTenant = await createTenant(
      harness,
      admin.token,
      'Tenant Delta',
      uniqueSlug('tenant-delta'),
    );
    await addMember(harness, admin.token, otherTenant._id, otherUser.user.email, 'ADMIN');

    const keyList = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/sdk-public-keys`,
      {
        headers: authHeaders(otherUser.accessToken),
      },
    );

    expect(keyList.status).toBe(404);

    const connectionList = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/channel-connections`,
      {
        headers: authHeaders(otherUser.accessToken),
      },
    );

    expect(connectionList.status).toBe(404);

    const revokeForeignKey = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/sdk-public-keys/${foreignKey.body.key.id}`,
      {
        method: 'DELETE',
        headers: authHeaders(otherUser.accessToken),
      },
    );

    expect(revokeForeignKey.status).toBe(404);
  });
});
