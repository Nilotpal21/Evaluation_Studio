/**
 * Module Tool Execution Integration Tests
 *
 * Validates the full module tool execution path: publish a module with an
 * HTTP tool, import into a consumer project, deploy, and verify that the
 * deployment snapshot contains the mounted tool with alias-prefixed name
 * and correct provenance metadata.
 *
 * NO mocks. Real HTTP API setup with MongoMemoryServer, plus direct snapshot
 * inspection for immutable deployment artifact assertions.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import zlib from 'node:zlib';
import {
  ModuleE2EBootstrap,
  SIMPLE_MODULE_AGENT_DSL,
  SIMPLE_MODULE_TOOL_DSL,
  CONSUMER_AGENT_DSL,
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
  const raw = (doc as any).compressedPayload;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer ?? raw);
  const decompressed = zlib.gunzipSync(buf);
  return JSON.parse(decompressed.toString());
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Module Tool Execution E2E', () => {
  let bootstrap: ModuleE2EBootstrap;

  beforeAll(async () => {
    bootstrap = await ModuleE2EBootstrap.create();
  }, 60_000);

  afterAll(async () => {
    await bootstrap?.teardown();
  }, 30_000);

  // ─── Full module tool execution path ───────────────────────────────────────

  test('module with HTTP tool — deploy consumer, verify tool mounted with alias prefix in snapshot', async () => {
    // 1. Create a module project
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Benefits Module',
      'module',
    );

    // 2. Create an agent and an HTTP tool in the module
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.createTool(moduleProjectId, 'validate_card', SIMPLE_MODULE_TOOL_DSL, 'http');
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 3. Publish a module release
    const { releaseId, version } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Module with HTTP tool',
    });
    expect(releaseId).toBeTruthy();
    expect(version).toBe('1.0.0');

    // 4. Create a consumer project
    const { projectId: consumerProjectId } = await bootstrap.createProject(
      'Benefits Consumer',
      'application',
    );
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    // 5. Import the module with alias 'benefits'
    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'benefits',
      { type: 'version', value: '1.0.0' },
    );
    expect(dependencyId).toBeTruthy();

    // 6. Deploy the consumer project
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 7. Verify deployment is active via API
    const deployResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deployResult.status).toBe(200);
    const deployBody = deployResult.body as {
      success: boolean;
      deployment: { status: string; entryAgentName: string };
    };
    expect(deployBody.success).toBe(true);
    expect(deployBody.deployment.status).toBe('active');
    expect(deployBody.deployment.entryAgentName).toBe('store_agent');

    // 8. Read back the deployment module snapshot
    const stored = await readSnapshot(bootstrap.tenantId, deploymentId);
    expect(stored).toBeTruthy();

    // 9. Verify dependency metadata
    expect(stored!.dependencies).toHaveLength(1);
    expect(stored!.dependencies[0].alias).toBe('benefits');
    expect(stored!.dependencies[0].moduleProjectId).toBe(moduleProjectId);
    expect(stored!.dependencies[0].moduleReleaseId).toBe(releaseId);
    expect(stored!.dependencies[0].version).toBe('1.0.0');

    // 10. Verify mounted agent with alias prefix
    const mountedAgent = stored!.mountedAgents['benefits__payment_processor'];
    expect(mountedAgent).toBeDefined();
    expect(mountedAgent.alias).toBe('benefits');
    expect(mountedAgent.moduleProjectId).toBe(moduleProjectId);
    expect(mountedAgent.moduleReleaseId).toBe(releaseId);
    expect(mountedAgent.sourceAgentName).toBe('payment_processor');
    expect(mountedAgent.ir.metadata.name).toBe('benefits__payment_processor');

    // 11. Verify mounted tool with alias prefix
    const mountedToolNames = Object.keys(stored!.mountedTools);
    expect(mountedToolNames.length).toBeGreaterThanOrEqual(1);

    // The tool should be mounted with alias prefix: benefits__validate_card
    const mountedTool = stored!.mountedTools['benefits__validate_card'];
    expect(mountedTool).toBeDefined();
    expect(mountedTool.alias).toBe('benefits');
    expect(mountedTool.moduleProjectId).toBe(moduleProjectId);
    expect(mountedTool.moduleReleaseId).toBe(releaseId);
    expect(mountedTool.sourceToolName).toBe('validate_card');
    expect(mountedTool.definition).toBeDefined();
  }, 30_000);

  // ─── Multiple modules with tools — alias isolation ─────────────────────────

  test('two modules with tools — deployment snapshot contains both sets of tools with distinct alias prefixes', async () => {
    // 1. Create Module A with a tool
    const { projectId: moduleAId } = await bootstrap.createProject('Payment Tool Module', 'module');
    await bootstrap.createAgent(moduleAId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.createTool(moduleAId, 'validate_card', SIMPLE_MODULE_TOOL_DSL, 'http');
    await bootstrap.setEntryAgent(moduleAId, 'payment_processor');
    const { releaseId: releaseAId } = await bootstrap.publishRelease(moduleAId, '1.0.0');

    // 2. Create Module B with the same tool name (to test alias isolation)
    const { projectId: moduleBId } = await bootstrap.createProject('CRM Tool Module', 'module');
    const crmAgentDsl = `
AGENT: crm_handler

GOAL: "Handle CRM operations"
`;
    const crmToolDsl = `TOOLS:
  base_url: "https://api.crm-example.com/v1"

  validate_card(card_id: string) -> object
    type: http
    endpoint: "/validate-card"
    method: POST
    description: "Validate a CRM card entry"
`;
    await bootstrap.createAgent(moduleBId, 'crm_handler', crmAgentDsl);
    await bootstrap.createTool(moduleBId, 'validate_card', crmToolDsl, 'http');
    await bootstrap.setEntryAgent(moduleBId, 'crm_handler');
    const { releaseId: releaseBId } = await bootstrap.publishRelease(moduleBId, '1.0.0');

    // 3. Create consumer and import both modules with different aliases
    const { projectId: consumerProjectId } = await bootstrap.createProject(
      'Multi Tool Consumer',
      'application',
    );
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    await bootstrap.importModule(consumerProjectId, moduleAId, 'payments', {
      type: 'version',
      value: '1.0.0',
    });
    await bootstrap.importModule(consumerProjectId, moduleBId, 'crm', {
      type: 'version',
      value: '1.0.0',
    });

    // 4. Deploy
    const { deploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(deploymentId).toBeTruthy();

    // 5. Read snapshot
    const stored = await readSnapshot(bootstrap.tenantId, deploymentId);
    expect(stored).toBeTruthy();

    // 6. Verify both dependencies
    expect(stored!.dependencies).toHaveLength(2);
    const aliases = stored!.dependencies.map((d) => d.alias).sort();
    expect(aliases).toEqual(['crm', 'payments']);

    // 7. Verify mounted agents from both modules
    expect(stored!.mountedAgents['payments__payment_processor']).toBeDefined();
    expect(stored!.mountedAgents['crm__crm_handler']).toBeDefined();

    // 8. Verify mounted tools from both modules — same source name, different alias prefix
    const paymentTool = stored!.mountedTools['payments__validate_card'];
    const crmTool = stored!.mountedTools['crm__validate_card'];

    expect(paymentTool).toBeDefined();
    expect(paymentTool.alias).toBe('payments');
    expect(paymentTool.moduleProjectId).toBe(moduleAId);
    expect(paymentTool.moduleReleaseId).toBe(releaseAId);
    expect(paymentTool.sourceToolName).toBe('validate_card');

    expect(crmTool).toBeDefined();
    expect(crmTool.alias).toBe('crm');
    expect(crmTool.moduleProjectId).toBe(moduleBId);
    expect(crmTool.moduleReleaseId).toBe(releaseBId);
    expect(crmTool.sourceToolName).toBe('validate_card');

    // 9. Verify deployment is active
    const deployResult = await bootstrap.get(
      `/api/projects/${consumerProjectId}/deployments/${deploymentId}`,
    );
    expect(deployResult.status).toBe(200);
    expect((deployResult.body as { success: boolean }).success).toBe(true);
  }, 30_000);

  // ─── Tool provenance preserved after module upgrade ────────────────────────

  test('tool provenance updates after module upgrade — new release tool appears in redeployed snapshot', async () => {
    // 1. Create module with agent + tool, publish v1.0.0
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Upgradeable Tool Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.createTool(moduleProjectId, 'validate_card', SIMPLE_MODULE_TOOL_DSL, 'http');
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 2. Create consumer, import module, deploy v1
    const { projectId: consumerProjectId } = await bootstrap.createProject(
      'Tool Upgrade Consumer',
      'application',
    );
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'benefits',
      { type: 'version', value: '1.0.0' },
    );

    const { deploymentId: v1DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });

    // 3. Verify v1 snapshot has the tool
    const v1Snapshot = await readSnapshot(bootstrap.tenantId, v1DeploymentId);
    expect(v1Snapshot).toBeTruthy();
    expect(v1Snapshot!.mountedTools['benefits__validate_card']).toBeDefined();
    expect(v1Snapshot!.mountedTools['benefits__validate_card'].moduleReleaseId).toBe(v1ReleaseId);

    // 4. Publish v1.1.0 with the same tool (no changes needed — just a new version)
    const { releaseId: v11ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.1.0', {
      releaseNotes: 'Minor tool update',
    });

    // 5. Upgrade the dependency
    const upgradeResult = await bootstrap.upgradeModule(
      consumerProjectId,
      dependencyId,
      v11ReleaseId,
    );
    expect(upgradeResult.status).toBe(200);

    // 6. Redeploy
    const { deploymentId: v11DeploymentId } = await bootstrap.deploy(consumerProjectId, {
      entryAgentName: 'store_agent',
    });
    expect(v11DeploymentId).not.toBe(v1DeploymentId);

    // 7. Verify v1.1.0 snapshot has the tool with updated release ID
    const v11Snapshot = await readSnapshot(bootstrap.tenantId, v11DeploymentId);
    expect(v11Snapshot).toBeTruthy();
    expect(v11Snapshot!.mountedTools['benefits__validate_card']).toBeDefined();
    expect(v11Snapshot!.mountedTools['benefits__validate_card'].moduleReleaseId).toBe(v11ReleaseId);
    expect(v11Snapshot!.mountedTools['benefits__validate_card'].sourceToolName).toBe(
      'validate_card',
    );
    expect(v11Snapshot!.mountedTools['benefits__validate_card'].alias).toBe('benefits');

    // 8. Verify the v1 snapshot still has the old release ID (immutable snapshots)
    const v1SnapshotReread = await readSnapshot(bootstrap.tenantId, v1DeploymentId);
    expect(v1SnapshotReread!.mountedTools['benefits__validate_card'].moduleReleaseId).toBe(
      v1ReleaseId,
    );
  }, 30_000);
});
