/**
 * RBAC Repository
 *
 * MongoDB role definition and resource permission lookups.
 * Used by: services/permission-resolution.ts
 */

export async function findRoleDefinitions(tenantId: string): Promise<any[]> {
  const { RoleDefinition } = await import('@agent-platform/database/models');
  return RoleDefinition.find({ tenantId }).lean();
}

export async function findResourcePermissions(where: {
  tenantId: string;
  userId: string;
}): Promise<any[]> {
  const { ResourcePermission } = await import('@agent-platform/database/models');
  return ResourcePermission.find(where).lean();
}
