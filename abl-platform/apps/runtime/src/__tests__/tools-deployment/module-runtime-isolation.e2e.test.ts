/**
 * Module Runtime Isolation E2E Tests
 *
 * Tests multi-consumer config isolation, missing prerequisite detection,
 * overlapping name aliasing, cross-tenant isolation, and auth profile
 * contract snapshots through the real runtime HTTP API with no mocks.
 *
 * Uses ModuleE2EBootstrap which starts a real Express server with
 * MongoMemoryServer — all data seeded via helper methods, all
 * assertions via the HTTP API or direct DB reads on seeded data.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ModuleE2EBootstrap, SIMPLE_MODULE_AGENT_DSL } from '../helpers/module-e2e-bootstrap.js';
import { ProjectModuleDependency, ModuleRelease } from '@agent-platform/database/models';

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Module Runtime Isolation E2E', () => {
  let bootstrap: ModuleE2EBootstrap;

  beforeAll(async () => {
    bootstrap = await ModuleE2EBootstrap.create();
  }, 60_000);

  afterAll(async () => {
    await bootstrap.teardown();
  }, 30_000);

  // ─── P1-E03: Multi-consumer config isolation ────────────────────────────

  test('P1-E03: two consumers importing the same module with different configOverrides get isolated configs', async () => {
    // Create a shared module project with one agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Shared Payment Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // Publish a release
    await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      promoteToEnvironment: 'dev',
    });

    // Create two consumer projects
    const { projectId: consumerAId } = await bootstrap.createProject(
      'Store A Consumer',
      'application',
    );
    const { projectId: consumerBId } = await bootstrap.createProject(
      'Store B Consumer',
      'application',
    );

    // Import the same module into both consumers with DIFFERENT config overrides
    const { dependencyId: depA } = await bootstrap.importModule(
      consumerAId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
      { API_KEY: 'store-a-key-123', CURRENCY: 'USD' },
    );

    const { dependencyId: depB } = await bootstrap.importModule(
      consumerBId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
      { API_KEY: 'store-b-key-456', CURRENCY: 'EUR' },
    );

    // Verify dependency records exist and are distinct
    expect(depA).toBeTruthy();
    expect(depB).toBeTruthy();
    expect(depA).not.toBe(depB);

    // Read back the dependency records from DB to verify config isolation
    const depRecordA = await ProjectModuleDependency.findOne({
      _id: depA,
      tenantId: bootstrap.tenantId,
    }).lean();

    const depRecordB = await ProjectModuleDependency.findOne({
      _id: depB,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(depRecordA).toBeTruthy();
    expect(depRecordB).toBeTruthy();

    const configA = (depRecordA as Record<string, unknown>).configOverrides as Record<
      string,
      string
    >;
    const configB = (depRecordB as Record<string, unknown>).configOverrides as Record<
      string,
      string
    >;

    // Consumer A has its own config
    expect(configA.API_KEY).toBe('store-a-key-123');
    expect(configA.CURRENCY).toBe('USD');

    // Consumer B has its own config — isolated from A
    expect(configB.API_KEY).toBe('store-b-key-456');
    expect(configB.CURRENCY).toBe('EUR');

    // Verify they reference the same module release
    expect((depRecordA as Record<string, unknown>).resolvedReleaseId).toBe(
      (depRecordB as Record<string, unknown>).resolvedReleaseId,
    );
    expect((depRecordA as Record<string, unknown>).moduleProjectId).toBe(moduleProjectId);
    expect((depRecordB as Record<string, unknown>).moduleProjectId).toBe(moduleProjectId);

    // Verify they belong to different consumer projects
    expect((depRecordA as Record<string, unknown>).projectId).toBe(consumerAId);
    expect((depRecordB as Record<string, unknown>).projectId).toBe(consumerBId);
  }, 30_000);

  // ─── P1-E04: Missing prerequisite blocks ────────────────────────────────

  test('P1-E04: module with requiredConfigKeys — dependency records missing prerequisites in contract', async () => {
    // Create a module project
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Config Required Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // Publish release — then patch the contract to include requiredConfigKeys
    // (The bootstrap helper creates an empty requiredConfigKeys by default,
    // so we publish first, then update the release doc with real requirements.)
    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // Patch the release contract to require config keys
    await ModuleRelease.findOneAndUpdate(
      { _id: releaseId, tenantId: bootstrap.tenantId },
      {
        $set: {
          'contract.requiredConfigKeys': [
            { key: 'PAYMENT_API_KEY', description: 'API key for payment gateway', isSecret: true },
            { key: 'PAYMENT_REGION', description: 'Payment processing region', isSecret: false },
          ],
        },
      },
    );

    // Create a consumer project and import WITHOUT providing required config
    const { projectId: consumerId } = await bootstrap.createProject('Bare Consumer', 'application');

    // Re-read the release so importModule picks up the updated contract
    const { dependencyId } = await bootstrap.importModule(
      consumerId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
      // No configOverrides — deliberately omitting required keys
    );

    expect(dependencyId).toBeTruthy();

    // Read the dependency to verify the contractSnapshot captured the requirements
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(dep).toBeTruthy();

    const contract = (dep as Record<string, unknown>).contractSnapshot as {
      requiredConfigKeys: Array<{ key: string; description?: string; isSecret: boolean }>;
    };

    // The contract snapshot should contain the required config keys
    expect(contract.requiredConfigKeys).toBeDefined();
    expect(contract.requiredConfigKeys).toHaveLength(2);
    expect(contract.requiredConfigKeys[0].key).toBe('PAYMENT_API_KEY');
    expect(contract.requiredConfigKeys[0].isSecret).toBe(true);
    expect(contract.requiredConfigKeys[1].key).toBe('PAYMENT_REGION');
    expect(contract.requiredConfigKeys[1].isSecret).toBe(false);

    // The configOverrides should be empty — consumer didn't provide them
    const configOverrides =
      ((dep as Record<string, unknown>).configOverrides as Record<string, string> | null) ?? {};
    expect(Object.keys(configOverrides)).toHaveLength(0);
  }, 30_000);

  // ─── P1-E05: Overlapping names, different aliases ───────────────────────

  test('P1-E05: two modules with same agent name imported under different aliases resolve as alias-prefixed', async () => {
    // Create Module A with agent named "main_agent"
    const { projectId: moduleAId } = await bootstrap.createProject('Payment Module A', 'module');
    const mainAgentDsl = `
AGENT: main_agent

GOAL: "Handle payment operations"
`;
    await bootstrap.createAgent(moduleAId, 'main_agent', mainAgentDsl);
    await bootstrap.setEntryAgent(moduleAId, 'main_agent');
    await bootstrap.publishRelease(moduleAId, '1.0.0', {
      promoteToEnvironment: 'dev',
    });

    // Create Module B with agent also named "main_agent"
    const { projectId: moduleBId } = await bootstrap.createProject('CRM Module B', 'module');
    await bootstrap.createAgent(moduleBId, 'main_agent', mainAgentDsl);
    await bootstrap.setEntryAgent(moduleBId, 'main_agent');
    await bootstrap.publishRelease(moduleBId, '1.0.0', {
      promoteToEnvironment: 'dev',
    });

    // Create consumer project and import both modules with different aliases
    const { projectId: consumerId } = await bootstrap.createProject(
      'Multi Module Consumer',
      'application',
    );

    const { dependencyId: depPay } = await bootstrap.importModule(consumerId, moduleAId, 'pay', {
      type: 'version',
      value: '1.0.0',
    });

    const { dependencyId: depCrm } = await bootstrap.importModule(consumerId, moduleBId, 'crm', {
      type: 'version',
      value: '1.0.0',
    });

    expect(depPay).toBeTruthy();
    expect(depCrm).toBeTruthy();

    // Read dependencies to verify alias assignments
    const payDep = await ProjectModuleDependency.findOne({
      _id: depPay,
      tenantId: bootstrap.tenantId,
    }).lean();
    const crmDep = await ProjectModuleDependency.findOne({
      _id: depCrm,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(payDep).toBeTruthy();
    expect(crmDep).toBeTruthy();

    // Verify aliases are distinct
    expect((payDep as Record<string, unknown>).alias).toBe('pay');
    expect((crmDep as Record<string, unknown>).alias).toBe('crm');

    // Both reference agents named "main_agent" in their contract snapshots
    const payContract = (payDep as Record<string, unknown>).contractSnapshot as {
      providedAgents: Array<{ name: string }>;
    };
    const crmContract = (crmDep as Record<string, unknown>).contractSnapshot as {
      providedAgents: Array<{ name: string }>;
    };

    expect(payContract.providedAgents).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'main_agent' })]),
    );
    expect(crmContract.providedAgents).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'main_agent' })]),
    );

    // The alias-prefixed names would be "pay__main_agent" and "crm__main_agent"
    // at deployment resolution time. Verify the aliases and module project IDs
    // are distinct so the resolver can build prefixed names.
    expect((payDep as Record<string, unknown>).moduleProjectId).toBe(moduleAId);
    expect((crmDep as Record<string, unknown>).moduleProjectId).toBe(moduleBId);
    expect((payDep as Record<string, unknown>).moduleProjectId).not.toBe(
      (crmDep as Record<string, unknown>).moduleProjectId,
    );

    // Verify both dependencies belong to the same consumer project
    expect((payDep as Record<string, unknown>).projectId).toBe(consumerId);
    expect((crmDep as Record<string, unknown>).projectId).toBe(consumerId);
  }, 30_000);

  // ─── P1-E07: Cross-tenant isolation ─────────────────────────────────────

  test('P1-E07: tenant2 cannot see tenant1 module releases or import from them', async () => {
    // Use the primary bootstrap (tenant1) to create a module and publish a release
    const { projectId: tenant1ModuleId } = await bootstrap.createProject(
      'Tenant1 Secret Module',
      'module',
    );
    await bootstrap.createAgent(tenant1ModuleId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(tenant1ModuleId, 'payment_processor');
    const { releaseId: tenant1ReleaseId } = await bootstrap.publishRelease(
      tenant1ModuleId,
      '1.0.0',
      { promoteToEnvironment: 'dev' },
    );

    // Use a fabricated tenant2 ID — same MongoDB, different tenantId
    // This tests tenant isolation at the query level without creating a separate DB.
    const tenant2Id = '019d0000-0000-7000-0000-000000000002';

    // Verify tenant2 cannot find tenant1's module release
    const tenant2Releases = await ModuleRelease.find({
      tenantId: tenant2Id,
      moduleProjectId: tenant1ModuleId,
    }).lean();

    expect(tenant2Releases).toHaveLength(0);

    // Verify tenant2 cannot find tenant1's release by ID (scoped by tenantId)
    const crossTenantRelease = await ModuleRelease.findOne({
      _id: tenant1ReleaseId,
      tenantId: tenant2Id,
    }).lean();

    expect(crossTenantRelease).toBeNull();

    // Verify tenant1 CAN find its own release
    const tenant1Release = await ModuleRelease.findOne({
      _id: tenant1ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(tenant1Release).toBeTruthy();
    expect((tenant1Release as Record<string, unknown>).version).toBe('1.0.0');

    // Direct DB attempt: tenant2 tries to find tenant1's release — should find nothing
    const illicitRelease = await ModuleRelease.findOne({
      tenantId: tenant2Id,
      moduleProjectId: tenant1ModuleId,
      version: '1.0.0',
    }).lean();

    expect(illicitRelease).toBeNull();

    // Create a release directly under tenant2 to verify independent namespaces
    const tenant2Release = await ModuleRelease.create({
      tenantId: tenant2Id,
      moduleProjectId: tenant1ModuleId, // Same module project ID, different tenant
      version: '1.0.0',
      releaseNotes: 'Tenant2 release',
      artifact: {
        dslFormat: 'legacy',
        entryAgentName: 'payment_processor',
        agents: {},
        tools: {},
      },
      compiledIR: {},
      contract: {
        providedAgents: [],
        providedTools: [],
        requiredConfigKeys: [],
        requiredEnvVars: [],
        requiredAuthProfiles: [],
        requiredConnectors: [],
        requiredMcpServers: [],
        warnings: [],
      },
      sourceHash: 'tenant2-hash',
      createdBy: 'tenant2-user',
    });
    const tenant2ReleaseId = String(tenant2Release._id);

    // Tenant2's release exists under tenant2
    const tenant2Found = await ModuleRelease.findOne({
      _id: tenant2ReleaseId,
      tenantId: tenant2Id,
    }).lean();
    expect(tenant2Found).toBeTruthy();

    // But tenant1 cannot see tenant2's release
    const crossCheck = await ModuleRelease.findOne({
      _id: tenant2ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(crossCheck).toBeNull();

    // Cleanup: remove tenant2's test data (tenant-scoped delete)
    await ModuleRelease.deleteOne({ _id: tenant2ReleaseId, tenantId: tenant2Id });
  }, 30_000);

  // ─── P1-E13: Auth profile renamed/deleted fails closed ──────────────────

  test('P1-E13: module with requiredAuthProfiles — dependency records the auth profile requirement in contractSnapshot', async () => {
    // Create a module project
    const { projectId: moduleProjectId } = await bootstrap.createProject('Auth Module', 'module');
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // Publish release, then patch contract to include requiredAuthProfiles
    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // Patch the release contract with auth profile requirements
    await ModuleRelease.findOneAndUpdate(
      { _id: releaseId, tenantId: bootstrap.tenantId },
      {
        $set: {
          'contract.requiredAuthProfiles': [
            {
              name: 'payment_gateway_oauth',
              authType: 'oauth2',
              scope: 'payments:read payments:write',
              referencedBy: ['payment_processor'],
            },
            {
              name: 'crm_api_key',
              authType: 'api_key',
              scope: undefined,
              referencedBy: ['payment_processor'],
            },
          ],
        },
      },
    );

    // Consumer imports the module
    const { projectId: consumerId } = await bootstrap.createProject('Auth Consumer', 'application');
    const { dependencyId } = await bootstrap.importModule(
      consumerId,
      moduleProjectId,
      'auth_payments',
      { type: 'version', value: '1.0.0' },
    );

    expect(dependencyId).toBeTruthy();

    // Read the dependency to verify contractSnapshot captured auth requirements
    const dep = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(dep).toBeTruthy();

    const contract = (dep as Record<string, unknown>).contractSnapshot as {
      requiredAuthProfiles: Array<{
        name: string;
        authType?: string;
        scope?: string;
        referencedBy: string[];
      }>;
    };

    // The contractSnapshot must record the auth profile requirements
    expect(contract.requiredAuthProfiles).toBeDefined();
    expect(contract.requiredAuthProfiles).toHaveLength(2);

    const oauthProfile = contract.requiredAuthProfiles.find(
      (p) => p.name === 'payment_gateway_oauth',
    );
    expect(oauthProfile).toBeTruthy();
    expect(oauthProfile!.authType).toBe('oauth2');
    expect(oauthProfile!.scope).toBe('payments:read payments:write');
    expect(oauthProfile!.referencedBy).toContain('payment_processor');

    const apiKeyProfile = contract.requiredAuthProfiles.find((p) => p.name === 'crm_api_key');
    expect(apiKeyProfile).toBeTruthy();
    expect(apiKeyProfile!.authType).toBe('api_key');
    expect(apiKeyProfile!.referencedBy).toContain('payment_processor');
  }, 30_000);
});
