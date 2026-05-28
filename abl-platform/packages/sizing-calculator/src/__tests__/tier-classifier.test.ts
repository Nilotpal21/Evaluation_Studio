import { describe, it, expect } from 'vitest';
import { classifyTier } from '../engine/tier-classifier.js';

describe('TierClassifier', () => {
  it('classifies starter tier', () => {
    expect(
      classifyTier({
        agentCount: 5,
        concurrentConversations: 100,
        totalDocuments: 1000,
        messagesPerDay: 500,
      }),
    ).toBe('S');
  });

  it('classifies mid-market tier', () => {
    expect(
      classifyTier({
        agentCount: 50,
        concurrentConversations: 5000,
        totalDocuments: 100000,
        messagesPerDay: 20000,
      }),
    ).toBe('M');
  });

  it('classifies enterprise tier', () => {
    expect(
      classifyTier({
        agentCount: 500,
        concurrentConversations: 50000,
        totalDocuments: 2000000,
        messagesPerDay: 200000,
      }),
    ).toBe('L');
  });

  it('classifies hyperscale tier', () => {
    expect(
      classifyTier({
        agentCount: 2000,
        concurrentConversations: 200000,
        totalDocuments: 10000000,
        messagesPerDay: 5000000,
      }),
    ).toBe('XL');
  });

  it('promotes tier when any single dimension exceeds boundary', () => {
    // Low agents but very high messages → bumps to M
    expect(
      classifyTier({
        agentCount: 3,
        concurrentConversations: 100,
        totalDocuments: 500,
        messagesPerDay: 50000,
      }),
    ).toBe('M');
  });

  it('classifies at exact boundary as within tier', () => {
    expect(
      classifyTier({
        agentCount: 10,
        concurrentConversations: 1000,
        totalDocuments: 10000,
        messagesPerDay: 10000,
      }),
    ).toBe('S');
  });

  it('uses workflow executions for classification', () => {
    expect(
      classifyTier({
        agentCount: 5,
        concurrentConversations: 100,
        totalDocuments: 1000,
        messagesPerDay: 500,
        workflowExecutionsPerDay: 50000,
      }),
    ).toBe('M');
  });
});
