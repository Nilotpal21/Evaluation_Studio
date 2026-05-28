import { describe, test, expect } from 'vitest';
import { TRACE_TO_PLATFORM_TYPE, inferCategory } from '../../services/trace-event-types.js';

describe('TRACE_TO_PLATFORM_TYPE', () => {
  test('maps core trace types', () => {
    expect(TRACE_TO_PLATFORM_TYPE['llm_call']).toBe('llm.call.completed');
    expect(TRACE_TO_PLATFORM_TYPE['tool_call']).toBe('tool.call.completed');
    expect(TRACE_TO_PLATFORM_TYPE['tool_call_retry']).toBe('tool.call.retried');
    expect(TRACE_TO_PLATFORM_TYPE['agent_enter']).toBe('agent.entered');
    expect(TRACE_TO_PLATFORM_TYPE['handoff']).toBe('agent.handoff');
    expect(TRACE_TO_PLATFORM_TYPE['decision']).toBe('agent.decision');
    expect(TRACE_TO_PLATFORM_TYPE['constraint_check']).toBe('agent.constraint.checked');
    expect(TRACE_TO_PLATFORM_TYPE['error']).toBe('system.error');
  });

  test('maps agent lifecycle events', () => {
    expect(TRACE_TO_PLATFORM_TYPE['agent_enter']).toBe('agent.entered');
    expect(TRACE_TO_PLATFORM_TYPE['agent_exit']).toBe('agent.exited');
    expect(TRACE_TO_PLATFORM_TYPE['escalation']).toBe('agent.escalated');
  });

  test('maps flow events to flow.* namespace', () => {
    expect(TRACE_TO_PLATFORM_TYPE['flow_step_enter']).toBe('flow.step.entered');
    expect(TRACE_TO_PLATFORM_TYPE['flow_step_exit']).toBe('flow.step.exited');
    expect(TRACE_TO_PLATFORM_TYPE['flow_transition']).toBe('flow.transition');
  });

  test('maps delegation events', () => {
    expect(TRACE_TO_PLATFORM_TYPE['delegate_start']).toBe('agent.delegated');
    expect(TRACE_TO_PLATFORM_TYPE['delegate_complete']).toBe('agent.delegate.completed');
  });

  test('every entry has a non-empty dotted string value', () => {
    for (const [key, value] of Object.entries(TRACE_TO_PLATFORM_TYPE)) {
      expect(value, `mapping for '${key}' should be a non-empty string`).toBeTruthy();
      expect(typeof value).toBe('string');
      expect(value, `platform type for '${key}' should contain a dot`).toContain('.');
    }
  });

  test('voice events all map to voice.* namespace', () => {
    const voiceKeys = Object.keys(TRACE_TO_PLATFORM_TYPE).filter((k) => k.startsWith('voice_'));
    expect(voiceKeys.length).toBeGreaterThan(0);
    for (const key of voiceKeys) {
      expect(TRACE_TO_PLATFORM_TYPE[key]).toMatch(/^(voice|agent\.voice)\./);
    }
  });

  test('session events map to session.* namespace', () => {
    expect(TRACE_TO_PLATFORM_TYPE['session_created']).toBe('session.started');
    expect(TRACE_TO_PLATFORM_TYPE['session_ended']).toBe('session.ended');
    expect(TRACE_TO_PLATFORM_TYPE['session_updated']).toBe('session.updated');
  });

  test('message events map to message.* namespace', () => {
    expect(TRACE_TO_PLATFORM_TYPE['user_message']).toBe('message.user.received');
    expect(TRACE_TO_PLATFORM_TYPE['agent_response']).toBe('message.agent.sent');
  });
});

describe('inferCategory', () => {
  test('extracts first segment of dotted type', () => {
    expect(inferCategory('llm.call.completed')).toBe('llm');
    expect(inferCategory('agent.entered')).toBe('agent');
    expect(inferCategory('system.error')).toBe('system');
    expect(inferCategory('flow.step.entered')).toBe('flow');
    expect(inferCategory('voice.session.started')).toBe('voice');
  });

  test('returns full string if no dots', () => {
    expect(inferCategory('custom_thing')).toBe('custom_thing');
    expect(inferCategory('standalone')).toBe('standalone');
  });

  test('handles empty string', () => {
    expect(inferCategory('')).toBe('');
  });
});
