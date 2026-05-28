import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration } from '../migrations/scripts/20260420_019_seed_member_project_create_permission.js';

const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  if (!isMongoReady()) return;

  const db = mongoose.connection.db!;
  const collections = await db.listCollections({ name: ROLE_DEFINITIONS_COLLECTION }).toArray();
  if (collections.length > 0) {
    await db.collection(ROLE_DEFINITIONS_COLLECTION).deleteMany({});
  }
});

describe('20260420_019 add project:create to system MEMBER roles', () => {
  test('adds project:create to every system MEMBER role and validates the result', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    await roleDefinitions.insertMany([
      {
        _id: 'member-tenant-1',
        tenantId: 'tenant-1',
        name: 'MEMBER',
        isSystem: true,
        permissions: ['tenant:read', 'project:read', 'project:update'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'member-tenant-2',
        tenantId: 'tenant-2',
        name: 'MEMBER',
        isSystem: true,
        permissions: ['tenant:read', 'project:create', 'project:read'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'custom-member',
        tenantId: 'tenant-1',
        name: 'MEMBER',
        isSystem: false,
        permissions: ['tenant:read', 'project:read'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await migration.up(db);

    const systemMemberRoles = await roleDefinitions
      .find({ name: 'MEMBER', isSystem: true })
      .toArray();

    expect(systemMemberRoles).toHaveLength(2);
    systemMemberRoles.forEach((role) => {
      expect(role.permissions).toContain('project:create');
    });

    const customMemberRole = await roleDefinitions.findOne({
      _id: 'custom-member',
      tenantId: 'tenant-1',
    });
    expect(customMemberRole?.permissions).not.toContain('project:create');

    const validation = await migration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toEqual({
      auditedRoleCount: 2,
      permission: 'project:create',
    });
  });

  test('removes project:create from system MEMBER roles on rollback', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    await roleDefinitions.insertMany([
      {
        _id: 'member-tenant-1',
        tenantId: 'tenant-1',
        name: 'MEMBER',
        isSystem: true,
        permissions: ['tenant:read', 'project:create', 'project:read'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'admin-tenant-1',
        tenantId: 'tenant-1',
        name: 'ADMIN',
        isSystem: true,
        permissions: ['project:*'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await migration.down(db);

    const memberRole = await roleDefinitions.findOne({ _id: 'member-tenant-1' });
    expect(memberRole?.permissions).not.toContain('project:create');

    const adminRole = await roleDefinitions.findOne({ _id: 'admin-tenant-1' });
    expect(adminRole?.permissions).toEqual(['project:*']);
  });
});
