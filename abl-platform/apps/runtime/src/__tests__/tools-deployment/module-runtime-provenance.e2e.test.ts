/**
 * Module Runtime Provenance E2E Tests
 *
 * P1-E06:  Provenance tracking in deployment — deploy consumer with module
 *          dependency, verify DeploymentModuleSnapshot contains provenance metadata.
 * P1-E11:  Module agent provenance in deployment manifest — multi-agent module
 *          published, imported, deployed; manifest has entries for all agents.
 * P1-E06b: Provenance preserved across re-deployment — same consumer redeployed,
 *          both deployments carry identical module dependency info.
 * P1-E11b: Multiple modules provenance tracking — two modules imported into one
 *          consumer; deployment shows agents from both modules plus consumer's own.
 *
 * NO mocks. Real HTTP API, real MongoMemoryServer.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import zlib from 'node:zlib';
import {
  ModuleE2EBootstrap,
  SIMPLE_MODULE_AGENT_DSL,
  CONSUMER_AGENT_DSL,
  MULTI_AGENT_MODULE_DSL,
} from '../helpers/module-e2e-bootstrap.js';
import { DeploymentModuleSnapshot } from '@agent-platform/database/models';
import type { DeploymentModuleSnapshotPayload } from '../../services/modules/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read and decompress a stored snapshot for assertions.
 */
async function readSnapshot(
  tenantId: string,
  deploymentId: string,
): Promise<DeploymentModuleSnapshotPayload | null> {
  const doc = await DeploymentModuleSnapshot.findOne({ tenantId, deploymentId }).lean();
  if (!doc) return null;
  // Mongoose returns Binary — convert to Buffer before gunzip
  const raw = (doc as any).compressedPayload;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer ?? raw);
  const decompressed = zlib.gunzipSync(buf);
  return JSON.parse(decompressed.toString());
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Module runtime provenance E2E', () => {
  let bootstrap: ModuleE2EBootstrap;

  beforeAll(async () => {
    bootstrap = await ModuleE2EBootstrap.create();
  }, 60_000);

  afterAll(async () => {
    await bootstrap.teardown();
  }, 30_000);

  // ─── P1-E06: Provenance tracking in deployment ──────────────────────────

  test('P1-E06: deployed consumer includes module dependency provenance in snapshot', async () => {
    // 1. Create module project with an agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Provenance Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish a release
    const { releaseId, version } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Provenance test release',
    });

    // 3. Create consumer project
    const { projectId: consumerProjectId } = await bootstrap.createProject(
      'Provenance Consumer',
      'application',
    );
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

    // 5. Deploy the consumer
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 6. Read back the snapshot and verify provenance
    const stored = await readSnapshot(bootstrap.tenantId, deploymentId);
    expect(stored).toBeTruthy();

    // Dependency metadata
    expect(stored!.dependencies).toHaveLength(1);
    expect(stored!.dependencies[0].alias).toBe('payments');
    expect(stored!.dependencies[0].moduleProjectId).toBe(moduleProjectId);
    expect(stored!.dependencies[0].moduleReleaseId).toBe(releaseId);
    expect(stored!.dependencies[0].version).toBe('1.0.0');

    // Mounted agent provenance
    const mountedAgent = stored!.mountedAgents['payments__payment_processor'];
    expect(mountedAgent).toBeDefined();
    expect(mountedAgent.alias).toBe('payments');
    expect(mountedAgent.moduleProjectId).toBe(moduleProjectId);
    expect(mountedAgent.moduleReleaseId).toBe(releaseId);
    expect(mountedAgent.sourceAgentName).toBe('payment_processor');
    expect(mountedAgent.ir.metadata.name).toBe('payments__payment_processor');

    // 7. Verify deployment itself is accessible via API
    const deployResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deployResult.status).toBe(200);
    expect((deployResult.body as any).success).toBe(true);
  }, 30_000);

  // ─── P1-E11: Module agent provenance in deployment manifest ─────────────

  test('P1-E11: multi-agent module — deployment manifest contains entries for all module agents and consumer agents', async () => {
    // 1. Create module with 2 agents
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Multi Agent Module',
      'module',
    );
    await bootstrap.createAgents(moduleProjectId, [
      { name: 'order_supervisor', dslContent: MULTI_AGENT_MODULE_DSL.entry },
      { name: 'order_worker', dslContent: MULTI_AGENT_MODULE_DSL.worker },
    ]);
    await bootstrap.setEntryAgent(moduleProjectId, 'order_supervisor');

    // 2. Publish release
    const { releaseId, version } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Multi-agent module release',
    });

    // 3. Create consumer
    const { projectId: consumerProjectId } = await bootstrap.createProject(
      'Multi Agent Consumer',
      'application',
    );
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    // 4. Import module
    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'orders', {
      type: 'version',
      value: '1.0.0',
    });

    // 5. Deploy the consumer
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 6. Read snapshot and verify both module agents are present
    const stored = await readSnapshot(bootstrap.tenantId, deploymentId);
    expect(stored).toBeTruthy();

    const mountedNames = Object.keys(stored!.mountedAgents);
    expect(mountedNames).toContain('orders__order_supervisor');
    expect(mountedNames).toContain('orders__order_worker');
    expect(mountedNames).toHaveLength(2);

    // Verify provenance for each mounted agent
    for (const [mountedName, entry] of Object.entries(stored!.mountedAgents)) {
      expect(entry.alias).toBe('orders');
      expect(entry.moduleProjectId).toBe(moduleProjectId);
      expect(entry.moduleReleaseId).toBe(releaseId);
      expect(entry.ir.metadata.name).toBe(mountedName);
    }

    // 7. Verify the deployment API includes the consumer's own agent in its manifest
    const deployResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deployResult.status).toBe(200);
    const body = deployResult.body as {
      success: boolean;
      deployment: {
        agentVersionManifest: Record<string, string>;
        entryAgentName: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.deployment.entryAgentName).toBe('store_agent');
    expect(body.deployment.agentVersionManifest).toHaveProperty('store_agent');
  }, 30_000);

  // ─── P1-E06b: Provenance preserved across re-deployment ─────────────────

  test('P1-E06b: provenance preserved across re-deployment — both deployments carry same module dependency info', async () => {
    // 1. Create module and publish
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Redeploy Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId, version } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 2. Create consumer and import module
    const { projectId: consumerProjectId } = await bootstrap.createProject(
      'Redeploy Consumer',
      'application',
    );
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleProjectId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });

    // 3. First deployment (A)
    const { deploymentId: deploymentA } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentA).toBeTruthy();

    // 4. Second deployment (B) — same consumer, same module dependency
    const { deploymentId: deploymentB } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentB).toBeTruthy();
    expect(deploymentB).not.toBe(deploymentA);

    // 5. Read both snapshots and compare dependency info
    const storedA = await readSnapshot(bootstrap.tenantId, deploymentA);
    const storedB = await readSnapshot(bootstrap.tenantId, deploymentB);

    expect(storedA).toBeTruthy();
    expect(storedB).toBeTruthy();

    // Both deployments carry the same module dependency metadata
    expect(storedA!.dependencies).toHaveLength(1);
    expect(storedB!.dependencies).toHaveLength(1);

    expect(storedA!.dependencies[0].alias).toBe(storedB!.dependencies[0].alias);
    expect(storedA!.dependencies[0].moduleProjectId).toBe(storedB!.dependencies[0].moduleProjectId);
    expect(storedA!.dependencies[0].moduleReleaseId).toBe(storedB!.dependencies[0].moduleReleaseId);
    expect(storedA!.dependencies[0].version).toBe(storedB!.dependencies[0].version);

    // Both have the same mounted agent provenance
    const agentA = storedA!.mountedAgents['payments__payment_processor'];
    const agentB = storedB!.mountedAgents['payments__payment_processor'];
    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
    expect(agentA.moduleProjectId).toBe(agentB.moduleProjectId);
    expect(agentA.moduleReleaseId).toBe(agentB.moduleReleaseId);
    expect(agentA.sourceAgentName).toBe(agentB.sourceAgentName);
    expect(agentA.alias).toBe(agentB.alias);

    // 6. Verify both deployments are accessible via API
    const resultA = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentA}`,
    );
    const resultB = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentB}`,
    );
    expect(resultA.status).toBe(200);
    expect(resultB.status).toBe(200);
  }, 30_000);

  // ─── P1-E11b: Multiple modules provenance tracking ──────────────────────

  test('P1-E11b: two modules imported into one consumer — deployment shows agents from both modules plus consumer own', async () => {
    // 1. Create Module A (payment)
    const { projectId: moduleAId } = await bootstrap.createProject('Payment Module Prov', 'module');
    await bootstrap.createAgent(moduleAId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleAId, 'payment_processor');
    const { releaseId: releaseAId, version: versionA } = await bootstrap.publishRelease(
      moduleAId,
      '1.0.0',
    );

    // 2. Create Module B (orders — multi-agent)
    const { projectId: moduleBId } = await bootstrap.createProject('Orders Module Prov', 'module');
    await bootstrap.createAgents(moduleBId, [
      { name: 'order_supervisor', dslContent: MULTI_AGENT_MODULE_DSL.entry },
      { name: 'order_worker', dslContent: MULTI_AGENT_MODULE_DSL.worker },
    ]);
    await bootstrap.setEntryAgent(moduleBId, 'order_supervisor');
    const { releaseId: releaseBId, version: versionB } = await bootstrap.publishRelease(
      moduleBId,
      '1.0.0',
    );

    // 3. Create consumer and import both modules
    const { projectId: consumerProjectId } = await bootstrap.createProject(
      'Multi Module Consumer Prov',
      'application',
    );
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleAId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });
    await bootstrap.importModule(consumerProjectId, moduleBId, 'orders', {
      type: 'version',
      value: '1.0.0',
    });

    // 4. Deploy
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 5. Read snapshot and verify ALL mounted agents from both modules
    const stored = await readSnapshot(bootstrap.tenantId, deploymentId);
    expect(stored).toBeTruthy();

    // Should have 2 dependencies
    expect(stored!.dependencies).toHaveLength(2);
    const depAliases = stored!.dependencies.map((d) => d.alias).sort();
    expect(depAliases).toEqual(['orders', 'payments']);

    // Should have 3 mounted agents (1 from payments, 2 from orders)
    const mountedNames = Object.keys(stored!.mountedAgents).sort();
    expect(mountedNames).toEqual([
      'orders__order_supervisor',
      'orders__order_worker',
      'payments__payment_processor',
    ]);

    // Verify payments module provenance
    const payAgent = stored!.mountedAgents['payments__payment_processor'];
    expect(payAgent.moduleProjectId).toBe(moduleAId);
    expect(payAgent.moduleReleaseId).toBe(releaseAId);
    expect(payAgent.alias).toBe('payments');
    expect(payAgent.sourceAgentName).toBe('payment_processor');

    // Verify orders module provenance
    const orderSup = stored!.mountedAgents['orders__order_supervisor'];
    expect(orderSup.moduleProjectId).toBe(moduleBId);
    expect(orderSup.moduleReleaseId).toBe(releaseBId);
    expect(orderSup.alias).toBe('orders');
    expect(orderSup.sourceAgentName).toBe('order_supervisor');

    const orderWorker = stored!.mountedAgents['orders__order_worker'];
    expect(orderWorker.moduleProjectId).toBe(moduleBId);
    expect(orderWorker.moduleReleaseId).toBe(releaseBId);
    expect(orderWorker.alias).toBe('orders');
    expect(orderWorker.sourceAgentName).toBe('order_worker');

    // 6. Verify deployment API shows consumer's own agent in manifest
    const deployResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deployResult.status).toBe(200);
    const body = deployResult.body as {
      success: boolean;
      deployment: {
        agentVersionManifest: Record<string, string>;
        entryAgentName: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.deployment.entryAgentName).toBe('store_agent');
    expect(body.deployment.agentVersionManifest).toHaveProperty('store_agent');
  }, 30_000);
});
