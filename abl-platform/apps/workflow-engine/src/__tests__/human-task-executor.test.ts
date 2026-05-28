import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildHumanTaskRequest,
  buildTimeoutResponse,
  type HumanTaskStep,
} from '../executors/human-task-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-777', amount: 2500 },
  },
  workflow: { id: 'wf-1', name: 'human-task-flow', executionId: 'exec-42' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {
    lookup: {
      output: {
        reviewers: [
          { label: 'Alice', value: 'alice' },
          { label: 'Bob', value: 'bob' },
        ],
        priorities: ['low', 'medium', 'high'],
      },
    },
  },
  vars: { managerGroup: 'finance-managers' },
};

describe('buildHumanTaskRequest', () => {
  it('resolves expressions in title, description, and assignTo', () => {
    const step: HumanTaskStep = {
      id: 'ht-1',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve order {{trigger.payload.orderId}}',
      description: 'Amount: ${{trigger.payload.amount}}',
      assignTo: ['user-alice', '{{context.vars.managerGroup}}'],
    };

    const req = buildHumanTaskRequest(step, ctx);

    expect(req.taskId).toBe('exec-42:ht-1');
    expect(req.executionId).toBe('exec-42');
    expect(req.stepId).toBe('ht-1');
    expect(req.taskType).toBe('approval');
    expect(req.title).toBe('Approve order ORD-777');
    expect(req.description).toBe('Amount: $2500');
    expect(req.assignTo).toEqual(['user-alice', 'finance-managers']);
    expect(req.tenantId).toBe('t1');
    expect(req.projectId).toBe('p1');
  });

  it('defaults priority to medium when not provided', () => {
    const step: HumanTaskStep = {
      id: 'ht-2',
      type: 'human_task',
      taskType: 'review',
      title: 'Review',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.priority).toBe('medium');
  });

  it('passes explicit priority through unchanged', () => {
    const step: HumanTaskStep = {
      id: 'ht-3',
      type: 'human_task',
      taskType: 'decision',
      title: 'Decide',
      priority: 'critical',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.priority).toBe('critical');
  });

  it('wraps a single-string assignTo into an array', () => {
    const step = {
      id: 'ht-4',
      type: 'human_task',
      taskType: 'approval',
      title: 'Sign off',
      // Force the single-string branch (buildHumanTaskRequest accepts both,
      // even though HumanTaskStep types assignTo as string[])
      assignTo: 'alice' as unknown as string[],
    } as HumanTaskStep;

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.assignTo).toEqual(['alice']);
  });

  it('treats undefined assignTo as an empty array', () => {
    const step: HumanTaskStep = {
      id: 'ht-5',
      type: 'human_task',
      taskType: 'approval',
      title: 'Review',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.assignTo).toEqual([]);
  });

  it('passes timeoutMs through when set', () => {
    const step: HumanTaskStep = {
      id: 'ht-6',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
      timeout: 900_000,
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.timeoutMs).toBe(900_000);
  });

  it('leaves timeoutMs and onTimeout undefined when timeout is not set', () => {
    const step: HumanTaskStep = {
      id: 'ht-7',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.timeoutMs).toBeUndefined();
    expect(req.onTimeout).toBeUndefined();
  });

  it('defaults onTimeout to expire when timeout is set', () => {
    const step: HumanTaskStep = {
      id: 'ht-8',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
      timeout: 60_000,
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.onTimeout).toBe('expire');
  });

  it('preserves explicit onTimeout when timeout is set', () => {
    const step: HumanTaskStep = {
      id: 'ht-9',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
      timeout: 60_000,
      onTimeout: 'escalate',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.onTimeout).toBe('escalate');
  });

  it('returns an empty description when step.description is absent', () => {
    const step: HumanTaskStep = {
      id: 'ht-10',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.description).toBe('');
  });

  it('returns an empty fields array when step.fields is undefined', () => {
    const step: HumanTaskStep = {
      id: 'ht-11',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.fields).toEqual([]);
  });

  it('passes non-select fields through unchanged', () => {
    const step: HumanTaskStep = {
      id: 'ht-12',
      type: 'human_task',
      taskType: 'data_entry',
      title: 'Collect',
      fields: [
        { name: 'amount', type: 'number', label: 'Amount', required: true },
        { name: 'notes', type: 'textarea', label: 'Notes', required: false },
      ],
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.fields).toEqual([
      { name: 'amount', type: 'number', label: 'Amount', required: true },
      { name: 'notes', type: 'textarea', label: 'Notes', required: false },
    ]);
  });

  it('resolves optionsExpression that returns SelectOption objects', () => {
    const step: HumanTaskStep = {
      id: 'ht-13',
      type: 'human_task',
      taskType: 'data_entry',
      title: 'Pick reviewer',
      fields: [
        {
          name: 'reviewer',
          type: 'select',
          label: 'Reviewer',
          required: true,
          optionsExpression: '{{steps.lookup.output.reviewers}}',
        },
      ],
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.fields[0].options).toEqual([
      { label: 'Alice', value: 'alice' },
      { label: 'Bob', value: 'bob' },
    ]);
    // optionsExpression gets cleared once resolved
    expect(req.fields[0].optionsExpression).toBeUndefined();
  });

  it('coerces non-object array entries from optionsExpression to strings', () => {
    const step: HumanTaskStep = {
      id: 'ht-14',
      type: 'human_task',
      taskType: 'data_entry',
      title: 'Pick priority',
      fields: [
        {
          name: 'priority',
          type: 'select',
          label: 'Priority',
          required: true,
          optionsExpression: '{{steps.lookup.output.priorities}}',
        },
      ],
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.fields[0].options).toEqual(['low', 'medium', 'high']);
  });

  it('returns empty options when optionsExpression resolves to a non-array', () => {
    const step: HumanTaskStep = {
      id: 'ht-15',
      type: 'human_task',
      taskType: 'data_entry',
      title: 'Pick',
      fields: [
        {
          name: 'x',
          type: 'select',
          label: 'X',
          required: false,
          optionsExpression: '{{trigger.payload.orderId}}', // resolves to a string, not an array
        },
      ],
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.fields[0].options).toEqual([]);
  });

  it('leaves static select options alone when no optionsExpression is present', () => {
    const staticOpts = [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ];
    const step: HumanTaskStep = {
      id: 'ht-16',
      type: 'human_task',
      taskType: 'approval',
      title: 'Confirm',
      fields: [
        {
          name: 'confirm',
          type: 'select',
          label: 'Confirm',
          required: true,
          options: staticOpts,
        },
      ],
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.fields[0].options).toEqual(staticOpts);
  });

  it('includes workflow name, id, and variables in context', () => {
    const step: HumanTaskStep = {
      id: 'ht-17',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
    };

    const req = buildHumanTaskRequest(step, ctx);
    expect(req.context).toEqual({
      workflowName: 'human-task-flow',
      workflowId: 'wf-1',
      variables: { vars: { managerGroup: 'finance-managers' } },
    });
  });
});

describe('buildTimeoutResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to an "expired" response when onTimeout is not set', () => {
    const step: HumanTaskStep = {
      id: 'ht-t1',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
    };

    const resp = buildTimeoutResponse(step);

    expect(resp.respondedBy).toBe('system:timeout');
    expect(resp.respondedAt).toBe('2026-04-15T09:00:00.000Z');
    expect(resp.fields).toEqual({});
    expect(resp.decision).toBe('expired');
    expect(resp.notes).toContain('auto-expire');
  });

  it('returns decision "completed" for onTimeout auto_complete', () => {
    const step: HumanTaskStep = {
      id: 'ht-t2',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
      onTimeout: 'auto_complete',
    };

    const resp = buildTimeoutResponse(step);
    expect(resp.decision).toBe('completed');
    expect(resp.notes).toContain('auto-auto_complete');
  });

  it('returns decision "skipped" for onTimeout skip', () => {
    const step: HumanTaskStep = {
      id: 'ht-t3',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
      onTimeout: 'skip',
    };

    const resp = buildTimeoutResponse(step);
    expect(resp.decision).toBe('skipped');
    expect(resp.notes).toContain('auto-skip');
  });

  it('returns decision "expired" for onTimeout escalate', () => {
    const step: HumanTaskStep = {
      id: 'ht-t4',
      type: 'human_task',
      taskType: 'approval',
      title: 'Approve',
      onTimeout: 'escalate',
    };

    const resp = buildTimeoutResponse(step);
    expect(resp.decision).toBe('expired');
    expect(resp.notes).toContain('auto-escalate');
  });
});
