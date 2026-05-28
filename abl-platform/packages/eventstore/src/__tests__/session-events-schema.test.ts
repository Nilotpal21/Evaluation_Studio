import { describe, expect, it } from 'vitest';
import { SessionEndedDataSchema } from '../schema/events/session-events.js';

describe('SessionEndedDataSchema', () => {
  it('accepts legacy reason-only payloads', () => {
    const parsed = SessionEndedDataSchema.parse({
      reason: 'completed',
      total_duration_ms: 1200,
    });

    expect(parsed.reason).toBe('completed');
    expect(parsed.total_duration_ms).toBe(1200);
  });

  it('accepts canonical lifecycle payload fields additively', () => {
    const parsed = SessionEndedDataSchema.parse({
      reason: 'abandoned',
      disposition: 'abandoned',
      status: 'abandoned',
      terminalSource: 'disconnect',
      totalDurationMs: 4200,
    });

    expect(parsed.reason).toBe('abandoned');
    expect(parsed.disposition).toBe('abandoned');
    expect(parsed.status).toBe('abandoned');
    expect(parsed.terminalSource).toBe('disconnect');
    expect(parsed.totalDurationMs).toBe(4200);
  });
});
