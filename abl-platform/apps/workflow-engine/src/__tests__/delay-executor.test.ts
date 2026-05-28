import { describe, it, expect } from 'vitest';
import { resolveDelay, type DelayStep } from '../executors/delay-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: {},
  },
  workflow: { id: 'wf-1', name: 'delay-flow', executionId: 'exec-1' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {},
  vars: { customDelay: '10000' },
};

describe('resolveDelay', () => {
  it('parses ISO 8601 seconds', () => {
    const step: DelayStep = { id: 'd1', type: 'delay', duration: 'PT30S' };
    expect(resolveDelay(step, ctx).durationMs).toBe(30_000);
  });

  it('parses ISO 8601 minutes', () => {
    const step: DelayStep = { id: 'd2', type: 'delay', duration: 'PT5M' };
    expect(resolveDelay(step, ctx).durationMs).toBe(300_000);
  });

  it('parses ISO 8601 hours', () => {
    const step: DelayStep = { id: 'd3', type: 'delay', duration: 'PT2H' };
    expect(resolveDelay(step, ctx).durationMs).toBe(7_200_000);
  });

  it('parses ISO 8601 days', () => {
    const step: DelayStep = { id: 'd4', type: 'delay', duration: 'P1D' };
    expect(resolveDelay(step, ctx).durationMs).toBe(86_400_000);
  });

  it('parses combined ISO 8601 duration', () => {
    const step: DelayStep = { id: 'd5', type: 'delay', duration: 'PT1H30M' };
    expect(resolveDelay(step, ctx).durationMs).toBe(5_400_000);
  });

  it('parses raw millisecond strings', () => {
    const step: DelayStep = { id: 'd6', type: 'delay', duration: '5000' };
    expect(resolveDelay(step, ctx).durationMs).toBe(5_000);
  });

  it('resolves expressions in duration', () => {
    const step: DelayStep = { id: 'd7', type: 'delay', duration: '{{context.vars.customDelay}}' };
    expect(resolveDelay(step, ctx).durationMs).toBe(10_000);
  });

  it('throws on invalid duration string', () => {
    const step: DelayStep = { id: 'd8', type: 'delay', duration: 'invalid' };
    expect(() => resolveDelay(step, ctx)).toThrow('Invalid delay duration');
  });

  it('throws on duration exceeding max (7 days)', () => {
    const eightDaysMs = String(8 * 24 * 60 * 60 * 1000);
    const step: DelayStep = { id: 'd9', type: 'delay', duration: eightDaysMs };
    expect(() => resolveDelay(step, ctx)).toThrow('out of range');
  });

  it('throws on negative duration', () => {
    const step: DelayStep = { id: 'd10', type: 'delay', duration: '-1000' };
    expect(() => resolveDelay(step, ctx)).toThrow('out of range');
  });

  it('handles fractional seconds in ISO 8601', () => {
    const step: DelayStep = { id: 'd11', type: 'delay', duration: 'PT1.5S' };
    expect(resolveDelay(step, ctx).durationMs).toBe(1_500);
  });
});
