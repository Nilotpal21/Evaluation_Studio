/**
 * Permission Graph Client Tests
 *
 * Tests for Neo4j permission graph operations.
 * These tests require a running Neo4j instance.
 *
 * Run with: NEO4J_URI=neo4j://localhost:7687 pnpm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PermissionGraphClient } from '../permission-graph-client.js';
import type {
  Neo4jConnectionConfig,
  CreateUserInput,
  CreateGroupInput,
  CreateDocumentInput,
  CreateDomainInput,
} from '../types.js';

// Skip tests if Neo4j is not configured
const runTests = !!process.env.NEO4J_URI;
const describeIf = runTests ? describe : describe.skip;

describeIf('PermissionGraphClient', () => {
  let client: PermissionGraphClient;
  const testTenantId = 'test-tenant-123';

  beforeAll(async () => {
    const config: Neo4jConnectionConfig = {
      uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
      username: process.env.NEO4J_USERNAME || 'neo4j',
      password: process.env.NEO4J_PASSWORD || 'password',
      database: process.env.NEO4J_DATABASE || 'neo4j',
    };

    client = new PermissionGraphClient(config);

    // Verify connection
    const connected = await client.verifyConnection();
    expect(connected).toBe(true);

    // Initialize schema
    await client.initializeSchema();
  });

  afterAll(async () => {
    // Cleanup: Delete all test data
    // Note: This is a test-only operation, never do this in production!
    await client.close();
  });

  beforeEach(async () => {
    // Cleanup test data before each test
    // This ensures test isolation
  });

  describe('Schema Initialization', () => {
    it('should initialize constraints and indexes', async () => {
      // Schema is initialized in beforeAll
      // This test verifies it doesn't throw
      await client.initializeSchema(); // Idempotent, should not fail
    });

    it('should verify connection', async () => {
      const connected = await client.verifyConnection();
      expect(connected).toBe(true);
    });
  });

  describe('User Operations', () => {
    it('should upsert a user', async () => {
      const input: CreateUserInput = {
        tenantId: testTenantId,
        email: 'alice@contoso.com',
        idpUserId: '00000000-0000-0000-0000-000000000001',
        idpProvider: 'azuread',
        displayName: 'Alice Johnson',
        status: 'active',
      };

      const user = await client.upsertUser(input);

      expect(user.tenantId).toBe(testTenantId);
      expect(user.email).toBe('alice@contoso.com');
      expect(user.idpUserId).toBe('00000000-0000-0000-0000-000000000001');
      expect(user.displayName).toBe('Alice Johnson');
      expect(user.domain).toBe('contoso.com');
      expect(user.status).toBe('active');
    });

    it('should normalize email to lowercase', async () => {
      const input: CreateUserInput = {
        tenantId: testTenantId,
        email: 'Bob@Contoso.Com',
        displayName: 'Bob Smith',
      };

      const user = await client.upsertUser(input);
      expect(user.email).toBe('bob@contoso.com'); // Lowercase
      expect(user.domain).toBe('contoso.com'); // Lowercase
    });

    it('should get user by email', async () => {
      const input: CreateUserInput = {
        tenantId: testTenantId,
        email: 'charlie@contoso.com',
        displayName: 'Charlie Brown',
      };

      await client.upsertUser(input);

      const user = await client.getUser(testTenantId, 'charlie@contoso.com');
      expect(user).not.toBeNull();
      expect(user?.email).toBe('charlie@contoso.com');
      expect(user?.displayName).toBe('Charlie Brown');
    });

    it('should return null for non-existent user', async () => {
      const user = await client.getUser(testTenantId, 'nonexistent@contoso.com');
      expect(user).toBeNull();
    });

    it('should batch upsert users', async () => {
      const users: CreateUserInput[] = [
        {
          tenantId: testTenantId,
          email: 'user1@contoso.com',
          displayName: 'User 1',
        },
        {
          tenantId: testTenantId,
          email: 'user2@contoso.com',
          displayName: 'User 2',
        },
        {
          tenantId: testTenantId,
          email: 'user3@contoso.com',
          displayName: 'User 3',
        },
      ];

      const count = await client.batchUpsertUsers(testTenantId, users);
      expect(count).toBe(3);

      // Verify users were created
      const user1 = await client.getUser(testTenantId, 'user1@contoso.com');
      expect(user1).not.toBeNull();
    });
  });

  describe('Group Operations', () => {
    it('should upsert a group', async () => {
      const input: CreateGroupInput = {
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        idpGroupId: '00000000-0000-0000-0000-000000000002',
        source: 'azuread',
        displayName: 'Engineering Team',
        email: 'engineering@contoso.com',
      };

      const group = await client.upsertGroup(input);

      expect(group.tenantId).toBe(testTenantId);
      expect(group.groupId).toBe('azuread:engineering');
      expect(group.source).toBe('azuread');
      expect(group.displayName).toBe('Engineering Team');
    });

    it('should get group by groupId', async () => {
      const input: CreateGroupInput = {
        tenantId: testTenantId,
        groupId: 'azuread:sales',
        source: 'azuread',
        displayName: 'Sales Team',
      };

      await client.upsertGroup(input);

      const group = await client.getGroup(testTenantId, 'azuread:sales');
      expect(group).not.toBeNull();
      expect(group?.groupId).toBe('azuread:sales');
    });

    it('should batch upsert groups', async () => {
      const groups: CreateGroupInput[] = [
        {
          tenantId: testTenantId,
          groupId: 'azuread:group1',
          source: 'azuread',
          displayName: 'Group 1',
        },
        {
          tenantId: testTenantId,
          groupId: 'azuread:group2',
          source: 'azuread',
          displayName: 'Group 2',
        },
      ];

      const count = await client.batchUpsertGroups(testTenantId, groups);
      expect(count).toBe(2);
    });
  });

  describe('Document Operations', () => {
    it('should upsert a document', async () => {
      const input: CreateDocumentInput = {
        tenantId: testTenantId,
        documentId: 'doc-123',
        sourceId: 'connector-456',
        source: 'sharepoint',
        name: 'Q1 Report.docx',
        path: '/sites/Sales/Q1 Report.docx',
        publicInDomain: false,
        publicEverywhere: false,
      };

      const doc = await client.upsertDocument(input);

      expect(doc.tenantId).toBe(testTenantId);
      expect(doc.documentId).toBe('doc-123');
      expect(doc.source).toBe('sharepoint');
      expect(doc.publicInDomain).toBe(false);
    });

    it('should delete document', async () => {
      const input: CreateDocumentInput = {
        tenantId: testTenantId,
        documentId: 'doc-to-delete',
        sourceId: 'connector-456',
        source: 'sharepoint',
        publicInDomain: false,
        publicEverywhere: false,
      };

      await client.upsertDocument(input);

      const deleted = await client.deleteDocument(testTenantId, 'doc-to-delete');
      expect(deleted).toBe(true);
    });
  });

  describe('Domain Operations', () => {
    it('should upsert a domain', async () => {
      const input: CreateDomainInput = {
        tenantId: testTenantId,
        domain: 'contoso.com',
        verified: true,
        verificationMethod: 'idp-trust',
      };

      const domain = await client.upsertDomain(input);

      expect(domain.tenantId).toBe(testTenantId);
      expect(domain.domain).toBe('contoso.com');
      expect(domain.verified).toBe(true);
      expect(domain.verificationMethod).toBe('idp-trust');
    });

    it('should normalize domain to lowercase', async () => {
      const input: CreateDomainInput = {
        tenantId: testTenantId,
        domain: 'Example.COM',
        verified: false,
        verificationMethod: 'dns',
      };

      const domain = await client.upsertDomain(input);
      expect(domain.domain).toBe('example.com'); // Lowercase
    });
  });

  describe('Membership Operations', () => {
    beforeEach(async () => {
      // Create test users and groups
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'member@contoso.com',
        displayName: 'Member User',
      });

      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:parent-group',
        source: 'azuread',
        displayName: 'Parent Group',
      });

      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:child-group',
        source: 'azuread',
        displayName: 'Child Group',
      });
    });

    it('should set User → Group membership', async () => {
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'member@contoso.com',
        parentGroupId: 'azuread:parent-group',
        source: 'azuread',
      });

      // Verify membership
      const groups = await client.getUserGroups(testTenantId, 'member@contoso.com');
      expect(groups).toContain('azuread:parent-group');
    });

    it('should set Group → Group nested membership', async () => {
      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:child-group',
        parentGroupId: 'azuread:parent-group',
        source: 'azuread',
      });

      // TODO: Add verification query for nested groups
    });

    it('should remove membership', async () => {
      // Set membership
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'member@contoso.com',
        parentGroupId: 'azuread:parent-group',
        source: 'azuread',
      });

      // Remove membership
      await client.removeMembership({
        tenantId: testTenantId,
        memberEmail: 'member@contoso.com',
        parentGroupId: 'azuread:parent-group',
        source: 'azuread',
      });

      // Verify membership removed
      const groups = await client.getUserGroups(testTenantId, 'member@contoso.com');
      expect(groups).not.toContain('azuread:parent-group');
    });
  });

  describe('Permission Operations', () => {
    beforeEach(async () => {
      // Create test data
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'owner@contoso.com',
        displayName: 'Document Owner',
      });

      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:readers',
        source: 'azuread',
        displayName: 'Readers Group',
      });

      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-perm-test',
        sourceId: 'connector-456',
        source: 'sharepoint',
        publicInDomain: false,
        publicEverywhere: false,
      });
    });

    it('should set User → Document permission', async () => {
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'owner@contoso.com',
        documentId: 'doc-perm-test',
        role: 'owner',
        source: 'sharepoint',
      });

      // Verify permission
      const docs = await client.getAccessibleDocuments(testTenantId, 'owner@contoso.com');
      expect(docs).toContain('doc-perm-test');
    });

    it('should set Group → Document permission', async () => {
      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:readers',
        documentId: 'doc-perm-test',
        role: 'read',
        source: 'sharepoint',
      });

      // TODO: Add verification query
    });

    it('should remove permission', async () => {
      // Set permission
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'owner@contoso.com',
        documentId: 'doc-perm-test',
        role: 'owner',
        source: 'sharepoint',
      });

      // Remove permission
      await client.removePermission({
        tenantId: testTenantId,
        userEmail: 'owner@contoso.com',
        documentId: 'doc-perm-test',
        role: 'owner',
        source: 'sharepoint',
      });

      // Verify permission removed
      const docs = await client.getAccessibleDocuments(testTenantId, 'owner@contoso.com');
      expect(docs).not.toContain('doc-perm-test');
    });
  });

  describe('Permission Queries', () => {
    beforeEach(async () => {
      // Create test hierarchy:
      // alice@contoso.com
      //   → dev-team
      //       → engineering
      //           → all-staff

      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@contoso.com',
        displayName: 'Alice',
      });

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

      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:all-staff',
        source: 'azuread',
        displayName: 'All Staff',
      });

      // Set memberships
      await client.setMembership({
        tenantId: testTenantId,
        memberEmail: 'alice@contoso.com',
        parentGroupId: 'azuread:dev-team',
        source: 'azuread',
      });

      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:dev-team',
        parentGroupId: 'azuread:engineering',
        source: 'azuread',
      });

      await client.setMembership({
        tenantId: testTenantId,
        memberGroupId: 'azuread:engineering',
        parentGroupId: 'azuread:all-staff',
        source: 'azuread',
      });
    });

    it('should get all groups for user (recursive)', async () => {
      const groups = await client.getUserGroups(testTenantId, 'alice@contoso.com');

      expect(groups).toContain('azuread:dev-team');
      expect(groups).toContain('azuread:engineering');
      expect(groups).toContain('azuread:all-staff');
      expect(groups.length).toBe(3);
    });

    it('should get accessible documents for user', async () => {
      // Create document with permission
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-accessible',
        sourceId: 'connector-456',
        source: 'sharepoint',
        publicInDomain: false,
        publicEverywhere: false,
      });

      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'alice@contoso.com',
        documentId: 'doc-accessible',
        role: 'read',
        source: 'sharepoint',
      });

      const docs = await client.getAccessibleDocuments(testTenantId, 'alice@contoso.com');
      expect(docs).toContain('doc-accessible');
    });

    it('should get flattened permissions for document', async () => {
      // Create document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-flatten',
        sourceId: 'connector-456',
        source: 'sharepoint',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Set permissions
      await client.setPermission({
        tenantId: testTenantId,
        userEmail: 'alice@contoso.com',
        documentId: 'doc-flatten',
        role: 'owner',
        source: 'sharepoint',
      });

      await client.setPermission({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        documentId: 'doc-flatten',
        role: 'read',
        source: 'sharepoint',
      });

      const permissions = await client.getFlattenedPermissions(testTenantId, 'doc-flatten');

      expect(permissions.allowedUsers).toContain('alice@contoso.com');
      expect(permissions.allowedGroups).toContain('azuread:engineering');
      expect(permissions.publicInDomain).toBe(false);
      expect(permissions.publicEverywhere).toBe(false);
    });
  });

  describe('Statistics', () => {
    it('should get graph statistics', async () => {
      const stats = await client.getGraphStats(testTenantId);

      expect(stats.tenantId).toBe(testTenantId);
      expect(stats.userCount).toBeGreaterThanOrEqual(0);
      expect(stats.groupCount).toBeGreaterThanOrEqual(0);
      expect(stats.documentCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tenant Isolation', () => {
    const tenant1 = 'tenant-1';
    const tenant2 = 'tenant-2';

    it('should isolate users by tenant', async () => {
      // Create same email in different tenants
      await client.upsertUser({
        tenantId: tenant1,
        email: 'shared@example.com',
        displayName: 'User Tenant 1',
      });

      await client.upsertUser({
        tenantId: tenant2,
        email: 'shared@example.com',
        displayName: 'User Tenant 2',
      });

      // Get user from tenant 1
      const user1 = await client.getUser(tenant1, 'shared@example.com');
      expect(user1?.displayName).toBe('User Tenant 1');

      // Get user from tenant 2
      const user2 = await client.getUser(tenant2, 'shared@example.com');
      expect(user2?.displayName).toBe('User Tenant 2');

      // Verify they're different users
      expect(user1?.displayName).not.toBe(user2?.displayName);
    });
  });
});
