import { describe, test, expect } from 'vitest';
import type {
  InsightResult,
  InsightRecord,
  Granularity,
  InsightStatus,
} from '../pipeline/insight-types.js';

describe('InsightResult types', () => {
  test('InsightResult can represent a session-level toxicity result', () => {
    const result: InsightResult = {
      insightType: 'toxicity',
      granularity: 'session',
      score: 0.85,
      status: 'pass',
      dimensions: { avgToxicity: 0.12, maxToxicity: 0.35, messageCount: 5 },
    };
    expect(result.insightType).toBe('toxicity');
    expect(result.granularity).toBe('session');
    expect(result.score).toBe(0.85);
  });

  test('InsightResult with batch records for per-message toxicity', () => {
    const result: InsightResult = {
      insightType: 'toxicity',
      granularity: 'message',
      score: 0.6,
      status: 'warn',
      dimensions: { messageCount: 3 },
      records: [
        { messageId: 'msg-1', score: 0.1, status: 'pass', dimensions: { text: 'hello' } },
        { messageId: 'msg-2', score: 0.9, status: 'fail', dimensions: { text: 'toxic' } },
        { messageId: 'msg-3', score: 0.3, status: 'pass', dimensions: { text: 'thanks' } },
      ],
    };
    expect(result.records).toHaveLength(3);
    expect(result.records![1].status).toBe('fail');
  });

  test('InsightResult with agent-level tool effectiveness', () => {
    const result: InsightResult = {
      insightType: 'tool-effectiveness',
      granularity: 'agent',
      score: 0.78,
      status: 'pass',
      dimensions: {
        selectionAccuracy: 0.85,
        parameterAccuracy: 0.72,
        retryRate: 0.1,
        toolCallCount: 15,
      },
    };
    expect(result.dimensions.selectionAccuracy).toBe(0.85);
  });

  test('Granularity type accepts all valid levels', () => {
    const levels: Granularity[] = ['message', 'span', 'session', 'agent', 'project'];
    expect(levels).toHaveLength(5);
  });

  test('InsightStatus type accepts pass, warn, fail', () => {
    const statuses: InsightStatus[] = ['pass', 'warn', 'fail'];
    expect(statuses).toHaveLength(3);
  });
});
