import { describe, it, expect } from 'vitest';
import {
  applySnapshot,
  mergeStepDelta,
  mergeExecutionDelta,
} from '../components/workflows/canvas/execution-merge';
import type {
  StepDeltaMsg,
  ExecutionDeltaMsg,
} from '../components/workflows/canvas/execution-merge';

// ── applySnapshot ─────────────────────────────────────────────────────────────

describe('applySnapshot', () => {
  const raw = {
    _id: 'exec-1',
    workflowId: 'wf-1',
    workflowVersionId: 'v-1',
    workflowVersion: 'draft',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    triggerType: 'studio',
    triggerMetadata: { userId: 'u1' },
    input: { prompt: 'hi' },
    context: { steps: { start: { status: 'completed' } } },
    durationMs: null,
    output: null,
    error: null,
  };

  it('maps _id to id', () => {
    const exec = applySnapshot(raw);
    expect(exec.id).toBe('exec-1');
  });

  it('prefers id field over _id when both present', () => {
    const exec = applySnapshot({ ...raw, id: 'exec-id-field' });
    expect(exec.id).toBe('exec-id-field');
  });

  it('maps all standard fields correctly', () => {
    const exec = applySnapshot(raw);
    expect(exec.workflowId).toBe('wf-1');
    expect(exec.workflowVersionId).toBe('v-1');
    expect(exec.workflowVersion).toBe('draft');
    expect(exec.projectId).toBe('proj-1');
    expect(exec.tenantId).toBe('tenant-1');
    expect(exec.status).toBe('running');
    expect(exec.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(exec.triggerType).toBe('studio');
    expect(exec.input).toEqual({ prompt: 'hi' });
  });

  it('defaults status to running when absent', () => {
    const exec = applySnapshot({ ...raw, status: undefined });
    expect(exec.status).toBe('running');
  });

  it('defaults triggerType to manual when absent', () => {
    const exec = applySnapshot({ ...raw, triggerType: undefined });
    expect(exec.triggerType).toBe('manual');
  });

  it('defaults startedAt to current time when absent', () => {
    const before = Date.now();
    const exec = applySnapshot({ ...raw, startedAt: undefined });
    const after = Date.now();
    const t = new Date(exec.startedAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('preserves context as-is', () => {
    const exec = applySnapshot(raw);
    expect(exec.context).toEqual({ steps: { start: { status: 'completed' } } });
  });

  it('does not include workflowName on the result', () => {
    const exec = applySnapshot({ ...raw, workflowName: 'My Workflow' } as Record<string, unknown>);
    expect('workflowName' in exec).toBe(false);
  });
});

// ── mergeStepDelta ────────────────────────────────────────────────────────────

describe('mergeStepDelta', () => {
  const base = applySnapshot({
    _id: 'exec-1',
    workflowId: 'wf-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    triggerType: 'studio',
    context: {
      steps: {
        start: { nodeType: 'start', status: 'completed', stepId: 'start' },
        Agent0001: { nodeType: 'agent_invocation', status: 'pending', stepId: 'agent-uuid' },
      },
    },
  });

  const delta: StepDeltaMsg = {
    type: 'workflow_step_status',
    executionId: 'exec-1',
    stepId: 'agent-uuid',
    stepName: 'Agent0001',
    stepType: 'agent_invocation',
    status: 'running',
    timestamp: '2026-01-01T00:00:01.000Z',
  };

  it('updates the step status by display name', () => {
    const updated = mergeStepDelta(base, delta);
    const steps = (updated.context as any).steps;
    expect(steps.Agent0001.status).toBe('running');
  });

  it('prefers existing stepId key over display name', () => {
    // 'start' is keyed by stepId in the snapshot
    const startDelta: StepDeltaMsg = {
      type: 'workflow_step_status',
      executionId: 'exec-1',
      stepId: 'start',
      stepName: 'Start',
      stepType: 'start',
      status: 'completed',
      timestamp: '2026-01-01T00:00:00.500Z',
    };
    const updated = mergeStepDelta(base, startDelta);
    const steps = (updated.context as any).steps;
    expect(steps.start.status).toBe('completed');
    expect(steps['Start']).toBeUndefined();
  });

  it('merges stepData into the existing step', () => {
    const withData: StepDeltaMsg = {
      ...delta,
      status: 'completed',
      stepData: { output: { reply: 'hello' }, durationMs: 500 },
    };
    const updated = mergeStepDelta(base, withData);
    const step = (updated.context as any).steps.Agent0001;
    expect(step.output).toEqual({ reply: 'hello' });
    expect(step.durationMs).toBe(500);
  });

  it('merges contextPatch vars from step deltas', () => {
    const withVars: StepDeltaMsg = {
      ...delta,
      contextPatch: {
        vars: {
          loopResults: [{ s: { variable: 'l' } }],
        },
      },
    };

    const updated = mergeStepDelta(base, withVars);
    const context = updated.context as any;
    expect(context.vars.loopResults).toEqual([{ s: { variable: 'l' } }]);
    expect(context.steps.Agent0001.status).toBe('running');
  });

  it('preserves existing step fields not in the delta', () => {
    const updated = mergeStepDelta(base, delta);
    const step = (updated.context as any).steps.Agent0001;
    expect(step.nodeType).toBe('agent_invocation');
    expect(step.stepId).toBe('agent-uuid');
  });

  it('does not mutate the original execution', () => {
    const original = JSON.stringify(base);
    mergeStepDelta(base, delta);
    expect(JSON.stringify(base)).toBe(original);
  });
});

// ── mergeExecutionDelta ───────────────────────────────────────────────────────

describe('mergeExecutionDelta', () => {
  const base = applySnapshot({
    _id: 'exec-1',
    workflowId: 'wf-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    triggerType: 'studio',
  });

  it('updates status', () => {
    const delta: ExecutionDeltaMsg = {
      type: 'workflow_execution_status',
      executionId: 'exec-1',
      status: 'completed',
      timestamp: '2026-01-01T00:01:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
    };
    const updated = mergeExecutionDelta(base, delta);
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('sets durationMs when provided', () => {
    const delta: ExecutionDeltaMsg = {
      type: 'workflow_execution_status',
      executionId: 'exec-1',
      status: 'completed',
      timestamp: '2026-01-01T00:01:00.000Z',
      durationMs: 60000,
    };
    const updated = mergeExecutionDelta(base, delta);
    expect(updated.durationMs).toBe(60000);
  });

  it('sets output when provided', () => {
    const delta: ExecutionDeltaMsg = {
      type: 'workflow_execution_status',
      executionId: 'exec-1',
      status: 'completed',
      timestamp: '2026-01-01T00:01:00.000Z',
      output: { result: 'ok' },
    };
    const updated = mergeExecutionDelta(base, delta);
    expect(updated.output).toEqual({ result: 'ok' });
  });

  it('wraps error string into error object', () => {
    const delta: ExecutionDeltaMsg = {
      type: 'workflow_execution_status',
      executionId: 'exec-1',
      status: 'failed',
      timestamp: '2026-01-01T00:00:30.000Z',
      error: 'Step timed out',
    };
    const updated = mergeExecutionDelta(base, delta);
    expect(updated.error).toEqual({ code: 'WORKFLOW_ERROR', message: 'Step timed out' });
  });

  it('does not overwrite completedAt when not in delta', () => {
    const withCompleted = { ...base, completedAt: '2026-01-01T00:01:00.000Z' };
    const delta: ExecutionDeltaMsg = {
      type: 'workflow_execution_status',
      executionId: 'exec-1',
      status: 'completed',
      timestamp: '2026-01-01T00:01:00.000Z',
    };
    const updated = mergeExecutionDelta(withCompleted, delta);
    expect(updated.completedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('does not mutate the original execution', () => {
    const original = JSON.stringify(base);
    const delta: ExecutionDeltaMsg = {
      type: 'workflow_execution_status',
      executionId: 'exec-1',
      status: 'completed',
      timestamp: '2026-01-01T00:01:00.000Z',
    };
    mergeExecutionDelta(base, delta);
    expect(JSON.stringify(base)).toBe(original);
  });
});
