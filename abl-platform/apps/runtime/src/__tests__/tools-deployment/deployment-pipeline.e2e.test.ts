/**
 * Deployment Pipeline E2E Tests
 *
 * Exercises the full deployment lifecycle through the HTTP API:
 *   - Agent import via project-io
 *   - Agent version listing
 *   - Deployment creation with auto-versioning
 *   - Deployment listing, detail, filtering
 *   - Deployment retirement and rollback
 *   - Deployment promotion across environments
 *   - Multi-agent deployments
 *   - SDK session creation from deployment
 *   - Auth enforcement and tenant isolation
 *   - Preflight validation
 *
 * ZERO vi.mock() calls — real Express server, real MongoDB, real middleware chain.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import sessionsRouter from '../../routes/sessions.js';
import projectAgentsRouter from '../../routes/project-agents.js';
import deploymentsRouter from '../../routes/deployments.js';
import versionsRouter from '../../routes/versions.js';
import projectIoRouter from '../../routes/project-io.js';
import chatRouter from '../../routes/chat.js';
import sdkPublicKeysRouter from '../../routes/sdk-public-keys.js';
import sdkChannelsRouter from '../../routes/sdk-channels.js';
import sdkInitRouter from '../../routes/sdk-init.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  requestJson,
  authHeaders,
  bootstrapProject,
  importProjectFiles,
  createDeployment,
  createSdkPublicKey,
  createSdkBootstrapChannel,
  initSdkSession,
  devLogin,
  addMember,
  uniqueEmail,
  uniqueSlug,
  type DeploymentRecord,
  type BootstrapProjectResult,
} from '../helpers/channel-e2e-bootstrap.js';
import { ProjectMember } from '@agent-platform/database/models';

// =============================================================================
// CONSTANTS
// =============================================================================

const E2E_TIMEOUT_MS = 120_000;

// =============================================================================
// AGENT DSL FIXTURES
// =============================================================================

const SIMPLE_CHAT_DSL = `
AGENT: Chat_Agent

GOAL: "Answer user questions"

PERSONA: "Helpful assistant"
`;

const GATHER_DSL = `
AGENT: Travel_Agent

GOAL: "Collect travel preferences"

PERSONA: "Travel advisor"

GATHER:
  STRATEGY: conversational
  FIELDS:
    destination:
      TYPE: string
      REQUIRED: true
      PROMPT: "Where to?"
`;

const MULTI_AGENT_ENTRY_DSL = `
AGENT: Supervisor

GOAL: "Route customer queries"

PERSONA: "Customer service supervisor"
`;

const MULTI_AGENT_WORKER_DSL = `
AGENT: Billing_Agent

GOAL: "Handle billing questions"

PERSONA: "Billing specialist"
`;

// =============================================================================
// TYPES
// =============================================================================

interface ListDeploymentsResponse {
  success: boolean;
  deployments: Array<{
    id: string;
    projectId: string;
    environment: string;
    status: string;
    label: string | null;
    endpointSlug: string;
    createdAt?: string;
  }>;
}

interface DeploymentDetailResponse {
  success: boolean;
  deployment: DeploymentRecord & {
    channelCount: number;
    createdAt?: string;
    createdBy?: string;
  };
}

interface RetireResponse {
  success: boolean;
  deployment: {
    id: string;
    status: string;
    drainingStartedAt?: string | null;
    retiredAt?: string | null;
  };
}

interface RollbackResponse {
  success: boolean;
  deployment: {
    id: string;
    status: string;
    retiredAt?: string | null;
  };
}

interface PromoteResponse {
  success: boolean;
  deployment: DeploymentRecord & {
    promotedFromDeploymentId?: string | null;
    createdAt?: string;
    createdBy?: string;
  };
  channelsUpdated: number;
}

interface CreateDeploymentErrorResponse {
  success: boolean;
  error: string | { code: string; message: string };
}

interface ListVersionsResponse {
  success: boolean;
  versions: Array<{
    versionId: string;
    version: string;
    status: string;
    sourceHash: string;
    createdAt: string;
    createdBy: string;
  }>;
  total: number;
}

// =============================================================================
// TEST SUITE
// =============================================================================

/**
 * Helper to create a deployment with force=true (skip preflight validation).
 * Preflight checks require LLM model configuration which is absent in the
 * E2E test environment.
 */
async function createForcedDeployment(
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
  },
): Promise<DeploymentRecord> {
  return createDeployment(harness, token, projectId, { ...body, force: true });
}

describe('Deployment Pipeline E2E', { timeout: E2E_TIMEOUT_MS }, () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
      app.use('/api/projects/:projectId/sessions', sessionsRouter);
      app.use('/api/projects/:projectId/agents', projectAgentsRouter);
      app.use('/api/projects/:projectId/agents/:agentName/versions', versionsRouter);
      app.use('/api/projects/:projectId/deployments', deploymentsRouter);
      app.use('/api/projects/:projectId/project-io', projectIoRouter);
      app.use('/api/v1/chat', chatRouter);
      app.use('/api/projects/:projectId/sdk-public-keys', sdkPublicKeysRouter);
      app.use('/api/projects/:projectId/sdk-channels', sdkChannelsRouter);
      app.use('/api/v1/sdk', sdkInitRouter);
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    clearPermissionCache();
  });

  // ---------------------------------------------------------------------------
  // E2E-1: Deployment creation via API
  // ---------------------------------------------------------------------------
  test('E2E-1: create deployment from imported agent DSL', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-create'),
      uniqueSlug('deploy-create'),
      uniqueSlug('proj-deploy-create'),
    );

    // Import agent DSL
    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    // List agent versions (auto-versioning will happen at deploy time)
    const versionsRes = await requestJson<ListVersionsResponse>(
      harness,
      `/api/projects/${admin.projectId}/agents/Chat_Agent/versions`,
      { headers: authHeaders(admin.token) },
    );
    // After import, there should be an initial version
    expect(versionsRes.status).toBe(200);
    expect(versionsRes.body.success).toBe(true);

    // Create deployment with auto-versioning
    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'E2E test deployment',
      description: 'Created by E2E test',
    });

    expect(deployment.id).toBeTruthy();
    expect(deployment.projectId).toBe(admin.projectId);
    expect(deployment.environment).toBe('dev');
    expect(deployment.status).toBe('active');
    expect(deployment.endpointSlug).toBeTruthy();
    expect(deployment.entryAgentName).toBe('Chat_Agent');
    expect(deployment.agentVersionManifest).toHaveProperty('Chat_Agent');
    expect(deployment.label).toBe('E2E test deployment');
    expect(deployment.description).toBe('Created by E2E test');
  });

  // ---------------------------------------------------------------------------
  // E2E-2: Deployment listing
  // ---------------------------------------------------------------------------
  test('E2E-2: list deployments and filter by environment', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-list'),
      uniqueSlug('deploy-list'),
      uniqueSlug('proj-deploy-list'),
    );

    // Import and deploy to two environments
    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'staging',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    // List all deployments
    const listAll = await requestJson<ListDeploymentsResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
      { headers: authHeaders(admin.token) },
    );
    expect(listAll.status).toBe(200);
    expect(listAll.body.success).toBe(true);
    expect(listAll.body.deployments.length).toBeGreaterThanOrEqual(2);

    // Filter by environment
    const listDev = await requestJson<ListDeploymentsResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments?environment=dev`,
      { headers: authHeaders(admin.token) },
    );
    expect(listDev.status).toBe(200);
    expect(listDev.body.success).toBe(true);
    const devDeployments = listDev.body.deployments.filter((d) => d.environment === 'dev');
    expect(devDeployments.length).toBeGreaterThanOrEqual(1);

    // Verify all returned deployments match the filter
    for (const d of listDev.body.deployments) {
      expect(d.environment).toBe('dev');
    }
  });

  // ---------------------------------------------------------------------------
  // E2E-3: Deployment detail
  // ---------------------------------------------------------------------------
  test('E2E-3: get deployment detail and 404 for non-existent', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-detail'),
      uniqueSlug('deploy-detail'),
      uniqueSlug('proj-deploy-detail'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    // Get detail
    const detail = await requestJson<DeploymentDetailResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${deployment.id}`,
      { headers: authHeaders(admin.token) },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.success).toBe(true);
    expect(detail.body.deployment.id).toBe(deployment.id);
    expect(detail.body.deployment.environment).toBe('dev');
    expect(detail.body.deployment.status).toBe('active');
    expect(detail.body.deployment.entryAgentName).toBe('Chat_Agent');
    expect(typeof detail.body.deployment.channelCount).toBe('number');
    expect(detail.body.deployment.channelCount).toBeGreaterThanOrEqual(0);

    // 404 for non-existent
    const notFound = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/deployments/000000000000000000000000`,
      { headers: authHeaders(admin.token) },
    );
    expect(notFound.status).toBe(404);
    expect(notFound.body.success).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // E2E-4: Deployment retirement
  // ---------------------------------------------------------------------------
  test('E2E-4: retire active deployment transitions through draining to retired', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-retire'),
      uniqueSlug('deploy-retire'),
      uniqueSlug('proj-deploy-retire'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    // Retire without force -> should transition to draining
    const retireRes = await requestJson<RetireResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${deployment.id}/retire`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {},
      },
    );
    expect(retireRes.status).toBe(200);
    expect(retireRes.body.success).toBe(true);
    expect(retireRes.body.deployment.status).toBe('draining');
    expect(retireRes.body.deployment.drainingStartedAt).toBeTruthy();

    // Force retire -> should transition to retired
    const forceRetireRes = await requestJson<RetireResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${deployment.id}/retire`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { force: true },
      },
    );
    expect(forceRetireRes.status).toBe(200);
    expect(forceRetireRes.body.success).toBe(true);
    expect(forceRetireRes.body.deployment.status).toBe('retired');

    // Verify detail shows retired
    const detail = await requestJson<DeploymentDetailResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${deployment.id}`,
      { headers: authHeaders(admin.token) },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.deployment.status).toBe('retired');
  });

  // ---------------------------------------------------------------------------
  // E2E-5: Multi-agent deployment
  // ---------------------------------------------------------------------------
  test('E2E-5: deploy multiple agents with entry agent specified', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-multi'),
      uniqueSlug('deploy-multi'),
      uniqueSlug('proj-deploy-multi'),
    );

    // Import multiple agents
    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Supervisor.agent.abl': MULTI_AGENT_ENTRY_DSL,
      'agents/Billing_Agent.agent.abl': MULTI_AGENT_WORKER_DSL,
    });

    // Deploy with multi-agent manifest
    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Supervisor: 'auto', Billing_Agent: 'auto' },
      entryAgentName: 'Supervisor',
    });

    expect(deployment.id).toBeTruthy();
    expect(deployment.entryAgentName).toBe('Supervisor');
    expect(deployment.agentVersionManifest).toHaveProperty('Supervisor');
    expect(deployment.agentVersionManifest).toHaveProperty('Billing_Agent');
  });

  // ---------------------------------------------------------------------------
  // E2E-6: Session creation from deployment via SDK flow
  // ---------------------------------------------------------------------------
  test('E2E-6: create SDK session pointing to a deployment', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-sdk'),
      uniqueSlug('deploy-sdk'),
      uniqueSlug('proj-deploy-sdk'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    // Create SDK public key + channel
    const sdkKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'deploy-e2e-key',
    });

    const channel = await createSdkBootstrapChannel(
      harness,
      admin.token,
      admin.projectId,
      sdkKey.id,
      {
        name: 'deploy-e2e-channel',
        deploymentId: deployment.id,
      },
    );

    // Init SDK session pointing to deployment
    const session = await initSdkSession(harness, {
      publicKey: sdkKey.key!,
      channelId: channel.id,
    });

    expect(session.token).toBeTruthy();
    expect(session.tenantId).toBe(admin.tenantId);
    expect(session.projectId).toBe(admin.projectId);
    expect(session.channelId).toBe(channel.id);
  });

  // ---------------------------------------------------------------------------
  // E2E-7: Deployment environment resolution
  // ---------------------------------------------------------------------------
  test('E2E-7: create deployments in different environments and filter correctly', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-env'),
      uniqueSlug('deploy-env'),
      uniqueSlug('proj-deploy-env'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const devDeploy = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'dev-deployment',
    });

    const stagingDeploy = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'staging',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'staging-deployment',
    });

    expect(devDeploy.environment).toBe('dev');
    expect(stagingDeploy.environment).toBe('staging');

    // Filter by dev environment
    const devList = await requestJson<ListDeploymentsResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments?environment=dev`,
      { headers: authHeaders(admin.token) },
    );
    expect(devList.body.deployments.every((d) => d.environment === 'dev')).toBe(true);

    // Filter by staging environment
    const stagingList = await requestJson<ListDeploymentsResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments?environment=staging`,
      { headers: authHeaders(admin.token) },
    );
    expect(stagingList.body.deployments.every((d) => d.environment === 'staging')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // E2E-8: Auth enforcement
  // ---------------------------------------------------------------------------
  test('E2E-8: unauthenticated request returns 401', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-auth'),
      uniqueSlug('deploy-auth'),
      uniqueSlug('proj-deploy-auth'),
    );

    // Request without token
    const noAuth = await requestJson<{ success: boolean }>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
    );
    expect(noAuth.status).toBe(401);
  });

  test('E2E-8b: viewer role can read but cannot create deployments', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-rbac'),
      uniqueSlug('deploy-rbac'),
      uniqueSlug('proj-deploy-rbac'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    // Create a second user with MEMBER tenant role
    const viewerEmail = uniqueEmail('deploy-viewer');
    const viewer = await devLogin(harness, viewerEmail);
    await addMember(harness, admin.token, admin.tenantId, viewerEmail, 'MEMBER');
    clearPermissionCache();

    // Add as project member with viewer role (direct model insert — no runtime
    // API exists for project member management)
    await ProjectMember.create({
      projectId: admin.projectId,
      userId: viewer.user.id,
      role: 'viewer',
    });

    // Re-login to get fresh token with tenant context
    const viewerLogin = await devLogin(harness, viewerEmail);
    clearPermissionCache();

    // Viewer CAN list deployments (deployment:read)
    const listRes = await requestJson<ListDeploymentsResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
      { headers: authHeaders(viewerLogin.accessToken) },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);

    // Viewer CANNOT create deployments (needs deployment:create)
    const createRes = await requestJson<CreateDeploymentErrorResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
      {
        method: 'POST',
        headers: authHeaders(viewerLogin.accessToken),
        body: {
          environment: 'dev',
          agentVersionManifest: { Chat_Agent: 'auto' },
          entryAgentName: 'Chat_Agent',
        },
      },
    );
    expect(createRes.status).toBe(403);
    expect(createRes.body.success).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // E2E-9: Tenant isolation
  // ---------------------------------------------------------------------------
  test('E2E-9: deployment from tenant A is not accessible from tenant B', async () => {
    // Bootstrap two separate tenants
    const tenantA = await bootstrapProject(
      harness,
      uniqueEmail('deploy-iso-a'),
      uniqueSlug('deploy-iso-a'),
      uniqueSlug('proj-iso-a'),
    );

    const tenantB = await bootstrapProject(
      harness,
      uniqueEmail('deploy-iso-b'),
      uniqueSlug('deploy-iso-b'),
      uniqueSlug('proj-iso-b'),
    );

    // Import and deploy in tenant A
    await importProjectFiles(harness, tenantA.token, tenantA.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const deployment = await createForcedDeployment(harness, tenantA.token, tenantA.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    // Tenant B trying to access tenant A's deployment -> 404 (not 403)
    const crossTenant = await requestJson<{ success: boolean; error?: string }>(
      harness,
      `/api/projects/${tenantA.projectId}/deployments/${deployment.id}`,
      { headers: authHeaders(tenantB.token) },
    );
    // Should get 403 (no project access) or 404 (deployment not visible)
    expect([403, 404]).toContain(crossTenant.status);
    expect(crossTenant.body.success).toBe(false);

    // Tenant B's own project should have no deployments
    const tenantBList = await requestJson<ListDeploymentsResponse>(
      harness,
      `/api/projects/${tenantB.projectId}/deployments`,
      { headers: authHeaders(tenantB.token) },
    );
    expect(tenantBList.status).toBe(200);
    expect(tenantBList.body.deployments.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // E2E-10: Preflight validation errors
  // ---------------------------------------------------------------------------
  test('E2E-10a: deploy with empty manifest returns error', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-pf'),
      uniqueSlug('deploy-pf'),
      uniqueSlug('proj-deploy-pf'),
    );

    const res = await requestJson<CreateDeploymentErrorResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          environment: 'dev',
          agentVersionManifest: {},
          entryAgentName: 'Chat_Agent',
        },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('E2E-10b: deploy with missing entry agent in manifest returns error', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-entry'),
      uniqueSlug('deploy-entry'),
      uniqueSlug('proj-deploy-entry'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    // entryAgentName not in the agentVersionManifest
    const res = await requestJson<CreateDeploymentErrorResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          environment: 'dev',
          agentVersionManifest: { Chat_Agent: 'auto' },
          entryAgentName: 'NonExistentAgent',
        },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('E2E-10c: deploy with non-existent agent name returns error', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-noagent'),
      uniqueSlug('deploy-noagent'),
      uniqueSlug('proj-deploy-noagent'),
    );

    const res = await requestJson<CreateDeploymentErrorResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          environment: 'dev',
          agentVersionManifest: { GhostAgent: 'auto' },
          entryAgentName: 'GhostAgent',
        },
      },
    );
    // Agent not found
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // E2E-11: Deployment promotion
  // ---------------------------------------------------------------------------
  test('E2E-11: promote deployment from dev to staging', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-promote'),
      uniqueSlug('deploy-promote'),
      uniqueSlug('proj-deploy-promote'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const devDeploy = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'dev-v1',
    });

    // Promote to staging
    const promoteRes = await requestJson<PromoteResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${devDeploy.id}/promote`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { targetEnvironment: 'staging' },
      },
    );
    expect(promoteRes.status).toBe(201);
    expect(promoteRes.body.success).toBe(true);
    expect(promoteRes.body.deployment.environment).toBe('staging');
    expect(promoteRes.body.deployment.status).toBe('active');
    expect(promoteRes.body.deployment.entryAgentName).toBe('Chat_Agent');
    // Promoted deployment should reference source
    expect(promoteRes.body.deployment.promotedFromDeploymentId).toBe(devDeploy.id);
  });

  test('E2E-11b: cannot promote to same environment', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-promote-same'),
      uniqueSlug('deploy-promote-same'),
      uniqueSlug('proj-promote-same'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    const promoteRes = await requestJson<{ success: boolean; error?: { code: string } }>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${deployment.id}/promote`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { targetEnvironment: 'dev' },
      },
    );
    expect(promoteRes.status).toBe(422);
    expect(promoteRes.body.success).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // E2E-12: Deployment replaces previous active in same environment
  // ---------------------------------------------------------------------------
  test('E2E-12: new deployment retires previous active in same environment', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-replace'),
      uniqueSlug('deploy-replace'),
      uniqueSlug('proj-deploy-replace'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const first = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'first',
    });

    const second = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'second',
    });

    // First deployment should be retired (or draining)
    const firstDetail = await requestJson<DeploymentDetailResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${first.id}`,
      { headers: authHeaders(admin.token) },
    );
    expect(firstDetail.status).toBe(200);
    expect(['draining', 'retired']).toContain(firstDetail.body.deployment.status);

    // Second should be active
    const secondDetail = await requestJson<DeploymentDetailResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${second.id}`,
      { headers: authHeaders(admin.token) },
    );
    expect(secondDetail.status).toBe(200);
    expect(secondDetail.body.deployment.status).toBe('active');
  });

  // ---------------------------------------------------------------------------
  // E2E-13: Rollback to previous deployment
  // ---------------------------------------------------------------------------
  test('E2E-13: rollback reactivates previous deployment', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-rollback'),
      uniqueSlug('deploy-rollback'),
      uniqueSlug('proj-deploy-rollback'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    // Create first deployment
    const first = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'v1',
    });

    // Create second deployment (retires first)
    const second = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
      label: 'v2',
    });

    // Rollback second deployment
    const rollbackRes = await requestJson<RollbackResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${second.id}/rollback`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {},
      },
    );
    expect(rollbackRes.status).toBe(200);
    expect(rollbackRes.body.success).toBe(true);
    expect(rollbackRes.body.deployment.status).toBe('active');
    // The reactivated deployment is the first one
    expect(rollbackRes.body.deployment.id).toBe(first.id);

    // Verify second is now retired
    const secondDetail = await requestJson<DeploymentDetailResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${second.id}`,
      { headers: authHeaders(admin.token) },
    );
    expect(secondDetail.body.deployment.status).toBe('retired');
  });

  // ---------------------------------------------------------------------------
  // E2E-14: Retire non-retirable deployment returns error
  // ---------------------------------------------------------------------------
  test('E2E-14: cannot retire already-retired deployment', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-reretire'),
      uniqueSlug('deploy-reretire'),
      uniqueSlug('proj-deploy-reretire'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Chat_Agent.agent.abl': SIMPLE_CHAT_DSL,
    });

    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Chat_Agent: 'auto' },
      entryAgentName: 'Chat_Agent',
    });

    // Force retire
    await requestJson<RetireResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${deployment.id}/retire`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { force: true },
      },
    );

    // Try to retire again -> should fail
    const retireAgain = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/projects/${admin.projectId}/deployments/${deployment.id}/retire`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {},
      },
    );
    expect(retireAgain.status).toBe(422);
    expect(retireAgain.body.success).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // E2E-15: Gather agent deployment and version list
  // ---------------------------------------------------------------------------
  test('E2E-15: deploy gather agent and verify versions are created', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-gather'),
      uniqueSlug('deploy-gather'),
      uniqueSlug('proj-deploy-gather'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Travel_Agent.agent.abl': GATHER_DSL,
    });

    const deployment = await createForcedDeployment(harness, admin.token, admin.projectId, {
      environment: 'dev',
      agentVersionManifest: { Travel_Agent: 'auto' },
      entryAgentName: 'Travel_Agent',
    });

    expect(deployment.id).toBeTruthy();
    expect(deployment.entryAgentName).toBe('Travel_Agent');

    // Verify agent version was auto-created
    const versionsRes = await requestJson<ListVersionsResponse>(
      harness,
      `/api/projects/${admin.projectId}/agents/Travel_Agent/versions`,
      { headers: authHeaders(admin.token) },
    );
    expect(versionsRes.status).toBe(200);
    expect(versionsRes.body.success).toBe(true);
    expect(versionsRes.body.versions.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // E2E-16: Invalid environment rejected
  // ---------------------------------------------------------------------------
  test('E2E-16: deploy with invalid environment returns 400', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('deploy-badenv'),
      uniqueSlug('deploy-badenv'),
      uniqueSlug('proj-deploy-badenv'),
    );

    const res = await requestJson<CreateDeploymentErrorResponse>(
      harness,
      `/api/projects/${admin.projectId}/deployments`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          environment: 'invalid_env',
          agentVersionManifest: { Chat_Agent: 'auto' },
          entryAgentName: 'Chat_Agent',
        },
      },
    );
    // Zod validation or route validation rejects invalid environment
    expect([400, 422]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });
});
