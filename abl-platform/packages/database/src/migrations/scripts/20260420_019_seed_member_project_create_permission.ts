/**
 * Migration: add project:create to system MEMBER roles
 *
 * ABLP-430 introduced an explicit project:create permission check on the
 * Studio project-creation route. Workspace MEMBER is supposed to retain the
 * ability to create projects and become the project owner, but older seeded
 * RoleDefinition documents do not include that permission.
 *
 * This migration patches existing system MEMBER roles in-place so current
 * tenants keep working after deploy.
 *
 * Date: 2026-04-20
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';
const MEMBER_ROLE_NAME = 'MEMBER';
const PROJECT_CREATE_PERMISSION = 'project:create';

export const migration: Migration = {
  version: '20260420_019',
  description: 'Add project:create to system MEMBER roles',

  async up(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const result = await roleDefinitions.updateMany(
      { name: MEMBER_ROLE_NAME, isSystem: true },
      { $addToSet: { permissions: PROJECT_CREATE_PERMISSION } },
    );

    console.log(
      `[migration] ${MEMBER_ROLE_NAME}: ${result.modifiedCount} role(s) updated with ${PROJECT_CREATE_PERMISSION}`,
    );
  },

  async down(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const result = await roleDefinitions.updateMany(
      { name: MEMBER_ROLE_NAME, isSystem: true },
      { $pull: { permissions: PROJECT_CREATE_PERMISSION } as any },
    );

    console.log(
      `[migration] ${MEMBER_ROLE_NAME}: ${result.modifiedCount} role(s) removed ${PROJECT_CREATE_PERMISSION}`,
    );
  },

  async validate(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const roles = await roleDefinitions
      .find({ name: MEMBER_ROLE_NAME, isSystem: true })
      .project({ tenantId: 1, permissions: 1 })
      .toArray();

    const missingPermission = roles
      .map((role) => {
        const permissions = Array.isArray(role.permissions)
          ? role.permissions.map((permission: unknown) => String(permission))
          : [];

        return permissions.includes(PROJECT_CREATE_PERMISSION)
          ? null
          : {
              tenantId: role.tenantId ? String(role.tenantId) : null,
              missingPermissions: [PROJECT_CREATE_PERMISSION],
            };
      })
      .filter((role): role is { tenantId: string | null; missingPermissions: string[] } =>
        Boolean(role),
      );

    if (missingPermission.length > 0) {
      return validationFailed('System MEMBER roles are missing project:create', {
        missingPermission,
      });
    }

    return validationPassed('System MEMBER roles include project:create', {
      auditedRoleCount: roles.length,
      permission: PROJECT_CREATE_PERMISSION,
    });
  },
};

export default migration;
