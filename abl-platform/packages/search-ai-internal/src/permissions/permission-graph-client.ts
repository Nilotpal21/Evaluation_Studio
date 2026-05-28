/**
 * Permission Graph Client
 *
 * Neo4j client for SearchAI permission graph operations.
 * Implements CRUD operations for users, groups, documents, domains,
 * and permission relationships.
 *
 * @see neo4j-permission-schema.md for schema documentation
 * @see types.ts for type definitions
 */

import neo4j, { Driver, Session, Result, Integer, Record } from 'neo4j-driver';
import type {
  UserNode,
  GroupNode,
  DocumentNode,
  DomainNode,
  CreateUserInput,
  CreateGroupInput,
  CreateDocumentInput,
  CreateDomainInput,
  SetMembershipInput,
  SetPermissionInput,
  FlattenedPermissions,
  UserGroupsResult,
  AccessibleDocumentsResult,
  PermissionGraphStats,
  Neo4jConnectionConfig,
  PermissionQueryOptions,
} from './types.js';

/**
 * Permission Graph Client
 *
 * Thread-safe client for Neo4j permission graph operations.
 * All queries enforce tenant isolation (tenantId filter).
 */
export class PermissionGraphClient {
  private driver: Driver;
  private database: string;
  private readonly maxDepth: number;

  constructor(config: Neo4jConnectionConfig) {
    this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
      maxConnectionPoolSize: config.maxConnectionPoolSize || 50,
      connectionTimeout: config.connectionTimeout || 30000,
    });
    this.database = config.database || 'neo4j';
    this.maxDepth = 20; // Hard limit for group nesting
  }

  /**
   * Get a Neo4j session
   *
   * IMPORTANT: Caller must close the session when done.
   * Use try-finally to ensure cleanup.
   */
  private getSession(): Session {
    return this.driver.session({ database: this.database });
  }

  /**
   * Close the driver connection pool
   */
  async close(): Promise<void> {
    await this.driver.close();
  }

  /**
   * Verify connection and database is reachable
   */
  async verifyConnection(): Promise<boolean> {
    const session = this.getSession();
    try {
      await session.run('RETURN 1');
      return true;
    } catch (error) {
      console.error('Neo4j connection verification failed:', error);
      return false;
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Schema Management
  // ==========================================================================

  /**
   * Initialize schema: Create constraints and indexes
   *
   * IDEMPOTENT: Safe to run multiple times.
   */
  async initializeSchema(): Promise<void> {
    const session = this.getSession();
    try {
      // Unique constraints
      await session.run(`
        CREATE CONSTRAINT user_unique IF NOT EXISTS
        FOR (u:User) REQUIRE (u.tenantId, u.email) IS UNIQUE
      `);

      await session.run(`
        CREATE CONSTRAINT group_unique IF NOT EXISTS
        FOR (g:Group) REQUIRE (g.tenantId, g.groupId) IS UNIQUE
      `);

      await session.run(`
        CREATE CONSTRAINT document_unique IF NOT EXISTS
        FOR (d:Document) REQUIRE (d.tenantId, d.documentId) IS UNIQUE
      `);

      await session.run(`
        CREATE CONSTRAINT domain_unique IF NOT EXISTS
        FOR (d:Domain) REQUIRE (d.tenantId, d.domain) IS UNIQUE
      `);

      // Performance indexes
      await session.run(`
        CREATE INDEX user_idp IF NOT EXISTS
        FOR (u:User) ON (u.tenantId, u.idpUserId)
      `);

      await session.run(`
        CREATE INDEX user_domain IF NOT EXISTS
        FOR (u:User) ON (u.tenantId, u.domain)
      `);

      await session.run(`
        CREATE INDEX group_source IF NOT EXISTS
        FOR (g:Group) ON (g.tenantId, g.source)
      `);

      await session.run(`
        CREATE INDEX document_source IF NOT EXISTS
        FOR (d:Document) ON (d.tenantId, d.sourceId)
      `);

      console.log('✅ Neo4j permission schema initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Neo4j schema:', error);
      throw error;
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  /**
   * Upsert a user node
   *
   * Creates if not exists, updates if exists.
   * Email is normalized to lowercase.
   */
  async upsertUser(input: CreateUserInput): Promise<UserNode> {
    const session = this.getSession();
    try {
      const email = input.email.toLowerCase();
      const domain = email.split('@')[1];

      const result = await session.run(
        `
        MERGE (u:User {tenantId: $tenantId, email: $email})
        SET u.idpUserId = $idpUserId,
            u.idpProvider = $idpProvider,
            u.displayName = $displayName,
            u.domain = $domain,
            u.status = $status,
            u.lastSyncAt = datetime(),
            u.createdAt = coalesce(u.createdAt, datetime())
        RETURN u
        `,
        {
          tenantId: input.tenantId,
          email,
          idpUserId: input.idpUserId || null,
          idpProvider: input.idpProvider || null,
          displayName: input.displayName || null,
          domain,
          status: input.status || 'active',
        },
      );

      return this.parseUserNode(result.records[0].get('u'));
    } finally {
      await session.close();
    }
  }

  /**
   * Get user by email
   */
  async getUser(tenantId: string, email: string): Promise<UserNode | null> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (u:User {tenantId: $tenantId, email: $email})
        WHERE u.status <> 'deleted'
        RETURN u
        `,
        { tenantId, email: email.toLowerCase() },
      );

      if (result.records.length === 0) {
        return null;
      }

      return this.parseUserNode(result.records[0].get('u'));
    } finally {
      await session.close();
    }
  }

  /**
   * Batch upsert users (for IDP sync)
   *
   * Uses UNWIND for efficient batch processing.
   */
  async batchUpsertUsers(tenantId: string, users: CreateUserInput[]): Promise<number> {
    const session = this.getSession();
    try {
      const normalizedUsers = users.map((u) => ({
        tenantId: u.tenantId,
        email: u.email.toLowerCase(),
        domain: u.email.toLowerCase().split('@')[1],
        idpUserId: u.idpUserId || null,
        idpProvider: u.idpProvider || null,
        displayName: u.displayName || null,
        status: u.status || 'active',
      }));

      const result = await session.run(
        `
        UNWIND $users AS user
        MERGE (u:User {tenantId: user.tenantId, email: user.email})
        SET u.idpUserId = user.idpUserId,
            u.idpProvider = user.idpProvider,
            u.displayName = user.displayName,
            u.domain = user.domain,
            u.status = user.status,
            u.lastSyncAt = datetime(),
            u.createdAt = coalesce(u.createdAt, datetime())
        RETURN count(u) AS count
        `,
        { users: normalizedUsers },
      );

      return result.records[0].get('count').toNumber();
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Group Operations
  // ==========================================================================

  /**
   * Upsert a group node
   */
  async upsertGroup(input: CreateGroupInput): Promise<GroupNode> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MERGE (g:Group {tenantId: $tenantId, groupId: $groupId})
        SET g.idpGroupId = $idpGroupId,
            g.source = $source,
            g.displayName = $displayName,
            g.email = $email,
            g.lastSyncAt = datetime(),
            g.createdAt = coalesce(g.createdAt, datetime())
        RETURN g
        `,
        {
          tenantId: input.tenantId,
          groupId: input.groupId,
          idpGroupId: input.idpGroupId || null,
          source: input.source,
          displayName: input.displayName || null,
          email: input.email?.toLowerCase() || null,
        },
      );

      return this.parseGroupNode(result.records[0].get('g'));
    } finally {
      await session.close();
    }
  }

  /**
   * Get group by groupId
   */
  async getGroup(tenantId: string, groupId: string): Promise<GroupNode | null> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (g:Group {tenantId: $tenantId, groupId: $groupId})
        RETURN g
        `,
        { tenantId, groupId },
      );

      if (result.records.length === 0) {
        return null;
      }

      return this.parseGroupNode(result.records[0].get('g'));
    } finally {
      await session.close();
    }
  }

  /**
   * Batch upsert groups (for IDP sync)
   */
  async batchUpsertGroups(tenantId: string, groups: CreateGroupInput[]): Promise<number> {
    const session = this.getSession();
    try {
      const normalizedGroups = groups.map((g) => ({
        tenantId: g.tenantId,
        groupId: g.groupId,
        idpGroupId: g.idpGroupId || null,
        source: g.source,
        displayName: g.displayName || null,
        email: g.email?.toLowerCase() || null,
      }));

      const result = await session.run(
        `
        UNWIND $groups AS group
        MERGE (g:Group {tenantId: group.tenantId, groupId: group.groupId})
        SET g.idpGroupId = group.idpGroupId,
            g.source = group.source,
            g.displayName = group.displayName,
            g.email = group.email,
            g.lastSyncAt = datetime(),
            g.createdAt = coalesce(g.createdAt, datetime())
        RETURN count(g) AS count
        `,
        { groups: normalizedGroups },
      );

      return result.records[0].get('count').toNumber();
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Document Operations
  // ==========================================================================

  /**
   * Upsert a document node
   */
  async upsertDocument(input: CreateDocumentInput): Promise<DocumentNode> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MERGE (d:Document {tenantId: $tenantId, documentId: $documentId})
        SET d.sourceId = $sourceId,
            d.source = $source,
            d.name = $name,
            d.path = $path,
            d.publicInDomain = $publicInDomain,
            d.publicEverywhere = $publicEverywhere,
            d.lastPermissionCrawlAt = datetime(),
            d.createdAt = coalesce(d.createdAt, datetime())
        RETURN d
        `,
        {
          tenantId: input.tenantId,
          documentId: input.documentId,
          sourceId: input.sourceId,
          source: input.source,
          name: input.name || null,
          path: input.path || null,
          publicInDomain: input.publicInDomain,
          publicEverywhere: input.publicEverywhere,
        },
      );

      return this.parseDocumentNode(result.records[0].get('d'));
    } finally {
      await session.close();
    }
  }

  /**
   * Delete document node and all its relationships
   */
  async deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (d:Document {tenantId: $tenantId, documentId: $documentId})
        DETACH DELETE d
        RETURN count(d) AS count
        `,
        { tenantId, documentId },
      );

      return result.records[0].get('count').toNumber() > 0;
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Domain Operations
  // ==========================================================================

  /**
   * Upsert a domain node
   */
  async upsertDomain(input: CreateDomainInput): Promise<DomainNode> {
    const session = this.getSession();
    try {
      const domain = input.domain.toLowerCase();

      const result = await session.run(
        `
        MERGE (d:Domain {tenantId: $tenantId, domain: $domain})
        SET d.verified = $verified,
            d.verificationMethod = $verificationMethod,
            d.verifiedAt = CASE WHEN $verified THEN datetime() ELSE null END,
            d.createdAt = coalesce(d.createdAt, datetime())
        RETURN d
        `,
        {
          tenantId: input.tenantId,
          domain,
          verified: input.verified,
          verificationMethod: input.verificationMethod,
        },
      );

      return this.parseDomainNode(result.records[0].get('d'));
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Membership Operations (MEMBER_OF relationships)
  // ==========================================================================

  /**
   * Set MEMBER_OF relationship (User → Group or Group → Group)
   */
  async setMembership(input: SetMembershipInput): Promise<void> {
    const session = this.getSession();
    try {
      if (input.memberEmail) {
        // User → Group
        await session.run(
          `
          MATCH (u:User {tenantId: $tenantId, email: $email})
          MATCH (g:Group {tenantId: $tenantId, groupId: $groupId})
          MERGE (u)-[r:MEMBER_OF]->(g)
          SET r.source = $source,
              r.syncedAt = datetime()
          `,
          {
            tenantId: input.tenantId,
            email: input.memberEmail.toLowerCase(),
            groupId: input.parentGroupId,
            source: input.source,
          },
        );
      } else if (input.memberGroupId) {
        // Group → Group (nested)
        await session.run(
          `
          MATCH (child:Group {tenantId: $tenantId, groupId: $childGroupId})
          MATCH (parent:Group {tenantId: $tenantId, groupId: $parentGroupId})
          MERGE (child)-[r:MEMBER_OF]->(parent)
          SET r.source = $source,
              r.syncedAt = datetime()
          `,
          {
            tenantId: input.tenantId,
            childGroupId: input.memberGroupId,
            parentGroupId: input.parentGroupId,
            source: input.source,
          },
        );
      } else {
        throw new Error('Either memberEmail or memberGroupId must be provided');
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Remove MEMBER_OF relationship
   */
  async removeMembership(input: SetMembershipInput): Promise<void> {
    const session = this.getSession();
    try {
      if (input.memberEmail) {
        await session.run(
          `
          MATCH (u:User {tenantId: $tenantId, email: $email})
                -[r:MEMBER_OF]->
                (g:Group {tenantId: $tenantId, groupId: $groupId})
          DELETE r
          `,
          {
            tenantId: input.tenantId,
            email: input.memberEmail.toLowerCase(),
            groupId: input.parentGroupId,
          },
        );
      } else if (input.memberGroupId) {
        await session.run(
          `
          MATCH (child:Group {tenantId: $tenantId, groupId: $childGroupId})
                -[r:MEMBER_OF]->
                (parent:Group {tenantId: $tenantId, groupId: $parentGroupId})
          DELETE r
          `,
          {
            tenantId: input.tenantId,
            childGroupId: input.memberGroupId,
            parentGroupId: input.parentGroupId,
          },
        );
      }
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Permission Operations (HAS_PERMISSION relationships)
  // ==========================================================================

  /**
   * Set HAS_PERMISSION relationship (User → Document or Group → Document)
   */
  async setPermission(input: SetPermissionInput): Promise<void> {
    const session = this.getSession();
    try {
      if (input.userEmail) {
        // User → Document
        await session.run(
          `
          MATCH (u:User {tenantId: $tenantId, email: $email})
          MATCH (d:Document {tenantId: $tenantId, documentId: $documentId})
          MERGE (u)-[r:HAS_PERMISSION]->(d)
          SET r.role = $role,
              r.source = $source,
              r.grantedAt = datetime()
          `,
          {
            tenantId: input.tenantId,
            email: input.userEmail.toLowerCase(),
            documentId: input.documentId,
            role: input.role,
            source: input.source,
          },
        );
      } else if (input.groupId) {
        // Group → Document
        await session.run(
          `
          MATCH (g:Group {tenantId: $tenantId, groupId: $groupId})
          MATCH (d:Document {tenantId: $tenantId, documentId: $documentId})
          MERGE (g)-[r:HAS_PERMISSION]->(d)
          SET r.role = $role,
              r.source = $source,
              r.grantedAt = datetime()
          `,
          {
            tenantId: input.tenantId,
            groupId: input.groupId,
            documentId: input.documentId,
            role: input.role,
            source: input.source,
          },
        );
      } else {
        throw new Error('Either userEmail or groupId must be provided');
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Remove HAS_PERMISSION relationship
   */
  async removePermission(input: SetPermissionInput): Promise<void> {
    const session = this.getSession();
    try {
      if (input.userEmail) {
        await session.run(
          `
          MATCH (u:User {tenantId: $tenantId, email: $email})
                -[r:HAS_PERMISSION]->
                (d:Document {tenantId: $tenantId, documentId: $documentId})
          DELETE r
          `,
          {
            tenantId: input.tenantId,
            email: input.userEmail.toLowerCase(),
            documentId: input.documentId,
          },
        );
      } else if (input.groupId) {
        await session.run(
          `
          MATCH (g:Group {tenantId: $tenantId, groupId: $groupId})
                -[r:HAS_PERMISSION]->
                (d:Document {tenantId: $tenantId, documentId: $documentId})
          DELETE r
          `,
          {
            tenantId: input.tenantId,
            groupId: input.groupId,
            documentId: input.documentId,
          },
        );
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Remove ALL HAS_PERMISSION edges pointing to a document.
   *
   * Used before re-crawling permissions to ensure revoked permissions are cleaned up.
   * This is a reconcile pattern: delete old state, then write current state.
   *
   * @returns Number of relationships deleted
   */
  async removeAllDocumentPermissions(tenantId: string, documentId: string): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH ()-[r:HAS_PERMISSION]->(d:Document {tenantId: $tenantId, documentId: $documentId})
        DELETE r
        RETURN count(r) AS count
        `,
        { tenantId, documentId },
      );
      return result.records[0]?.get('count')?.toNumber?.() ?? 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Set PUBLIC_IN relationship (Document → Domain)
   */
  async setPublicInDomain(tenantId: string, documentId: string, domain: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(
        `
        MATCH (doc:Document {tenantId: $tenantId, documentId: $documentId})
        MATCH (dom:Domain {tenantId: $tenantId, domain: $domain})
        MERGE (doc)-[:PUBLIC_IN]->(dom)
        `,
        { tenantId, documentId, domain: domain.toLowerCase() },
      );
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Permission Queries
  // ==========================================================================

  /**
   * Query 1: Get all groups for user (recursive, up to maxDepth levels)
   */
  async getUserGroups(tenantId: string, email: string, maxDepth?: number): Promise<string[]> {
    const session = this.getSession();
    try {
      const depth = maxDepth || this.maxDepth;

      const result = await session.run(
        `
        MATCH (u:User {tenantId: $tenantId, email: $email})
              -[:MEMBER_OF*1..${depth}]->(g:Group)
        WHERE NOT (g)-[:MEMBER_OF*]->(u)
        RETURN DISTINCT g.groupId AS groupId
        `,
        { tenantId, email: email.toLowerCase() },
      );

      return result.records.map((record: Record) => record.get('groupId'));
    } finally {
      await session.close();
    }
  }

  /**
   * Query 2: Get all accessible documents for user
   *
   * Returns document IDs that user can access via:
   * 1. Direct permission (User → Document)
   * 2. Group permission (User → Group → Document, recursive)
   * 3. Domain-scoped (publicInDomain + user's domain)
   * 4. Public everywhere
   */
  async getAccessibleDocuments(
    tenantId: string,
    email: string,
    options?: PermissionQueryOptions,
  ): Promise<string[]> {
    const session = this.getSession();
    try {
      const depth = options?.maxDepth || this.maxDepth;
      const limit = options?.limit || 10000;

      const result = await session.run(
        `
        MATCH (u:User {tenantId: $tenantId, email: $email})

        // Path 1: Direct user permission
        OPTIONAL MATCH (u)-[:HAS_PERMISSION]->(doc1:Document)

        // Path 2: Group permission (recursive)
        OPTIONAL MATCH (u)-[:MEMBER_OF*1..${depth}]->(g:Group)
                          -[:HAS_PERMISSION]->(doc2:Document)

        // Path 3: Public in user's domain
        OPTIONAL MATCH (doc3:Document {tenantId: $tenantId, publicInDomain: true})
                          -[:PUBLIC_IN]->(d:Domain)
        WHERE u.domain = d.domain

        // Path 4: Public everywhere
        OPTIONAL MATCH (doc4:Document {tenantId: $tenantId, publicEverywhere: true})

        WITH COLLECT(DISTINCT doc1.documentId) +
             COLLECT(DISTINCT doc2.documentId) +
             COLLECT(DISTINCT doc3.documentId) +
             COLLECT(DISTINCT doc4.documentId) AS allDocs

        UNWIND allDocs AS docId
        RETURN DISTINCT docId
        LIMIT $limit
        `,
        { tenantId, email: email.toLowerCase(), limit },
      );

      return result.records
        .map((record: Record) => record.get('docId') as string)
        .filter((id: string) => id != null);
    } finally {
      await session.close();
    }
  }

  /**
   * Query 3: Get flattened permissions for document
   *
   * Returns all users, groups, and domains that can access the document.
   * Used for vector DB denormalization.
   */
  async getFlattenedPermissions(
    tenantId: string,
    documentId: string,
  ): Promise<FlattenedPermissions> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (doc:Document {tenantId: $tenantId, documentId: $documentId})

        // Collect direct users
        OPTIONAL MATCH (u:User)-[:HAS_PERMISSION]->(doc)
        WITH doc, COLLECT(DISTINCT u.email) AS allowedUsers

        // Collect groups
        OPTIONAL MATCH (g:Group)-[:HAS_PERMISSION]->(doc)
        WITH doc, allowedUsers, COLLECT(DISTINCT g.groupId) AS allowedGroups

        // Collect domains
        OPTIONAL MATCH (doc)-[:PUBLIC_IN]->(d:Domain)
        WITH doc, allowedUsers, allowedGroups, COLLECT(DISTINCT d.domain) AS allowedDomains

        RETURN {
          allowedUsers: allowedUsers,
          allowedGroups: allowedGroups,
          allowedDomains: allowedDomains,
          publicInDomain: doc.publicInDomain,
          publicEverywhere: doc.publicEverywhere,
          source: COALESCE(doc.source, 'unknown')
        } AS permissions
        `,
        { tenantId, documentId },
      );

      if (result.records.length === 0) {
        return {
          allowedUsers: [],
          allowedGroups: [],
          allowedDomains: [],
          publicInDomain: false,
          publicEverywhere: false,
          source: 'unknown',
        };
      }

      return result.records[0].get('permissions');
    } finally {
      await session.close();
    }
  }

  /**
   * Get permission graph statistics for tenant
   */
  async getGraphStats(tenantId: string): Promise<PermissionGraphStats> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (u:User {tenantId: $tenantId})
        WITH count(u) AS userCount

        MATCH (g:Group {tenantId: $tenantId})
        WITH userCount, count(g) AS groupCount

        MATCH (d:Document {tenantId: $tenantId})
        WITH userCount, groupCount, count(d) AS documentCount

        MATCH (dom:Domain {tenantId: $tenantId})
        WITH userCount, groupCount, documentCount, count(dom) AS domainCount

        MATCH ()-[m:MEMBER_OF]->()
        WITH userCount, groupCount, documentCount, domainCount, count(m) AS membershipCount

        MATCH ()-[p:HAS_PERMISSION]->()
        WITH userCount, groupCount, documentCount, domainCount, membershipCount, count(p) AS permissionCount

        RETURN {
          userCount: userCount,
          groupCount: groupCount,
          documentCount: documentCount,
          domainCount: domainCount,
          membershipCount: membershipCount,
          permissionCount: permissionCount
        } AS stats
        `,
        { tenantId },
      );

      const stats = result.records[0]?.get('stats') || {};

      return {
        tenantId,
        userCount: this.toNumber(stats.userCount),
        groupCount: this.toNumber(stats.groupCount),
        documentCount: this.toNumber(stats.documentCount),
        domainCount: this.toNumber(stats.domainCount),
        membershipCount: this.toNumber(stats.membershipCount),
        permissionCount: this.toNumber(stats.permissionCount),
        averageGroupDepth: 0, // TODO: Calculate in separate query
        maxGroupDepth: 0, // TODO: Calculate in separate query
        lastUpdated: new Date(),
      };
    } finally {
      await session.close();
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Parse Neo4j User node to UserNode type
   */
  private parseUserNode(node: any): UserNode {
    const props = node.properties;
    return {
      tenantId: props.tenantId,
      email: props.email,
      idpUserId: props.idpUserId,
      idpProvider: props.idpProvider,
      displayName: props.displayName,
      domain: props.domain,
      status: props.status || 'active',
      lastSyncAt: this.parseDateTime(props.lastSyncAt),
      createdAt: this.parseDateTime(props.createdAt) || new Date(),
    };
  }

  /**
   * Parse Neo4j Group node to GroupNode type
   */
  private parseGroupNode(node: any): GroupNode {
    const props = node.properties;
    return {
      tenantId: props.tenantId,
      groupId: props.groupId,
      idpGroupId: props.idpGroupId,
      source: props.source,
      displayName: props.displayName,
      email: props.email,
      lastSyncAt: this.parseDateTime(props.lastSyncAt),
      createdAt: this.parseDateTime(props.createdAt) || new Date(),
    };
  }

  /**
   * Parse Neo4j Document node to DocumentNode type
   */
  private parseDocumentNode(node: any): DocumentNode {
    const props = node.properties;
    return {
      tenantId: props.tenantId,
      documentId: props.documentId,
      sourceId: props.sourceId,
      source: props.source,
      name: props.name,
      path: props.path,
      publicInDomain: props.publicInDomain || false,
      publicEverywhere: props.publicEverywhere || false,
      lastPermissionCrawlAt: this.parseDateTime(props.lastPermissionCrawlAt),
      createdAt: this.parseDateTime(props.createdAt) || new Date(),
    };
  }

  /**
   * Parse Neo4j Domain node to DomainNode type
   */
  private parseDomainNode(node: any): DomainNode {
    const props = node.properties;
    return {
      tenantId: props.tenantId,
      domain: props.domain,
      verified: props.verified || false,
      verificationMethod: props.verificationMethod,
      verifiedAt: this.parseDateTime(props.verifiedAt),
      createdAt: this.parseDateTime(props.createdAt) || new Date(),
    };
  }

  /**
   * Parse Neo4j DateTime to JavaScript Date
   */
  private parseDateTime(value: any): Date | undefined {
    if (!value) return undefined;
    // Neo4j DateTime has toStandardDate() method
    if (typeof value.toStandardDate === 'function') {
      return value.toStandardDate();
    }
    return new Date(value);
  }

  /**
   * Convert Neo4j Integer to JavaScript number
   */
  private toNumber(value: any): number {
    if (value instanceof Integer) {
      return value.toNumber();
    }
    return value || 0;
  }
}
