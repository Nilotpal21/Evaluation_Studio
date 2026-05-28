/**
 * Membership Repository
 *
 * MongoDB operations for variable namespace memberships (many-to-many join collection).
 * Links environment variables and config variables to namespaces.
 */

import type { ClientSession } from 'mongoose';

export async function addVariableNamespaceMemberships(
  tenantId: string,
  projectId: string,
  namespaceId: string,
  variables: Array<{ variableId: string; variableType: 'env' | 'config' }>,
  session?: ClientSession,
): Promise<void> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');

  const docs = variables.map((v) => ({
    tenantId,
    projectId,
    namespaceId,
    variableId: v.variableId,
    variableType: v.variableType,
  }));

  try {
    await VariableNamespaceMembership.insertMany(docs, {
      ordered: false,
      session,
    });
  } catch (err: unknown) {
    // Ignore duplicate key errors (code 11000), rethrow others
    if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
      // Duplicate memberships are acceptable
      return;
    }
    throw err;
  }
}

export async function removeVariableNamespaceMembership(
  tenantId: string,
  namespaceId: string,
  variableId: string,
  variableType: 'env' | 'config',
  session?: ClientSession,
): Promise<void> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  await VariableNamespaceMembership.deleteOne(
    { tenantId, namespaceId, variableId, variableType },
    { session },
  );
}

export async function findMembershipsByVariableNamespace(
  tenantId: string,
  projectId: string,
  namespaceId: string,
): Promise<any[]> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  return VariableNamespaceMembership.find({ tenantId, projectId, namespaceId }).lean();
}

export async function findVariableNamespaceMembershipsByVariable(
  tenantId: string,
  variableId: string,
  variableType: 'env' | 'config',
): Promise<any[]> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  return VariableNamespaceMembership.find({ tenantId, variableId, variableType }).lean();
}

export async function countVariableNamespaceMembershipsForVariable(
  tenantId: string,
  variableId: string,
  variableType: 'env' | 'config',
): Promise<number> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  return VariableNamespaceMembership.countDocuments({ tenantId, variableId, variableType });
}

export async function deleteAllVariableNamespaceMembershipsForVariable(
  variableId: string,
  variableType: 'env' | 'config',
  session?: ClientSession,
): Promise<void> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  await VariableNamespaceMembership.deleteMany({ variableId, variableType }, { session });
}

export async function deleteAllMembershipsForVariableNamespace(
  namespaceId: string,
  session?: ClientSession,
): Promise<void> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  await VariableNamespaceMembership.deleteMany({ namespaceId }, { session });
}

export async function moveVariableNamespaceMemberships(
  tenantId: string,
  projectId: string,
  sourceNsId: string,
  targetNsId: string,
  variables: Array<{ variableId: string; variableType: 'env' | 'config' }>,
  session?: ClientSession,
): Promise<void> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');

  const bulkOps = variables.flatMap((v) => [
    {
      deleteOne: {
        filter: {
          tenantId,
          namespaceId: sourceNsId,
          variableId: v.variableId,
          variableType: v.variableType,
        },
      },
    },
    {
      insertOne: {
        document: {
          tenantId,
          projectId,
          namespaceId: targetNsId,
          variableId: v.variableId,
          variableType: v.variableType,
        },
      },
    },
  ]);

  if (bulkOps.length > 0) {
    await VariableNamespaceMembership.bulkWrite(bulkOps, { session });
  }
}

export async function findVariableNamespaceMembershipsByVariableIds(
  tenantId: string,
  variableIds: string[],
): Promise<any[]> {
  const { VariableNamespaceMembership } = await import('@agent-platform/database/models');
  return VariableNamespaceMembership.find({ tenantId, variableId: { $in: variableIds } }).lean();
}
