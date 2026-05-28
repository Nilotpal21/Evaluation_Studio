import { describe, expect, test } from 'vitest';
import { classifyProbeError } from '../error-classifier.js';

describe('classifyProbeError', () => {
  test.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:19092', 'connection_refused'],
    ['ETIMEDOUT', 'Request timed out after 5000ms', 'timeout'],
    ['DNS', 'getaddrinfo ENOTFOUND kafka.internal', 'dns_failure'],
    ['connection reset', 'ECONNRESET', 'connection_reset'],
    ['broken pipe', 'write EPIPE (broken pipe)', 'connection_reset'],
    [
      'unknown topic',
      'This server does not host this topic-partition (UNKNOWN_TOPIC_OR_PARTITION)',
      'topic_missing',
    ],
    ['SASL auth', 'SASL Authentication failed for user abl_admin', 'auth_failed'],
    ['HTTP 401', 'Unauthorized', 'auth_failed'],
    ['broker', 'Connection error: Broker not available', 'broker_unreachable'],
    ['unknown', 'Some completely novel failure mode', 'probe_failed'],
  ])('%s → %s', (_label, input, expected) => {
    expect(classifyProbeError(new Error(input))).toBe(expected);
  });

  test('accepts raw strings too (non-Error values)', () => {
    expect(classifyProbeError('ETIMEDOUT')).toBe('timeout');
  });

  test('does not leak raw message in the classifier output', () => {
    const sensitive = new Error('connect ECONNREFUSED to kafka-cluster.prod.internal:9092');
    const out = classifyProbeError(sensitive);
    expect(out).toBe('connection_refused');
    expect(out).not.toContain('kafka-cluster');
    expect(out).not.toContain('prod.internal');
  });
});
