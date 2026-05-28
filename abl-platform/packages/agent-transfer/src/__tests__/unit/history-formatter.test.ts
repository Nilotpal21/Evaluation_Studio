import { describe, it, expect } from 'vitest';
import {
  KoreHistoryStrategy,
  GenericHistoryStrategy,
  getHistoryStrategy,
  type HistoryEntry,
} from '../../adapters/history-formatter.js';

const HISTORY: HistoryEntry[] = [
  { role: 'user', content: 'Hello', timestamp: '2026-01-01T00:00:00Z' },
  { role: 'agent', content: 'Hi there', timestamp: '2026-01-01T00:00:01Z' },
  { role: 'user', content: 'Need help', timestamp: '2026-01-01T00:00:02Z' },
  { role: 'agent', content: 'Sure', timestamp: '2026-01-01T00:00:03Z' },
];

describe('KoreHistoryStrategy', () => {
  const strategy = new KoreHistoryStrategy();

  it('returns history as array', () => {
    const result = strategy.formatHistory(HISTORY);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
  });

  it('respects maxMessages (slices from end)', () => {
    const result = strategy.formatHistory(HISTORY, { maxMessages: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Need help');
    expect(result[1].content).toBe('Sure');
  });

  it('removes timestamps when includeTimestamps=false', () => {
    const result = strategy.formatHistory(HISTORY, { includeTimestamps: false });
    for (const entry of result) {
      expect(entry.timestamp).toBe('');
    }
  });

  it('removes roles when includeRoles=false', () => {
    const result = strategy.formatHistory(HISTORY, { includeRoles: false });
    for (const entry of result) {
      expect(entry.role).toBe('');
    }
  });
});

describe('GenericHistoryStrategy', () => {
  const strategy = new GenericHistoryStrategy();

  it('returns formatted text with timestamps and roles', () => {
    const result = strategy.formatHistory(HISTORY);
    expect(typeof result).toBe('string');
    expect(result).toContain('[2026-01-01T00:00:00Z]');
    expect(result).toContain('user:');
    expect(result).toContain('Hello');
  });

  it('respects maxMessages', () => {
    const result = strategy.formatHistory(HISTORY, { maxMessages: 1 });
    const lines = (result as string).split('\n');
    expect(lines).toHaveLength(1);
    expect(result).toContain('Sure');
  });

  it('omits timestamps when includeTimestamps=false', () => {
    const result = strategy.formatHistory(HISTORY, { includeTimestamps: false });
    expect(result).not.toContain('[2026-01-01T00:00:00Z]');
    expect(result).toContain('user:');
    expect(result).toContain('Hello');
  });

  it('omits roles when includeRoles=false', () => {
    const result = strategy.formatHistory(HISTORY, { includeRoles: false });
    expect(result).not.toContain('user:');
    expect(result).not.toContain('agent:');
    expect(result).toContain('Hello');
  });
});

describe('getHistoryStrategy', () => {
  it('returns KoreHistoryStrategy for "kore"', () => {
    const strategy = getHistoryStrategy('kore');
    expect(strategy).toBeInstanceOf(KoreHistoryStrategy);
  });

  it('returns GenericHistoryStrategy for unknown providers', () => {
    const strategy = getHistoryStrategy('genesys');
    expect(strategy).toBeInstanceOf(GenericHistoryStrategy);
  });
});
