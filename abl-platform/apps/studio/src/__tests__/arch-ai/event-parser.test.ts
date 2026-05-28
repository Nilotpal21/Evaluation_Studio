import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '@/lib/arch-ai/ui/event-parser';

describe('parseEnvelope', () => {
  it('parses v4 replay envelopes with durable turn metadata', () => {
    const envelope = parseEnvelope(
      JSON.stringify({
        sessionId: 'sess-1',
        turnId: 'turn-1',
        seq: 4,
        timestamp: 123,
        delta: 'hello',
      }),
      'text_delta',
    );

    expect(envelope).toMatchObject({
      type: 'text_delta',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      seq: 4,
      delta: 'hello',
    });
  });

  it('parses raw live SSE frames from the v4 POST stream', () => {
    const envelope = parseEnvelope(
      JSON.stringify({
        agent: 'BookingTriageAgent',
        mode: 'parallel',
        role: 'entry',
      }),
      'build_agent_start',
    );

    expect(envelope).toMatchObject({
      type: 'build_agent_start',
      agent: 'BookingTriageAgent',
      mode: 'parallel',
      role: 'entry',
    });
    expect(envelope).not.toHaveProperty('turnId');
    expect(envelope).not.toHaveProperty('seq');
  });
});
