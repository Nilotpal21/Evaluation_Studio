import { describe, expect, it } from 'vitest';
import {
  ARCH_MUTATING_ACTIONS,
  buildArchMutationIntent,
  checkArchMutationAllowed,
  checkToolPermission,
  isArchMutationAction,
  type ToolPermissionContext,
} from '@/lib/arch-ai/guards';

const BASE_CONTEXT: ToolPermissionContext = {
  projectId: 'project-1',
  sessionId: 'session-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['agent:read', 'agent:update', 'agent:delete'],
  },
};

describe('Arch mutation guard', () => {
  it('classifies proposal-covered write actions centrally', () => {
    expect(isArchMutationAction('agent_ops', 'create')).toBe(true);
    expect(isArchMutationAction('agent_ops', 'modify')).toBe(true);
    expect(isArchMutationAction('agent_ops', 'delete')).toBe(true);
    expect(isArchMutationAction('agent_ops', 'read')).toBe(false);
    expect(isArchMutationAction('tools_ops', 'update')).toBe(true);
    expect(isArchMutationAction('project_config', 'update_settings')).toBe(true);
    expect(isArchMutationAction('manage_memory', 'add')).toBe(true);
    expect(isArchMutationAction('testing_ops', 'list_evals')).toBe(false);
  });

  it('tracks the expected high-risk tool families in the inventory', () => {
    expect(Object.keys(ARCH_MUTATING_ACTIONS)).toEqual(
      expect.arrayContaining([
        'agent_ops',
        'tools_ops',
        'project_config',
        'manage_memory',
        'integration_ops',
        'connection_ops',
        'variable_ops',
        'testing_ops',
        'configure_model',
      ]),
    );
  });

  it('allows mutations while plan enforcement is not enabled', () => {
    const result = checkArchMutationAllowed(
      {
        sourceTool: 'agent_ops',
        sourceAction: 'modify',
        targetKind: 'agent_dsl',
        operation: 'modify',
        agentName: 'LeadIntake',
      },
      BASE_CONTEXT,
    );

    expect(result.allowed).toBe(true);
  });

  it('blocks mutation actions when enforcement is enabled without an approved plan', () => {
    const result = checkArchMutationAllowed(
      {
        sourceTool: 'agent_ops',
        sourceAction: 'modify',
        targetKind: 'agent_dsl',
        operation: 'modify',
        agentName: 'LeadIntake',
      },
      {
        ...BASE_CONTEXT,
        requireApprovedPlanForMutation: true,
      },
    );

    expect(result).toEqual({
      allowed: false,
      error: {
        code: 'PLAN_REQUIRED',
        message: 'Plan required before mutation. Call propose_plan first.',
      },
    });
  });

  it('allows mutation actions when enforcement has an approved plan', () => {
    const result = checkArchMutationAllowed(
      {
        sourceTool: 'agent_ops',
        sourceAction: 'modify',
        targetKind: 'agent_dsl',
        operation: 'modify',
        agentName: 'LeadIntake',
      },
      {
        ...BASE_CONTEXT,
        requireApprovedPlanForMutation: true,
        approvedPlan: {
          id: 'plan-1',
          projectId: 'project-1',
          status: 'approved',
          plannedMutations: [
            {
              sourceTool: 'agent_ops',
              sourceAction: 'modify',
              targetKind: 'agent_dsl',
              operation: 'modify',
              agentName: 'LeadIntake',
            },
          ],
        },
      },
    );

    expect(result.allowed).toBe(true);
  });

  it('blocks mutation actions that are outside the approved plan scope', () => {
    const result = checkArchMutationAllowed(
      {
        sourceTool: 'agent_ops',
        sourceAction: 'delete',
        targetKind: 'agent_dsl',
        operation: 'delete',
        agentName: 'BillingAgent',
      },
      {
        ...BASE_CONTEXT,
        requireApprovedPlanForMutation: true,
        approvedPlan: {
          id: 'plan-1',
          projectId: 'project-1',
          status: 'approved',
          plannedMutations: [
            {
              sourceTool: 'agent_ops',
              sourceAction: 'modify',
              targetKind: 'agent_dsl',
              operation: 'modify',
              agentName: 'LeadIntake',
            },
          ],
        },
      },
    );

    expect(result).toEqual({
      allowed: false,
      error: {
        code: 'PLAN_SCOPE_MISMATCH',
        message:
          'Approved plan does not cover this mutation. Call propose_plan with the correct scope first.',
      },
    });
  });

  it('blocks agent-scoped mutations when the approved plan omits the agent name', () => {
    const result = checkArchMutationAllowed(
      {
        sourceTool: 'agent_ops',
        sourceAction: 'modify',
        targetKind: 'agent_dsl',
        operation: 'modify',
        agentName: 'LeadIntake',
      },
      {
        ...BASE_CONTEXT,
        requireApprovedPlanForMutation: true,
        approvedPlan: {
          id: 'plan-1',
          projectId: 'project-1',
          status: 'approved',
          plannedMutations: [
            {
              sourceTool: 'agent_ops',
              sourceAction: 'modify',
              targetKind: 'agent_dsl',
              operation: 'modify',
            },
          ],
        },
      },
    );

    expect(result).toMatchObject({
      allowed: false,
      error: { code: 'PLAN_SCOPE_MISMATCH' },
    });
  });

  it('blocks approved plans from another project', () => {
    const result = checkArchMutationAllowed(
      {
        sourceTool: 'agent_ops',
        sourceAction: 'modify',
        targetKind: 'agent_dsl',
        operation: 'modify',
        agentName: 'LeadIntake',
      },
      {
        ...BASE_CONTEXT,
        requireApprovedPlanForMutation: true,
        approvedPlan: {
          id: 'plan-1',
          projectId: 'project-2',
          status: 'approved',
          plannedMutations: [
            {
              sourceTool: 'agent_ops',
              sourceAction: 'modify',
              targetKind: 'agent_dsl',
              operation: 'modify',
              agentName: 'LeadIntake',
            },
          ],
        },
      },
    );

    expect(result).toMatchObject({
      allowed: false,
      error: { code: 'PLAN_SCOPE_MISMATCH' },
    });
  });

  it('builds a generic mutation intent for centrally guarded tools', () => {
    expect(buildArchMutationIntent('tools_ops', 'update')).toEqual({
      sourceTool: 'tools_ops',
      sourceAction: 'update',
      targetKind: 'tool_binding',
      operation: 'modify',
    });
    expect(buildArchMutationIntent('tools_ops', 'list')).toBeNull();
  });

  it('enforces the mutation guard inside the shared permission gate', async () => {
    await expect(
      checkToolPermission('tools_ops', 'update', {
        ...BASE_CONTEXT,
        requireApprovedPlanForMutation: true,
        user: {
          ...BASE_CONTEXT.user,
          permissions: ['tool:write'],
        },
      }),
    ).resolves.toEqual({
      allowed: false,
      code: 'PLAN_REQUIRED',
      error: 'Plan required before mutation. Call propose_plan first.',
    });
  });
});
