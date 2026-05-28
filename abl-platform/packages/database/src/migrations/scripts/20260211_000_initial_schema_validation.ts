/**
 * Migration: Initial Schema Validation + Indexes
 *
 * Creates all collections with $jsonSchema validation and
 * establishes the complete index catalog for all 40+ collections.
 *
 * validationLevel: 'moderate' — validates inserts + updates, not existing docs
 * validationAction: 'error' — reject invalid documents
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { collectionExists, hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

// ─── Collection Definitions ──────────────────────────────────────────────

interface CollectionDef {
  name: string;
  validator?: { $jsonSchema: Record<string, unknown> };
  indexes: Array<{
    key: Record<string, 1 | -1 | 'hashed'>;
    options?: Record<string, unknown>;
  }>;
}

const collections: CollectionDef[] = [
  // ── Users ────────────────────────────────────────────────────────
  {
    name: 'users',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'email', 'name'],
        properties: {
          email: { bsonType: 'string' },
          name: { bsonType: 'string' },
        },
      },
    },
    indexes: [
      { key: { email: 1 }, options: { unique: true } },
      { key: { googleId: 1 }, options: { unique: true, sparse: true } },
    ],
  },
  {
    name: 'refresh_tokens',
    indexes: [
      { key: { token: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
      { key: { familyId: 1 } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ],
  },
  {
    name: 'email_verification_tokens',
    indexes: [
      { key: { token: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ],
  },
  {
    name: 'password_reset_tokens',
    indexes: [
      { key: { token: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ],
  },

  // ── Organizations ────────────────────────────────────────────────
  {
    name: 'organizations',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'name', 'slug', 'ownerId'],
        properties: {
          name: { bsonType: 'string' },
          slug: { bsonType: 'string' },
          ownerId: { bsonType: 'string' },
        },
      },
    },
    indexes: [
      { key: { slug: 1 }, options: { unique: true } },
      { key: { ownerId: 1 } },
      { key: { 'domainMappings.domain': 1 }, options: { unique: true, sparse: true } },
    ],
  },
  {
    name: 'org_members',
    indexes: [
      { key: { organizationId: 1, userId: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
    ],
  },
  {
    name: 'tenant_transfers',
    indexes: [
      { key: { tenantId: 1 } },
      { key: { sourceOrgId: 1 } },
      { key: { targetOrgId: 1 } },
      { key: { status: 1 } },
    ],
  },

  // ── Tenants ──────────────────────────────────────────────────────
  {
    name: 'tenants',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'name', 'slug', 'organizationId', 'ownerId'],
        properties: {
          name: { bsonType: 'string' },
          slug: { bsonType: 'string' },
          status: { enum: ['active', 'suspended', 'archived'] },
        },
      },
    },
    indexes: [
      { key: { slug: 1 }, options: { unique: true } },
      { key: { organizationId: 1 } },
      { key: { ownerId: 1 } },
      { key: { status: 1 } },
    ],
  },
  {
    name: 'tenant_members',
    indexes: [
      { key: { tenantId: 1, userId: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
      { key: { customRoleId: 1 } },
    ],
  },
  {
    name: 'workspace_invitations',
    indexes: [
      { key: { token: 1 }, options: { unique: true } },
      { key: { tenantId: 1, email: 1 }, options: { unique: true } },
      { key: { email: 1 } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ],
  },

  // ── Projects ─────────────────────────────────────────────────────
  {
    name: 'projects',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'name', 'slug', 'tenantId', 'ownerId'],
        properties: {
          name: { bsonType: 'string' },
          slug: { bsonType: 'string' },
        },
      },
    },
    indexes: [
      { key: { slug: 1 }, options: { unique: true } },
      { key: { tenantId: 1 } },
      { key: { ownerId: 1 } },
    ],
  },
  {
    name: 'project_agents',
    indexes: [
      { key: { projectId: 1, name: 1 }, options: { unique: true } },
      { key: { projectId: 1 } },
      { key: { domain: 1 } },
    ],
  },
  {
    name: 'agent_versions',
    indexes: [
      { key: { agentId: 1, version: 1 }, options: { unique: true } },
      { key: { agentId: 1, status: 1 } },
    ],
  },
  {
    name: 'project_members',
    indexes: [
      { key: { projectId: 1, userId: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
    ],
  },
  {
    name: 'model_configs',
    indexes: [
      { key: { projectId: 1, name: 1 }, options: { unique: true } },
      { key: { projectId: 1, tier: 1 } },
    ],
  },
  {
    name: 'agent_model_configs',
    indexes: [{ key: { projectId: 1, agentName: 1 }, options: { unique: true } }],
  },
  {
    name: 'service_nodes',
    indexes: [{ key: { projectId: 1, name: 1 }, options: { unique: true } }],
  },

  // ── RBAC ─────────────────────────────────────────────────────────
  {
    name: 'role_definitions',
    indexes: [
      { key: { tenantId: 1, name: 1 }, options: { unique: true } },
      { key: { tenantId: 1 } },
    ],
  },
  {
    name: 'resource_permissions',
    indexes: [
      {
        key: { tenantId: 1, userId: 1, resourceType: 1, resourceId: 1 },
        options: { unique: true },
      },
      { key: { tenantId: 1, userId: 1 } },
      { key: { tenantId: 1, resourceType: 1, resourceId: 1 } },
      { key: { userId: 1 } },
    ],
  },
  {
    name: 'resource_types',
    indexes: [{ key: { name: 1 }, options: { unique: true } }],
  },

  // ── Contacts ─────────────────────────────────────────────────────
  {
    name: 'contacts',
    indexes: [
      { key: { tenantId: 1, identityType: 1, identity: 1 } },
      { key: { tenantId: 1, type: 1 } },
      { key: { tenantId: 1, lastSeenAt: -1 } },
      {
        key: { tenantId: 1, deletedAt: 1 },
        options: { partialFilterExpression: { deletedAt: { $exists: true } } },
      },
    ],
  },

  // ── Conversations ────────────────────────────────────────────────
  {
    name: 'sessions',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'tenantId', 'channel', 'status', 'currentAgent'],
        properties: {
          tenantId: { bsonType: 'string' },
          channel: {
            enum: [
              'web',
              'web_chat',
              'web_debug',
              'voice',
              'sms',
              'whatsapp',
              'email',
              'api',
              'sdk',
            ],
          },
          status: {
            enum: ['active', 'idle', 'ended', 'completed', 'escalated', 'abandoned', 'archived'],
          },
        },
      },
    },
    indexes: [
      { key: { tenantId: 1, status: 1, lastActivityAt: -1 } },
      { key: { tenantId: 1, contactId: 1 } },
      { key: { tenantId: 1, callerNumber: 1 } },
      { key: { tenantId: 1, workflowId: 1 } },
      { key: { tenantId: 1, projectId: 1, environment: 1 } },
      { key: { tenantId: 1, initiatedById: 1 } },
      { key: { tenantId: 1, billingPeriod: 1, isTest: 1 } },
      { key: { tenantId: 1, projectSlug: 1, status: 1 } },
      { key: { tenantId: 1, entryAgentName: 1, startedAt: -1 } },
      { key: { tenantId: 1, environment: 1, status: 1 } },
      { key: { deploymentId: 1, status: 1 } },
      { key: { customerId: 1 }, options: { sparse: true } },
      { key: { parentId: 1 }, options: { sparse: true } },
    ],
  },

  // ── Workflows ────────────────────────────────────────────────────
  {
    name: 'workflows',
    indexes: [
      { key: { tenantId: 1, projectId: 1, name: 1 }, options: { unique: true } },
      { key: { tenantId: 1, type: 1, status: 1 } },
      { key: { tenantId: 1, projectId: 1 } },
    ],
  },

  // ── API Keys ─────────────────────────────────────────────────────
  {
    name: 'api_keys',
    indexes: [
      { key: { keyHash: 1 }, options: { unique: true } },
      { key: { tenantId: 1, clientId: 1 }, options: { unique: true } },
      { key: { tenantId: 1 } },
      { key: { prefix: 1 } },
    ],
  },
  {
    name: 'public_api_keys',
    indexes: [{ key: { keyHash: 1 }, options: { unique: true } }, { key: { projectId: 1 } }],
  },
  {
    name: 'sdk_channels',
    indexes: [
      { key: { tenantId: 1, projectId: 1, name: 1 }, options: { unique: true } },
      { key: { tenantId: 1, projectId: 1 } },
      { key: { publicApiKeyId: 1 } },
    ],
  },

  // ── LLM Config ───────────────────────────────────────────────────
  {
    name: 'llm_credentials',
    indexes: [
      { key: { userId: 1, provider: 1, name: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
      { key: { provider: 1 } },
      { key: { tenantId: 1 } },
    ],
  },
  {
    name: 'tenant_models',
    indexes: [
      { key: { tenantId: 1, displayName: 1 }, options: { unique: true } },
      { key: { tenantId: 1, tier: 1, isActive: 1 } },
      { key: { tenantId: 1, provider: 1, isActive: 1 } },
    ],
  },
  {
    name: 'tenant_service_instances',
    indexes: [
      { key: { tenantId: 1, serviceType: 1, displayName: 1 }, options: { unique: true } },
      { key: { tenantId: 1, serviceType: 1, isActive: 1 } },
    ],
  },

  // ── Security ─────────────────────────────────────────────────────
  {
    name: 'end_user_oauth_tokens',
    indexes: [
      { key: { tenantId: 1, userId: 1, provider: 1 }, options: { unique: true } },
      { key: { tenantId: 1 } },
    ],
  },
  {
    name: 'org_proxy_configs',
    indexes: [
      { key: { tenantId: 1, name: 1, environment: 1 }, options: { unique: true } },
      { key: { tenantId: 1, environment: 1 } },
    ],
  },
  {
    name: 'key_versions',
    indexes: [
      { key: { tenantId: 1, version: 1 }, options: { unique: true } },
      { key: { tenantId: 1 } },
      { key: { status: 1 } },
    ],
  },

  // ── Compliance ───────────────────────────────────────────────────
  {
    name: 'deletion_requests',
    indexes: [
      { key: { tenantId: 1 } },
      { key: { status: 1 } },
      { key: { subjectId: 1 } },
      { key: { slaDeadline: 1 } },
    ],
  },
  {
    name: 'archive_manifests',
    indexes: [{ key: { tenantId: 1 } }, { key: { type: 1, createdAt: -1 } }],
  },

  // ── Billing ──────────────────────────────────────────────────────
  {
    name: 'subscriptions',
    indexes: [
      { key: { organizationId: 1 } },
      { key: { tenantId: 1 } },
      { key: { status: 1 } },
      { key: { planTier: 1 } },
    ],
  },
  {
    name: 'deals',
    indexes: [
      { key: { organizationId: 1, status: 1 } },
      { key: { hubspotDealId: 1 }, options: { unique: true, sparse: true } },
    ],
  },
  {
    name: 'credit_ledgers',
    indexes: [
      { key: { dealId: 1, periodStart: 1 }, options: { unique: true } },
      { key: { organizationId: 1, periodStart: 1 } },
    ],
  },
  {
    name: 'billing_line_items',
    indexes: [{ key: { dealId: 1, periodLabel: 1 } }],
  },
  {
    name: 'billing_replay_runs',
    indexes: [
      { key: { tenantId: 1, createdAt: -1 } },
      { key: { tenantId: 1, projectId: 1, createdAt: -1 } },
      { key: { tenantId: 1, status: 1, createdAt: -1 } },
    ],
  },
  {
    name: 'billing_replay_session_results',
    indexes: [
      { key: { tenantId: 1, runId: 1, sequence: 1 } },
      { key: { tenantId: 1, runId: 1, sessionId: 1 }, options: { unique: true } },
      { key: { tenantId: 1, sessionId: 1, createdAt: -1 } },
    ],
  },
  {
    name: 'billing_materialization_batches',
    indexes: [
      { key: { tenantId: 1, createdAt: -1 } },
      { key: { tenantId: 1, projectId: 1, createdAt: -1 } },
      { key: { subscriptionId: 1, createdAt: -1 } },
      { key: { tenantId: 1, status: 1, createdAt: -1 } },
    ],
  },
  {
    name: 'billing_materialization_applications',
    indexes: [
      {
        key: { tenantId: 1, batchId: 1 },
        options: { unique: true, name: 'uniq_billing_materialization_application_batch' },
      },
      { key: { tenantId: 1, createdAt: -1 } },
      { key: { subscriptionId: 1, createdAt: -1 } },
      {
        key: { 'dealResolution.dealId': 1, 'accountingPeriod.periodStart': -1 },
        options: { name: 'billing_materialization_application_deal_period' },
      },
    ],
  },
  {
    name: 'billing_materialization_session_results',
    indexes: [
      { key: { tenantId: 1, batchId: 1, sequence: 1 } },
      { key: { tenantId: 1, batchId: 1, sessionId: 1 }, options: { unique: true } },
      { key: { tenantId: 1, sessionId: 1, createdAt: -1 } },
      { key: { subscriptionId: 1, createdAt: -1 } },
    ],
  },
  {
    name: 'billing_materialization_checkpoints',
    indexes: [
      {
        key: { tenantId: 1, projectId: 1, basis: 1 },
        options: { unique: true, name: 'uniq_billing_materialization_checkpoint_scope' },
      },
      { key: { tenantId: 1, basis: 1, updatedAt: -1 } },
    ],
  },
  {
    name: 'billing_usage_published_sessions',
    indexes: [
      {
        key: { tenantId: 1, sessionId: 1 },
        options: { unique: true, name: 'uniq_billing_usage_published_session' },
      },
      { key: { tenantId: 1, endedAt: -1 } },
      { key: { tenantId: 1, projectId: 1, endedAt: -1 } },
      { key: { tenantId: 1, channel: 1, endedAt: -1 } },
      { key: { batchId: 1, createdAt: -1 } },
      { key: { applicationId: 1, createdAt: -1 } },
    ],
  },

  // ── Knowledge ────────────────────────────────────────────────────
  {
    name: 'knowledge_bases',
    indexes: [
      { key: { tenantId: 1, name: 1 }, options: { unique: true } },
      { key: { tenantId: 1 } },
      { key: { indexStatus: 1 } },
      { key: { sourceType: 1 } },
    ],
  },
  {
    name: 'resource_groups',
    indexes: [
      { key: { tenantId: 1, name: 1 }, options: { unique: true } },
      { key: { tenantId: 1 } },
    ],
  },
  {
    name: 'facts',
    indexes: [
      { key: { key: 1 }, options: { unique: true } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
      { key: { sourceType: 1 } },
    ],
  },

  // ── SDK ──────────────────────────────────────────────────────────
  {
    name: 'widget_configs',
    indexes: [{ key: { projectId: 1 }, options: { unique: true } }],
  },
  {
    name: 'debug_tokens',
    indexes: [
      { key: { token: 1 }, options: { unique: true } },
      { key: { userId: 1 } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ],
  },
  {
    name: 'device_auth_requests',
    indexes: [
      { key: { deviceCode: 1 }, options: { unique: true } },
      { key: { userCode: 1 }, options: { unique: true } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ],
  },

  // ── Audit Logs ───────────────────────────────────────────────────
  {
    name: 'audit_logs',
    indexes: [
      { key: { tenantId: 1, createdAt: -1 } },
      { key: { userId: 1 } },
      { key: { action: 1 } },
      { key: { createdAt: -1 } },
    ],
  },

  // ── Deployments ──────────────────────────────────────────────────
  {
    name: 'deployments',
    indexes: [
      { key: { endpointSlug: 1 }, options: { unique: true } },
      { key: { projectId: 1, environment: 1, createdAt: -1 } },
      { key: { projectId: 1, environment: 1, status: 1 } },
      { key: { tenantId: 1 } },
      { key: { status: 1 } },
    ],
  },
];

// ─── Migration ───────────────────────────────────────────────────────────

export const migration: Migration = {
  version: '20260211_000',
  description: 'Initial schema validation and index creation for all collections',

  async up(db) {
    const existingCollections = new Set(
      (await db.listCollections().toArray()).map((c: any) => c.name),
    );

    for (const col of collections) {
      // Create collection with validator (if not exists)
      if (!existingCollections.has(col.name)) {
        const options: Record<string, unknown> = {};
        if (col.validator) {
          options.validator = col.validator;
          options.validationLevel = 'moderate';
          options.validationAction = 'error';
        }
        await db.createCollection(col.name, options);
        console.log(`  Created collection: ${col.name}`);
      } else if (col.validator) {
        // Apply validator to existing collection
        await db.command({
          collMod: col.name,
          validator: col.validator,
          validationLevel: 'moderate',
          validationAction: 'error',
        });
        console.log(`  Updated validation for: ${col.name}`);
      }

      // Create indexes
      for (const idx of col.indexes) {
        try {
          await db.collection(col.name).createIndex(idx.key as any, {
            background: true,
            ...idx.options,
          });
        } catch (error: any) {
          // Index already exists with same definition — skip
          if (error.code === 85 || error.code === 86) {
            continue;
          }
          throw error;
        }
      }
    }

    console.log(`  Created indexes for ${collections.length} collections`);
  },

  async down(db) {
    // Drop all indexes except _id (keep collections and data)
    for (const col of collections) {
      try {
        await db.collection(col.name).dropIndexes();
      } catch {
        // Collection may not exist
      }
    }
    console.log('  Dropped all custom indexes');
  },

  async validate(db) {
    const missingCollections: string[] = [];
    const missingIndexes: string[] = [];

    for (const collection of collections) {
      const exists = await collectionExists(db, collection.name);
      if (!exists) {
        missingCollections.push(collection.name);
        continue;
      }

      for (const index of collection.indexes) {
        const present = await hasIndex(
          db,
          collection.name,
          index.key,
          index.options as Record<string, unknown> | undefined,
        );
        if (!present) {
          missingIndexes.push(`${collection.name}:${JSON.stringify(index.key)}`);
        }
      }
    }

    if (missingCollections.length > 0 || missingIndexes.length > 0) {
      return validationFailed('Schema bootstrap validation found missing collections or indexes', {
        missingCollections,
        missingIndexes,
      });
    }

    return validationPassed('Verified seeded collections and indexes for the initial schema', {
      collectionCount: collections.length,
      indexCount: collections.reduce((total, collection) => total + collection.indexes.length, 0),
    });
  },
};
