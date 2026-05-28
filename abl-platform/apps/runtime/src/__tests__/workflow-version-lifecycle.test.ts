/**
 * WorkflowVersionService — Lifecycle Integration Tests
 *
 * Uses MongoMemoryServer (in-process MongoDB) for real document CRUD.
 * NO vi.mock of internal modules.
 *
 * Coverage:
 *  1. Full lifecycle: draft → createVersion → activate → deactivate
 *  2. Cascade delete: workflow + versions + triggers
 *  3. INT-12: activate → deactivate → TriggerRegistrations updated, not deleted
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { Workflow, WorkflowVersion, TriggerRegistration } from '@agent-platform/database/models';
import {
  getWorkflowVersionService,
  resetWorkflowVersionService,
} from '../services/workflow-version-service.js';

// ─── Test Constants ──────────────────────────────────────────────────────────

const TENANT = 'tenant-lifecycle-test';
const PROJECT = 'project-lifecycle-test';
const USER = 'user-lifecycle-test';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeWorkflowData(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    projectId: PROJECT,
    name: `lifecycle-wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdBy: USER,
    nodes: [
      {
        id: 'start-1',
        nodeType: 'start',
        name: 'Start Node',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'end-1',
        nodeType: 'end',
        name: 'End Node',
        position: { x: 200, y: 0 },
        config: {},
      },
    ],
    edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'default', target: 'end-1' }],
    envVars: { API_KEY: 'test-key' },
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
    outputSchema: null,
    triggers: [
      {
        id: 'trig-cron',
        type: 'cron',
        config: { name: 'daily-run', cronExpression: '0 0 * * *' },
        status: 'active',
      },
      {
        id: 'trig-webhook',
        type: 'webhook',
        config: { name: 'inbound-hook' },
        status: 'active',
      },
    ],
    ...overrides,
  };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestMongo();
}, 60_000);

afterAll(async () => {
  await teardownTestMongo();
}, 30_000);

afterEach(async () => {
  resetWorkflowVersionService();
  await clearCollections();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

// Deterministic stub replaces the DEK-facade-backed `encryptForTenantAuto`
// in tests — avoids bootstrapping KMS just to exercise the trigger writer.
// The `cipher:` prefix lets assertions prove that the row holds ciphertext.
const TEST_CIPHER_PREFIX = 'cipher:';
const testEncryptSecret = async (plaintext: string): Promise<string> =>
  `${TEST_CIPHER_PREFIX}${plaintext}`;

describe('WorkflowVersion Lifecycle', () => {
  function svc() {
    resetWorkflowVersionService();
    return getWorkflowVersionService({ encryptSecret: testEncryptSecret });
  }

  // ─── 1. Full lifecycle ────────────────────────────────────────────────────

  it('full lifecycle: draft → createVersion → activate → verify triggers → deactivate', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    // Step 1: Draft is created lazily
    const draft = await s.getOrCreateDraft(wf._id, TENANT, PROJECT, USER);
    expect(draft.version).toBe('draft');

    // Step 2: Create a published version from draft
    const created = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
      changelog: 'Initial release',
    });
    expect(created.version).toBe('v0.1.0');

    // Verify it starts inactive
    const versionDoc = await WorkflowVersion.findOne({
      _id: created.versionId,
      tenantId: TENANT,
    }).lean();
    expect(versionDoc).toBeDefined();
    expect((versionDoc as Record<string, unknown>).state).toBe('inactive');

    // Step 3: Activate
    const activated = await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });
    expect((activated as Record<string, unknown>).state).toBe('active');

    // Step 4: Verify TriggerRegistrations were created
    const regs = await TriggerRegistration.find({
      workflowVersionId: created.versionId,
      tenantId: TENANT,
    }).lean();
    expect(regs.length).toBe(2); // cron + webhook
    expect(regs.every((r) => r.status === 'active')).toBe(true);

    // Verify trigger types
    const triggerTypes = regs.map((r) => r.triggerType).sort();
    expect(triggerTypes).toEqual(['cron', 'webhook']);

    // Verify webhook trigger has a webhookSecret, and that it is persisted
    // as ciphertext — not the raw `whsec_…` plaintext emitted by
    // `generateWebhookSecret()`. The connectors webhook handler decrypts on
    // read, so the on-disk row must never carry plaintext HMAC material.
    const webhookReg = regs.find((r) => r.triggerType === 'webhook');
    expect(webhookReg?.webhookSecret).toBeDefined();
    expect(typeof webhookReg?.webhookSecret).toBe('string');
    expect(webhookReg!.webhookSecret!.length).toBeGreaterThan(0);
    expect(webhookReg!.webhookSecret!.startsWith(TEST_CIPHER_PREFIX)).toBe(true);
    expect(webhookReg!.webhookSecret!.startsWith('whsec_')).toBe(false);

    // Verify cron trigger has cronExpression
    const cronReg = regs.find((r) => r.triggerType === 'cron');
    expect(cronReg?.cronExpression).toBe('0 0 * * *');

    // Step 5: Deactivate
    const deactivated = await s.deactivate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
    });
    expect((deactivated as Record<string, unknown>).state).toBe('inactive');

    // Step 6: Verify TriggerRegistrations are now inactive
    const deactivatedRegs = await TriggerRegistration.find({
      workflowVersionId: created.versionId,
      tenantId: TENANT,
    }).lean();
    expect(deactivatedRegs.every((r) => r.status === 'inactive')).toBe(true);

    // Step 7: resolveDefaultVersion should fall back to draft since no active version
    const resolved = await s.resolveDefaultVersion(TENANT, PROJECT, wf._id);
    expect(resolved.resolution).toBe('draft-fallback');
  });

  // ─── 2. Cascade delete ───────────────────────────────────────────────────

  it('cascade delete: workflow + versions + triggers all marked deleted', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    // Create a version and activate it (so triggers exist)
    const v1 = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });
    await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: v1.version,
      activatedBy: USER,
    });

    // Verify pre-conditions: workflow, versions, triggers all exist and not deleted
    const preWorkflow = await Workflow.findOne({ _id: wf._id, tenantId: TENANT }).lean();
    expect((preWorkflow as Record<string, unknown>).deleted).toBe(false);

    const preVersions = await WorkflowVersion.find({
      workflowId: wf._id,
      tenantId: TENANT,
      deleted: false,
    }).lean();
    expect(preVersions.length).toBeGreaterThanOrEqual(2); // draft + v0.1.0

    const preTriggers = await TriggerRegistration.find({
      workflowId: wf._id,
      tenantId: TENANT,
      status: 'active',
    }).lean();
    expect(preTriggers.length).toBeGreaterThan(0);

    // Execute cascade delete
    await s.softDeleteCascade(TENANT, PROJECT, wf._id);

    // Verify workflow is deleted
    const postWorkflow = await Workflow.findOne({ _id: wf._id, tenantId: TENANT }).lean();
    expect((postWorkflow as Record<string, unknown>).deleted).toBe(true);

    // Verify ALL versions are deleted
    const postVersions = await WorkflowVersion.find({
      workflowId: wf._id,
      tenantId: TENANT,
    }).lean();
    for (const v of postVersions) {
      expect((v as Record<string, unknown>).deleted).toBe(true);
    }

    // Verify ALL trigger registrations have status 'deleted'
    const postTriggers = await TriggerRegistration.find({
      workflowId: wf._id,
      tenantId: TENANT,
    }).lean();
    for (const t of postTriggers) {
      expect(t.status).toBe('deleted');
    }
  });

  // ─── 3. INT-12: activate → deactivate → triggers updated not deleted ─────

  it('INT-12: deactivate updates TriggerRegistrations to inactive, does not delete them', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    // Create and activate
    const created = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });

    // Capture trigger count before deactivation
    const activeRegs = await TriggerRegistration.find({
      workflowVersionId: created.versionId,
      tenantId: TENANT,
    }).lean();
    const triggerCountBefore = activeRegs.length;
    expect(triggerCountBefore).toBeGreaterThan(0);

    // Deactivate
    await s.deactivate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
    });

    // Verify: same number of triggers, all inactive (NOT deleted)
    const postRegs = await TriggerRegistration.find({
      workflowVersionId: created.versionId,
      tenantId: TENANT,
    }).lean();

    expect(postRegs.length).toBe(triggerCountBefore);
    for (const reg of postRegs) {
      expect(reg.status).toBe('inactive');
      // Explicitly check not deleted
      expect(reg.status).not.toBe('deleted');
    }

    // Verify the version doc is inactive
    const versionDoc = await WorkflowVersion.findOne({
      _id: created.versionId,
      tenantId: TENANT,
    }).lean();
    expect((versionDoc as Record<string, unknown>).state).toBe('inactive');
    expect((versionDoc as Record<string, unknown>).deleted).toBe(false);
  });
});
