/**
 * Microsoft Graph API Client
 *
 * Wraps Microsoft Graph API with rate limiting, retry logic, and type safety.
 * Implements SharePoint-specific endpoints for sites, drives, and items.
 */

import {
  HttpClient,
  RateLimiter,
  TokenManager,
  type HttpClientConfig,
} from '@agent-platform/connectors-base';
import type {
  Site,
  SiteCollection,
  Drive,
  DriveCollection,
  DriveItem,
  DriveItemCollection,
  Permission,
  PermissionCollection,
  GroupMember,
  GroupMemberCollection,
  GraphList,
  GraphListCollection,
  GraphColumnDefinition,
  GraphColumnCollection,
} from './graph-types.js';

// ─── Configuration ───────────────────────────────────────────────────────

export interface GraphClientConfig {
  /** Access token (use this OR tokenManager) */
  accessToken?: string;
  /** Token manager for automatic refresh (preferred over static accessToken) */
  tokenManager?: TokenManager;
  /** Base URL (default: https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Rate limit configuration */
  rateLimit?: {
    /** Maximum requests per interval (default: 10000) */
    maxRequests?: number;
    /** Requests per second (default: 16.67 = ~10K per 10 min) */
    requestsPerSecond?: number;
  };
}

// ─── Microsoft Graph Client ──────────────────────────────────────────────

export class GraphClient extends HttpClient {
  constructor(config: GraphClientConfig) {
    if (!config.accessToken && !config.tokenManager) {
      throw new Error('GraphClient requires either accessToken or tokenManager');
    }

    // Use configurable rate limits or Microsoft Graph defaults
    // Default: 10,000 requests per 10 minutes = ~16.67 req/sec
    const maxRequests = config.rateLimit?.maxRequests ?? 10000;
    const requestsPerSecond = config.rateLimit?.requestsPerSecond ?? 16.67;
    const rateLimiter = new RateLimiter(maxRequests, requestsPerSecond);

    const httpConfig: HttpClientConfig = {
      baseUrl: config.baseUrl || 'https://graph.microsoft.com/v1.0',
      defaultHeaders: {
        Authorization: `Bearer ${config.accessToken || 'PLACEHOLDER'}`,
        'Content-Type': 'application/json',
      },
      rateLimiter,
      timeoutMs: config.timeoutMs || 30000,
      retryOptions: {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        retryableStatusCodes: [429, 500, 502, 503, 504],
      },
      // Use tokenProvider for automatic token refresh before each request
      tokenProvider: config.tokenManager ? () => config.tokenManager!.getAccessToken() : undefined,
    };

    super(httpConfig);
  }

  // ─── Site Operations ───────────────────────────────────────────────────

  /**
   * Get all SharePoint sites.
   */
  async getSites(): Promise<Site[]> {
    const sites: Site[] = [];

    // Strategy: try search=* first (works with delegated permissions).
    // If it fails with 500 (known transient issue), fall back to enumerating
    // from the root site's subsites.
    try {
      let nextLink: string | undefined = '/sites?search=*';

      while (nextLink) {
        const response: { data: SiteCollection } = await this.get<SiteCollection>(nextLink);
        sites.push(...response.data.value);
        nextLink = response.data['@odata.nextLink'];
      }

      return sites;
    } catch (error: any) {
      // If search=* fails, fall back to root site enumeration
      if (error.status === 500 || error.status === 400) {
        console.warn(
          `[GraphClient] sites?search=* failed (${error.status}), falling back to root site enumeration`,
        );
        return this.getSitesFallback();
      }
      throw error;
    }
  }

  /**
   * Fallback: get root site and enumerate subsites.
   */
  private async getSitesFallback(): Promise<Site[]> {
    const sites: Site[] = [];

    // Get root site
    const rootResponse = await this.get<Site>('/sites/root');
    sites.push(rootResponse.data);

    // Get subsites of root
    try {
      let nextLink: string | undefined = `/sites/root/sites`;
      while (nextLink) {
        const response: { data: SiteCollection } = await this.get<SiteCollection>(nextLink);
        sites.push(...response.data.value);
        nextLink = response.data['@odata.nextLink'];
      }
    } catch (error: any) {
      console.warn(`[GraphClient] Failed to enumerate subsites: ${error.message}`);
      // Continue with just the root site
    }

    return sites;
  }

  /**
   * Get a specific site by URL.
   */
  async getSiteByUrl(siteUrl: string): Promise<Site> {
    // Extract hostname and path from URL
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const path = url.pathname;

    const response = await this.get<Site>(`/sites/${hostname}:${path}`);
    return response.data;
  }

  /**
   * Search for sites by keyword.
   */
  async searchSites(keyword: string): Promise<Site[]> {
    const response = await this.get<SiteCollection>('/sites', {
      query: {
        search: keyword,
      },
    });

    return response.data.value;
  }

  // ─── Drive Operations ──────────────────────────────────────────────────

  /**
   * Get all drives (document libraries) in a site.
   */
  async getDrives(siteId: string): Promise<Drive[]> {
    const drives: Drive[] = [];
    let nextLink: string | undefined = `/sites/${siteId}/drives`;

    while (nextLink) {
      const response: { data: DriveCollection } = await this.get<DriveCollection>(nextLink);
      drives.push(...response.data.value);
      nextLink = response.data['@odata.nextLink'];
    }

    return drives;
  }

  /**
   * Get a specific drive.
   */
  async getDrive(driveId: string): Promise<Drive> {
    const encodedDriveId = encodeURIComponent(driveId);
    const response = await this.get<Drive>(`/drives/${encodedDriveId}`);
    return response.data;
  }

  // ─── Drive Item Operations ─────────────────────────────────────────────

  /**
   * Get all items in a drive with pagination.
   */
  async getDriveItems(driveId: string, nextLink?: string): Promise<DriveItemCollection> {
    const encodedDriveId = encodeURIComponent(driveId);
    const path = nextLink || `/drives/${encodedDriveId}/root/children`;
    const response = await this.get<DriveItemCollection>(path);
    return response.data;
  }

  /**
   * Get items recursively (all files in all folders) - STREAMING VERSION.
   * Yields batches of items as they are fetched, preventing memory exhaustion.
   *
   * @param driveId - SharePoint drive ID
   * @param batchSize - Number of items to yield per batch (default: 100)
   * @yields Batches of DriveItem objects
   *
   * @example
   * ```typescript
   * for await (const batch of graphClient.getDriveItemsStream(driveId)) {
   *   for (const item of batch) {
   *     await processItem(item);
   *   }
   * }
   * ```
   */
  async *getDriveItemsStream(
    driveId: string,
    batchSize: number = 100,
  ): AsyncGenerator<DriveItem[]> {
    const encodedDriveId = encodeURIComponent(driveId);
    const queue: string[] = [`/drives/${encodedDriveId}/root/children`];
    let currentBatch: DriveItem[] = [];

    while (queue.length > 0) {
      const path = queue.shift()!;
      const response = await this.get<DriveItemCollection>(path);

      for (const item of response.data.value) {
        currentBatch.push(item);

        // If it's a folder, add to queue for recursive traversal
        if (item.folder) {
          const encodedItemId = encodeURIComponent(item.id);
          queue.push(`/drives/${encodedDriveId}/items/${encodedItemId}/children`);
        }

        // Yield batch when it reaches the configured size
        if (currentBatch.length >= batchSize) {
          yield currentBatch;
          currentBatch = [];
        }
      }

      // Handle pagination
      if (response.data['@odata.nextLink']) {
        queue.push(response.data['@odata.nextLink']);
      }
    }

    // Yield any remaining items in the last batch
    if (currentBatch.length > 0) {
      yield currentBatch;
    }
  }

  /**
   * Get items recursively (all files in all folders).
   *
   * @deprecated Use getDriveItemsStream() for memory-efficient streaming.
   * This method loads all items into memory and will cause OOM for large drives (>50K items).
   */
  async getDriveItemsRecursive(driveId: string): Promise<DriveItem[]> {
    const items: DriveItem[] = [];
    const encodedDriveId = encodeURIComponent(driveId);
    const queue: string[] = [`/drives/${encodedDriveId}/root/children`];

    while (queue.length > 0) {
      const path = queue.shift()!;
      const response = await this.get<DriveItemCollection>(path);

      for (const item of response.data.value) {
        items.push(item);

        // If it's a folder, add to queue
        if (item.folder) {
          const encodedItemId = encodeURIComponent(item.id);
          queue.push(`/drives/${encodedDriveId}/items/${encodedItemId}/children`);
        }
      }

      // Handle pagination
      if (response.data['@odata.nextLink']) {
        queue.push(response.data['@odata.nextLink']);
      }
    }

    return items;
  }

  /**
   * Get item content (download file).
   */
  async getDriveItemContent(driveId: string, itemId: string): Promise<Buffer> {
    // URL-encode IDs to handle special characters
    const encodedDriveId = encodeURIComponent(driveId);
    const encodedItemId = encodeURIComponent(itemId);

    const response = await this.get<ArrayBuffer>(
      `/drives/${encodedDriveId}/items/${encodedItemId}/content`,
      {
        headers: {
          Accept: 'application/octet-stream',
        },
      },
    );

    return Buffer.from(response.data);
  }

  // ─── Delta Sync Operations ─────────────────────────────────────────────

  /**
   * Get delta changes for a drive.
   * Returns changes since the last delta token.
   */
  async getDeltaItems(driveId: string, deltaToken?: string): Promise<DriveItemCollection> {
    const encodedDriveId = encodeURIComponent(driveId);
    const path = deltaToken || `/drives/${encodedDriveId}/root/delta`;
    const response = await this.get<DriveItemCollection>(path);
    return response.data;
  }

  // ─── Permission Operations (Phase 2) ───────────────────────────────────

  /**
   * Get permissions for an item.
   */
  async getItemPermissions(driveId: string, itemId: string): Promise<Permission[]> {
    const encodedDriveId = encodeURIComponent(driveId);
    const encodedItemId = encodeURIComponent(itemId);
    const response = await this.get<PermissionCollection>(
      `/drives/${encodedDriveId}/items/${encodedItemId}/permissions`,
    );
    return response.data.value;
  }

  /**
   * Get permissions for a drive (root folder permissions, inherited by all items).
   *
   * Uses /drives/{driveId}/root/permissions — the correct Graph API endpoint.
   * The bare /drives/{driveId}/permissions returns 400 "Resource not found".
   */
  async getDrivePermissions(driveId: string): Promise<Permission[]> {
    const encodedDriveId = encodeURIComponent(driveId);
    const response = await this.get<PermissionCollection>(
      `/drives/${encodedDriveId}/root/permissions`,
    );
    return response.data.value;
  }

  /**
   * Get group members (for resolving group permissions).
   *
   * Uses the microsoft.graph.user OData cast to return only user members
   * with full profile fields (mail, userPrincipalName, displayName).
   * Without this cast, /members returns directoryObject types that
   * may lack email fields, causing MEMBER_OF edges to be skipped.
   *
   * Note: OData query params ($select, $filter) must be passed directly in
   * the URL, NOT via HttpClient's `query` option, because URLSearchParams
   * encodes `$` as `%24` and `,` as `%2C`, which Graph API rejects.
   */
  async getGroupMembers(groupId: string): Promise<GroupMember[]> {
    const members: GroupMember[] = [];
    const encodedGroupId = encodeURIComponent(groupId);
    // Fetch all members (users, groups, service principals) without OData cast.
    // The caller filters by mail/UPN presence.
    // Note: Using /members (not /members/microsoft.graph.user) because the
    // OData cast combined with $select can return null fields in some tenants.
    let nextLink: string | undefined = `/groups/${encodedGroupId}/members`;

    while (nextLink) {
      const response: { data: GroupMemberCollection } =
        await this.get<GroupMemberCollection>(nextLink);
      members.push(...response.data.value);
      nextLink = response.data['@odata.nextLink'];
    }

    return members;
  }

  /**
   * Get group owners (for resolving "Owners" siteGroup permissions).
   *
   * Uses /groups/{id}/owners which returns only the owner-role members.
   * The /groups/{id}/members endpoint returns ALL members (including owners),
   * so use this specifically when you need the Owners subset.
   */
  async getGroupOwners(groupId: string): Promise<GroupMember[]> {
    const owners: GroupMember[] = [];
    const encodedGroupId = encodeURIComponent(groupId);
    let nextLink: string | undefined = `/groups/${encodedGroupId}/owners`;

    while (nextLink) {
      const response: { data: GroupMemberCollection } =
        await this.get<GroupMemberCollection>(nextLink);
      owners.push(...response.data.value);
      nextLink = response.data['@odata.nextLink'];
    }

    return owners;
  }

  /**
   * Get a single user by Azure AD object ID.
   *
   * Used as a fallback when /groups/{id}/members returns users with null
   * mail/userPrincipalName (common for guest/external users).
   * The /users/{id} endpoint often returns fuller data than the collection.
   */
  async getUser(userId: string): Promise<GroupMember | null> {
    try {
      const encodedUserId = encodeURIComponent(userId);
      const response = await this.get<GroupMember>(
        `/users/${encodedUserId}?$select=id,displayName,mail,userPrincipalName`,
      );
      return response.data;
    } catch {
      // User might be deleted, external, or inaccessible
      return null;
    }
  }

  // ─── List & Column Operations ─────────────────────────────────────────

  /**
   * Get all lists in a site.
   */
  async getLists(siteId: string): Promise<GraphList[]> {
    const lists: GraphList[] = [];
    const encodedSiteId = encodeURIComponent(siteId);
    let nextLink: string | undefined = `/sites/${encodedSiteId}/lists`;

    while (nextLink) {
      const response: { data: GraphListCollection } = await this.get<GraphListCollection>(nextLink);
      lists.push(...response.data.value);
      nextLink = response.data['@odata.nextLink'];
    }

    return lists;
  }

  /**
   * Get all columns (fields) for a specific list.
   */
  async getListColumns(siteId: string, listId: string): Promise<GraphColumnDefinition[]> {
    const columns: GraphColumnDefinition[] = [];
    const encodedSiteId = encodeURIComponent(siteId);
    const encodedListId = encodeURIComponent(listId);
    let nextLink: string | undefined = `/sites/${encodedSiteId}/lists/${encodedListId}/columns`;

    while (nextLink) {
      const response: { data: GraphColumnCollection } =
        await this.get<GraphColumnCollection>(nextLink);
      columns.push(...response.data.value);
      nextLink = response.data['@odata.nextLink'];
    }

    return columns;
  }

  // ─── Webhook Operations (Phase 2) ──────────────────────────────────────

  /**
   * Subscribe to drive changes.
   */
  async subscribeToDriveChanges(
    driveId: string,
    notificationUrl: string,
    clientState?: string,
  ): Promise<any> {
    const expirationDate = new Date();
    expirationDate.setHours(expirationDate.getHours() + 24); // 24 hours

    const encodedDriveId = encodeURIComponent(driveId);
    const response = await this.post('/subscriptions', {
      body: {
        changeType: 'updated',
        notificationUrl,
        resource: `/drives/${encodedDriveId}/root`,
        expirationDateTime: expirationDate.toISOString(),
        clientState: clientState || 'secretClientValue', // For validation
      },
    });

    return response.data;
  }

  /**
   * Renew a subscription.
   */
  async renewSubscription(subscriptionId: string): Promise<any> {
    const expirationDate = new Date();
    expirationDate.setHours(expirationDate.getHours() + 24); // 24 hours

    const response = await this.patch(`/subscriptions/${subscriptionId}`, {
      body: {
        expirationDateTime: expirationDate.toISOString(),
      },
    });

    return response.data;
  }

  /**
   * Delete a subscription.
   */
  async deleteSubscription(subscriptionId: string): Promise<void> {
    await this.delete(`/subscriptions/${subscriptionId}`);
  }
}
