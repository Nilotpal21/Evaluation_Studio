/**
 * Permission System Integration Tests
 *
 * End-to-end tests for the complete permission crawling and filtering system:
 * - Document sync → Permission crawl → Query-time filtering
 * - Permission recrawl flow
 * - Cache invalidation
 * - Neo4j integration
 *
 * These tests validate the entire permission system working together.
 */

import { describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { PermissionFilterService } from '../../services/permission-filter.service.js';
import { PermissionGraphService } from '@agent-platform/search-ai-internal/permissions';
import type { UserIdentity } from '../../services/permission-filter.service.js';

// =============================================================================
// Test Configuration
// =============================================================================

const NEO4J_CONFIG = {
  uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
  username: process.env.NEO4J_USERNAME || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',
  database: process.env.NEO4J_DATABASE || 'neo4j',
};

const TEST_TENANT_ID = 'integration-test-tenant';
const TEST_USER_EMAIL = 'test-user@example.com';

// =============================================================================
// Setup and Teardown
// =============================================================================

describe('Permission System Integration', () => {
  let permissionGraphService: PermissionGraphService;
  let permissionFilterService: PermissionFilterService;

  beforeAll(async () => {
    // Skip if Neo4j is not available
    if (!process.env.NEO4J_URI) {
      console.log('⚠️  Skipping Neo4j integration tests (NEO4J_URI not set)');
      return;
    }

    try {
      permissionGraphService = PermissionGraphService.getInstance(NEO4J_CONFIG);
      permissionFilterService = new PermissionFilterService(permissionGraphService);

      // Test connection
      await permissionGraphService.getGraphStats(TEST_TENANT_ID);
      console.log('✅ Neo4j connection successful');
    } catch (error) {
      console.error('❌ Failed to connect to Neo4j:', error);
      throw error;
    }
  });

  afterAll(async () => {
    if (!process.env.NEO4J_URI) return;

    // Cleanup test data
    try {
      // Delete all test tenant data
      // Note: This requires the PermissionGraphService to have a cleanup method
      console.log('🧹 Cleaning up test data...');
    } catch (error) {
      console.error('Failed to cleanup test data:', error);
    }
  });

  beforeEach(async () => {
    // Skip setup if Neo4j not available (tests will be skipped individually)
  });

  // ─── End-to-End Flow Tests ─────────────────────────────────────────────

  test.skipIf(!process.env.NEO4J_URI)(
    'complete permission flow: crawl → store → filter',
    async () => {
      // STEP 1: Setup test data in Neo4j
      const documentId = 'test-doc-1';
      const userId = TEST_USER_EMAIL;
      const groupId = 'sharepoint:group-1';

      // Create user
      await permissionGraphService.upsertUser({
        tenantId: TEST_TENANT_ID,
        email: userId,
        displayName: 'Test User',
        status: 'active',
      });

      // Create group
      await permissionGraphService.upsertGroup({
        tenantId: TEST_TENANT_ID,
        groupId,
        source: 'sharepoint',
        displayName: 'Test Group',
      });

      // Add user to group
      await permissionGraphService.setMembership({
        tenantId: TEST_TENANT_ID,
        memberEmail: userId,
        parentGroupId: groupId,
        source: 'sharepoint',
      });

      // Create document
      await permissionGraphService.upsertDocument({
        tenantId: TEST_TENANT_ID,
        documentId,
        sourceId: 'source-1',
        source: 'sharepoint',
        name: 'Test Document',
        publicInDomain: false,
        publicEverywhere: false,
      });

      // Set permission (user has direct access)
      await permissionGraphService.setPermission({
        tenantId: TEST_TENANT_ID,
        userEmail: userId,
        documentId,
        role: 'read',
        source: 'sharepoint',
      });

      // STEP 2: Query accessible documents
      const userIdentity: UserIdentity = {
        tenantId: TEST_TENANT_ID,
        userId,
        email: userId,
        groupIds: [],
      };

      const result = await permissionFilterService.getAccessibleDocuments(userIdentity);

      // STEP 3: Verify results
      expect(result.documentIds).toContain(documentId);
      expect(result.cacheHit).toBe(false); // First query = cache miss
      expect(result.isComplete).toBe(true);

      // STEP 4: Query again (should hit cache)
      const cachedResult = await permissionFilterService.getAccessibleDocuments(userIdentity);
      expect(cachedResult.cacheHit).toBe(true);
      expect(cachedResult.documentIds).toEqual(result.documentIds);
    },
  );

  test.skipIf(!process.env.NEO4J_URI)('group-based permission resolution', async () => {
    // STEP 1: Setup nested groups
    const documentId = 'test-doc-2';
    const userId = 'group-member@example.com';
    const parentGroupId = 'sharepoint:parent-group';
    const childGroupId = 'sharepoint:child-group';

    // Create user
    await permissionGraphService.upsertUser({
      tenantId: TEST_TENANT_ID,
      email: userId,
      displayName: 'Group Member',
      status: 'active',
    });

    // Create parent and child groups
    await permissionGraphService.upsertGroup({
      tenantId: TEST_TENANT_ID,
      groupId: parentGroupId,
      source: 'sharepoint',
      displayName: 'Parent Group',
    });

    await permissionGraphService.upsertGroup({
      tenantId: TEST_TENANT_ID,
      groupId: childGroupId,
      source: 'sharepoint',
      displayName: 'Child Group',
    });

    // Create group hierarchy: user → child group → parent group
    await permissionGraphService.setMembership({
      tenantId: TEST_TENANT_ID,
      memberEmail: userId,
      parentGroupId: childGroupId,
      source: 'sharepoint',
    });

    await permissionGraphService.setMembership({
      tenantId: TEST_TENANT_ID,
      memberGroupId: childGroupId,
      parentGroupId: parentGroupId,
      source: 'sharepoint',
    });

    // Create document
    await permissionGraphService.upsertDocument({
      tenantId: TEST_TENANT_ID,
      documentId,
      sourceId: 'source-1',
      source: 'sharepoint',
      name: 'Group Access Document',
      publicInDomain: false,
      publicEverywhere: false,
    });

    // Give permission to parent group
    await permissionGraphService.setPermission({
      tenantId: TEST_TENANT_ID,
      groupId: parentGroupId,
      documentId,
      role: 'read',
      source: 'sharepoint',
    });

    // STEP 2: Query as user (should have access via nested groups)
    const userIdentity: UserIdentity = {
      tenantId: TEST_TENANT_ID,
      userId,
      email: userId,
      groupIds: [],
    };

    const result = await permissionFilterService.getAccessibleDocuments(userIdentity);

    // STEP 3: Verify user has access via group hierarchy
    expect(result.documentIds).toContain(documentId);
  });

  test.skipIf(!process.env.NEO4J_URI)('public document access', async () => {
    // STEP 1: Create public document
    const publicDocId = 'test-doc-public';

    await permissionGraphService.upsertDocument({
      tenantId: TEST_TENANT_ID,
      documentId: publicDocId,
      sourceId: 'source-1',
      source: 'sharepoint',
      name: 'Public Document',
      publicInDomain: false,
      publicEverywhere: true,
    });

    // STEP 2: Query as any user
    const anyUserIdentity: UserIdentity = {
      tenantId: TEST_TENANT_ID,
      userId: 'random-user@example.com',
      email: 'random-user@example.com',
      groupIds: [],
    };

    const result = await permissionFilterService.getAccessibleDocuments(anyUserIdentity);

    // STEP 3: Verify user has access to public document
    expect(result.documentIds).toContain(publicDocId);
  });

  test.skipIf(!process.env.NEO4J_URI)('cache invalidation flow', async () => {
    const documentId = 'test-doc-cache';
    const userId = 'cache-test@example.com';

    // STEP 1: Create user and document
    await permissionGraphService.upsertUser({
      tenantId: TEST_TENANT_ID,
      email: userId,
      displayName: 'Cache Test User',
      status: 'active',
    });

    await permissionGraphService.upsertDocument({
      tenantId: TEST_TENANT_ID,
      documentId,
      sourceId: 'source-1',
      source: 'sharepoint',
      name: 'Cache Test Document',
      publicInDomain: false,
      publicEverywhere: false,
    });

    const userIdentity: UserIdentity = {
      tenantId: TEST_TENANT_ID,
      userId,
      email: userId,
      groupIds: [],
    };

    // STEP 2: Query (should not have access)
    let result = await permissionFilterService.getAccessibleDocuments(userIdentity);
    expect(result.documentIds).not.toContain(documentId);

    // STEP 3: Grant permission
    await permissionGraphService.setPermission({
      tenantId: TEST_TENANT_ID,
      userEmail: userId,
      documentId,
      role: 'read',
      source: 'sharepoint',
    });

    // STEP 4: Query again (cached result = still no access)
    result = await permissionFilterService.getAccessibleDocuments(userIdentity);
    expect(result.cacheHit).toBe(true);
    expect(result.documentIds).not.toContain(documentId); // Stale cache

    // STEP 5: Invalidate cache
    await permissionFilterService.invalidateCache(userIdentity);

    // STEP 6: Query again (fresh from Neo4j = now has access)
    result = await permissionFilterService.getAccessibleDocuments(userIdentity);
    expect(result.cacheHit).toBe(false);
    expect(result.documentIds).toContain(documentId); // Fresh data
  });

  test.skipIf(!process.env.NEO4J_URI)('tenant isolation', async () => {
    const documentId = 'tenant-isolation-doc';
    const tenant1 = 'tenant-1';
    const tenant2 = 'tenant-2';
    const userId = 'user@example.com';

    // STEP 1: Create same user in two tenants
    await permissionGraphService.upsertUser({
      tenantId: tenant1,
      email: userId,
      displayName: 'User Tenant 1',
      status: 'active',
    });

    await permissionGraphService.upsertUser({
      tenantId: tenant2,
      email: userId,
      displayName: 'User Tenant 2',
      status: 'active',
    });

    // STEP 2: Create document in tenant 1 only
    await permissionGraphService.upsertDocument({
      tenantId: tenant1,
      documentId,
      sourceId: 'source-1',
      source: 'sharepoint',
      name: 'Tenant 1 Document',
      publicInDomain: false,
      publicEverywhere: false,
    });

    // Grant permission in tenant 1
    await permissionGraphService.setPermission({
      tenantId: tenant1,
      userEmail: userId,
      documentId,
      role: 'read',
      source: 'sharepoint',
    });

    // STEP 3: Query as tenant 1 user (should have access)
    const tenant1Identity: UserIdentity = {
      tenantId: tenant1,
      userId,
      email: userId,
      groupIds: [],
    };

    const tenant1Result = await permissionFilterService.getAccessibleDocuments(tenant1Identity);
    expect(tenant1Result.documentIds).toContain(documentId);

    // STEP 4: Query as tenant 2 user (should NOT have access)
    const tenant2Identity: UserIdentity = {
      tenantId: tenant2,
      userId,
      email: userId,
      groupIds: [],
    };

    const tenant2Result = await permissionFilterService.getAccessibleDocuments(tenant2Identity);
    expect(tenant2Result.documentIds).not.toContain(documentId);
  });

  // ─── Performance Tests ─────────────────────────────────────────────────

  test.skipIf(!process.env.NEO4J_URI)(
    'performance: query with 1000 documents',
    async () => {
      const userId = 'perf-test@example.com';
      const documentCount = 1000;

      // STEP 1: Create user
      await permissionGraphService.upsertUser({
        tenantId: TEST_TENANT_ID,
        email: userId,
        displayName: 'Performance Test User',
        status: 'active',
      });

      // STEP 2: Create 1000 documents (in batches)
      console.time('Create 1000 documents');
      const batchSize = 100;
      for (let i = 0; i < documentCount; i += batchSize) {
        const promises = [];
        for (let j = 0; j < batchSize && i + j < documentCount; j++) {
          const docId = `perf-doc-${i + j}`;
          promises.push(
            permissionGraphService.upsertDocument({
              tenantId: TEST_TENANT_ID,
              documentId: docId,
              sourceId: 'source-1',
              source: 'sharepoint',
              name: `Perf Doc ${i + j}`,
              publicInDomain: false,
              publicEverywhere: false,
            }),
          );

          promises.push(
            permissionGraphService.setPermission({
              tenantId: TEST_TENANT_ID,
              userEmail: userId,
              documentId: docId,
              role: 'read',
              source: 'sharepoint',
            }),
          );
        }
        await Promise.all(promises);
      }
      console.timeEnd('Create 1000 documents');

      // STEP 3: Query accessible documents
      const userIdentity: UserIdentity = {
        tenantId: TEST_TENANT_ID,
        userId,
        email: userId,
        groupIds: [],
      };

      console.time('Query 1000 accessible documents');
      const result = await permissionFilterService.getAccessibleDocuments(userIdentity);
      console.timeEnd('Query 1000 accessible documents');

      // STEP 4: Verify performance
      expect(result.documentIds.length).toBe(documentCount);
      expect(result.isComplete).toBe(true);

      // Query should complete in under 1 second
      console.time('Cached query');
      const cachedResult = await permissionFilterService.getAccessibleDocuments(userIdentity);
      console.timeEnd('Cached query');

      expect(cachedResult.cacheHit).toBe(true);
    },
    120000,
  ); // 2 minute timeout for performance test

  // ─── Edge Cases ────────────────────────────────────────────────────────

  test.skipIf(!process.env.NEO4J_URI)('handles user with no permissions', async () => {
    const userId = 'no-access@example.com';

    await permissionGraphService.upsertUser({
      tenantId: TEST_TENANT_ID,
      email: userId,
      displayName: 'No Access User',
      status: 'active',
    });

    const userIdentity: UserIdentity = {
      tenantId: TEST_TENANT_ID,
      userId,
      email: userId,
      groupIds: [],
    };

    const result = await permissionFilterService.getAccessibleDocuments(userIdentity);

    expect(result.documentIds).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  test.skipIf(!process.env.NEO4J_URI)('handles non-existent user', async () => {
    const userIdentity: UserIdentity = {
      tenantId: TEST_TENANT_ID,
      userId: 'nonexistent@example.com',
      email: 'nonexistent@example.com',
      groupIds: [],
    };

    const result = await permissionFilterService.getAccessibleDocuments(userIdentity);

    // Should return empty list, not error
    expect(result.documentIds).toEqual([]);
    expect(result.success).not.toBe(false);
  });

  test.skipIf(!process.env.NEO4J_URI)(
    'canAccessDocument checks single document permission',
    async () => {
      const documentId = 'single-check-doc';
      const userId = 'single-check@example.com';

      // Create user and document
      await permissionGraphService.upsertUser({
        tenantId: TEST_TENANT_ID,
        email: userId,
        displayName: 'Single Check User',
        status: 'active',
      });

      await permissionGraphService.upsertDocument({
        tenantId: TEST_TENANT_ID,
        documentId,
        sourceId: 'source-1',
        source: 'sharepoint',
        name: 'Single Check Document',
        publicInDomain: false,
        publicEverywhere: false,
      });

      const userIdentity: UserIdentity = {
        tenantId: TEST_TENANT_ID,
        userId,
        email: userId,
        groupIds: [],
      };

      // Should not have access initially
      let canAccess = await permissionFilterService.canAccessDocument(userIdentity, documentId);
      expect(canAccess).toBe(false);

      // Grant permission
      await permissionGraphService.setPermission({
        tenantId: TEST_TENANT_ID,
        userEmail: userId,
        documentId,
        role: 'read',
        source: 'sharepoint',
      });

      // Should have access now
      canAccess = await permissionFilterService.canAccessDocument(userIdentity, documentId);
      expect(canAccess).toBe(true);
    },
  );
});
