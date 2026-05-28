/**
 * Integration Test: Cross-Tenant Connection Isolation (INT-6)
 *
 * Tests that ConnectionService enforces strict tenant + project isolation
 * at the data layer. Every CRUD operation is scoped to { tenantId, projectId },
 * so Tenant B must never see, modify, or delete Tenant A's connections.
 *
 * Uses MongoMemoryServer for real DB operations.
 * No mocks of codebase components.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { ConnectionService } from '../../services/connection-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { registerTestConnector } from '../fixtures/test-connector.js';
import { setupIntegrationContext, type IntegrationTestContext } from '../helpers/setup-mongo.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PROJECT_P1 = 'project-P1';
const PROJECT_P2 = 'project-P2';

// ─── Setup / Teardown ───────────────────────────────────────────────────────

let ctx: IntegrationTestContext;
let mongoAvailable = false;

beforeAll(async () => {
  try {
    ctx = await setupIntegrationContext();
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
}, 30_000);

afterEach(async () => {
  if (mongoAvailable) {
    await ctx.cleanup();
  }
});

afterAll(async () => {
  if (mongoAvailable) {
    await ctx.teardown();
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createService(): ConnectionService {
  const registry = new ConnectorRegistry();
  registerTestConnector(registry);

  return new ConnectionService({
    connectionModel: ctx.connectionModel,
    registry,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('INT-6: Cross-Tenant Connection Isolation', () => {
  it('skips if MongoDB unavailable', ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');
  });

  // ── 1. list returns only the requesting tenant's connections ────────────

  it('list returns only the requesting tenant connections', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Create connections for Tenant A (project P1) and Tenant B (project P2)
    await svc.create(TENANT_A, PROJECT_P1, {
      connectorName: 'test-connector',
      displayName: 'Tenant A Connection',
      authProfileId: 'ap-a',
    });

    await svc.create(TENANT_B, PROJECT_P2, {
      connectorName: 'test-connector',
      displayName: 'Tenant B Connection',
      authProfileId: 'ap-b',
    });

    // List for Tenant A — should see only its own
    const listA = await svc.list(TENANT_A, PROJECT_P1);
    expect(listA).toHaveLength(1);
    expect(listA[0].displayName).toBe('Tenant A Connection');
    expect(listA[0].tenantId).toBe(TENANT_A);
    expect(listA[0].projectId).toBe(PROJECT_P1);

    // List for Tenant B — should see only its own
    const listB = await svc.list(TENANT_B, PROJECT_P2);
    expect(listB).toHaveLength(1);
    expect(listB[0].displayName).toBe('Tenant B Connection');
    expect(listB[0].tenantId).toBe(TENANT_B);
    expect(listB[0].projectId).toBe(PROJECT_P2);

    // Cross-tenant list — Tenant A querying Tenant B's project returns nothing
    const crossList = await svc.list(TENANT_A, PROJECT_P2);
    expect(crossList).toHaveLength(0);
  });

  // ── 2. getById with wrong tenantId returns null ─────────────────────────

  it('getById with wrong tenantId returns null (cross-tenant)', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Create connection for Tenant A
    const created = await svc.create(TENANT_A, PROJECT_P1, {
      connectorName: 'test-connector',
      displayName: 'Tenant A Only',
      authProfileId: 'ap-a-only',
    });

    // Tenant B tries to read Tenant A's connection
    const crossTenantResult = await svc.getById(TENANT_B, PROJECT_P2, created._id);
    expect(crossTenantResult).toBeNull();

    // Tenant A can still read its own connection
    const ownResult = await svc.getById(TENANT_A, PROJECT_P1, created._id);
    expect(ownResult).not.toBeNull();
    expect(ownResult!.displayName).toBe('Tenant A Only');
  });

  // ── 3. update with wrong tenantId returns null ──────────────────────────

  it('update with wrong tenantId returns null and leaves original unchanged', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Create connection for Tenant A
    const created = await svc.create(TENANT_A, PROJECT_P1, {
      connectorName: 'test-connector',
      displayName: 'Original Name',
      authProfileId: 'ap-update',
    });

    // Tenant B attempts to update Tenant A's connection
    const updateResult = await svc.update(TENANT_B, PROJECT_P2, created._id, {
      displayName: 'hacked',
    });
    expect(updateResult).toBeNull();

    // Verify original is unchanged
    const original = await svc.getById(TENANT_A, PROJECT_P1, created._id);
    expect(original).not.toBeNull();
    expect(original!.displayName).toBe('Original Name');
  });

  // ── 4. delete with wrong tenantId returns false ─────────────────────────

  it('delete with wrong tenantId returns false and connection still exists', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Create connection for Tenant A
    const created = await svc.create(TENANT_A, PROJECT_P1, {
      connectorName: 'test-connector',
      displayName: 'Should Survive',
      authProfileId: 'ap-survive',
    });

    // Tenant B attempts to delete Tenant A's connection
    const deleteResult = await svc.delete(TENANT_B, PROJECT_P2, created._id);
    expect(deleteResult).toBe(false);

    // Verify connection still exists for Tenant A
    const stillExists = await svc.getById(TENANT_A, PROJECT_P1, created._id);
    expect(stillExists).not.toBeNull();
    expect(stillExists!.displayName).toBe('Should Survive');
  });

  // ── 5. getById with correct tenantId but wrong projectId returns null ───

  it('getById with correct tenantId but wrong projectId returns null', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Create connection for Tenant A, Project P1
    const created = await svc.create(TENANT_A, PROJECT_P1, {
      connectorName: 'test-connector',
      displayName: 'Project P1 Only',
      authProfileId: 'ap-p1',
    });

    // Same tenant, wrong project
    const wrongProject = await svc.getById(TENANT_A, 'wrong-project', created._id);
    expect(wrongProject).toBeNull();

    // Same tenant, correct project — should work
    const correctProject = await svc.getById(TENANT_A, PROJECT_P1, created._id);
    expect(correctProject).not.toBeNull();
    expect(correctProject!.displayName).toBe('Project P1 Only');
  });

  // ── 6. Concurrent create with identical scope fields per tenant ─────────

  it('concurrent create with identical scope fields succeeds separately per tenant', async ({
    skip,
  }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Two connections with same connectorName and scope, but different tenants
    const [connA, connB] = await Promise.all([
      svc.create(TENANT_A, PROJECT_P1, {
        connectorName: 'test-connector',
        displayName: 'Shared Name',
        scope: 'tenant',
        authProfileId: 'ap-shared-a',
      }),
      svc.create(TENANT_B, PROJECT_P2, {
        connectorName: 'test-connector',
        displayName: 'Shared Name',
        scope: 'tenant',
        authProfileId: 'ap-shared-b',
      }),
    ]);

    // Both should succeed with distinct IDs
    expect(connA._id).toBeDefined();
    expect(connB._id).toBeDefined();
    expect(connA._id).not.toBe(connB._id);

    // Each tenant sees only its own connection
    const listA = await svc.list(TENANT_A, PROJECT_P1);
    expect(listA).toHaveLength(1);
    expect(listA[0]._id).toBe(connA._id);

    const listB = await svc.list(TENANT_B, PROJECT_P2);
    expect(listB).toHaveLength(1);
    expect(listB[0]._id).toBe(connB._id);
  });
});
