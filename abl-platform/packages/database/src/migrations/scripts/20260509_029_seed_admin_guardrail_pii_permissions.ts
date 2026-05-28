/**
 * Migration: add guardrail and PII pattern permissions to system ADMIN roles
 *
 * ABLP-673 verification exposed that workspace ADMIN users could be blocked
 * from mutating project safety configuration because older seeded ADMIN role
 * definitions predate guardrail and PII pattern permissions.
 *
 * This migration patches existing system ADMIN roles in-place so current
 * tenants match the canonical built-in role contract after deploy.
 *
 * Date: 2026-05-09
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';
const ADMIN_ROLE_NAME = 'ADMIN';
const ADMIN_SAFETY_PERMISSIONS = [
  'guardrail:read',
  'guardrail:write',
  'pii-pattern:read',
  'pii-pattern:write',
] as const;

export const migration: Migration = {
  version: '20260509_029',
  description: 'Add guardrail and PII pattern permissions to system ADMIN roles',

  async up(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const result = await roleDefinitions.updateMany(
      { name: ADMIN_ROLE_NAME, isSystem: true },
      { $addToSet: { permissions: { $each: [...ADMIN_SAFETY_PERMISSIONS] } } },
    );

    console.log(
      `[migration] ${ADMIN_ROLE_NAME}: ${result.modifiedCount} role(s) updated with guardrail/PII permissions`,
    );
  },

  async down(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const result = await roleDefinitions.updateMany(
      { name: ADMIN_ROLE_NAME, isSystem: true },
      { $pull: { permissions: { $in: [...ADMIN_SAFETY_PERMISSIONS] } } as any },
    );

    console.log(
      `[migration] ${ADMIN_ROLE_NAME}: ${result.modifiedCount} role(s) removed guardrail/PII permissions`,
    );
  },

  async validate(db: Db) {
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const roles = await roleDefinitions
      .find({ name: ADMIN_ROLE_NAME, isSystem: true })
      .project({ tenantId: 1, permissions: 1 })
      .toArray();

    const missingRolePermissions = roles
      .map((role) => {
        const permissions = Array.isArray(role.permissions)
          ? role.permissions.map((permission: unknown) => String(permission))
          : [];
        const missingPermissions = ADMIN_SAFETY_PERMISSIONS.filter(
          (permission) => !permissions.includes(permission),
        );

        return missingPermissions.length > 0
          ? {
              tenantId: role.tenantId ? String(role.tenantId) : null,
              missingPermissions,
            }
          : null;
      })
      .filter(
        (
          role,
        ): role is {
          tenantId: string | null;
          missingPermissions: Array<(typeof ADMIN_SAFETY_PERMISSIONS)[number]>;
        } => Boolean(role),
      );

    if (missingRolePermissions.length > 0) {
      return validationFailed('System ADMIN roles are missing guardrail/PII permissions', {
        missingRolePermissions,
      });
    }

    return validationPassed('System ADMIN roles include guardrail/PII permissions', {
      auditedRoleCount: roles.length,
      permissions: [...ADMIN_SAFETY_PERMISSIONS],
    });
  },
};

export default migration;
