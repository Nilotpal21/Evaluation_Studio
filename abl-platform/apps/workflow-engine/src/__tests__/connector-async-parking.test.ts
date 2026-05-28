/**
 * connector_action → AsyncParkingSentinel → StepDispatchResult.callbackRequest
 * plumbing (LLD Phase 1 Task 1.10 / Exit Criterion).
 *
 * Verifies the dispatcher converts an `AsyncParkingSentinel` returned from a
 * connector action body into a `callbackRequest` field on the dispatch result,
 * which `workflow-handler.ts` then converts into a Restate-promise suspension.
 *
 * No `vi.mock()` of platform packages — the test injects a stub
 * `ConnectorToolExecutor` via the existing `connectorDeps` dependency-injection
 * point (CLAUDE.md test-architecture rules).
 */

import { describe, it, expect, vi } from 'vitest';
import { dispatchStep, type StepDispatcherDeps } from '../handlers/step-dispatcher.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';
import type { ConnectorActionStep } from '../executors/connector-action-executor.js';
import type { AsyncParkingSentinel } from '@agent-platform/connectors';

const baseCtx: WorkflowContextData = {
  trigger: { type: 'webhook', payload: {} },
  workflow: { id: 'wf-1', name: 'docling-extract', executionId: 'exec-async-1' },
  tenant: { tenantId: 't-async-1', projectId: 'p-async-1' },
  steps: {},
  vars: {},
};

const baseStep: ConnectorActionStep = {
  id: 'step-extract',
  type: 'connector_action',
  connector: 'docling',
  action: 'extract_document',
  params: { fileUrl: 'https://example.com/doc.pdf' },
  paramModes: { fileUrl: 'static' },
};

describe('dispatchStep — connector_action async parking', () => {
  it('passes through real-value outputs untouched (regression guard for ingestion path)', async () => {
    const deps: StepDispatcherDeps = {
      connectorDeps: {
        connectorToolExecutor: {
          execute: vi.fn().mockResolvedValue({ pageCount: 7 }),
        } as unknown as import('@agent-platform/connectors').ConnectorToolExecutor,
      },
    };

    const result = await dispatchStep(baseStep, baseCtx, deps);
    expect(result.type).toBe('connector_action');
    expect(result.callbackRequest).toBeUndefined();
    expect(result.output).toEqual({ pageCount: 7 });
  });

  it('converts an AsyncParkingSentinel into callbackRequest with output=null', async () => {
    const sentinel: AsyncParkingSentinel = {
      __asyncParking: true,
      callbackId: 'step-extract',
      callbackTimeoutMs: 600_000,
      encryptedCallbackSecret: 'whsec_enc::ABC123',
    };

    const deps: StepDispatcherDeps = {
      connectorDeps: {
        connectorToolExecutor: {
          execute: vi.fn().mockResolvedValue(sentinel),
        } as unknown as import('@agent-platform/connectors').ConnectorToolExecutor,
      },
    };

    const result = await dispatchStep(baseStep, baseCtx, deps);

    expect(result.type).toBe('connector_action');
    expect(result.output).toBeNull();
    expect(result.input).toEqual({
      action: 'extract_document',
      connector: 'docling',
      params: { fileUrl: 'https://example.com/doc.pdf' },
    });
    expect(result.callbackRequest).toEqual({
      callbackId: 'step-extract',
      callbackTimeoutMs: 600_000,
      encryptedCallbackSecret: 'whsec_enc::ABC123',
    });
  });

  it('omits encryptedCallbackSecret when the sentinel did not carry one', async () => {
    const sentinel: AsyncParkingSentinel = {
      __asyncParking: true,
      callbackId: 'step-extract',
      callbackTimeoutMs: 120_000,
    };

    const deps: StepDispatcherDeps = {
      connectorDeps: {
        connectorToolExecutor: {
          execute: vi.fn().mockResolvedValue(sentinel),
        } as unknown as import('@agent-platform/connectors').ConnectorToolExecutor,
      },
    };

    const result = await dispatchStep(baseStep, baseCtx, deps);

    expect(result.callbackRequest).toBeDefined();
    expect(result.callbackRequest).not.toHaveProperty('encryptedCallbackSecret');
    expect(result.callbackRequest?.callbackId).toBe('step-extract');
    expect(result.callbackRequest?.callbackTimeoutMs).toBe(120_000);
  });

  it('does NOT mistake objects shaped like the sentinel as parking requests', async () => {
    // A legitimate connector return value with a __asyncParking-looking key
    // that is NOT explicitly `true` must be passed through as a real output —
    // the guard checks for strict `=== true` to avoid coincidental matches.
    const decoy = { __asyncParking: 'yes please', callbackId: 'x', callbackTimeoutMs: 1 };

    const deps: StepDispatcherDeps = {
      connectorDeps: {
        connectorToolExecutor: {
          execute: vi.fn().mockResolvedValue(decoy),
        } as unknown as import('@agent-platform/connectors').ConnectorToolExecutor,
      },
    };

    const result = await dispatchStep(baseStep, baseCtx, deps);
    expect(result.callbackRequest).toBeUndefined();
    expect(result.output).toEqual(decoy);
  });
});
