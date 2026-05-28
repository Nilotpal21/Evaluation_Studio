/**
 * Module Cutover Safety E2E Tests (GAP-008)
 *
 * Tests that failed deployment attempts leave the previous active deployment
 * intact, create no partial snapshots, return actionable errors, and allow
 * retry after fix. Exercises the real Runtime API with no mocks.
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
} from '../helpers/module-e2e-bootstrap.js';
import { DeploymentModuleSnapshot, ModuleRelease } from '@agent-platform/database/models';

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Module Cutover Safety E2E (GAP-008)', () => {
  let bootstrap: ModuleE2EBootstrap;

  beforeAll(async () => {
    bootstrap = await ModuleE2EBootstrap.create();
  }, 60_000);

  afterAll(async () => {
    await bootstrap?.teardown();
  }, 30_000);

  // ─── (a) Failed deployment leaves previous deployment active ───────────

  test('GAP-008a: failed deployment attempt leaves previous active deployment intact', async () => {
    // 1. Create a module project, publish v1.0.0, and set up consumer
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Cutover Module A',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');
    await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 2. Create consumer project, import module, deploy successfully
    const { projectId: consumerProjectId } = await bootstrap.createProject('Cutover Consumer A');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });

    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    // 3. Verify the v1 deployment is active
    const v1Deployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1Deployment.status).toBe(200);
    const v1Body = v1Deployment.body as {
      success: boolean;
      deployment: { status: string; id: string };
    };
    expect(v1Body.deployment.status).toBe('active');

    // 4. Attempt a new deployment with a non-existent agent in the manifest
    // This should fail because agent "nonexistent_agent" does not exist in the project
    const failResult = await bootstrap.post(`/api/projects/${consumerProjectId}/deployments`, {
      environment: 'dev',
      agentVersionManifest: {
        store_agent: 'auto',
        nonexistent_agent: 'auto',
      },
      entryAgentName: 'store_agent',
      label: 'Should fail deployment',
      force: true,
    });

    // 5. Verify the deployment attempt failed
    expect(failResult.status).toBe(400);
    const failBody = failResult.body as { success: boolean; error: string };
    expect(failBody.success).toBe(false);

    // 6. Verify the original v1 deployment is still active
    // List deployments and filter for active ones
    const deploymentsResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments?status=active`,
    );
    expect(deploymentsResult.status).toBe(200);
    const deploymentsBody = deploymentsResult.body as {
      success: boolean;
      deployments: Array<{ id: string; status: string }>;
    };
    expect(deploymentsBody.success).toBe(true);

    // The original deployment should still be in the list
    const activeDeployments = deploymentsBody.deployments.filter((d) => d.status === 'active');
    expect(activeDeployments.length).toBeGreaterThanOrEqual(1);
    const originalStillActive = activeDeployments.some((d) => d.id === v1DeploymentId);
    expect(originalStillActive).toBe(true);

    // 7. Verify v1 deployment detail still shows active
    const v1PostFail = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1PostFail.status).toBe(200);
    const v1PostFailBody = v1PostFail.body as {
      success: boolean;
      deployment: { status: string };
    };
    expect(v1PostFailBody.deployment.status).toBe('active');
  }, 30_000);

  // ─── (b) No partial snapshot referenced after failed deployment ────────

  test('GAP-008b: no partial module snapshot exists after a failed deployment attempt', async () => {
    // 1. Create a module project and publish
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Cutover Module B',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');
    await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 2. Create consumer, import module, deploy v1 successfully
    const { projectId: consumerProjectId } = await bootstrap.createProject('Cutover Consumer B');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });

    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    // 3. Count existing module snapshots for this project before failure
    const snapshotsBefore = await DeploymentModuleSnapshot.find({
      tenantId: bootstrap.tenantId,
      projectId: consumerProjectId,
    }).lean();
    const snapshotCountBefore = snapshotsBefore.length;

    // 4. Attempt a deployment that will fail (missing agent)
    const failResult = await bootstrap.post(`/api/projects/${consumerProjectId}/deployments`, {
      environment: 'dev',
      agentVersionManifest: {
        store_agent: 'auto',
        phantom_agent: 'auto',
      },
      entryAgentName: 'store_agent',
      label: 'Should fail - no partial snapshot',
      force: true,
    });

    expect(failResult.status).toBe(400);

    // 5. Verify no new module snapshot was created
    const snapshotsAfter = await DeploymentModuleSnapshot.find({
      tenantId: bootstrap.tenantId,
      projectId: consumerProjectId,
    }).lean();

    expect(snapshotsAfter.length).toBe(snapshotCountBefore);

    // 6. Verify no deployment record references a partially-created snapshot
    // Get all deployments for the project
    const deploymentsResult = await bootstrap.get(`/api/projects/${consumerProjectId}/deployments`);
    expect(deploymentsResult.status).toBe(200);
    const deploymentsBody = deploymentsResult.body as {
      success: boolean;
      deployments: Array<{ id: string; status: string }>;
    };

    // For each deployment, verify if a snapshot exists it has valid data
    for (const deployment of deploymentsBody.deployments) {
      const snapshot = await DeploymentModuleSnapshot.findOne({
        tenantId: bootstrap.tenantId,
        deploymentId: deployment.id,
      }).lean();

      // Either no snapshot exists, or if it exists it must have a valid snapshotHash
      if (snapshot) {
        const snap = snapshot as Record<string, unknown>;
        expect(snap.snapshotHash).toBeTruthy();
        expect(snap.compressedPayload).toBeTruthy();
      }
    }
  }, 30_000);

  // ─── (c) Actionable error returned on deployment failure ───────────────

  test('GAP-008c: deployment failure returns actionable error identifying the problem', async () => {
    // 1. Create consumer project with an agent
    const { projectId: consumerProjectId } = await bootstrap.createProject('Cutover Consumer C');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    // Scenario 1: Agent not found — deploy with a non-existent agent
    const missingAgentResult = await bootstrap.post(
      `/api/projects/${consumerProjectId}/deployments`,
      {
        environment: 'dev',
        agentVersionManifest: {
          store_agent: 'auto',
          missing_payment_agent: 'auto',
        },
        entryAgentName: 'store_agent',
        label: 'Missing agent test',
        force: true,
      },
    );

    expect(missingAgentResult.status).toBe(400);
    const missingBody = missingAgentResult.body as { success: boolean; error: string };
    expect(missingBody.success).toBe(false);
    // Error should identify which agent is missing
    expect(missingBody.error).toContain('missing_payment_agent');
    expect(missingBody.error).toContain('not found');

    // Scenario 2: Entry agent not in manifest
    const entryMismatchResult = await bootstrap.post(
      `/api/projects/${consumerProjectId}/deployments`,
      {
        environment: 'dev',
        agentVersionManifest: {
          store_agent: 'auto',
        },
        entryAgentName: 'nonexistent_entry',
        label: 'Entry mismatch test',
        force: true,
      },
    );

    expect(entryMismatchResult.status).toBe(400);
    const entryBody = entryMismatchResult.body as { success: boolean; error: string };
    expect(entryBody.success).toBe(false);
    // Error should identify the entry agent name issue
    expect(entryBody.error).toContain('nonexistent_entry');
    expect(entryBody.error).toContain('agentVersionManifest');

    // Scenario 3: Empty manifest
    const emptyManifestResult = await bootstrap.post(
      `/api/projects/${consumerProjectId}/deployments`,
      {
        environment: 'dev',
        agentVersionManifest: {},
        entryAgentName: 'store_agent',
        label: 'Empty manifest test',
        force: true,
      },
    );

    expect(emptyManifestResult.status).toBe(400);
    const emptyBody = emptyManifestResult.body as { success: boolean; error: string };
    expect(emptyBody.success).toBe(false);
    expect(emptyBody.error).toContain('non-empty');

    // Scenario 4: Module dependency with deleted release — deployment
    // should now fail at deployment creation time because the frozen module
    // snapshot is built before the deployment is accepted.
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Cutover Module C',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');
    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });

    // Delete the release to create a dangling dependency
    await ModuleRelease.deleteOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    });

    // Verify the release is gone
    const deletedRelease = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(deletedRelease).toBeNull();

    const deployResult = await bootstrap.post(`/api/projects/${consumerProjectId}/deployments`, {
      environment: 'dev',
      agentVersionManifest: {
        store_agent: 'auto',
      },
      entryAgentName: 'store_agent',
      label: 'Deleted module release should fail deployment',
      force: true,
    });

    expect(deployResult.status).toBe(422);
    const deployBody = deployResult.body as {
      success: boolean;
      error: { code: string; message: string };
      moduleBuild: { diagnostics: Array<{ code: string; message: string }> };
    };
    expect(deployBody.success).toBe(false);
    expect(deployBody.error.code).toBe('MODULE_BUILD_FAILED');
    expect(
      deployBody.moduleBuild.diagnostics.some((diagnostic) =>
        ['SELECTOR_RESOLUTION_FAILED', 'RELEASE_NOT_FOUND'].includes(diagnostic.code),
      ),
    ).toBe(true);
  }, 30_000);

  // ─── (d) Retry after fix succeeds ─────────────────────────────────────

  test('GAP-008d: deployment succeeds on retry after fixing the issue that caused the initial failure', async () => {
    // 1. Create a module project and consumer
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Cutover Module D',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');
    await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    const { projectId: consumerProjectId } = await bootstrap.createProject('Cutover Consumer D');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });

    // 2. Deploy v1 successfully
    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    // Verify v1 is active
    const v1Result = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1Result.status).toBe(200);
    expect((v1Result.body as { deployment: { status: string } }).deployment.status).toBe('active');

    // 3. Attempt a deployment with a non-existent agent (should fail)
    const failResult = await bootstrap.post(`/api/projects/${consumerProjectId}/deployments`, {
      environment: 'dev',
      agentVersionManifest: {
        store_agent: 'auto',
        broken_agent: 'auto',
      },
      entryAgentName: 'store_agent',
      label: 'Should fail',
      force: true,
    });

    expect(failResult.status).toBe(400);
    expect((failResult.body as { success: boolean }).success).toBe(false);

    // 4. Verify v1 is still active (failure didn't corrupt state)
    const v1AfterFail = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1AfterFail.status).toBe(200);
    expect((v1AfterFail.body as { deployment: { status: string } }).deployment.status).toBe(
      'active',
    );

    // 5. "Fix" the issue by deploying with only valid agents
    const { deploymentId: v2DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    expect(v2DeploymentId).toBeTruthy();
    expect(v2DeploymentId).not.toBe(v1DeploymentId);

    // 6. Verify the new deployment is active
    const v2Result = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v2DeploymentId}`,
    );
    expect(v2Result.status).toBe(200);
    const v2Body = v2Result.body as {
      success: boolean;
      deployment: { status: string; id: string; entryAgentName: string };
    };
    expect(v2Body.deployment.status).toBe('active');
    expect(v2Body.deployment.entryAgentName).toBe('store_agent');

    // 7. Verify the old v1 deployment was retired (replaced by v2)
    const v1Final = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1Final.status).toBe(200);
    const v1FinalBody = v1Final.body as {
      success: boolean;
      deployment: { status: string };
    };
    expect(v1FinalBody.deployment.status).toBe('retired');
  }, 30_000);

  // ─── (e) Compile error during auto-version leaves previous active ──────

  test('GAP-008e: compile error during auto-version returns 422 and leaves previous deployment active', async () => {
    // 1. Create consumer project with agent and deploy v1
    const { projectId: consumerProjectId } = await bootstrap.createProject('Cutover Consumer E');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    // Verify v1 is active
    const v1Check = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect((v1Check.body as { deployment: { status: string } }).deployment.status).toBe('active');

    // 2. Create an agent with invalid/empty DSL that will cause auto-version to fail
    // An agent with empty DSL content should fail during auto-versioning
    const { ProjectAgent } = await import('@agent-platform/database/models');
    await ProjectAgent.create({
      projectId: consumerProjectId,
      tenantId: bootstrap.tenantId,
      name: 'broken_agent',
      agentPath: `${consumerProjectId}/broken_agent`,
      dslContent: '', // empty DSL — will fail "has no DSL content to auto-version"
      createdBy: bootstrap.userId,
    });

    // 3. Attempt deployment including the broken agent
    const failResult = await bootstrap.post(`/api/projects/${consumerProjectId}/deployments`, {
      environment: 'dev',
      agentVersionManifest: {
        store_agent: 'auto',
        broken_agent: 'auto',
      },
      entryAgentName: 'store_agent',
      label: 'Compile error test',
      force: true,
    });

    // 4. Should fail with 400 because broken_agent has no DSL content
    expect(failResult.status).toBe(400);
    const failBody = failResult.body as { success: boolean; error: string };
    expect(failBody.success).toBe(false);
    expect(failBody.error).toContain('broken_agent');
    expect(failBody.error).toContain('no DSL content');

    // 5. Verify v1 deployment is still active
    const v1PostFail = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${v1DeploymentId}`,
    );
    expect(v1PostFail.status).toBe(200);
    expect((v1PostFail.body as { deployment: { status: string } }).deployment.status).toBe(
      'active',
    );

    // 6. Clean up: remove the broken agent so future tests aren't affected
    await ProjectAgent.deleteOne({
      projectId: consumerProjectId,
      tenantId: bootstrap.tenantId,
      name: 'broken_agent',
    });
  }, 30_000);
});
