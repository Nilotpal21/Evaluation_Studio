/**
 * Azure AD User Sync Worker
 *
 * Syncs users from Azure AD (Microsoft Entra ID) to MongoDB contact cards.
 * Uses Microsoft Graph API with delta query support for incremental syncs.
 *
 * Flow:
 * 1. Fetch users from Microsoft Graph API (/users endpoint)
 * 2. Batch upsert user contact cards via MongoPermissionStore (100 per batch)
 * 3. Store delta token for next incremental sync
 * 4. Invalidate group membership cache in Redis
 *
 * Each user gets a contact card with:
 * - identities[]: encrypted email with blind index for lookup
 * - sourceIdentities[]: azuread source identity with encrypted email
 * - acl{}: initialized with empty groups, domain extracted from email
 *
 * Features:
 * - Delta query support (incremental syncs after initial full sync)
 * - Pagination (handles 10k+ users)
 * - Batch upsert to MongoDB (performance optimization)
 * - Error handling with retry logic
 * - Sync status tracking
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_AZUREAD_USER_SYNC } from '@agent-platform/search-ai-sdk';
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
import type { AzureADUserSyncJobData } from './shared.js';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys } from '@agent-platform/redis';

const logger = createLogger('azuread-user-sync');

// =============================================================================
// MICROSOFT GRAPH API CLIENT
// =============================================================================

interface GraphUser {
  id: string; // Azure AD Object ID
  userPrincipalName: string; // email@domain.com
  mail?: string; // Alternative email
  displayName?: string;
  accountEnabled?: boolean;
}

interface GraphAPIResponse<T> {
  '@odata.context': string;
  '@odata.nextLink'?: string; // Pagination
  '@odata.deltaLink'?: string; // Delta query token
  value: T[];
}

/**
 * Microsoft Graph API Client
 *
 * Wrapper for fetching users from Azure AD via Microsoft Graph API.
 * Supports pagination and delta queries.
 */
class MicrosoftGraphClient {
  private accessToken: string;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Fetch users from Azure AD
   *
   * @param deltaLink - Delta link from previous sync (for incremental sync)
   * @returns Users and next page/delta link
   */
  async fetchUsers(
    deltaLink?: string,
  ): Promise<{ users: GraphUser[]; nextLink?: string; deltaLink?: string }> {
    const url =
      deltaLink ||
      `${this.baseUrl}/users/delta?$select=id,userPrincipalName,mail,displayName,accountEnabled&$top=100`;

    // Add 120s timeout to prevent hanging on slow/unresponsive API
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Microsoft Graph API error: ${response.status} ${error}`);
      }

      const data = (await response.json()) as GraphAPIResponse<GraphUser>;

      return {
        users: data.value,
        nextLink: data['@odata.nextLink'],
        deltaLink: data['@odata.deltaLink'],
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Microsoft Graph API timeout after 120s');
      }
      throw error;
    }
  }

  /**
   * Fetch all users (with pagination)
   *
   * @param deltaLink - Optional delta link for incremental sync
   * @returns All users and final delta link
   */
  async fetchAllUsers(deltaLink?: string): Promise<{ users: GraphUser[]; deltaLink?: string }> {
    const allUsers: GraphUser[] = [];
    let nextLink: string | undefined = deltaLink;
    let finalDeltaLink: string | undefined;

    do {
      const response = await this.fetchUsers(nextLink);
      allUsers.push(...response.users);
      nextLink = response.nextLink;
      finalDeltaLink = response.deltaLink;

      logger.debug('Fetched users page', { count: response.users.length, hasMore: !!nextLink });
    } while (nextLink);

    return {
      users: allUsers,
      deltaLink: finalDeltaLink,
    };
  }
}

// =============================================================================
// CACHE INVALIDATION
// =============================================================================

/**
 * Invalidate group membership cache for tenant
 *
 * After IdP sync, group memberships may have changed. Clear the cache
 * to force fresh MongoDB contact card lookups on next user query.
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

async function processAzureADUserSync(job: Job<AzureADUserSyncJobData>): Promise<void> {
  const { tenantId, credentialId, syncMode, deltaToken, authProfileId } = job.data;

  workerLog('azuread-user-sync', `Starting Azure AD user sync (${syncMode})`, {
    tenantId,
    credentialId,
    hasDeltaToken: !!deltaToken,
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

        // Step 2: Fetch users from Microsoft Graph API
        const graphClient = new MicrosoftGraphClient(accessToken);
        const { users, deltaLink: newDeltaLink } = await graphClient.fetchAllUsers(
          syncMode === 'delta' ? deltaToken : undefined,
        );

        workerLog('azuread-user-sync', `Fetched ${users.length} users from Azure AD`, {
          tenantId,
        });

        // Step 3: Transform Graph users to CreateUserInput for MongoDB
        const userInputs: CreateUserInput[] = users
          .filter((u) => u.accountEnabled !== false) // Only active users
          .map((user) => {
            const email = user.mail || user.userPrincipalName;

            return {
              tenantId,
              email: email.toLowerCase(),
              idpUserId: user.id, // Azure AD Object ID
              idpProvider: 'azuread' as const,
              displayName: user.displayName,
              status: 'active' as const,
            };
          });

        if (userInputs.length === 0) {
          workerLog('azuread-user-sync', 'No users to sync (all filtered or deleted)', {
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

          workerLog('azuread-user-sync', `Synced batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}`, {
            tenantId,
            batchSize: batch.length,
            totalSynced: syncedCount,
          });
        }

        // Step 5: Store delta token for next incremental sync
        // Store for both full AND delta syncs to ensure token is always current
        if (newDeltaLink) {
          await LLMCredential.findOneAndUpdate(
            { _id: credentialId, tenantId },
            {
              $set: {
                'metadata.azureadUserSyncDeltaToken': newDeltaLink,
                'metadata.lastUserSync': new Date(),
              },
            },
          );

          workerLog('azuread-user-sync', 'Stored delta token for future incremental syncs', {
            tenantId,
            syncMode,
          });
        }

        // Step 6: Invalidate group membership cache
        // User/group memberships may have changed, clear cache to force fresh queries
        const cacheKeysDeleted = await invalidateGroupMembershipCache(tenantId);

        workerLog('azuread-user-sync', `Azure AD user sync complete`, {
          tenantId,
          totalUsers: users.length,
          syncedUsers: syncedCount,
          syncMode,
          cacheKeysDeleted,
        });
      } catch (error) {
        workerError('azuread-user-sync', `Failed to sync Azure AD users`, error);
        throw error;
      }
    }),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

export default function createAzureADUserSyncWorker(
  concurrency = 1,
): Worker<AzureADUserSyncJobData> {
  const worker = new Worker(
    QUEUE_AZUREAD_USER_SYNC,
    processAzureADUserSync,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('azuread-user-sync', `Job ${job.id} completed`, { tenantId: job.data.tenantId });
  });

  worker.on('failed', (job, err) => {
    workerError('azuread-user-sync', `Job ${job?.id} failed`, err);
  });

  return worker;
}
