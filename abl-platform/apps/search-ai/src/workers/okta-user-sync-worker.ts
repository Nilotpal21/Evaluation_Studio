/**
 * Okta User Sync Worker
 *
 * Syncs users from Okta to MongoDB contact cards via MongoPermissionStore.
 * Uses Okta API with filter-based delta query support for incremental syncs.
 *
 * Flow:
 * 1. Fetch users from Okta API (/api/v1/users endpoint)
 * 2. Batch upsert users to MongoDB contacts (100 users per batch)
 * 3. Store lastUpdated timestamp for next incremental sync
 * 4. Invalidate group membership cache in Redis
 *
 * Features:
 * - Delta query support via filter=lastUpdated gt timestamp (incremental syncs)
 * - Pagination with 'after' cursor (handles 10k+ users)
 * - Batch upsert to MongoDB via MongoPermissionStore (performance optimization)
 * - Error handling with retry logic
 * - Sync status tracking
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_OKTA_USER_SYNC } from '@agent-platform/search-ai-sdk';
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
import type { OktaUserSyncJobData } from './shared.js';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys } from '@agent-platform/redis';

const logger = createLogger('okta-user-sync');

// =============================================================================
// OKTA API CLIENT
// =============================================================================

interface OktaUser {
  id: string; // Okta User ID
  status: string; // STAGED, PROVISIONED, ACTIVE, RECOVERY, PASSWORD_EXPIRED, LOCKED_OUT, DEPROVISIONED, SUSPENDED
  profile: {
    email: string;
    login: string;
    firstName?: string;
    lastName?: string;
  };
  lastUpdated: string; // ISO 8601 timestamp
}

interface OktaAPIResponse<T> {
  data: T[];
  headers?: {
    link?: string; // Link header with 'after' cursor for pagination
  };
}

/**
 * Okta API Client
 *
 * Wrapper for fetching users from Okta via Okta API.
 * Supports pagination with 'after' cursor and filter-based delta queries.
 */
class OktaClient {
  private apiToken: string;
  private oktaDomain: string; // e.g., "company.okta.com"

  constructor(apiToken: string, oktaDomain: string) {
    this.apiToken = apiToken;
    this.oktaDomain = oktaDomain;
  }

  /**
   * Fetch users from Okta
   *
   * @param after - Pagination cursor from previous response
   * @param lastUpdated - Filter users updated after this timestamp (ISO 8601)
   * @returns Users and next page cursor
   */
  async fetchUsers(
    after?: string,
    lastUpdated?: string,
  ): Promise<{ users: OktaUser[]; after?: string }> {
    // Build URL with pagination and optional delta filter
    const params = new URLSearchParams();
    params.append('limit', '200'); // Okta max is 200
    if (after) {
      params.append('after', after);
    }
    if (lastUpdated) {
      // Filter users updated after timestamp (delta query)
      params.append('filter', `lastUpdated gt "${lastUpdated}"`);
    }

    const url = `https://${this.oktaDomain}/api/v1/users?${params.toString()}`;

    // Add 120s timeout to prevent hanging on slow/unresponsive API
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `SSWS ${this.apiToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Okta API error: ${response.status} ${error}`);
      }

      const users = (await response.json()) as OktaUser[];

      // Extract 'after' cursor from Link header
      // Link: <https://.../api/v1/users?after=...>; rel="next"
      const linkHeader = response.headers.get('link');
      let nextAfter: string | undefined;

      if (linkHeader) {
        const match = linkHeader.match(/after=([^&>]+)/);
        if (match) {
          nextAfter = match[1];
        }
      }

      return {
        users,
        after: nextAfter,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Okta API timeout after 120s');
      }
      throw error;
    }
  }

  /**
   * Fetch all users (with pagination)
   *
   * @param lastUpdated - Optional timestamp for delta query (ISO 8601)
   * @returns All users
   */
  async fetchAllUsers(lastUpdated?: string): Promise<OktaUser[]> {
    const allUsers: OktaUser[] = [];
    let after: string | undefined;

    do {
      const response = await this.fetchUsers(after, lastUpdated);
      allUsers.push(...response.users);
      after = response.after;

      logger.debug('Fetched users page', { count: response.users.length, hasMore: !!after });
    } while (after);

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

export async function processOktaUserSync(job: Job<OktaUserSyncJobData>): Promise<void> {
  const { tenantId, credentialId, syncMode, lastUpdated, oktaDomain, authProfileId } = job.data;

  workerLog('okta-user-sync', `Starting Okta user sync (${syncMode})`, {
    tenantId,
    credentialId,
    hasLastUpdated: !!lastUpdated,
    oktaDomain,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      try {
        let apiToken: string | undefined;

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
              apiToken = profileResult.apiKey;
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
        if (!apiToken) {
          const credential = await LLMCredential.findOne({
            _id: credentialId,
            tenantId,
            isActive: true,
          });

          apiToken = await resolveLegacyCredentialApiKey(credential, tenantId, credentialId);
        }

        // Step 2: Fetch users from Okta API
        const oktaClient = new OktaClient(apiToken, oktaDomain);
        const users = await oktaClient.fetchAllUsers(
          syncMode === 'delta' ? lastUpdated : undefined,
        );

        workerLog('okta-user-sync', `Fetched ${users.length} users from Okta`, { tenantId });

        // Step 3: Transform Okta users to CreateUserInput for MongoDB
        const userInputs: CreateUserInput[] = users
          .filter((u) => u.status === 'ACTIVE' || u.status === 'PROVISIONED') // Only active users
          .map((user) => {
            const email = user.profile.email || user.profile.login;
            const displayName =
              user.profile.firstName && user.profile.lastName
                ? `${user.profile.firstName} ${user.profile.lastName}`
                : user.profile.firstName || user.profile.lastName || email;

            return {
              tenantId,
              email: email.toLowerCase(),
              idpUserId: user.id, // Okta User ID
              idpProvider: 'okta' as const,
              displayName,
              status: 'active' as const,
            };
          });

        if (userInputs.length === 0) {
          workerLog('okta-user-sync', 'No users to sync (all filtered or deleted)', { tenantId });
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

          workerLog('okta-user-sync', `Synced batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}`, {
            tenantId,
            batchSize: batch.length,
            totalSynced: syncedCount,
          });
        }

        // Step 5: Store lastUpdated timestamp for next incremental sync
        const currentTimestamp = new Date().toISOString();
        await LLMCredential.findOneAndUpdate(
          { _id: credentialId, tenantId },
          {
            $set: {
              'metadata.oktaUserSyncLastUpdated': currentTimestamp,
              'metadata.lastUserSync': new Date(),
            },
          },
        );

        workerLog('okta-user-sync', 'Stored lastUpdated timestamp for future incremental syncs', {
          tenantId,
          syncMode,
          timestamp: currentTimestamp,
        });

        // Step 6: Invalidate group membership cache
        // User/group memberships may have changed, clear cache to force fresh queries
        const cacheKeysDeleted = await invalidateGroupMembershipCache(tenantId);

        workerLog('okta-user-sync', `Okta user sync complete`, {
          tenantId,
          totalUsers: users.length,
          syncedUsers: syncedCount,
          syncMode,
          cacheKeysDeleted,
        });
      } catch (error) {
        workerError('okta-user-sync', `Failed to sync Okta users`, error);
        throw error;
      }
    }),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

export default function createOktaUserSyncWorker(concurrency = 1): Worker<OktaUserSyncJobData> {
  const worker = new Worker(
    QUEUE_OKTA_USER_SYNC,
    processOktaUserSync,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('okta-user-sync', `Job ${job.id} completed`, { tenantId: job.data.tenantId });
  });

  worker.on('failed', (job, err) => {
    workerError('okta-user-sync', `Job ${job?.id} failed`, err);
  });

  return worker;
}
