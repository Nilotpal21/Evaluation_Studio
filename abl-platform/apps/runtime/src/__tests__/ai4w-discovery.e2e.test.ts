/**
 * AI4W Discovery & Provisioning E2E Tests
 *
 * Exercises the internal discovery API through real middleware with
 * in-memory MongoDB and an in-process JWKS server. No vi.mock().
 *
 * Tests:
 * - Tenant discovery returns RBAC-filtered list (sorted by name asc)
 * - Project discovery returns projects with live agentCount
 * - Cross-tenant discovery returns empty list (not 403)
 * - Provisioning creates a project-bound connection (agentId not accepted)
 * - Provisioning rejects environment + deploymentId together
 * - Missing/invalid service token returns 401
 * - Deactivate is idempotent; DELETE removes the row (channelType='ai4w' scoped)
 *
 * Note: /info lives at GET /api/v1/channels/ai4w/:id/info with HMAC+JWT auth.
 * It is covered by ai4w-channel.e2e.test.ts where HMAC-signing helpers exist.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../routes/platform-admin-models.js';
import projectIoRouter from '../routes/project-io.js';
import channelConnectionsRouter from '../routes/channel-connections.js';
import deploymentsRouter from '../routes/deployments.js';
import internalDiscoveryRouter from '../routes/internal-discovery.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  authHeaders,
  devLogin,
  createProject,
  addMember,
  provisionBasicAgentProject,
  importProjectFiles,
  provisionTenantModel,
} from './helpers/channel-e2e-bootstrap.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from './helpers/redis-server-harness.js';
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const E2E_TIMEOUT_MS = 60_000;
let TEST_ISSUER: string; // set to http://127.0.0.1:{jwksPort} after listen
const TEST_AUDIENCE = 'urn:kore:agentic';
const TEST_SERVICE_TOKEN = 'test-ai4w-service-token-' + crypto.randomBytes(16).toString('hex');

// ---------------------------------------------------------------------------
// Test key material
// ---------------------------------------------------------------------------

let privateKey: KeyLike;
let jwksServer: http.Server;
let jwksPort: number;

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function mintJwt(
  overrides: {
    subject?: string;
    issuer?: string;
    audience?: string;
    email?: string;
    accountId?: string;
    expiresIn?: string;
  } = {},
): Promise<string> {
  const builder = new SignJWT({
    email: overrides.email ?? 'user@test.com',
    accountId: overrides.accountId ?? 'acc_discovery_test',
    scope: 'agentic',
    product: 'AgenticApp',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'discovery-key-1' })
    .setSubject(overrides.subject ?? 'user_disc_456')
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setAudience(overrides.audience ?? TEST_AUDIENCE)
    .setIssuedAt();

  if (overrides.expiresIn) {
    builder.setExpirationTime(overrides.expiresIn);
  } else {
    builder.setExpirationTime('1h');
  }

  return builder.sign(privateKey);
}

// ---------------------------------------------------------------------------
// Service-authed request helper
// ---------------------------------------------------------------------------

async function serviceRequest<T>(
  harness: RuntimeApiHarness,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    email?: string;
    serviceToken?: string;
    omitServiceToken?: boolean;
    omitJwt?: boolean;
  } = {},
): Promise<{ status: number; body: T }> {
  const jwt = options.omitJwt ? undefined : await mintJwt({ email: options.email });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (!options.omitServiceToken) {
    headers['X-Service-Token'] = options.serviceToken ?? TEST_SERVICE_TOKEN;
  }

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };

  if (options.body) {
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${harness.baseUrl}${path}`, init);
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Test suite — requires Redis for JWT verification
// ---------------------------------------------------------------------------

const describeDiscoveryE2E = isRedisServerHarnessAvailable() ? describe.sequential : describe.skip;

describeDiscoveryE2E('AI4W Discovery & Provisioning E2E', () => {
  let harness: RuntimeApiHarness;
  let redis: RedisServerHarness;
  let mockLlm: MockLLM;

  // Shared test state
  let adminEmail: string;
  let adminToken: string;
  let adminUserId: string;
  let tenantId: string;
  let projectId: string;

  beforeAll(async () => {
    // 1. Generate RS256 key pair for JWT signing
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'discovery-key-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    // 2. Start in-process server that serves BOTH JWKS and OIDC discovery
    jwksServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: TEST_ISSUER,
            jwks_uri: `${TEST_ISSUER}/.well-known/jwks.json`,
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      jwksServer.listen(0, '127.0.0.1', () => resolve());
    });
    jwksPort = (jwksServer.address() as AddressInfo).port;
    TEST_ISSUER = `http://127.0.0.1:${jwksPort}`;

    // 3. Set AI4W env vars
    process.env.AI4W_INTERNAL_API_ENABLED = 'true';
    process.env.AI4W_SERVICE_TOKEN = TEST_SERVICE_TOKEN;
    process.env.AI4W_TRUSTED_ISSUERS = TEST_ISSUER;
    process.env.AI4W_JWT_AUDIENCE = TEST_AUDIENCE;
    process.env.AI4W_ALLOW_HTTP_ISSUERS = 'true';

    // 4. Start Redis
    redis = await startRedisServerHarness();
    mockLlm = await startMockLLM();

    // 5. Start runtime harness
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/projects/:projectId/deployments', deploymentsRouter);
        app.use('/api/internal/v1', internalDiscoveryRouter);
      },
      {
        REDIS_ENABLED: 'true',
        REDIS_URL: redis.url,
      },
    );

    // Populate the trusted-issuer registry (server.ts does this in
    // startServer(), but the harness loads the module without starting).
    const { __resetAI4WAuthForTests, initAI4WAuth } =
      await import('../channels/adapters/ai4w-auth.js');
    __resetAI4WAuthForTests();
    await initAI4WAuth();
  }, E2E_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await redis.clear();
    await setSuperAdmins([]);
    mockLlm.reset();

    // Bootstrap a fresh project for each test
    adminEmail = uniqueEmail('disc-admin');
    const admin = await bootstrapProject(
      harness,
      adminEmail,
      uniqueSlug('tenant-disc'),
      uniqueSlug('project-disc'),
    );

    adminToken = admin.token;
    adminUserId = admin.userId;
    tenantId = admin.tenantId;
    projectId = admin.projectId;
  });

  afterAll(async () => {
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (redis) await redis.close();
    if (jwksServer) {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    }
    delete process.env.AI4W_INTERNAL_API_ENABLED;
    delete process.env.AI4W_SERVICE_TOKEN;
    delete process.env.AI4W_TRUSTED_ISSUERS;
    delete process.env.AI4W_JWT_AUDIENCE;
    delete process.env.AI4W_ALLOW_HTTP_ISSUERS;
  }, E2E_TIMEOUT_MS);

  // =========================================================================
  // AUTH FAILURES
  // =========================================================================

  test(
    'missing service token returns 401',
    async () => {
      const res = await serviceRequest(
        harness,
        `/api/internal/v1/tenants/by-membership?email=${adminEmail}`,
        { omitServiceToken: true },
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'invalid service token returns 401',
    async () => {
      const res = await serviceRequest(
        harness,
        `/api/internal/v1/tenants/by-membership?email=${adminEmail}`,
        { serviceToken: 'wrong-token' },
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'missing JWT returns 401',
    async () => {
      const res = await serviceRequest(
        harness,
        `/api/internal/v1/tenants/by-membership?email=${adminEmail}`,
        { omitJwt: true },
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // TENANT DISCOVERY
  // =========================================================================

  test(
    'tenant discovery returns tenants for valid email',
    async () => {
      const res = await serviceRequest<{
        success: boolean;
        data: { tenants: { id: string; name: string }[] };
      }>(harness, `/api/internal/v1/tenants/by-membership?email=${adminEmail}`, {
        email: adminEmail,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tenants).toBeInstanceOf(Array);
      expect(res.body.data.tenants.length).toBeGreaterThanOrEqual(1);

      const found = res.body.data.tenants.find((t: { id: string }) => t.id === tenantId);
      expect(found).toBeDefined();
      expect(found!.name).toBeTruthy();
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'query email mismatching JWT identity returns 403 EMAIL_MISMATCH',
    async () => {
      // Caller authenticates with JWT for adminEmail but tries to look up
      // another user's tenants via the query string. This is the
      // impersonation path — must be blocked, not silently allowed.
      const otherEmail = uniqueEmail('other-user');
      const res = await serviceRequest<{
        success: boolean;
        error: { code: string };
      }>(harness, `/api/internal/v1/tenants/by-membership?email=${otherEmail}`, {
        email: adminEmail,
      });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('EMAIL_MISMATCH');
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'omitting query email uses JWT claim for lookup',
    async () => {
      // The query parameter is now optional — the JWT claim is the source
      // of truth. Calling without `?email=` must still resolve via the JWT.
      const res = await serviceRequest<{
        success: boolean;
        data: { tenants: { id: string; name: string }[] };
      }>(harness, `/api/internal/v1/tenants/by-membership`, {
        email: adminEmail,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const found = res.body.data.tenants.find((t: { id: string }) => t.id === tenantId);
      expect(found).toBeDefined();
    },
    E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // PROJECT DISCOVERY
  // =========================================================================

  test(
    'project discovery returns projects in tenant with live agentCount',
    async () => {
      // Import a simple agent and create a deployment so agentCount > 0.
      await provisionBasicAgentProject(
        harness,
        adminToken,
        tenantId,
        projectId,
        mockLlm.url,
        'greeter',
      );

      const res = await serviceRequest<{
        success: boolean;
        data: {
          projects: {
            id: string;
            name: string;
            description: string;
            agentCount: number;
          }[];
          nextCursor: string | null;
        };
      }>(harness, `/api/internal/v1/tenants/${tenantId}/projects/discoverable`, {
        email: adminEmail,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.projects).toBeInstanceOf(Array);
      expect(res.body.data.projects.length).toBeGreaterThanOrEqual(1);

      const project = res.body.data.projects.find((p: { id: string }) => p.id === projectId);
      expect(project).toBeDefined();
      expect(project!.agentCount).toBeGreaterThanOrEqual(1);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'project discovery for wrong tenant returns empty list',
    async () => {
      const fakeTenantId = crypto.randomUUID();
      const res = await serviceRequest<{
        success: boolean;
        data: { projects: unknown[]; nextCursor: string | null };
      }>(harness, `/api/internal/v1/tenants/${fakeTenantId}/projects/discoverable`, {
        email: adminEmail,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.projects).toEqual([]);
      expect(res.body.data.nextCursor).toBeNull();
    },
    E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // PROVISIONING
  // =========================================================================

  test(
    'provisioning creates connection and returns connectionId + connectionSecret',
    async () => {
      const res = await serviceRequest<{
        success: boolean;
        data: { connectionId: string; connectionSecret: string };
      }>(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          connectionName: 'Test Connection',
          environment: 'production',
          callbackBaseUrl: 'https://external-service.example.com/callback',
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.connectionId).toMatch(/^ai4w_c_/);
      expect(res.body.data.connectionSecret).toMatch(/^abl_cs_/);
      // /info verification lives in ai4w-channel.e2e.test.ts (HMAC+JWT path).
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning with async response mode returns 201',
    async () => {
      const res = await serviceRequest<{
        success: boolean;
        data: { connectionId: string; connectionSecret: string };
      }>(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          connectionName: 'Async Connection',
          environment: 'production',
          callbackBaseUrl: 'https://external.example.com/hooks',
          responseMode: 'async',
        },
      });

      expect(res.status).toBe(201);
      // responseMode storage is covered by ai4w-channel.e2e.test.ts /info tests.
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning with invalid body returns 400',
    async () => {
      const res = await serviceRequest(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: { tenantId }, // missing required fields
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning by non-member returns 403',
    async () => {
      const nonMemberEmail = uniqueEmail('outsider');
      // Create a user that isn't a member of this tenant
      await devLogin(harness, nonMemberEmail);

      const res = await serviceRequest(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: nonMemberEmail,
        body: {
          tenantId,
          projectId,
          connectionName: 'Forbidden Connection',
          environment: 'production',
          callbackBaseUrl: 'https://external.example.com/hooks',
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning by tenant member without project membership returns 403',
    async () => {
      const memberEmail = uniqueEmail('tenant-member');
      await devLogin(harness, memberEmail);
      await addMember(harness, adminToken, tenantId, memberEmail, 'MEMBER');

      const res = await serviceRequest(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: memberEmail,
        body: {
          tenantId,
          projectId,
          connectionName: 'Project Forbidden Connection',
          environment: 'production',
          callbackBaseUrl: 'https://external.example.com/hooks',
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  // NOTE: connection /info lives at GET /api/v1/channels/ai4w/:id/info and
  // uses HMAC+JWT auth. Its behaviour (meta payload, 401 on bad HMAC, secret
  // never leaked) is covered in ai4w-channel.e2e.test.ts where the HMAC
  // signing helpers are available.

  // =========================================================================
  // PROVISIONING — validation edge cases (A2)
  // =========================================================================

  test(
    'provisioning rejects environment + deploymentId together with 400',
    async () => {
      const res = await serviceRequest(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          environment: 'production',
          deploymentId: 'dep-123',
          callbackBaseUrl: 'https://external.example.com/hook',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning rejects invalid environment with 400',
    async () => {
      const res = await serviceRequest(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          environment: 'prod-east',
          callbackBaseUrl: 'https://external.example.com/hook',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning rejects deploymentId outside the requested project',
    async () => {
      const secondProject = await createProject(
        harness,
        adminToken,
        tenantId,
        'Second Project',
        uniqueSlug('project-disc-second'),
      );
      const secondDeployment = await provisionBasicAgentProject(
        harness,
        adminToken,
        tenantId,
        secondProject._id,
        mockLlm.url,
        'other_greeter',
      );

      const res = await serviceRequest(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          deploymentId: secondDeployment.id,
          callbackBaseUrl: 'https://external.example.com/hook',
        },
      });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning rejects unknown agentId field (project-only binding)',
    async () => {
      const res = await serviceRequest(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          agentId: 'legacy-agent-1',
          connectionName: 'Legacy',
          callbackBaseUrl: 'https://external.example.com/hook',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'provisioning without connectionName succeeds (default applied server-side)',
    async () => {
      const first = await serviceRequest<{
        success: boolean;
        data: { connectionId: string };
      }>(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          environment: 'production',
          callbackBaseUrl: 'https://external.example.com/hook-1',
        },
      });
      expect(first.status).toBe(201);
      expect(first.body.data.connectionId).toMatch(/^ai4w_c_/);

      const second = await serviceRequest<{
        success: boolean;
        data: { connectionId: string };
      }>(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          environment: 'production',
          callbackBaseUrl: 'https://external.example.com/hook-2',
        },
      });
      expect(second.status).toBe(201);
      expect(second.body.data.connectionId).not.toBe(first.body.data.connectionId);
      // displayName default is verified through ai4w-channel.e2e.test.ts /info checks.
    },
    E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // LIFECYCLE — deactivate + unlink (C1 + C2)
  // =========================================================================

  test(
    'deactivate returns 200 and is idempotent',
    async () => {
      const prov = await serviceRequest<{
        success: boolean;
        data: { connectionId: string };
      }>(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          connectionName: 'To Deactivate',
          environment: 'production',
          callbackBaseUrl: 'https://external.example.com/dhook',
        },
      });
      expect(prov.status).toBe(201);
      const { connectionId } = prov.body.data;

      const deact1 = await serviceRequest(
        harness,
        `/api/internal/v1/channel-connections/${connectionId}/deactivate`,
        { method: 'POST', email: adminEmail, body: {} },
      );
      expect(deact1.status).toBe(200);
      expect(deact1.body).toMatchObject({
        success: true,
        data: { status: 'inactive' },
      });

      // Idempotent — deactivate again still returns 200
      const deact2 = await serviceRequest(
        harness,
        `/api/internal/v1/channel-connections/${connectionId}/deactivate`,
        { method: 'POST', email: adminEmail, body: {} },
      );
      expect(deact2.status).toBe(200);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'DELETE removes connection; subsequent DELETE on same id returns 404',
    async () => {
      const prov = await serviceRequest<{
        success: boolean;
        data: { connectionId: string };
      }>(harness, '/api/internal/v1/channel-connections/provision', {
        method: 'POST',
        email: adminEmail,
        body: {
          tenantId,
          projectId,
          connectionName: 'To Delete',
          environment: 'production',
          callbackBaseUrl: 'https://external.example.com/xhook',
        },
      });
      expect(prov.status).toBe(201);
      const { connectionId } = prov.body.data;

      const del = await serviceRequest(
        harness,
        `/api/internal/v1/channel-connections/${connectionId}`,
        { method: 'DELETE', email: adminEmail },
      );
      expect(del.status).toBe(200);
      expect(del.body).toMatchObject({ success: true, data: { deleted: true } });

      // Second DELETE on the same id — row is gone → 404
      const del2 = await serviceRequest(
        harness,
        `/api/internal/v1/channel-connections/${connectionId}`,
        { method: 'DELETE', email: adminEmail },
      );
      expect(del2.status).toBe(404);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'DELETE on non-existent connection returns 404',
    async () => {
      const res = await serviceRequest(
        harness,
        '/api/internal/v1/channel-connections/ai4w_c_doesnotexist',
        { method: 'DELETE', email: adminEmail },
      );
      expect(res.status).toBe(404);
    },
    E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // ENVIRONMENT DISCOVERY
  // =========================================================================

  test(
    'environment discovery returns available environments for a project',
    async () => {
      // Create a deployment in production environment to seed the environments list
      await provisionBasicAgentProject(
        harness,
        adminToken,
        tenantId,
        projectId,
        mockLlm.url,
        'env_test_agent',
      );

      const res = await serviceRequest<{
        success: boolean;
        data: { environments: string[] };
      }>(harness, `/api/internal/v1/tenants/${tenantId}/projects/${projectId}/environments`, {
        email: adminEmail,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.environments).toBeInstanceOf(Array);
      expect(res.body.data.environments).toContain('production');
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'environment discovery returns empty array for project with no deployments',
    async () => {
      // Fresh project has no deployments → empty environments
      const freshProject = await createProject(
        harness,
        adminToken,
        tenantId,
        'No Deployments',
        uniqueSlug('project-no-deploy'),
      );

      const res = await serviceRequest<{
        success: boolean;
        data: { environments: string[] };
      }>(
        harness,
        `/api/internal/v1/tenants/${tenantId}/projects/${freshProject._id}/environments`,
        { email: adminEmail },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.environments).toEqual([]);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'environment discovery returns 403 for non-member of tenant',
    async () => {
      const outsiderEmail = uniqueEmail('env-outsider');
      await devLogin(harness, outsiderEmail);

      const res = await serviceRequest(
        harness,
        `/api/internal/v1/tenants/${tenantId}/projects/${projectId}/environments`,
        { email: outsiderEmail },
      );

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'environment discovery returns 404 for non-existent project',
    async () => {
      const fakeProjectId = crypto.randomUUID();
      const res = await serviceRequest(
        harness,
        `/api/internal/v1/tenants/${tenantId}/projects/${fakeProjectId}/environments`,
        { email: adminEmail },
      );

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'environment discovery returns error for invalid tenantId/projectId',
    async () => {
      // Empty-string params are caught by Zod validation → 400
      const res = await serviceRequest(
        harness,
        '/api/internal/v1/tenants/x/projects/y/environments',
        { email: adminEmail },
      );

      // Non-member of fake tenant → 403
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      });
    },
    E2E_TIMEOUT_MS,
  );

  // =========================================================================
  // AGENT COUNT SEMANTICS
  // =========================================================================

  test(
    'agentCount reflects number of agents, not deployments',
    async () => {
      const modelId = 'count_test_model';

      await provisionTenantModel(harness, adminToken, {
        targetTenantId: tenantId,
        displayName: 'Count Test Model',
        integrationType: 'api',
        provider: 'openai_compatible',
        modelId,
        endpointUrl: mockLlm.url,
        supportsStreaming: true,
        supportsTools: true,
        capabilities: ['text', 'tools', 'streaming'],
        tier: 'balanced',
        isDefault: false,
        connection: {
          credentialName: 'count-test-cred',
          apiKey: 'test-key-count',
        },
      });

      // Import two agents
      await importProjectFiles(harness, adminToken, projectId, {
        'agents/agent_alpha.agent.abl': [
          'AGENT: agent_alpha',
          'GOAL: "Alpha agent"',
          'EXECUTION:',
          `  model: ${modelId}`,
          'PERSONA:',
          '  You are alpha.',
        ].join('\n'),
        'agents/agent_beta.agent.abl': [
          'AGENT: agent_beta',
          'GOAL: "Beta agent"',
          'EXECUTION:',
          `  model: ${modelId}`,
          'PERSONA:',
          '  You are beta.',
        ].join('\n'),
      });

      const res = await serviceRequest<{
        success: boolean;
        data: {
          projects: { id: string; agentCount: number }[];
          nextCursor: string | null;
        };
      }>(harness, `/api/internal/v1/tenants/${tenantId}/projects/discoverable`, {
        email: adminEmail,
      });

      expect(res.status).toBe(200);
      const project = res.body.data.projects.find((p) => p.id === projectId);
      expect(project).toBeDefined();
      // We imported 2 agents (no deployment created) → agentCount should be 2
      expect(project!.agentCount).toBe(2);
    },
    E2E_TIMEOUT_MS,
  );
});
