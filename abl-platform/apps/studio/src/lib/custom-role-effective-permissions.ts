import {
  hasPermission,
  resolveRolePermissions,
  type RoleDefinitionRecord,
} from '@agent-platform/shared/rbac';

export interface RawRoleDefinitionRecord extends Record<string, unknown> {
  _id?: unknown;
  id?: unknown;
  name?: unknown;
  permissions?: unknown;
  parentRoleId?: unknown;
}

export interface EffectiveRoleDraft {
  id: string;
  name: string;
  permissions: string[];
  parentRoleId: string | null;
}

export interface EffectivePermissionValidationResult {
  effectivePermissions: string[];
  exceedingPermissions: string[];
  error?: string;
}

export function mapRoleDefinitionRecords(
  rawRoles: readonly RawRoleDefinitionRecord[],
): RoleDefinitionRecord[] {
  return rawRoles.map((role) => ({
    id: String(role.id ?? role._id),
    name: String(role.name ?? ''),
    permissions: JSON.stringify(Array.isArray(role.permissions) ? role.permissions : []),
    parentRoleId: typeof role.parentRoleId === 'string' ? role.parentRoleId : null,
  }));
}

function wouldCreateParentCycle(
  roleId: string,
  parentRoleId: string | null,
  roles: readonly RoleDefinitionRecord[],
): boolean {
  let nextParentRoleId = parentRoleId;
  const visited = new Set<string>();

  while (nextParentRoleId) {
    if (nextParentRoleId === roleId) {
      return true;
    }

    if (visited.has(nextParentRoleId)) {
      return true;
    }
    visited.add(nextParentRoleId);

    const parentRole = roles.find((role) => role.id === nextParentRoleId);
    nextParentRoleId = parentRole?.parentRoleId ?? null;
  }

  return false;
}

export function validateEffectiveRolePermissionCeiling(
  rawRoles: readonly RawRoleDefinitionRecord[],
  draft: EffectiveRoleDraft,
  ceiling: readonly string[],
): EffectivePermissionValidationResult {
  const mappedRoles = mapRoleDefinitionRecords(rawRoles);
  const parentRoleId = draft.parentRoleId;

  if (parentRoleId && !mappedRoles.some((role) => role.id === parentRoleId)) {
    return {
      effectivePermissions: [],
      exceedingPermissions: [],
      error: 'parentRoleId must reference an existing role in this workspace',
    };
  }

  const rolesWithDraft = [
    ...mappedRoles.filter((role) => role.id !== draft.id),
    {
      id: draft.id,
      name: draft.name,
      permissions: JSON.stringify(draft.permissions),
      parentRoleId,
    },
  ];

  if (wouldCreateParentCycle(draft.id, parentRoleId, rolesWithDraft)) {
    return {
      effectivePermissions: [],
      exceedingPermissions: [],
      error: 'parentRoleId would create a role inheritance cycle',
    };
  }

  const effectivePermissions = resolveRolePermissions(
    rolesWithDraft.find((role) => role.id === draft.id),
    rolesWithDraft,
  );
  const exceedingPermissions = effectivePermissions.filter(
    (permission) => !hasPermission(ceiling, permission),
  );

  return { effectivePermissions, exceedingPermissions };
}
