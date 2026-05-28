/**
 * Azure AD Group Sync Worker
 *
 * Syncs security groups and their memberships from Azure AD to MongoDB.
 * Creates groups in acl_group_hierarchy and MEMBER_OF relationships on contact cards.
 *
 * Flow:
 * 1. Fetch groups from Microsoft Graph API (/groups endpoint)
 * 2. For each group, fetch members (/groups/{id}/members)
 * 3. Upsert groups to acl_group_hierarchy via MongoPermissionStore
 * 4. Set memberships (User → Group, Group → Group) via MongoPermissionStore
 * 5. Trigger BFS recomputation of effective groups for the tenant
 * 6. Store delta token for incremental syncs
 *
 * Features:
 * - Delta query support (incremental syncs)
 * - Pagination (handles 10k+ groups)
 * - Batch operations to MongoDB
 * - Nested group support (up to 20 levels via BFS)
 * - Membership sync (parallel fetching)
 * - BFS recomputation after sync (pre-computes effective groups)
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_AZUREAD_GROUP_SYNC } from '@agent-platform/search-ai-sdk';
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
import type { AzureADGroupSyncJobData } from './shared.js';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys } from '@agent-platform/redis';

const logger = createLogger('azuread-group-sync');

// =============================================================================
// MICROSOFT GRAPH API CLIENT
// =============================================================================

interface GraphGroup {
  id: string; // Azure AD Group Object ID
  displayName: string;
  mail?: string; // Distribution list email
  securityEnabled?: boolean;
  mailEnabled?: boolean;
}

interface GraphMember {
  '@odata.type': string; // #microsoft.graph.user or #microsoft.graph.group
  id: string;
  userPrincipalName?: string; // For users
  mail?: string;
}

interface GraphAPIResponse<T> {
  '@odata.context': string;
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
  value: T[];
}

/**
 * Microsoft Graph API Client for Groups
 */
class MicrosoftGraphGroupClient {
  private accessToken: string;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Fetch groups from Azure AD
   */
  async fetchGroups(
    deltaLink?: string,
  ): Promise<{ groups: GraphGroup[]; nextLink?: string; deltaLink?: string }> {
    const url =
      deltaLink ||
      `${this.baseUrl}/groups/delta?$select=id,displayName,mail,securityEnabled,mailEnabled&$top=100`;

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

      const data = (await response.json()) as GraphAPIResponse<GraphGroup>;

      return {
        groups: data.value,
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
   * Fetch all groups (with pagination)
   */
  async fetchAllGroups(deltaLink?: string): Promise<{ groups: GraphGroup[]; deltaLink?: string }> {
    const allGroups: GraphGroup[] = [];
    let nextLink: string | undefined = deltaLink;
    let finalDeltaLink: string | undefined;

    do {
      const response = await this.fetchGroups(nextLink);
      allGroups.push(...response.groups);
      nextLink = response.nextLink;
      finalDeltaLink = response.deltaLink;

      logger.debug('Fetched groups page', { count: response.groups.length, hasMore: !!nextLink });
    } while (nextLink);

    return {
      groups: allGroups,
      deltaLink: finalDeltaLink,
    };
  }

  /**
   * Fetch group members (users and nested groups)
   */
  async fetchGroupMembers(groupId: string): Promise<GraphMember[]> {
    const url = `${this.baseUrl}/groups/${groupId}/members?$select=id,userPrincipalName,mail`;
    const members: GraphMember[] = [];
    let nextLink: string | undefined = url;

    do {
      // Add 120s timeout to prevent hanging on slow/unresponsive API
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      try {
        const response = await fetch(nextLink, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          // Non-fatal: Skip groups with access errors
          logger.warn(`Failed to fetch members for group ${groupId}`, {
            status: response.status,
          });
          break;
        }

        const data = (await response.json()) as GraphAPIResponse<GraphMember>;
        members.push(...data.value);
        nextLink = data['@odata.nextLink'];
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
          logger.warn(`Timeout fetching members for group ${groupId}`, {
            error: 'Microsoft Graph API timeout after 120s',
          });
          break; // Non-fatal: Skip this group and continue
        }
        throw error;
      }
    } while (nextLink);

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

const UPSERT_BATCH_SIZE = 50; // Smaller batch for groups (includes membership fetching)

async function processAzureADGroupSync(job: Job<AzureADGroupSyncJobData>): Promise<void> {
  const { tenantId, credentialId, syncMode, deltaToken, authProfileId } = job.data;

  workerLog('azuread-group-sync', `Starting Azure AD group sync (${syncMode})`, {
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

        // LLMCredential model needed for both legacy fallback and delta token storage
        const LLMCredential = getLazyModel<ILLMCredential>('LLMCredential');

        // Legacy credential path (fallback)
        if (!accessToken) {
          const credential = await LLMCredential.findOne({
            _id: credentialId,
            tenantId,
            isActive: true,
          });

          accessToken = await resolveLegacyCredentialApiKey(credential, tenantId, credentialId);
        }

        // Step 2: Fetch groups from Microsoft Graph API
        const graphClient = new MicrosoftGraphGroupClient(accessToken);
        const { groups, deltaLink: newDeltaLink } = await graphClient.fetchAllGroups(
          syncMode === 'delta' ? deltaToken : undefined,
        );

        workerLog('azuread-group-sync', `Fetched ${groups.length} groups from Azure AD`, {
          tenantId,
        });

        if (groups.length === 0) {
          workerLog('azuread-group-sync', 'No groups to sync', { tenantId });
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
              const members = await graphClient.fetchGroupMembers(group.id);
              return { group, members };
            }),
          );

          // Step 5: Upsert groups and create relationships
          for (const result of membershipResults) {
            if (result.status === 'rejected') {
              logger.warn('Failed to process group', { error: result.reason });
              continue;
            }

            const { group, members } = result.value;

            // Upsert group in acl_group_hierarchy
            const groupInput: CreateGroupInput = {
              tenantId,
              groupId: `azuread:${group.id}`, // Prefixed with IdP provider
              idpGroupId: group.id,
              source: 'azuread',
              displayName: group.displayName,
              email: group.mail,
            };

            await mongoPermissionStore.upsertGroup(groupInput);
            syncedGroups++;

            // Set memberships (User → Group and Group → Group)
            for (const member of members) {
              try {
                if (member['@odata.type'] === '#microsoft.graph.user') {
                  // User → Group membership
                  const email = member.mail || member.userPrincipalName;
                  if (email) {
                    await mongoPermissionStore.setMembership({
                      tenantId,
                      memberEmail: email.toLowerCase(),
                      parentGroupId: `azuread:${group.id}`,
                      source: 'azuread',
                    });
                    syncedMemberships++;
                  }
                } else if (member['@odata.type'] === '#microsoft.graph.group') {
                  // Nested group: Group → Group membership (parent-child)
                  await mongoPermissionStore.setMembership({
                    tenantId,
                    memberGroupId: `azuread:${member.id}`, // Child group
                    parentGroupId: `azuread:${group.id}`, // Parent group
                    source: 'azuread',
                  });
                  syncedMemberships++;
                }
              } catch (error) {
                // Non-fatal: Log and continue
                logger.warn('Failed to create membership relationship', {
                  groupId: group.id,
                  memberId: member.id,
                  error,
                });
              }
            }
          }

          // Update progress
          const progress = Math.round(((i + batch.length) / groups.length) * 100);
          await job.updateProgress(progress);

          workerLog('azuread-group-sync', `Synced batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}`, {
            tenantId,
            batchSize: batch.length,
            totalSynced: syncedGroups,
          });
        }

        // Step 6: BFS recompute effective groups for all contacts in the tenant
        // Group hierarchy changed → need to recompute transitive closures
        const recomputedContacts =
          await mongoPermissionStore.recomputeEffectiveGroupsForTenant(tenantId);

        workerLog('azuread-group-sync', 'BFS recomputation complete', {
          tenantId,
          contactsRecomputed: recomputedContacts,
        });

        // Step 7: Store delta token
        // Store for both full AND delta syncs to ensure token is always current
        if (newDeltaLink) {
          await LLMCredential.findOneAndUpdate(
            { _id: credentialId, tenantId },
            {
              $set: {
                'metadata.azureadGroupSyncDeltaToken': newDeltaLink,
                'metadata.lastGroupSync': new Date(),
              },
            },
          );

          workerLog('azuread-group-sync', 'Stored delta token for future incremental syncs', {
            tenantId,
            syncMode,
          });
        }

        // Step 8: Invalidate group membership cache
        // Group memberships have changed, clear cache to force fresh lookups
        const cacheKeysDeleted = await invalidateGroupMembershipCache(tenantId);

        workerLog('azuread-group-sync', `Azure AD group sync complete`, {
          tenantId,
          totalGroups: groups.length,
          syncedGroups,
          syncedMemberships,
          syncMode,
          cacheKeysDeleted,
        });
      } catch (error) {
        workerError('azuread-group-sync', `Failed to sync Azure AD groups`, error);
        throw error;
      }
    }),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

export default function createAzureADGroupSyncWorker(
  concurrency = 1,
): Worker<AzureADGroupSyncJobData> {
  const worker = new Worker(
    QUEUE_AZUREAD_GROUP_SYNC,
    processAzureADGroupSync,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('azuread-group-sync', `Job ${job.id} completed`, { tenantId: job.data.tenantId });
  });

  worker.on('failed', (job, err) => {
    workerError('azuread-group-sync', `Job ${job?.id} failed`, err);
  });

  return worker;
}
