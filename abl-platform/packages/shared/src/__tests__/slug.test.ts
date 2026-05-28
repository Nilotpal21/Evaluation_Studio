import { describe, it, expect } from 'vitest';
import { slugify, AGENT_NAME_PATTERN, AGENT_NAME_MAX_LENGTH, validateAgentName } from '../slug.js';

// =============================================================================
// slugify()
// =============================================================================

describe('slugify', () => {
  it('converts a simple name to lowercase', () => {
    expect(slugify('MyProject')).toBe('myproject');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugify('My Cool Project')).toBe('my-cool-project');
  });

  it('collapses multiple non-alphanumeric chars into one hyphen', () => {
    expect(slugify('foo---bar___baz')).toBe('foo-bar-baz');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('handles special characters', () => {
    expect(slugify('Hello, World! (2024)')).toBe('hello-world-2024');
  });

  it('handles unicode characters', () => {
    expect(slugify('café résumé')).toBe('caf-r-sum');
  });

  it('truncates to default maxLength of 50', () => {
    const longName = 'a'.repeat(60);
    expect(slugify(longName)).toHaveLength(50);
  });

  it('truncates to custom maxLength', () => {
    expect(slugify('this-is-a-long-slug', 10)).toBe('this-is-a-');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('returns empty string for only special chars', () => {
    expect(slugify('!!!@@@###')).toBe('');
  });

  it('preserves numbers', () => {
    expect(slugify('project-v2.1')).toBe('project-v2-1');
  });

  it('handles single character', () => {
    expect(slugify('A')).toBe('a');
  });

  it('handles mixed case with numbers', () => {
    expect(slugify('MyApp123')).toBe('myapp123');
  });

  it('handles input exactly at maxLength', () => {
    const slug = slugify('abcde', 5);
    expect(slug).toBe('abcde');
    expect(slug).toHaveLength(5);
  });
});

// =============================================================================
// AGENT_NAME_PATTERN
// =============================================================================

describe('AGENT_NAME_PATTERN', () => {
  it('matches simple names', () => {
    expect(AGENT_NAME_PATTERN.test('BookingAgent')).toBe(true);
  });

  it('matches names with underscores', () => {
    expect(AGENT_NAME_PATTERN.test('booking_agent')).toBe(true);
  });

  it('matches names with digits', () => {
    expect(AGENT_NAME_PATTERN.test('agent2')).toBe(true);
  });

  it('matches single letter', () => {
    expect(AGENT_NAME_PATTERN.test('a')).toBe(true);
  });

  it('rejects names starting with digit', () => {
    expect(AGENT_NAME_PATTERN.test('2agent')).toBe(false);
  });

  it('rejects names starting with underscore', () => {
    expect(AGENT_NAME_PATTERN.test('_agent')).toBe(false);
  });

  it('rejects names with hyphens', () => {
    expect(AGENT_NAME_PATTERN.test('booking-agent')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(AGENT_NAME_PATTERN.test('booking agent')).toBe(false);
  });

  it('rejects names with dots', () => {
    expect(AGENT_NAME_PATTERN.test('agent.v2')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(AGENT_NAME_PATTERN.test('')).toBe(false);
  });
});

// =============================================================================
// AGENT_NAME_MAX_LENGTH
// =============================================================================

describe('AGENT_NAME_MAX_LENGTH', () => {
  it('is 100', () => {
    expect(AGENT_NAME_MAX_LENGTH).toBe(100);
  });
});

// =============================================================================
// validateAgentName()
// =============================================================================

describe('validateAgentName', () => {
  it('returns null for valid name', () => {
    expect(validateAgentName('BookingAgent')).toBeNull();
  });

  it('returns null for name with underscores and digits', () => {
    expect(validateAgentName('my_agent_v2')).toBeNull();
  });

  it('returns error for empty string', () => {
    expect(validateAgentName('')).toBe('Agent name is required');
  });

  it('returns error for whitespace-only string', () => {
    expect(validateAgentName('   ')).toBe('Agent name is required');
  });

  it('returns error for name exceeding max length', () => {
    const longName = 'a'.repeat(101);
    expect(validateAgentName(longName)).toBe('Agent name must be at most 100 characters');
  });

  it('returns null for name exactly at max length', () => {
    const name = 'a'.repeat(100);
    expect(validateAgentName(name)).toBeNull();
  });

  it('returns error for name starting with digit', () => {
    expect(validateAgentName('1agent')).toBe(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );
  });

  it('returns error for name with hyphens', () => {
    expect(validateAgentName('my-agent')).toBe(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );
  });

  it('returns error for name with spaces', () => {
    expect(validateAgentName('my agent')).toBe(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );
  });

  it('returns error for name with special characters', () => {
    expect(validateAgentName('agent!')).toBe(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );
  });

  it('returns error for name starting with underscore', () => {
    expect(validateAgentName('_private')).toBe(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );
  });
});
