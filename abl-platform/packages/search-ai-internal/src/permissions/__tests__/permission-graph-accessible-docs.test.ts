/**
 * Permission Graph - getAccessibleDocuments() Multi-Path Query Tests
 *
 * Tests for document authorization query with 4 access paths:
 * 1. Direct user permission: User → Document
 * 2. Group permission (recursive): User → Group → Document
 * 3. Domain-scoped public: User.domain matches Document → Domain
 * 4. Public everywhere: Document.publicEverywhere = true
 *
 * Performance target: <50ms for large document sets
 *
 * @see permission-graph-client.ts - getAccessibleDocuments()
 * @see neo4j-permission-schema.md - Query 2
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

describeIf('PermissionGraphClient - getAccessibleDocuments() Multi-Path Query', () => {
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
  // Path 1: Direct User Permission Tests
  // ==========================================================================

  describe('Path 1: Direct User Permission (User → Document)', () => {
    it('should return empty array for user with no permissions', async () => {
      // Create user with no permissions
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toEqual([]);
    });

    it('should return document with direct user permission', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Document 1',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Grant direct permission
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'alice@example.com',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toEqual(['doc-1']);
    });

    it('should return multiple documents with direct permissions', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create documents
      for (let i = 1; i <= 3; i++) {
        await client.upsertDocument({
          tenantId: testTenantId,
          documentId: `doc-${i}`,
          sourceId: 'connector-1',
          source: 'sharepoint',
          name: `Document ${i}`,
          publicInDomain: false,
          publicEverywhere: false,
        });

        await client.setPermission({
          tenantId: testTenantId,
          userEmail: 'alice@example.com',
          documentId: `doc-${i}`,
          role: 'read',
          source: 'sharepoint',
        });
      }

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toHaveLength(3);
      expect(docs).toContain('doc-1');
      expect(docs).toContain('doc-2');
      expect(docs).toContain('doc-3');
    });
  });

  // ==========================================================================
  // Path 2: Group Permission Tests (Recursive)
  // ==========================================================================

  describe('Path 2: Group Permission (User → Group → Document)', () => {
    it('should return document via direct group membership', async () => {
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

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Engineering Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Set membership: Alice → Engineering
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });

      // Grant group permission: Engineering → Doc
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toContain('doc-1');
    });

    it('should return document via nested group membership (2 levels)', async () => {
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

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Engineering Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Set memberships: Alice → DevTeam → Engineering
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

      // Grant permission: Engineering → Doc
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toContain('doc-1');
    });

    it('should return document via deep nested groups (5 levels)', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 5-level hierarchy
      const hierarchy = [
        'azuread:junior',
        'azuread:dev',
        'azuread:engineering',
        'azuread:rd',
        'azuread:all-staff',
      ];
      for (const groupId of hierarchy) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: 'azuread',
          displayName: groupId,
        });
      }

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Company Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Chain memberships: Alice → Junior → Dev → Eng → R&D → AllStaff
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

      // Grant permission: AllStaff → Doc
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:all-staff',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toContain('doc-1');
    });
  });

  // ==========================================================================
  // Path 3: Domain-Scoped Public Tests
  // ==========================================================================

  describe('Path 3: Public in Domain (Document → Domain)', () => {
    it('should return document public in user domain', async () => {
      // Create user with example.com domain
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Create document public in domain
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Company News',
        publicInDomain: true,
        publicEverywhere: false,
      });

      // Link document to domain
      await client.setPublicInDomain(testTenantId, 'doc-1', 'example.com');

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toContain('doc-1');
    });

    it('should NOT return document public in different domain', async () => {
      // Create user with example.com domain
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'other.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Create document public in other.com (not user's domain)
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Other Company Doc',
        publicInDomain: true,
        publicEverywhere: false,
      });

      await client.setPublicInDomain(testTenantId, 'doc-1', 'other.com');

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).not.toContain('doc-1');
    });

    it('should return multiple documents public in user domain', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Create 3 public documents
      for (let i = 1; i <= 3; i++) {
        await client.upsertDocument({
          tenantId: testTenantId,
          documentId: `doc-${i}`,
          sourceId: 'connector-1',
          source: 'sharepoint',
          name: `Public Doc ${i}`,
          publicInDomain: true,
          publicEverywhere: false,
        });

        await client.setPublicInDomain(testTenantId, `doc-${i}`, 'example.com');
      }

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toHaveLength(3);
      expect(docs).toContain('doc-1');
      expect(docs).toContain('doc-2');
      expect(docs).toContain('doc-3');
    });
  });

  // ==========================================================================
  // Path 4: Public Everywhere Tests
  // ==========================================================================

  describe('Path 4: Public Everywhere', () => {
    it('should return document marked public everywhere', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create public document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Public Announcement',
        publicInDomain: false,
        publicEverywhere: true,
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toContain('doc-1');
    });

    it('should return all public everywhere documents', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 5 public documents
      for (let i = 1; i <= 5; i++) {
        await client.upsertDocument({
          tenantId: testTenantId,
          documentId: `doc-${i}`,
          sourceId: 'connector-1',
          source: 'sharepoint',
          name: `Public Doc ${i}`,
          publicInDomain: false,
          publicEverywhere: true,
        });
      }

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toHaveLength(5);
      for (let i = 1; i <= 5; i++) {
        expect(docs).toContain(`doc-${i}`);
      }
    });
  });

  // ==========================================================================
  // Multi-Path Tests (Combined Access)
  // ==========================================================================

  describe('Multi-Path Access (All 4 Paths)', () => {
    it('should return documents accessible via any path', async () => {
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
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });

      // Create domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Path 1: Direct permission
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-direct',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Direct Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'alice@example.com',
        documentId: 'doc-direct',
        role: 'read',
        source: 'sharepoint',
      });

      // Path 2: Group permission
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-group',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Group Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        documentId: 'doc-group',
        role: 'read',
        source: 'sharepoint',
      });

      // Path 3: Public in domain
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-domain',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Domain Doc',
        publicInDomain: true,
        publicEverywhere: false,
      });
      await client.setPublicInDomain(testTenantId, 'doc-domain', 'example.com');

      // Path 4: Public everywhere
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-public',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Public Doc',
        publicInDomain: false,
        publicEverywhere: true,
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      expect(docs).toHaveLength(4);
      expect(docs).toContain('doc-direct');
      expect(docs).toContain('doc-group');
      expect(docs).toContain('doc-domain');
      expect(docs).toContain('doc-public');
    });

    it('should deduplicate documents accessible via multiple paths', async () => {
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
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@example.com',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Shared Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Grant access via Path 1 (direct) AND Path 2 (group)
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'alice@example.com',
        documentId: 'doc-1',
        role: 'owner',
        source: 'sharepoint',
      });
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');

      // Should only return doc once despite multiple access paths
      expect(docs).toEqual(['doc-1']);
    });
  });

  // ==========================================================================
  // Query Options Tests
  // ==========================================================================

  describe('Query Options', () => {
    it('should respect maxDepth option for group resolution', async () => {
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

      // Create documents
      for (let i = 0; i < hierarchy.length; i++) {
        await client.upsertDocument({
          tenantId: testTenantId,
          documentId: `doc-level-${i}`,
          sourceId: 'connector-1',
          source: 'sharepoint',
          name: `Doc Level ${i}`,
          publicInDomain: false,
          publicEverywhere: false,
        });

        await client.setPermission({
          tenantId: testTenantId,
          groupId: hierarchy[i],
          documentId: `doc-level-${i}`,
          role: 'read',
          source: 'sharepoint',
        });
      }

      // Chain memberships
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

      // Query with maxDepth=2 (should only resolve first 2 levels)
      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com', {
        maxDepth: 2,
      });

      expect(docs).toHaveLength(2);
      expect(docs).toContain('doc-level-0');
      expect(docs).toContain('doc-level-1');
      expect(docs).not.toContain('doc-level-2');
    });

    it('should respect limit option', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 10 public documents
      for (let i = 1; i <= 10; i++) {
        await client.upsertDocument({
          tenantId: testTenantId,
          documentId: `doc-${i}`,
          sourceId: 'connector-1',
          source: 'sharepoint',
          name: `Doc ${i}`,
          publicInDomain: false,
          publicEverywhere: true,
        });
      }

      // Query with limit=5
      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com', {
        limit: 5,
      });

      expect(docs.length).toBeLessThanOrEqual(5);
    });
  });

  // ==========================================================================
  // Tenant Isolation Tests
  // ==========================================================================

  describe('Tenant Isolation', () => {
    it('should not return documents from other tenants', async () => {
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

      // Create documents in both tenants
      await client.upsertDocument({
        tenantId: tenant1,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Tenant 1 Doc',
        publicInDomain: false,
        publicEverywhere: true,
      });
      await client.upsertDocument({
        tenantId: tenant2,
        documentId: 'doc-2',
        sourceId: 'connector-2',
        source: 'sharepoint',
        name: 'Tenant 2 Doc',
        publicInDomain: false,
        publicEverywhere: true,
      });

      // Query tenant 1 (should only return tenant 1 docs)
      const docs1 = await client.getAccessibleDocuments(tenant1, 'alice@example.com');
      expect(docs1).toEqual(['doc-1']);

      // Query tenant 2 (should only return tenant 2 docs)
      const docs2 = await client.getAccessibleDocuments(tenant2, 'alice@example.com');
      expect(docs2).toEqual(['doc-2']);

      // Cleanup
      await cleanupTestData(client, tenant1);
      await cleanupTestData(client, tenant2);
    });
  });

  // ==========================================================================
  // Performance Tests
  // ==========================================================================

  describe('Performance', () => {
    it('should query 1000 documents in <100ms', async () => {
      // Create user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice',
      });

      // Create 1000 public documents
      const batchSize = 100;
      for (let batch = 0; batch < 10; batch++) {
        for (let i = 0; i < batchSize; i++) {
          const docId = `doc-${batch * batchSize + i}`;
          await client.upsertDocument({
            tenantId: testTenantId,
            documentId: docId,
            sourceId: 'connector-1',
            source: 'sharepoint',
            name: docId,
            publicInDomain: false,
            publicEverywhere: true,
          });
        }
      }

      // Measure query performance
      const start = Date.now();
      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@example.com');
      const duration = Date.now() - start;

      expect(docs).toHaveLength(1000);
      expect(duration).toBeLessThan(100); // Target: <100ms
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
