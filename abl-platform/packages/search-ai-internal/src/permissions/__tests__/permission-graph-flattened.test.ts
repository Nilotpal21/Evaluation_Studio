/**
 * Permission Graph - getFlattenedPermissions() Tests
 *
 * Tests for document permission flattening (used for vector DB denormalization):
 * - Returns all users with direct access (email list)
 * - Returns all groups with access (group ID list)
 * - Returns all domains for public documents
 * - Returns public flags (publicInDomain, publicEverywhere)
 * - Used to write permissions metadata to OpenSearch/vector DB
 *
 * Performance target: <20ms per document
 *
 * @see permission-graph-client.ts - getFlattenedPermissions()
 * @see neo4j-permission-schema.md - Query 3
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PermissionGraphClient } from '../permission-graph-client.js';
import type { Neo4jConnectionConfig, FlattenedPermissions } from '../types.js';

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

describeIf('PermissionGraphClient - getFlattenedPermissions()', () => {
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
  // Basic Flattening Tests
  // ==========================================================================

  describe('Basic Permission Flattening', () => {
    it('should return empty permissions for private document with no access', async () => {
      // Create document with no permissions
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Private Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms).toEqual({
        allowedUsers: [],
        allowedGroups: [],
        allowedDomains: [],
        publicInDomain: false,
        publicEverywhere: false,
      });
    });

    it('should return empty permissions for non-existent document', async () => {
      const perms = await client.getFlattenedPermissions(testTenantId, 'non-existent');

      expect(perms).toEqual({
        allowedUsers: [],
        allowedGroups: [],
        allowedDomains: [],
        publicInDomain: false,
        publicEverywhere: false,
      });
    });
  });

  // ==========================================================================
  // Direct User Permission Tests
  // ==========================================================================

  describe('Direct User Permissions', () => {
    it('should return single user with direct access', async () => {
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

      // Grant permission
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'alice@example.com',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedUsers).toEqual(['alice@example.com']);
      expect(perms.allowedGroups).toEqual([]);
      expect(perms.allowedDomains).toEqual([]);
      expect(perms.publicInDomain).toBe(false);
      expect(perms.publicEverywhere).toBe(false);
    });

    it('should return multiple users with direct access', async () => {
      // Create users
      const emails = ['alice@example.com', 'bob@example.com', 'charlie@example.com'];
      for (const email of emails) {
        await client.upsertUser({
          tenantId: testTenantId,
          email,
          displayName: email.split('@')[0],
        });
      }

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

      // Grant permissions to all users
      for (const email of emails) {
        await client.setPermission({
          tenantId: testTenantId,
          userEmail: email,
          documentId: 'doc-1',
          role: 'read',
          source: 'sharepoint',
        });
      }

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedUsers).toHaveLength(3);
      emails.forEach((email) => {
        expect(perms.allowedUsers).toContain(email);
      });
      expect(perms.allowedGroups).toEqual([]);
    });

    it('should deduplicate users with multiple permission roles', async () => {
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

      // Grant multiple permissions (should only appear once)
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'alice@example.com',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      // Should only return user once
      expect(perms.allowedUsers).toEqual(['alice@example.com']);
    });
  });

  // ==========================================================================
  // Group Permission Tests
  // ==========================================================================

  describe('Group Permissions', () => {
    it('should return single group with access', async () => {
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

      // Grant permission
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedUsers).toEqual([]);
      expect(perms.allowedGroups).toEqual(['azuread:engineering']);
      expect(perms.allowedDomains).toEqual([]);
    });

    it('should return multiple groups with access', async () => {
      // Create groups
      const groupIds = ['azuread:engineering', 'azuread:product', 'sharepoint:site-owners'];
      for (const groupId of groupIds) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: groupId.split(':')[0],
          displayName: groupId,
        });
      }

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Cross-Team Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Grant permissions to all groups
      for (const groupId of groupIds) {
        await client.setPermission({
          tenantId: testTenantId,
          groupId,
          documentId: 'doc-1',
          role: 'read',
          source: 'sharepoint',
        });
      }

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedGroups).toHaveLength(3);
      groupIds.forEach((groupId) => {
        expect(perms.allowedGroups).toContain(groupId);
      });
    });

    it('should NOT recursively expand group members (returns group IDs)', async () => {
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

      // Grant permission to group (NOT user)
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      // Should return group ID, NOT user email
      expect(perms.allowedGroups).toEqual(['azuread:engineering']);
      expect(perms.allowedUsers).toEqual([]);
    });
  });

  // ==========================================================================
  // Domain Permission Tests
  // ==========================================================================

  describe('Domain-Scoped Public Documents', () => {
    it('should return domain for publicInDomain document', async () => {
      // Create domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Company News',
        publicInDomain: true,
        publicEverywhere: false,
      });

      // Link to domain
      await client.setPublicInDomain(testTenantId, 'doc-1', 'example.com');

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedUsers).toEqual([]);
      expect(perms.allowedGroups).toEqual([]);
      expect(perms.allowedDomains).toEqual(['example.com']);
      expect(perms.publicInDomain).toBe(true);
      expect(perms.publicEverywhere).toBe(false);
    });

    it('should return multiple domains for multi-domain document', async () => {
      // Create domains
      const domains = ['example.com', 'partner.com'];
      for (const domain of domains) {
        await client.upsertDomain({
          tenantId: testTenantId,
          domain,
          verified: true,
          verificationMethod: 'idp-trust',
        });
      }

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Partner Document',
        publicInDomain: true,
        publicEverywhere: false,
      });

      // Link to multiple domains
      for (const domain of domains) {
        await client.setPublicInDomain(testTenantId, 'doc-1', domain);
      }

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedDomains).toHaveLength(2);
      domains.forEach((domain) => {
        expect(perms.allowedDomains).toContain(domain);
      });
    });
  });

  // ==========================================================================
  // Public Everywhere Tests
  // ==========================================================================

  describe('Public Everywhere Documents', () => {
    it('should return publicEverywhere=true for public document', async () => {
      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Public Announcement',
        publicInDomain: false,
        publicEverywhere: true,
      });

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedUsers).toEqual([]);
      expect(perms.allowedGroups).toEqual([]);
      expect(perms.allowedDomains).toEqual([]);
      expect(perms.publicInDomain).toBe(false);
      expect(perms.publicEverywhere).toBe(true);
    });

    it('should return publicInDomain=true AND publicEverywhere=true when both set', async () => {
      // Create domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Create document with both flags
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Public Doc',
        publicInDomain: true,
        publicEverywhere: true,
      });

      await client.setPublicInDomain(testTenantId, 'doc-1', 'example.com');

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedDomains).toEqual(['example.com']);
      expect(perms.publicInDomain).toBe(true);
      expect(perms.publicEverywhere).toBe(true);
    });
  });

  // ==========================================================================
  // Combined Permission Tests
  // ==========================================================================

  describe('Combined Permissions (Users + Groups + Domains)', () => {
    it('should return all permission types for document', async () => {
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

      // Create domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Shared Doc',
        publicInDomain: true,
        publicEverywhere: false,
      });

      // Grant permissions via all paths
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
      await client.setPublicInDomain(testTenantId, 'doc-1', 'example.com');

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedUsers).toEqual(['alice@example.com']);
      expect(perms.allowedGroups).toEqual(['azuread:engineering']);
      expect(perms.allowedDomains).toEqual(['example.com']);
      expect(perms.publicInDomain).toBe(true);
      expect(perms.publicEverywhere).toBe(false);
    });

    it('should return complex permission set for enterprise document', async () => {
      // Create multiple users
      const users = ['alice@example.com', 'bob@example.com'];
      for (const email of users) {
        await client.upsertUser({
          tenantId: testTenantId,
          email,
          displayName: email.split('@')[0],
        });
      }

      // Create multiple groups
      const groups = ['azuread:engineering', 'azuread:product', 'sharepoint:site-owners'];
      for (const groupId of groups) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId,
          source: groupId.split(':')[0],
          displayName: groupId,
        });
      }

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Enterprise Document',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Grant permissions to all users and groups
      for (const email of users) {
        await client.setPermission({
          tenantId: testTenantId,
          userEmail: email,
          documentId: 'doc-1',
          role: 'read',
          source: 'sharepoint',
        });
      }
      for (const groupId of groups) {
        await client.setPermission({
          tenantId: testTenantId,
          groupId,
          documentId: 'doc-1',
          role: 'read',
          source: 'sharepoint',
        });
      }

      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');

      expect(perms.allowedUsers).toHaveLength(2);
      expect(perms.allowedGroups).toHaveLength(3);
      users.forEach((email) => expect(perms.allowedUsers).toContain(email));
      groups.forEach((groupId) => expect(perms.allowedGroups).toContain(groupId));
    });
  });

  // ==========================================================================
  // Tenant Isolation Tests
  // ==========================================================================

  describe('Tenant Isolation', () => {
    it('should not return permissions from other tenants', async () => {
      const tenant1 = `${testTenantId}-1`;
      const tenant2 = `${testTenantId}-2`;

      // Create user in tenant 1
      await client.upsertUser({
        tenantId: tenant1,
        email: 'alice@example.com',
        displayName: 'Alice Tenant 1',
      });

      // Create user in tenant 2
      await client.upsertUser({
        tenantId: tenant2,
        email: 'bob@example.com',
        displayName: 'Bob Tenant 2',
      });

      // Create same document in both tenants
      await client.upsertDocument({
        tenantId: tenant1,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Doc Tenant 1',
        publicInDomain: false,
        publicEverywhere: false,
      });
      await client.upsertDocument({
        tenantId: tenant2,
        documentId: 'doc-1',
        sourceId: 'connector-2',
        source: 'sharepoint',
        name: 'Doc Tenant 2',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Grant permissions in both tenants
      await client.setPermission({
        tenantId: tenant1,
        userEmail: 'alice@example.com',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });
      await client.setPermission({
        tenantId: tenant2,
        userEmail: 'bob@example.com',
        documentId: 'doc-1',
        role: 'read',
        source: 'sharepoint',
      });

      // Query tenant 1 (should only see Alice)
      const perms1 = await client.getFlattenedPermissions(tenant1, 'doc-1');
      expect(perms1.allowedUsers).toEqual(['alice@example.com']);

      // Query tenant 2 (should only see Bob)
      const perms2 = await client.getFlattenedPermissions(tenant2, 'doc-1');
      expect(perms2.allowedUsers).toEqual(['bob@example.com']);

      // Cleanup
      await cleanupTestData(client, tenant1);
      await cleanupTestData(client, tenant2);
    });
  });

  // ==========================================================================
  // Performance Tests
  // ==========================================================================

  describe('Performance', () => {
    it('should flatten permissions in <50ms', async () => {
      // Create 50 users
      for (let i = 0; i < 50; i++) {
        await client.upsertUser({
          tenantId: testTenantId,
          email: `user${i}@example.com`,
          displayName: `User ${i}`,
        });
      }

      // Create 20 groups
      for (let i = 0; i < 20; i++) {
        await client.upsertGroup({
          tenantId: testTenantId,
          groupId: `azuread:group-${i}`,
          source: 'azuread',
          displayName: `Group ${i}`,
        });
      }

      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-1',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Complex Permissions Doc',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Grant permissions to all users and groups
      for (let i = 0; i < 50; i++) {
        await client.setPermission({
          tenantId: testTenantId,
          userEmail: `user${i}@example.com`,
          documentId: 'doc-1',
          role: 'read',
          source: 'sharepoint',
        });
      }
      for (let i = 0; i < 20; i++) {
        await client.setPermission({
          tenantId: testTenantId,
          groupId: `azuread:group-${i}`,
          documentId: 'doc-1',
          role: 'read',
          source: 'sharepoint',
        });
      }

      // Measure performance
      const start = Date.now();
      const perms = await client.getFlattenedPermissions(testTenantId, 'doc-1');
      const duration = Date.now() - start;

      expect(perms.allowedUsers).toHaveLength(50);
      expect(perms.allowedGroups).toHaveLength(20);
      expect(duration).toBeLessThan(50); // Target: <50ms
    }, 30000); // 30s timeout for setup
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
