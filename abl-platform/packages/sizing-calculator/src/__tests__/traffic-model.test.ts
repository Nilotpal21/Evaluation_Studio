import { describe, it, expect } from 'vitest';
import { peakRps, expectedRps } from '../engine/traffic-model.js';
import { makeQ } from './helpers/make-questionnaire.js';

describe('peakRps', () => {
  it('converts daily volume to peak RPS using enterprise traffic model', () => {
    // 10,000 messages/day -> peak hour = 10000 * 0.4 / 2 = 2000 per hour -> 2000/3600 ~ 0.556
    const rps = peakRps(10000);
    expect(rps).toBeCloseTo(0.556, 2);
  });

  it('returns 0 for zero daily volume', () => {
    expect(peakRps(0)).toBe(0);
  });
});

describe('expectedRps', () => {
  it('uses concurrentConversations for runtime when available', () => {
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 500,
        avgConversationLength: 10,
        messagesPerDay: 10000,
        toolCallsPerConversation: 3,
        multiAgentUsage: 0,
      },
    });
    expect(expectedRps('runtime', q)).toBe(500);
  });

  it('falls back to daily messages for runtime when concurrentConversations is 0', () => {
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 0,
        avgConversationLength: 10,
        messagesPerDay: 10000,
        toolCallsPerConversation: 3,
        multiAgentUsage: 0,
      },
    });
    const rps = expectedRps('runtime', q);
    expect(rps).toBeCloseTo(1.667, 2);
  });

  it('derives search-ai-runtime from vectorSearchQueriesPerDay', () => {
    const q = makeQ();
    const rps = expectedRps('search-ai-runtime', q);
    expect(rps).toBeCloseTo(peakRps(5000), 2);
  });

  it('derives bge-m3 from search-ai ingestion + search-ai-runtime queries', () => {
    const q = makeQ();
    const rps = expectedRps('bge-m3', q);
    expect(rps).toBeGreaterThan(0);
  });

  it('returns 0 for unknown service', () => {
    const q = makeQ();
    expect(expectedRps('unknown-service', q)).toBe(0);
  });
});
