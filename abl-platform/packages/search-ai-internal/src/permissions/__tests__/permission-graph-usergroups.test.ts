/**
 * Permission Graph - getUserGroups() Performance & Correctness Tests
 *
 * Tests for recursive group membership resolution:
 * - Performance targets: <10ms for 100 groups, <50ms for 1000 groups
 * - Cycle detection (prevent infinite loops)
 * - Depth limits (20 levels max)
 * - Nested group hierarchies
 * - Multi-source groups (IDP + connector groups)
 *
 * @see permission-graph-client.ts - getUserGroups()
 * @see neo4j-permission-schema.md - Query patterns
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PermissionGraphClient } from '../permission-graph-client.js';
import type { Neo4jConnectionConfig } from '../types.js';

// ============================================================================
// Test Configuration
// ============================================================================

const testConfig: Neo4jConnectionConfig = {
  uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
  username: process.env.NEO4J_USERNAME || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',
  database: process.env.NEO4J_DATABASE || 'neo4j',
};

// Skip tests if Neo4j is not available
const NEO4J_AVAILABLE = process.env.NEO4J_URI !== undefined;
const describeIf = NEO4J_AVAILABLE ? describe : describe.skip;

// ============================================================================
// Test Suite
// ============================================================================

describeIf('PermissionGraphClient - getUserGroups() Performance & Correctness', () => {
  let client: PermissionGraphClient;
  const testTenantId = `test-tenant-${Date.now()}`;

  beforeAll(async () => {
    client = new PermissionGraphClient(testConfig);

    // Verify connection
    const connected = await client.verifyConnection();
    if (!connected) {
      throw new Error('Neo4j connection failed - cannot run tests');
    }

    // Initialize schema
    await client.initializeSchema();
  });

  afterAll(async () => {
    // Cleanup test data
    await cleanupTestData(client, testTenantId);
    await client.close();
  });

  beforeEach(async () => {
    // Clean test data before each test
    await cleanupTestData(client, testTenantId);
  });

  // ==========================================================================
  // Basic Functionality Tests
  // ==========================================================================

  describe('Basic Group Membership', () => {
    it('should return empty array for user with no group memberships', async () => {
      // Create user with no groups
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toEqual([]);
    });

    it('should return direct group membership', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create group
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering',
      });

      // Set membership
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });

      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toEqual(['azuread:engineering']);
    });

    it('should return multiple direct group memberships', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create groups
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering',
      });
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:product',
        source: 'azuread',
        displayName: 'Product',
      });

      // Set memberships
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:product',
        source: 'azuread',
      });

      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toHaveLength(2);
      expect(groups).toContain('azuread:engineering');
      expect(groups).toContain('azuread:product');
    });
  });

  // ==========================================================================
  // Nested Group Tests
  // ==========================================================================

  describe('Nested Group Hierarchies', () => {
    it('should resolve 2-level nested groups', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create groups: DevTeam → Engineering
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:dev-team',
        source: 'azuread',
        displayName: 'Dev Team',
      });
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering',
      });

      // Set memberships: Alice → DevTeam, DevTeam → Engineering
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:dev-team',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:dev-team',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });

      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toHaveLength(2);
      expect(groups).toContain('azuread:dev-team');
      expect(groups).toContain('azuread:engineering');
    });

    it('should resolve 5-level nested groups', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 5-level hierarchy: Junior → Dev → Engineering → R&D → AllStaff
      const hierarchy = [
        'azuread:junior-devs',
        'azuread:dev-team',
        'azuread:engineering',
        'azuread:rd',
        'azuread:all-staff',
      ];

      for (const groupId of hierarchy) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: 'azuread',
          displayName: groupId.split(':')[1],
        });
      }

      // Set memberships: Alice → Junior
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: hierarchy[0],
        source: 'azuread',
      });

      // Chain groups: Junior → Dev → Engineering → R&D → AllStaff
      for (let i = 0; i < hierarchy.length - 1; i++) {
        await client.setMembership({
          tenantId: testTenantId,
          memberGroupId: hierarchy[i],
          parentGroupId: hierarchy[i + 1],
          source: 'azuread',
        });
      }

      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toHaveLength(5);
      hierarchy.forEach((groupId) => {
        expect(groups).toContain(groupId);
      });
    });

    it('should resolve diamond-shaped group hierarchies', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create diamond: Alice → [Frontend, Backend] → Engineering
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:frontend',
        source: 'azuread',
        displayName: 'Frontend',
      });
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:backend',
        source: 'azuread',
        displayName: 'Backend',
      });
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering',
      });

      // Set memberships
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:frontend',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:backend',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:frontend',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:backend',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });

      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toHaveLength(3);
      expect(groups).toContain('azuread:frontend');
      expect(groups).toContain('azuread:backend');
      expect(groups).toContain('azuread:engineering');
    });
  });

  // ==========================================================================
  // Cycle Detection Tests
  // ==========================================================================

  describe('Cycle Detection', () => {
    it('should handle simple cycle (A → B → A)', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create groups
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:group-a',
        source: 'azuread',
        displayName: 'Group A',
      });
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:group-b',
        source: 'azuread',
        displayName: 'Group B',
      });

      // Create cycle: Alice → A → B → A (cycle!)
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:group-a',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:group-a',
        parentGroupId: 'azuread:group-b',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:group-b',
        parentGroupId: 'azuread:group-a',
        source: 'azuread',
      });

      // Should not hang (cycle detection)
      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      // Should return both groups despite cycle
      expect(groups).toHaveLength(2);
      expect(groups).toContain('azuread:group-a');
      expect(groups).toContain('azuread:group-b');
    });

    it('should handle complex cycle (A → B → C → A)', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create groups
      const groups = ['azuread:group-a', 'azuread:group-b', 'azuread:group-c'];
      for (const groupId of groups) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: 'azuread',
          displayName: groupId.split(':')[1],
        });
      }

      // Create cycle: Alice → A → B → C → A (cycle!)
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: groups[0],
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: groups[0],
        parentGroupId: groups[1],
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: groups[1],
        parentGroupId: groups[2],
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: groups[2],
        parentGroupId: groups[0],
        source: 'azuread',
      });

      // Should not hang
      const result = await client.getUserGroups(testTenantId, 'alice@example.com');

      // Should return all groups despite cycle
      expect(result).toHaveLength(3);
      groups.forEach((groupId) => {
        expect(result).toContain(groupId);
      });
    });
  });

  // ==========================================================================
  // Depth Limit Tests
  // ==========================================================================

  describe('Depth Limits', () => {
    it('should enforce maxDepth parameter', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 5-level hierarchy
      const hierarchy = Array.from({ length: 5 }, (_, i) => `azuread:level-${i}`);
      for (const groupId of hierarchy) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: 'azuread',
          displayName: groupId,
        });
      }

      // Chain groups
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: hierarchy[0],
        source: 'azuread',
      });
      for (let i = 0; i < hierarchy.length - 1; i++) {
        await client.setMembership({
          tenantId: testTenantId,
          memberGroupId: hierarchy[i],
          parentGroupId: hierarchy[i + 1],
          source: 'azuread',
        });
      }

      // Query with maxDepth=3 (should only return first 3 levels)
      const groups = await client.getUserGroups(testTenantId, 'alice@example.com', 3);

      expect(groups).toHaveLength(3);
      expect(groups).toContain('azuread:level-0');
      expect(groups).toContain('azuread:level-1');
      expect(groups).toContain('azuread:level-2');
      expect(groups).not.toContain('azuread:level-3');
      expect(groups).not.toContain('azuread:level-4');
    });

    it('should use default maxDepth (20) when not specified', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 10-level hierarchy (well under default 20)
      const hierarchy = Array.from({ length: 10 }, (_, i) => `azuread:level-${i}`);
      for (const groupId of hierarchy) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: 'azuread',
          displayName: groupId,
        });
      }

      // Chain groups
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: hierarchy[0],
        source: 'azuread',
      });
      for (let i = 0; i < hierarchy.length - 1; i++) {
        await client.setMembership({
          tenantId: testTenantId,
          memberGroupId: hierarchy[i],
          parentGroupId: hierarchy[i + 1],
          source: 'azuread',
        });
      }

      // Query without maxDepth (should use default 20)
      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toHaveLength(10);
      hierarchy.forEach((groupId) => {
        expect(groups).toContain(groupId);
      });
    });
  });

  // ==========================================================================
  // Multi-Source Tests
  // ==========================================================================

  describe('Multi-Source Groups', () => {
    it('should resolve groups from different sources (IDP + connectors)', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create groups from different sources
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering (IDP)',
      });
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'sharepoint:site-owners',
        source: 'sharepoint',
        displayName: 'Site Owners (SharePoint)',
      });

      // Set memberships
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'sharepoint:site-owners',
        source: 'sharepoint',
      });

      const groups = await client.getUserGroups(testTenantId, 'alice@example.com');

      expect(groups).toHaveLength(2);
      expect(groups).toContain('azuread:engineering');
      expect(groups).toContain('sharepoint:site-owners');
    });
  });

  // ==========================================================================
  // Tenant Isolation Tests
  // ==========================================================================

  describe('Tenant Isolation', () => {
    it('should not return groups from other tenants', async () => {
      const tenant1 = `${testTenantId}-1`;
      const tenant2 = `${testTenantId}-2`;

      // Create same user in both tenants
      await client.upsertUser({
        tenantId: tenant1,
        email: 'alice@example.com',
        displayName: 'Alice Tenant 1',
      });
      await client.upsertUser({
        tenantId: tenant2,
        email: 'alice@example.com',
        displayName: 'Alice Tenant 2',
      });

      // Create groups in both tenants
      await client.upsertGroup({
        tenantId: tenant1,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering Tenant 1',
      });
      await client.upsertGroup({
        tenantId: tenant2,
        groupId: 'azuread:product',
        source: 'azuread',
        displayName: 'Product Tenant 2',
      });

      // Set memberships
      await client.setMembership({
        tenantId: tenant1,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });
      await client.setMembership({
        tenantId: tenant2,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:product',
        source: 'azuread',
      });

      // Query tenant 1 (should only return tenant 1 groups)
      const groups1 = await client.getUserGroups(tenant1, 'alice@example.com');
      expect(groups1).toEqual(['azuread:engineering']);

      // Query tenant 2 (should only return tenant 2 groups)
      const groups2 = await client.getUserGroups(tenant2, 'alice@example.com');
      expect(groups2).toEqual(['azuread:product']);

      // Cleanup
      await cleanupTestData(client, tenant1);
      await cleanupTestData(client, tenant2);
    });
  });

  // ==========================================================================
  // Performance Tests
  // ==========================================================================

  describe('Performance', () => {
    it('should resolve 100 groups in <50ms', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 100 groups
      const groups = Array.from({ length: 100 }, (_, i) => `azuread:group-${i}`);
      for (const groupId of groups) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: 'azuread',
          displayName: groupId,
        });
      }

      // Add user to all groups (direct membership)
      for (const groupId of groups) {
        await client.setMembership({
          tenantId: testTenantId,
          memberEmail: 'alice@example.com',
          parentGroupId: groupId,
          source: 'azuread',
        });
      }

      // Measure query performance
      const start = Date.now();
      const result = await client.getUserGroups(testTenantId, 'alice@example.com');
      const duration = Date.now() - start;

      expect(result).toHaveLength(100);
      expect(duration).toBeLessThan(50); // Target: <50ms for 100 groups
    }, 10000); // 10s timeout for setup

    it('should resolve 1000 groups in <100ms', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 1000 groups in batches
      const totalGroups = 1000;
      const batchSize = 100;
      for (let batch = 0; batch < totalGroups / batchSize; batch++) {
        const batchGroups = Array.from(
          { length: batchSize },
          (_, i) => `azuread:group-${batch * batchSize + i}`,
        );

        for (const groupId of batchGroups) {
          await client.upsertGroup({
            tenantId: testTenantId,
            groupId,
            source: 'azuread',
            displayName: groupId,
          });
        }

        for (const groupId of batchGroups) {
          await client.setMembership({
            tenantId: testTenantId,
            memberEmail: 'alice@example.com',
            parentGroupId: groupId,
            source: 'azuread',
          });
        }
      }

      // Measure query performance
      const start = Date.now();
      const result = await client.getUserGroups(testTenantId, 'alice@example.com');
      const duration = Date.now() - start;

      expect(result).toHaveLength(1000);
      expect(duration).toBeLessThan(100); // Target: <100ms for 1000 groups
    }, 60000); // 60s timeout for setup
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Cleanup all test data for a tenant
 */
async function cleanupTestData(client: PermissionGraphClient, tenantId: string): Promise<void> {
  const session = (client as any).getSession();
  try {
    await session.run(
      `
      MATCH (n {tenantId: $tenantId})
      DETACH DELETE n
      `,
      { tenantId },
    );
  } catch (error) {
    console.error('Cleanup failed:', error);
  } finally {
    await session.close();
  }
}
