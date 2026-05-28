/**
 * Migration: backfill guardrail and PII permissions for active custom project roles
 *
 * ABLP-673 added project-scoped guardrail and PII-pattern route authorization.
 * Built-in project roles resolve from code, but active custom project roles are
 * stored as RoleDefinition rows and can otherwise miss the new safety contract.
 *
 * This migration is intentionally conservative:
 * - only RoleDefinition rows referenced by ProjectMember(role="custom") are considered
 * - write-capable custom project roles receive read/write safety permissions
 * - read-capable custom project roles receive read-only safety permissions
 * - narrow or unreferenced custom roles are left untouched
 *
 * Date: 2026-05-10
 */

import mongoose from 'mongoose';
import {
  resolveRolePermissions,
  type RoleDefinitionRecord,
} from '@agent-platform/shared-auth/rbac';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';
const PROJECT_MEMBERS_COLLECTION = 'project_members';
const MIGRATION_GRANTS_COLLECTION = '_migration_role_permission_grants';
const MIGRATION_VERSION = '20260510_030';

const READ_SAFETY_PERMISSIONS = ['guardrail:read', 'pii-pattern:read'] as const;
const WRITE_SAFETY_PERMISSIONS = ['guardrail:write', 'pii-pattern:write'] as const;
const ALL_SAFETY_PERMISSIONS = [...READ_SAFETY_PERMISSIONS, ...WRITE_SAFETY_PERMISSIONS] as const;

const READ_TRIGGER_PERMISSIONS = [
  'agent:read',
  'tool:read',
  'version:read',
  'deployment:read',
  'channel:read',
  'env_var:read',
  'session:read',
  'workflow:read',
  'channel_connection:read',
  'credential:read',
  'lookup_data:read',
  'project:export',
  'attachment:read',
  'analytics:read',
  'prompt:read',
  'external_agent:read',
  'governance:audit-read',
] as const;

const WRITE_TRIGGER_PERMISSIONS = [
  'agent:create',
  'agent:update',
  'agent:delete',
  'tool:write',
  'tool:delete',
  'version:create',
  'version:update',
  'version:delete',
  'workflow:write',
  'workflow:create',
  'workflow:update',
  'workflow:delete',
  'channel:create',
  'channel:update',
  'channel:delete',
  'channel_connection:create',
  'channel_connection:update',
  'channel_connection:delete',
  'env_var:create',
  'env_var:update',
  'env_var:delete',
  'credential:write',
  'credential:manage',
  'credential:delete',
  'lookup_data:write',
  'lookup_data:delete',
  'attachment:write',
  'runtime_config:write',
  'model_config:write',
  'prompt:create',
  'prompt:update',
  'prompt:delete',
  'prompt:promote',
  'external_agent:create',
  'external_agent:update',
  'external_agent:delete',
  'governance:write',
] as const;

type SafetyPermission = (typeof ALL_SAFETY_PERMISSIONS)[number];

interface CandidateRole {
  _id: unknown;
  name?: unknown;
  tenantId?: unknown;
  permissions?: unknown;
  parentRoleId?: unknown;
  isSystem?: unknown;
}

interface RoleBackfillPlan {
  roleId: string;
  tenantId: string | null;
  targetPermissions: SafetyPermission[];
  missingPermissions: SafetyPermission[];
}

function normalizePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (permission): permission is string => typeof permission === 'string' && permission.length > 0,
  );
}

function hasAnyPermission(permissions: ReadonlySet<string>, targets: readonly string[]): boolean {
  return targets.some((permission) => permissions.has(permission));
}

function determineTargetSafetyPermissions(permissions: string[]): SafetyPermission[] {
  const permissionSet = new Set(permissions);
  const hasWriteAuthority =
    hasAnyPermission(permissionSet, WRITE_TRIGGER_PERMISSIONS) ||
    hasAnyPermission(permissionSet, WRITE_SAFETY_PERMISSIONS);

  if (hasWriteAuthority) {
    return [...ALL_SAFETY_PERMISSIONS];
  }

  const hasReadAuthority =
    hasAnyPermission(permissionSet, READ_TRIGGER_PERMISSIONS) ||
    hasAnyPermission(permissionSet, READ_SAFETY_PERMISSIONS);

  return hasReadAuthority ? [...READ_SAFETY_PERMISSIONS] : [];
}

function mapRoleDefinitions(roles: CandidateRole[]): RoleDefinitionRecord[] {
  return roles.map((role) => ({
    id: String(role._id),
    name: String(role.name ?? ''),
    permissions: JSON.stringify(normalizePermissions(role.permissions)),
    parentRoleId: typeof role.parentRoleId === 'string' ? role.parentRoleId : null,
  }));
}

async function listReferencedCustomRoleIds(db: Db): Promise<string[]> {
  const projectMembers = db.collection(PROJECT_MEMBERS_COLLECTION);
  const roleIds = await projectMembers.distinct('customRoleId', {
    role: 'custom',
    customRoleId: { $type: 'string', $ne: '' },
  });

  return roleIds.filter((roleId): roleId is string => typeof roleId === 'string');
}

async function buildBackfillPlans(db: Db): Promise<RoleBackfillPlan[]> {
  const referencedRoleIds = await listReferencedCustomRoleIds(db);
  if (referencedRoleIds.length === 0) {
    return [];
  }

  const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
  const roles = (await roleDefinitions
    .find({} as Record<string, unknown>)
    .project({ tenantId: 1, name: 1, permissions: 1, parentRoleId: 1, isSystem: 1 })
    .toArray()) as CandidateRole[];
  const referencedRoleIdSet = new Set(referencedRoleIds);
  const mappedRoles = mapRoleDefinitions(roles);

  return roles
    .filter((role) => role.isSystem !== true && referencedRoleIdSet.has(String(role._id)))
    .map((role) => {
      const roleId = String(role._id);
      const permissions = normalizePermissions(role.permissions);
      const effectivePermissions = resolveRolePermissions(
        mappedRoles.find((candidate) => candidate.id === roleId),
        mappedRoles,
      );
      const targetPermissions = determineTargetSafetyPermissions(effectivePermissions);
      const missingPermissions = targetPermissions.filter(
        (permission) => !permissions.includes(permission),
      );

      return {
        roleId,
        tenantId: role.tenantId ? String(role.tenantId) : null,
        targetPermissions,
        missingPermissions,
      };
    })
    .filter((plan) => plan.targetPermissions.length > 0);
}

export const migration: Migration = {
  version: MIGRATION_VERSION,
  description: 'Backfill safety permissions for active custom project roles',

  async up(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const migrationGrants = db.collection(MIGRATION_GRANTS_COLLECTION);
    await migrationGrants.createIndex(
      { migrationVersion: 1, roleId: 1 },
      { unique: true, name: 'migration_role_permission_grants_version_role_idx' },
    );

    const plans = await buildBackfillPlans(db);
    let updatedRoleCount = 0;
    let grantedPermissionCount = 0;

    for (const plan of plans) {
      if (plan.missingPermissions.length === 0) {
        continue;
      }

      const updateResult = await roleDefinitions.updateOne(
        { _id: plan.roleId, isSystem: false } as Record<string, unknown>,
        { $addToSet: { permissions: { $each: plan.missingPermissions } } },
      );

      if (updateResult.modifiedCount > 0) {
        updatedRoleCount += 1;
        grantedPermissionCount += plan.missingPermissions.length;
        await migrationGrants.updateOne(
          { migrationVersion: MIGRATION_VERSION, roleId: plan.roleId },
          {
            $setOnInsert: {
              migrationVersion: MIGRATION_VERSION,
              roleId: plan.roleId,
              tenantId: plan.tenantId,
              createdAt: new Date(),
            },
            $addToSet: { permissions: { $each: plan.missingPermissions } },
          },
          { upsert: true },
        );
      }
    }

    console.log(
      `[migration] custom project roles: ${updatedRoleCount} role(s) updated with ${grantedPermissionCount} guardrail/PII permission grant(s)`,
    );
  },

  async down(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const migrationGrants = db.collection(MIGRATION_GRANTS_COLLECTION);
    const grants = await migrationGrants.find({ migrationVersion: MIGRATION_VERSION }).toArray();
    let updatedRoleCount = 0;
    let revokedPermissionCount = 0;

    for (const grant of grants) {
      const roleId = typeof grant.roleId === 'string' ? grant.roleId : null;
      const permissions = normalizePermissions(grant.permissions).filter(
        (permission): permission is SafetyPermission =>
          (ALL_SAFETY_PERMISSIONS as readonly string[]).includes(permission),
      );

      if (!roleId || permissions.length === 0) {
        continue;
      }

      const updateResult = await roleDefinitions.updateOne(
        { _id: roleId, isSystem: false } as Record<string, unknown>,
        { $pull: { permissions: { $in: permissions } } as any },
      );

      if (updateResult.modifiedCount > 0) {
        updatedRoleCount += 1;
        revokedPermissionCount += permissions.length;
      }
    }

    await migrationGrants.deleteMany({ migrationVersion: MIGRATION_VERSION });

    console.log(
      `[migration] custom project roles: ${updatedRoleCount} role(s) rolled back, ${revokedPermissionCount} guardrail/PII permission grant(s) removed`,
    );
  },

  async validate(db: Db) {
    const plans = await buildBackfillPlans(db);
    const missingRolePermissions = plans
      .filter((plan) => plan.missingPermissions.length > 0)
      .map((plan) => ({
        roleId: plan.roleId,
        tenantId: plan.tenantId,
        missingPermissions: plan.missingPermissions,
      }));

    if (missingRolePermissions.length > 0) {
      return validationFailed('Active custom project roles are missing safety permissions', {
        missingRolePermissions,
      });
    }

    return validationPassed('Active custom project roles include expected safety permissions', {
      auditedRoleCount: plans.length,
      permissions: [...ALL_SAFETY_PERMISSIONS],
    });
  },
};

export default migration;
