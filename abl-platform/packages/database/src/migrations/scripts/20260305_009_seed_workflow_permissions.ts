/**
 * Migration: Seed workflow resource type and add workflow permissions to roles
 *
 * The seed script (seed-mongo.ts) already defines workflow as a resource type
 * with CRUD + execute operations, and includes workflow permissions in all
 * system roles. However, environments that only run migrations (not the full
 * init stage) are missing these records, causing "Forbidden: missing required
 * permission (workflow:read)" errors.
 *
 * This migration ensures:
 * 1. The "workflow" ResourceType exists with all operations
 * 2. All system RoleDefinitions include the appropriate workflow permissions
 *
 * Idempotent — safe to run even if seed script already ran.
 *
 * Date: 2026-03-05
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const RESOURCE_TYPES_COLLECTION = 'resource_types';
const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';

const WORKFLOW_RESOURCE_TYPE = {
  name: 'workflow',
  displayName: 'Workflow',
  description: 'Workflow definition',
  isSystem: true,
  operations: [
    { name: 'create', displayName: 'Create' },
    { name: 'read', displayName: 'Read' },
    { name: 'update', displayName: 'Update' },
    { name: 'delete', displayName: 'Delete' },
    { name: 'execute', displayName: 'Execute' },
  ],
};

/**
 * Workflow permissions to add per role.
 * OWNER already has `*:*` so no changes needed.
 */
const ROLE_WORKFLOW_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ['workflow:*'],
  OPERATOR: ['workflow:read', 'workflow:execute'],
  MEMBER: ['workflow:read'],
  VIEWER: ['workflow:read'],
};

export const migration: Migration = {
  version: '20260305_009',
  description: 'Seed workflow resource type and add workflow permissions to system roles',

  async up(db: Db) {
    const resourceTypes = db.collection(RESOURCE_TYPES_COLLECTION);
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);

    // Step 1: Upsert workflow resource type
    const rtResult = await resourceTypes.updateOne(
      { name: 'workflow' },
      {
        $set: {
          displayName: WORKFLOW_RESOURCE_TYPE.displayName,
          description: WORKFLOW_RESOURCE_TYPE.description,
          isSystem: true,
          operations: WORKFLOW_RESOURCE_TYPE.operations,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          name: 'workflow',
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    console.log(
      `[migration] workflow ResourceType: ${rtResult.upsertedCount ? 'created' : 'already exists (updated)'}`,
    );

    // Step 2: Add workflow permissions to each system role
    for (const [roleName, permissions] of Object.entries(ROLE_WORKFLOW_PERMISSIONS)) {
      const result = await roleDefinitions.updateMany(
        { name: roleName, isSystem: true },
        { $addToSet: { permissions: { $each: permissions } } },
      );
      console.log(
        `[migration] ${roleName}: ${result.modifiedCount} role(s) updated with workflow permissions`,
      );
    }
  },

  async down(db: Db) {
    const resourceTypes = db.collection(RESOURCE_TYPES_COLLECTION);
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);

    // Remove workflow permissions from roles
    const allWorkflowPerms = [
      'workflow:*',
      'workflow:create',
      'workflow:read',
      'workflow:update',
      'workflow:delete',
      'workflow:execute',
    ];
    for (const [roleName] of Object.entries(ROLE_WORKFLOW_PERMISSIONS)) {
      await roleDefinitions.updateMany(
        { name: roleName, isSystem: true },
        { $pull: { permissions: { $in: allWorkflowPerms } } as any },
      );
      console.log(`[migration] ${roleName}: removed workflow permissions`);
    }

    // Remove workflow resource type
    const result = await resourceTypes.deleteOne({ name: 'workflow' });
    console.log(
      `[migration] workflow ResourceType: ${result.deletedCount ? 'removed' : 'not found'}`,
    );
  },

  async validate(db: Db) {
    const resourceTypes = db.collection(RESOURCE_TYPES_COLLECTION);
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);

    const workflowResourceType = await resourceTypes.findOne({ name: 'workflow' });
    const workflowOps = Array.isArray(workflowResourceType?.operations)
      ? workflowResourceType.operations.map((operation: any) => operation.name)
      : [];
    const missingOperations = WORKFLOW_RESOURCE_TYPE.operations
      .map((operation) => operation.name)
      .filter((name) => !workflowOps.includes(name));

    const missingRolePermissions: Array<{
      roleName: string;
      tenantId: string | null;
      missingPermissions: string[];
    }> = [];

    for (const [roleName, permissions] of Object.entries(ROLE_WORKFLOW_PERMISSIONS)) {
      const roles = await roleDefinitions
        .find({ name: roleName, isSystem: true })
        .project({ tenantId: 1, permissions: 1 })
        .toArray();

      for (const role of roles) {
        const currentPermissions = Array.isArray(role.permissions) ? role.permissions : [];
        const missingPermissions = permissions.filter(
          (permission) => !currentPermissions.includes(permission),
        );
        if (missingPermissions.length > 0) {
          missingRolePermissions.push({
            roleName,
            tenantId: role.tenantId ? String(role.tenantId) : null,
            missingPermissions,
          });
        }
      }
    }

    if (
      !workflowResourceType ||
      missingOperations.length > 0 ||
      missingRolePermissions.length > 0
    ) {
      return validationFailed('Workflow resource type or role permissions are not fully seeded', {
        workflowResourceTypePresent: Boolean(workflowResourceType),
        missingOperations,
        missingRolePermissions,
      });
    }

    return validationPassed('Workflow resource type and role permissions are aligned', {
      operationCount: workflowOps.length,
      auditedRoleCount: Object.keys(ROLE_WORKFLOW_PERMISSIONS).length,
    });
  },
};

export default migration;
