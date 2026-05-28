/**
 * Migration: Create human_tasks collection with indexes and seed permissions
 *
 * Creates the unified human-in-the-loop task collection supporting workflow
 * approvals, data entry, reviews, decisions, and agent escalations.
 *
 * Also seeds the human_task resource type and adds permissions to system roles.
 *
 * Idempotent — safe to run multiple times.
 *
 * Date: 2026-03-07
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'human_tasks';
const RESOURCE_TYPES_COLLECTION = 'resource_types';
const ROLE_DEFINITIONS_COLLECTION = 'role_definitions';

const HUMAN_TASK_RESOURCE_TYPE = {
  name: 'human_task',
  displayName: 'Human Task',
  description: 'Human-in-the-loop task',
  isSystem: true,
  operations: [
    { name: 'read', displayName: 'Read' },
    { name: 'assign', displayName: 'Assign' },
    { name: 'claim', displayName: 'Claim' },
    { name: 'resolve', displayName: 'Resolve' },
  ],
};

const ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ['human_task:*'],
  OPERATOR: ['human_task:read', 'human_task:assign', 'human_task:claim', 'human_task:resolve'],
  MEMBER: ['human_task:read', 'human_task:claim', 'human_task:resolve'],
  VIEWER: ['human_task:read'],
};

export const migration: Migration = {
  version: '20260307_010',
  description: 'Create human_tasks collection with indexes and seed permissions',

  async up(db: Db) {
    // Step 1: Create collection if it doesn't exist
    const collections = await db.listCollections({ name: COLLECTION }).toArray();
    if (collections.length === 0) {
      await db.createCollection(COLLECTION);
      console.log(`[migration] Created ${COLLECTION} collection`);
    } else {
      console.log(`[migration] ${COLLECTION} collection already exists`);
    }

    const col = db.collection(COLLECTION);

    // Step 2: Create indexes
    await col.createIndex(
      { tenantId: 1, projectId: 1, status: 1, createdAt: -1 },
      { name: 'tenant_project_status_created', background: true },
    );
    await col.createIndex(
      { 'source.type': 1, 'source.executionId': 1, 'source.stepId': 1 },
      { name: 'source_lookup', background: true },
    );
    await col.createIndex({ status: 1, dueAt: 1 }, { name: 'sla_check', background: true });
    console.log(`[migration] Created indexes on ${COLLECTION}`);

    // Step 3: Seed resource type
    const resourceTypes = db.collection(RESOURCE_TYPES_COLLECTION);
    const rtResult = await resourceTypes.updateOne(
      { name: 'human_task' },
      {
        $set: {
          displayName: HUMAN_TASK_RESOURCE_TYPE.displayName,
          description: HUMAN_TASK_RESOURCE_TYPE.description,
          isSystem: true,
          operations: HUMAN_TASK_RESOURCE_TYPE.operations,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          name: 'human_task',
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    console.log(
      `[migration] human_task ResourceType: ${rtResult.upsertedCount ? 'created' : 'already exists'}`,
    );

    // Step 4: Seed role permissions
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    for (const [roleName, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      const result = await roleDefinitions.updateMany(
        { name: roleName, isSystem: true },
        { $addToSet: { permissions: { $each: permissions } } },
      );
      console.log(
        `[migration] ${roleName}: ${result.modifiedCount} role(s) updated with human_task permissions`,
      );
    }
  },

  async down(db: Db) {
    // Remove permissions
    const roleDefinitions = db.collection(ROLE_DEFINITIONS_COLLECTION);
    const allPerms = [
      'human_task:*',
      'human_task:read',
      'human_task:assign',
      'human_task:claim',
      'human_task:resolve',
    ];
    for (const [roleName] of Object.entries(ROLE_PERMISSIONS)) {
      await roleDefinitions.updateMany(
        { name: roleName, isSystem: true },
        { $pull: { permissions: { $in: allPerms } } as any },
      );
    }
    console.log('[migration] Removed human_task permissions from roles');

    // Remove resource type
    const resourceTypes = db.collection(RESOURCE_TYPES_COLLECTION);
    await resourceTypes.deleteOne({ name: 'human_task' });
    console.log('[migration] Removed human_task ResourceType');

    // Drop collection
    const collections = await db.listCollections({ name: COLLECTION }).toArray();
    if (collections.length > 0) {
      await db.dropCollection(COLLECTION);
      console.log(`[migration] Dropped ${COLLECTION} collection`);
    }
  },
};

export default migration;
