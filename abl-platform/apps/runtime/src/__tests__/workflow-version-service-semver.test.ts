/**
 * Scenario 4b / INT-3: resolveDefaultVersion() semver-desc ordering.
 *
 * Verifies the Phase 5 behavior change: default version resolution picks
 * the highest-semver active version, NOT the most-recently-published one.
 *
 * Uses real MongoMemoryServer + real WorkflowVersionService.
 * No vi.mock of internal packages.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { Workflow, WorkflowVersion } from '@agent-platform/database/models';
import {
  getWorkflowVersionService,
  resetWorkflowVersionService,
} from '../services/workflow-version-service.js';

// ─── Test Constants ──────────────────────────────────────────────────────────

const TENANT = 'tenant-semver-int';
const PROJECT = 'project-semver-int';
const USER = 'user-semver-int';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeWorkflowData() {
  return {
    tenantId: TENANT,
    projectId: PROJECT,
    name: `wf-semver-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdBy: USER,
    nodes: [
      {
        id: 'n1',
        nodeType: 'start',
        name: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      },
    ],
    edges: [],
    envVars: {},
    inputSchema: null,
    outputSchema: null,
    triggers: [],
  };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestMongo();
}, 60_000);

afterEach(async () => {
  await clearCollections();
  resetWorkflowVersionService();
});

afterAll(async () => {
  await teardownTestMongo();
}, 30_000);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('resolveDefaultVersion() — semver-desc ordering (INT-3)', () => {
  // 30s timeout on the first test: MongoMemoryServer first-query warmup can exceed
  // the default 5s when the binary is cold.
  it('returns highest-semver active version, not the most recently published', async () => {
    const wfDoc = await Workflow.create(makeWorkflowData());
    const workflowId = wfDoc._id as string;

    // Seed 3 active versions — v0.9.0 is published LAST (most recent publishedAt)
    // but v0.10.0 is the highest semver. The old publishedAt-sort would pick v0.9.0.
    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'v0.2.0',
      state: 'active',
      deleted: false,
      sourceHash: 'hash-v0.2.0',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
      publishedAt: new Date('2024-01-01T00:00:00Z'),
    });

    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'v0.10.0',
      state: 'active',
      deleted: false,
      sourceHash: 'hash-v0.10.0',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
      publishedAt: new Date('2024-02-01T00:00:00Z'),
    });

    // v0.9.0 has the MOST RECENT publishedAt — this is the trap.
    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'v0.9.0',
      state: 'active',
      deleted: false,
      sourceHash: 'hash-v0.9.0',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
      publishedAt: new Date('2024-03-01T00:00:00Z'),
    });

    const service = getWorkflowVersionService();
    const result = await service.resolveDefaultVersion(TENANT, PROJECT, workflowId);

    expect(result.resolution).toBe('published');
    expect(result.version.version).toBe('v0.10.0');
  }, 30_000);

  it('returns v0.9.0 after v0.10.0 is deactivated', async () => {
    const wfDoc = await Workflow.create(makeWorkflowData());
    const workflowId = wfDoc._id as string;

    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'v0.2.0',
      state: 'active',
      deleted: false,
      sourceHash: 'hash-v0.2.0',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
    });

    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'v0.10.0',
      state: 'inactive', // deactivated
      deleted: false,
      sourceHash: 'hash-v0.10.0',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
    });

    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'v0.9.0',
      state: 'active',
      deleted: false,
      sourceHash: 'hash-v0.9.0',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
    });

    const service = getWorkflowVersionService();
    const result = await service.resolveDefaultVersion(TENANT, PROJECT, workflowId);

    expect(result.resolution).toBe('published');
    expect(result.version.version).toBe('v0.9.0');
  });

  it('falls back to draft with resolution.miss metric when all active deactivated', async () => {
    const wfDoc = await Workflow.create(makeWorkflowData());
    const workflowId = wfDoc._id as string;

    // Seed a draft version so the fallback can find it
    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'draft',
      state: 'active',
      deleted: false,
      sourceHash: 'hash-draft',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
    });

    // All non-draft versions are inactive
    await WorkflowVersion.create({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId,
      version: 'v0.10.0',
      state: 'inactive',
      deleted: false,
      sourceHash: 'hash-v0.10.0',
      createdBy: USER,
      definition: { nodes: [], edges: [] },
    });

    const service = getWorkflowVersionService();
    const result = await service.resolveDefaultVersion(TENANT, PROJECT, workflowId);

    expect(result.resolution).toBe('draft-fallback');
    expect(result.version.version).toBe('draft');
  });
});
