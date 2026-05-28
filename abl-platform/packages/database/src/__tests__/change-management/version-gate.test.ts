import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { setupTestMongo, teardownTestMongo, isMongoReady } from '../helpers/setup-mongo.js';
import { writeChangeHistory } from '../../change-management/history.js';
import {
  evaluateServiceChangeCompatibility,
  loadServiceChangeCompatibility,
} from '../../change-management/version-gate.js';
import type {
  ChangeHistoryEntry,
  ServiceChangeRequirement,
} from '../../change-management/types.js';

function createRequirement(
  overrides: Partial<ServiceChangeRequirement> = {},
): ServiceChangeRequirement {
  return {
    service: 'runtime',
    environment: 'prod',
    enforcementMode: 'soft_ready',
    requiredChangeIds: ['seed.platform-core', 'seed.rbac-tool-permissions'],
    optionalChangeIds: ['clickhouse.006-json-path-index'],
    ...overrides,
  };
}

function createHistoryEntry(overrides: Partial<ChangeHistoryEntry> = {}): ChangeHistoryEntry {
  return {
    changeId: 'seed.platform-core',
    description: 'Platform core seed',
    engine: 'mongodb',
    kind: 'seed_platform',
    phase: 'continuous',
    scope: 'global',
    status: 'applied',
    environment: 'prod',
    ...overrides,
  };
}

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  if (!isMongoReady()) return;

  const db = mongoose.connection.db!;
  const collections = await db.listCollections({ name: '_change_history' }).toArray();
  if (collections.length > 0) {
    await db.collection('_change_history').deleteMany({});
  }
});

describe('evaluateServiceChangeCompatibility', () => {
  test('marks runtime not_ready when any required change is missing', () => {
    const result = evaluateServiceChangeCompatibility(createRequirement(), [
      createHistoryEntry({ changeId: 'seed.platform-core' }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.outcome).toBe('not_ready');
    expect(result.blockingIssues).toHaveLength(1);
    expect(result.blockingIssues[0]).toMatchObject({
      changeId: 'seed.rbac-tool-permissions',
      reason: 'missing',
      severity: 'blocking',
    });
  });

  test('keeps optional changes as warnings when required changes are satisfied', () => {
    const result = evaluateServiceChangeCompatibility(createRequirement(), [
      createHistoryEntry({ changeId: 'seed.platform-core' }),
      createHistoryEntry({
        changeId: 'seed.rbac-tool-permissions',
        description: 'RBAC permission alignment',
      }),
    ]);

    expect(result.ready).toBe(true);
    expect(result.outcome).toBe('ready');
    expect(result.blockingIssues).toHaveLength(0);
    expect(result.warningIssues).toHaveLength(1);
    expect(result.warningIssues[0]).toMatchObject({
      changeId: 'clickhouse.006-json-path-index',
      reason: 'missing',
      severity: 'warning',
    });
  });

  test('supports warn_only outcomes for search-ai compatibility warnings', () => {
    const result = evaluateServiceChangeCompatibility(
      createRequirement({
        service: 'search-ai',
        enforcementMode: 'warn_only',
        requiredChangeIds: ['seed.platform-core'],
        optionalChangeIds: ['clickhouse.006-json-path-index'],
      }),
      [createHistoryEntry({ changeId: 'seed.platform-core' })],
    );

    expect(result.ready).toBe(true);
    expect(result.outcome).toBe('warn_only');
    expect(result.shouldExit).toBe(false);
    expect(result.warningIssues).toHaveLength(1);
  });

  test('marks hard_fail requirements as exit-worthy when blockers remain', () => {
    const result = evaluateServiceChangeCompatibility(
      createRequirement({
        enforcementMode: 'hard_fail',
        requiredChangeIds: ['seed.platform-core'],
      }),
      [],
    );

    expect(result.ready).toBe(false);
    expect(result.outcome).toBe('not_ready');
    expect(result.shouldExit).toBe(true);
  });
});

describe('loadServiceChangeCompatibility', () => {
  test('filters by environment and ignores tenant-scoped history for service gates', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await writeChangeHistory(db, {
      changeId: 'seed.platform-core',
      description: 'Platform core seed',
      environment: 'prod',
      engine: 'mongodb',
      kind: 'seed_platform',
      phase: 'continuous',
      scope: 'global',
      status: 'applied',
      appliedAt: new Date(),
    });

    await writeChangeHistory(db, {
      changeId: 'seed.rbac-tool-permissions',
      description: 'RBAC permission alignment',
      environment: 'dev',
      engine: 'mongodb',
      kind: 'seed_platform',
      phase: 'continuous',
      scope: 'global',
      status: 'applied',
      appliedAt: new Date(),
    });

    await writeChangeHistory(db, {
      changeId: 'seed.rbac-tool-permissions',
      description: 'RBAC permission alignment',
      environment: 'prod',
      engine: 'mongodb',
      kind: 'seed_platform',
      phase: 'continuous',
      scope: 'tenant',
      status: 'applied',
      targetKey: 'tenant:customer-a',
      appliedAt: new Date(),
    });

    const result = await loadServiceChangeCompatibility(
      db,
      createRequirement({
        requiredChangeIds: ['seed.platform-core', 'seed.rbac-tool-permissions'],
        optionalChangeIds: [],
      }),
    );

    expect(result.ready).toBe(false);
    expect(result.blockingIssues).toHaveLength(1);
    expect(result.blockingIssues[0]).toMatchObject({
      changeId: 'seed.rbac-tool-permissions',
      reason: 'missing',
    });
  });
});
