/**
 * Google Group Sync Worker
 *
 * Syncs security groups and their memberships from Google Workspace to MongoDB
 * via MongoPermissionStore (acl_group_hierarchy + contact ACL).
 *
 * Flow:
 * 1. Fetch groups from Google Directory API (/admin/directory/v1/groups endpoint)
 * 2. For each group, fetch members (/admin/directory/v1/groups/{groupId}/members)
 * 3. Upsert groups in acl_group_hierarchy collection
 * 4. Create memberships (User -> Group via contact.acl.directGroups)
 * 5. Handle nested groups (Group -> Group via parentGroups/childGroups)
 * 6. BFS recompute effective groups for all tenant contacts
 * 7. Store timestamp for incremental syncs
 *
 * Features:
 * - Timestamp-based delta sync (Google has no native delta query)
 * - Pagination with pageToken (handles 10k+ groups)
 * - Batch operations to MongoDB via MongoPermissionStore
 * - Nested group support (unlimited depth, practical limit ~50 levels)
 * - Membership sync (parallel fetching)
 *
 * Note: Google Directory API requires OAuth2 service account with domain-wide delegation
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_GOOGLE_GROUP_SYNC } from '@agent-platform/search-ai-sdk';
import { MongoPermissionStore } from '@agent-platform/search-ai-internal/permissions';
import type { CreateGroupInput } from '@agent-platform/search-ai-internal/permissions';
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
import type { GoogleGroupSyncJobData } from './shared.js';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys } from '@agent-platform/redis';

const logger = createLogger('google-group-sync');

// =============================================================================
// GOOGLE DIRECTORY API CLIENT
// =============================================================================

interface GoogleGroup {
  id: string; // Google Group ID
  email: string; // Group email address
  name: string;
  description?: string;
  directMembersCount?: string;
}

interface GoogleGroupMember {
  id: string; // Member ID (user or group)
  email: string;
  role: string; // OWNER, MANAGER, MEMBER
  type: string; // USER or GROUP
  status?: string; // ACTIVE, SUSPENDED
}

interface GoogleDirectoryGroupsResponse {
  groups: GoogleGroup[];
  nextPageToken?: string;
}

interface GoogleDirectoryMembersResponse {
  members: GoogleGroupMember[];
  nextPageToken?: string;
}

/**
 * Google Directory API Client for Groups
 */
class GoogleDirectoryGroupClient {
  private accessToken: string;
  private googleDomain: string;

  constructor(accessToken: string, googleDomain: string) {
    this.accessToken = accessToken;
    this.googleDomain = googleDomain;
  }

  /**
   * Fetch groups from Google Workspace
   */
  async fetchGroups(
    pageToken?: string,
  ): Promise<{ groups: GoogleGroup[]; nextPageToken?: string }> {
    const params = new URLSearchParams();
    params.append('customer', 'my_customer');
    params.append('domain', this.googleDomain);
    params.append('maxResults', '200'); // Google Directory API max is 200 for groups
    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const url = `https://admin.googleapis.com/admin/directory/v1/groups?${params.toString()}`;

    // Add 60s timeout
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

      const data = (await response.json()) as GoogleDirectoryGroupsResponse;

      return {
        groups: data.groups || [],
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
   * Fetch all groups (with pagination)
   */
  async fetchAllGroups(): Promise<GoogleGroup[]> {
    const allGroups: GoogleGroup[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.fetchGroups(pageToken);
      allGroups.push(...response.groups);
      pageToken = response.nextPageToken;

      logger.debug('Fetched groups page', { count: response.groups.length, hasMore: !!pageToken });
    } while (pageToken);

    return allGroups;
  }

  /**
   * Fetch group members (users and nested groups)
   */
  async fetchGroupMembers(groupId: string): Promise<GoogleGroupMember[]> {
    const url = `https://admin.googleapis.com/admin/directory/v1/groups/${groupId}/members?maxResults=200`;
    const members: GoogleGroupMember[] = [];
    let pageToken: string | undefined;

    do {
      const requestUrl = pageToken ? `${url}&pageToken=${pageToken}` : url;

      // Add 60s timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(requestUrl, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          // Non-fatal: Skip groups with access errors
          logger.warn('Failed to fetch members for group', {
            groupId,
            status: response.status,
          });
          break;
        }

        const data = (await response.json()) as GoogleDirectoryMembersResponse;
        members.push(...(data.members || []));
        pageToken = data.nextPageToken;
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
          logger.warn('Timeout fetching members for group', {
            groupId,
            error: 'Google Directory API timeout after 60s',
          });
          break; // Non-fatal: Skip this group and continue
        }
        throw error;
      }
    } while (pageToken);

    return members;
  }
}

// =============================================================================
// CACHE INVALIDATION
// =============================================================================

/**
 * Invalidate group membership cache for tenant
 *
 * After IdP group sync, group memberships have changed. Clear the cache
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

const UPSERT_BATCH_SIZE = 50; // Smaller batch for groups (includes membership fetching)

export async function processGoogleGroupSync(job: Job<GoogleGroupSyncJobData>): Promise<void> {
  const { tenantId, credentialId, syncMode, lastUpdated, googleDomain, authProfileId } = job.data;

  workerLog('google-group-sync', `Starting Google group sync (${syncMode})`, {
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

        // Step 2: Fetch groups from Google Directory API
        const googleClient = new GoogleDirectoryGroupClient(accessToken, googleDomain);
        const groups = await googleClient.fetchAllGroups();

        workerLog('google-group-sync', `Fetched ${groups.length} groups from Google Workspace`, {
          tenantId,
        });

        if (groups.length === 0) {
          workerLog('google-group-sync', 'No groups to sync', { tenantId });
          return;
        }

        // Step 3: Initialize MongoPermissionStore
        const mongoPermissionStore = MongoPermissionStore.getInstance({
          contactModel: Contact as any,
          groupHierarchyModel: AclGroupHierarchy as any,
          documentPermissionsModel: AclDocumentPermissions as any,
          blindIndexFn: createBlindIndexFn(),
          encryptFn: createEncryptFn(),
        });
        let syncedGroups = 0;
        let syncedMemberships = 0;

        // Process groups in batches
        for (let i = 0; i < groups.length; i += UPSERT_BATCH_SIZE) {
          const batch = groups.slice(i, i + UPSERT_BATCH_SIZE);

          // Step 4: Fetch memberships in parallel for this batch
          const membershipResults = await Promise.allSettled(
            batch.map(async (group) => {
              const members = await googleClient.fetchGroupMembers(group.id);
              return { group, members };
            }),
          );

          // Step 5: Upsert groups and set memberships
          for (const result of membershipResults) {
            if (result.status === 'rejected') {
              logger.warn('Failed to process group', {
                error:
                  result.reason instanceof Error ? result.reason.message : String(result.reason),
              });
              continue;
            }

            const { group, members } = result.value;

            // Upsert group in acl_group_hierarchy
            const groupInput: CreateGroupInput = {
              tenantId,
              groupId: `google:${group.id}`, // Prefixed with IdP provider
              idpGroupId: group.id,
              source: 'google',
              displayName: group.name,
              email: group.email, // Google groups have email addresses
            };

            await mongoPermissionStore.upsertGroup(groupInput);
            syncedGroups++;

            // Set memberships (User → Group and Group → Group)
            for (const member of members) {
              try {
                // Skip suspended members
                if (member.status === 'SUSPENDED') {
                  continue;
                }

                if (member.type === 'USER') {
                  // User → Group membership
                  const email = member.email;
                  if (email) {
                    await mongoPermissionStore.setMembership({
                      tenantId,
                      memberEmail: email.toLowerCase(),
                      parentGroupId: `google:${group.id}`,
                      source: 'google',
                    });
                    syncedMemberships++;
                  }
                } else if (member.type === 'GROUP') {
                  // Nested group: Group → Group membership
                  await mongoPermissionStore.setMembership({
                    tenantId,
                    memberGroupId: `google:${member.id}`, // Child group
                    parentGroupId: `google:${group.id}`, // Parent group
                    source: 'google',
                  });
                  syncedMemberships++;
                }
              } catch (error) {
                // Non-fatal: Log and continue
                logger.warn('Failed to create membership relationship', {
                  groupId: group.id,
                  memberId: member.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }

          // Update progress
          const progress = Math.round(((i + batch.length) / groups.length) * 100);
          await job.updateProgress(progress);

          workerLog('google-group-sync', `Synced batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}`, {
            tenantId,
            batchSize: batch.length,
            totalSynced: syncedGroups,
          });
        }

        // Step 6: BFS recompute effective groups for all contacts
        const recomputedContacts =
          await mongoPermissionStore.recomputeEffectiveGroupsForTenant(tenantId);
        workerLog('google-group-sync', 'BFS recomputation complete', {
          tenantId,
          contactsRecomputed: recomputedContacts,
        });

        // Step 7: Store timestamp for next incremental sync
        const currentTimestamp = new Date().toISOString();
        await LLMCredential.findOneAndUpdate(
          { _id: credentialId, tenantId },
          {
            $set: {
              'metadata.googleGroupSyncLastUpdated': currentTimestamp,
              'metadata.lastGroupSync': new Date(),
            },
          },
        );

        workerLog('google-group-sync', 'Stored timestamp for future incremental syncs', {
          tenantId,
          syncMode,
          timestamp: currentTimestamp,
        });

        // Step 7: Invalidate group membership cache
        // Group memberships have changed, clear cache to force fresh queries
        const cacheKeysDeleted = await invalidateGroupMembershipCache(tenantId);

        workerLog('google-group-sync', `Google group sync complete`, {
          tenantId,
          totalGroups: groups.length,
          syncedGroups,
          syncedMemberships,
          syncMode,
          cacheKeysDeleted,
        });
      } catch (error) {
        workerError('google-group-sync', `Failed to sync Google groups`, error);
        throw error;
      }
    }),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

export default function createGoogleGroupSyncWorker(
  concurrency = 1,
): Worker<GoogleGroupSyncJobData> {
  const worker = new Worker(
    QUEUE_GOOGLE_GROUP_SYNC,
    processGoogleGroupSync,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('google-group-sync', `Job ${job.id} completed`, { tenantId: job.data.tenantId });
  });

  worker.on('failed', (job, err) => {
    workerError('google-group-sync', `Job ${job?.id} failed`, err);
  });

  return worker;
}
