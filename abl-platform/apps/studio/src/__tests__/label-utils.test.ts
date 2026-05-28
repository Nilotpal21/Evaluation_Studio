// apps/studio/src/__tests__/label-utils.test.ts
import { describe, it, expect } from 'vitest';
import {
  isRawId,
  resolveAgentLabel,
  resolveLLMLabel,
  resolveToolLabel,
  resolveDecisionLabel,
  resolveHandoffLabel,
} from '../lib/label-utils';

describe('isRawId', () => {
  it('detects hex strings >= 16 chars', () => {
    expect(isRawId('f160636b4e1e3bcee2f2bfb2')).toBe(true);
  });

  it('detects traceId:spanId composites', () => {
    expect(isRawId('f160636b4e1e3bcee2f2bfb2:29e4086b8fc5dd0')).toBe(true);
  });

  it('detects UUIDs', () => {
    expect(isRawId('019c0ce7-7248-7815-8030-42c421246467')).toBe(true);
  });

  it('allows normal agent names', () => {
    expect(isRawId('TravelDesk_Supervisor')).toBe(false);
    expect(isRawId('gpt-4o')).toBe(false);
    expect(isRawId('search_flights')).toBe(false);
  });

  it('allows empty/short strings', () => {
    expect(isRawId('')).toBe(false);
    expect(isRawId('Agent')).toBe(false);
  });
});

describe('resolveAgentLabel', () => {
  it('uses agentName when present', () => {
    expect(resolveAgentLabel({ agentName: 'Travel_Agent' })).toBe('Travel_Agent');
  });

  it('extracts last segment from dotted agent path', () => {
    expect(resolveAgentLabel({ agent: 'traveldesk/TravelDesk_Supervisor' })).toBe(
      'TravelDesk_Supervisor',
    );
  });

  it('falls back to sessionAgentName', () => {
    expect(resolveAgentLabel({}, 'Booking_Agent')).toBe('Booking_Agent');
  });

  it('replaces raw IDs with fallback', () => {
    expect(resolveAgentLabel({ agentName: 'f160636b4e1e3bcee2f2bfb2:29e4086b8fc5dd0' })).toBe(
      'Agent',
    );
  });

  it('falls back to "Agent" when nothing available', () => {
    expect(resolveAgentLabel({})).toBe('Agent');
  });
});

describe('resolveLLMLabel', () => {
  it('prefixes model name', () => {
    expect(resolveLLMLabel({ model: 'gpt-4o' })).toBe('LLM → gpt-4o');
  });

  it('falls back to "LLM Call"', () => {
    expect(resolveLLMLabel({})).toBe('LLM Call');
  });
});

describe('resolveToolLabel', () => {
  it('prefixes tool name', () => {
    expect(resolveToolLabel({ toolName: 'search_flights' })).toBe('tool: search_flights');
  });

  it('tries name field', () => {
    expect(resolveToolLabel({ name: 'weather_api' })).toBe('tool: weather_api');
  });

  it('falls back to "Tool Call"', () => {
    expect(resolveToolLabel({})).toBe('Tool Call');
  });
});

describe('resolveDecisionLabel', () => {
  it('combines kind and outcome', () => {
    expect(resolveDecisionLabel({ decisionKind: 'handoff', outcome: 'Booking_Agent' })).toBe(
      'handoff: Booking_Agent',
    );
  });

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(100);
    expect(
      resolveDecisionLabel({ decisionKind: 'completion', outcome: long }).length,
    ).toBeLessThanOrEqual(80);
  });

  it('falls back to "decision"', () => {
    expect(resolveDecisionLabel({})).toBe('decision');
  });
});

describe('resolveHandoffLabel', () => {
  it('uses toAgent', () => {
    expect(resolveHandoffLabel({ toAgent: 'Booking_Agent' })).toBe('handoff → Booking_Agent');
  });

  it('falls back to agentName', () => {
    expect(resolveHandoffLabel({ agentName: 'Travel_Agent' })).toBe('handoff → Travel_Agent');
  });

  it('falls back to "Handoff"', () => {
    expect(resolveHandoffLabel({})).toBe('Handoff');
  });
});
