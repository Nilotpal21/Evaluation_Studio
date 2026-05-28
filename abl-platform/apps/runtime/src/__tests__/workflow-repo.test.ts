/**
 * Workflow Repository — Unit Tests
 *
 * Uses MongoMemoryServer (in-process MongoDB) for real document CRUD.
 * NO vi.mock of internal modules.
 *
 * Validates:
 *  - Each repo function produces the correct Mongoose filter shape.
 *  - Isolation: wrong tenantId / projectId returns null.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { Workflow, WorkflowVersion, WorkflowExecution } from '@agent-platform/database/models';
import {
  findWorkflowByNameAndProject,
  findWorkflowByIdAndTenant,
  findWorkflowVersion,
  findActiveWorkflowVersion,
  findWorkflowExecution,
} from '../repos/workflow-repo.js';

// ─── Test Constants ──────────────────────────────────────────────────────────

const TENANT = 'tenant-wf-repo-test';
const PROJECT = 'project-wf-repo-test';
const OTHER_TENANT = 'tenant-other';
const OTHER_PROJECT = 'project-other';

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

// ─── findWorkflowByNameAndProject ────────────────────────────────────────────

describe('findWorkflowByNameAndProject', () => {
  it('returns the workflow when tenant, project, and name match', async () => {
    const doc = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'my-workflow',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const result = await findWorkflowByNameAndProject('my-workflow', TENANT, PROJECT);
    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(doc._id));
    expect(result.name).toBe('my-workflow');
    expect(result.tenantId).toBe(TENANT);
    expect(result.projectId).toBe(PROJECT);
  });

  it('returns null when tenantId does not match (isolation)', async () => {
    await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'my-workflow',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const result = await findWorkflowByNameAndProject('my-workflow', OTHER_TENANT, PROJECT);
    expect(result).toBeNull();
  });

  it('returns null when projectId does not match (isolation)', async () => {
    await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'my-workflow',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const result = await findWorkflowByNameAndProject('my-workflow', TENANT, OTHER_PROJECT);
    expect(result).toBeNull();
  });
});

// ─── findWorkflowVersion ─────────────────────────────────────────────────────

describe('findWorkflowVersion', () => {
  it('returns the version when all fields match (state-agnostic)', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'versioned-wf',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const ver = await WorkflowVersion.create({
      workflowId: wf._id,
      version: 'v0.1.0',
      tenantId: TENANT,
      projectId: PROJECT,
      state: 'inactive',
      deleted: false,
      createdBy: 'test-user',
      definition: { nodes: [], edges: [] },
      sourceHash: 'test-hash-' + Math.random().toString(36).slice(2, 8),
    });

    const result = await findWorkflowVersion(String(wf._id), 'v0.1.0', TENANT, PROJECT);
    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(ver._id));
    expect(result.version).toBe('v0.1.0');
    // State-agnostic: inactive version is still returned
    expect(result.state).toBe('inactive');
  });

  it('returns null when tenantId does not match (isolation)', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'versioned-wf',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    await WorkflowVersion.create({
      workflowId: wf._id,
      version: 'v0.1.0',
      tenantId: TENANT,
      projectId: PROJECT,
      state: 'active',
      deleted: false,
      createdBy: 'test-user',
      definition: { nodes: [], edges: [] },
      sourceHash: 'test-hash-' + Math.random().toString(36).slice(2, 8),
    });

    const result = await findWorkflowVersion(String(wf._id), 'v0.1.0', OTHER_TENANT, PROJECT);
    expect(result).toBeNull();
  });

  it('returns null when projectId does not match (isolation)', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'versioned-wf',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    await WorkflowVersion.create({
      workflowId: wf._id,
      version: 'v0.1.0',
      tenantId: TENANT,
      projectId: PROJECT,
      state: 'active',
      deleted: false,
      createdBy: 'test-user',
      definition: { nodes: [], edges: [] },
      sourceHash: 'test-hash-' + Math.random().toString(36).slice(2, 8),
    });

    const result = await findWorkflowVersion(String(wf._id), 'v0.1.0', TENANT, OTHER_PROJECT);
    expect(result).toBeNull();
  });
});

// ─── findWorkflowByIdAndTenant ──────────────────────────────────────────────

describe('findWorkflowByIdAndTenant', () => {
  it('returns the workflow when _id and tenantId match (includeDeleted: false)', async () => {
    const doc = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'wf-by-id',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const result = await findWorkflowByIdAndTenant(String(doc._id), TENANT, {
      includeDeleted: false,
    });
    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(doc._id));
    expect(result.tenantId).toBe(TENANT);
  });

  it('returns null for soft-deleted workflow when includeDeleted: false', async () => {
    const doc = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'wf-deleted',
      createdBy: 'test-user',
      deleted: true,
      nodes: [],
      edges: [],
    });

    const result = await findWorkflowByIdAndTenant(String(doc._id), TENANT, {
      includeDeleted: false,
    });
    expect(result).toBeNull();
  });

  it('returns soft-deleted workflow when includeDeleted: true (D-4: status polling)', async () => {
    const doc = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'wf-deleted-visible',
      createdBy: 'test-user',
      deleted: true,
      nodes: [],
      edges: [],
    });

    const result = await findWorkflowByIdAndTenant(String(doc._id), TENANT, {
      includeDeleted: true,
    });
    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(doc._id));
  });

  it('returns null when tenantId does not match (isolation)', async () => {
    const doc = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'wf-tenant-iso',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const result = await findWorkflowByIdAndTenant(String(doc._id), OTHER_TENANT, {
      includeDeleted: false,
    });
    expect(result).toBeNull();
  });
});

// ─── findActiveWorkflowVersion ──────────────────────────────────────────────

describe('findActiveWorkflowVersion', () => {
  it('returns active, non-deleted version (happy path)', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'active-ver-wf',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const ver = await WorkflowVersion.create({
      workflowId: wf._id,
      version: 'v1.0.0',
      tenantId: TENANT,
      projectId: PROJECT,
      state: 'active',
      deleted: false,
      createdBy: 'test-user',
      definition: { nodes: [], edges: [] },
      sourceHash: 'hash-' + Math.random().toString(36).slice(2, 8),
    });

    const result = await findActiveWorkflowVersion(String(wf._id), 'v1.0.0', TENANT, PROJECT);
    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(ver._id));
    expect(result.state).toBe('active');
  });

  it('returns null when state is not active', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'inactive-ver-wf',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    await WorkflowVersion.create({
      workflowId: wf._id,
      version: 'v1.0.0',
      tenantId: TENANT,
      projectId: PROJECT,
      state: 'inactive',
      deleted: false,
      createdBy: 'test-user',
      definition: { nodes: [], edges: [] },
      sourceHash: 'hash-' + Math.random().toString(36).slice(2, 8),
    });

    const result = await findActiveWorkflowVersion(String(wf._id), 'v1.0.0', TENANT, PROJECT);
    expect(result).toBeNull();
  });

  it('returns null when version is deleted', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'deleted-ver-wf',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    await WorkflowVersion.create({
      workflowId: wf._id,
      version: 'v1.0.0',
      tenantId: TENANT,
      projectId: PROJECT,
      state: 'active',
      deleted: true,
      createdBy: 'test-user',
      definition: { nodes: [], edges: [] },
      sourceHash: 'hash-' + Math.random().toString(36).slice(2, 8),
    });

    const result = await findActiveWorkflowVersion(String(wf._id), 'v1.0.0', TENANT, PROJECT);
    expect(result).toBeNull();
  });
});

// ─── findWorkflowExecution ──────────────────────────────────────────────────

describe('findWorkflowExecution', () => {
  it('returns the execution when all fields match (happy path)', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'exec-wf',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const exec = await WorkflowExecution.create({
      workflowId: wf._id,
      tenantId: TENANT,
      projectId: PROJECT,
      status: 'completed',
      triggerType: 'webhook',
      startedAt: new Date(),
      input: {},
      nodeExecutions: [],
      context: {},
    });

    const result = await findWorkflowExecution(String(exec._id), String(wf._id), TENANT, PROJECT);
    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(exec._id));
    expect(result.status).toBe('completed');
  });

  it('returns null when projectId does not match (isolation)', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'exec-wf-iso',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const exec = await WorkflowExecution.create({
      workflowId: wf._id,
      tenantId: TENANT,
      projectId: PROJECT,
      status: 'running',
      triggerType: 'webhook',
      startedAt: new Date(),
      input: {},
      nodeExecutions: [],
      context: {},
    });

    const result = await findWorkflowExecution(
      String(exec._id),
      String(wf._id),
      TENANT,
      OTHER_PROJECT,
    );
    expect(result).toBeNull();
  });

  it('returns null when tenantId does not match (isolation)', async () => {
    const wf = await Workflow.create({
      tenantId: TENANT,
      projectId: PROJECT,
      name: 'exec-wf-tenant-iso',
      createdBy: 'test-user',
      nodes: [],
      edges: [],
    });

    const exec = await WorkflowExecution.create({
      workflowId: wf._id,
      tenantId: TENANT,
      projectId: PROJECT,
      status: 'running',
      triggerType: 'webhook',
      startedAt: new Date(),
      input: {},
      nodeExecutions: [],
      context: {},
    });

    const result = await findWorkflowExecution(
      String(exec._id),
      String(wf._id),
      OTHER_TENANT,
      PROJECT,
    );
    expect(result).toBeNull();
  });
});
