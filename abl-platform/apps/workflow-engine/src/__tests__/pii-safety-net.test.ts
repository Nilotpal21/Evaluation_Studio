/**
 * DFA-M2: Tests for the workflow PII safety-net scanner.
 * DFA-L1: Verifies that `workflow_unprotected_pii_dispatched` is emitted
 *         as a structured trace event (not just a log.warn).
 *
 * Covers:
 * - Flat string param with PII (SSN, phone, email)
 * - Nested object with PII
 * - Deeply nested PII
 * - No PII case (no event, no warning)
 * - Multiple PII types in one param set
 * - Error resilience (malformed params)
 * - Trace event shape matches registry type 'workflow_unprotected_pii_dispatched'
 */
import { describe, it, expect, vi } from 'vitest';
import {
  scanToolParamsForPII,
  createLoggerTraceEventSink,
  type PIISafetyNetInput,
  type TraceEventSink,
} from '../services/pii-safety-net.js';

function makeInput(params: Record<string, unknown>): PIISafetyNetInput {
  return {
    toolName: 'test-tool',
    params,
    tenantId: 'tenant-1',
    projectId: 'project-1',
  };
}

describe('scanToolParamsForPII', () => {
  it('detects SSN in flat string param and emits trace event', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent: TraceEventSink = (e) => events.push(e);

    const result = scanToolParamsForPII(makeInput({ ssn: '123-45-6789' }), onTraceEvent);

    expect(result.hasPII).toBe(true);
    expect(result.piiTypesDetected).toContain('ssn');

    // DFA-L1: verify trace event fires (not just log.warn)
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workflow_unprotected_pii_dispatched');
    expect(events[0].data.toolName).toBe('test-tool');
    expect(events[0].data.tenantId).toBe('tenant-1');
    expect(events[0].data.projectId).toBe('project-1');
    expect(events[0].data.piiTypesDetected).toContain('ssn');
  });

  it('detects phone number in flat string param', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = scanToolParamsForPII(makeInput({ phone: '(555) 123-4567' }), (e) =>
      events.push(e),
    );

    expect(result.hasPII).toBe(true);
    expect(result.piiTypesDetected).toContain('phone');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workflow_unprotected_pii_dispatched');
  });

  it('detects email address in flat string param', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = scanToolParamsForPII(makeInput({ email: 'user@example.com' }), (e) =>
      events.push(e),
    );

    expect(result.hasPII).toBe(true);
    expect(result.piiTypesDetected).toContain('email');
    expect(events).toHaveLength(1);
  });

  it('detects PII in nested object', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = scanToolParamsForPII(
      makeInput({
        customer: {
          name: 'John Doe',
          ssn: '987-65-4321',
        },
      }),
      (e) => events.push(e),
    );

    expect(result.hasPII).toBe(true);
    expect(result.piiTypesDetected).toContain('ssn');
    expect(events).toHaveLength(1);
  });

  it('detects PII in deeply nested object', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = scanToolParamsForPII(
      makeInput({
        order: {
          billing: {
            contact: {
              phone: '(555) 987-6543',
            },
          },
        },
      }),
      (e) => events.push(e),
    );

    expect(result.hasPII).toBe(true);
    expect(result.piiTypesDetected).toContain('phone');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workflow_unprotected_pii_dispatched');
  });

  it('does not emit when no PII is detected', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = scanToolParamsForPII(
      makeInput({
        orderId: 'ORD-12345',
        status: 'pending',
        amount: 99.5,
      }),
      (e) => events.push(e),
    );

    expect(result.hasPII).toBe(false);
    expect(result.piiTypesDetected).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('detects multiple PII types in one param set', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = scanToolParamsForPII(
      makeInput({
        ssn: '123-45-6789',
        phone: '(555) 123-4567',
        email: 'user@example.com',
      }),
      (e) => events.push(e),
    );

    expect(result.hasPII).toBe(true);
    // Should detect at least ssn and phone
    expect(result.piiTypesDetected.length).toBeGreaterThanOrEqual(2);
    // Single trace event even with multiple PII types
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workflow_unprotected_pii_dispatched');
    // piiTypesDetected should contain all detected types
    expect((events[0].data.piiTypesDetected as string[]).length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty params without error', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = scanToolParamsForPII(makeInput({}), (e) => events.push(e));

    expect(result.hasPII).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('works without onTraceEvent callback (log-only)', () => {
    // Should not throw when onTraceEvent is omitted
    const result = scanToolParamsForPII(makeInput({ ssn: '123-45-6789' }));

    expect(result.hasPII).toBe(true);
    expect(result.piiTypesDetected).toContain('ssn');
  });

  it('trace event data shape matches registry type', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    scanToolParamsForPII(makeInput({ ssn: '123-45-6789' }), (e) => events.push(e));

    expect(events).toHaveLength(1);
    const event = events[0];

    // Verify the trace event type matches the registry entry
    expect(event.type).toBe('workflow_unprotected_pii_dispatched');

    // Verify required data fields are present
    expect(event.data).toHaveProperty('toolName');
    expect(event.data).toHaveProperty('tenantId');
    expect(event.data).toHaveProperty('projectId');
    expect(event.data).toHaveProperty('piiTypesDetected');

    // Verify no plaintext PII leaks into the event payload
    const payload = JSON.stringify(event.data);
    expect(payload).not.toContain('123-45-6789');
  });
});

describe('createLoggerTraceEventSink', () => {
  it('creates a function that accepts trace events without throwing', () => {
    const sink = createLoggerTraceEventSink();
    expect(typeof sink).toBe('function');

    // Should not throw
    sink({
      type: 'workflow_unprotected_pii_dispatched',
      data: {
        toolName: 'test-tool',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        piiTypesDetected: ['ssn'],
      },
    });
  });
});
