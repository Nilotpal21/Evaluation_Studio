/**
 * INT-4: Workflow Tool Binding Validation Tests
 *
 * Tests the async DB cross-check for workflow tool bindings:
 * 1. Webhook trigger accepted
 * 2. Non-existent trigger rejected
 * 3. Cron trigger rejected
 * 4. Cross-project 404 (workflow in different projectId)
 *
 * Uses a fake workflowsRepo (DI) — no Mongoose mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflowToolBinding } from '../tools/validate-workflow-tool-binding.js';
import type {
  TriggerRegistrationsRepo,
  WorkflowVersionsRepo,
  WorkflowsRepo,
  WorkflowDoc,
} from '../tools/validate-workflow-tool-binding.js';
import { validateToolDsl } from '../tools/project-tool-validator.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeWorkflow(overrides?: Partial<WorkflowDoc>): WorkflowDoc {
  return {
    _id: 'wf_001',
    status: 'active',
    triggers: [
      { id: 'tr_webhook', type: 'webhook' },
      { id: 'tr_cron', type: 'cron' },
    ],
    ...overrides,
  };
}

function makeRepo(
  workflow: WorkflowDoc | null,
  expectedFilter?: Record<string, unknown>,
): WorkflowsRepo {
  return {
    findOne: async (filter: Record<string, unknown>) => {
      if (expectedFilter) {
        // Ensure tenant+project isolation is enforced in the query
        expect(filter).toHaveProperty('tenantId');
        expect(filter).toHaveProperty('projectId');
      }
      // Simulate cross-scope miss by checking projectId match
      if (workflow && filter.projectId && filter.projectId !== 'proj_A') {
        return null;
      }
      if (workflow && filter._id === workflow._id) {
        return workflow;
      }
      return null;
    },
  };
}

function makeWorkflowVersionsRepo(version: { _id: string; state?: 'active' | 'inactive' } | null) {
  return {
    findOne: async () =>
      version
        ? {
            _id: version._id,
            workflowId: 'wf_001',
            state: version.state ?? 'active',
          }
        : null,
  } satisfies WorkflowVersionsRepo;
}

function makeTriggerRegistrationsRepo(
  trigger: {
    _id: string;
    workflowVersionId?: string;
    status?: 'active' | 'paused' | 'error' | 'deleted' | 'inactive';
  } | null,
) {
  return {
    findOne: async () =>
      trigger
        ? {
            _id: trigger._id,
            workflowId: 'wf_001',
            workflowVersionId: trigger.workflowVersionId,
            triggerType: 'webhook',
            status: trigger.status ?? 'active',
          }
        : null,
  } satisfies TriggerRegistrationsRepo;
}

// ─── Sync Structural Validation ────────────────────────────────────────────

describe('validateToolDsl — workflow type structural checks', () => {
  it('accepts a valid workflow DSL', () => {
    const dsl = [
      'run_workflow(payload: object) -> object',
      '  type: workflow',
      '  description: Run the approval workflow',
      '  workflow_id: wf_001',
      '  trigger_id: tr_webhook',
      '  mode: sync',
      '  timeout_ms: 15000',
    ].join('\n');

    const result = validateToolDsl(dsl, { tenantId: 't1', projectId: 'p1' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects workflow DSL missing workflow_id in trial compile', () => {
    const dsl = [
      'run_workflow(payload: object) -> object',
      '  type: workflow',
      '  description: Run the approval workflow',
      '  trigger_id: tr_webhook',
    ].join('\n');

    const result = validateToolDsl(dsl, { tenantId: 't1', projectId: 'p1' });
    expect(result.valid).toBe(false);
    // Should fail structural check for missing workflow_id
    expect(result.errors.some((e) => e.code === 'WORKFLOW_MISSING_WORKFLOW_ID')).toBe(true);
  });

  it('rejects invalid mode', () => {
    const dsl = [
      'run_workflow(payload: object) -> object',
      '  type: workflow',
      '  description: Run it',
      '  workflow_id: wf_001',
      '  trigger_id: tr_webhook',
      '  mode: batch',
    ].join('\n');

    const result = validateToolDsl(dsl, { tenantId: 't1', projectId: 'p1' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'WORKFLOW_INVALID_MODE')).toBe(true);
  });
});

// ─── Async DB Cross-Check ──────────────────────────────────────────────────

describe('validateWorkflowToolBinding — async DB cross-check', () => {
  const ctx = (repo: WorkflowsRepo) => ({
    tenantId: 'tenant_1',
    projectId: 'proj_A',
    workflowsRepo: repo,
  });

  it('accepts a valid webhook trigger', async () => {
    const wf = makeWorkflow();
    const repo = makeRepo(wf);

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf_001', triggerId: 'tr_webhook' },
      ctx(repo),
    );

    expect(result.valid).toBe(true);
  });

  it('rejects a non-existent trigger', async () => {
    const wf = makeWorkflow();
    const repo = makeRepo(wf);

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf_001', triggerId: 'tr_nonexistent' },
      ctx(repo),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('tr_nonexistent');
    }
  });

  it('rejects a cron trigger (non-webhook)', async () => {
    const wf = makeWorkflow();
    const repo = makeRepo(wf);

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf_001', triggerId: 'tr_cron' },
      ctx(repo),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('webhook');
    }
  });

  it('returns 404-equivalent for cross-project workflow (WORKFLOW_NOT_FOUND)', async () => {
    // Workflow exists in proj_A, but we query from proj_B
    const wf = makeWorkflow();
    const repo = makeRepo(wf, { tenantId: 'tenant_1', projectId: 'proj_B' });

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf_001', triggerId: 'tr_webhook' },
      {
        tenantId: 'tenant_1',
        projectId: 'proj_B', // Different project — cross-scope
        workflowsRepo: repo,
      },
    );

    // Cross-scope access returns NOT_FOUND (404), NOT forbidden (403)
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('WORKFLOW_NOT_FOUND');
    }
  });

  it('rejects an inactive workflow', async () => {
    const wf = makeWorkflow({ status: 'archived' });
    const repo = makeRepo(wf);

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf_001', triggerId: 'tr_webhook' },
      ctx(repo),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('WORKFLOW_INACTIVE');
    }
  });

  it('rejects a webhook trigger with user_level auth', async () => {
    const wf = makeWorkflow({
      triggers: [{ id: 'tr_user_auth', type: 'webhook', auth: { type: 'user_level' } }],
    });
    const repo = makeRepo(wf);

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf_001', triggerId: 'tr_user_auth' },
      ctx(repo),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('user_level');
    }
  });

  it('rejects active trigger registrations pinned to a missing workflow version', async () => {
    const wf = makeWorkflow();
    const repo = makeRepo(wf);

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf_001', triggerId: 'tr_webhook' },
      {
        tenantId: 'tenant_1',
        projectId: 'proj_A',
        workflowsRepo: repo,
        workflowVersionsRepo: makeWorkflowVersionsRepo(null),
        triggerRegistrationsRepo: makeTriggerRegistrationsRepo({
          _id: 'tr_webhook',
          workflowVersionId: 'wfv_missing',
        }),
      },
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain(
        'Workflow version bound to this trigger was not found',
      );
    }
  });
});
