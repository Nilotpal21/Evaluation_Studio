/**
 * Effective Groups Computation Service
 *
 * Pre-computes the transitive closure of group memberships at sync time.
 * Replaces Neo4j's runtime MEMBER_OF*1..20 traversal.
 *
 * Algorithm: BFS from a user's direct groups upward through the group
 * hierarchy. Handles cycles (via visited set) and enforces max depth 20.
 *
 * Performance:
 * - Load hierarchy: one MongoDB query (~5ms for 5K groups, ~2MB in memory)
 * - BFS per user: microseconds (in-memory traversal)
 * - Write result: one MongoDB updateOne (~2ms)
 * - Total per user: ~7ms (vs Neo4j MEMBER_OF*1..20 at 20-50ms per query)
 *
 * The hierarchy is loaded ONCE per tenant per sync cycle and reused
 * for all users in that tenant.
 */

import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('effective-groups-compute');

const MAX_BFS_DEPTH = 20;

/**
 * In-memory group hierarchy for BFS traversal.
 * Maps groupId → parentGroupIds.
 */
export type GroupHierarchyMap = Map<string, string[]>;

/**
 * Load the full group hierarchy for a tenant into an in-memory map.
 *
 * @param tenantId - Tenant to load hierarchy for
 * @param aclGroupHierarchyModel - Mongoose model for acl_group_hierarchy
 * @returns Map of groupId → parentGroupIds
 */
export async function loadGroupHierarchy(
  tenantId: string,
  aclGroupHierarchyModel: {
    find: (filter: Record<string, unknown>) => {
      select: (fields: Record<string, number>) => {
        lean: () => Promise<Array<{ groupId: string; parentGroups: string[] }>>;
      };
    };
  },
): Promise<GroupHierarchyMap> {
  const docs = await aclGroupHierarchyModel
    .find({ tenantId })
    .select({ groupId: 1, parentGroups: 1 })
    .lean();

  const map: GroupHierarchyMap = new Map();
  for (const doc of docs) {
    map.set(doc.groupId, doc.parentGroups ?? []);
  }

  log.debug('Loaded group hierarchy into memory', {
    tenantId,
    groupCount: map.size,
  });

  return map;
}

/**
 * Compute the transitive closure of group memberships using BFS.
 *
 * Starting from the user's direct groups, traverses upward through
 * parent groups to build the complete set of effective groups.
 *
 * @param directGroups - The user's direct group IDs
 * @param hierarchy - In-memory group hierarchy map (groupId → parentGroupIds)
 * @returns Array of all effective group IDs (direct + transitive)
 */
export function computeEffectiveGroups(
  directGroups: string[],
  hierarchy: GroupHierarchyMap,
): string[] {
  const effective = new Set<string>();
  const queue: Array<{ groupId: string; depth: number }> = [];

  // Seed BFS with direct groups
  for (const groupId of directGroups) {
    if (!effective.has(groupId)) {
      queue.push({ groupId, depth: 0 });
    }
  }

  // BFS upward through parent groups
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;

    const { groupId, depth } = item;

    // Cycle detection: skip if already visited
    if (effective.has(groupId)) continue;

    // Depth limit: prevent infinite traversal in deep/cyclic hierarchies
    if (depth > MAX_BFS_DEPTH) {
      log.warn('BFS depth limit reached, truncating traversal', {
        groupId,
        depth,
        maxDepth: MAX_BFS_DEPTH,
      });
      continue;
    }

    effective.add(groupId);

    // Enqueue parent groups
    const parents = hierarchy.get(groupId);
    if (parents) {
      for (const parentId of parents) {
        if (!effective.has(parentId)) {
          queue.push({ groupId: parentId, depth: depth + 1 });
        }
      }
    }
  }

  return Array.from(effective);
}
