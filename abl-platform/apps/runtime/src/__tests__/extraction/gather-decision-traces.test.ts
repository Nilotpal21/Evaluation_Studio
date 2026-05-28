import { describe, it, expect } from 'vitest';
import { emitDecisionTrace, shouldEmitTrace } from '../../services/execution/trace-helpers.js';

describe('gather decision traces', () => {
  describe('gather_complete_reason', () => {
    it('is a verbose-level event', () => {
      expect(shouldEmitTrace('gather_complete_reason', 'verbose')).toBe(true);
      expect(shouldEmitTrace('gather_complete_reason', 'standard')).toBe(false);
    });
  });

  describe('gather_field_activation', () => {
    it('is a verbose-level event', () => {
      expect(shouldEmitTrace('gather_field_activation', 'verbose')).toBe(true);
      expect(shouldEmitTrace('gather_field_activation', 'standard')).toBe(false);
    });
  });

  describe('validation_fail_open', () => {
    it('is a verbose-level event', () => {
      expect(shouldEmitTrace('validation_fail_open', 'verbose')).toBe(true);
      expect(shouldEmitTrace('validation_fail_open', 'standard')).toBe(false);
    });
  });

  describe('emitDecisionTrace integration', () => {
    it('emits gather_complete_reason at verbose level', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const handler = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

      emitDecisionTrace(handler, 'verbose', 'gather_complete_reason', {
        agentName: 'test',
        stepName: 'greeting',
        reason: 'all_fields',
        missingOptional: ['nickname'],
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('gather_complete_reason');
      expect(events[0].data.reason).toBe('all_fields');
    });

    it('does not emit gather_complete_reason at standard level', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const handler = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

      emitDecisionTrace(handler, 'standard', 'gather_complete_reason', {
        agentName: 'test',
        stepName: 'greeting',
        reason: 'all_fields',
      });

      expect(events).toHaveLength(0);
    });

    it('emits gather_field_activation with skip reason', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const handler = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

      emitDecisionTrace(handler, 'verbose', 'gather_field_activation', {
        agentName: 'test',
        field: 'nickname',
        activation: 'optional',
        active: false,
        reason: 'optional_mode',
      });

      expect(events).toHaveLength(1);
      expect(events[0].data.field).toBe('nickname');
      expect(events[0].data.active).toBe(false);
    });

    it('emits validation_fail_open with error detail', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const handler = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

      emitDecisionTrace(handler, 'verbose', 'validation_fail_open', {
        field: 'email',
        rule: 'Must be a valid email format',
        error: 'LLM timeout',
        treatAsValid: true,
      });

      expect(events).toHaveLength(1);
      expect(events[0].data.treatAsValid).toBe(true);
    });

    it('does not throw when onTraceEvent is undefined', () => {
      expect(() => {
        emitDecisionTrace(undefined, 'verbose', 'validation_fail_open', { field: 'x' });
      }).not.toThrow();
    });
  });
});
