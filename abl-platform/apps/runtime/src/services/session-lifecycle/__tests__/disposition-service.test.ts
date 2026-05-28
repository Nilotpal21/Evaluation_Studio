import { describe, expect, it } from 'vitest';
import {
  deriveSessionStatus,
  normalizeSessionDisposition,
  normalizeTerminalDisposition,
} from '../disposition-service.js';

describe('normalizeSessionDisposition', () => {
  it.each([
    ['completed', 'completed'],
    ['agent_completed', 'completed'],
    ['conversation_complete', 'completed'],
    ['timeout', 'timeout'],
    ['error', 'failed'],
    ['user_left', 'abandoned'],
    ['user_exit', 'abandoned'],
    ['unengaged', 'unengaged'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(normalizeSessionDisposition(input)).toBe(expected);
  });

  it('returns undefined for unknown reasons', () => {
    expect(normalizeSessionDisposition('not-a-real-reason')).toBeUndefined();
  });
});

describe('deriveSessionStatus', () => {
  it('maps canonical dispositions to coarse-grained session status', () => {
    expect(deriveSessionStatus('completed')).toBe('completed');
    expect(deriveSessionStatus('transferred')).toBe('escalated');
    expect(deriveSessionStatus('timeout')).toBe('abandoned');
    expect(deriveSessionStatus('unengaged')).toBe('abandoned');
  });
});

describe('normalizeTerminalDisposition', () => {
  it('returns both disposition and derived status', () => {
    expect(normalizeTerminalDisposition('transferred')).toEqual({
      disposition: 'transferred',
      status: 'escalated',
    });
  });
});
