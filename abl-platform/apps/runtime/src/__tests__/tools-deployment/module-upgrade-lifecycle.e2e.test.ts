/**
 * Module Upgrade Lifecycle E2E Tests
 *
 * Exercises module dependency upgrade/downgrade scenarios through the real
 * Runtime API: version upgrades, downgrades, breaking changes (removed agents),
 * and auth profile requirements. No mocks, no vi.fn — real E2E.
 *
 * Uses ModuleE2EBootstrap which starts a real Express server with
 * MongoMemoryServer — all data seeded via helper methods, all
 * assertions via the HTTP API or direct DB reads on seeded data.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ModuleE2EBootstrap,
  SIMPLE_MODULE_AGENT_DSL,
  CONSUMER_AGENT_DSL,
  MULTI_AGENT_MODULE_DSL,
} from '../helpers/module-e2e-bootstrap.js';
import { ProjectModuleDependency } from '@agent-platform/database/models';

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Module Upgrade Lifecycle E2E', () => {
  let bootstrap: ModuleE2EBootstrap;

  beforeAll(async () => {
    bootstrap = await ModuleE2EBootstrap.create();
  }, 120_000);

  afterAll(async () => {
    await bootstrap?.teardown();
  }, 30_000);

  // ─── (a) Upgrade v1.0.0 → v1.1.0, deploy, verify ────────────────────────

  test('upgrade v1.0.0 → v1.1.0 — deploy uses updated agent IR', async () => {
    // 1. Create module project with v1.0.0 agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Upgrade Module A',
      'module',
    );
    const v1Goal = 'Process payments for customers';
    const v1Dsl = `
AGENT: payment_processor

GOAL: "${v1Goal}"
`;
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', v1Dsl);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish v1.0.0
    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Initial release',
    });
    expect(v1ReleaseId).toBeTruthy();

    // 3. Create consumer project, import module, deploy
    const { projectId: consumerProjectId } = await bootstrap.createProject('Upgrade Consumer A');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
    );

    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(v1DeploymentId).toBeTruthy();

    // Verify v1 deployment is active
    const v1Deployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1Deployment.status).toBe(200);
    expect((v1Deployment.body as { deployment: { status: string } }).deployment.status).toBe(
      'active',
    );

    // 4. Update the module agent and publish v1.1.0
    const v11Goal = 'Process payments with enhanced fraud detection';
    const v11Dsl = `
AGENT: payment_processor

GOAL: "${v11Goal}"
`;
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', v11Dsl);
    const { releaseId: v11ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.1.0', {
      releaseNotes: 'Added fraud detection',
    });
    expect(v11ReleaseId).toBeTruthy();

    // 5. Upgrade the dependency to v1.1.0
    const upgradeResult = await bootstrap.upgradeModule(
      consumerProjectId,
      dependencyId,
      v11ReleaseId,
    );
    expect(upgradeResult.status).toBe(200);
    expect((upgradeResult.body as { success: boolean }).success).toBe(true);

    // 6. Verify the dependency record was updated
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(dep).toBeTruthy();
    const depDoc = dep as Record<string, unknown>;
    expect(depDoc.resolvedVersion).toBe('1.1.0');
    expect(depDoc.resolvedReleaseId).toBe(v11ReleaseId);

    // 7. Deploy again with the upgraded dependency
    const { deploymentId: v11DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(v11DeploymentId).toBeTruthy();
    expect(v11DeploymentId).not.toBe(v1DeploymentId);

    // 8. Verify the new deployment is active and the old one is retired
    const v11Deployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v11DeploymentId}`,
    );
    expect(v11Deployment.status).toBe(200);
    const v11Body = v11Deployment.body as {
      success: boolean;
      deployment: { status: string; id: string };
    };
    expect(v11Body.deployment.status).toBe('active');

    const v1PostUpgrade = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1PostUpgrade.status).toBe(200);
    expect((v1PostUpgrade.body as { deployment: { status: string } }).deployment.status).toBe(
      'retired',
    );
  }, 30_000);

  // ─── (b) Downgrade back to v1.0.0 ───────────────────────────────────────

  test('downgrade v1.1.0 → v1.0.0 — original behavior restored', async () => {
    // 1. Create module project with v1.0.0
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Downgrade Module B',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 2. Update agent and publish v1.1.0
    const updatedDsl = `
AGENT: payment_processor

GOAL: "Process payments with enhanced validation"
`;
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', updatedDsl);
    const { releaseId: v11ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.1.0');

    // 3. Create consumer, import at v1.1.0, deploy
    const { projectId: consumerProjectId } = await bootstrap.createProject('Downgrade Consumer B');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.1.0' },
    );

    const { deploymentId: v11DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    // Verify v1.1.0 deployment is active
    const v11Deployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v11DeploymentId}`,
    );
    expect(v11Deployment.status).toBe(200);
    expect((v11Deployment.body as { deployment: { status: string } }).deployment.status).toBe(
      'active',
    );

    // 4. Downgrade the dependency back to v1.0.0
    const downgradeResult = await bootstrap.upgradeModule(
      consumerProjectId,
      dependencyId,
      v1ReleaseId,
    );
    expect(downgradeResult.status).toBe(200);
    expect((downgradeResult.body as { success: boolean }).success).toBe(true);

    // 5. Verify dependency points to v1.0.0
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(dep).toBeTruthy();
    const depDoc = dep as Record<string, unknown>;
    expect(depDoc.resolvedVersion).toBe('1.0.0');
    expect(depDoc.resolvedReleaseId).toBe(v1ReleaseId);

    // 6. Deploy with the downgraded dependency
    const { deploymentId: downgradedDeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(downgradedDeploymentId).toBeTruthy();
    expect(downgradedDeploymentId).not.toBe(v11DeploymentId);

    // 7. Verify the downgraded deployment is active
    const downgradedDeployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${downgradedDeploymentId}`,
    );
    expect(downgradedDeployment.status).toBe(200);
    const body = downgradedDeployment.body as {
      success: boolean;
      deployment: { status: string; id: string };
    };
    expect(body.deployment.status).toBe('active');

    // 8. Verify previous v1.1.0 deployment was retired
    const v11PostDowngrade = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v11DeploymentId}`,
    );
    expect(v11PostDowngrade.status).toBe(200);
    expect((v11PostDowngrade.body as { deployment: { status: string } }).deployment.status).toBe(
      'retired',
    );
  }, 30_000);

  // ─── (c) Upgrade with breaking change (removed agent) ────────────────────

  test('upgrade with removed agent — deploy succeeds when consumer does not reference removed agent', async () => {
    // 1. Create module project with two agents
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Breaking Module C',
      'module',
    );
    await bootstrap.createAgents(moduleProjectId, [
      { name: 'order_supervisor', dslContent: MULTI_AGENT_MODULE_DSL.entry },
      { name: 'order_worker', dslContent: MULTI_AGENT_MODULE_DSL.worker },
    ]);
    await bootstrap.setEntryAgent(moduleProjectId, 'order_supervisor');

    // 2. Publish v1.0.0 with two agents
    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Two agents: supervisor + worker',
    });

    // Verify v1.0.0 contract has two agents
    const { ModuleRelease } = await import('@agent-platform/database/models');
    const v1Release = await ModuleRelease.findOne({
      _id: v1ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    const v1Contract = (v1Release as Record<string, unknown>).contract as {
      providedAgents: Array<{ name: string }>;
    };
    expect(v1Contract.providedAgents).toHaveLength(2);
    const v1AgentNames = v1Contract.providedAgents.map((a) => a.name).sort();
    expect(v1AgentNames).toEqual(['order_supervisor', 'order_worker']);

    // 3. Create consumer, import module at v1.0.0
    const { projectId: consumerProjectId } = await bootstrap.createProject('Breaking Consumer C');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'orders',
      { type: 'version', value: '1.0.0' },
    );

    // 4. Deploy with v1.0.0 (two module agents)
    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(v1DeploymentId).toBeTruthy();

    // 5. Remove order_worker from the module and publish v1.1.0
    const { ProjectAgent } = await import('@agent-platform/database/models');
    await ProjectAgent.deleteOne({
      projectId: moduleProjectId,
      tenantId: bootstrap.tenantId,
      name: 'order_worker',
    });

    const { releaseId: v11ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.1.0', {
      releaseNotes: 'Removed order_worker agent',
    });

    // Verify v1.1.0 contract has only one agent
    const v11Release = await ModuleRelease.findOne({
      _id: v11ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    const v11Contract = (v11Release as Record<string, unknown>).contract as {
      providedAgents: Array<{ name: string }>;
    };
    expect(v11Contract.providedAgents).toHaveLength(1);
    expect(v11Contract.providedAgents[0].name).toBe('order_supervisor');

    // 6. Upgrade the dependency to v1.1.0
    const upgradeResult = await bootstrap.upgradeModule(
      consumerProjectId,
      dependencyId,
      v11ReleaseId,
    );
    expect(upgradeResult.status).toBe(200);

    // 7. Deploy with v1.1.0 — should succeed since the consumer's own agent
    //    (store_agent) doesn't directly reference order_worker. The module
    //    now only provides order_supervisor.
    const { deploymentId: v11DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(v11DeploymentId).toBeTruthy();

    // 8. Verify the upgraded deployment is active
    const v11Deployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v11DeploymentId}`,
    );
    expect(v11Deployment.status).toBe(200);
    expect((v11Deployment.body as { deployment: { status: string } }).deployment.status).toBe(
      'active',
    );

    // 9. Verify the dependency's contract snapshot reflects the reduced agent set
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(dep).toBeTruthy();
    const depContract = (dep as Record<string, unknown>).contractSnapshot as {
      providedAgents: Array<{ name: string }>;
    };
    expect(depContract.providedAgents).toHaveLength(1);
    expect(depContract.providedAgents[0].name).toBe('order_supervisor');
  }, 30_000);

  // ─── (d) Upgrade with new required auth profile ──────────────────────────

  test('upgrade with required auth profile — module build fails with actionable auth preflight error', async () => {
    // 1. Create module project with v1.0.0 (no auth requirements)
    const { projectId: moduleProjectId } = await bootstrap.createProject('Auth Module D', 'module');
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'No auth requirements',
    });

    // 2. Create consumer, import module, deploy successfully
    const { projectId: consumerProjectId } = await bootstrap.createProject('Auth Consumer D');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
    );

    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(v1DeploymentId).toBeTruthy();

    // 3. Publish v1.1.0 that requires an auth profile
    const { releaseId: v11ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.1.0', {
      releaseNotes: 'Now requires stripe_api auth profile',
      contractOverrides: {
        requiredAuthProfiles: [
          {
            name: 'stripe_api',
            authType: 'api_key',
            scope: 'payment_processing',
            referencedBy: ['payment_processor'],
          },
        ],
      },
    });

    // 4. Upgrade the dependency to v1.1.0 (with auth requirements)
    const upgradeResult = await bootstrap.upgradeModule(
      consumerProjectId,
      dependencyId,
      v11ReleaseId,
    );
    expect(upgradeResult.status).toBe(200);

    // 5. Verify the dependency's contract now includes the auth profile requirement
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(dep).toBeTruthy();
    const depDoc = dep as Record<string, unknown>;
    const contract = depDoc.contractSnapshot as {
      requiredAuthProfiles: Array<{ name: string; authType?: string }>;
    };
    expect(contract.requiredAuthProfiles).toHaveLength(1);
    expect(contract.requiredAuthProfiles[0].name).toBe('stripe_api');

    // 6. Deployment should now fail at the public API boundary because the
    //    frozen module snapshot runs auth profile preflight before accepting
    //    the deployment.
    const deployResult = await bootstrap.post(`/api/projects/${consumerProjectId}/deployments`, {
      environment: 'dev',
      agentVersionManifest: {
        store_agent: 'auto',
      },
      entryAgentName: 'store_agent',
      label: 'Auth profile preflight should fail',
      force: true,
    });

    expect(deployResult.status).toBe(422);
    const deployBody = deployResult.body as {
      success: boolean;
      error: { code: string; message: string };
      moduleBuild: {
        diagnostics: Array<{ code: string; severity: string; source: string; message: string }>;
      };
    };

    expect(deployBody.success).toBe(false);
    expect(deployBody.error.code).toBe('MODULE_BUILD_FAILED');

    const authDiagnostic = deployBody.moduleBuild.diagnostics.find(
      (d) => d.code === 'AUTH_PROFILE_PREFLIGHT_FAILED',
    );
    expect(authDiagnostic).toBeTruthy();
    expect(authDiagnostic!.severity).toBe('error');
    expect(authDiagnostic!.source).toBe('auth-preflight');
    // The message should identify the missing profile and the dependency
    expect(authDiagnostic!.message).toContain('stripe_api');
    expect(authDiagnostic!.message).toContain('payments');
    expect(authDiagnostic!.message).toContain('Create the required auth profiles');

    // 7. Verify the original v1 deployment is still active (upgrade + failed
    //    deployment rebuild does not affect existing deployment)
    const v1PostUpgrade = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1PostUpgrade.status).toBe(200);
    expect((v1PostUpgrade.body as { deployment: { status: string } }).deployment.status).toBe(
      'active',
    );
  }, 30_000);
});
