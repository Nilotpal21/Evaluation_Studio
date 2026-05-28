import { describe, it, expect } from 'vitest';
import { resolveStrategy } from '../../services/execution/multi-intent-strategy.js';

describe('resolveStrategy', () => {
  // Explicit strategies
  it('returns declared strategy for supervisor', () => {
    expect(resolveStrategy('parallel', 'supervisor', 'independent')).toBe('parallel');
  });
  it('downgrades explicit parallel to sequential for dependent intents', () => {
    expect(resolveStrategy('parallel', 'supervisor', 'dependent')).toBe('sequential');
  });
  it('downgrades explicit parallel to disambiguate for ambiguous intents', () => {
    expect(resolveStrategy('parallel', 'supervisor', 'ambiguous')).toBe('disambiguate');
  });
  it('downgrades parallel to sequential for scripted', () => {
    expect(resolveStrategy('parallel', 'scripted', 'independent')).toBe('sequential');
  });
  it('downgrades parallel to sequential for reasoning', () => {
    expect(resolveStrategy('parallel', 'reasoning', 'independent')).toBe('sequential');
  });

  // Auto mode
  it('auto + independent + supervisor → parallel', () => {
    expect(resolveStrategy('auto', 'supervisor', 'independent')).toBe('parallel');
  });
  it('auto + independent + scripted → sequential', () => {
    expect(resolveStrategy('auto', 'scripted', 'independent')).toBe('sequential');
  });
  it('auto + dependent → sequential', () => {
    expect(resolveStrategy('auto', 'supervisor', 'dependent')).toBe('sequential');
  });
  it('auto + ambiguous → disambiguate', () => {
    expect(resolveStrategy('auto', 'supervisor', 'ambiguous')).toBe('disambiguate');
  });

  // Safe strategies always allowed
  it('primary_queue for all types', () => {
    expect(resolveStrategy('primary_queue', 'scripted', 'independent')).toBe('primary_queue');
    expect(resolveStrategy('primary_queue', 'reasoning', 'dependent')).toBe('primary_queue');
    expect(resolveStrategy('primary_queue', 'supervisor', 'ambiguous')).toBe('primary_queue');
  });
  it('disambiguate for all types', () => {
    expect(resolveStrategy('disambiguate', 'scripted', 'independent')).toBe('disambiguate');
  });
  it('sequential for all types', () => {
    expect(resolveStrategy('sequential', 'scripted', 'independent')).toBe('sequential');
  });
});
