/**
 * MongoDB Permission Store
 *
 * Drop-in replacement for PermissionGraphService (Neo4j).
 * Implements the same public API using MongoDB collections:
 *   - contacts (extended with sourceIdentities + acl)
 *   - acl_group_hierarchy
 *   - acl_document_permissions
 *
 * Key differences from Neo4j:
 * - getUserGroups() reads pre-computed effectiveGroups (O(1) vs O(depth) traversal)
 * - getFlattenedPermissions() reads from acl_document_permissions (1 findOne vs 4 OPTIONAL MATCH)
 * - Fails closed: empty groups on error (not publicEverywhere: true)
 *
 * @see effective-groups-compute.ts for BFS pre-computation
 */

import crypto from 'node:crypto';
import { createLogger } from '@agent-platform/shared-observability';
import type {
  CreateUserInput,
  CreateGroupInput,
  CreateDocumentInput,
  SetMembershipInput,
  SetPermissionInput,
  FlattenedPermissions,
} from './types.js';
import {
  loadGroupHierarchy,
  computeEffectiveGroups,
  type GroupHierarchyMap,
} from './effective-groups-compute.js';

const log = createLogger('mongo-permission-store');

// ============================================================================
// Types
// ============================================================================

/** Minimal model interfaces — avoids importing Mongoose directly */
interface LeanDoc<T> {
  lean: () => Promise<T | null>;
}
interface FindOneOp<T> {
  findOne: (filter: Record<string, unknown>, projection?: Record<string, unknown>) => LeanDoc<T>;
}
interface FindOp<T> {
  find: (filter: Record<string, unknown>) => {
    select: (fields: Record<string, number>) => {
      lean: () => Promise<T[]>;
      skip: (n: number) => { limit: (n: number) => { lean: () => Promise<T[]> } };
    };
  };
}
interface UpdateOneOp {
  updateOne: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{ modifiedCount: number; upsertedCount: number }>;
}
interface BulkWriteOp {
  bulkWrite: (
    ops: Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
      };
    }>,
  ) => Promise<{ modifiedCount: number }>;
}
interface DeleteOneOp {
  deleteOne: (filter: Record<string, unknown>) => Promise<{ deletedCount: number }>;
}

/** Aggregate model type for the operations we need */
type MongoModel<T> = FindOneOp<T> & FindOp<T> & UpdateOneOp & BulkWriteOp & DeleteOneOp;

/**
 * Compute a blind index (HMAC-SHA256 hex) for encrypted contact lookup.
 * Provided by the caller from @agent-platform/shared-encryption.
 */
export type BlindIndexFn = (tenantId: string, value: string) => string;

/**
 * Encrypt a plaintext value for storage (AES-256-GCM).
 * Optional — when provided, enables creation of new contacts with encrypted identities.
 */
export type EncryptFn = (tenantId: string, value: string) => string;

export interface MongoPermissionStoreConfig {
  /** Mongoose model for contacts collection */
  contactModel: MongoModel<any>;
  /** Mongoose model for acl_group_hierarchy collection */
  groupHierarchyModel: MongoModel<any>;
  /** Mongoose model for acl_document_permissions collection */
  documentPermissionsModel: MongoModel<any>;
  /** Compute blind index for contact email lookup (required for correct contact matching) */
  blindIndexFn: BlindIndexFn;
  /** Encrypt values for storage — needed when creating new contacts from IdP sync */
  encryptFn?: EncryptFn;
}

// ============================================================================
// Singleton
// ============================================================================

let instance: MongoPermissionStore | null = null;

// ============================================================================
// Service
// ============================================================================

export class MongoPermissionStore {
  private contactModel: MongoModel<any>;
  private groupHierarchyModel: MongoModel<any>;
  private documentPermissionsModel: MongoModel<any>;
  private blindIndexFn: BlindIndexFn;
  private encryptFn?: EncryptFn;

  /** Per-tenant group hierarchy cache (loaded once per sync cycle) */
  private hierarchyCache: Map<string, { map: GroupHierarchyMap; loadedAt: number }> = new Map();
  private static readonly HIERARCHY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  /** Max tenants cached — prevents unbounded memory growth (~2MB per tenant hierarchy) */
  private static readonly MAX_HIERARCHY_CACHE_ENTRIES = 50;

  constructor(config: MongoPermissionStoreConfig) {
    this.contactModel = config.contactModel;
    this.groupHierarchyModel = config.groupHierarchyModel;
    this.documentPermissionsModel = config.documentPermissionsModel;
    this.blindIndexFn = config.blindIndexFn;
    this.encryptFn = config.encryptFn;
  }

  static getInstance(config?: MongoPermissionStoreConfig): MongoPermissionStore {
    if (!instance) {
      if (!config) {
        throw new Error('MongoPermissionStore: config required for first initialization');
      }
      instance = new MongoPermissionStore(config);
    }
    return instance;
  }

  static resetInstance(): void {
    instance = null;
  }

  // ==========================================================================
  // Health Check
  // ==========================================================================

  async healthCheck(): Promise<{
    healthy: boolean;
    status: string;
    details: { connected: boolean };
  }> {
    try {
      // Simple ping: try to count documents (will fail if MongoDB is down)
      await this.groupHierarchyModel.findOne({}).lean();
      return { healthy: true, status: 'healthy', details: { connected: true } };
    } catch {
      return { healthy: false, status: 'disconnected', details: { connected: false } };
    }
  }

  // ==========================================================================
  // User Operations (writes to contacts collection)
  // ==========================================================================

  /**
   * Upsert a user as a contact card.
   * Called by IdP sync workers and SharePoint permission crawler.
   *
   * Three-step resolution:
   *   1. Find contact by existing sourceIdentity (source + sourceUserId) → update in-place
   *   2. Find contact by email blind index (runtime or other sync created it) → add sourceIdentity
   *   3. No contact found → create new "employee" contact with identity + sourceIdentity + ACL
   *
   * Uses blindIndexFn for encrypted lookup — never queries by plaintext email.
   */
  async upsertUser(input: CreateUserInput): Promise<void> {
    const email = input.email.toLowerCase().trim();
    const source = input.idpProvider ?? 'unknown';
    const blindIndex = this.blindIndexFn(input.tenantId, email);
    const domain = email.split('@')[1] || null;
    const encryptedEmail = this.encryptFn ? this.encryptFn(input.tenantId, email) : null;
    const now = new Date();
    const isDeleted = input.status === 'deleted';

    try {
      // ── Step 1: Update contact that already has this sourceIdentity ──────
      const sourceMatch = await this.contactModel.updateOne(
        {
          tenantId: input.tenantId,
          'sourceIdentities.source': source,
          'sourceIdentities.sourceUserId': input.idpUserId ?? email,
        },
        {
          $set: {
            'sourceIdentities.$.resolved': !isDeleted,
            'sourceIdentities.$.lastSyncAt': now,
            'sourceIdentities.$.blindIndex': blindIndex,
            ...(encryptedEmail && { 'sourceIdentities.$.encryptedEmail': encryptedEmail }),
            ...(input.displayName && {
              'sourceIdentities.$.displayName': input.displayName,
              displayName: input.displayName,
            }),
          },
        },
      );

      if (sourceMatch.modifiedCount > 0) {
        log.debug('Updated existing source identity on contact', {
          tenantId: input.tenantId,
          email,
          source,
        });
        return;
      }

      // ── Step 2: Find contact by email blind index (runtime- or other-sync-created) ──
      const newSourceIdentity = {
        source,
        sourceUserId: input.idpUserId ?? email,
        encryptedEmail,
        blindIndex,
        displayName: input.displayName ?? null,
        resolved: !isDeleted,
        lastSyncAt: now,
      };

      const existingContact = await this.contactModel
        .findOne(
          {
            tenantId: input.tenantId,
            $or: [
              { 'identities.blindIndex': blindIndex },
              { 'sourceIdentities.blindIndex': blindIndex },
            ],
            deletedAt: null,
          },
          { _id: 1, acl: 1 },
        )
        .lean();

      if (existingContact) {
        // Link sourceIdentity + ensure ACL is initialized
        const updateFields: Record<string, unknown> = {};
        if (input.displayName) updateFields.displayName = input.displayName;
        if (!existingContact.acl) {
          updateFields.acl = {
            effectiveGroups: [],
            directGroups: [],
            domain,
            effectiveGroupsComputedAt: null,
            syncVersion: 0,
          };
        }

        await this.contactModel.updateOne(
          { _id: existingContact._id, tenantId: input.tenantId },
          {
            $addToSet: { sourceIdentities: newSourceIdentity },
            ...(Object.keys(updateFields).length > 0 && { $set: updateFields }),
          },
        );

        log.debug('Linked source identity to existing contact', {
          tenantId: input.tenantId,
          email,
          source,
          contactId: existingContact._id,
        });
        return;
      }

      // ── Step 3: Create new contact (user in IdP but never chatted) ──────
      const contactId = crypto.randomUUID();

      await this.contactModel.updateOne(
        { _id: contactId },
        {
          $setOnInsert: {
            tenantId: input.tenantId,
            type: 'employee',
            identities: [
              {
                type: 'email',
                encryptedValue: encryptedEmail ?? email,
                blindIndex,
                verified: true,
                verifiedAt: now,
                verifiedVia: 'provider',
                channel: null,
              },
            ],
            sourceIdentities: [newSourceIdentity],
            channelHistory: [],
            sessionCount: 0,
            mergedInto: null,
            displayName: input.displayName ?? null,
            department: null,
            employeeId: null,
            company: null,
            accountRef: null,
            channel: null,
            metadata: null,
            tags: [],
            firstSeenAt: now,
            lastSeenAt: now,
            deletedAt: null,
            encryptionSalt: null,
            contactContext: null,
            acl: {
              effectiveGroups: [],
              directGroups: [],
              domain,
              effectiveGroupsComputedAt: null,
              syncVersion: 0,
            },
            _v: 1,
          },
        },
        { upsert: true },
      );

      log.debug('Created new contact for IdP user', {
        tenantId: input.tenantId,
        email,
        source,
        contactId,
      });
    } catch (error) {
      log.error('Failed to upsert user', {
        tenantId: input.tenantId,
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ==========================================================================
  // Group Operations (writes to acl_group_hierarchy)
  // ==========================================================================

  /**
   * Upsert a group in the hierarchy.
   * Called by group sync workers.
   */
  async upsertGroup(input: CreateGroupInput): Promise<void> {
    try {
      await this.groupHierarchyModel.updateOne(
        { tenantId: input.tenantId, groupId: input.groupId },
        {
          $set: {
            source: input.source,
            displayName: input.displayName ?? null,
            email: input.email ?? null,
            lastSyncAt: new Date(),
          },
        },
        { upsert: true },
      );

      // Invalidate hierarchy cache for this tenant
      this.hierarchyCache.delete(input.tenantId);

      log.debug('Upserted group', {
        tenantId: input.tenantId,
        groupId: input.groupId,
        source: input.source,
      });
    } catch (error) {
      log.error('Failed to upsert group', {
        tenantId: input.tenantId,
        groupId: input.groupId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ==========================================================================
  // Document Operations (writes to acl_document_permissions)
  // ==========================================================================

  /**
   * Upsert a document's permission metadata.
   * Called by connector permission crawlers.
   */
  async upsertDocument(input: CreateDocumentInput): Promise<void> {
    try {
      await this.documentPermissionsModel.updateOne(
        { tenantId: input.tenantId, documentId: input.documentId },
        {
          $set: {
            source: input.source,
            publicInDomain: input.publicInDomain,
            publicEverywhere: input.publicEverywhere,
            lastPermissionCrawlAt: new Date(),
          },
          $setOnInsert: {
            allowedUsers: [],
            allowedGroups: [],
            allowedDomains: [],
          },
        },
        { upsert: true },
      );
    } catch (error) {
      log.error('Failed to upsert document permissions', {
        tenantId: input.tenantId,
        documentId: input.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    const result = await this.documentPermissionsModel.deleteOne({ tenantId, documentId });
    return result.deletedCount > 0;
  }

  // ==========================================================================
  // Membership Operations
  // ==========================================================================

  /**
   * Set a user's membership in a group.
   * Adds the group to the contact's acl.directGroups (idempotent).
   *
   * For user→group: finds the contact by email blind index (not plaintext email).
   * Also ensures the ACL subdocument exists on the contact before adding groups.
   *
   * Uses a `$ne` guard on `acl.directGroups.group` to prevent duplicate entries
   * on re-crawl. Plain `$addToSet` compared full subdocuments including `addedAt`,
   * so each crawl run produced a "unique" object — causing unbounded array growth.
   */
  async setMembership(input: SetMembershipInput): Promise<void> {
    if (input.memberEmail) {
      // User → Group membership: look up contact by email blind index
      const blindIndex = this.blindIndexFn(input.tenantId, input.memberEmail.toLowerCase().trim());
      const domain = input.memberEmail.toLowerCase().trim().split('@')[1] || null;

      // First ensure the contact has an ACL subdocument (may be null if runtime-created)
      await this.contactModel.updateOne(
        {
          tenantId: input.tenantId,
          $or: [
            { 'identities.blindIndex': blindIndex },
            { 'sourceIdentities.blindIndex': blindIndex },
          ],
          acl: null,
        },
        {
          $set: {
            acl: {
              effectiveGroups: [],
              directGroups: [],
              domain,
              effectiveGroupsComputedAt: null,
              syncVersion: 0,
            },
          },
        },
      );

      // Add the group to acl.directGroups ONLY if not already present.
      // The `$ne` guard prevents duplicates by checking that no existing
      // directGroups entry has the same group ID before pushing.
      await this.contactModel.updateOne(
        {
          tenantId: input.tenantId,
          $or: [
            { 'identities.blindIndex': blindIndex },
            { 'sourceIdentities.blindIndex': blindIndex },
          ],
          'acl.directGroups.group': { $ne: input.parentGroupId },
        },
        {
          $push: {
            'acl.directGroups': {
              group: input.parentGroupId,
              source: input.source,
              addedAt: new Date(),
            },
          },
        },
      );
    } else if (input.memberGroupId) {
      // Group → Group membership (parent-child in hierarchy)
      await this.groupHierarchyModel.updateOne(
        { tenantId: input.tenantId, groupId: input.memberGroupId },
        { $addToSet: { parentGroups: input.parentGroupId } },
        { upsert: true },
      );

      await this.groupHierarchyModel.updateOne(
        { tenantId: input.tenantId, groupId: input.parentGroupId },
        { $addToSet: { childGroups: input.memberGroupId } },
        { upsert: true },
      );

      // Invalidate hierarchy cache
      this.hierarchyCache.delete(input.tenantId);
    }
  }

  /**
   * Remove a user's membership from a group.
   * Finds the contact by email blind index, then pulls the group from acl.directGroups.
   */
  async removeMembership(input: SetMembershipInput): Promise<void> {
    if (input.memberEmail) {
      // User → Group removal: find contact by email blind index, pull from directGroups
      const blindIndex = this.blindIndexFn(input.tenantId, input.memberEmail.toLowerCase().trim());

      await this.contactModel.updateOne(
        {
          tenantId: input.tenantId,
          $or: [
            { 'identities.blindIndex': blindIndex },
            { 'sourceIdentities.blindIndex': blindIndex },
          ],
        },
        {
          $pull: {
            'acl.directGroups': { group: input.parentGroupId },
          } as any, // Mongoose typing doesn't support $pull on nested array subdocuments
        },
      );
    } else if (input.memberGroupId) {
      // Group → Group removal: mirror setMembership's Group→Group logic
      // Remove parentGroupId from memberGroup's parentGroups
      await this.groupHierarchyModel.updateOne(
        { tenantId: input.tenantId, groupId: input.memberGroupId },
        { $pull: { parentGroups: input.parentGroupId } } as any,
      );

      // Remove memberGroupId from parentGroup's childGroups
      await this.groupHierarchyModel.updateOne(
        { tenantId: input.tenantId, groupId: input.parentGroupId },
        { $pull: { childGroups: input.memberGroupId } } as any,
      );

      // Invalidate hierarchy cache — group structure changed
      this.hierarchyCache.delete(input.tenantId);
    }
  }

  // ==========================================================================
  // Permission Operations (on documents)
  // ==========================================================================

  /**
   * Set permission on a document for a user or group (idempotent).
   * Called by connector permission crawlers.
   *
   * Uses a two-step approach:
   * 1. Upsert the document if it doesn't exist (with empty arrays)
   * 2. Push the user/group only if not already present (`$ne` guard)
   *
   * This prevents duplicate entries when the same document is re-crawled.
   * Plain `$addToSet` compared full subdocuments including `grantedAt`,
   * so each crawl produced "unique" objects — causing unbounded growth.
   *
   * NOTE: The SharePoint crawler uses a reconcile pattern (removeAll + re-add),
   * which also prevents duplicates. But this method must be idempotent on its
   * own for callers that don't use the reconcile pattern.
   *
   * NOTE: Emails are stored in PLAINTEXT in acl_document_permissions.allowedUsers.
   * This is architecturally necessary for OpenSearch matching — the runtime builds
   * `{ term: { 'permissions.allowedUsers': email } }` for the 4-clause bool filter.
   * This differs from the contact model which uses encrypted emails with blind indexes.
   * The trade-off is acceptable because acl_document_permissions only stores the fact
   * that an email has access to a document, not PII beyond the email address itself.
   */
  async setPermission(input: SetPermissionInput): Promise<void> {
    const now = new Date();

    if (input.userEmail) {
      const emailLower = input.userEmail.toLowerCase();

      // Ensure the document exists with default arrays
      await this.documentPermissionsModel.updateOne(
        { tenantId: input.tenantId, documentId: input.documentId },
        {
          $setOnInsert: {
            source: input.source,
            allowedUsers: [],
            allowedGroups: [],
            allowedDomains: [],
            publicInDomain: false,
            publicEverywhere: false,
            lastPermissionCrawlAt: now,
          },
        },
        { upsert: true },
      );

      // Push user only if email not already in the array
      await this.documentPermissionsModel.updateOne(
        {
          tenantId: input.tenantId,
          documentId: input.documentId,
          'allowedUsers.email': { $ne: emailLower },
        },
        {
          $push: {
            allowedUsers: {
              email: emailLower,
              role: input.role,
              grantedAt: now,
            },
          },
        },
      );
    }

    if (input.groupId) {
      // Ensure the document exists with default arrays
      await this.documentPermissionsModel.updateOne(
        { tenantId: input.tenantId, documentId: input.documentId },
        {
          $setOnInsert: {
            source: input.source,
            allowedUsers: [],
            allowedGroups: [],
            allowedDomains: [],
            publicInDomain: false,
            publicEverywhere: false,
            lastPermissionCrawlAt: now,
          },
        },
        { upsert: true },
      );

      // Push group only if groupId not already in the array
      await this.documentPermissionsModel.updateOne(
        {
          tenantId: input.tenantId,
          documentId: input.documentId,
          'allowedGroups.groupId': { $ne: input.groupId },
        },
        {
          $push: {
            allowedGroups: {
              groupId: input.groupId,
              role: input.role,
              grantedAt: now,
            },
          },
        },
      );
    }
  }

  /**
   * Remove a specific permission from a document for a user or group.
   *
   * For bulk reconciliation (remove-all-then-re-add pattern), prefer
   * removeAllDocumentPermissions() which is more efficient.
   * This method handles targeted single-user or single-group removal.
   */
  async removePermission(input: SetPermissionInput): Promise<void> {
    if (input.userEmail) {
      await this.documentPermissionsModel.updateOne(
        { tenantId: input.tenantId, documentId: input.documentId },
        {
          $pull: {
            allowedUsers: { email: input.userEmail.toLowerCase() },
          },
        } as any, // Mongoose typing for $pull on subdocument arrays
      );
    }

    if (input.groupId) {
      await this.documentPermissionsModel.updateOne(
        { tenantId: input.tenantId, documentId: input.documentId },
        {
          $pull: {
            allowedGroups: { groupId: input.groupId },
          },
        } as any, // Mongoose typing for $pull on subdocument arrays
      );
    }
  }

  /**
   * Remove all permissions from a document (reconcile pattern).
   * Clears allowedUsers and allowedGroups arrays.
   */
  async removeAllDocumentPermissions(tenantId: string, documentId: string): Promise<number> {
    const result = await this.documentPermissionsModel.updateOne(
      { tenantId, documentId },
      {
        $set: {
          allowedUsers: [],
          allowedGroups: [],
          allowedDomains: [],
        },
      },
    );
    return result.modifiedCount;
  }

  async setPublicInDomain(tenantId: string, documentId: string, domain: string): Promise<void> {
    await this.documentPermissionsModel.updateOne(
      { tenantId, documentId },
      {
        $set: { publicInDomain: true },
        $addToSet: { allowedDomains: domain.toLowerCase() },
      },
      { upsert: true },
    );
  }

  // ==========================================================================
  // Permission Queries (Read Path — replaces Neo4j traversals)
  // ==========================================================================

  /**
   * Get a user's effective groups (pre-computed, O(1)).
   * Replaces Neo4j MEMBER_OF*1..20 traversal.
   *
   * Looks up the contact by email blind index (identities[] or sourceIdentities[]),
   * then returns the pre-computed acl.effectiveGroups array.
   *
   * @param tenantId - Tenant ID
   * @param email - User email (used to compute blind index for lookup)
   * @returns Array of effective group IDs (pre-computed by BFS)
   */
  async getUserGroups(tenantId: string, email: string): Promise<string[]> {
    try {
      const blindIndex = this.blindIndexFn(tenantId, email.toLowerCase().trim());

      const contact = await this.contactModel
        .findOne(
          {
            tenantId,
            $or: [
              { 'identities.blindIndex': blindIndex },
              { 'sourceIdentities.blindIndex': blindIndex },
            ],
            deletedAt: null,
          },
          { 'acl.effectiveGroups': 1 },
        )
        .lean();

      if (!contact?.acl?.effectiveGroups) {
        return [];
      }

      return contact.acl.effectiveGroups;
    } catch (error) {
      log.error('Failed to get user groups — fail-closed (empty groups)', {
        tenantId,
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      // FAIL-CLOSED: empty groups = user sees only public docs
      return [];
    }
  }

  /**
   * Get flattened permissions for a document (for OpenSearch indexing).
   * Replaces Neo4j's 4-OPTIONAL-MATCH Cypher query.
   *
   * @param tenantId - Tenant ID
   * @param documentId - Document ID
   * @returns Flattened permissions for stamping on OpenSearch chunks
   */
  async getFlattenedPermissions(
    tenantId: string,
    documentId: string,
  ): Promise<FlattenedPermissions> {
    try {
      const doc = await this.documentPermissionsModel.findOne({ tenantId, documentId }).lean();

      if (!doc) {
        // No permission record = fail-closed (restricted)
        return {
          allowedUsers: [],
          allowedGroups: [],
          allowedDomains: [],
          publicInDomain: false,
          publicEverywhere: false,
          source: 'none',
        };
      }

      return {
        allowedUsers: (doc.allowedUsers ?? []).map((u: { email: string }) => u.email),
        allowedGroups: (doc.allowedGroups ?? []).map((g: { groupId: string }) => g.groupId),
        allowedDomains: doc.allowedDomains ?? [],
        publicInDomain: doc.publicInDomain ?? false,
        publicEverywhere: doc.publicEverywhere ?? false,
        source: doc.source ?? 'unknown',
      };
    } catch (error) {
      log.error('Failed to get document permissions — fail-closed', {
        tenantId,
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // FAIL-CLOSED: no permissions = document restricted
      return {
        allowedUsers: [],
        allowedGroups: [],
        allowedDomains: [],
        publicInDomain: false,
        publicEverywhere: false,
        source: 'fallback-restricted',
      };
    }
  }

  // ==========================================================================
  // BFS Recomputation
  // ==========================================================================

  /**
   * Recompute effective groups for a specific contact.
   *
   * @param tenantId - Tenant ID
   * @param contactId - Contact _id
   */
  async recomputeEffectiveGroupsForContact(tenantId: string, contactId: string): Promise<void> {
    const contact = await this.contactModel
      .findOne({ _id: contactId, tenantId }, { 'acl.directGroups': 1 })
      .lean();

    if (!contact?.acl?.directGroups) {
      return;
    }

    const hierarchy = await this.getHierarchy(tenantId);
    const directGroupIds = contact.acl.directGroups.map((dg: { group: string }) => dg.group);
    const effectiveGroups = computeEffectiveGroups(directGroupIds, hierarchy);

    await this.contactModel.updateOne(
      { _id: contactId, tenantId },
      {
        $set: {
          'acl.effectiveGroups': effectiveGroups,
          'acl.effectiveGroupsComputedAt': new Date(),
        },
        $inc: { 'acl.syncVersion': 1 },
      },
    );

    log.debug('Recomputed effective groups for contact', {
      tenantId,
      contactId,
      directCount: directGroupIds.length,
      effectiveCount: effectiveGroups.length,
    });
  }

  /**
   * Recompute effective groups for ALL contacts in a tenant.
   * Called after group hierarchy changes (parent/child updates).
   *
   * Uses skip/limit pagination + bulkWrite batches to avoid loading all
   * contacts into memory at once (O(batchSize) memory instead of O(N)).
   */
  async recomputeEffectiveGroupsForTenant(tenantId: string): Promise<number> {
    const hierarchy = await this.getHierarchy(tenantId);
    const BATCH_SIZE = 500;
    let recomputedCount = 0;
    let skip = 0;

    // Process contacts in batches using skip/limit pagination
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const contacts = await this.contactModel
        .find({ tenantId, 'acl.directGroups.0': { $exists: true } })
        .select({ _id: 1, 'acl.directGroups': 1 })
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean();

      if (contacts.length === 0) break;

      const now = new Date();
      const bulkOps = contacts.map(
        (contact: { _id: string; acl?: { directGroups?: Array<{ group: string }> } }) => {
          const directGroupIds = (contact.acl?.directGroups ?? []).map(
            (dg: { group: string }) => dg.group,
          );
          const effectiveGroups = computeEffectiveGroups(directGroupIds, hierarchy);

          return {
            updateOne: {
              filter: { _id: contact._id, tenantId },
              update: {
                $set: {
                  'acl.effectiveGroups': effectiveGroups,
                  'acl.effectiveGroupsComputedAt': now,
                },
                $inc: { 'acl.syncVersion': 1 },
              },
            },
          };
        },
      );

      await this.contactModel.bulkWrite(bulkOps);
      recomputedCount += contacts.length;
      skip += BATCH_SIZE;
    }

    log.info('Recomputed effective groups for tenant', {
      tenantId,
      contactsRecomputed: recomputedCount,
    });

    return recomputedCount;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Get group hierarchy for a tenant (with in-memory caching + LRU eviction).
   *
   * Cache limits:
   *   - TTL: 5 minutes (stale entries replaced on access)
   *   - Max entries: 50 tenants (~100MB worst case at 2MB per hierarchy)
   *   - Eviction: oldest-loadedAt entry evicted when at capacity
   */
  private async getHierarchy(tenantId: string): Promise<GroupHierarchyMap> {
    const cached = this.hierarchyCache.get(tenantId);
    const now = Date.now();

    if (cached && now - cached.loadedAt < MongoPermissionStore.HIERARCHY_CACHE_TTL_MS) {
      return cached.map;
    }

    const map = await loadGroupHierarchy(tenantId, this.groupHierarchyModel as any);

    // Evict oldest entry if cache is at max capacity
    if (this.hierarchyCache.size >= MongoPermissionStore.MAX_HIERARCHY_CACHE_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.hierarchyCache) {
        if (entry.loadedAt < oldestTime) {
          oldestTime = entry.loadedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.hierarchyCache.delete(oldestKey);
      }
    }

    this.hierarchyCache.set(tenantId, { map, loadedAt: now });
    return map;
  }

  /**
   * Close / cleanup (for testing).
   */
  async close(): Promise<void> {
    this.hierarchyCache.clear();
    instance = null;
  }
}
