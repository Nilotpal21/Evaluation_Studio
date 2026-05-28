import { describe, it, expect, vi } from 'vitest';
import {
  dispatchStep,
  resolveStepInput,
  type StepDispatcherDeps,
} from '../handlers/step-dispatcher.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';
import type { ConnectorActionStep } from '../executors/connector-action-executor.js';
import type { HttpStep } from '../executors/http-executor.js';
import type { ToolCallStep } from '../executors/tool-call-executor.js';
import type { AgentInvocationStep } from '../executors/agent-invocation-executor.js';
import type { ConditionStep } from '../executors/condition-executor.js';
import type { DelayStep } from '../executors/delay-executor.js';
import type { ParallelStep } from '../executors/parallel-executor.js';
import type { AsyncWebhookStep } from '../executors/async-webhook-executor.js';
import type { ApprovalStep } from '../executors/approval-executor.js';
import type { FunctionStep } from '../executors/function-executor.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-1' },
  },
  workflow: { id: 'wf-1', name: 'test-flow', executionId: 'exec-1' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {},
  vars: {},
};

describe('dispatchStep', () => {
  it('dispatches condition step and returns nextSteps', async () => {
    const step: ConditionStep = {
      id: 'c1',
      type: 'condition',
      expression: '{{trigger.payload.orderId}}',
      thenSteps: ['a', 'b'],
      elseSteps: ['c'],
    };

    const result = await dispatchStep(step, ctx, {});
    expect(result.type).toBe('condition');
    expect(result.nextSteps).toEqual(['a', 'b']);
    expect(result.output).toEqual(expect.objectContaining({ conditionMet: true }));
  });

  it('dispatches delay step and returns delayMs', async () => {
    const step: DelayStep = {
      id: 'd1',
      type: 'delay',
      duration: 'PT30S',
    };

    const result = await dispatchStep(step, ctx, {});
    expect(result.type).toBe('delay');
    expect(result.delayMs).toBe(30_000);
  });

  it('dispatches tool_call step', async () => {
    const step: ToolCallStep = {
      id: 't1',
      type: 'tool_call',
      toolName: 'test_tool',
      params: {},
    };

    const deps: StepDispatcherDeps = {
      toolClient: {
        executeTool: vi.fn().mockResolvedValue({
          success: true,
          status: 'completed',
          output: { ok: 1 },
        }),
      },
    };

    const result = await dispatchStep(step, ctx, deps);
    expect(result.type).toBe('tool_call');
    expect(result.output).toEqual({ ok: 1 });
  });

  it('returns a tool callback wait request when executionMode is async_wait', async () => {
    const step: ToolCallStep = {
      id: 't-wait',
      type: 'tool_call',
      toolName: 'child_workflow',
      params: { orderId: '{{trigger.payload.orderId}}' },
      executionMode: 'async_wait',
    };

    const deps: StepDispatcherDeps = {
      toolClient: {
        executeTool: vi.fn(),
      },
      callbackUrlBuilder: {
        buildCallbackUrl: (execId, stepId) => `https://platform.example.com/cb/${execId}/${stepId}`,
      },
    };

    const result = await dispatchStep(step, ctx, deps);
    expect(result.type).toBe('tool_call');
    expect(result.output).toBeNull();
    expect(result.toolRequest).toEqual({
      toolName: 'child_workflow',
      params: { orderId: 'ORD-1' },
      callbackUrl: 'https://platform.example.com/cb/exec-1/t-wait',
      executionMode: 'async_wait',
    });
  });

  it('accepts async_continue tool responses with accepted status', async () => {
    const step: ToolCallStep = {
      id: 't-continue',
      type: 'tool_call',
      toolName: 'async_http_tool',
      params: {},
      executionMode: 'async_continue',
    };

    const deps: StepDispatcherDeps = {
      toolClient: {
        executeTool: vi.fn().mockResolvedValue({
          success: true,
          status: 'accepted',
          output: { requestId: 'req-1' },
        }),
      },
    };

    const result = await dispatchStep(step, ctx, deps);
    expect(result.type).toBe('tool_call');
    expect(result.output).toEqual({ requestId: 'req-1' });
  });

  it('dispatches agent_invocation step', async () => {
    const step: AgentInvocationStep = {
      id: 'a1',
      type: 'agent_invocation',
      agentId: 'test-agent',
      message: 'Hello',
    };

    const deps: StepDispatcherDeps = {
      runtimeClient: {
        sendMessage: vi.fn().mockResolvedValue({
          sessionId: 'sess-1',
          agentResponse: 'Hi',
        }),
      },
    };

    const result = await dispatchStep(step, ctx, deps);
    expect(result.type).toBe('agent_invocation');
    expect(result.output).toEqual({ sessionId: 'sess-1', agentResponse: 'Hi' });
  });

  it('dispatches async_webhook step and returns webhook request', async () => {
    const step: AsyncWebhookStep = {
      id: 'w1',
      type: 'async_webhook',
      url: 'https://example.com/hook',
    };

    const deps: StepDispatcherDeps = {
      callbackUrlBuilder: {
        buildCallbackUrl: (execId, stepId) => `https://platform.example.com/cb/${execId}/${stepId}`,
      },
    };

    const result = await dispatchStep(step, ctx, deps);
    expect(result.type).toBe('async_webhook');
    expect(result.webhookRequest).toBeDefined();
  });

  it('dispatches approval step and returns approval request', async () => {
    const step: ApprovalStep = {
      id: 'ap1',
      type: 'approval',
      message: 'Approve order {{trigger.payload.orderId}}',
      approvers: ['admin'],
    };

    const result = await dispatchStep(step, ctx, {});
    expect(result.type).toBe('approval');
    expect(result.approvalRequest).toBeDefined();
  });

  it('dispatches parallel step with branch runner', async () => {
    const step: ParallelStep = {
      id: 'p1',
      type: 'parallel',
      branches: [
        { name: 'b1', steps: ['s1'] },
        { name: 'b2', steps: ['s2'] },
      ],
      failureStrategy: 'wait_all',
    };

    const deps: StepDispatcherDeps = {
      branchRunner: vi.fn().mockResolvedValue({ done: true }),
    };

    const result = await dispatchStep(step, ctx, deps);
    expect(result.type).toBe('parallel');
  });

  it('throws when tool_call deps are missing', async () => {
    const step: ToolCallStep = {
      id: 't2',
      type: 'tool_call',
      toolName: 'missing',
      params: {},
    };

    await expect(dispatchStep(step, ctx, {})).rejects.toThrow('ToolExecutionClient not configured');
  });

  it('throws when agent_invocation deps are missing', async () => {
    const step: AgentInvocationStep = {
      id: 'a2',
      type: 'agent_invocation',
      agentId: 'missing',
      message: 'Hello',
    };

    await expect(dispatchStep(step, ctx, {})).rejects.toThrow('RuntimeClient not configured');
  });

  // UT-16: function step dispatches to FunctionExecutor (context API)
  it('dispatches function step and returns output with consoleLogs', async () => {
    const step: FunctionStep = {
      id: 'fn-1',
      type: 'function',
      config: {
        code: 'console.log("hi"); context.value = 99;',
        timeout: 5,
      },
    };

    const result = await dispatchStep(step, ctx, {});
    expect(result.type).toBe('function');
    expect(result.output).toEqual({ value: 99 });
    expect(result.consoleLogs).toBeDefined();
    expect(result.consoleLogs).toEqual([{ level: 'log', args: ['hi'] }]);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('resolveStepInput', () => {
  // UT-17: resolveStepInput returns code snippet for function step
  it('returns code snippet for function step', () => {
    const step: FunctionStep = {
      id: 'fn-2',
      type: 'function',
      config: {
        code: 'context.result = context.trigger.payload;',
        timeout: 5,
      },
    };

    const input = resolveStepInput(step, ctx);
    expect(input).toBeDefined();
    expect(input!.code).toBe('context.result = context.trigger.payload;');
  });
});
