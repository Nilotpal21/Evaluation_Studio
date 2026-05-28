import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration } from '../migrations/scripts/20260510_030_backfill_custom_project_safety_permissions.js';

const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';
const PROJECT_MEMBERS_COLLECTION = 'project_members';
const MIGRATION_GRANTS_COLLECTION = '_migration_role_permission_grants';

const READ_SAFETY_PERMISSIONS = ['guardrail:read', 'pii-pattern:read'] as const;
const WRITE_SAFETY_PERMISSIONS = ['guardrail:write', 'pii-pattern:write'] as const;
const ALL_SAFETY_PERMISSIONS = [...READ_SAFETY_PERMISSIONS, ...WRITE_SAFETY_PERMISSIONS] as const;

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
  await Promise.all(
    [ROLE_DEFINITIONS_COLLECTION, PROJECT_MEMBERS_COLLECTION, MIGRATION_GRANTS_COLLECTION].map(
      async (collectionName) => {
        const collections = await db.listCollections({ name: collectionName }).toArray();
        if (collections.length > 0) {
          await db.collection(collectionName).deleteMany({});
        }
      },
    ),
  );
});

describe('20260510_030 backfill safety permissions for active custom project roles', () => {
  test('adds read/write safety permissions only to active custom project roles with matching authority', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const projectMembers = db.collection(PROJECT_MEMBERS_COLLECTION);

    await roleDefinitions.insertMany([
      {
        _id: 'custom-author',
        tenantId: 'tenant-1',
        name: 'Custom Author',
        isSystem: false,
        permissions: ['agent:update', 'tool:write'],
      },
      {
        _id: 'custom-reader',
        tenantId: 'tenant-1',
        name: 'Custom Reader',
        isSystem: false,
        permissions: ['agent:read', 'session:read'],
      },
      {
        _id: 'custom-narrow',
        tenantId: 'tenant-1',
        name: 'Custom Narrow',
        isSystem: false,
        permissions: ['simulate:execute'],
      },
      {
        _id: 'custom-parent-author',
        tenantId: 'tenant-1',
        name: 'Custom Parent Author',
        isSystem: false,
        permissions: ['agent:update'],
      },
      {
        _id: 'custom-inherited-author',
        tenantId: 'tenant-1',
        name: 'Custom Inherited Author',
        isSystem: false,
        permissions: ['agent:read'],
        parentRoleId: 'custom-parent-author',
      },
      {
        _id: 'custom-unreferenced-author',
        tenantId: 'tenant-1',
        name: 'Custom Unreferenced Author',
        isSystem: false,
        permissions: ['agent:update', 'tool:write'],
      },
      {
        _id: 'system-author',
        tenantId: 'tenant-1',
        name: 'System Author',
        isSystem: true,
        permissions: ['agent:update', 'tool:write'],
      },
    ]);

    await projectMembers.insertMany([
      {
        _id: 'member-author',
        projectId: 'project-1',
        userId: 'user-1',
        role: 'custom',
        customRoleId: 'custom-author',
      },
      {
        _id: 'member-reader',
        projectId: 'project-1',
        userId: 'user-2',
        role: 'custom',
        customRoleId: 'custom-reader',
      },
      {
        _id: 'member-narrow',
        projectId: 'project-1',
        userId: 'user-3',
        role: 'custom',
        customRoleId: 'custom-narrow',
      },
      {
        _id: 'member-inherited-author',
        projectId: 'project-1',
        userId: 'user-5',
        role: 'custom',
        customRoleId: 'custom-inherited-author',
      },
      {
        _id: 'member-system',
        projectId: 'project-1',
        userId: 'user-4',
        role: 'custom',
        customRoleId: 'system-author',
      },
    ]);

    await migration.up(db);

    const author = await roleDefinitions.findOne({ _id: 'custom-author' });
    expect(author?.permissions).toEqual(expect.arrayContaining([...ALL_SAFETY_PERMISSIONS]));

    const reader = await roleDefinitions.findOne({ _id: 'custom-reader' });
    expect(reader?.permissions).toEqual(expect.arrayContaining([...READ_SAFETY_PERMISSIONS]));
    expect(reader?.permissions).not.toEqual(expect.arrayContaining([...WRITE_SAFETY_PERMISSIONS]));

    const narrow = await roleDefinitions.findOne({ _id: 'custom-narrow' });
    expect(narrow?.permissions).toEqual(['simulate:execute']);

    const inheritedAuthor = await roleDefinitions.findOne({ _id: 'custom-inherited-author' });
    expect(inheritedAuthor?.permissions).toEqual(
      expect.arrayContaining([...ALL_SAFETY_PERMISSIONS]),
    );

    const parentAuthor = await roleDefinitions.findOne({ _id: 'custom-parent-author' });
    expect(parentAuthor?.permissions).toEqual(['agent:update']);

    const unreferenced = await roleDefinitions.findOne({ _id: 'custom-unreferenced-author' });
    expect(unreferenced?.permissions).toEqual(['agent:update', 'tool:write']);

    const system = await roleDefinitions.findOne({ _id: 'system-author' });
    expect(system?.permissions).toEqual(['agent:update', 'tool:write']);

    const grants = await db.collection(MIGRATION_GRANTS_COLLECTION).find({}).toArray();
    expect(grants).toHaveLength(3);

    const validation = await migration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toEqual({
      auditedRoleCount: 3,
      permissions: [...ALL_SAFETY_PERMISSIONS],
    });
  });

  test('rolls back only permissions this migration added', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const projectMembers = db.collection(PROJECT_MEMBERS_COLLECTION);

    await roleDefinitions.insertOne({
      _id: 'custom-reader',
      tenantId: 'tenant-1',
      name: 'Custom Reader',
      isSystem: false,
      permissions: ['agent:read', 'guardrail:read'],
    });

    await projectMembers.insertOne({
      _id: 'member-reader',
      projectId: 'project-1',
      userId: 'user-1',
      role: 'custom',
      customRoleId: 'custom-reader',
    });

    await migration.up(db);

    const updated = await roleDefinitions.findOne({ _id: 'custom-reader' });
    expect(updated?.permissions).toEqual(
      expect.arrayContaining(['agent:read', 'guardrail:read', 'pii-pattern:read']),
    );

    await migration.down(db);

    const rolledBack = await roleDefinitions.findOne({ _id: 'custom-reader' });
    expect(rolledBack?.permissions).toEqual(['agent:read', 'guardrail:read']);

    const grants = await db.collection(MIGRATION_GRANTS_COLLECTION).find({}).toArray();
    expect(grants).toEqual([]);
  });
});
