/**
 * SearchAI Permission Module
 *
 * Permission storage and query for enterprise authorization.
 *
 * Two implementations:
 * - PermissionGraphService/Client: Neo4j-based (legacy, being replaced)
 * - MongoPermissionStore: MongoDB-based (new, replaces Neo4j)
 *
 * New code should use MongoPermissionStore.
 */

// ── MongoDB permission store (new — replaces Neo4j) ─────────────────────
export { MongoPermissionStore } from './mongo-permission-store.js';
export type {
  MongoPermissionStoreConfig,
  BlindIndexFn,
  EncryptFn,
} from './mongo-permission-store.js';
export {
  computeEffectiveGroups,
  loadGroupHierarchy,
  type GroupHierarchyMap,
} from './effective-groups-compute.js';

// ── Neo4j permission graph (legacy — retained for backward compat) ──────
export { PermissionGraphClient } from './permission-graph-client.js';
export { PermissionGraphService } from './permission-graph-service.js';
export type { PermissionGraphServiceConfig } from './permission-graph-service.js';

export type {
  // Node types
  UserNode,
  GroupNode,
  DocumentNode,
  DomainNode,
  // Relationship types
  MemberOfRelationship,
  HasPermissionRelationship,
  // Query result types
  UserGroupsResult,
  AccessibleDocumentsResult,
  FlattenedPermissions,
  // Input types
  CreateUserInput,
  CreateGroupInput,
  CreateDocumentInput,
  CreateDomainInput,
  SetMembershipInput,
  SetPermissionInput,
  // Batch operation types
  BatchUpsertUsersInput,
  BatchUpsertGroupsInput,
  BatchSetMembershipsInput,
  BatchSetPermissionsInput,
  // Configuration types
  Neo4jConnectionConfig,
  PermissionQueryOptions,
  // Error types
  Neo4jPermissionError,
  GroupCycleError,
  GroupDepthLimitError,
  // Statistics types
  PermissionGraphStats,
  UserPermissionSummary,
  DocumentPermissionSummary,
} from './types.js';
