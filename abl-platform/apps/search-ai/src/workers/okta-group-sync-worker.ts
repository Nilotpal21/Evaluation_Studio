/**
 * Okta Group Sync Worker
 *
 * Syncs security groups and their memberships from Okta to MongoDB
 * via MongoPermissionStore (acl_group_hierarchy + contact ACL).
 *
 * Flow:
 * 1. Fetch groups from Okta API (/api/v1/groups endpoint)
 * 2. For each group, fetch members (/api/v1/groups/{id}/users)
 * 3. Upsert groups in acl_group_hierarchy collection
 * 4. Create memberships (User → Group via contact.acl.directGroups)
 * 5. Handle nested groups (Group → Group via parentGroups/childGroups)
 * 6. BFS recompute effective groups for all tenant contacts
 * 7. Store lastUpdated timestamp for incremental syncs
 *
 * Features:
 * - Delta query support via filter=lastUpdated gt timestamp
 * - Pagination with 'after' cursor (handles 10k+ groups)
 * - Batch operations to MongoDB via MongoPermissionStore
 * - Nested group support (up to 100 levels in Okta)
 * - Membership sync (parallel fetching)
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_OKTA_GROUP_SYNC } from '@agent-platform/search-ai-sdk';
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
import type { OktaGroupSyncJobData } from './shared.js';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys } from '@agent-platform/redis';

const logger = createLogger('okta-group-sync');

// =============================================================================
// OKTA API CLIENT
// =============================================================================

interface OktaGroup {
  id: string; // Okta Group ID
  profile: {
    name: string;
    description?: string;
  };
  type: string; // OKTA_GROUP, APP_GROUP, or BUILT_IN
  lastUpdated: string; // ISO 8601 timestamp
}

interface OktaGroupMember {
  id: string; // User or Group ID
  type: string; // "User" or "Group"
  profile: {
    email?: string;
    login?: string;
  };
}

/**
 * Okta API Client for Groups
 */
class OktaGroupClient {
  private apiToken: string;
  private oktaDomain: string;

  constructor(apiToken: string, oktaDomain: string) {
    this.apiToken = apiToken;
    this.oktaDomain = oktaDomain;
  }

  /**
   * Fetch groups from Okta
   */
  async fetchGroups(
    after?: string,
    lastUpdated?: string,
  ): Promise<{ groups: OktaGroup[]; after?: string }> {
    const params = new URLSearchParams();
    params.append('limit', '200');
    if (after) {
      params.append('after', after);
    }
    if (lastUpdated) {
      params.append('filter', `lastUpdated gt "${lastUpdated}"`);
    }

    const url = `https://${this.oktaDomain}/api/v1/groups?${params.toString()}`;

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

      const groups = (await response.json()) as OktaGroup[];

      // Extract 'after' cursor from Link header
      const linkHeader = response.headers.get('link');
      let nextAfter: string | undefined;

      if (linkHeader) {
        const match = linkHeader.match(/after=([^&>]+)/);
        if (match) {
          nextAfter = match[1];
        }
      }

      return {
        groups,
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
   * Fetch all groups (with pagination)
   */
  async fetchAllGroups(lastUpdated?: string): Promise<OktaGroup[]> {
    const allGroups: OktaGroup[] = [];
    let after: string | undefined;

    do {
      const response = await this.fetchGroups(after, lastUpdated);
      allGroups.push(...response.groups);
      after = response.after;

      logger.debug('Fetched groups page', { count: response.groups.length, hasMore: !!after });
    } while (after);

    return allGroups;
  }

  /**
   * Fetch group members (users and nested groups)
   *
   * Note: Okta's /api/v1/groups/{groupId}/users returns both users and nested groups
   */
  async fetchGroupMembers(groupId: string): Promise<OktaGroupMember[]> {
    const url = `https://${this.oktaDomain}/api/v1/groups/${groupId}/users?limit=200`;
    const members: OktaGroupMember[] = [];
    let after: string | undefined;

    do {
      const requestUrl = after ? `${url}&after=${after}` : url;

      // Add 120s timeout to prevent hanging on slow/unresponsive API
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      try {
        const response = await fetch(requestUrl, {
          headers: {
            Authorization: `SSWS ${this.apiToken}`,
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

        const data = (await response.json()) as OktaGroupMember[];
        members.push(...data);

        // Extract 'after' cursor from Link header
        const linkHeader = response.headers.get('link');
        if (linkHeader) {
          const match = linkHeader.match(/after=([^&>]+)/);
          after = match ? match[1] : undefined;
        } else {
          after = undefined;
        }
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
          logger.warn('Timeout fetching members for group', {
            groupId,
            error: 'Okta API timeout after 120s',
          });
          break; // Non-fatal: Skip this group and continue
        }
        throw error;
      }
    } while (after);

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

export async function processOktaGroupSync(job: Job<OktaGroupSyncJobData>): Promise<void> {
  const { tenantId, credentialId, syncMode, lastUpdated, oktaDomain, authProfileId } = job.data;

  workerLog('okta-group-sync', `Starting Okta group sync (${syncMode})`, {
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

        // Step 2: Fetch groups from Okta API
        const oktaClient = new OktaGroupClient(apiToken, oktaDomain);
        const groups = await oktaClient.fetchAllGroups(
          syncMode === 'delta' ? lastUpdated : undefined,
        );

        workerLog('okta-group-sync', `Fetched ${groups.length} groups from Okta`, {
          tenantId,
        });

        if (groups.length === 0) {
          workerLog('okta-group-sync', 'No groups to sync', { tenantId });
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
              const members = await oktaClient.fetchGroupMembers(group.id);
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
              groupId: `okta:${group.id}`, // Prefixed with IdP provider
              idpGroupId: group.id,
              source: 'okta',
              displayName: group.profile.name,
            };

            await mongoPermissionStore.upsertGroup(groupInput);
            syncedGroups++;

            // Set memberships (User → Group and Group → Group)
            for (const member of members) {
              try {
                if (member.type === 'User') {
                  // User → Group membership
                  const email = member.profile.email || member.profile.login;
                  if (email) {
                    await mongoPermissionStore.setMembership({
                      tenantId,
                      memberEmail: email.toLowerCase(),
                      parentGroupId: `okta:${group.id}`,
                      source: 'okta',
                    });
                    syncedMemberships++;
                  }
                } else if (member.type === 'Group') {
                  // Nested group: Group → Group membership
                  await mongoPermissionStore.setMembership({
                    tenantId,
                    memberGroupId: `okta:${member.id}`, // Child group
                    parentGroupId: `okta:${group.id}`, // Parent group
                    source: 'okta',
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

          workerLog('okta-group-sync', `Synced batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}`, {
            tenantId,
            batchSize: batch.length,
            totalSynced: syncedGroups,
          });
        }

        // Step 6: BFS recompute effective groups for all contacts
        const recomputedContacts =
          await mongoPermissionStore.recomputeEffectiveGroupsForTenant(tenantId);
        workerLog('okta-group-sync', 'BFS recomputation complete', {
          tenantId,
          contactsRecomputed: recomputedContacts,
        });

        // Step 7: Store lastUpdated timestamp
        const currentTimestamp = new Date().toISOString();
        await LLMCredential.findOneAndUpdate(
          { _id: credentialId, tenantId },
          {
            $set: {
              'metadata.oktaGroupSyncLastUpdated': currentTimestamp,
              'metadata.lastGroupSync': new Date(),
            },
          },
        );

        workerLog('okta-group-sync', 'Stored lastUpdated timestamp for future incremental syncs', {
          tenantId,
          syncMode,
          timestamp: currentTimestamp,
        });

        // Step 7: Invalidate group membership cache
        // Group memberships have changed, clear cache to force fresh queries
        const cacheKeysDeleted = await invalidateGroupMembershipCache(tenantId);

        workerLog('okta-group-sync', `Okta group sync complete`, {
          tenantId,
          totalGroups: groups.length,
          syncedGroups,
          syncedMemberships,
          syncMode,
          cacheKeysDeleted,
        });
      } catch (error) {
        workerError('okta-group-sync', `Failed to sync Okta groups`, error);
        throw error;
      }
    }),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

export default function createOktaGroupSyncWorker(concurrency = 1): Worker<OktaGroupSyncJobData> {
  const worker = new Worker(
    QUEUE_OKTA_GROUP_SYNC,
    processOktaGroupSync,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('okta-group-sync', `Job ${job.id} completed`, { tenantId: job.data.tenantId });
  });

  worker.on('failed', (job, err) => {
    workerError('okta-group-sync', `Job ${job?.id} failed`, err);
  });

  return worker;
}
