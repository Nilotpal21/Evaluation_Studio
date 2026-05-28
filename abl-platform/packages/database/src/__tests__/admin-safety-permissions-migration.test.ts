import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration } from '../migrations/scripts/20260509_029_seed_admin_guardrail_pii_permissions.js';

const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';
const ADMIN_SAFETY_PERMISSIONS = [
  'guardrail:read',
  'guardrail:write',
  'pii-pattern:read',
  'pii-pattern:write',
] as const;

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

describe('20260509_029 add guardrail and PII pattern permissions to system ADMIN roles', () => {
  test('adds safety configuration permissions to every system ADMIN role and validates', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    await roleDefinitions.insertMany([
      {
        _id: 'admin-tenant-1',
        tenantId: 'tenant-1',
        name: 'ADMIN',
        isSystem: true,
        permissions: ['tenant:read', 'project:*', 'agent:*'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'admin-tenant-2',
        tenantId: 'tenant-2',
        name: 'ADMIN',
        isSystem: true,
        permissions: ['tenant:read', 'project:*', 'guardrail:read'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'custom-admin',
        tenantId: 'tenant-1',
        name: 'ADMIN',
        isSystem: false,
        permissions: ['tenant:read', 'project:*'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await migration.up(db);

    const systemAdminRoles = await roleDefinitions
      .find({ name: 'ADMIN', isSystem: true })
      .toArray();

    expect(systemAdminRoles).toHaveLength(2);
    systemAdminRoles.forEach((role) => {
      expect(role.permissions).toEqual(expect.arrayContaining([...ADMIN_SAFETY_PERMISSIONS]));
    });

    const customAdminRole = await roleDefinitions.findOne({ _id: 'custom-admin' });
    expect(customAdminRole?.permissions).not.toEqual(
      expect.arrayContaining([...ADMIN_SAFETY_PERMISSIONS]),
    );

    const validation = await migration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toEqual({
      auditedRoleCount: 2,
      permissions: [...ADMIN_SAFETY_PERMISSIONS],
    });
  });

  test('removes only the seeded safety configuration permissions on rollback', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    await roleDefinitions.insertMany([
      {
        _id: 'admin-tenant-1',
        tenantId: 'tenant-1',
        name: 'ADMIN',
        isSystem: true,
        permissions: ['tenant:read', 'project:*', ...ADMIN_SAFETY_PERMISSIONS],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'member-tenant-1',
        tenantId: 'tenant-1',
        name: 'MEMBER',
        isSystem: true,
        permissions: ['tenant:read', 'project:read', 'pii-pattern:read'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await migration.down(db);

    const adminRole = await roleDefinitions.findOne({ _id: 'admin-tenant-1' });
    expect(adminRole?.permissions).toEqual(['tenant:read', 'project:*']);

    const memberRole = await roleDefinitions.findOne({ _id: 'member-tenant-1' });
    expect(memberRole?.permissions).toContain('pii-pattern:read');
  });
});
