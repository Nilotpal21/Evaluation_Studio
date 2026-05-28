/**
 * Workflow output `_status` / `_reason` convention
 *
 * The workflow handler emits a standard shape on the terminal execution
 * result's `output` field:
 *   - Success  → { _status: 0, ...mappedOutputs }
 *   - Failure  → { _status: 1, _reason: <string> }
 *
 * Producers: workflow-handler.ts resolvedOutput (success) and
 * buildFailureOutput (no-steps, cancel, reject, thrown-step failure).
 * Consumers: studio StatusReasonBanner, callback delivery payloads, and
 * any expression reading `{{steps.<end>.output._status}}`.
 *
 * These tests guard the contract so a future rename (we just did
 * _state → _status) cannot silently slip through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runWorkflow,
  type WorkflowExecutionInput,
  type WorkflowHandlerDeps,
  type ExecutionPersistence,
  type StatusPublisher,
} from '../handlers/workflow-handler.js';
import type { HttpStep } from '../executors/http-executor.js';
import type { DelayStep } from '../executors/delay-executor.js';

// SSRF guard is validated elsewhere — keep it out of this pure contract suite.
vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
}));

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  assertUrlSafeForFetch: vi.fn().mockResolvedValue(undefined),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

function makePersistence(): ExecutionPersistence {
  return {
    createExecution: vi.fn().mockResolvedValue(undefined),
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makePublisher(): StatusPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function makeInput(overrides?: Partial<WorkflowExecutionInput>): WorkflowExecutionInput {
  return {
    workflowId: 'wf-status',
    workflowName: 'status-convention',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'studio',
    triggerPayload: {},
    steps: [],
    ...overrides,
  };
}

function makeDeps(): WorkflowHandlerDeps {
  return {
    persistence: makePersistence(),
    publisher: makePublisher(),
    dispatcherDeps: {},
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('workflow output `_status` convention — success', () => {
  it('delay-step workflow returns output with _status: 0 and no _reason', async () => {
    const step: DelayStep = { id: 'wait', type: 'delay', duration: 'PT1S' };
    const result = await runWorkflow(makeInput({ steps: [step] }), 'exec-s1', makeDeps());

    expect(result.status).toBe('completed');
    expect(result.output).toBeDefined();
    expect(result.output?._status).toBe(0);
    expect(result.output).not.toHaveProperty('_reason');
  });

  it('single delay step completes with _status: 0', async () => {
    const step: DelayStep = { id: 'wait', type: 'delay', duration: 'PT1S' };
    const result = await runWorkflow(makeInput({ steps: [step] }), 'exec-s2', makeDeps());

    expect(result.status).toBe('completed');
    expect(result.output?._status).toBe(0);
  });

  it('output mappings merge alongside _status: 0 (does not overwrite mapped fields)', async () => {
    const step: DelayStep = { id: 'wait', type: 'delay', duration: 'PT1S' };
    const result = await runWorkflow(
      makeInput({
        triggerPayload: { orderId: 'ORD-9' },
        steps: [step],
        outputMappings: [{ name: 'orderId', expression: '{{trigger.payload.orderId}}' }],
      }),
      'exec-s3',
      makeDeps(),
    );

    expect(result.output).toEqual({
      _status: 0,
      orderId: 'ORD-9',
    });
  });

  it('passes output with _status: 0 to persistence.updateExecutionStatus on success', async () => {
    const deps = makeDeps();
    const step: DelayStep = { id: 'wait', type: 'delay', duration: 'PT1S' };
    await runWorkflow(makeInput({ steps: [step] }), 'exec-s4', deps);

    const call = (deps.persistence.updateExecutionStatus as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toBe('completed');
    expect(call[4].output._status).toBe(0);
  });
});

describe('workflow output `_status` convention — failure', () => {
  it('non-array `steps` returns output with _status: 1 and _reason describing the shape', async () => {
    const badInput = {
      ...makeInput(),
      steps: undefined as unknown as WorkflowExecutionInput['steps'],
    };

    const result = await runWorkflow(badInput, 'exec-f1', makeDeps());

    expect(result.status).toBe('failed');
    expect(result.output?._status).toBe(1);
    expect(typeof result.output?._reason).toBe('string');
    expect(result.output?._reason as string).toMatch(/no complete Start/i);
  });

  it('step failure propagates to workflow output with _status: 1 and _reason = error message', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection refused'),
    );

    const step: HttpStep = {
      id: 'call-api',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/down',
    };
    const result = await runWorkflow(makeInput({ steps: [step] }), 'exec-f2', makeDeps());

    expect(result.status).toBe('failed');
    expect(result.output?._status).toBe(1);
    expect(typeof result.output?._reason).toBe('string');
    // The failure reason should surface the underlying error text — not a
    // generic string — so operators can see why the workflow failed.
    expect(result.output?._reason as string).toContain('connection refused');
  });

  it('passes output with _status: 1 to persistence.updateExecutionStatus on failure', async () => {
    // The non-array-steps short-circuit early-returns without touching
    // persistence. Go through the thrown-step catch branch instead, which is
    // the path real workflow failures take.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const step: HttpStep = {
      id: 'call-api',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/down',
    };
    const deps = makeDeps();

    await runWorkflow(makeInput({ steps: [step] }), 'exec-f3', deps);

    const calls = (deps.persistence.updateExecutionStatus as ReturnType<typeof vi.fn>).mock.calls;
    const terminal = calls.find((c) => c[3] === 'failed');
    expect(terminal).toBeDefined();
    expect(terminal![4].output._status).toBe(1);
    expect(typeof terminal![4].output._reason).toBe('string');
  });
});
