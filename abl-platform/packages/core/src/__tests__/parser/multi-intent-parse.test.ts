import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../../parser/agent-based-parser.js';

describe('MULTI_INTENT parsing', () => {
  it('parses MULTI_INTENT section with all fields', () => {
    const dsl = `AGENT: booking_assistant
GOAL: "Help with bookings"
MULTI_INTENT:
  strategy: auto
  max_intents: 5
  confidence_threshold: 0.7
  queue_max_age_ms: 300000
  enabled: true`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent).toBeDefined();
    expect(result.document?.multiIntent?.strategy).toBe('auto');
    expect(result.document?.multiIntent?.max_intents).toBe(5);
    expect(result.document?.multiIntent?.confidence_threshold).toBe(0.7);
    expect(result.document?.multiIntent?.queue_max_age_ms).toBe(300000);
    expect(result.document?.multiIntent?.enabled).toBe(true);
  });

  it('parses MULTI_INTENT with minimal config', () => {
    const dsl = `AGENT: test
GOAL: "Test"
MULTI_INTENT:
  strategy: primary_queue`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent?.strategy).toBe('primary_queue');
    expect(result.document?.multiIntent?.max_intents).toBeUndefined();
  });

  it('handles missing MULTI_INTENT section gracefully', () => {
    const dsl = `AGENT: test
GOAL: "Test"
MODE: reasoning`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent).toBeUndefined();
  });

  it('parses enabled: false', () => {
    const dsl = `AGENT: test
GOAL: "Test"
MULTI_INTENT:
  strategy: sequential
  enabled: false`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent?.enabled).toBe(false);
  });

  it('MULTI_INTENT does not consume next section', () => {
    const dsl = `AGENT: test
GOAL: "Test"
MULTI_INTENT:
  strategy: auto
TOOLS:
  search(query: string) -> object`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent?.strategy).toBe('auto');
    expect(result.document?.tools).toBeDefined();
    expect(result.document?.tools.length).toBeGreaterThan(0);
  });
});
