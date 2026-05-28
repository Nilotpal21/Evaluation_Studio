import { describe, test, expect } from 'vitest';

// Import the pure classification function (no I/O)
const { classifyOutcome } = await import('../pipeline/services/outcome-classification.js');

describe('classifyOutcome', () => {
  test('contained: session completed without escalation', () => {
    expect(classifyOutcome({ status: 'completed', hasEscalation: false })).toBe('contained');
  });

  test('contained: session ended without escalation', () => {
    expect(classifyOutcome({ status: 'ended', hasEscalation: false })).toBe('contained');
  });

  test('escalated: session has escalation event', () => {
    expect(classifyOutcome({ status: 'completed', hasEscalation: true })).toBe('escalated');
    expect(classifyOutcome({ status: 'escalated', hasEscalation: false })).toBe('escalated');
  });

  test('abandoned: session timed out or user left', () => {
    expect(classifyOutcome({ status: 'abandoned', hasEscalation: false })).toBe('abandoned');
  });

  test('active: session still in progress', () => {
    expect(classifyOutcome({ status: 'active', hasEscalation: false })).toBe(null);
  });

  test('idle: session idle is not yet classifiable', () => {
    expect(classifyOutcome({ status: 'idle', hasEscalation: false })).toBe(null);
  });

  test('archived: session archived without escalation is contained', () => {
    expect(classifyOutcome({ status: 'archived', hasEscalation: false })).toBe('contained');
  });

  test('escalation flag takes priority over completed status', () => {
    expect(classifyOutcome({ status: 'completed', hasEscalation: true })).toBe('escalated');
  });

  test('escalation flag takes priority over ended status', () => {
    expect(classifyOutcome({ status: 'ended', hasEscalation: true })).toBe('escalated');
  });

  test('abandoned with escalation is still escalated (escalation takes priority)', () => {
    expect(classifyOutcome({ status: 'abandoned', hasEscalation: true })).toBe('escalated');
  });

  test('unknown status returns null', () => {
    expect(classifyOutcome({ status: 'unknown_status', hasEscalation: false })).toBe(null);
  });
});
