import { describe, it, expect } from 'vitest';
import { runDiagnostics } from '../services/diagnostics/diagnostic-patterns.js';
import type { TraceEvents } from '../services/diagnostics/diagnostic-patterns.js';

describe('arch diagnostics', () => {
  describe('runDiagnostics', () => {
    it('returns empty patterns when no issues detected', () => {
      const result = runDiagnostics({ traces: [] });
      expect(result.patterns).toEqual([]);
    });

    it('returns empty patterns for normal trace events', () => {
      const traces: TraceEvents = [
        { type: 'flow_step_enter', data: { stepName: 'greeting' } },
        { type: 'tool_call', data: { tool: 'search' } },
        { type: 'flow_step_exit', data: { stepName: 'greeting' } },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toEqual([]);
    });
  });

  describe('memory_silent_noop', () => {
    it('detects when agent has memory but FactStore unavailable', () => {
      const traces: TraceEvents = [
        {
          type: 'memory_unavailable',
          data: { agentName: 'booking', reason: 'no_fact_store', operation: 'remember' },
        },
      ];
      const result = runDiagnostics({ traces, agentHasMemory: true });
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].id).toBe('memory_silent_noop');
      expect(result.patterns[0].fix).toContain('FactStore');
      expect(result.patterns[0].eventCount).toBe(1);
    });

    it('does not detect when agent has no memory config', () => {
      const traces: TraceEvents = [
        { type: 'memory_unavailable', data: { reason: 'no_fact_store' } },
      ];
      const result = runDiagnostics({ traces, agentHasMemory: false });
      expect(result.patterns).toEqual([]);
    });

    it('detects no_user_id reason', () => {
      const traces: TraceEvents = [{ type: 'memory_unavailable', data: { reason: 'no_user_id' } }];
      const result = runDiagnostics({ traces, agentHasMemory: true });
      expect(result.patterns[0].fix).toContain('userId');
    });
  });

  describe('backtrack_escalation', () => {
    it('detects constraint backtrack limit exceeded', () => {
      const traces: TraceEvents = [
        {
          type: 'constraint_backtrack_limit',
          data: { step: 'payment', count: 3, fallbackAction: 'escalate' },
        },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].id).toBe('backtrack_escalation');
      expect(result.patterns[0].explanation).toContain('payment');
    });
  });

  describe('wrong_field_corrected', () => {
    it('detects ambiguous correction with _correction fallback', () => {
      const traces: TraceEvents = [
        {
          type: 'correction',
          data: { field: '_correction', method: 'heuristic', value: 'changed value' },
        },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].id).toBe('wrong_field_corrected');
    });

    it('does not detect normal corrections', () => {
      const traces: TraceEvents = [
        { type: 'correction', data: { field: 'destination', method: 'regex', value: 'NYC' } },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toEqual([]);
    });
  });

  describe('strategy_mismatch', () => {
    it('detects LLM extraction fallback to pattern', () => {
      const traces: TraceEvents = [
        {
          type: 'extraction_fallback',
          data: { fields: ['checkin_date', 'checkout_date'], from: 'llm', to: 'pattern' },
        },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].id).toBe('strategy_mismatch');
      expect(result.patterns[0].explanation).toContain('checkin_date');
    });
  });

  describe('gather_stall', () => {
    it('detects repeated prompts without progress', () => {
      const traces: TraceEvents = [
        { type: 'dsl_prompt', data: { stepName: 'booking' } },
        { type: 'dsl_prompt', data: { stepName: 'booking' } },
        { type: 'dsl_prompt', data: { stepName: 'booking' } },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].id).toBe('gather_stall');
      expect(result.patterns[0].explanation).toContain('booking');
    });

    it('does not detect with fewer than 3 prompts', () => {
      const traces: TraceEvents = [
        { type: 'dsl_prompt', data: { stepName: 'booking' } },
        { type: 'dsl_prompt', data: { stepName: 'booking' } },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toEqual([]);
    });
  });

  describe('on_input_drop', () => {
    it('detects unmatched ON_INPUT conditions', () => {
      const traces: TraceEvents = [
        { type: 'dsl_on_input', data: { matched: false, step: 'greeting' } },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].id).toBe('on_input_drop');
      expect(result.patterns[0].fix).toContain('ELSE');
    });

    it('does not detect when ON_INPUT matched', () => {
      const traces: TraceEvents = [
        { type: 'dsl_on_input', data: { matched: true, step: 'greeting' } },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toEqual([]);
    });
  });

  describe('validation_fail_open', () => {
    it('detects LLM validation failures treated as valid', () => {
      const traces: TraceEvents = [
        {
          type: 'validation_fail_open',
          data: { field: 'email', error: 'LLM timeout', treatAsValid: true },
        },
      ];
      const result = runDiagnostics({ traces });
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].id).toBe('validation_fail_open');
      expect(result.patterns[0].fix).toContain('pattern');
    });
  });

  describe('preference_not_persisted', () => {
    it('detects preferences with unavailable memory', () => {
      const traces: TraceEvents = [
        {
          type: 'preference_detected',
          data: { category: 'desire', text: 'window seat', confidence: 0.9 },
        },
        { type: 'memory_unavailable', data: { reason: 'no_fact_store' } },
      ];
      const result = runDiagnostics({ traces, agentHasMemory: true });
      const prefPattern = result.patterns.find((p) => p.id === 'preference_not_persisted');
      expect(prefPattern).toBeDefined();
      expect(prefPattern!.explanation).toContain('preferences');
    });
  });

  describe('multiple patterns', () => {
    it('detects multiple patterns in priority order', () => {
      const traces: TraceEvents = [
        { type: 'memory_unavailable', data: { reason: 'no_fact_store' } },
        { type: 'constraint_backtrack_limit', data: { step: 'payment', count: 3 } },
        { type: 'validation_fail_open', data: { field: 'email', error: 'timeout' } },
      ];
      const result = runDiagnostics({ traces, agentHasMemory: true });
      expect(result.patterns.length).toBeGreaterThanOrEqual(3);
      // memory_silent_noop should come before backtrack_escalation (detector order = priority)
      const ids = result.patterns.map((p) => p.id);
      expect(ids.indexOf('memory_silent_noop')).toBeLessThan(ids.indexOf('backtrack_escalation'));
    });
  });

  describe('pattern structure', () => {
    it('every detected pattern has required fields', () => {
      const traces: TraceEvents = [
        { type: 'memory_unavailable', data: { reason: 'no_fact_store' } },
        { type: 'constraint_backtrack_limit', data: { step: 'payment', count: 3 } },
      ];
      const result = runDiagnostics({ traces, agentHasMemory: true });
      for (const pattern of result.patterns) {
        expect(pattern.id).toBeTruthy();
        expect(pattern.name).toBeTruthy();
        expect(pattern.explanation).toBeTruthy();
        expect(pattern.fix).toBeTruthy();
        expect(typeof pattern.eventCount).toBe('number');
        expect(pattern.eventCount).toBeGreaterThan(0);
      }
    });
  });
});
