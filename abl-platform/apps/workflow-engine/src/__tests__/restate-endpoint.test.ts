/**
 * Restate endpoint handlers — unit tests
 *
 * `buildRestateEndpoint` wires the workflow-runner service into the Restate
 * SDK. The full endpoint can only be tested against a live Restate runtime,
 * so we extract the shared-handler bodies (cancel, resolveCallback,
 * resolveApproval, resolveHumanTask) as pure exported functions and test
 * them directly with a fake Restate context.
 *
 * The `run` handler is covered end-to-end by the workflow-handler and e2e
 * test suites — not duplicated here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildRestateEndpoint,
  handleCancel,
  handleResolveApproval,
  handleResolveCallback,
  handleResolveHumanTask,
  WORKFLOW_SERVICE_NAME,
  type RestateEndpointDeps,
  type SharedCtxLike,
} from '../services/restate-endpoint.js';

// Records every promise key the handler resolves so tests can assert the
// exact Restate durable-promise name used for each resolution shape.
function makeCtx(key: string): SharedCtxLike & {
  resolved: Array<{ name: string; value: unknown }>;
} {
  const resolved: Array<{ name: string; value: unknown }> = [];
  return {
    key,
    resolved,
    promise<T>(name: string) {
      return {
        resolve: vi.fn(async (value: T) => {
          resolved.push({ name, value });
        }),
      };
    },
  };
}

describe('WORKFLOW_SERVICE_NAME', () => {
  it('is the stable "workflow-runner" identifier the ingress URLs depend on', () => {
    // Guards against accidental rename — restate-client builds URLs like
    // /workflow-runner/{executionId}/run/send from this constant.
    expect(WORKFLOW_SERVICE_NAME).toBe('workflow-runner');
  });
});

describe('handleCancel', () => {
  it('resolves the sys:cancel durable promise with true and returns the execution id', async () => {
    const ctx = makeCtx('exec-1');

    const result = await handleCancel(ctx);

    expect(result).toEqual({ cancelled: true, executionId: 'exec-1' });
    expect(ctx.resolved).toEqual([{ name: 'sys:cancel', value: true }]);
  });
});

describe('handleResolveCallback', () => {
  it('resolves sys:callback:<stepId> with the payload and echoes execution + step ids', async () => {
    const ctx = makeCtx('exec-2');

    const result = await handleResolveCallback(ctx, {
      executionId: 'exec-2',
      stepId: 'async-webhook-1',
      payload: { orderId: 'ORD-7', status: 'shipped' },
    });

    expect(result).toEqual({
      resolved: true,
      executionId: 'exec-2',
      stepId: 'async-webhook-1',
    });
    expect(ctx.resolved).toEqual([
      {
        name: 'sys:callback:async-webhook-1',
        value: { orderId: 'ORD-7', status: 'shipped' },
      },
    ]);
  });

  it('forwards null/undefined payloads verbatim (does not coerce)', async () => {
    const ctx = makeCtx('exec-3');
    await handleResolveCallback(ctx, {
      executionId: 'exec-3',
      stepId: 'cb-null',
      payload: null,
    });
    expect(ctx.resolved[0]).toEqual({ name: 'sys:callback:cb-null', value: null });
  });
});

describe('handleResolveApproval', () => {
  it('resolves sys:approval:<stepId> with the decision payload', async () => {
    const ctx = makeCtx('exec-4');

    const result = await handleResolveApproval(ctx, {
      executionId: 'exec-4',
      stepId: 'approve-1',
      decision: { approved: true, decidedBy: 'alice', reason: 'LGTM' },
    });

    expect(result).toEqual({
      resolved: true,
      executionId: 'exec-4',
      stepId: 'approve-1',
    });
    expect(ctx.resolved).toEqual([
      {
        name: 'sys:approval:approve-1',
        value: { approved: true, decidedBy: 'alice', reason: 'LGTM' },
      },
    ]);
  });

  it('carries rejection decisions through unchanged', async () => {
    const ctx = makeCtx('exec-5');
    await handleResolveApproval(ctx, {
      executionId: 'exec-5',
      stepId: 'approve-2',
      decision: { approved: false, decidedBy: 'bob', reason: 'budget' },
    });
    expect(ctx.resolved[0].value).toEqual({
      approved: false,
      decidedBy: 'bob',
      reason: 'budget',
    });
  });
});

describe('handleResolveHumanTask', () => {
  it('resolves sys:human_task:<stepId> with the response envelope', async () => {
    const ctx = makeCtx('exec-6');

    const result = await handleResolveHumanTask(ctx, {
      executionId: 'exec-6',
      stepId: 'ht-1',
      response: {
        respondedBy: 'carol',
        fields: { note: 'ok' },
        decision: 'approved',
      },
    });

    expect(result).toEqual({
      resolved: true,
      executionId: 'exec-6',
      stepId: 'ht-1',
    });
    expect(ctx.resolved).toEqual([
      {
        name: 'sys:human_task:ht-1',
        value: {
          respondedBy: 'carol',
          fields: { note: 'ok' },
          decision: 'approved',
        },
      },
    ]);
  });
});

describe('promise-key uniqueness across handlers', () => {
  // Regression guard: each shared handler must resolve a distinct durable
  // promise name so a concurrent cancel, callback, approval, and human-task
  // resolution for the same stepId do not cross-wake each other.
  it('cancel, callback, approval, and human-task use disjoint promise keys', async () => {
    const ctx = makeCtx('exec-7');

    await handleCancel(ctx);
    await handleResolveCallback(ctx, {
      executionId: 'exec-7',
      stepId: 'same-id',
      payload: null,
    });
    await handleResolveApproval(ctx, {
      executionId: 'exec-7',
      stepId: 'same-id',
      decision: {},
    });
    await handleResolveHumanTask(ctx, {
      executionId: 'exec-7',
      stepId: 'same-id',
      response: {},
    });

    const names = ctx.resolved.map((r) => r.name);
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual([
      'sys:cancel',
      'sys:callback:same-id',
      'sys:approval:same-id',
      'sys:human_task:same-id',
    ]);
  });
});

describe('buildRestateEndpoint', () => {
  it('returns a truthy endpoint object for valid deps (smoke)', () => {
    // Runtime sanity: the workflow registration does not throw during SDK
    // build-time with a well-formed deps object. The returned object is
    // opaque (Restate SDK internals) — we only assert it exists.
    const deps: RestateEndpointDeps = {
      persistence: {
        createExecution: vi.fn(),
        updateStepStatus: vi.fn(),
        updateExecutionStatus: vi.fn(),
      },
      publisher: { publish: vi.fn() },
      dispatcherDeps: {},
    };
    const endpoint = buildRestateEndpoint(deps);
    expect(endpoint).toBeTruthy();
  });
});
