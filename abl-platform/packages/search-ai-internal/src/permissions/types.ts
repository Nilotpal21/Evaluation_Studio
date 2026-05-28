/**
 * Neo4j Permission Graph Type Definitions
 *
 * Type-safe interfaces for all Neo4j nodes, relationships, and query results
 * in the SearchAI permission graph.
 *
 * @see neo4j-permission-schema.md for complete schema documentation
 */

// ============================================================================
// Node Types
// ============================================================================

/**
 * User Node
 *
 * Represents an end-user identity from the Identity Provider (IDP).
 * Email is the universal identity key across all systems.
 */
export interface UserNode {
  // Compound primary key
  tenantId: string;
  email: string; // MUST be lowercase

  // IDP metadata
  idpUserId?: string; // IDP-specific ID (e.g., Azure AD object ID)
  idpProvider?: 'azuread' | 'okta' | 'google';
  displayName?: string;

  // Derived fields
  domain: string; // Extracted from email (lowercase)

  // Status tracking
  status: 'active' | 'suspended' | 'deleted';
  lastSyncAt?: Date;
  createdAt: Date;
}

/**
 * Group Node
 *
 * Represents a security group from IDP or connector.
 * Groups can be nested within other groups (unlimited depth).
 */
export interface GroupNode {
  // Compound primary key
  tenantId: string;
  groupId: string; // Composite: "{source}:{id}"

  // IDP metadata (if from IDP)
  idpGroupId?: string; // Azure AD group ID (null if from connector)
  source: 'azuread' | 'okta' | 'google' | 'sharepoint' | 'jira' | 'confluence';
  displayName?: string;
  email?: string;

  // Status tracking
  lastSyncAt?: Date;
  createdAt: Date;
}

/**
 * Document Node
 *
 * Represents a searchable document from a connector.
 * Links to MongoDB SearchDocument via documentId.
 */
export interface DocumentNode {
  // Compound primary key
  tenantId: string;
  documentId: string; // SearchDocument._id (MongoDB)

  // Connector metadata
  sourceId: string; // Connector ID (ConnectorConfig._id)
  source: 'sharepoint' | 'jira' | 'confluence';

  // Document metadata
  name?: string;
  path?: string;

  // Permission flags (optimization)
  publicInDomain: boolean;
  publicEverywhere: boolean;

  // Tracking
  lastPermissionCrawlAt?: Date;
  createdAt: Date;
}

/**
 * Domain Node
 *
 * Represents a verified email domain for domain-scoped permissions.
 */
export interface DomainNode {
  // Compound primary key
  tenantId: string;
  domain: string; // MUST be lowercase (e.g., "contoso.com")

  // Verification metadata
  verified: boolean;
  verificationMethod: 'dns' | 'email' | 'manual' | 'idp-trust';
  verifiedAt?: Date;

  // Tracking
  createdAt: Date;
}

// ============================================================================
// Relationship Types
// ============================================================================

/**
 * MEMBER_OF Relationship Properties
 *
 * Can be:
 * - User → Group (user belongs to group)
 * - Group → Group (nested group)
 */
export interface MemberOfRelationship {
  source: 'azuread' | 'okta' | 'google' | 'sharepoint' | 'jira' | 'confluence';
  syncedAt: Date;
}

/**
 * HAS_PERMISSION Relationship Properties
 *
 * Can be:
 * - User → Document (direct permission)
 * - Group → Document (group permission, applies to all members)
 */
export interface HasPermissionRelationship {
  role: 'read' | 'write' | 'owner';
  source: 'sharepoint' | 'jira' | 'confluence';
  grantedAt: Date;
}

// ============================================================================
// Query Result Types
// ============================================================================

/**
 * Result of Query 1: Get all groups for user
 */
export interface UserGroupsResult {
  groupId: string; // Composite: "{source}:{id}"
}

/**
 * Result of Query 2: Get all accessible documents for user
 */
export interface AccessibleDocumentsResult {
  documentIds: string[];
}

/**
 * Result of Query 3: Get flattened permissions for document
 */
export interface FlattenedPermissions {
  allowedUsers: string[]; // User emails
  allowedGroups: string[]; // Group IDs
  allowedDomains: string[]; // Domain names
  publicInDomain: boolean;
  publicEverywhere: boolean;
  source: string; // "sharepoint", "google-drive", "manual", "azuread", "okta", "google", etc.
}

// ============================================================================
// Service Input Types
// ============================================================================

/**
 * Input for creating/updating a User node
 */
export interface CreateUserInput {
  tenantId: string;
  email: string; // Will be normalized to lowercase
  idpUserId?: string;
  idpProvider?: 'azuread' | 'okta' | 'google';
  displayName?: string;
  status?: 'active' | 'suspended' | 'deleted';
}

/**
 * Input for creating/updating a Group node
 */
export interface CreateGroupInput {
  tenantId: string;
  groupId: string; // Composite: "{source}:{id}"
  idpGroupId?: string;
  source: 'azuread' | 'okta' | 'google' | 'sharepoint' | 'jira' | 'confluence';
  displayName?: string;
  email?: string;
}

/**
 * Input for creating/updating a Document node
 */
export interface CreateDocumentInput {
  tenantId: string;
  documentId: string;
  sourceId: string;
  source: 'sharepoint' | 'jira' | 'confluence';
  name?: string;
  path?: string;
  publicInDomain: boolean;
  publicEverywhere: boolean;
}

/**
 * Input for creating/updating a Domain node
 */
export interface CreateDomainInput {
  tenantId: string;
  domain: string; // Will be normalized to lowercase
  verified: boolean;
  verificationMethod: 'dns' | 'email' | 'manual' | 'idp-trust';
}

/**
 * Input for setting MEMBER_OF relationship
 */
export interface SetMembershipInput {
  tenantId: string;
  memberEmail?: string; // If User → Group
  memberGroupId?: string; // If Group → Group
  parentGroupId: string;
  source: 'azuread' | 'okta' | 'google' | 'sharepoint' | 'jira' | 'confluence';
}

/**
 * Input for setting HAS_PERMISSION relationship
 */
export interface SetPermissionInput {
  tenantId: string;
  userEmail?: string; // If User → Document
  groupId?: string; // If Group → Document
  documentId: string;
  role: 'read' | 'write' | 'owner';
  source: 'sharepoint' | 'jira' | 'confluence';
}

// ============================================================================
// Batch Operation Types
// ============================================================================

/**
 * Batch upsert users (for IDP sync)
 */
export interface BatchUpsertUsersInput {
  tenantId: string;
  users: CreateUserInput[];
}

/**
 * Batch upsert groups (for IDP sync)
 */
export interface BatchUpsertGroupsInput {
  tenantId: string;
  groups: CreateGroupInput[];
}

/**
 * Batch set memberships (for IDP sync)
 */
export interface BatchSetMembershipsInput {
  tenantId: string;
  memberships: SetMembershipInput[];
}

/**
 * Batch set permissions (for connector permission crawl)
 */
export interface BatchSetPermissionsInput {
  tenantId: string;
  permissions: SetPermissionInput[];
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Neo4j connection configuration
 */
export interface Neo4jConnectionConfig {
  uri: string; // e.g., 'neo4j://localhost:7687'
  username: string;
  password: string;
  database?: string; // Default: 'neo4j'
  maxConnectionPoolSize?: number; // Default: 50
  connectionTimeout?: number; // Default: 30000ms
}

/**
 * Permission graph query options
 */
export interface PermissionQueryOptions {
  tenantId: string;
  maxDepth?: number; // Max group nesting depth (default: 20)
  limit?: number; // Max results to return (default: 10000)
  includeDeleted?: boolean; // Include deleted users/groups (default: false)
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Neo4j operation error with context
 */
export interface Neo4jPermissionError extends Error {
  code: string;
  tenantId?: string;
  operation: string;
  context?: Record<string, any>;
}

/**
 * Cycle detected in group hierarchy
 */
export interface GroupCycleError extends Neo4jPermissionError {
  code: 'GROUP_CYCLE_DETECTED';
  cycleGroupIds: string[];
}

/**
 * Group depth limit exceeded
 */
export interface GroupDepthLimitError extends Neo4jPermissionError {
  code: 'GROUP_DEPTH_LIMIT_EXCEEDED';
  maxDepth: number;
  actualDepth: number;
}

// ============================================================================
// Statistics Types
// ============================================================================

/**
 * Permission graph statistics for a tenant
 */
export interface PermissionGraphStats {
  tenantId: string;
  userCount: number;
  groupCount: number;
  documentCount: number;
  domainCount: number;
  membershipCount: number; // Total MEMBER_OF relationships
  permissionCount: number; // Total HAS_PERMISSION relationships
  averageGroupDepth: number;
  maxGroupDepth: number;
  lastUpdated: Date;
}

/**
 * User permission summary
 */
export interface UserPermissionSummary {
  email: string;
  directPermissions: number; // Direct User → Document
  groupPermissions: number; // Via groups
  domainPermissions: number; // Via domain-scoped
  publicPermissions: number; // Public documents
  totalAccessibleDocuments: number;
  groups: string[]; // All groups (direct + inherited)
}

/**
 * Document permission summary
 */
export interface DocumentPermissionSummary {
  documentId: string;
  directUsers: number; // Users with direct permission
  groups: number; // Groups with permission
  domains: number; // Domains (if public in domain)
  publicInDomain: boolean;
  publicEverywhere: boolean;
  totalAccessibleUsers: number; // Estimated (users + group members)
}
