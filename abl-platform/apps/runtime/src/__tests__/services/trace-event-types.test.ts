import { describe, it, expect } from 'vitest';
import {
  PLATFORM_TO_TRACE_ALIASES,
  PLATFORM_TO_TRACE_TYPE,
  TRACE_TO_PLATFORM_TYPE,
  inferCategory,
} from '../../services/trace-event-types.js';

// ---------------------------------------------------------------------------
// TRACE_TO_PLATFORM_TYPE — structural invariant only
// ---------------------------------------------------------------------------

describe('TRACE_TO_PLATFORM_TYPE', () => {
  it('stays internally consistent with the reverse mapping', () => {
    const platformTypes = Object.values(TRACE_TO_PLATFORM_TYPE);
    const uniquePlatformTypes = new Set(platformTypes);
    const aliasPlatformTypes = Object.keys(PLATFORM_TO_TRACE_ALIASES);
    const delegatedAliases = Object.entries(TRACE_TO_PLATFORM_TYPE)
      .filter(([, platformType]) => platformType === 'agent.delegated')
      .map(([traceType]) => traceType)
      .sort();

    expect(Object.keys(PLATFORM_TO_TRACE_TYPE).sort()).toEqual(
      [...new Set([...uniquePlatformTypes, ...aliasPlatformTypes])].sort(),
    );
    expect(delegatedAliases).toEqual(['delegate', 'delegate_start']);
  });

  it('returns undefined for unknown trace types', () => {
    expect(TRACE_TO_PLATFORM_TYPE['nonexistent']).toBeUndefined();
  });

  it('keeps dotted compatibility aliases mapped to canonical trace types', () => {
    expect(TRACE_TO_PLATFORM_TYPE['tool_call_retry']).toBe('tool.call.retried');
    expect(PLATFORM_TO_TRACE_TYPE['llm.call.failed']).toBe('llm_call');
    expect(PLATFORM_TO_TRACE_TYPE['tool.call.failed']).toBe('tool_call');
    expect(PLATFORM_TO_TRACE_TYPE['tool.call.retried']).toBe('tool_call_retry');
  });
});

// ---------------------------------------------------------------------------
// inferCategory
// ---------------------------------------------------------------------------

describe('inferCategory', () => {
  it('infers "llm" from llm.call.completed', () => {
    expect(inferCategory('llm.call.completed')).toBe('llm');
  });

  it('infers "agent" from agent.entered', () => {
    expect(inferCategory('agent.entered')).toBe('agent');
  });

  it('infers "flow" from flow.step.entered', () => {
    expect(inferCategory('flow.step.entered')).toBe('flow');
  });

  it('infers "session" from session.started', () => {
    expect(inferCategory('session.started')).toBe('session');
  });

  it('infers "message" from message.user.received', () => {
    expect(inferCategory('message.user.received')).toBe('message');
  });

  it('infers "voice" from voice.session.started', () => {
    expect(inferCategory('voice.session.started')).toBe('voice');
  });

  it('infers "system" from system.error', () => {
    expect(inferCategory('system.error')).toBe('system');
  });

  it('infers "tool" from tool.call.completed', () => {
    expect(inferCategory('tool.call.completed')).toBe('tool');
  });

  it('infers "channel" from channel.response.sent', () => {
    expect(inferCategory('channel.response.sent')).toBe('channel');
  });

  it('infers "attachment" from attachment.preprocessed', () => {
    expect(inferCategory('attachment.preprocessed')).toBe('attachment');
  });

  it('returns the full string when there are no dots', () => {
    expect(inferCategory('standalone')).toBe('standalone');
  });

  it('handles empty string', () => {
    expect(inferCategory('')).toBe('');
  });
});
