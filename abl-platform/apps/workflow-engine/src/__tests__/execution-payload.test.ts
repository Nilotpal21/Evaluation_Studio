/**
 * buildWorkflowExecutionPayload — unit tests
 *
 * The builder is the single source of truth for the `startWorkflow` wire
 * shape. Regressions here cascade into every fire path (webhook, cron,
 * polling, Studio execute), so the tests pin the concrete field list and
 * the `null → omit` vs `undefined → omit` vs `{} → keep` behaviour.
 */

import { describe, it, expect } from 'vitest';
import { buildWorkflowExecutionPayload } from '../lib/execution-payload.js';

function baseInput() {
  return {
    workflowId: 'wf-1',
    workflowName: 'ShipOrder',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'webhook' as const,
    triggerPayload: { orderId: 'ORD-1' },
    triggerMetadata: { requestId: 'req-1' },
    steps: [{ id: 's1', type: 'http' }],
  };
}

describe('buildWorkflowExecutionPayload — required fields', () => {
  it('always carries the 8 required fields with pass-through values', () => {
    const payload = buildWorkflowExecutionPayload(baseInput());

    expect(payload.workflowId).toBe('wf-1');
    expect(payload.workflowName).toBe('ShipOrder');
    expect(payload.tenantId).toBe('t1');
    expect(payload.projectId).toBe('p1');
    expect(payload.triggerType).toBe('webhook');
    expect(payload.triggerPayload).toEqual({ orderId: 'ORD-1' });
    expect(payload.triggerMetadata).toEqual({ requestId: 'req-1' });
    expect(payload.steps).toEqual([{ id: 's1', type: 'http' }]);
  });

  it('defaults nameToIdMap to {} when omitted (not undefined — never-drop contract)', () => {
    // The canvas-workflow-via-cron bug was a silent-empty-output because
    // nameToIdMap was `undefined`. The builder must always produce an object.
    const payload = buildWorkflowExecutionPayload(baseInput());
    expect(payload.nameToIdMap).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(payload, 'nameToIdMap')).toBe(true);
  });

  it('defaults outputMappings to [] when omitted (not undefined)', () => {
    const payload = buildWorkflowExecutionPayload(baseInput());
    expect(payload.outputMappings).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(payload, 'outputMappings')).toBe(true);
  });

  it('defaults startInputVariables to [] when omitted (never-drop contract)', () => {
    // Same failure-mode as nameToIdMap/outputMappings: if one fire path forgets
    // to pass startInputVariables, the engine must still see an empty array
    // (not undefined) so the validator's pass-through branch runs uniformly.
    const payload = buildWorkflowExecutionPayload(baseInput());
    expect(payload.startInputVariables).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(payload, 'startInputVariables')).toBe(true);
  });

  it('forwards provided startInputVariables untouched', () => {
    const declared = [
      { name: 'email', type: 'string' as const, required: true },
      { name: 'amount', type: 'number' as const, required: true },
    ];
    const payload = buildWorkflowExecutionPayload({
      ...baseInput(),
      startInputVariables: declared,
    });
    expect(payload.startInputVariables).toEqual(declared);
    // Same reference — builder does not clone (consistent with nameToIdMap/outputMappings).
    expect(payload.startInputVariables).toBe(declared);
  });

  it('forwards provided nameToIdMap and outputMappings untouched', () => {
    const payload = buildWorkflowExecutionPayload({
      ...baseInput(),
      nameToIdMap: { Start: 'id-0', API: 'id-1' },
      outputMappings: [{ name: 'orderId', expression: '{{trigger.payload.orderId}}' }],
    });

    expect(payload.nameToIdMap).toEqual({ Start: 'id-0', API: 'id-1' });
    expect(payload.outputMappings).toEqual([
      { name: 'orderId', expression: '{{trigger.payload.orderId}}' },
    ]);
  });
});

describe('buildWorkflowExecutionPayload — version / deployment fields', () => {
  it('includes workflowVersion, workflowVersionId, deploymentId when non-null', () => {
    const payload = buildWorkflowExecutionPayload({
      ...baseInput(),
      workflowVersion: '1.2.0',
      workflowVersionId: 'ver-1',
      deploymentId: 'dep-1',
    });

    expect(payload.workflowVersion).toBe('1.2.0');
    expect(payload.workflowVersionId).toBe('ver-1');
    expect(payload.deploymentId).toBe('dep-1');
  });

  it('omits the key entirely when null or undefined (not "key: undefined")', () => {
    // Tests that assert field absence (e.g. `expect(payload).not.toHaveProperty`)
    // rely on null-valued inputs being omitted outright.
    const payload = buildWorkflowExecutionPayload({
      ...baseInput(),
      workflowVersion: null,
      workflowVersionId: null,
      deploymentId: null,
    });

    expect(payload).not.toHaveProperty('workflowVersion');
    expect(payload).not.toHaveProperty('workflowVersionId');
    expect(payload).not.toHaveProperty('deploymentId');
  });

  it('omits when undefined (same behaviour as null)', () => {
    const payload = buildWorkflowExecutionPayload(baseInput());
    expect(payload).not.toHaveProperty('workflowVersion');
    expect(payload).not.toHaveProperty('workflowVersionId');
    expect(payload).not.toHaveProperty('deploymentId');
  });
});

describe('buildWorkflowExecutionPayload — webhook-only fields', () => {
  it('includes webhookMode and webhookDelivery when set', () => {
    const payload = buildWorkflowExecutionPayload({
      ...baseInput(),
      webhookMode: 'async',
      webhookDelivery: 'poll',
    });

    expect(payload.webhookMode).toBe('async');
    expect(payload.webhookDelivery).toBe('poll');
  });

  it('omits webhookMode and webhookDelivery for non-webhook triggers', () => {
    const payload = buildWorkflowExecutionPayload({
      ...baseInput(),
      triggerType: 'cron',
    });

    expect(payload).not.toHaveProperty('webhookMode');
    expect(payload).not.toHaveProperty('webhookDelivery');
  });
});

describe('buildWorkflowExecutionPayload — trigger-type specific', () => {
  it('accepts every declared trigger type', () => {
    const types = ['webhook', 'cron', 'event', 'studio', 'agent'] as const;
    for (const t of types) {
      const payload = buildWorkflowExecutionPayload({ ...baseInput(), triggerType: t });
      expect(payload.triggerType).toBe(t);
    }
  });

  it('does not mutate the caller-supplied triggerPayload / triggerMetadata / steps objects', () => {
    const input = baseInput();
    const refPayload = input.triggerPayload;
    const refMetadata = input.triggerMetadata;
    const refSteps = input.steps;

    buildWorkflowExecutionPayload(input);

    expect(input.triggerPayload).toBe(refPayload);
    expect(input.triggerMetadata).toBe(refMetadata);
    expect(input.steps).toBe(refSteps);
  });
});
