import { describe, test, expect, vi } from 'vitest';

// Mock lucide-react to avoid missing icon export errors in test environment
vi.mock('lucide-react', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const stub = () => null;
  return new Proxy(actual, {
    get: (target, prop) => (prop in target ? target[prop as string] : stub),
  });
});

import { normalizeEventType, DECISION_KIND_META } from '../lib/event-types';

describe('normalizeEventType', () => {
  test('normalizes dotted LLM types to llm_call', () => {
    expect(normalizeEventType('llm.call.completed')).toBe('llm_call');
    expect(normalizeEventType('llm.call.failed')).toBe('llm_call');
  });

  test('normalizes dotted tool types to tool_call', () => {
    expect(normalizeEventType('tool.call.completed')).toBe('tool_call');
    expect(normalizeEventType('tool.call.failed')).toBe('tool_call');
  });

  test('normalizes agent decision type', () => {
    expect(normalizeEventType('agent.decision')).toBe('decision');
  });

  test('normalizes agent lifecycle types', () => {
    expect(normalizeEventType('agent.entered')).toBe('agent_enter');
    expect(normalizeEventType('agent.exited')).toBe('agent_exit');
    expect(normalizeEventType('agent.handoff')).toBe('handoff');
    expect(normalizeEventType('agent.escalated')).toBe('escalation');
  });

  test('normalizes flow types', () => {
    expect(normalizeEventType('flow.step.entered')).toBe('flow_step_enter');
    expect(normalizeEventType('flow.step.exited')).toBe('flow_step_exit');
    expect(normalizeEventType('flow.transition')).toBe('flow_transition');
  });

  test('normalizes delegation types', () => {
    expect(normalizeEventType('agent.delegated')).toBe('delegate_start');
    expect(normalizeEventType('agent.delegate.completed')).toBe('delegate_complete');
  });

  test('normalizes constraint check', () => {
    expect(normalizeEventType('agent.constraint.checked')).toBe('constraint_check');
  });

  test('normalizes system error', () => {
    expect(normalizeEventType('system.error')).toBe('error');
  });

  test('normalizes session types', () => {
    expect(normalizeEventType('session.started')).toBe('session_created');
    expect(normalizeEventType('session.ended')).toBe('session_ended');
    expect(normalizeEventType('session.updated')).toBe('session_updated');
  });

  test('normalizes message types', () => {
    expect(normalizeEventType('message.user.received')).toBe('user_message');
    expect(normalizeEventType('message.agent.sent')).toBe('agent_response');
  });

  test('normalizes voice types', () => {
    expect(normalizeEventType('voice.session.started')).toBe('voice_session_start');
    expect(normalizeEventType('voice.session.ended')).toBe('voice_session_end');
    expect(normalizeEventType('voice.turn.completed')).toBe('voice_turn');
    expect(normalizeEventType('voice.stt.completed')).toBe('voice_stt');
    expect(normalizeEventType('voice.tts.completed')).toBe('voice_tts');
  });

  test('normalizes channel and lifecycle dotted types', () => {
    expect(normalizeEventType('channel.message.received')).toBe('channel_message_received');
    expect(normalizeEventType('channel.message.sent')).toBe('channel_message_sent');
    expect(normalizeEventType('channel.response.sent')).toBe('channel_response_sent');
    expect(normalizeEventType('channel.webhook.delivered')).toBe('channel_webhook_delivered');
    expect(normalizeEventType('agent.error.handled')).toBe('agent_error_handled');
    expect(normalizeEventType('agent.profile.applied')).toBe('behavior_profile_applied');
    expect(normalizeEventType('agent.voice.config_resolved')).toBe('voice_config_resolved');
    expect(normalizeEventType('agent.hook.executed')).toBe('hook_executed');
    expect(normalizeEventType('flow.action_handler.executed')).toBe('action_handler_executed');
    expect(normalizeEventType('agent.escalation.triggered')).toBe('escalation_triggered');
    expect(normalizeEventType('agent.escalation.resolved')).toBe('escalation_resolved');
    expect(normalizeEventType('agent.escalation.itsm_created')).toBe('itsm_ticket_created');
  });

  test('passes through underscore types unchanged', () => {
    expect(normalizeEventType('llm_call')).toBe('llm_call');
    expect(normalizeEventType('tool_call')).toBe('tool_call');
    expect(normalizeEventType('decision')).toBe('decision');
    expect(normalizeEventType('constraint_check')).toBe('constraint_check');
    expect(normalizeEventType('error')).toBe('error');
  });

  test('passes through unknown types unchanged', () => {
    expect(normalizeEventType('custom_thing')).toBe('custom_thing');
    expect(normalizeEventType('some.unknown.type')).toBe('some.unknown.type');
  });
});

describe('DECISION_KIND_META', () => {
  test('all 11 decision kinds have metadata', () => {
    const kinds = Object.keys(DECISION_KIND_META);
    expect(kinds).toHaveLength(11);
    expect(kinds).toContain('handoff');
    expect(kinds).toContain('delegation');
    expect(kinds).toContain('flow_transition');
    expect(kinds).toContain('escalation');
    expect(kinds).toContain('completion');
    expect(kinds).toContain('constraint_check');
    expect(kinds).toContain('guardrail_check');
    expect(kinds).toContain('gather_extraction');
    expect(kinds).toContain('correction');
    expect(kinds).toContain('data_mutation');
    expect(kinds).toContain('field_validation');
  });

  test('every kind has label, icon, color, and sections', () => {
    for (const [kind, meta] of Object.entries(DECISION_KIND_META)) {
      expect(meta.label, `${kind} should have label`).toBeTruthy();
      expect(meta.icon, `${kind} should have icon`).toBeTruthy();
      expect(meta.color, `${kind} should have color`).toBeTruthy();
      expect(Array.isArray(meta.sections), `${kind} sections should be array`).toBe(true);
    }
  });
});
