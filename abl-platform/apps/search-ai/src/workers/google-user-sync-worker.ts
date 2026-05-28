/**
 * Google User Sync Worker
 *
 * Syncs users from Google Workspace to MongoDB contact cards via MongoPermissionStore.
 * Uses Google Directory API with timestamp-based delta sync.
 *
 * Flow:
 * 1. Fetch users from Google Directory API (/admin/directory/v1/users endpoint)
 * 2. Batch upsert users to MongoDB contacts (100 users per batch)
 * 3. Store timestamp for next incremental sync
 * 4. Invalidate group membership cache in Redis
 *
 * Features:
 * - Timestamp-based delta sync (Google has no native delta query)
 * - Pagination with pageToken (handles 10k+ users)
 * - Batch upsert to MongoDB via MongoPermissionStore (performance optimization)
 * - Error handling with retry logic
 * - Sync status tracking
 *
 * Note: Google Directory API requires OAuth2 service account with domain-wide delegation
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_GOOGLE_USER_SYNC } from '@agent-platform/search-ai-sdk';
import { MongoPermissionStore } from '@agent-platform/search-ai-internal/permissions';
import type { CreateUserInput } from '@agent-platform/search-ai-internal/permissions';
import { getLazyModel } from '../db/index.js';
import { withTenantContext } from '@agent-platform/database/mongo';
import type { ILLMCredential } from '@agent-platform/database/models';
import {
  Contact,
  AclGroupHierarchy,
  AclDocumentPermissions,
} from '@agent-platform/database/models';
import {
  createWorkerOptions,
  workerLog,
  workerError,
  getSharedRedisHandle,
  withTraceContext,
  createBlindIndexFn,
  createEncryptFn,
} from './shared.js';
import { resolveLegacyCredentialApiKey } from './legacy-credential-resolution.js';
import type { GoogleUserSyncJobData } from './shared.js';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys } from '@agent-platform/redis';

const logger = createLogger('google-user-sync');

// =============================================================================
// GOOGLE DIRECTORY API CLIENT
// =============================================================================

interface GoogleUser {
  id: string; // Google User ID
  primaryEmail: string;
  name?: {
    givenName?: string;
    familyName?: string;
    fullName?: string;
  };
  suspended?: boolean;
  isAdmin?: boolean;
  creationTime?: string; // ISO 8601 timestamp
  lastLoginTime?: string; // ISO 8601 timestamp
}

interface GoogleDirectoryResponse {
  users: GoogleUser[];
  nextPageToken?: string;
}

/**
 * Google Directory API Client
 *
 * Wrapper for fetching users from Google Workspace via Directory API.
 * Supports pagination with pageToken. No native delta query - uses timestamp comparison.
 */
class GoogleDirectoryClient {
  private accessToken: string;
  private googleDomain: string;

  constructor(accessToken: string, googleDomain: string) {
    this.accessToken = accessToken;
    this.googleDomain = googleDomain;
  }

  /**
   * Fetch users from Google Workspace
   *
   * @param pageToken - Pagination token from previous response
   * @param lastUpdated - Filter users by comparing local lastUpdated timestamp
   * @returns Users and next page token
   */
  async fetchUsers(
    pageToken?: string,
    lastUpdated?: string,
  ): Promise<{ users: GoogleUser[]; nextPageToken?: string }> {
    // Build URL with domain and pagination
    const params = new URLSearchParams();
    params.append('customer', 'my_customer'); // Fetch all users in organization
    params.append('domain', this.googleDomain);
    params.append('maxResults', '500'); // Google Directory API max is 500
    params.append('projection', 'full'); // Get full user profile
    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const url = `https://admin.googleapis.com/admin/directory/v1/users?${params.toString()}`;

    // Add 60s timeout (Google API is typically faster than Graph/Okta)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google Directory API error: ${response.status} ${error}`);
      }

      const data = (await response.json()) as GoogleDirectoryResponse;

      // Client-side filtering: Google has no native delta query
      // Filter users updated after lastUpdated timestamp
      let filteredUsers = data.users || [];
      if (lastUpdated) {
        filteredUsers = filteredUsers.filter((user) => {
          // Compare user's lastLoginTime or creationTime with lastUpdated
          const userTimestamp = user.lastLoginTime || user.creationTime;
          return userTimestamp && userTimestamp > lastUpdated;
        });
      }

      return {
        users: filteredUsers,
        nextPageToken: data.nextPageToken,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Google Directory API timeout after 60s');
      }
      throw error;
    }
  }

  /**
   * Fetch all users (with pagination)
   *
   * @param lastUpdated - Optional timestamp for delta sync (client-side filtering)
   * @returns All users
   */
  async fetchAllUsers(lastUpdated?: string): Promise<GoogleUser[]> {
    const allUsers: GoogleUser[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.fetchUsers(pageToken, lastUpdated);
      allUsers.push(...response.users);
      pageToken = response.nextPageToken;

      logger.debug('Fetched users page', { count: response.users.length, hasMore: !!pageToken });
    } while (pageToken);

    return allUsers;
  }
}

// =============================================================================
// CACHE INVALIDATION
// =============================================================================

/**
 * Invalidate group membership cache for tenant
 *
 * After IdP sync, group memberships may have changed. Clear the cache
 * to force fresh MongoDB queries on next user query.
 *
 * Cache key pattern: searchai:permissions:groups:{tenantId}:*
 */
async function invalidateGroupMembershipCache(tenantId: string): Promise<number> {
  try {
    const handle = getSharedRedisHandle();
    if (!handle) {
      logger.debug('Redis not configured, skipping group cache invalidation', { tenantId });
      return 0;
    }
    const redis = handle.duplicate();
    const pattern = `searchai:permissions:groups:${tenantId}:*`;

    // Use cluster-safe scanKeys instead of KEYS to avoid blocking Redis for O(N) time
    const keys: string[] = [];
    for await (const key of scanKeys(redis, pattern, 200)) {
      keys.push(key);
    }

    if (keys.length === 0) {
      logger.debug('No group membership cache keys to invalidate', { tenantId });
      await redis.quit();
      return 0;
    }

    // Delete keys one at a time (cluster-safe — avoids multi-key cross-slot DEL)
    await Promise.all(keys.map((k) => redis.del(k)));
    const deleted = keys.length;
    await redis.quit();

    logger.info('Group membership cache invalidated', {
      tenantId,
      keysDeleted: deleted,
    });

    return deleted;
  } catch (error) {
    logger.warn('Failed to invalidate group membership cache (non-fatal)', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

const UPSERT_BATCH_SIZE = 100; // Upsert 100 users per batch

export async function processGoogleUserSync(job: Job<GoogleUserSyncJobData>): Promise<void> {
  const { tenantId, credentialId, syncMode, lastUpdated, googleDomain, authProfileId } = job.data;

  workerLog('google-user-sync', `Starting Google user sync (${syncMode})`, {
    tenantId,
    credentialId,
    hasLastUpdated: !!lastUpdated,
    googleDomain,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      try {
        let accessToken: string | undefined;

        // Auth Profile dual-read: resolve via auth profile if available
        if (authProfileId) {
          try {
            const { resolveAuthProfileCredential } =
              await import('../services/auth-profile-resolver.js');
            const profileResult = await resolveAuthProfileCredential({
              authProfileId,
              tenantId,
            });
            if (profileResult) {
              accessToken = profileResult.apiKey;
              logger.debug('Credential resolved from auth profile', {
                authProfileId,
                tenantId,
              });
            }
          } catch (error) {
            logger.warn('Auth profile resolution failed, falling back to legacy', {
              authProfileId,
              tenantId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Legacy credential path (fallback)
        const LLMCredential = getLazyModel<ILLMCredential>('LLMCredential');
        if (!accessToken) {
          const credential = await LLMCredential.findOne({
            _id: credentialId,
            tenantId,
            isActive: true,
          });

          accessToken = await resolveLegacyCredentialApiKey(credential, tenantId, credentialId);
        }

        // Step 2: Fetch users from Google Directory API
        const googleClient = new GoogleDirectoryClient(accessToken, googleDomain);
        const users = await googleClient.fetchAllUsers(
          syncMode === 'delta' ? lastUpdated : undefined,
        );

        workerLog('google-user-sync', `Fetched ${users.length} users from Google Workspace`, {
          tenantId,
        });

        // Step 3: Transform Google users to CreateUserInput for MongoDB
        const userInputs: CreateUserInput[] = users
          .filter((u) => !u.suspended) // Only active users
          .map((user) => {
            const email = user.primaryEmail;
            const displayName = user.name?.fullName || user.name?.givenName || email;

            return {
              tenantId,
              email: email.toLowerCase(),
              idpUserId: user.id, // Google User ID
              idpProvider: 'google' as const,
              displayName,
              status: 'active' as const,
            };
          });

        if (userInputs.length === 0) {
          workerLog('google-user-sync', 'No users to sync (all filtered or deleted)', {
            tenantId,
          });
          return;
        }

        // Step 4: Batch upsert to MongoDB contact cards
        const mongoPermissionStore = MongoPermissionStore.getInstance({
          contactModel: Contact as any,
          groupHierarchyModel: AclGroupHierarchy as any,
          documentPermissionsModel: AclDocumentPermissions as any,
          blindIndexFn: createBlindIndexFn(),
          encryptFn: createEncryptFn(),
        });
        let syncedCount = 0;

        for (let i = 0; i < userInputs.length; i += UPSERT_BATCH_SIZE) {
          const batch = userInputs.slice(i, i + UPSERT_BATCH_SIZE);

          // Upsert users in parallel
          await Promise.all(batch.map((input) => mongoPermissionStore.upsertUser(input)));

          syncedCount += batch.length;

          // Update progress
          const progress = Math.round((syncedCount / userInputs.length) * 100);
          await job.updateProgress(progress);

          workerLog('google-user-sync', `Synced batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}`, {
            tenantId,
            batchSize: batch.length,
            totalSynced: syncedCount,
          });
        }

        // Step 5: Store timestamp for next incremental sync
        const currentTimestamp = new Date().toISOString();
        await LLMCredential.findOneAndUpdate(
          { _id: credentialId, tenantId },
          {
            $set: {
              'metadata.googleUserSyncLastUpdated': currentTimestamp,
              'metadata.lastUserSync': new Date(),
            },
          },
        );

        workerLog('google-user-sync', 'Stored timestamp for future incremental syncs', {
          tenantId,
          syncMode,
          timestamp: currentTimestamp,
        });

        // Step 6: Invalidate group membership cache
        // User/group memberships may have changed, clear cache to force fresh queries
        const cacheKeysDeleted = await invalidateGroupMembershipCache(tenantId);

        workerLog('google-user-sync', `Google user sync complete`, {
          tenantId,
          totalUsers: users.length,
          syncedUsers: syncedCount,
          syncMode,
          cacheKeysDeleted,
        });
      } catch (error) {
        workerError('google-user-sync', `Failed to sync Google users`, error);
        throw error;
      }
    }),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

export default function createGoogleUserSyncWorker(concurrency = 1): Worker<GoogleUserSyncJobData> {
  const worker = new Worker(
    QUEUE_GOOGLE_USER_SYNC,
    processGoogleUserSync,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('google-user-sync', `Job ${job.id} completed`, { tenantId: job.data.tenantId });
  });

  worker.on('failed', (job, err) => {
    workerError('google-user-sync', `Job ${job?.id} failed`, err);
  });

  return worker;
}
