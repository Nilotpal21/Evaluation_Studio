import { describe, it, expect } from 'vitest';
import {
  getFanOutContinuationOwner,
  type SuspendedContinuation,
  type ChannelBinding,
} from '../suspension.js';
import type { SuspensionReason, ResumeData, ExecutionStatus } from '../types.js';

describe('Suspension Types', () => {
  it('SuspensionReason covers all async boundary types', () => {
    const reasons: SuspensionReason[] = [
      {
        type: 'async_tool',
        toolName: 'payment',
        toolCallId: 'tc-1',
        callbackId: 'cb-1',
        timeout: 3600,
      },
      { type: 'human_approval', prompt: 'Approve?', callbackId: 'cb-2', timeout: 86400 },
      {
        type: 'human_input',
        prompt: 'Enter amount',
        fields: ['amount'],
        callbackId: 'cb-3',
        timeout: 3600,
      },
      {
        type: 'remote_handoff',
        target: 'agent_b',
        remoteTaskId: 'task-1',
        callbackId: 'cb-4',
        timeout: 30000,
      },
      {
        type: 'fan_out_branch',
        target: 'agent_c',
        barrierId: 'bar-1',
        callbackId: 'cb-5',
        timeout: 60000,
      },
      {
        type: 'fan_out_remote_branch',
        target: 'agent_d',
        barrierId: 'bar-2',
        branchId: 'branch-2',
        callbackId: 'cb-6',
        timeout: 60000,
      },
      {
        type: 'fan_out_parent_resume',
        barrierId: 'bar-3',
        callbackId: 'cb-7',
        timeout: 60000,
      },
      { type: 'a2a_push_notification', taskId: 'task-2', callbackId: 'cb-8', timeout: 3600 },
      { type: 'human_agent_transfer', target: 'support', callbackId: 'cb-9', timeout: 86400 },
      { type: 'escalation', humanTaskId: 'human-1', callbackId: 'cb-10' },
    ];
    expect(reasons).toHaveLength(10);
    const types = reasons.map((r) => r.type);
    expect(types).toContain('async_tool');
    expect(types).toContain('human_agent_transfer');
    expect(types).toContain('fan_out_remote_branch');
    expect(types).toContain('fan_out_parent_resume');
  });

  it('ExecutionStatus includes suspended and resuming', () => {
    const statuses: ExecutionStatus[] = [
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'preempted',
      'suspended',
      'resuming',
    ];
    expect(statuses).toHaveLength(8);
  });

  it('SuspendedContinuation covers all continuation types', () => {
    const continuations: SuspendedContinuation[] = [
      {
        type: 'tool_result',
        toolName: 'pay',
        toolCallId: 'tc-1',
        threadIndex: 0,
        conversationLength: 5,
      },
      {
        type: 'remote_handoff_result',
        targetAgent: 'a',
        remoteThreadIndex: 1,
        returnExpected: true,
        remoteTaskId: 't',
      },
      {
        type: 'fan_out_branch',
        barrierId: 'b-1',
        branchAgent: 'a',
        threadIndex: 2,
        parentExecutionId: 'e-1',
      },
      {
        type: 'fan_out_remote_branch',
        barrierId: 'b-2',
        branchId: 'branch-2',
        branchAgent: 'b',
        threadIndex: 3,
        parentExecutionId: 'e-2',
      },
      {
        type: 'fan_out_parent_resume',
        barrierId: 'b-3',
        parentThreadIndex: 0,
        parentExecutionId: 'e-3',
      },
      { type: 'human_input', prompt: 'Enter', threadIndex: 0 },
      { type: 'human_agent_transfer', routingKey: 'support:billing', threadIndex: 0 },
    ];
    expect(continuations).toHaveLength(7);
  });

  it('classifies hardened fan-out continuation ownership separately from legacy fan-out', () => {
    expect(
      getFanOutContinuationOwner({
        type: 'fan_out_remote_branch',
        barrierId: 'bar-1',
        branchId: 'branch-1',
        branchAgent: 'agent_a',
        threadIndex: 1,
        parentExecutionId: 'exec-1',
      }),
    ).toBe('remote_branch');
    expect(
      getFanOutContinuationOwner({
        type: 'fan_out_parent_resume',
        barrierId: 'bar-1',
        parentThreadIndex: 0,
        parentExecutionId: 'exec-1',
      }),
    ).toBe('parent_resume');
    expect(
      getFanOutContinuationOwner({
        type: 'fan_out_branch',
        barrierId: 'bar-legacy',
        branchAgent: 'agent_legacy',
        threadIndex: 2,
        parentExecutionId: 'exec-legacy',
      }),
    ).toBe('legacy');
  });

  it('ChannelBinding captures all delivery mechanisms', () => {
    const binding: ChannelBinding = {
      channelType: 'sdk_websocket',
      tenantId: 'tenant-1',
      wsConnectionId: 'ws-1',
      wsSessionId: 'session-1',
      connectionId: 'conn-1',
      pushNotificationConfig: { url: 'https://example.com/push', token: 'tok' },
      dbSessionId: 'db-1',
      callerContext: { userId: 'user-1' },
    };
    expect(binding.channelType).toBe('sdk_websocket');
    expect(binding.pushNotificationConfig?.url).toBe('https://example.com/push');
  });

  it('ResumeData has typed discriminant', () => {
    const data: ResumeData = {
      type: 'tool_result',
      callbackId: 'cb-1',
      payload: { result: 'success' },
      receivedAt: Date.now(),
    };
    expect(data.type).toBe('tool_result');
    expect(data.callbackId).toBe('cb-1');
  });
});
