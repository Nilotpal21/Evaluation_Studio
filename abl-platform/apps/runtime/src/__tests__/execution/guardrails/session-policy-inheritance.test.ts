/**
 * Session Policy Inheritance — Integration Test
 *
 * Tests getSessionPolicy() with a real MongoDB backend:
 *   - GuardrailPolicy documents are seeded into an in-memory Mongo
 *   - resolveGuardrailPolicy queries real data (no vi.mock)
 *   - Caching semantics (positive + negative) are verified by mutating the DB between calls
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoConnectionManager } from '@agent-platform/database/mongo';
import { getSessionPolicy } from '../../../services/execution/session-policy.js';
import { resetSharedRegistry } from '../../../services/guardrails/pipeline-factory.js';
import type { RuntimeSession } from '../../../services/execution/types.js';

const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const TEST_DATABASE = 'abl_platform_session_policy_test';

let mongod: MongoMemoryServer;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: MONGOMS_VERSION },
    instance: { launchTimeout: 30_000 },
  });

  await MongoConnectionManager.reset();

  const { initMongoBackend } = await import('../../../db/index.js');
  await initMongoBackend({
    enabled: true,
    url: mongod.getUri(),
    database: TEST_DATABASE,
    minPoolSize: 1,
    maxPoolSize: 5,
    maxIdleTimeMs: 10_000,
    connectTimeoutMs: 10_000,
    socketTimeoutMs: 10_000,
    serverSelectionTimeoutMs: 10_000,
    heartbeatFrequencyMs: 10_000,
    tls: false,
    tlsAllowInvalidCertificates: false,
    authSource: 'admin',
    writeConcern: '1',
    readPreference: 'primary',
    retryWrites: true,
    retryReads: true,
    directConnection: true,
    autoIndex: true,
    slowQueryThresholdMs: 250,
    appName: 'session-policy-test',
  });
}, 60_000);

afterAll(async () => {
  const { disconnectDatabase } = await import('../../../db/index.js');
  await disconnectDatabase();
  await MongoConnectionManager.reset();
  await mongod.stop();
}, 30_000);

beforeEach(async () => {
  const { GuardrailPolicy } = await import('@agent-platform/database/models');
  await GuardrailPolicy.deleteMany({});
  resetSharedRegistry();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    agentName: 'test-agent',
    agentIR: {
      metadata: { name: 'test-agent', version: '1.0' },
      constraints: { guardrails: [] },
    },
    data: { values: {}, conversationHistory: [] },
    ...overrides,
  } as unknown as RuntimeSession;
}

async function seedPolicy(overrides: Record<string, unknown> = {}): Promise<void> {
  const { GuardrailPolicy } = await import('@agent-platform/database/models');
  await GuardrailPolicy.create({
    name: 'test-policy',
    tenantId: 'tenant-1',
    isActive: true,
    status: 'active',
    scope: { type: 'project', projectId: 'project-1' },
    rules: [
      {
        guardrailName: 'content_safety',
        override: 'action',
        action: { type: 'block', message: 'Blocked' },
      },
    ],
    settings: { failMode: 'open' },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getSessionPolicy — project inheritance (real MongoDB)', () => {
  it('should resolve policy from DB when agent has no DSL guardrails', async () => {
    await seedPolicy();

    const session = makeSession();
    const result = await getSessionPolicy(session);

    expect(result).toBeDefined();
    expect(result!.settings.failMode).toBe('open');
  });

  it('should cache resolved policy on session (no re-query)', async () => {
    await seedPolicy();

    const session = makeSession();
    const first = await getSessionPolicy(session);
    expect(first).toBeDefined();

    // Delete all policies — a re-query would return undefined
    const { GuardrailPolicy } = await import('@agent-platform/database/models');
    await GuardrailPolicy.deleteMany({});

    // Second call on the SAME session object should return the cached value
    const second = await getSessionPolicy(session);
    expect(second).toBeDefined();
    expect(second!.settings.failMode).toBe('open');
  });

  it('should cache undefined when no policies found', async () => {
    // Do NOT seed any policies
    const session = makeSession();
    const first = await getSessionPolicy(session);
    expect(first).toBeUndefined();

    // NOW seed a policy — if caching works, the next call still returns undefined
    await seedPolicy();

    const second = await getSessionPolicy(session);
    expect(second).toBeUndefined();
  });

  it('should resolve policy when agent has DSL guardrails', async () => {
    await seedPolicy();

    const session = makeSession({
      agentIR: {
        metadata: { name: 'test-agent', version: '1.0' },
        constraints: {
          guardrails: [
            {
              name: 'dsl-guard',
              description: 'DSL guard',
              kind: 'output',
              priority: 1,
              tier: 'local',
              check: 'true',
              action: { type: 'block' },
            },
          ],
        },
      },
    } as unknown as Partial<RuntimeSession>);

    const result = await getSessionPolicy(session);

    // The resolver ran successfully with both DSL guardrails and DB policies
    expect(result).toBeDefined();
    expect(result!.settings.failMode).toBe('open');
  });
});
