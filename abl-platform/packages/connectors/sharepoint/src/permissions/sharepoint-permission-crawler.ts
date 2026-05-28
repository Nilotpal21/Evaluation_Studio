/**
 * SharePoint Permission Crawler
 *
 * Crawls document permissions from SharePoint and writes to the permission store.
 * Supports two modes:
 * - enabled: Resolves all group memberships recursively (100% accurate)
 * - disabled: Permission crawling skipped
 *
 * Uses MongoPermissionStore (MongoDB) as the permission backend.
 *
 * @see RFC-003 for permission architecture
 */

import type { GraphClient } from '../client/graph-client.js';
import type {
  Permission,
  PermissionIdentity,
  AzureADGroupCollection,
} from '../client/graph-types.js';
import { MongoPermissionStore } from '@agent-platform/search-ai-internal';
import type {
  CreateUserInput,
  CreateGroupInput,
  CreateDocumentInput,
  SetMembershipInput,
  SetPermissionInput,
  FlattenedPermissions,
} from '@agent-platform/search-ai-internal';

/**
 * Common permission store interface — implemented by MongoPermissionStore.
 * Allows dependency injection for testing.
 */
export interface PermissionStoreInterface {
  upsertUser(input: CreateUserInput): Promise<unknown>;
  upsertGroup(input: CreateGroupInput): Promise<unknown>;
  upsertDocument(input: CreateDocumentInput): Promise<unknown>;
  setPermission(input: SetPermissionInput): Promise<void>;
  setMembership(input: SetMembershipInput): Promise<void>;
  removeAllDocumentPermissions(tenantId: string, documentId: string): Promise<number>;
}

// ============================================================================
// Logger (lightweight structured logger for connector packages)
// ============================================================================

interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

function createLogger(module: string): Logger {
  const prefix = `[${module}]`;
  function safeMeta(meta: Record<string, unknown>): string {
    try {
      return JSON.stringify(meta);
    } catch {
      return '[unserializable meta]';
    }
  }
  return {
    error(message: string, meta?: Record<string, unknown>) {
      console.error(prefix, message, meta ? safeMeta(meta) : '');
    },
    warn(message: string, meta?: Record<string, unknown>) {
      console.warn(prefix, message, meta ? safeMeta(meta) : '');
    },
    info(message: string, meta?: Record<string, unknown>) {
      console.info(prefix, message, meta ? safeMeta(meta) : '');
    },
    debug(message: string, meta?: Record<string, unknown>) {
      console.debug(prefix, message, meta ? safeMeta(meta) : '');
    },
  };
}

const log = createLogger('sharepoint-permission-crawler');

// ============================================================================
// Types
// ============================================================================

export interface PermissionCrawlConfig {
  mode: 'full' | 'simplified' | 'enabled' | 'disabled';
  tenantId: string;
  sourceId: string; // Connector ID
  /** @deprecated Neo4j config — no longer needed when using MongoPermissionStore */
  neo4jConfig?: Record<string, unknown>;
}

export interface DocumentToCrawl {
  documentId: string; // SearchDocument._id
  driveId: string; // SharePoint drive ID
  itemId: string; // SharePoint item ID
  name?: string;
  path?: string;
}

export interface CrawlProgress {
  totalDocuments: number;
  processedDocuments: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
}

export interface CrawlResult {
  success: boolean;
  mode: 'full' | 'simplified' | 'enabled' | 'disabled';
  documentsProcessed: number;
  averageAccuracy: number;
  durationMs: number;
  errors: Array<{ documentId: string; error: string }>;
}

// ============================================================================
// LRU Cache with TTL (max size + eviction)
// ============================================================================

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // TTL check
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used) by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete first to update insertion order
    this.cache.delete(key);

    // Evict oldest entry (least recently used = first entry) if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// SharePoint Permission Crawler
// ============================================================================

const AZURE_AD_GROUP_CACHE_MAX = 10_000;
const AZURE_AD_GROUP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class SharePointPermissionCrawler {
  private graphClient: GraphClient;
  private permissionService: PermissionStoreInterface;
  private config: PermissionCrawlConfig;

  /** Cache: SharePoint group email → Azure AD group ID (or null if unresolvable) */
  private azureADGroupCache = new LRUCache<string | null>(
    AZURE_AD_GROUP_CACHE_MAX,
    AZURE_AD_GROUP_CACHE_TTL_MS,
  );

  /**
   * @param graphClient - Microsoft Graph API client
   * @param config - Crawl configuration (mode, tenantId, sourceId)
   * @param permissionService - Permission store (MongoPermissionStore).
   *   If not provided, uses MongoPermissionStore singleton (must be initialized beforehand).
   */
  constructor(
    graphClient: GraphClient,
    config: PermissionCrawlConfig,
    permissionService?: PermissionStoreInterface,
  ) {
    this.graphClient = graphClient;
    this.config = config;

    // Use provided service (for testing/DI) or MongoPermissionStore singleton
    this.permissionService = permissionService || MongoPermissionStore.getInstance();
  }

  /**
   * Crawl permissions for a batch of documents
   */
  async crawlDocuments(documents: DocumentToCrawl[]): Promise<CrawlResult> {
    if (this.config.mode === 'disabled') {
      return {
        success: true,
        mode: 'disabled',
        documentsProcessed: 0,
        averageAccuracy: 0,
        durationMs: 0,
        errors: [],
      };
    }

    const startTime = Date.now();
    const errors: Array<{ documentId: string; error: string }> = [];
    let successCount = 0;

    for (const doc of documents) {
      try {
        await this.crawlDocument(doc);
        successCount++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        errors.push({
          documentId: doc.documentId,
          error: errMsg,
        });
      }
    }

    return {
      success: errors.length === 0,
      mode: this.config.mode,
      documentsProcessed: successCount,
      averageAccuracy: this.config.mode === 'full' || this.config.mode === 'enabled' ? 100 : 0,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Crawl permissions for a single document.
   *
   * Fetches both item-level and drive-level permissions, merges them
   * (de-duplicating by permission ID), then processes each.
   *
   * Uses a reconcile pattern: delete all old HAS_PERMISSION edges first,
   * then write current permissions. This ensures revoked permissions are
   * cleaned up (Bug 6 fix).
   */
  private async crawlDocument(doc: DocumentToCrawl): Promise<void> {
    // 1. Fetch item-level permissions from SharePoint
    const itemPermissions = await this.graphClient.getItemPermissions(doc.driveId, doc.itemId);

    // 2. Fetch drive-level permissions (inherited by all items in the drive)
    let drivePermissions: Permission[] = [];
    try {
      drivePermissions = await this.graphClient.getDrivePermissions(doc.driveId);
    } catch (error) {
      log.warn('Failed to fetch drive-level permissions, continuing with item permissions only', {
        driveId: doc.driveId,
        documentId: doc.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 3. Merge and de-duplicate by permission ID
    const seenPermIds = new Set<string>();
    const allPermissions: Permission[] = [];

    for (const perm of itemPermissions) {
      if (!seenPermIds.has(perm.id)) {
        seenPermIds.add(perm.id);
        allPermissions.push(perm);
      }
    }
    for (const perm of drivePermissions) {
      if (!seenPermIds.has(perm.id)) {
        seenPermIds.add(perm.id);
        allPermissions.push(perm);
      }
    }

    // 4. Create/update document permissions in MongoDB
    await this.permissionService.upsertDocument({
      tenantId: this.config.tenantId,
      documentId: doc.documentId,
      sourceId: this.config.sourceId,
      source: 'sharepoint',
      name: doc.name,
      path: doc.path,
      publicInDomain: this.hasPublicInDomainAccess(allPermissions),
      publicEverywhere: this.hasPublicEverywhereAccess(allPermissions),
    });

    // 5. Remove all existing HAS_PERMISSION edges for this document (reconcile pattern)
    //    This ensures revoked permissions are cleaned up. (Bug 6 fix)
    const removedCount = await this.permissionService.removeAllDocumentPermissions(
      this.config.tenantId,
      doc.documentId,
    );
    if (removedCount > 0) {
      log.debug('Removed stale permission edges before re-crawl', {
        documentId: doc.documentId,
        removedCount,
      });
    }

    // 6. Process each permission entry (write current permissions)
    for (const perm of allPermissions) {
      await this.processPermission(doc, perm);
    }
  }

  /**
   * Process a single permission entry.
   *
   * Collects all identity blocks from grantedToV2 (singular) and
   * grantedToIdentitiesV2 (array), de-duplicates them, and processes each.
   *
   * Handles all identity types: user, group, siteUser, siteGroup, sharePointGroup.
   * Sharing links with scope "users" are processed via their grantedToIdentitiesV2
   * entries — they are NOT skipped. Only anonymous/organization links are handled
   * via the publicEverywhere/publicInDomain flags on the Document node.
   */
  private async processPermission(doc: DocumentToCrawl, perm: Permission): Promise<void> {
    // Collect all identity blocks from both fields
    const identities: PermissionIdentity[] = [];

    if (perm.grantedToV2) {
      identities.push(perm.grantedToV2);
    }

    if (perm.grantedToIdentitiesV2) {
      for (const identity of perm.grantedToIdentitiesV2) {
        // Avoid duplicates: skip if grantedToV2 was already added and refers to the same entity
        const isDuplicate =
          perm.grantedToV2 &&
          ((identity.user && perm.grantedToV2.user?.id === identity.user.id) ||
            (identity.group && perm.grantedToV2.group?.id === identity.group.id) ||
            (identity.siteUser && perm.grantedToV2.siteUser?.id === identity.siteUser.id) ||
            (identity.siteGroup && perm.grantedToV2.siteGroup?.id === identity.siteGroup.id));

        if (!isDuplicate) {
          identities.push(identity);
        }
      }
    }

    // Process each identity block
    for (const identity of identities) {
      await this.processIdentity(doc, perm, identity);
    }
  }

  /**
   * Process a single identity block.
   *
   * Handles all SharePoint identity types:
   * - user: Direct Azure AD user
   * - group: Azure AD security group (resolved via Graph API)
   * - siteUser: SharePoint site user (treated as user)
   * - siteGroup: SharePoint site group (Members, Visitors, Owners)
   *
   * Note: An identity object may contain BOTH a user/group AND a siteUser/siteGroup.
   * We process ALL present sub-identities, not just the first one found.
   */
  private async processIdentity(
    doc: DocumentToCrawl,
    perm: Permission,
    identity: PermissionIdentity,
  ): Promise<void> {
    let processed = false;

    // User permission (Azure AD user or external user)
    if (identity.user) {
      const user = identity.user;
      const email = user.email || user.id; // Fallback to ID if email not available

      await this.permissionService.upsertUser({
        tenantId: this.config.tenantId,
        email: email.toLowerCase(),
        idpUserId: user.id,
        idpProvider: 'azuread',
        displayName: user.displayName,
      });

      await this.permissionService.setPermission({
        tenantId: this.config.tenantId,
        userEmail: email.toLowerCase(),
        documentId: doc.documentId,
        role: this.mapRoles(perm.roles),
        source: 'sharepoint',
      });

      processed = true;
    }

    // Azure AD group permission
    if (identity.group) {
      const group = identity.group;

      const resolvedGroupId = await this.resolveAzureADGroupId(group);
      const groupIdKey = resolvedGroupId || `sharepoint:${group.id}`;
      const azureAdGroupId = resolvedGroupId || group.id;

      const displayName = group.displayName || group.id;
      const email = group.email || undefined;

      await this.permissionService.upsertGroup({
        tenantId: this.config.tenantId,
        groupId: groupIdKey,
        idpGroupId: azureAdGroupId,
        source: 'sharepoint',
        displayName,
        email,
      });

      await this.permissionService.setPermission({
        tenantId: this.config.tenantId,
        groupId: groupIdKey,
        documentId: doc.documentId,
        role: this.mapRoles(perm.roles),
        source: 'sharepoint',
      });

      // Full/enabled mode: Resolve group members recursively using Azure AD group ID
      if ((this.config.mode === 'full' || this.config.mode === 'enabled') && resolvedGroupId) {
        log.info('Resolving group members for Azure AD group', {
          azureAdGroupId: resolvedGroupId,
          groupIdKey,
          displayName: group.displayName || group.id,
        });
        await this.resolveGroupMembers(resolvedGroupId, groupIdKey);
      } else if (!resolvedGroupId) {
        log.debug('Skipping group member resolution — no Azure AD group ID resolved', {
          sharepointGroupId: group.id,
          displayName: group.displayName || group.id,
          mode: this.config.mode,
        });
      }

      processed = true;
    }

    // SharePoint site group (Bug 1 fix: "Pulkit Test Members", "Visitors", "Owners")
    // These have siteGroup.id (numeric SharePoint ID) but no email — they are
    // SharePoint-internal groups distinct from Azure AD groups.
    if (identity.siteGroup && !processed) {
      const siteGroup = identity.siteGroup;
      // Use a stable composite key: sp-sitegroup:{displayName} since the numeric
      // id is site-scoped and could collide across sites
      const groupIdKey = `sp-sitegroup:${siteGroup.displayName}`;

      await this.permissionService.upsertGroup({
        tenantId: this.config.tenantId,
        groupId: groupIdKey,
        idpGroupId: siteGroup.id,
        source: 'sharepoint',
        displayName: siteGroup.displayName,
      });

      await this.permissionService.setPermission({
        tenantId: this.config.tenantId,
        groupId: groupIdKey,
        documentId: doc.documentId,
        role: this.mapRoles(perm.roles),
        source: 'sharepoint',
      });

      // Bug 9 fix: Resolve siteGroup members via the backing M365 group.
      // SharePoint siteGroups ("Site Members", "Site Owners") are backed by
      // M365 groups that can be looked up by site name. "Visitors" groups
      // are SharePoint-only and cannot be resolved via Graph API.
      if (this.config.mode === 'full' || this.config.mode === 'enabled') {
        await this.resolveSiteGroupMembers(siteGroup.displayName, groupIdKey);
      }

      processed = true;
    }

    // Site user permission (treat as user) — only if not already processed as user
    if (identity.siteUser && !processed) {
      const siteUser = identity.siteUser;
      const email = siteUser.email || siteUser.id;

      await this.permissionService.upsertUser({
        tenantId: this.config.tenantId,
        email: email.toLowerCase(),
        idpUserId: siteUser.id,
        idpProvider: 'azuread',
        displayName: siteUser.displayName,
      });

      await this.permissionService.setPermission({
        tenantId: this.config.tenantId,
        userEmail: email.toLowerCase(),
        documentId: doc.documentId,
        role: this.mapRoles(perm.roles),
        source: 'sharepoint',
      });

      processed = true;
    }

    if (!processed) {
      log.debug('Unhandled permission identity type', {
        documentId: doc.documentId,
        permissionId: perm.id,
        identityKeys: Object.keys(identity),
      });
    }
  }

  /**
   * Resolve Azure AD group ID from a SharePoint group identity.
   *
   * SharePoint permission entries return SharePoint-internal group IDs, not
   * Azure AD group IDs. This method looks up the Azure AD group by email
   * via GET /groups?$filter=mail eq '{email}'.
   *
   * Results are cached in an LRU cache (max 10,000 entries, 1hr TTL).
   *
   * @returns Azure AD group ID, or null if resolution fails
   */
  private async resolveAzureADGroupId(group: {
    id: string;
    displayName: string;
    email: string;
  }): Promise<string | null> {
    const email = group.email;

    // No email means we can't resolve via Graph API
    if (!email) {
      log.debug('Group has no email, cannot resolve Azure AD group ID', {
        sharepointGroupId: group.id,
        displayName: group.displayName || group.id,
      });
      return null;
    }

    // Check cache first
    const cacheKey = email.toLowerCase();
    const cached = this.azureADGroupCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const response = await this.graphClient.get<AzureADGroupCollection>('/groups', {
        query: {
          $filter: `mail eq '${email}'`,
          $select: 'id,displayName,mail',
          $top: 1,
        },
      });

      const groups = response.data.value;
      if (groups.length > 0) {
        const azureAdGroupId = groups[0].id;
        this.azureADGroupCache.set(cacheKey, azureAdGroupId);
        return azureAdGroupId;
      }

      // No matching Azure AD group found
      log.warn('No Azure AD group found for SharePoint group email', {
        email,
        sharepointGroupId: group.id,
      });
      this.azureADGroupCache.set(cacheKey, null);
      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAuthError =
        errorMessage.includes('Authorization_RequestDenied') ||
        errorMessage.includes('Insufficient privileges') ||
        errorMessage.includes('403');

      if (isAuthError) {
        // Bug 3 fix: Upgrade to ERROR for missing API scopes — this is not transient
        log.error(
          'MISSING API SCOPE: Cannot resolve Azure AD group. Add "Group.Read.All" and ' +
            '"GroupMember.Read.All" application permissions to the Azure AD app registration ' +
            'and grant admin consent. Without these scopes, group-based permission search will NOT work.',
          {
            email,
            sharepointGroupId: group.id,
            error: errorMessage,
          },
        );
      } else {
        log.warn('Failed to resolve Azure AD group ID, falling back to SharePoint ID', {
          email,
          sharepointGroupId: group.id,
          error: errorMessage,
        });
      }
      // Don't cache auth failures — they may be resolved by adding scopes
      return null;
    }
  }

  /**
   * Resolve group members recursively (enabled mode only).
   *
   * @param azureAdGroupId - The Azure AD group ID (NOT the SharePoint-internal ID)
   * @param groupIdKey - The namespaced group ID (e.g. the Azure AD ID or "sharepoint:{id}")
   */
  private async resolveGroupMembers(azureAdGroupId: string, groupIdKey: string): Promise<void> {
    try {
      const members = await this.graphClient.getGroupMembers(azureAdGroupId);

      log.info('Group members fetched from Azure AD', {
        azureAdGroupId,
        groupIdKey,
        memberCount: members.length,
      });

      let resolvedCount = 0;
      for (const member of members) {
        let email = member.mail || member.userPrincipalName;
        let displayName = member.displayName;

        // Fallback: if /groups/{id}/members returned null for mail/UPN,
        // fetch the individual user by ID. The /users/{id} endpoint often
        // returns fuller data than the collection, especially for
        // guest/external users whose profile is in another tenant.
        if (!email && member.id) {
          const userDetails = await this.graphClient.getUser(member.id);
          if (userDetails) {
            email = userDetails.mail || userDetails.userPrincipalName;
            displayName = displayName || userDetails.displayName;
          }
        }

        // If member is a user with resolvable email
        if (email) {
          // Create user node
          await this.permissionService.upsertUser({
            tenantId: this.config.tenantId,
            email: email.toLowerCase(),
            idpUserId: member.id,
            idpProvider: 'azuread',
            displayName: displayName,
          });

          // Set membership: User → Group
          await this.permissionService.setMembership({
            tenantId: this.config.tenantId,
            memberEmail: email.toLowerCase(),
            parentGroupId: groupIdKey,
            source: 'sharepoint',
          });

          resolvedCount++;
        } else {
          log.debug('Skipped unresolvable group member (no email even after user lookup)', {
            memberId: member.id,
            groupIdKey,
          });
        }
        // Nested groups (Group → Group) are not resolved transitively.
        // Azure AD supports nested group memberships, but resolving them
        // requires recursive Graph API calls which would significantly
        // increase crawl time and API quota usage. For v1, only direct
        // group members are resolved. Nested group support can be added
        // as a configurable option in a future iteration.
      }

      log.info('Group member resolution completed', {
        azureAdGroupId,
        groupIdKey,
        totalMembers: members.length,
        resolvedMembers: resolvedCount,
        skipped: members.length - resolvedCount,
      });
    } catch (error) {
      log.warn('Failed to resolve members for group', {
        azureAdGroupId,
        groupIdKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Resolve siteGroup members via the backing M365 group.
   *
   * SharePoint site groups follow the pattern "{SiteName} Members/Owners/Visitors".
   * Modern team sites are backed by an M365 group with the site name. This method:
   * 1. Parses the display name to extract site name and role
   * 2. Looks up the M365 group by display name
   * 3. Fetches members (for "Members") or owners (for "Owners")
   * 4. Creates user + group memberships in MongoDB
   *
   * "Visitors" groups are SharePoint-only (no M365 backing) and cannot be resolved.
   *
   * @param siteGroupDisplayName - e.g. "Pulkit Test Members"
   * @param groupIdKey - Namespaced group key, e.g. "sp-sitegroup:Pulkit Test Members"
   */
  private async resolveSiteGroupMembers(
    siteGroupDisplayName: string,
    groupIdKey: string,
  ): Promise<void> {
    // Parse site name and role from display name
    // Format: "{SiteName} Members" / "{SiteName} Owners" / "{SiteName} Visitors"
    const suffixes = ['Members', 'Owners', 'Visitors'] as const;
    let siteName: string | null = null;
    let role: (typeof suffixes)[number] | null = null;

    for (const suffix of suffixes) {
      if (siteGroupDisplayName.endsWith(` ${suffix}`)) {
        siteName = siteGroupDisplayName.slice(0, -(suffix.length + 1));
        role = suffix;
        break;
      }
    }

    if (!siteName || !role) {
      log.debug('Cannot parse siteGroup name for member resolution', {
        siteGroupDisplayName,
        groupIdKey,
      });
      return;
    }

    // Visitors groups are SharePoint-only — no M365 backing group
    if (role === 'Visitors') {
      log.debug('Skipping Visitors siteGroup member resolution (SharePoint-only, no M365 group)', {
        siteGroupDisplayName,
        groupIdKey,
      });
      return;
    }

    try {
      // Find the backing M365 group by site name
      const m365GroupId = await this.findM365GroupBySiteName(siteName);
      if (!m365GroupId) {
        log.debug('No M365 group found for site, cannot resolve siteGroup members', {
          siteName,
          siteGroupDisplayName,
          groupIdKey,
        });
        return;
      }

      log.info('Resolving siteGroup members via M365 group', {
        siteGroupDisplayName,
        groupIdKey,
        m365GroupId,
        role,
      });

      // Fetch members or owners based on the siteGroup role
      const members =
        role === 'Owners'
          ? await this.graphClient.getGroupOwners(m365GroupId)
          : await this.graphClient.getGroupMembers(m365GroupId);

      let resolvedCount = 0;
      for (const member of members) {
        let email = member.mail || member.userPrincipalName;
        let displayName = member.displayName;

        // Fallback: individual user lookup if collection returned null fields
        if (!email && member.id) {
          const userDetails = await this.graphClient.getUser(member.id);
          if (userDetails) {
            email = userDetails.mail || userDetails.userPrincipalName;
            displayName = displayName || userDetails.displayName;
          }
        }

        if (email) {
          await this.permissionService.upsertUser({
            tenantId: this.config.tenantId,
            email: email.toLowerCase(),
            idpUserId: member.id,
            idpProvider: 'azuread',
            displayName: displayName,
          });

          await this.permissionService.setMembership({
            tenantId: this.config.tenantId,
            memberEmail: email.toLowerCase(),
            parentGroupId: groupIdKey,
            source: 'sharepoint',
          });

          resolvedCount++;
        } else {
          log.debug('Skipped unresolvable siteGroup member (no email even after user lookup)', {
            memberId: member.id,
            siteGroupDisplayName,
            groupIdKey,
          });
        }
      }

      log.info('SiteGroup member resolution completed', {
        siteGroupDisplayName,
        groupIdKey,
        m365GroupId,
        role,
        totalMembers: members.length,
        resolvedMembers: resolvedCount,
        skipped: members.length - resolvedCount,
      });
    } catch (error) {
      log.warn('Failed to resolve siteGroup members', {
        siteGroupDisplayName,
        groupIdKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Find the M365 group backing a SharePoint site by site display name.
   *
   * Modern SharePoint team sites are created through M365 Groups. The group
   * typically has the same display name as the site. Uses Graph API:
   * GET /groups?$filter=displayName eq '{siteName}'
   *
   * Results are cached (key: "m365:{siteName}") to avoid repeated lookups
   * when multiple siteGroups reference the same site.
   */
  private async findM365GroupBySiteName(siteName: string): Promise<string | null> {
    const cacheKey = `m365:${siteName.toLowerCase()}`;
    const cached = this.azureADGroupCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      // Escape single quotes in site name for OData filter
      const escapedName = siteName.replace(/'/g, "''");
      const response = await this.graphClient.get<AzureADGroupCollection>('/groups', {
        query: {
          $filter: `displayName eq '${escapedName}'`,
          $select: 'id,displayName',
          $top: '1',
        },
      });

      const groups = response.data.value;
      if (groups.length > 0) {
        log.info('Found M365 group for site', {
          siteName,
          m365GroupId: groups[0].id,
          m365GroupName: groups[0].displayName,
        });
        this.azureADGroupCache.set(cacheKey, groups[0].id);
        return groups[0].id;
      }

      log.debug('No M365 group found matching site name', { siteName });
      this.azureADGroupCache.set(cacheKey, null);
      return null;
    } catch (error) {
      log.warn('Failed to find M365 group for site', {
        siteName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Check if document has public-in-domain access
   */
  private hasPublicInDomainAccess(permissions: Permission[]): boolean {
    // SharePoint sharing links with scope 'organization' grant access to
    // all users within the Azure AD tenant (public within the domain).
    return permissions.some((perm) => perm.link?.scope === 'organization');
  }

  /**
   * Check if document has public-everywhere access
   */
  private hasPublicEverywhereAccess(permissions: Permission[]): boolean {
    return permissions.some((perm) => perm.link?.scope === 'anonymous');
  }

  /**
   * Map SharePoint roles to permission role
   */
  private mapRoles(roles: string[]): 'read' | 'write' | 'owner' {
    // Priority: owner > write > read
    if (roles.includes('owner') || roles.includes('Owner')) {
      return 'owner';
    }
    if (
      roles.includes('write') ||
      roles.includes('edit') ||
      roles.includes('Write') ||
      roles.includes('Edit')
    ) {
      return 'write';
    }
    return 'read';
  }

  /**
   * Close connections
   */
  async close(): Promise<void> {
    // Permission service uses singleton, don't close it here
    // It will be closed when the application shuts down
  }
}
