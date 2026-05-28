/**
 * Deployment Repository — Variable Snapshot Tests
 *
 * Uses MongoMemoryServer for real document CRUD.
 * NO vi.mock of internal modules.
 *
 * Validates:
 *  - findDeploymentVariableSnapshot returns the correct snapshot.
 *  - Isolation: wrong tenantId returns null.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { DeploymentVariableSnapshot } from '@agent-platform/database/models';
import { findDeploymentVariableSnapshot } from '../repos/deployment-repo.js';

// ─── Test Constants ──────────────────────────────────────────────────────────

const TENANT = 'tenant-snap-test';
const OTHER_TENANT = 'tenant-other';
const PROJECT = 'project-snap-test';
const OTHER_PROJECT = 'project-other';
const DEPLOYMENT_ID = 'deployment-snap-001';

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestMongo();
});

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
});

// ─── findDeploymentVariableSnapshot ──────────────────────────────────────────

describe('findDeploymentVariableSnapshot', () => {
  it('returns the snapshot when deploymentId, tenantId, and projectId match', async () => {
    const doc = await DeploymentVariableSnapshot.create({
      deploymentId: DEPLOYMENT_ID,
      tenantId: TENANT,
      projectId: PROJECT,
      environment: 'production',
      snapshotVersion: 1,
      snapshotHash: 'abc123',
      envVars: [{ key: 'API_KEY', isSecret: true, encryptedValue: 'enc-val', sourceId: 'src-1' }],
      configVars: [{ key: 'LOG_LEVEL', value: 'info', sourceId: 'src-2' }],
      createdBy: 'test-user',
    });

    const result = await findDeploymentVariableSnapshot(DEPLOYMENT_ID, TENANT, PROJECT);
    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(doc._id));
    expect(result.deploymentId).toBe(DEPLOYMENT_ID);
    expect(result.tenantId).toBe(TENANT);
    expect(result.projectId).toBe(PROJECT);
    expect(result.envVars).toHaveLength(1);
    expect(result.configVars).toHaveLength(1);
  });

  it('returns null when tenantId does not match (isolation)', async () => {
    await DeploymentVariableSnapshot.create({
      deploymentId: DEPLOYMENT_ID,
      tenantId: TENANT,
      projectId: PROJECT,
      environment: 'production',
      snapshotVersion: 1,
      snapshotHash: 'abc123',
      envVars: [],
      configVars: [],
      createdBy: 'test-user',
    });

    const result = await findDeploymentVariableSnapshot(DEPLOYMENT_ID, OTHER_TENANT, PROJECT);
    expect(result).toBeNull();
  });

  it('returns null when projectId does not match (isolation)', async () => {
    await DeploymentVariableSnapshot.create({
      deploymentId: DEPLOYMENT_ID,
      tenantId: TENANT,
      projectId: PROJECT,
      environment: 'production',
      snapshotVersion: 1,
      snapshotHash: 'abc123',
      envVars: [],
      configVars: [],
      createdBy: 'test-user',
    });

    const result = await findDeploymentVariableSnapshot(DEPLOYMENT_ID, TENANT, OTHER_PROJECT);
    expect(result).toBeNull();
  });
});
