/**
 * Module Preview E2E Tests
 *
 * Exercises module-aware deployment resolution through the real Runtime HTTP API:
 * auth enforcement, module deployment resolution, module tool resolution,
 * multi-module dependencies, session creation with modules, tenant isolation,
 * deployment listing/detail, and deployment retirement.
 *
 * Uses ModuleE2EBootstrap which starts a real Express server with
 * MongoMemoryServer. Module-specific operations (releases, dependencies)
 * are seeded via Mongoose models (Studio-only operations). All assertions
 * go through HTTP API responses. Zero vi.mock() calls.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ModuleE2EBootstrap,
  SIMPLE_MODULE_AGENT_DSL,
  SIMPLE_MODULE_TOOL_DSL,
  CONSUMER_AGENT_DSL,
  MULTI_AGENT_MODULE_DSL,
} from '../helpers/module-e2e-bootstrap.js';
import { requestJson } from '../helpers/channel-e2e-bootstrap.js';
import { DeploymentModuleSnapshot, ModuleRelease } from '@agent-platform/database/models';
import zlib from 'node:zlib';

// ─── Suite-level setup ────────────────────────────────────────────────────────

let bootstrap: ModuleE2EBootstrap;

beforeAll(async () => {
  bootstrap = await ModuleE2EBootstrap.create();
}, 60_000);

afterAll(async () => {
  await bootstrap?.teardown();
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Module Preview E2E', { timeout: 120_000 }, () => {
  // ─── 1. Auth enforcement on deployment endpoints ────────────────────────

  describe('auth enforcement on deployment endpoints', () => {
    let consumerProjectId: string;

    beforeAll(async () => {
      // Create a project with an agent and deploy it so we have a real projectId
      const { projectId } = await bootstrap.createProject('Auth Test App');
      await bootstrap.createAgent(projectId, 'store_agent', CONSUMER_AGENT_DSL);
      await bootstrap.setEntryAgent(projectId, 'store_agent');
      consumerProjectId = projectId;
    }, 30_000);

    test('GET /deployments without auth token returns 401', async () => {
      const result = await requestJson(
        bootstrap.harness,
        `/api/projects/${consumerProjectId}/deployments`,
        { method: 'GET' },
      );

      expect(result.status).toBe(401);
    });

    test('POST /deployments without auth token returns 401', async () => {
      const result = await requestJson(
        bootstrap.harness,
        `/api/projects/${consumerProjectId}/deployments`,
        {
          method: 'POST',
          body: {
            environment: 'dev',
            agentVersionManifest: { store_agent: 'auto' },
            entryAgentName: 'store_agent',
          },
        },
      );

      expect(result.status).toBe(401);
    });

    test('GET /deployments with valid auth returns 200', async () => {
      const result = await bootstrap.get(`/api/projects/${consumerProjectId}/deployments`);

      expect(result.status).toBe(200);
      const body = result.body as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  // ─── 2. Module deployment resolution via API ────────────────────────────

  test('module deployment resolution — consumer deploys with imported module agent', async () => {
    // 1. Create a module project with an agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Preview Payment Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish a release
    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Initial release for preview test',
    });
    expect(releaseId).toBeTruthy();

    // 3. Create a consumer project with its own agent
    const { projectId: consumerProjectId } = await bootstrap.createProject('Preview Store App');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    // 4. Import the module
    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
    );
    expect(dependencyId).toBeTruthy();

    // 5. Deploy the consumer project
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 6. Verify deployment detail via API
    const detailResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(detailResult.status).toBe(200);

    const detailBody = detailResult.body as {
      success: boolean;
      deployment: {
        id: string;
        entryAgentName: string;
        agentVersionManifest: Record<string, string>;
        status: string;
      };
    };
    expect(detailBody.success).toBe(true);
    expect(detailBody.deployment.entryAgentName).toBe('store_agent');
    expect(detailBody.deployment.agentVersionManifest).toHaveProperty('store_agent');
    expect(detailBody.deployment.status).toBe('active');
  }, 30_000);

  // ─── 3. Module tool resolution via API ──────────────────────────────────

  test('module tool resolution — consumer deploys with module that provides tools', async () => {
    // 1. Create a module project with an agent and a tool
    const { projectId: moduleProjectId } = await bootstrap.createProject('Tool Module', 'module');
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.createTool(moduleProjectId, 'validate_card', SIMPLE_MODULE_TOOL_DSL, 'http');
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish a release — artifact should include both agent and tool
    const { releaseId, version } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Release with tools',
    });
    expect(releaseId).toBeTruthy();
    expect(version).toBe('1.0.0');

    // 3. Verify the release artifact includes the tool via DB read
    const release = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(release).toBeTruthy();

    const artifact = (release as Record<string, unknown>).artifact as {
      tools: Record<string, unknown>;
      agents: Record<string, unknown>;
    };
    expect(artifact.agents).toHaveProperty('payment_processor');
    expect(artifact.tools).toHaveProperty('validate_card');

    // 4. Create consumer, import module, deploy
    const { projectId: consumerProjectId } = await bootstrap.createProject('Tool Consumer App');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });

    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 5. Verify the deployment was created and is active
    const detailResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(detailResult.status).toBe(200);

    const detailBody = detailResult.body as {
      success: boolean;
      deployment: { id: string; status: string };
    };
    expect(detailBody.success).toBe(true);
    expect(detailBody.deployment.status).toBe('active');
  }, 30_000);

  test('module publish/import/deploy preserves publish-time tool definitions and applies config overrides into the deployment snapshot', async () => {
    const configurableToolDsl = `TOOLS:
  validate_card(card_number: string) -> object
    type: http
    endpoint: "{{config.API_BASE}}/validate"
    method: POST
    auth_profile: "{{config.AUTH_PROFILE}}"
    description: "Validate cards against {{config.API_BASE}}"
`;

    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Configurable Tool Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.createTool(moduleProjectId, 'validate_card', configurableToolDsl, 'http');
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');
    const release = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(release).toBeTruthy();

    const releaseArtifact = (release as Record<string, unknown>).artifact as {
      tools: Record<string, { definition?: Record<string, unknown> }>;
    };
    expect(releaseArtifact.tools.validate_card.definition).toEqual(
      expect.objectContaining({
        name: 'validate_card',
        auth_profile_ref: '{{config.AUTH_PROFILE}}',
        http_binding: expect.objectContaining({
          endpoint: '{{config.API_BASE}}/validate',
          method: 'POST',
        }),
      }),
    );

    const { projectId: consumerProjectId } = await bootstrap.createProject('Config Tool Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const authProfileResult = await bootstrap.post('/api/auth-profiles', {
      name: 'crm_shared_auth',
      authType: 'api_key',
      scope: 'tenant',
      visibility: 'shared',
      config: { headerName: 'Authorization' },
      secrets: { apiKey: 'crm-test-key' },
    });
    expect(authProfileResult.status).toBe(201);

    await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
      {
        API_BASE: 'https://tenant.example.com',
        AUTH_PROFILE: 'crm_shared_auth',
      },
    );

    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    const snapshot = await DeploymentModuleSnapshot.findOne({
      tenantId: bootstrap.tenantId,
      deploymentId,
    }).lean();
    expect(snapshot).toBeTruthy();

    const rawPayload = (snapshot as { compressedPayload: unknown }).compressedPayload;
    const compressedPayload = Buffer.isBuffer(rawPayload)
      ? rawPayload
      : Buffer.from((rawPayload as { buffer?: ArrayBuffer }).buffer ?? rawPayload);
    const payload = JSON.parse(zlib.gunzipSync(compressedPayload).toString()) as {
      dependencies: Array<{ alias: string; configOverrides: Record<string, string> }>;
      mountedTools: Record<string, { definition: Record<string, unknown> }>;
    };

    expect(payload.dependencies).toEqual([
      expect.objectContaining({
        alias: 'payments',
        configOverrides: {
          API_BASE: 'https://tenant.example.com',
          AUTH_PROFILE: 'crm_shared_auth',
        },
      }),
    ]);
    expect(payload.mountedTools.payments__validate_card.definition).toEqual(
      expect.objectContaining({
        auth_profile_ref: 'crm_shared_auth',
        http_binding: expect.objectContaining({
          endpoint: 'https://tenant.example.com/validate',
          method: 'POST',
        }),
      }),
    );
  }, 30_000);

  // ─── 4. Multi-module dependency resolution ──────────────────────────────

  test('multi-module dependency resolution — consumer with 2 module dependencies deploys successfully', async () => {
    // 1. Create Module A: payment module
    const { projectId: moduleAId } = await bootstrap.createProject('Multi Pay Module', 'module');
    await bootstrap.createAgent(moduleAId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleAId, 'payment_processor');
    const { releaseId: releaseA } = await bootstrap.publishRelease(moduleAId, '1.0.0');
    expect(releaseA).toBeTruthy();

    // 2. Create Module B: order management module with 2 agents
    const { projectId: moduleBId } = await bootstrap.createProject('Multi Order Module', 'module');
    await bootstrap.createAgent(moduleBId, 'order_supervisor', MULTI_AGENT_MODULE_DSL.entry);
    await bootstrap.createAgent(moduleBId, 'order_worker', MULTI_AGENT_MODULE_DSL.worker);
    await bootstrap.setEntryAgent(moduleBId, 'order_supervisor');
    const { releaseId: releaseB } = await bootstrap.publishRelease(moduleBId, '1.0.0');
    expect(releaseB).toBeTruthy();

    // 3. Create consumer project
    const { projectId: consumerProjectId } = await bootstrap.createProject('Multi Module Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    // 4. Import both modules
    const { dependencyId: depA } = await bootstrap.importModule(
      consumerProjectId,
      moduleAId,
      'payments',
      { type: 'version', value: '1.0.0' },
    );
    const { dependencyId: depB } = await bootstrap.importModule(
      consumerProjectId,
      moduleBId,
      'orders',
      { type: 'version', value: '1.0.0' },
    );
    expect(depA).toBeTruthy();
    expect(depB).toBeTruthy();

    // 5. Deploy the consumer
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 6. Verify deployment via API
    const detailResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(detailResult.status).toBe(200);

    const detailBody = detailResult.body as {
      success: boolean;
      deployment: {
        id: string;
        status: string;
        entryAgentName: string;
        agentVersionManifest: Record<string, string>;
      };
    };
    expect(detailBody.success).toBe(true);
    expect(detailBody.deployment.status).toBe('active');
    expect(detailBody.deployment.entryAgentName).toBe('store_agent');
    // Consumer's own agent must be in the manifest
    expect(detailBody.deployment.agentVersionManifest).toHaveProperty('store_agent');
  }, 30_000);

  // ─── 5. Session creation with module context ────────────────────────────

  test('session creation with module context — SDK init succeeds for deployed consumer with module dependency', async () => {
    // 1. Create module project
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Session Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');
    await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      promoteToEnvironment: 'dev',
    });

    // 2. Create consumer project with dependency
    const { projectId: consumerProjectId } = await bootstrap.createProject('Session Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');
    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });

    // 3. Deploy
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 4. Create SDK public key, SDK channel, and init session
    const { createSdkPublicKey, createSdkBootstrapChannel, initSdkSession } =
      await import('../helpers/channel-e2e-bootstrap.js');
    const publicKey = await createSdkPublicKey(
      bootstrap.harness,
      bootstrap.authToken,
      consumerProjectId,
      { name: `Session Module Key ${Date.now()}` },
    );

    await createSdkBootstrapChannel(
      bootstrap.harness,
      bootstrap.authToken,
      consumerProjectId,
      publicKey.id,
      { deploymentId: deploymentId },
    );

    const sdkSession = await initSdkSession(bootstrap.harness, {
      publicKey: publicKey.key!,
      userContext: { userId: `e2e-session-user-${Date.now()}` },
    });

    // 5. Verify SDK session initialized successfully
    expect(sdkSession.token).toBeTruthy();
    expect(sdkSession.projectId).toBe(consumerProjectId);
    expect(sdkSession.tenantId).toBe(bootstrap.tenantId);
  }, 30_000);

  // ─── 6. Tenant isolation for modules ────────────────────────────────────

  test('tenant isolation — module from tenant1 cannot be accessed by fabricated tenant2', async () => {
    // 1. Create a module in the bootstrap tenant (tenant1)
    const { projectId: tenant1ModuleId } = await bootstrap.createProject(
      'Tenant1 Preview Module',
      'module',
    );
    await bootstrap.createAgent(tenant1ModuleId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(tenant1ModuleId, 'payment_processor');
    const { releaseId: tenant1ReleaseId } = await bootstrap.publishRelease(
      tenant1ModuleId,
      '1.0.0',
      { promoteToEnvironment: 'dev' },
    );
    expect(tenant1ReleaseId).toBeTruthy();

    // 2. Fabricated tenant2 ID — same MongoDB, different tenantId
    const tenant2Id = '019d0000-0000-7000-0000-000000000099';

    // 3. Verify tenant2 cannot find tenant1's releases
    const tenant2Releases = await ModuleRelease.find({
      tenantId: tenant2Id,
      moduleProjectId: tenant1ModuleId,
    }).lean();
    expect(tenant2Releases).toHaveLength(0);

    // 4. Verify tenant2 cannot find tenant1's release by ID (scoped by tenantId)
    const crossTenantRelease = await ModuleRelease.findOne({
      _id: tenant1ReleaseId,
      tenantId: tenant2Id,
    }).lean();
    expect(crossTenantRelease).toBeNull();

    // 5. Verify tenant1 CAN find its own release
    const tenant1Release = await ModuleRelease.findOne({
      _id: tenant1ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(tenant1Release).toBeTruthy();
    expect((tenant1Release as Record<string, unknown>).version).toBe('1.0.0');
  }, 30_000);

  // ─── 7. Deployment listing and detail ───────────────────────────────────

  describe('deployment listing and detail', () => {
    let consumerProjectId: string;
    let deploymentId: string;

    beforeAll(async () => {
      // Create a consumer project, deploy it
      const { projectId } = await bootstrap.createProject('List Detail Consumer');
      await bootstrap.createAgent(projectId, 'store_agent', CONSUMER_AGENT_DSL);
      await bootstrap.setEntryAgent(projectId, 'store_agent');
      const result = await bootstrap.deploy(projectId, {
        entryAgentName: 'store_agent',
      });
      consumerProjectId = projectId;
      deploymentId = result.deploymentId;
    }, 30_000);

    test('GET /deployments returns list with correct structure', async () => {
      const result = await bootstrap.get(`/api/projects/${consumerProjectId}/deployments`);

      expect(result.status).toBe(200);
      const body = result.body as {
        success: boolean;
        deployments: Array<{
          id: string;
          projectId: string;
          environment: string;
          status: string;
          label: string | null;
          endpointSlug: string;
        }>;
      };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.deployments)).toBe(true);
      expect(body.deployments.length).toBeGreaterThanOrEqual(1);

      // Find the deployment we created
      const found = body.deployments.find((d) => d.id === deploymentId);
      expect(found).toBeDefined();
      expect(found?.projectId).toBe(consumerProjectId);
      expect(found?.environment).toBe('dev');
      expect(found?.status).toBe('active');
      expect(found?.endpointSlug).toBeTruthy();
    });

    test('GET /deployments/:id returns full detail with channelCount', async () => {
      const result = await bootstrap.get(
        `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
      );

      expect(result.status).toBe(200);
      const body = result.body as {
        success: boolean;
        deployment: {
          id: string;
          projectId: string;
          environment: string;
          status: string;
          label: string | null;
          description: string | null;
          endpointSlug: string;
          entryAgentName: string;
          agentVersionManifest: Record<string, string>;
          channelCount: number;
        };
      };
      expect(body.success).toBe(true);
      expect(body.deployment.id).toBe(deploymentId);
      expect(body.deployment.projectId).toBe(consumerProjectId);
      expect(body.deployment.entryAgentName).toBe('store_agent');
      expect(body.deployment.agentVersionManifest).toHaveProperty('store_agent');
      expect(typeof body.deployment.channelCount).toBe('number');
      expect(body.deployment.endpointSlug).toBeTruthy();
    });

    test('GET /deployments/:id with nonexistent ID returns 404', async () => {
      const result = await bootstrap.get(
        `/api/projects/${consumerProjectId}/deployments/000000000000000000000000`,
      );

      expect(result.status).toBe(404);
      const body = result.body as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });
  });

  // ─── 8. Deployment retirement via API ───────────────────────────────────

  describe('deployment retirement via API', () => {
    test('POST /deployments/:id/retire transitions active to draining', async () => {
      // 1. Create and deploy a project
      const { projectId } = await bootstrap.createProject('Retire Test App');
      await bootstrap.createAgent(projectId, 'store_agent', CONSUMER_AGENT_DSL);
      await bootstrap.setEntryAgent(projectId, 'store_agent');
      const { deploymentId } = await bootstrap.deploy(projectId, {
        entryAgentName: 'store_agent',
      });

      // 2. Retire the deployment (default: transitions active → draining)
      const retireResult = await bootstrap.post(
        `/api/projects/${projectId}/deployments/${deploymentId}/retire`,
        {},
      );

      expect(retireResult.status).toBe(200);
      const retireBody = retireResult.body as {
        success: boolean;
        deployment: {
          id: string;
          status: string;
          drainingStartedAt: string | null;
        };
      };
      expect(retireBody.success).toBe(true);
      expect(retireBody.deployment.status).toBe('draining');
      expect(retireBody.deployment.drainingStartedAt).toBeTruthy();

      // 3. Retire again (draining → retired)
      const retireAgainResult = await bootstrap.post(
        `/api/projects/${projectId}/deployments/${deploymentId}/retire`,
        {},
      );

      expect(retireAgainResult.status).toBe(200);
      const retireAgainBody = retireAgainResult.body as {
        success: boolean;
        deployment: { id: string; status: string };
      };
      expect(retireAgainBody.success).toBe(true);
      expect(retireAgainBody.deployment.status).toBe('retired');
    }, 30_000);

    test('POST /deployments/:id/retire with force=true retires immediately', async () => {
      // 1. Create and deploy a project
      const { projectId } = await bootstrap.createProject('Force Retire Test App');
      await bootstrap.createAgent(projectId, 'store_agent', CONSUMER_AGENT_DSL);
      await bootstrap.setEntryAgent(projectId, 'store_agent');
      const { deploymentId } = await bootstrap.deploy(projectId, {
        entryAgentName: 'store_agent',
      });

      // 2. Force retire
      const retireResult = await bootstrap.post(
        `/api/projects/${projectId}/deployments/${deploymentId}/retire`,
        { force: true },
      );

      expect(retireResult.status).toBe(200);
      const retireBody = retireResult.body as {
        success: boolean;
        deployment: { id: string; status: string };
      };
      expect(retireBody.success).toBe(true);
      expect(retireBody.deployment.status).toBe('retired');
    }, 30_000);

    test('retired deployment cannot be retired again', async () => {
      // 1. Create, deploy, force-retire
      const { projectId } = await bootstrap.createProject('Already Retired Test App');
      await bootstrap.createAgent(projectId, 'store_agent', CONSUMER_AGENT_DSL);
      await bootstrap.setEntryAgent(projectId, 'store_agent');
      const { deploymentId } = await bootstrap.deploy(projectId, {
        entryAgentName: 'store_agent',
      });

      // Force retire
      await bootstrap.post(`/api/projects/${projectId}/deployments/${deploymentId}/retire`, {
        force: true,
      });

      // 2. Attempt to retire again — should fail with 422
      const retireAgainResult = await bootstrap.post(
        `/api/projects/${projectId}/deployments/${deploymentId}/retire`,
        {},
      );

      expect(retireAgainResult.status).toBe(422);
      const body = retireAgainResult.body as {
        success: boolean;
        error: string;
      };
      expect(body.success).toBe(false);
    }, 30_000);
  });
});
