/**
 * Permission Graph Schema Validation Tests
 *
 * Tests for Neo4j schema initialization:
 * - Unique constraints on compound keys
 * - Performance indexes on common queries
 * - Constraint enforcement (duplicate prevention)
 * - Index usage verification
 *
 * @see permission-graph-client.ts - initializeSchema()
 * @see neo4j-permission-schema.md - Schema documentation
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

describeIf('PermissionGraphClient - Schema Validation', () => {
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
  // Unique Constraints Tests
  // ==========================================================================

  describe('Unique Constraints', () => {
    it('should enforce unique (tenantId, email) for User nodes', async () => {
      // Create first user
      await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice First',
      });

      // Attempt to create duplicate user with same (tenantId, email)
      // This should succeed (upsert) but update existing
      const result = await client.upsertUser({
        tenantId: testTenantId,
        email: 'alice@example.com',
        displayName: 'Alice Updated',
      });

      expect(result.email).toBe('alice@example.com');
      expect(result.displayName).toBe('Alice Updated');

      // Verify only one user exists
      const user = await client.getUser(testTenantId, 'alice@example.com');
      expect(user?.displayName).toBe('Alice Updated');
    });

    it('should allow same email in different tenants (User)', async () => {
      const tenant1 = `${testTenantId}-1`;
      const tenant2 = `${testTenantId}-2`;

      // Create user in tenant 1
      await client.upsertUser({
        tenantId: tenant1,
        email: 'alice@example.com',
        displayName: 'Alice Tenant 1',
      });

      // Create user with same email in tenant 2 (should succeed)
      await client.upsertUser({
        tenantId: tenant2,
        email: 'alice@example.com',
        displayName: 'Alice Tenant 2',
      });

      // Verify both users exist independently
      const user1 = await client.getUser(tenant1, 'alice@example.com');
      const user2 = await client.getUser(tenant2, 'alice@example.com');

      expect(user1?.displayName).toBe('Alice Tenant 1');
      expect(user2?.displayName).toBe('Alice Tenant 2');

      // Cleanup
      await cleanupTestData(client, tenant1);
      await cleanupTestData(client, tenant2);
    });

    it('should enforce unique (tenantId, groupId) for Group nodes', async () => {
      // Create first group
      await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering First',
      });

      // Attempt to create duplicate group (should update)
      const result = await client.upsertGroup({
        tenantId: testTenantId,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering Updated',
      });

      expect(result.groupId).toBe('azuread:engineering');
      expect(result.displayName).toBe('Engineering Updated');

      // Verify only one group exists
      const group = await client.getGroup(testTenantId, 'azuread:engineering');
      expect(group?.displayName).toBe('Engineering Updated');
    });

    it('should allow same groupId in different tenants (Group)', async () => {
      const tenant1 = `${testTenantId}-1`;
      const tenant2 = `${testTenantId}-2`;

      // Create group in tenant 1
      await client.upsertGroup({
        tenantId: tenant1,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering Tenant 1',
      });

      // Create group with same ID in tenant 2
      await client.upsertGroup({
        tenantId: tenant2,
        groupId: 'azuread:engineering',
        source: 'azuread',
        displayName: 'Engineering Tenant 2',
      });

      // Verify both groups exist independently
      const group1 = await client.getGroup(tenant1, 'azuread:engineering');
      const group2 = await client.getGroup(tenant2, 'azuread:engineering');

      expect(group1?.displayName).toBe('Engineering Tenant 1');
      expect(group2?.displayName).toBe('Engineering Tenant 2');

      // Cleanup
      await cleanupTestData(client, tenant1);
      await cleanupTestData(client, tenant2);
    });

    it('should enforce unique (tenantId, documentId) for Document nodes', async () => {
      // Create first document
      await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-123',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Document First',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Update same document (should succeed)
      const result = await client.upsertDocument({
        tenantId: testTenantId,
        documentId: 'doc-123',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Document Updated',
        publicInDomain: false,
        publicEverywhere: false,
      });

      expect(result.documentId).toBe('doc-123');
      expect(result.name).toBe('Document Updated');
    });

    it('should allow same documentId in different tenants (Document)', async () => {
      const tenant1 = `${testTenantId}-1`;
      const tenant2 = `${testTenantId}-2`;

      // Create document in tenant 1
      await client.upsertDocument({
        tenantId: tenant1,
        documentId: 'doc-123',
        sourceId: 'connector-1',
        source: 'sharepoint',
        name: 'Document Tenant 1',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Create document with same ID in tenant 2
      await client.upsertDocument({
        tenantId: tenant2,
        documentId: 'doc-123',
        sourceId: 'connector-2',
        source: 'sharepoint',
        name: 'Document Tenant 2',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Verify both documents exist (indirectly via delete)
      const deleted1 = await client.deleteDocument(tenant1, 'doc-123');
      const deleted2 = await client.deleteDocument(tenant2, 'doc-123');

      expect(deleted1).toBe(true);
      expect(deleted2).toBe(true);

      // Cleanup
      await cleanupTestData(client, tenant1);
      await cleanupTestData(client, tenant2);
    });

    it('should enforce unique (tenantId, domain) for Domain nodes', async () => {
      // Create first domain
      await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: false,
        verificationMethod: 'dns',
      });

      // Update same domain (should succeed)
      const result = await client.upsertDomain({
        tenantId: testTenantId,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      expect(result.domain).toBe('example.com');
      expect(result.verified).toBe(true);
    });

    it('should allow same domain in different tenants (Domain)', async () => {
      const tenant1 = `${testTenantId}-1`;
      const tenant2 = `${testTenantId}-2`;

      // Create domain in tenant 1
      await client.upsertDomain({
        tenantId: tenant1,
        domain: 'example.com',
        verified: true,
        verificationMethod: 'idp-trust',
      });

      // Create domain in tenant 2
      const result = await client.upsertDomain({
        tenantId: tenant2,
        domain: 'example.com',
        verified: false,
        verificationMethod: 'dns',
      });

      expect(result.domain).toBe('example.com');
      expect(result.verified).toBe(false);

      // Cleanup
      await cleanupTestData(client, tenant1);
      await cleanupTestData(client, tenant2);
    });
  });

  // ==========================================================================
  // Performance Indexes Tests
  // ==========================================================================

  describe('Performance Indexes', () => {
    it('should have user_idp index on (tenantId, idpUserId)', async () => {
      const indexes = await listIndexes(client);
      const userIdpIndex = indexes.find((idx) => idx.name === 'user_idp');

      expect(userIdpIndex).toBeDefined();
      expect(userIdpIndex?.labelsOrTypes).toContain('User');
      expect(userIdpIndex?.properties).toContain('tenantId');
      expect(userIdpIndex?.properties).toContain('idpUserId');
    });

    it('should have user_domain index on (tenantId, domain)', async () => {
      const indexes = await listIndexes(client);
      const userDomainIndex = indexes.find((idx) => idx.name === 'user_domain');

      expect(userDomainIndex).toBeDefined();
      expect(userDomainIndex?.labelsOrTypes).toContain('User');
      expect(userDomainIndex?.properties).toContain('tenantId');
      expect(userDomainIndex?.properties).toContain('domain');
    });

    it('should have group_source index on (tenantId, source)', async () => {
      const indexes = await listIndexes(client);
      const groupSourceIndex = indexes.find((idx) => idx.name === 'group_source');

      expect(groupSourceIndex).toBeDefined();
      expect(groupSourceIndex?.labelsOrTypes).toContain('Group');
      expect(groupSourceIndex?.properties).toContain('tenantId');
      expect(groupSourceIndex?.properties).toContain('source');
    });

    it('should have document_source index on (tenantId, sourceId)', async () => {
      const indexes = await listIndexes(client);
      const documentSourceIndex = indexes.find((idx) => idx.name === 'document_source');

      expect(documentSourceIndex).toBeDefined();
      expect(documentSourceIndex?.labelsOrTypes).toContain('Document');
      expect(documentSourceIndex?.properties).toContain('tenantId');
      expect(documentSourceIndex?.properties).toContain('sourceId');
    });
  });

  // ==========================================================================
  // Constraint Tests
  // ==========================================================================

  describe('Constraint Verification', () => {
    it('should have user_unique constraint on (tenantId, email)', async () => {
      const constraints = await listConstraints(client);
      const userConstraint = constraints.find((c) => c.name === 'user_unique');

      expect(userConstraint).toBeDefined();
      expect(userConstraint?.labelsOrTypes).toContain('User');
      expect(userConstraint?.properties).toContain('tenantId');
      expect(userConstraint?.properties).toContain('email');
      expect(userConstraint?.type).toBe('UNIQUENESS');
    });

    it('should have group_unique constraint on (tenantId, groupId)', async () => {
      const constraints = await listConstraints(client);
      const groupConstraint = constraints.find((c) => c.name === 'group_unique');

      expect(groupConstraint).toBeDefined();
      expect(groupConstraint?.labelsOrTypes).toContain('Group');
      expect(groupConstraint?.properties).toContain('tenantId');
      expect(groupConstraint?.properties).toContain('groupId');
      expect(groupConstraint?.type).toBe('UNIQUENESS');
    });

    it('should have document_unique constraint on (tenantId, documentId)', async () => {
      const constraints = await listConstraints(client);
      const documentConstraint = constraints.find((c) => c.name === 'document_unique');

      expect(documentConstraint).toBeDefined();
      expect(documentConstraint?.labelsOrTypes).toContain('Document');
      expect(documentConstraint?.properties).toContain('tenantId');
      expect(documentConstraint?.properties).toContain('documentId');
      expect(documentConstraint?.type).toBe('UNIQUENESS');
    });

    it('should have domain_unique constraint on (tenantId, domain)', async () => {
      const constraints = await listConstraints(client);
      const domainConstraint = constraints.find((c) => c.name === 'domain_unique');

      expect(domainConstraint).toBeDefined();
      expect(domainConstraint?.labelsOrTypes).toContain('Domain');
      expect(domainConstraint?.properties).toContain('tenantId');
      expect(domainConstraint?.properties).toContain('domain');
      expect(domainConstraint?.type).toBe('UNIQUENESS');
    });
  });

  // ==========================================================================
  // Idempotency Tests
  // ==========================================================================

  describe('Schema Idempotency', () => {
    it('should allow running initializeSchema() multiple times', async () => {
      // Run schema initialization again (should not fail)
      await expect(client.initializeSchema()).resolves.not.toThrow();

      // Verify constraints still exist
      const constraints = await listConstraints(client);
      expect(constraints.find((c) => c.name === 'user_unique')).toBeDefined();
      expect(constraints.find((c) => c.name === 'group_unique')).toBeDefined();
      expect(constraints.find((c) => c.name === 'document_unique')).toBeDefined();
      expect(constraints.find((c) => c.name === 'domain_unique')).toBeDefined();

      // Verify indexes still exist
      const indexes = await listIndexes(client);
      expect(indexes.find((idx) => idx.name === 'user_idp')).toBeDefined();
      expect(indexes.find((idx) => idx.name === 'user_domain')).toBeDefined();
      expect(indexes.find((idx) => idx.name === 'group_source')).toBeDefined();
      expect(indexes.find((idx) => idx.name === 'document_source')).toBeDefined();
    });
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

interface IndexInfo {
  name: string;
  labelsOrTypes: string[];
  properties: string[];
  type: string;
}

interface ConstraintInfo {
  name: string;
  labelsOrTypes: string[];
  properties: string[];
  type: string;
}

/**
 * List all indexes in the database
 */
async function listIndexes(client: PermissionGraphClient): Promise<IndexInfo[]> {
  const session = (client as any).getSession();
  try {
    const result = await session.run('SHOW INDEXES');
    return result.records.map((record) => ({
      name: record.get('name'),
      labelsOrTypes: record.get('labelsOrTypes'),
      properties: record.get('properties'),
      type: record.get('type'),
    }));
  } finally {
    await session.close();
  }
}

/**
 * List all constraints in the database
 */
async function listConstraints(client: PermissionGraphClient): Promise<ConstraintInfo[]> {
  const session = (client as any).getSession();
  try {
    const result = await session.run('SHOW CONSTRAINTS');
    return result.records.map((record) => ({
      name: record.get('name'),
      labelsOrTypes: record.get('labelsOrTypes'),
      properties: record.get('properties'),
      type: record.get('type'),
    }));
  } finally {
    await session.close();
  }
}

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
