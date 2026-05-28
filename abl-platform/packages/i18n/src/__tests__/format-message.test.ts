import { describe, it, expect } from 'vitest';
import { formatMessage, resolveMessage } from '../format-message.js';

describe('formatMessage', () => {
  it('returns plain string unchanged', () => {
    expect(formatMessage('Hello world', undefined, 'en')).toBe('Hello world');
  });

  it('substitutes simple parameters', () => {
    expect(formatMessage('Project {projectId} was not found', { projectId: '123' }, 'en')).toBe(
      'Project 123 was not found',
    );
  });

  it('handles pluralization', () => {
    const tpl = '{count, plural, =0 {No agents} one {# agent} other {# agents}}';
    expect(formatMessage(tpl, { count: 0 }, 'en')).toBe('No agents');
    expect(formatMessage(tpl, { count: 1 }, 'en')).toBe('1 agent');
    expect(formatMessage(tpl, { count: 5 }, 'en')).toBe('5 agents');
  });

  it('handles select', () => {
    const tpl = '{status, select, active {Active} paused {Paused} other {Unknown}}';
    expect(formatMessage(tpl, { status: 'active' }, 'en')).toBe('Active');
    expect(formatMessage(tpl, { status: 'archived' }, 'en')).toBe('Unknown');
  });

  it('returns template on format error', () => {
    expect(formatMessage('{broken', undefined, 'en')).toBe('{broken');
  });
});

describe('resolveMessage', () => {
  const messages = {
    en: { greeting: 'Hello', farewell: 'Goodbye' },
    ar: { greeting: 'مرحبا' },
  };

  it('resolves from requested locale', () => {
    expect(resolveMessage(messages, 'en', 'ar', 'greeting')).toBe('مرحبا');
  });

  it('falls back to default locale', () => {
    expect(resolveMessage(messages, 'en', 'ar', 'farewell')).toBe('Goodbye');
  });

  it('falls back to en if default locale missing', () => {
    expect(resolveMessage(messages, 'de', 'ja', 'greeting')).toBe('Hello');
  });

  it('returns key itself as last resort', () => {
    expect(resolveMessage(messages, 'en', 'en', 'nonexistent')).toBe('nonexistent');
  });

  it('formats ICU params through fallback chain', () => {
    const msgs = {
      en: { err: 'Error in {field}' },
    };
    expect(resolveMessage(msgs, 'en', 'de', 'err', { field: 'name' })).toBe('Error in name');
  });
});
