import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildApprovalRequest,
  buildTimeoutDecision,
  type ApprovalStep,
} from '../executors/approval-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-123', amount: 5000 },
  },
  workflow: { id: 'wf-1', name: 'approval-flow', executionId: 'exec-99' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {},
  vars: { managerGroup: 'finance-managers' },
};

describe('buildApprovalRequest', () => {
  it('builds approval request with resolved message and approvers', () => {
    const step: ApprovalStep = {
      id: 'approval-1',
      type: 'approval',
      message: 'Approve order {{trigger.payload.orderId}} for ${{trigger.payload.amount}}',
      approvers: ['user-alice', '{{context.vars.managerGroup}}'],
    };

    const request = buildApprovalRequest(step, ctx);

    expect(request.approvalId).toBe('exec-99:approval-1');
    expect(request.executionId).toBe('exec-99');
    expect(request.stepId).toBe('approval-1');
    expect(request.message).toBe('Approve order ORD-123 for $5000');
    expect(request.approvers).toEqual(['user-alice', 'finance-managers']);
    expect(request.tenantId).toBe('t1');
    expect(request.projectId).toBe('p1');
  });

  it('has no timeout when not configured', () => {
    const step: ApprovalStep = {
      id: 'approval-2',
      type: 'approval',
      message: 'Approve this',
      approvers: ['admin'],
    };

    const request = buildApprovalRequest(step, ctx);
    expect(request.timeoutMs).toBeUndefined();
  });

  it('uses custom timeout when specified', () => {
    const step: ApprovalStep = {
      id: 'approval-3',
      type: 'approval',
      message: 'Quick approval needed',
      approvers: ['admin'],
      timeout: 3_600_000,
    };

    const request = buildApprovalRequest(step, ctx);
    expect(request.timeoutMs).toBe(3_600_000);
  });

  it('has no onTimeout when timeout not configured', () => {
    const step: ApprovalStep = {
      id: 'approval-4',
      type: 'approval',
      message: 'Approve',
      approvers: ['admin'],
    };

    const request = buildApprovalRequest(step, ctx);
    expect(request.onTimeout).toBeUndefined();
  });

  it('defaults onTimeout to reject when timeout is set', () => {
    const step: ApprovalStep = {
      id: 'approval-4b',
      type: 'approval',
      message: 'Approve',
      approvers: ['admin'],
      timeout: 3_600_000,
    };

    const request = buildApprovalRequest(step, ctx);
    expect(request.onTimeout).toBe('reject');
  });

  it('uses specified onTimeout action when timeout is set', () => {
    const step: ApprovalStep = {
      id: 'approval-5',
      type: 'approval',
      message: 'Approve',
      approvers: ['admin'],
      timeout: 3_600_000,
      onTimeout: 'escalate',
    };

    const request = buildApprovalRequest(step, ctx);
    expect(request.onTimeout).toBe('escalate');
  });
});

describe('buildTimeoutDecision', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates reject decision by default', () => {
    const step: ApprovalStep = {
      id: 'approval-6',
      type: 'approval',
      message: 'Approve',
      approvers: ['admin'],
    };

    const decision = buildTimeoutDecision(step);

    expect(decision.approved).toBe(false);
    expect(decision.decidedBy).toBe('system:timeout');
    expect(decision.reason).toContain('auto-reject');
    expect(decision.decidedAt).toBe('2026-02-28T12:00:00.000Z');
  });

  it('creates approve decision when onTimeout is approve', () => {
    const step: ApprovalStep = {
      id: 'approval-7',
      type: 'approval',
      message: 'Approve',
      approvers: ['admin'],
      onTimeout: 'approve',
    };

    const decision = buildTimeoutDecision(step);

    expect(decision.approved).toBe(true);
    expect(decision.reason).toContain('auto-approve');
  });

  it('creates reject decision when onTimeout is escalate', () => {
    const step: ApprovalStep = {
      id: 'approval-8',
      type: 'approval',
      message: 'Approve',
      approvers: ['admin'],
      onTimeout: 'escalate',
    };

    const decision = buildTimeoutDecision(step);

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('auto-escalate');
  });
});
