/**
 * Module E2E — Lifecycle Tests (P1-E01, P1-E02, P1-E08, P1-E09, P1-E10)
 *
 * Exercises the full module lifecycle through the real Runtime API:
 * project creation, agent import, release publishing, dependency wiring,
 * deployment, and verification. No mocks, no vi.fn — real E2E.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ModuleE2EBootstrap,
  SIMPLE_MODULE_AGENT_DSL,
  CONSUMER_AGENT_DSL,
} from '../helpers/module-e2e-bootstrap.js';
import {
  ProjectModuleDependency,
  ModuleRelease,
  ModuleEnvironmentPointer,
} from '@agent-platform/database/models';

let bootstrap: ModuleE2EBootstrap;

beforeAll(async () => {
  bootstrap = await ModuleE2EBootstrap.create();
}, 60_000);

afterAll(async () => {
  await bootstrap?.teardown();
}, 30_000);

describe('Module E2E — Lifecycle', () => {
  // ─── P1-E01: Full module lifecycle ──────────────────────────────────────────

  test('P1-E01: full module lifecycle — create, publish, import, deploy, verify', async () => {
    // 1. Create a module project
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Payment Module',
      'module',
    );

    // 2. Create an agent in the module project
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);

    // 3. Set entry agent
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 4. Publish a release
    const { releaseId, version } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Initial release',
    });

    expect(releaseId).toBeTruthy();
    expect(version).toBe('1.0.0');

    // Verify release exists in DB
    const release = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(release).toBeTruthy();
    expect((release as Record<string, unknown>).version).toBe('1.0.0');

    // 5. Create a consumer project
    const { projectId: consumerProjectId } = await bootstrap.createProject('Store App');

    // 6. Create a consumer agent
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    // 7. Import the module into the consumer
    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
    );

    expect(dependencyId).toBeTruthy();

    // Verify dependency record
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(dep).toBeTruthy();
    expect((dep as Record<string, unknown>).alias).toBe('payments');
    expect((dep as Record<string, unknown>).resolvedVersion).toBe('1.0.0');

    // 8. Deploy the consumer project
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    expect(deploymentId).toBeTruthy();

    // 9. Verify deployment was created with the consumer's agents
    const deploymentResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );

    expect(deploymentResult.status).toBe(200);
    const deploymentBody = deploymentResult.body as {
      success: boolean;
      deployment: {
        id: string;
        entryAgentName: string;
        agentVersionManifest: Record<string, string>;
        status: string;
      };
    };
    expect(deploymentBody.success).toBe(true);
    expect(deploymentBody.deployment.entryAgentName).toBe('store_agent');
    expect(deploymentBody.deployment.agentVersionManifest).toHaveProperty('store_agent');
    expect(deploymentBody.deployment.status).toBe('active');
  }, 30_000);

  // ─── P1-E02: Version pinning ──────────────────────────────────────────────

  test('P1-E02: version pinning — consumer stays on pinned version after new publish', async () => {
    // 1. Create module project with an agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Billing Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish v1.0.0
    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Version 1.0.0',
    });
    expect(v1ReleaseId).toBeTruthy();

    // 3. Create consumer and import with version pin to 1.0.0
    const { projectId: consumerProjectId } = await bootstrap.createProject('Billing Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'billing',
      { type: 'version', value: '1.0.0' },
    );

    // 4. Publish v1.1.0 of the module (new version)
    const updatedAgentDsl = `
AGENT: payment_processor

GOAL: "Process payments for customers with enhanced validation"

`;
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', updatedAgentDsl);
    const { releaseId: v11ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.1.0', {
      releaseNotes: 'Version 1.1.0 with enhanced validation',
    });
    expect(v11ReleaseId).toBeTruthy();

    // 5. Verify the consumer's dependency still points to v1.0.0
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(dep).toBeTruthy();
    const depDoc = dep as Record<string, unknown>;
    expect(depDoc.resolvedVersion).toBe('1.0.0');
    expect(depDoc.resolvedReleaseId).toBe(v1ReleaseId);

    // 6. Deploy the consumer — should use v1.0.0 agents
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 7. Verify deployment exists and is active
    const deploymentResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deploymentResult.status).toBe(200);
    const body = deploymentResult.body as {
      success: boolean;
      deployment: { status: string };
    };
    expect(body.deployment.status).toBe('active');
  }, 30_000);

  // ─── P1-E08: Source module changes don't affect consumer ────────────────────

  test("P1-E08: source module changes don't affect existing consumer deployment", async () => {
    // 1. Create module project with an agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Inventory Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish v1.0.0
    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 3. Create consumer, import module, deploy
    const { projectId: consumerProjectId } = await bootstrap.createProject('Inventory Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'inventory', {
      type: 'version',
      value: '1.0.0',
    });

    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    // 4. Capture the initial deployment state
    const initialDeployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(initialDeployment.status).toBe(200);
    const initialBody = initialDeployment.body as {
      success: boolean;
      deployment: {
        agentVersionManifest: Record<string, string>;
        status: string;
      };
    };
    const initialManifest = { ...initialBody.deployment.agentVersionManifest };

    // 5. Change the module source and publish v2.0.0
    const newModuleDsl = `
AGENT: payment_processor

GOAL: "Completely rewritten payment processor"

`;
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', newModuleDsl);
    await bootstrap.publishRelease(moduleProjectId, '2.0.0', {
      releaseNotes: 'Breaking change release',
    });

    // 6. Verify the existing consumer deployment is unchanged
    const postChangeDeployment = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(postChangeDeployment.status).toBe(200);
    const postBody = postChangeDeployment.body as {
      success: boolean;
      deployment: {
        agentVersionManifest: Record<string, string>;
        status: string;
      };
    };

    // Deployment manifest should be identical — module changes don't affect existing deployment
    expect(postBody.deployment.agentVersionManifest).toEqual(initialManifest);
    expect(postBody.deployment.status).toBe('active');

    // 7. Verify the v1.0.0 release is still intact (immutable)
    const v1Release = await ModuleRelease.findOne({
      _id: v1ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(v1Release).toBeTruthy();
    expect((v1Release as Record<string, unknown>).version).toBe('1.0.0');
  }, 30_000);

  // ─── P1-E09: Dependency removal ────────────────────────────────────────────

  test('P1-E09: dependency removal — consumer no longer has module agents after removal', async () => {
    // 1. Create module project with an agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Notification Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish v1.0.0
    await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 3. Create consumer and import the module
    const { projectId: consumerProjectId } = await bootstrap.createProject('Notification Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'notifications',
      { type: 'version', value: '1.0.0' },
    );

    // 4. Verify dependency exists
    const depBefore = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(depBefore).toBeTruthy();

    // 5. Remove the dependency (direct DB operation — Studio-only)
    await ProjectModuleDependency.deleteOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    });

    // 6. Verify dependency is gone
    const depAfter = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(depAfter).toBeNull();

    // 7. Deploy the consumer — should succeed with only consumer's own agents
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 8. Verify the deployment only has the consumer's own agent
    const deploymentResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deploymentResult.status).toBe(200);
    const body = deploymentResult.body as {
      success: boolean;
      deployment: {
        agentVersionManifest: Record<string, string>;
        entryAgentName: string;
      };
    };
    expect(body.deployment.entryAgentName).toBe('store_agent');
    expect(Object.keys(body.deployment.agentVersionManifest)).toEqual(['store_agent']);
  }, 30_000);

  // ─── P1-E10: Pointer promotion determinism ─────────────────────────────────

  test('P1-E10: pointer promotion determinism — env:dev resolves to promoted version, not latest', async () => {
    // 1. Create module project
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Analytics Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish v1.0.0 and promote to dev
    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Stable release for dev',
      promoteToEnvironment: 'dev',
    });

    // 3. Verify the dev pointer points to v1.0.0
    const pointerAfterV1 = await ModuleEnvironmentPointer.findOne({
      tenantId: bootstrap.tenantId,
      moduleProjectId,
      environment: 'dev',
    }).lean();
    expect(pointerAfterV1).toBeTruthy();
    expect((pointerAfterV1 as Record<string, unknown>).moduleReleaseId).toBe(v1ReleaseId);

    // 4. Publish v2.0.0 WITHOUT promoting to dev
    const { releaseId: v2ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '2.0.0', {
      releaseNotes: 'New version, not yet promoted',
      // No promoteToEnvironment — dev pointer stays at v1.0.0
    });
    expect(v2ReleaseId).toBeTruthy();

    // 5. Verify the dev pointer still points to v1.0.0 (not v2.0.0)
    const pointerAfterV2 = await ModuleEnvironmentPointer.findOne({
      tenantId: bootstrap.tenantId,
      moduleProjectId,
      environment: 'dev',
    }).lean();
    expect(pointerAfterV2).toBeTruthy();
    expect((pointerAfterV2 as Record<string, unknown>).moduleReleaseId).toBe(v1ReleaseId);

    // 6. Create consumer and import with env:dev selector
    const { projectId: consumerProjectId } = await bootstrap.createProject('Analytics Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'analytics',
      { type: 'environment', value: 'dev' },
    );

    // 7. Verify dependency resolved to v1.0.0 (the promoted one), not v2.0.0
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(dep).toBeTruthy();
    const depDoc = dep as Record<string, unknown>;
    expect(depDoc.resolvedVersion).toBe('1.0.0');
    expect(depDoc.resolvedReleaseId).toBe(v1ReleaseId);

    // 8. Deploy the consumer
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 9. Verify deployment is active
    const deploymentResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deploymentResult.status).toBe(200);
    const body = deploymentResult.body as {
      success: boolean;
      deployment: { status: string };
    };
    expect(body.deployment.status).toBe('active');
  }, 30_000);
});
