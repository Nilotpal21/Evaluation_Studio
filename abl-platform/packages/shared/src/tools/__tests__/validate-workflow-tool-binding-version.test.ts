/**
 * INT-11 — Workflow-as-Tool Binding Validation with Version-Aware Check
 *
 * Validates the dual-check logic in validateWorkflowToolBinding:
 * 1. Version-first: passes if an active WorkflowVersion exists
 * 2. Legacy fallback: passes if workflow.status === 'active' (no versions repo)
 * 3. Fails if neither condition is met
 * 4. Deleted workflows return WORKFLOW_NOT_FOUND
 *
 * Uses DI test doubles (no vi.mock). The function accepts repo interfaces,
 * so we provide simple in-memory implementations.
 */

import { describe, test, expect } from 'vitest';
import {
  validateWorkflowToolBinding,
  type WorkflowDoc,
  type WorkflowVersionDoc,
  type TriggerRegistrationDoc,
  type WorkflowsRepo,
  type WorkflowVersionsRepo,
  type TriggerRegistrationsRepo,
  type ValidateWorkflowBindingContext,
} from '../validate-workflow-tool-binding.js';

// ---------------------------------------------------------------------------
// Test doubles — in-memory repos
// ---------------------------------------------------------------------------

function createWorkflowsRepo(
  workflows: (WorkflowDoc & { tenantId?: string; projectId?: string })[],
): WorkflowsRepo {
  return {
    async findOne(filter: Record<string, unknown>) {
      return (
        workflows.find(
          (w) =>
            w._id === filter._id &&
            (filter.tenantId === undefined || w.tenantId === filter.tenantId) &&
            (filter.projectId === undefined || w.projectId === filter.projectId),
        ) ?? null
      );
    },
  };
}

function createVersionsRepo(
  versions: (WorkflowVersionDoc & { tenantId?: string; projectId?: string })[],
): WorkflowVersionsRepo {
  return {
    async findOne(filter: Record<string, unknown>) {
      return (
        versions.find((v) =>
          Object.entries(filter).every(([key, expected]) => {
            const actual = (v as unknown as Record<string, unknown>)[key];
            if (expected && typeof expected === 'object' && '$ne' in expected) {
              return actual !== (expected as { $ne: unknown }).$ne;
            }
            return actual === expected;
          }),
        ) ?? null
      );
    },
  };
}

function createTriggerRegistrationsRepo(
  triggers: (TriggerRegistrationDoc & { tenantId?: string; projectId?: string })[],
): TriggerRegistrationsRepo {
  return {
    async findOne(filter: Record<string, unknown>) {
      return (
        triggers.find((trigger) =>
          Object.entries(filter).every(
            ([key, expected]) => (trigger as unknown as Record<string, unknown>)[key] === expected,
          ),
        ) ?? null
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'project-1';

const activeWorkflow: WorkflowDoc & { tenantId: string; projectId: string } = {
  _id: 'wf-1',
  status: 'active',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  triggers: [
    { id: 'trg-webhook', type: 'webhook' },
    { id: 'trg-cron', type: 'cron' },
  ],
} as WorkflowDoc & { tenantId: string; projectId: string };

const inactiveWorkflow: WorkflowDoc & { tenantId: string; projectId: string } = {
  _id: 'wf-2',
  status: 'paused',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  triggers: [{ id: 'trg-webhook-2', type: 'webhook' }],
} as WorkflowDoc & { tenantId: string; projectId: string };

const deletedWorkflow: WorkflowDoc & { tenantId: string; projectId: string } = {
  _id: 'wf-3',
  status: 'active',
  deleted: true,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  triggers: [{ id: 'trg-webhook-3', type: 'webhook' }],
} as WorkflowDoc & { tenantId: string; projectId: string };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('INT-11: validateWorkflowToolBinding version-aware check', () => {
  test('rejects config-backed workflow identity fields by default for live project tools', async () => {
    const workflowsRepo = createWorkflowsRepo([]);
    const workflowVersionsRepo = createVersionsRepo([]);
    const triggerRegistrationsRepo = createTriggerRegistrationsRepo([]);
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo,
      workflowVersionsRepo,
      triggerRegistrationsRepo,
    };

    const result = await validateWorkflowToolBinding(
      {
        workflowId: '{{config.APPROVAL_WORKFLOW_ID}}',
        workflowVersionId: '{{config.APPROVAL_WORKFLOW_VERSION_ID}}',
        triggerId: '{{config.APPROVAL_TRIGGER_ID}}',
      },
      ctx,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatchObject({
        code: 'INVALID_TOOL_BINDING',
        message: 'Workflow tool identity fields cannot use config placeholders',
      });
    }
  });

  test('can defer DB validation for module artifact placeholder checks when explicitly allowed', async () => {
    const workflowsRepo = createWorkflowsRepo([]);
    const workflowVersionsRepo = createVersionsRepo([]);
    const triggerRegistrationsRepo = createTriggerRegistrationsRepo([]);
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo,
      workflowVersionsRepo,
      triggerRegistrationsRepo,
      allowConfigPlaceholders: true,
    };

    const result = await validateWorkflowToolBinding(
      {
        workflowId: '{{config.APPROVAL_WORKFLOW_ID}}',
        workflowVersionId: '{{config.APPROVAL_WORKFLOW_VERSION_ID}}',
        triggerId: '{{config.APPROVAL_TRIGGER_ID}}',
      },
      ctx,
    );

    expect(result.valid).toBe(true);
  });

  test('passes when active WorkflowVersion exists (version-first path)', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...inactiveWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        {
          _id: 'ver-1',
          workflowId: 'wf-2',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-2', triggerId: 'trg-webhook-2' },
      ctx,
    );
    expect(result.valid).toBe(true);
  });

  test('passes via legacy fallback when workflow.status is active (no active version)', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        // Only inactive versions
        { _id: 'ver-1', workflowId: 'wf-1', state: 'inactive', tenantId: TENANT_ID },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', triggerId: 'trg-webhook' },
      ctx,
    );
    expect(result.valid).toBe(true);
  });

  test('passes via legacy fallback when no versionsRepo provided', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      // No workflowVersionsRepo — legacy mode
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', triggerId: 'trg-webhook' },
      ctx,
    );
    expect(result.valid).toBe(true);
  });

  test('fails when neither active version nor active status', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...inactiveWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        { _id: 'ver-1', workflowId: 'wf-2', state: 'inactive', tenantId: TENANT_ID },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-2', triggerId: 'trg-webhook-2' },
      ctx,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('WORKFLOW_INACTIVE');
    }
  });

  test('fails with WORKFLOW_NOT_FOUND for deleted workflows', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...deletedWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        {
          _id: 'ver-1',
          workflowId: 'wf-3',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-3', triggerId: 'trg-webhook-3' },
      ctx,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('WORKFLOW_NOT_FOUND');
    }
  });

  test('fails with WORKFLOW_NOT_FOUND for non-existent workflow', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([]),
      workflowVersionsRepo: createVersionsRepo([]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-nonexistent', triggerId: 'trg-1' },
      ctx,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('WORKFLOW_NOT_FOUND');
    }
  });

  test('fails with INVALID_TOOL_BINDING for non-webhook trigger', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', triggerId: 'trg-cron' },
      ctx,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('cron');
    }
  });

  test('version check respects tenantId scope', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: 'different-tenant',
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([
        {
          ...activeWorkflow,
          _id: 'wf-scoped',
          status: 'paused',
          tenantId: 'different-tenant',
        } as WorkflowDoc & { tenantId: string; projectId: string },
      ]),
      workflowVersionsRepo: createVersionsRepo([
        // Active version belongs to TENANT_ID, not different-tenant
        {
          _id: 'ver-1',
          workflowId: 'wf-scoped',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-scoped', triggerId: 'trg-webhook' },
      ctx,
    );
    // Should fail because the active version has a different tenantId
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('WORKFLOW_INACTIVE');
    }
  });

  test('accepts a selected active workflowVersionId for a global webhook trigger', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        {
          _id: 'ver-selected',
          workflowId: 'wf-1',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
      ]),
      triggerRegistrationsRepo: createTriggerRegistrationsRepo([
        {
          _id: 'trg-webhook',
          workflowId: 'wf-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          triggerType: 'webhook',
          status: 'active',
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', workflowVersionId: 'ver-selected', triggerId: 'trg-webhook' },
      ctx,
    );
    expect(result.valid).toBe(true);
  });

  test('accepts a selected active workflowVersion semver pin for a global webhook trigger', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        {
          _id: 'ver-selected',
          workflowId: 'wf-1',
          version: 'v2.1.0',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
      ]),
      triggerRegistrationsRepo: createTriggerRegistrationsRepo([
        {
          _id: 'trg-webhook',
          workflowId: 'wf-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          triggerType: 'webhook',
          status: 'active',
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', workflowVersion: 'v2.1.0', triggerId: 'trg-webhook' },
      ctx,
    );
    expect(result.valid).toBe(true);
  });

  test('rejects a workflowVersion semver pin that does not exist', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([]),
      triggerRegistrationsRepo: createTriggerRegistrationsRepo([
        {
          _id: 'trg-webhook',
          workflowId: 'wf-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          triggerType: 'webhook',
          status: 'active',
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', workflowVersion: 'v9.9.9', triggerId: 'trg-webhook' },
      ctx,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('v9.9.9');
    }
  });

  test('rejects a version-first webhook trigger with user_level auth', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      triggerRegistrationsRepo: createTriggerRegistrationsRepo([
        {
          _id: 'trg-webhook',
          workflowId: 'wf-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          triggerType: 'webhook',
          status: 'active',
          config: {
            auth: {
              type: 'user_level',
            },
          },
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', triggerId: 'trg-webhook' },
      ctx,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('user_level');
    }
  });

  test('rejects a selected workflowVersionId that conflicts with the trigger pin', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        {
          _id: 'ver-selected',
          workflowId: 'wf-1',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
        {
          _id: 'ver-trigger',
          workflowId: 'wf-1',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
      ]),
      triggerRegistrationsRepo: createTriggerRegistrationsRepo([
        {
          _id: 'trg-webhook',
          workflowId: 'wf-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowVersionId: 'ver-trigger',
          triggerType: 'webhook',
          status: 'active',
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', workflowVersionId: 'ver-selected', triggerId: 'trg-webhook' },
      ctx,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('does not match');
    }
  });

  test('rejects a selected workflowVersion semver pin that conflicts with the trigger pin', async () => {
    const ctx: ValidateWorkflowBindingContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowsRepo: createWorkflowsRepo([{ ...activeWorkflow }]),
      workflowVersionsRepo: createVersionsRepo([
        {
          _id: 'ver-selected',
          workflowId: 'wf-1',
          version: 'v2.1.0',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
        {
          _id: 'ver-trigger',
          workflowId: 'wf-1',
          version: 'v2.0.0',
          state: 'active',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
        },
      ]),
      triggerRegistrationsRepo: createTriggerRegistrationsRepo([
        {
          _id: 'trg-webhook',
          workflowId: 'wf-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowVersionId: 'ver-trigger',
          triggerType: 'webhook',
          status: 'active',
        },
      ]),
    };

    const result = await validateWorkflowToolBinding(
      { workflowId: 'wf-1', workflowVersion: 'v2.1.0', triggerId: 'trg-webhook' },
      ctx,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_TOOL_BINDING');
      expect(result.error.message).toContain('does not match');
    }
  });
});
